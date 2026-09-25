import type { PlannerMessage, PlannerToolCall } from "../session/types.ts";
import { ProviderError, responseError, transientPayload } from "./errors.ts";
import { portableCallId, producedBy } from "./reasoning.ts";
import { parseServerSentEvents } from "./sse.ts";
import { emptyUsage, type Adapter, type AdapterRequest, type ProviderUsage } from "./types.ts";

type Item = Record<string, any>;

/** The replay payload stored on an assistant message: the response's output items. */
interface NativeReply { items: Item[] }

/**
 * Responses input items. A reply from this same model goes back as its own output items, so
 * its encrypted reasoning carries across tool rounds; any other reply goes back as plain text
 * and function calls, which every model can read.
 */
export function responsesInput(request: AdapterRequest): Item[] {
  const input: Item[] = [];
  for (const message of request.messages) {
    const text = message.content ?? "";
    if (message.role === "system") {
      if (text) input.push({ role: "developer", content: text });
    } else if (message.role === "user") {
      if (text) input.push({ role: "user", content: text });
    } else if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: portableCallId(message.tool_call_id ?? ""), output: text });
    } else {
      const native = producedBy(message, request.ref, "openai-responses") ? (message.native as NativeReply | undefined) : undefined;
      if (Array.isArray(native?.items)) {
        // Call IDs go through the same mapping as the results that answer them.
        input.push(...structuredClone(native.items).map((item) =>
          item.type === "function_call" && typeof item.call_id === "string" ? { ...item, call_id: portableCallId(item.call_id) } : item));
        continue;
      }
      if (text) input.push({ role: "assistant", content: text });
      for (const call of message.tool_calls ?? []) {
        input.push({ type: "function_call", call_id: portableCallId(call.id), name: call.function.name, arguments: call.function.arguments });
      }
    }
  }
  return input;
}

function normalizeUsage(value: unknown): ProviderUsage {
  if (!value || typeof value !== "object") return emptyUsage();
  const usage = value as Record<string, any>;
  const number = (candidate: unknown) => typeof candidate === "number" ? candidate : 0;
  return {
    promptTokens: number(usage.input_tokens),
    completionTokens: number(usage.output_tokens),
    totalTokens: number(usage.total_tokens),
    cachedTokens: number(usage.input_tokens_details?.cached_tokens),
    cacheWriteTokens: number(usage.input_tokens_details?.cache_write_tokens),
  };
}

