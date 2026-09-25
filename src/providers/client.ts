import type { PlannerMessage } from "../session/types.ts";
import { anthropicMessages } from "./anthropic-messages.ts";
import { DEFAULT_RETRY_POLICY, ProviderError, retryDelay, retryReason, wait, type RetryNotice, type RetryPolicy } from "./errors.ts";
import { openAICompletions } from "./openai-completions.ts";
import { openAIResponses } from "./openai-responses.ts";
import type { ProviderRegistry } from "./registry.ts";
import type { Adapter, ApiKind, Completion, StreamCallbacks } from "./types.ts";

const ADAPTERS: Record<ApiKind, Adapter> = {
  "openai-completions": openAICompletions,
  "anthropic-messages": anthropicMessages,
  "openai-responses": openAIResponses,
};

export interface CompleteOptions extends StreamCallbacks {
  /** A model reference: an OpenRouter ID, or `provider:model`. */
  model: string;
  sessionId: string;
  messages: readonly PlannerMessage[];
  /** One function definition or several. */
  toolSchema?: Record<string, unknown> | Record<string, unknown>[];
  effort?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called before each retry of a transient failure; nothing has reached the callbacks above. */
  onRetry?: (notice: RetryNotice) => void;
  retry?: Partial<RetryPolicy>;
}

export interface ProviderClientOptions {
  registry: ProviderRegistry;
  /** Defaults to the global fetch at request time. */
  fetch?: typeof globalThis.fetch;
  retry?: Partial<RetryPolicy>;
}

/** Streams one completion from whichever provider a model reference names. */
export class ProviderClient {
  readonly registry: ProviderRegistry;
  readonly retry: RetryPolicy;
  readonly #fetch?: typeof globalThis.fetch;

  constructor(options: ProviderClientOptions) {
    this.registry = options.registry;
    this.#fetch = options.fetch;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  }

  /**
   * One completion, retrying transient failures.
   *
   * A retry replays the whole request, so it is only safe while nothing has reached the
   * caller: a reasoning or content delta is already on screen, and a tool-call delta may
   * already have committed a graph to execution. Once any of them has been handed over,
   * the failure is the turn's, and the planner decides what to do with the evidence.
   */
  async complete(options: CompleteOptions): Promise<Completion> {
    const { provider, model, ref } = this.registry.resolve(options.model);
    const auth = await this.registry.resolveAuth(provider, options.signal);
    const adapter = ADAPTERS[provider.api];
    const policy: RetryPolicy = { ...this.retry, ...options.retry };
    const tools = options.toolSchema === undefined ? [] : Array.isArray(options.toolSchema) ? options.toolSchema : [options.toolSchema];
    for (let attempt = 1; ; attempt += 1) {
      let handedOver = false;
      try {
        return await adapter({
          provider,
          model,
          ref,
          compat: this.registry.compat(provider, model),
          ...auth,
          sessionId: options.sessionId,
          messages: options.messages,
          tools,
          ...(options.effort !== undefined ? { effort: options.effort } : {}),
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          fetch: this.#fetch ?? globalThis.fetch,
          onContent: options.onContent,
          onReasoning: options.onReasoning,
          onToolCall: options.onToolCall,
          handOver: () => { handedOver = true; },
        });
      } catch (error) {
        options.signal?.throwIfAborted();
        const delay = handedOver ? undefined : retryDelay(error, attempt, policy);
        if (delay === undefined) throw error;
        const failure = error as ProviderError;
        options.onRetry?.({ attempt, attempts: policy.attempts, delayMs: delay, reason: retryReason(failure), error: failure });
        await wait(delay, options.signal);
      }
    }
  }
}
