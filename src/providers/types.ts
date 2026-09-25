import type { PlannerMessage } from "../session/types.ts";

/** Wire protocols. A provider speaks exactly one; many vendors share `openai-completions`. */
export const API_KINDS = ["openai-completions", "anthropic-messages", "openai-responses"] as const;
export type ApiKind = (typeof API_KINDS)[number];

/**
 * Dialect differences between servers that speak the same protocol. Defaults are detected
 * from the provider's host; configuration overrides them one field at a time.
 */
export interface ProviderCompat {
  /** openai-completions: how an effort level is requested. */
  reasoningFormat?: "openrouter" | "openai" | "chat-template" | "none";
  /** openai-completions: OpenRouter's session_id and no-fallback routing fields. */
  openRouterRouting?: boolean;
  /** openai-completions: OpenRouter's automatic cache breakpoint for Anthropic-family models. */
  cacheControl?: "openrouter-auto" | "none";
  /** openai-completions: ask for usage in the final stream chunk. */
  streamUsage?: boolean;
  /** anthropic-messages: drop invalidated thinking blocks instead of failing the request. */
  thinkingBindingControls?: boolean;
  /** anthropic-messages: stream tool arguments as they are generated. */
  eagerToolStreaming?: boolean;
}

export interface ModelSpec {
  /** The provider's own model ID, e.g. `claude-opus-5-5` or `anthropic/claude-opus-5.5`. */
  id: string;
  name?: string;
  contextWindow?: number;
  /** Output cap sent with each request where the protocol needs one. */
  maxTokens?: number;
  /** Supported efforts in Jive's vocabulary. Undefined means unknown; [] means no effort control. */
  reasoningEfforts?: string[];
  reasoningDefault?: string;
  reasoningMandatory?: boolean;
  /** anthropic-messages: adaptive effort, a fixed thinking budget, or no thinking. */
  thinking?: "adaptive" | "budget" | "none";
  compat?: ProviderCompat;
}

export interface ProviderSpec {
  id: string;
  name: string;
  api: ApiKind;
  baseUrl: string;
  /** Configured key: a literal, `$NAME`/`${NAME}`, or `!command`. Resolved per request. */
  apiKey?: string;
  /** Environment variables consulted, in order, when no key is configured. */
  apiKeyEnv: string[];
  /** Local servers that accept any key. */
  keyless: boolean;
  headers: Record<string, string>;
  compat: ProviderCompat;
  models: ModelSpec[];
  /** Fields applied to models the provider does not list, such as a custom `/model` ID. */
  modelDefaults: Omit<ModelSpec, "id">;
  /** Where live model metadata comes from, if anywhere. */
  catalog?: "openrouter" | "list";
  /** The model chosen when this provider is the first one with credentials. */
  defaultModel?: string;
  /** `!command` values may run only when every contributing file is the user's own. */
  allowCommands: boolean;
  /** "built-in", or the config files that defined or changed the provider. */
  sources: string[];
}

export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

export interface Completion {
  message: PlannerMessage;
  usage: ProviderUsage;
  /** The model the provider reports it actually ran. */
  model: string;
  /** For routers, the upstream that served the request. */
  provider?: string;
  finishReason?: string;
}

export interface ToolCallDelta {
  index: number;
  id: string;
  name: string;
  /** Everything received so far for this call. */
  arguments: string;
  argumentsDelta: string;
}

export interface StreamCallbacks {
  onContent?: (delta: string) => void;
  /**
   * Called with each reasoning delta, or with no text when only opaque details arrived. A call
   * without text shows activity, not content, so the attempt can still be retried after it.
   */
  onReasoning?: (delta?: string) => void;
  onToolCall?: (delta: ToolCallDelta) => void | Promise<void>;
}

/** One request, already resolved to a provider, model and credentials. */
export interface AdapterRequest extends StreamCallbacks {
  provider: ProviderSpec;
  model: ModelSpec;
  /** The model reference recorded on the reply, e.g. `anthropic:claude-opus-5-5`. */
  ref: string;
  compat: ProviderCompat;
  apiKey?: string;
  headers: Record<string, string>;
  sessionId: string;
  messages: readonly PlannerMessage[];
  /** Function definitions: `{ name, description, parameters }`. */
  tools: Record<string, unknown>[];
  effort?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  fetch: typeof globalThis.fetch;
  /** Marks the attempt as visible to the caller; from then on it cannot be replayed. */
  handOver: () => void;
}

export type Adapter = (request: AdapterRequest) => Promise<Completion>;

export function emptyUsage(): ProviderUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
}
