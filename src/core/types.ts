import type { SessionSummary } from "../session/types.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Expression = unknown;
export interface Condition { op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "and" | "or" | "not" | "exists" | "in"; args: Expression[] }
export interface Common {
  label?: string;
  needs?: string[];
  when?: Condition;
  allowFailedDependencies?: boolean;
  onError?: "continue" | "stop";
}
export interface BashNode extends Common {
  type: "bash";
  script: string;
  cwd?: string;
  env?: Record<string, Expression>;
  stdin?: Expression;
  timeoutMs?: number;
  acceptedExitCodes?: number[];
  outputFormat?: "text" | "json";
}
export interface PrepareStep { use: string; as: string; input: Expression; config?: Expression }
export interface JevNode extends Common {
  type: "jev";
  prepare?: PrepareStep[];
  state: Expression;
  questions: Expression;
  accept?: Condition;
  select?: Record<string, { from: Expression; key: Expression }>;
}
export type Node = BashNode | JevNode;
export interface ForeachGroup extends Common {
  kind: "foreach";
  items: Expression;
  template: string;
  input?: Expression;
  maxItems: number;
  concurrency?: number;
  /** "continue" records failed items in the output and lets the group finish; the default fails the group. */
  onItemFailure?: "fail" | "continue";
}
export interface RepeatGroup extends Common {
  kind: "repeat";
  template: string;
  initial: Expression;
  next: Expression;
  until: Condition;
  maxIterations: number;
}
export type Group = ForeachGroup | RepeatGroup;
export interface GraphBody { nodes: Record<string, Node>; groups?: Record<string, Group>; output?: Expression }
export interface Graph extends GraphBody {
  version: 1;
  label: string;
  context?: unknown;
  templates?: Record<string, GraphBody>;
  limits?: Partial<Limits>;
  returns?: string[];
}
export interface Limits { concurrency: number; timeoutMs: number; maxJevCalls: number }
export type NodeStatus = "pending" | "running" | "done" | "failed" | "yielded" | "blocked" | "skipped" | "cancelled" | "exhausted";
export interface NodeResult {
  id: string;
  label: string;
  type: "bash" | "jev" | "foreach" | "repeat";
  status: NodeStatus;
  output?: unknown;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  artifact?: string;
}
export interface ExecutionEvent {
  sequence: number;
  time: number;
  graphId: string;
  type: "graph.building" | "graph.preview" | "graph.building.finished" | "graph.started" | "graph.finished" | "node.created" | "node.started" | "node.finished" | "node.output" | "edge.ready" | "plugin.activity" | "jev.request" | "jev.response";
  nodeId?: string;
  data: Record<string, unknown>;
}
export interface GraphReport {
  graphId: string;
  label: string;
  status: "done" | "partial" | "yielded" | "cancelled";
  reason?: string;
  previews: Array<{ id: string; type: NodeResult["type"]; status: NodeStatus; preview: string; artifact?: string }>;
  requested: Record<string, NodeResult>;
  recordPath: string;
}
export interface JevRequest { model?: string; state: unknown; questions: Record<string, unknown> }
export interface JevResponse { model: string; answers: Record<string, any>; usage?: Record<string, number> }
export interface JevAdapter { evaluate(request: JevRequest, signal?: AbortSignal): Promise<JevResponse> }

// The planner and UI communicate through this small, renderer-independent API.
/** `thinking` carries the planner's reasoning for a round; it renders dimmed. */
export interface ChatEntry { id: string; role: "user" | "assistant" | "notice" | "thinking"; text: string }
export interface ModelOption {
  /** A model reference: an OpenRouter ID, or `provider:model` for any other provider. */
  id: string; name: string; contextLength?: number;
  provider?: string;
  providerName?: string;
  /** False when the provider has no credentials yet. */
  available?: boolean;
  /** Undefined means metadata unavailable; [] means no effort selector. */
  reasoningEfforts?: string[];
  reasoningDefault?: string;
  reasoningMandatory?: boolean;
}
export type AgentPhase = "idle" | "thinking" | "responding" | "building" | "executing";
export interface AgentSnapshot {
  messages: ChatEntry[];
  busy: boolean;
  model: string;
  models: ModelOption[];
  events: ExecutionEvent[];
  sessionId: string;
  sessionName: string;
  contextTokens: number;
  contextLimit: number;
  cachedTokens: number;
  effort?: string;
  phase?: AgentPhase;
  activityStartedAt?: number;
  /** Set while a transient transport failure is waiting to be retried. */
  retry?: { attempt: number; attempts: number; resumesAt: number; reason: string };
  error?: string;
}
export interface AgentController {
  getSnapshot(): AgentSnapshot;
  subscribe(listener: () => void): () => void;
  submit(text: string): Promise<void>;
  interrupt(): void;
  setModel(id: string): void;
  setEffort(effort: string): Promise<void>;
  newSession(): Promise<void>;
  listSessions(): Promise<SessionSummary[]>;
  resumeSession(idOrPrefix: string): Promise<void>;
  setSessionName(name: string): Promise<void>;
  refreshModels?(signal?: AbortSignal): Promise<ModelOption[]>;
  pin(text: string): void;
}
