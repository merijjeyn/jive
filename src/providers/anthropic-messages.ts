import Anthropic from "@anthropic-ai/sdk";

import type { PlannerMessage, PlannerToolCall } from "../session/types.ts";
import { ProviderError, TRANSIENT_STATUS, TRANSIENT_TEXT, parseRetryAfter } from "./errors.ts";
import { ANTHROPIC_REASONING_BUDGETS, portableCallId } from "./reasoning.ts";
import { parseModelRef } from "./model-ref.ts";
import { emptyUsage, type Adapter, type AdapterRequest, type ProviderUsage } from "./types.ts";

type Block = Record<string, any>;
interface Turn { role: "user" | "assistant"; content: Block[] }

const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const RETRYABLE_TYPES = new Set(["overloaded_error", "api_error", "rate_limit_error", "timeout_error"]);
/** Where the API accepts a cache breakpoint; thinking blocks take none. */
const CACHEABLE = new Set(["text", "tool_use", "tool_result", "image", "document"]);

/** The replay payload stored on an assistant message. */
interface NativeReply { content: Block[] }

function nativeContent(message: PlannerMessage, request: AdapterRequest): Block[] | undefined {
  if (message.api !== "anthropic-messages" || !message.model) return undefined;
  // Thinking blocks go back unchanged to any model on the same endpoint: the API itself
  // drops the ones the receiving model cannot read, and removing them can break ordering.
  if (parseModelRef(message.model).provider !== request.provider.id) return undefined;
  const native = message.native as NativeReply | undefined;
  return Array.isArray(native?.content) ? structuredClone(native.content) : undefined;
}

function toolInput(argumentsText: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(argumentsText);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* an unreadable call is replayed without its arguments */ }
  return {};
}

function assistantBlocks(message: PlannerMessage, request: AdapterRequest, stripThinking: boolean): Block[] {
  const native = nativeContent(message, request);
  if (native) {
    return stripThinking ? native.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking") : native;
  }
  const blocks: Block[] = [];
  if (message.content) blocks.push({ type: "text", text: message.content });
  for (const call of message.tool_calls ?? []) {
    blocks.push({ type: "tool_use", id: portableCallId(call.id), name: call.function.name, input: toolInput(call.function.arguments) });
  }
  return blocks;
}

/**
 * Leading system messages become the system prompt. Later ones (pins, catalog updates, archive
 * notes) become user text, which every Claude model accepts wherever it falls in the history.
 */
export function anthropicTranscript(request: AdapterRequest, stripThinking = false): { system: Block[]; messages: Turn[] } {
  const system: Block[] = [];
  const turns: Turn[] = [];
  let leading = true;
  const push = (role: Turn["role"], blocks: Block[]) => {
    if (!blocks.length) return;
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };
  for (const message of request.messages) {
    const text = message.content ?? "";
    if (message.role === "system" && leading) {
      if (text) system.push({ type: "text", text });
      continue;
    }
    leading = false;
    if (message.role === "system") push("user", text ? [{ type: "text", text: `[System message]\n${text}` }] : []);
    else if (message.role === "user") push("user", text ? [{ type: "text", text }] : []);
    else if (message.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: portableCallId(message.tool_call_id ?? ""), content: text || "(empty)" }]);
    } else push("assistant", assistantBlocks(message, request, stripThinking));
  }
  // Tool results must open the user turn that answers the tool calls.
  for (const turn of turns) {
    if (turn.role !== "user") continue;
    turn.content = [
      ...turn.content.filter((block) => block.type === "tool_result"),
      ...turn.content.filter((block) => block.type !== "tool_result"),
    ];
  }
  if (turns[0]?.role !== "user") turns.unshift({ role: "user", content: [{ type: "text", text: "Continue." }] });
  // Two breakpoints: the stable system prompt, and the end of the append-only history.
  if (system.length) system.at(-1)!.cache_control = { type: "ephemeral" };
  const last = turns.at(-1)?.content.at(-1);
  if (last && CACHEABLE.has(last.type)) last.cache_control = { type: "ephemeral" };
  return { system, messages: turns };
}

function thinkingParameters(request: AdapterRequest, maxTokens: number): { thinking?: Block; output_config?: Block } {
  const { model, effort } = request;
  const mode = model.thinking ?? "adaptive";
  if (mode === "none") return {};
  if (mode === "budget") {
    const requested = effort && effort !== "none" ? ANTHROPIC_REASONING_BUDGETS[effort] : undefined;
    // The budget must be at least 1024 and leave room for the answer under max_tokens.
    const budget = requested === undefined ? undefined : Math.min(requested, maxTokens - 1024);
    return budget !== undefined && budget >= 1024 ? { thinking: { type: "enabled", budget_tokens: budget } } : {};
  }
  if (effort === "none") return { thinking: { type: "disabled" } };
  return {
    // The planner streams reasoning into the transcript; the API default leaves it empty.
    thinking: { type: "adaptive", display: "summarized" },
    ...(effort ? { output_config: { effort: effort === "minimal" ? "low" : effort } } : {}),
  };
}

