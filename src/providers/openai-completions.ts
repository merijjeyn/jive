import type { PlannerMessage, PlannerToolCall } from "../session/types.ts";
import { ProviderError, responseError, transientPayload } from "./errors.ts";
import { ANTHROPIC_REASONING_BUDGETS, producedBy } from "./reasoning.ts";
import { parseServerSentEvents } from "./sse.ts";
import { emptyUsage, type Adapter, type AdapterRequest, type ProviderCompat, type ProviderUsage } from "./types.ts";

/** The OpenRouter reasoning object for one request, or undefined to leave the provider default. */
export function reasoningParameters(model: string, effort: string | undefined): Record<string, unknown> | undefined {
  if (!effort) return undefined;
  if (model.startsWith("anthropic/")) {
    if (effort === "none") return { enabled: false };
    const budget = ANTHROPIC_REASONING_BUDGETS[effort];
    if (budget !== undefined) return { max_tokens: budget };
  }
  return { effort };
}

/** Request fields that ask for an effort level, in the server's dialect. */
function reasoningFields(compat: ProviderCompat, model: string, effort: string | undefined): Record<string, unknown> {
  if (!effort) return {};
  switch (compat.reasoningFormat) {
    case "openrouter": {
      const reasoning = reasoningParameters(model, effort);
      return reasoning ? { reasoning } : {};
    }
    case "openai":
      return { reasoning_effort: effort };
    case "chat-template":
      return { chat_template_kwargs: { enable_thinking: effort !== "none" } };
    default:
      return {};
  }
}

function normalizeUsage(value: unknown): ProviderUsage {
  const usage = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details as Record<string, unknown>
    : {};
  const number = (candidate: unknown) => typeof candidate === "number" ? candidate : 0;
  return {
    promptTokens: number(usage.prompt_tokens),
    completionTokens: number(usage.completion_tokens),
    totalTokens: number(usage.total_tokens),
    cachedTokens: number(details.cached_tokens),
    cacheWriteTokens: number(details.cache_write_tokens),
  };
}

/** Servers name their reasoning field differently; the first non-empty one wins. */
const REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"] as const;

function apiMessage(message: PlannerMessage, ref: string): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (message.name) result.name = message.name;
  if (message.tool_call_id) result.tool_call_id = message.tool_call_id;
  // Reasoning blocks are provider/model state. They must be passed back
  // unmodified during a tool round, but not leaked into another model.
  const own = message.role === "assistant" && producedBy(message, ref, "openai-completions");
  if (message.tool_calls) {
    result.tool_calls = own ? message.tool_calls : message.tool_calls.map(({ extra_content: _, ...call }) => call);
  }
  if (own) {
    if (message.reasoning !== undefined) result[message.reasoning_field ?? "reasoning"] = message.reasoning;
    if (message.reasoning_details !== undefined) result.reasoning_details = message.reasoning_details;
  }
  return result;
}

interface ToolAccumulator {
  index: number;
  id: string;
  type: "function";
  name: string;
  arguments: string;
  extra?: Record<string, unknown>;
}

function appendFragment(current: string, fragment: unknown): string {
  if (typeof fragment !== "string" || !fragment) return current;
  return current + fragment;
}