/** OpenAI's Responses API over SSE, stateless (`store: false`) with encrypted reasoning replay. */
export const openAIResponses: Adapter = async (request: AdapterRequest) => {
  const { provider, model, handOver } = request;
  const label = provider.name;
  const reasons = Boolean(model.reasoningEfforts?.length);
  let response: Response;
  try {
    response = await request.fetch(`${provider.baseUrl.replace(/\/+$/, "")}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
        ...request.headers,
      },
      body: JSON.stringify({
        model: model.id,
        input: responsesInput(request),
        ...(request.tools.length
          ? {
            tools: request.tools.map((tool) => ({
              type: "function", name: tool.name, description: tool.description,
              parameters: tool.parameters ?? { type: "object" }, strict: false,
            })),
            tool_choice: "auto",
            parallel_tool_calls: true,
          }
          : {}),
        stream: true,
        store: false,
        prompt_cache_key: request.sessionId.slice(0, 64),
        ...(reasons
          ? {
            reasoning: { ...(request.effort ? { effort: request.effort } : {}), summary: "auto" },
            include: ["reasoning.encrypted_content"],
          }
          : {}),
        ...(request.maxTokens ? { max_output_tokens: request.maxTokens } : {}),
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

  const items: Item[] = [];
  let finalItems: Item[] | undefined;
  const calls = new Map<number, { ordinal: number; id: string; name: string; arguments: string }>();
  let content = "";
  let reasoning = "";
  let reasoningBreak = false;
  let status: string | undefined;
  let incompleteReason: string | undefined;
  let usage = emptyUsage();
  let returnedModel = model.id;

  const addReasoning = (delta: unknown) => {
    if (typeof delta !== "string" || !delta) return;
    const separator = reasoningBreak && reasoning ? "\n\n" : "";
    reasoningBreak = false;
    reasoning += separator + delta;
    handOver();
    request.onReasoning?.(separator + delta);
  };
  const addContent = (delta: unknown) => {
    if (typeof delta !== "string" || !delta) return;
    content += delta;
    handOver();
    request.onContent?.(delta);
  };
  const toolCall = async (outputIndex: number, delta: string) => {
    const call = calls.get(outputIndex);
    if (!call || !delta) return;
    call.arguments += delta;
    handOver();
    await request.onToolCall?.({ index: call.ordinal, id: call.id, name: call.name, arguments: call.arguments, argumentsDelta: delta });
  };

  try {
    for await (const event of parseServerSentEvents(response.body)) {
      if (event.data.trim() === "[DONE]") break;
      let chunk: Item;
      try {
        chunk = JSON.parse(event.data) as Item;
      } catch (error) {
        throw new ProviderError(`${label} sent malformed SSE JSON.`, { details: event.data.slice(0, 1_000), cause: error, retryable: true, providerName: label });
      }
      switch (chunk.type) {
        case "response.created":
          if (typeof chunk.response?.model === "string") returnedModel = chunk.response.model;
          break;
        case "response.output_item.added": {
          const item = chunk.item ?? {};
          if (item.type === "function_call") {
            const call = { ordinal: calls.size, id: String(item.call_id ?? ""), name: String(item.name ?? ""), arguments: "" };
            calls.set(chunk.output_index, call);
            handOver();
            await request.onToolCall?.({ index: call.ordinal, id: call.id, name: call.name, arguments: "", argumentsDelta: "" });
            if (typeof item.arguments === "string") await toolCall(chunk.output_index, item.arguments);
          } else if (item.type === "reasoning") {
            reasoningBreak = true;
            request.onReasoning?.();
          } else if (item.type === "message" && content) {
            addContent("\n\n");
          }
          break;
        }
        case "response.reasoning_summary_part.added":
          reasoningBreak = true;
          break;
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          addReasoning(chunk.delta);
          break;
        case "response.output_text.delta":
        case "response.refusal.delta":
          addContent(chunk.delta);
          break;
        case "response.function_call_arguments.delta":
          if (typeof chunk.delta === "string") await toolCall(chunk.output_index, chunk.delta);
          break;
        case "response.function_call_arguments.done": {
          const call = calls.get(chunk.output_index);
          // Some servers send the arguments only here.
          if (call && typeof chunk.arguments === "string" && chunk.arguments.startsWith(call.arguments)) {
            await toolCall(chunk.output_index, chunk.arguments.slice(call.arguments.length));
          }
          break;
        }
        case "response.output_item.done":
          if (chunk.item) items[chunk.output_index] = chunk.item;
          break;
        case "response.completed":
        case "response.incomplete":
          status = chunk.response?.status ?? (chunk.type === "response.completed" ? "completed" : "incomplete");
          incompleteReason = chunk.response?.incomplete_details?.reason;
          usage = normalizeUsage(chunk.response?.usage);
          if (typeof chunk.response?.model === "string") returnedModel = chunk.response.model;
          // The terminal response carries every output item, including encrypted reasoning that
          // some deployments leave out of the per-item events.
          if (Array.isArray(chunk.response?.output) && chunk.response.output.length) finalItems = chunk.response.output;
          break;
        case "response.failed": {
          const failure = chunk.response?.error ?? {};
          const message = typeof failure.message === "string" ? failure.message : JSON.stringify(failure);
          throw new ProviderError(`${label} response failed: ${message}`, {
            details: failure, retryable: transientPayload(failure, message), providerName: label,
          });
        }
        case "error": {
          const message = typeof chunk.message === "string" ? chunk.message : JSON.stringify(chunk);
          throw new ProviderError(`${label} stream failed: ${message}`, {
            details: chunk, retryable: transientPayload(chunk, message), providerName: label,
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

  if (request.signal?.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
  if (!status) throw new ProviderError(`${label} stream ended before a completion marker.`, { retryable: true, providerName: label });
  if (status !== "completed") {
    const reason = incompleteReason === "max_output_tokens" ? "length" : incompleteReason ?? status;
    throw new ProviderError(`${label} completion ended with ${reason} before the full tool call was accepted.`, { providerName: label });
  }
  const outputItems = finalItems ?? items.filter(Boolean);
  // Arguments as the terminal response recorded them, which is what a replay sends back.
  for (const item of outputItems) {
    if (item.type !== "function_call") continue;
    const call = [...calls.values()].find((candidate) => candidate.id === item.call_id);
    if (call && typeof item.arguments === "string") call.arguments = item.arguments;
  }
  const toolCalls: PlannerToolCall[] = [...calls.values()]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((call, index) => ({
      id: call.id || `tool-call-${index}`,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  if (!toolCalls.length && !content.trim()) {
    throw new ProviderError(`${label} returned no answer or tool call.`, { retryable: true, providerName: label });
  }
  const message: PlannerMessage = {
    role: "assistant",
    content: content || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(reasoning ? { reasoning } : {}),
    model: request.ref,
    api: "openai-responses",
    native: { items: outputItems } satisfies NativeReply,
  };
  return { message, usage, model: returnedModel, finishReason: toolCalls.length ? "tool_calls" : "stop" };
};