function apiError(error: unknown, label: string): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`Could not reach ${label}: ${error.message}`, { cause: error, retryable: true, providerName: label });
  }
  if (error instanceof Anthropic.APIError) {
    const body = error.error as { error?: { type?: string; message?: string } } | undefined;
    const type = error.type ?? body?.error?.type;
    const message = body?.error?.message ?? error.message;
    const status = error.status;
    return new ProviderError(
      status === undefined ? `${label} stream failed: ${message}` : `${label} request failed (${status}): ${message}`,
      {
        ...(status !== undefined ? { status } : {}),
        details: body,
        cause: error,
        retryable: status !== undefined ? TRANSIENT_STATUS.has(status) : RETRYABLE_TYPES.has(type ?? "") || TRANSIENT_TEXT.test(message),
        retryAfterMs: parseRetryAfter(error.headers?.get("retry-after")),
        providerName: label,
      },
    );
  }
  return new ProviderError(
    `${label} stream was interrupted: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error, retryable: true, providerName: label },
  );
}

/** A replayed thinking block the API refuses because the history before it changed. */
function isBindingRejection(error: unknown): boolean {
  if (!(error instanceof Anthropic.APIError) || error.status !== 400) return false;
  const message = (error.error as { error?: { message?: string } } | undefined)?.error?.message ?? error.message;
  return /signature`? in `?thinking`? block|bound to a different conversation/i.test(message);
}

function usageFrom(value: unknown, into: ProviderUsage): void {
  if (!value || typeof value !== "object") return;
  const usage = value as Record<string, unknown>;
  const number = (key: string, fallback: number) => typeof usage[key] === "number" ? usage[key] as number : fallback;
  const input = number("input_tokens", into.promptTokens - into.cachedTokens - into.cacheWriteTokens);
  into.cachedTokens = number("cache_read_input_tokens", into.cachedTokens);
  into.cacheWriteTokens = number("cache_creation_input_tokens", into.cacheWriteTokens);
  into.promptTokens = input + into.cachedTokens + into.cacheWriteTokens;
  into.completionTokens = number("output_tokens", into.completionTokens);
  into.totalTokens = into.promptTokens + into.completionTokens;
}