/** Chat Completions over SSE: OpenRouter, OpenAI, and the many servers that copy the API. */
export const openAICompletions: Adapter = async (request: AdapterRequest) => {
  const { provider, model, compat, handOver } = request;
  const label = provider.name;
  let response: Response;
  try {
    response = await request.fetch(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
        ...request.headers,
      },
      body: JSON.stringify({
        model: model.id,
        messages: request.messages.map((message) => apiMessage(message, request.ref)),
        ...(request.tools.length
          ? { tools: request.tools.map((schema) => ({ type: "function", function: schema })), tool_choice: "auto" }
          : {}),
        stream: true,
        ...(compat.streamUsage === false ? {} : { stream_options: { include_usage: true } }),
        ...(compat.openRouterRouting
          ? { session_id: request.sessionId.slice(0, 256), provider: { allow_fallbacks: false } }
          : {}),
        ...reasoningFields(compat, model.id, request.effort),
        // OpenAI, recent Gemini, DeepSeek, and Z.AI use implicit caching through
        // OpenRouter. Anthropic-family routes support the recommended automatic
        // breakpoint, which advances while the underlying messages stay immutable.
        ...(compat.cacheControl === "openrouter-auto" && model.id.startsWith("anthropic/")
          ? { cache_control: { type: "ephemeral" } }
          : {}),
      }),
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal?.aborted) throw request.signal.reason ?? error;
    throw new ProviderError(
      `Could not reach ${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, retryable: true, providerName: label },
    );
  }

  if (!response.ok) throw await responseError(response, label);
  if (!response.body) throw new ProviderError(`${label} returned an empty streaming response.`, { providerName: label });

  let content = "";
  let reasoning = "";
  let reasoningField: string | undefined;
  let reasoningDetails: unknown[] | undefined;
  let usage = emptyUsage();
  let returnedModel = model.id;
  let upstream: string | undefined;
  let finishReason: string | undefined;
  const calls = new Map<number, ToolAccumulator>();
  let done = false;

  try {
    for await (const event of parseServerSentEvents(response.body)) {
      if (event.data.trim() === "[DONE]") {
        done = true;
        break;
      }
      let chunk: Record<string, any>;
      try {
        chunk = JSON.parse(event.data) as Record<string, any>;
      } catch (error) {
        throw new ProviderError(`${label} sent malformed SSE JSON.`, {
          details: event.data.slice(0, 1_000),
          cause: error,
          retryable: true,
          providerName: label,
        });
      }
      if (chunk.error || event.event === "error") {
        const reported = typeof chunk.error?.message === "string" ? chunk.error.message : JSON.stringify(chunk.error ?? chunk);
        const code = typeof chunk.error?.code === "number" ? chunk.error.code : undefined;
        throw new ProviderError(`${label} stream failed: ${reported}`, {
          details: chunk.error ?? chunk,
          ...(code !== undefined ? { status: code } : {}),
          retryable: transientPayload(chunk.error, reported),
          providerName: label,
        });
      }
      if (typeof chunk.model === "string") returnedModel = chunk.model;
      if (typeof chunk.provider === "string") upstream = chunk.provider;
      if (chunk.usage) usage = normalizeUsage(chunk.usage);

      for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
        const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};
        if (typeof delta.content === "string") {
          content += delta.content;
          if (delta.content) handOver();
          request.onContent?.(delta.content);
        }
        let reasoningActivity = false;
        const field = REASONING_FIELDS.find((name) => typeof delta[name] === "string" && delta[name]);
        if (field) {
          reasoningField ??= field;
          const text = delta[field] as string;
          reasoning += text;
          reasoningActivity = true;
          handOver();
          request.onReasoning?.(text);
        }
        if (delta.reasoning_details !== undefined) {
          reasoningDetails ??= [];
          if (Array.isArray(delta.reasoning_details)) reasoningDetails.push(...delta.reasoning_details);
          else reasoningDetails.push(delta.reasoning_details);
          reasoningActivity = true;
        }
        if (reasoningActivity && !field) request.onReasoning?.();
        for (const fragment of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const index = typeof fragment.index === "number" ? fragment.index : calls.size;
          const accumulator: ToolAccumulator = calls.get(index) ?? {
            index,
            id: "",
            type: "function" as const,
            name: "",
            arguments: "",
          };
          accumulator.id = appendFragment(accumulator.id, fragment.id);
          accumulator.name = appendFragment(accumulator.name, fragment.function?.name);
          accumulator.arguments = appendFragment(accumulator.arguments, fragment.function?.arguments);
          // Gemini attaches a thought signature here that must come back with the call.
          if (fragment.extra_content && typeof fragment.extra_content === "object") {
            accumulator.extra = { ...accumulator.extra, ...fragment.extra_content };
          }
          calls.set(index, accumulator);
          handOver();
          await request.onToolCall?.({
            index, id: accumulator.id, name: accumulator.name,
            arguments: accumulator.arguments,
            argumentsDelta: typeof fragment.function?.arguments === "string" ? fragment.function.arguments : "",
          });
        }
      }
    }
  } catch (error) {
    if (request.signal?.aborted) throw request.signal.reason ?? error;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      `${label} stream was interrupted: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, retryable: true, providerName: label },
    );
  }

  if (!done && request.signal?.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
  if (!done && !finishReason) {
    throw new ProviderError(`${label} stream ended before a completion marker.`, { retryable: true, providerName: label });
  }
  if (finishReason === "length" || finishReason === "content_filter" || finishReason === "error") {
    throw new ProviderError(`${label} completion ended with ${finishReason} before the full tool call was accepted.`, { providerName: label });
  }
  if (calls.size > 0 && finishReason !== "tool_calls" && finishReason !== "stop") {
    throw new ProviderError(`${label} did not confirm completion of the tool calls.`, { providerName: label });
  }
  if (calls.size === 0 && !content.trim()) {
    throw new ProviderError(`${label} returned no answer or tool call.`, { retryable: true, providerName: label });
  }
  const toolCalls: PlannerToolCall[] = [...calls.values()]
    .sort((left, right) => left.index - right.index)
    .map((call, index) => ({
      id: call.id || `tool-call-${index}`,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
      ...(call.extra ? { extra_content: call.extra } : {}),
    }));
  const message: PlannerMessage = {
    role: "assistant",
    content: content || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(reasoning && reasoningField && reasoningField !== "reasoning" ? { reasoning_field: reasoningField } : {}),
    ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
    // Keep the requested reference on the message so opaque reasoning state is
    // returned only while continuing with that same selected model. The
    // resolved ID is retained separately on the completion.
    model: request.ref,
    api: "openai-completions",
    ...(upstream ? { provider: upstream } : {}),
  };
  return { message, usage, model: returnedModel, ...(upstream ? { provider: upstream } : {}), ...(finishReason ? { finishReason } : {}) };
};
