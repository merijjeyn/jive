export interface PlannerToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  /** Provider state on the call, such as Gemini's thought signature; replayed only to its model. */
  extra_content?: unknown;
}

/**
 * The OpenAI-compatible message shape persisted in a session. `model`, `api`,
 * `provider`, `reasoning_field` and `native` are local provenance fields; each
 * protocol adapter builds its own request from them.
 */
export interface PlannerMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: PlannerToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning?: string;
  reasoning_details?: unknown;
  /** The model reference that produced an assistant message, e.g. `anthropic:claude-opus-5-5`. */
  model?: string;
  /** The wire protocol that produced it; absent on messages from before provider support. */
  api?: string;
  /** For routers such as OpenRouter, the upstream that served it. */
  provider?: string;
  /** The OpenAI-compatible field the reasoning arrived in, when not `reasoning`. */
  reasoning_field?: string;
  /** The provider's own reply, replayed verbatim to the same provider. */
  native?: unknown;
}

export type SessionEventType =
  | "session.created"
  | "session.named"
  | "session.name.failed"
  | "planner.message"
  | "planner.context"
  | "planner.request"
  | "pin.added"
  | "model.selected"
  | "effort.selected"
  | "project.instructions"
  | "project.skills"
  | "plugin.catalog"
  | "context.compacted"
  | "graph.started"
  | "graph.finished"
  | "graph.interrupted"
  | "graph.stream.started"
  | "graph.stream.finished"
  | "graph.stream.bound"
  | "graph.stream.published"
  | "execution.event"
  | "artifact.saved"
  | "transport.error"
  | "transport.retry"
  | "notice";

export interface SessionEvent<T = any> {
  id: string;
  sequence: number;
  timestamp: string;
  type: SessionEventType;
  data: T;
}

export interface MessageEventData {
  message: PlannerMessage;
  chatId?: string;
  /** Transcript id for the message's reasoning, so a resume rebuilds the same rows. */
  reasoningChatId?: string;
  requestedModel?: string;
  returnedModel?: string;
  provider?: string;
  usage?: Record<string, number>;
  pluginCatalog?: string;
}

export interface PinEventData {
  text: string;
}

export interface ProjectInstructionsEventData {
  path: string;
  text: string | null;
}

export type SessionNameSource = "generated" | "manual";

export interface SessionNameEventData {
  name: string;
  source: SessionNameSource;
  model?: string;
}

export interface SessionSummary {
  id: string;
  name: string;
  nameSource: "fallback" | SessionNameSource;
  createdAt: string;
  updatedAt: string;
  model?: string;
  effort?: string;
  messageCount: number;
}

export interface CompactionEventData {
  /** First retained planner-message event sequence. */
  retainedFrom: number;
  omittedThrough: number;
  archivePath: string;
  archiveMessage: PlannerMessage;
  retainedSequences: number[];
  mandatorySequences?: number[];
}

export interface SessionArtifact {
  path: string;
  relativePath: string;
  bytes: number;
  mediaType: string;
}

export interface ArchiveMatch {
  line: number;
  event: SessionEvent;
}