/** Anthropic's Messages API, through the official SDK; SDK retries are off so the client's rule applies. */
export const anthropicMessages: Adapter = async (request: AdapterRequest) => {
  const { provider, model, compat, handOver } = request;
  const label = provider.name;
  const client = new Anthropic({
    apiKey: request.apiKey ?? null,
    authToken: null,
    baseURL: provider.baseUrl,
    fetch: request.fetch,
    maxRetries: 0,
    timeout: 20 * 60 * 1000,
    // A null header tells the SDK that no key is intended, as for a local keyless server.
    defaultHeaders: { ...(request.apiKey ? {} : { "x-api-key": null }), ...request.headers },
  });
  const maxTokens = request.maxTokens ?? model.maxTokens ?? 32_000;
  const { thinking, output_config } = thinkingParameters(request, maxTokens);
  const betas: string[] = [];
  if (thinking && thinking.type !== "disabled" && compat.thinkingBindingControls) {
    // Compaction keeps recent turns verbatim after an archive note, which changes the history
    // their thinking was bound to. Dropping those blocks costs a little reasoning; failing costs the turn.
    thinking.block_binding = { prefix_mismatch_behavior: "drop_block" };
    betas.push(BINDING_BETA);
  }
  const tools = request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters ?? { type: "object" },
    ...(compat.eagerToolStreaming ? { eager_input_streaming: true } : {}),
  }));
  const open = async (stripThinking: boolean): Promise<AsyncIterable<Block>> => {
    const { system, messages } = anthropicTranscript(request, stripThinking);
    const params: Block = {
      model: model.id,
      max_tokens: maxTokens,
      ...(system.length ? { system } : {}),
      messages,
      ...(tools.length ? { tools, tool_choice: { type: "auto" } } : {}),
      ...(thinking ? { thinking } : {}),
      ...(output_config ? { output_config } : {}),
      stream: true,
    };
    const options = request.signal ? { signal: request.signal } : {};
    const stream = betas.length
      ? await client.beta.messages.create({ ...params, betas } as never, options)
      : await client.messages.create(params as never, options);
    return stream as unknown as AsyncIterable<Block>;
  };

  let events: AsyncIterable<Block>;
  try {
    try {
      events = await open(false);
    } catch (error) {
      // Where the binding beta is unavailable, the documented recovery is one retry without thinking history.
      if (!isBindingRejection(error)) throw error;
      events = await open(true);
    }
  } catch (error) {
    if (request.signal?.aborted) throw request.signal.reason ?? error;
    throw apiError(error, label);
  }

  const blocks: Block[] = [];
  const calls = new Map<number, { ordinal: number; arguments: string }>();
  let content = "";
  let reasoning = "";
  let stopReason: string | undefined;
  let stopDetails: Block | undefined;
  let returnedModel = model.id;
  const usage = emptyUsage();
  let finished = false;

  try {
    for await (const event of events) {
      switch (event.type) {
        case "message_start":
          if (typeof event.message?.model === "string") returnedModel = event.message.model;
          usageFrom(event.message?.usage, usage);
          break;
        case "content_block_start": {
          const block: Block = structuredClone(event.content_block ?? {});
          blocks[event.index] = block;
          if (block.type === "tool_use") {
            const ordinal = calls.size;
            calls.set(event.index, { ordinal, arguments: "" });
            block.input = {};
            handOver();
            await request.onToolCall?.({ index: ordinal, id: block.id, name: block.name, arguments: "", argumentsDelta: "" });
          } else if (block.type === "redacted_thinking") request.onReasoning?.();
          break;
        }
        case "content_block_delta": {
          const block = blocks[event.index];
          const delta = event.delta ?? {};
          if (!block) break;
          if (delta.type === "text_delta" && delta.text) {
            // Separate text blocks read as paragraphs, not one run-on sentence.
            const separator = !block.text && content ? "\n\n" : "";
            block.text = (block.text ?? "") + delta.text;
            content += separator + delta.text;
            handOver();
            request.onContent?.(separator + delta.text);
          } else if (delta.type === "thinking_delta") {
            if (delta.thinking) {
              const separator = !block.thinking && reasoning ? "\n\n" : "";
              block.thinking = (block.thinking ?? "") + delta.thinking;
              reasoning += separator + delta.thinking;
              handOver();
              request.onReasoning?.(separator + delta.thinking);
            } else request.onReasoning?.();
          } else if (delta.type === "signature_delta") {
            block.signature = (block.signature ?? "") + delta.signature;
          } else if (delta.type === "input_json_delta") {
            const call = calls.get(event.index);
            if (!call || typeof delta.partial_json !== "string") break;
            call.arguments += delta.partial_json;
            handOver();
            await request.onToolCall?.({
              index: call.ordinal, id: block.id, name: block.name,
              arguments: call.arguments, argumentsDelta: delta.partial_json,
            });
          }
          break;
        }
        case "content_block_stop": {
          const call = calls.get(event.index);
          const block = blocks[event.index];
          if (call && block) block.input = toolInput(call.arguments || "{}");
          break;
        }
        case "message_delta":
          if (typeof event.delta?.stop_reason === "string") stopReason = event.delta.stop_reason;
          if (event.delta?.stop_details) stopDetails = event.delta.stop_details;
          usageFrom(event.usage, usage);
          break;
        case "message_stop":
          finished = true;
          break;
      }
    }
  } catch (error) {
    if (request.signal?.aborted) throw request.signal.reason ?? error;
    throw apiError(error, label);
  }

  // The SDK ends the iteration quietly when the request is aborted.
  if (request.signal?.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
  if (!finished) throw new ProviderError(`${label} stream ended before a completion marker.`, { retryable: true, providerName: label });
  if (stopReason === "refusal") {
    const category = typeof stopDetails?.category === "string" ? ` (${stopDetails.category})` : "";
    throw new ProviderError(`${label} declined the request${category}.`, { details: stopDetails, providerName: label });
  }
  if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") {
    throw new ProviderError(`${label} completion ended with ${stopReason} before the full tool call was accepted.`, { providerName: label });
  }
  const toolCalls: PlannerToolCall[] = [...calls.entries()]
    .sort(([, left], [, right]) => left.ordinal - right.ordinal)
    .map(([index, call]) => ({
      id: String(blocks[index]?.id ?? `tool-call-${call.ordinal}`),
      type: "function",
      function: { name: String(blocks[index]?.name ?? ""), arguments: call.arguments },
    }));
  if (toolCalls.length && stopReason !== "tool_use" && stopReason !== "end_turn") {
    throw new ProviderError(`${label} did not confirm completion of the tool calls (${stopReason ?? "no stop reason"}).`, { providerName: label });
  }
  if (!toolCalls.length && !content.trim()) {
    throw new ProviderError(`${label} returned no answer or tool call.`, { retryable: true, providerName: label });
  }
  const message: PlannerMessage = {
    role: "assistant",
    content: content || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(reasoning ? { reasoning } : {}),
    model: request.ref,
    api: "anthropic-messages",
    native: { content: blocks.filter(Boolean) } satisfies NativeReply,
  };
  return {
    message,
    usage,
    model: returnedModel,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
  };
};
