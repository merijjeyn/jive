import { createHash, randomUUID } from "node:crypto";
import { GRAPH_GUIDE, PLANNING_GUIDE } from "../core/planner-guide.ts";
import { loadProjectInstructions, type ProjectInstructionsSnapshot } from "../core/project-instructions.ts";
import { emptyProjectSkills, loadProjectSkills, projectSkillsPrompt, type ProjectSkillsSnapshot } from "../core/project-skills.ts";
import { GRAPH_VALIDATION_HINT, GRAPH_VALIDATION_PREFIX, MINIMAL_GRAPH_EXAMPLE, repairGraph } from "../core/schema.ts";
import type { ExecuteOptions } from "../core/executor.ts";
import {
  applyGraphEdits,
  GRAPH_ID_PATTERN,
  GRAPH_MOD_TOOL_NAME,
  GRAPH_TOOL_NAME,
  graphModToolParameters,
  loadGraphFile,
  loadSavedGraph,
  parseGraphModCall,
  saveGraphForEditing,
} from "../core/graph-edits.ts";
import { GraphBuildingRound, type BuildingGraph } from "./graph-building.ts";
import { runtimeContext, runtimeContextMessage } from "./runtime-context.ts";

import type {
  AgentController,
  AgentSnapshot,
  ChatEntry,
  ExecutionEvent,
  Graph,
  GraphReport,
  ModelOption,
} from "../core/types.ts";
import {
  ContextCapacityError,
  DeterministicContext,
  estimateTokens,
  excerptOversizedOutput,
  fallbackSessionName,
  listSessions as discoverSessions,
  OpenRouterSessionNamer,
  resolveSessionReference,
  SESSION_NAMING_MODEL,
  SESSION_NAMING_RETRIES,
  SessionStore,
  type SessionNameGenerator,
  type SessionSummary,
  type PlannerMessage,
} from "../session/index.ts";
import {
  fetchOpenRouterModelCatalog,
  loadCachedModelCatalog,
  mergeModelOptions,
  saveModelCatalog,
} from "./models.ts";
import {
  OpenRouterClient,
  OpenRouterError,
  type OpenRouterCompletion,
  type OpenRouterUsage,
  type RetryPolicy,
} from "./openrouter.ts";

export interface AgentOptions {
  cwd: string;
  model?: string;
  sessionId?: string;
  apiKey?: string;
  execute: (
    graph: Graph,
    signal: AbortSignal,
    onEvent: (event: ExecutionEvent) => void,
    streaming?: Pick<ExecuteOptions, "graphId" | "updates">,
  ) => Promise<GraphReport>;
  getPluginCatalog: () => Promise<string>;
  toolSchema: Record<string, unknown>;
  demo?: boolean;
  /** Override capability facts when embedding an executor with different configuration. */
  getRuntimeContext?: () => ReturnType<typeof runtimeContext>;
  /** Enable only when execute() supports the streaming options argument. */
  supportsStreaming?: boolean;
  /** Transient-failure retries for planner requests; see DEFAULT_RETRY_POLICY. */
  retry?: Partial<RetryPolicy>;
  /** Optional side-channel namer. false disables naming; createAgent() supplies Gemma 3 27B by default. */
  generateSessionName?: SessionNameGenerator | false;
  sessionNamingModel?: string;
}

export const PLANNER_SYSTEM_PROMPT = [
  "You are Jive, a terminal agent that plans and executes graphs. You design the strategy and write code; bash handles mechanical work and Jev handles focused semantic judgments.",
  "Your tools are execute_graph for a new program and execute_graph_mod for a saved graph ID or file, with optional edits. Use the runtime context and contracts below as your operating interface.",
  PLANNING_GUIDE,
  "You may answer directly when no execution is needed.",
  "Treat graph results as observations, preserve artifact references, and never claim omitted output was complete.",
  "A tool result may describe interruption or partial effects; inspect it before deciding how to recover.",
  GRAPH_GUIDE,
].join("\n");

export function plannerSystemPrompt(
  cwd: string,
  instructions?: ProjectInstructionsSnapshot,
  skills?: ProjectSkillsSnapshot,
): string {
  const prompt = [PLANNER_SYSTEM_PROMPT, `Session working directory: ${cwd}`];
  if (instructions?.text !== null && instructions?.text !== undefined) {
    prompt.push([
      `Project instructions from ${instructions.path} (snapshotted when this session was created):`,
      instructions.text,
    ].join("\n"));
  }
  if (skills) prompt.push(projectSkillsPrompt(skills));
  return prompt.join("\n\n");
}

const DEFAULT_CONTEXT_LIMIT = 128_000;
const EFFORT_METADATA_TIMEOUT_MS = 10_000;
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const REASONING_EFFORT_SET = new Set<string>(REASONING_EFFORTS);
/** What "auto" sends. Provider defaults tend to be the heaviest thinking level; medium is the intended baseline. */
export const DEFAULT_REASONING_EFFORT = "medium";

/**
 * The effort sent when the user has not chosen one: medium, or the supported level nearest to it
 * (lower on ties). Unknown metadata still sends medium; a model with no effort control sends nothing.
 */
export function defaultEffortFor(option: ModelOption | undefined): string | undefined {
  const supported = option?.reasoningEfforts;
  if (supported === undefined) return DEFAULT_REASONING_EFFORT;
  const candidates = supported.filter((level) => REASONING_EFFORT_SET.has(level) && !(level === "none" && option?.reasoningMandatory));
  if (candidates.length === 0) return undefined;
  if (candidates.includes(DEFAULT_REASONING_EFFORT)) return DEFAULT_REASONING_EFFORT;
  const target = REASONING_EFFORTS.indexOf(DEFAULT_REASONING_EFFORT);
  const rank = (level: string) => REASONING_EFFORTS.indexOf(level as typeof REASONING_EFFORTS[number]);
  return candidates
    .slice()
    .sort((a, b) => (Math.abs(rank(a) - target) - Math.abs(rank(b) - target)) || (rank(a) - rank(b)))[0];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(
    signal?.aborted ||
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError"),
  );
}

function normalizeToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type === "function" && schema.function && typeof schema.function === "object") {
    return normalizeToolSchema(schema.function as Record<string, unknown>);
  }
  const isFunctionDefinition = typeof schema.name === "string" && "parameters" in schema;
  if (isFunctionDefinition && schema.name !== GRAPH_TOOL_NAME) {
    throw new Error("The planner tool schema must be named execute_graph.");
  }
  if (isFunctionDefinition) return structuredClone(schema);
  return {
    name: GRAPH_TOOL_NAME,
    description: "Execute a declarative program of bash and Jev nodes: parallel branches, foreach expansion over discovered items, bounded repeat loops with carried state, and Jev decisions that select the next work. Submit whole task phases, not single commands.",
    parameters: structuredClone(schema),
  };
}

/** The edit-and-rerun tool is intrinsic to the loop: it reads the run directory the loop writes. */
function graphModToolSchema(): Record<string, unknown> {
  return {
    name: GRAPH_MOD_TOOL_NAME,
    description: "Execute a saved graph in this session. Supply exactly one of base (earlier graphId) or file (graph JSON path). Optional edits change decoded values; omit edits or use [] to run unchanged. Validates and executes all nodes, saves a new graphId, and leaves the source unchanged. This reruns the graph, not just unfinished work.",
    parameters: structuredClone(graphModToolParameters),
  };
}

/** A tool-call ID is provider text; only its safe characters name a run directory. */
function provisionalGraphIdFor(callId: string): string {
  const safe = callId.replace(/[^a-zA-Z0-9_-]/g, "");
  const id = `planner-${safe || randomUUID()}`;
  return GRAPH_ID_PATTERN.test(id) ? id : `planner-${randomUUID()}`;
}

/** Tells the planner how to fix this graph without resending it. */
function rerunHint(graphId: string): string {
  return `Saved as graphId ${graphId}; call ${GRAPH_MOD_TOOL_NAME} with base ${JSON.stringify(graphId)} to rerun unchanged, or add edits. A file path can be supplied as file instead of base. All nodes run again; reuse persisted results or remove completed work when recovering.`;
}

function parsedGraph(argumentsText: string): { graph: Graph; repairs: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(argumentsText);
  } catch (error) {
    throw new Error(`execute_graph arguments are not valid JSON: ${errorMessage(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("execute_graph arguments must be a JSON object.");
  }
  const repaired = repairGraph(value);
  return { graph: repaired.value as Graph, repairs: repaired.repairs };
}

/**
 * Tool result for a failed graph. Schema rejections carry a hint and a minimal example so the
 * planner can resubmit instead of guessing at what "must be equal to constant" meant.
 */
function toolErrorContent(fields: { error: string } & Record<string, unknown>): string {
  const validation = fields.error.startsWith(GRAPH_VALIDATION_PREFIX);
  return JSON.stringify({
    status: "error",
    ...fields,
    ...(validation ? { hint: GRAPH_VALIDATION_HINT, example: MINIMAL_GRAPH_EXAMPLE } : {}),
  });
}

function usageMetadata(usage: OpenRouterUsage): Record<string, number> {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cachedTokens: usage.cachedTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  };
}

function terminalToolResult(callId: string, name: string, content: string): PlannerMessage {
  return { role: "tool", tool_call_id: callId, name, content };
}

function chatText(message: PlannerMessage): string | undefined {
  return typeof message.content === "string" && message.content ? message.content : undefined;
}

export class GraphAgentController implements AgentController {
  readonly options: AgentOptions;

  #store: SessionStore;
  #snapshot: AgentSnapshot;
  #listeners = new Set<() => void>();
  #abort?: AbortController;
  #client?: OpenRouterClient;
  #apiKey?: string;
  #ready: Promise<void>;
  #sideEffects: Promise<unknown> = Promise.resolve();
  #toolSchemas: Record<string, unknown>[];
  #activeSubmission?: Promise<void>;
  #resetPromise?: Promise<void>;
  #resetPending = false;
  #controlRevision = 0;
  #projectInstructions?: ProjectInstructionsSnapshot;
  #projectSkills?: ProjectSkillsSnapshot;
  #namingSessions = new Set<string>();

  constructor(options: AgentOptions) {
    this.options = options;
    this.#store = new SessionStore({ cwd: options.cwd, sessionId: options.sessionId });
    this.#apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    this.#toolSchemas = [normalizeToolSchema(options.toolSchema), graphModToolSchema()];
    const model = options.model ?? "";
    this.#snapshot = {
      messages: [],
      busy: false,
      model,
      models: mergeModelOptions(undefined, model ? [model] : []),
      events: [],
      sessionId: this.store.sessionId,
      sessionName: fallbackSessionName(this.store.sessionId),
      contextTokens: 0,
      contextLimit: DEFAULT_CONTEXT_LIMIT,
      cachedTokens: 0,
      phase: "idle",
    };
    if (this.#apiKey) this.#client = new OpenRouterClient({ apiKey: this.#apiKey, ...(this.options.retry ? { retry: this.options.retry } : {}) });
    this.#ready = this.#initialize().catch((error) => {
      this.#update({ error: `Could not restore session: ${errorMessage(error)}` });
    });
  }

  getSnapshot(): AgentSnapshot {
    return this.#snapshot;
  }

  get store(): SessionStore {
    return this.#store;
  }

  get sessionDirectory(): string {
    return this.#store.directory;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  submit(text: string): Promise<void> {
    if (this.#resetPromise) return this.#resetPromise.then(() => this.submit(text));
    if (this.#activeSubmission) {
      this.#update({ error: "The planner is already working. Interrupt it before submitting another message." });
      return Promise.resolve();
    }
    this.#controlRevision += 1;
    const operation = this.#submit(text);
    this.#activeSubmission = operation;
    const clear = () => {
      if (this.#activeSubmission === operation) this.#activeSubmission = undefined;
    };
    operation.then(clear, clear);
    return operation;
  }

  async #submit(text: string): Promise<void> {
    const input = text.trim();
    if (!input) return;
    await this.#ready;
    await this.#sideEffects;
    if (this.#resetPending) return;
    if (this.#snapshot.busy) {
      this.#update({ error: "The planner is already working. Interrupt it before submitting another message." });
      return;
    }

    const requestStore = this.store;
    const chatId = randomUUID();
    this.#appendChat({ id: chatId, role: "user", text: input });

    if (!this.#snapshot.model) {
      await this.store.appendMessage({ role: "user", content: input }, chatId);
      await this.#fail("Select an OpenRouter model before submitting.");
      this.#scheduleAutoName(requestStore);
      return;
    }
    if (!this.#apiKey || !this.#client) {
      await this.store.appendMessage({ role: "user", content: input }, chatId);
      await this.#fail(
        "OpenRouter API key is missing. Set OPENROUTER_API_KEY or pass apiKey to createAgent(), then restart or create a new controller.",
      );
      this.#scheduleAutoName(requestStore);
      return;
    }

    this.#update({ busy: true, error: undefined });
    this.#setPhase("thinking");
    this.#abort = new AbortController();
    try {
      await this.#refreshPluginCatalog();
      await this.store.appendMessage({ role: "user", content: input }, chatId);
      await this.#plannerLoop(this.#abort.signal);
    } catch (error) {
      if (isAbort(error, this.#abort.signal)) {
        await this.store.recoverInterruptedToolCalls({
          status: "cancelled",
          reason: "The user interrupted this planner turn before every emitted graph call could finish. Completed effects remain recorded; this call was not replayed.",
        });
        await this.#notice("Interrupted. Completed effects remain recorded; no operation was replayed.");
      } else {
        const prefix = error instanceof ContextCapacityError
          ? "Planner context is over capacity"
          : error instanceof OpenRouterError
            ? "OpenRouter error"
            : "Planner error";
        await this.#fail(`${prefix}: ${errorMessage(error)}`, error);
      }
    } finally {
      this.#abort = undefined;
      this.#setPhase("idle");
      this.#update({ busy: false, retry: undefined });
      await this.store.flush();
      this.#scheduleAutoName(requestStore);
    }
  }

  interrupt(): void {
    this.#abort?.abort(new DOMException("Interrupted by user", "AbortError"));
  }

  newSession(): Promise<void> {
    if (this.#resetPromise) return this.#resetPromise;
    this.#controlRevision += 1;
    this.#resetPending = true;
    this.#abort?.abort(new DOMException("Starting a new session", "AbortError"));
    this.#update({ busy: true, error: undefined });
    const operation = this.#performNewSession();
    this.#resetPromise = operation;
    const clear = () => {
      if (this.#resetPromise === operation) this.#resetPromise = undefined;
    };
    operation.then(clear, clear);
    return operation;
  }

  async #performNewSession(): Promise<void> {
    try {
      const active = this.#activeSubmission;
      if (active) await active.catch(() => undefined);
      await this.#ready;
      await this.#sideEffects;
      const oldStore = this.store;
      await oldStore.flush();

      const model = this.#snapshot.model;
      const effort = this.#snapshot.effort;
      const replacement = new SessionStore({ cwd: this.options.cwd });
      await replacement.initialize();
      const projectInstructions = await this.#loadSessionProjectInstructions(replacement);
      const projectSkills = await this.#loadSessionProjectSkills(replacement, true);
      if (model) await replacement.append("model.selected", { model });
      await replacement.append("effort.selected", { effort: effort ?? null });
      await replacement.flush();

      this.#store = replacement;
      this.#projectInstructions = projectInstructions;
      this.#projectSkills = projectSkills;
      this.#sideEffects = Promise.resolve();
      this.#snapshot = {
        ...this.#snapshot,
        messages: replacement.events.filter(event => event.type === "notice").map(event => ({
          id: String(event.data.chatId ?? event.id), role: "notice", text: String(event.data.text ?? ""),
        })),
        events: [],
        busy: false,
        sessionId: replacement.sessionId,
        sessionName: replacement.displayName(),
        contextTokens: 0,
        cachedTokens: 0,
        effort,
        phase: "idle",
        activityStartedAt: undefined,
        error: undefined,
      };
      this.#emit();
    } catch (error) {
      this.#setPhase("idle");
      this.#update({ busy: false, error: `Could not start a new session: ${errorMessage(error)}` });
      throw error;
    } finally {
      this.#resetPending = false;
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    await this.#ready;
    await this.#sideEffects;
    await this.store.flush();
    return discoverSessions(this.options.cwd);
  }

  resumeSession(idOrPrefix: string): Promise<void> {
    if (this.#resetPromise) return this.#resetPromise.then(() => this.resumeSession(idOrPrefix));
    this.#controlRevision += 1;
    this.#resetPending = true;
    this.#abort?.abort(new DOMException("Resuming another session", "AbortError"));
    this.#update({ busy: true, error: undefined });
    const operation = this.#performResumeSession(idOrPrefix);
    this.#resetPromise = operation;
    const clear = () => {
      if (this.#resetPromise === operation) this.#resetPromise = undefined;
    };
    operation.then(clear, clear);
    return operation;
  }

  async #performResumeSession(reference: string): Promise<void> {
    try {
      const active = this.#activeSubmission;
      if (active) await active.catch(() => undefined);
      await this.#ready;
      await this.#sideEffects;
      await this.store.flush();
      const sessionId = await resolveSessionReference(this.options.cwd, reference);
      if (sessionId === this.store.sessionId) {
        this.#update({ busy: false, error: undefined });
        return;
      }
      const replacement = new SessionStore({
        cwd: this.options.cwd,
        sessionId,
        existingOnly: true,
      });
      const restored = await this.#hydrateStore(replacement);
      this.#store = replacement;
      this.#projectInstructions = restored.projectInstructions;
      this.#projectSkills = restored.projectSkills;
      this.#sideEffects = Promise.resolve();
      this.#snapshot = { ...restored.snapshot, busy: false, error: undefined };
      this.#emit();
    } catch (error) {
      this.#setPhase("idle");
      this.#update({ busy: false, error: `Could not resume session: ${errorMessage(error)}` });
      throw error;
    } finally {
      this.#resetPending = false;
    }
  }

  async setSessionName(input: string): Promise<void> {
    if (this.#resetPromise) await this.#resetPromise;
    await this.#ready;
    await this.#sideEffects;
    if (this.#resetPending) throw new Error("Wait for the session switch to finish before naming it.");
    const store = this.store;
    const name = await store.setName(input, "manual");
    if (this.store === store) this.#update({ sessionName: name, error: undefined });
  }

  async setEffort(input: string): Promise<void> {
    if (this.#resetPromise) await this.#resetPromise;
    await this.#ready;
    await this.#sideEffects;
    if (this.#activeSubmission || this.#snapshot.busy) {
      const message = "Interrupt the active request before changing reasoning effort.";
      this.#update({ error: message });
      throw new Error(message);
    }
    const normalized = input.trim().toLowerCase();
    const targetStore = this.store;
    const targetModel = this.#snapshot.model;
    const targetRevision = ++this.#controlRevision;
    if (normalized === "auto" || normalized === "default") {
      this.#assertEffortTarget(targetStore, targetModel, targetRevision);
      const persistence = targetStore.append("effort.selected", { effort: null });
      this.#update({ effort: undefined, error: undefined });
      await persistence;
      return;
    }
    if (!REASONING_EFFORT_SET.has(normalized)) {
      const message = `Unknown reasoning effort ${JSON.stringify(input)}. Use auto, none, minimal, low, medium, high, xhigh, or max.`;
      this.#update({ error: message });
      throw new Error(message);
    }
    if (!targetModel) {
      const message = "Select a model before setting reasoning effort.";
      this.#update({ error: message });
      throw new Error(message);
    }

    let models = this.#snapshot.models;
    let option = models.find((candidate) => candidate.id === targetModel);
    if (option?.reasoningEfforts === undefined) {
      try {
        const catalog = await fetchOpenRouterModelCatalog({
          apiKey: this.#apiKey,
          signal: AbortSignal.timeout(EFFORT_METADATA_TIMEOUT_MS),
        });
        await saveModelCatalog(this.options.cwd, catalog);
        this.#assertEffortTarget(targetStore, targetModel, targetRevision);
        models = mergeModelOptions(catalog, [targetModel]);
      } catch (error) {
        this.#assertEffortTarget(targetStore, targetModel, targetRevision);
        const message = `Could not verify reasoning efforts for ${targetModel}: ${errorMessage(error)}`;
        this.#update({ error: message });
        throw new Error(message, { cause: error });
      }
      option = models.find((candidate) => candidate.id === targetModel);
    }
    this.#assertEffortTarget(targetStore, targetModel, targetRevision);
    if (!option?.reasoningEfforts?.includes(normalized)) {
      const supported = option?.reasoningEfforts?.length
        ? option.reasoningEfforts.join(", ")
        : "none reported";
      const message = `Reasoning effort ${normalized} is not supported by ${targetModel} (supported: ${supported}).`;
      this.#update({ error: message });
      throw new Error(message);
    }
    const persistence = targetStore.append("effort.selected", { effort: normalized });
    this.#update({
      models,
      contextLimit: this.#contextLimit(targetModel, models),
      effort: normalized,
      error: undefined,
    });
    await persistence;
  }

  setModel(id: string): void {
    const model = id.trim();
    if (!model) {
      this.#update({ error: "Model ID cannot be empty." });
      return;
    }
    if (this.#snapshot.busy) {
      this.#update({ error: "Interrupt the active request before changing models." });
      return;
    }
    if (this.#resetPending) {
      this.#update({ error: "Wait for the new session to finish opening before changing models." });
      return;
    }
    this.#controlRevision += 1;
    const models = this.#snapshot.models.some((option) => option.id === model)
      ? this.#snapshot.models
      : [...this.#snapshot.models, { id: model, name: model }];
    const selected = models.find((option) => option.id === model);
    const effort = this.#snapshot.effort;
    const resetEffort = this.#snapshot.model !== model && effort !== undefined &&
      !selected?.reasoningEfforts?.includes(effort);
    this.#update({
      model,
      models,
      ...(resetEffort ? { effort: undefined } : {}),
      error: undefined,
      contextLimit: this.#contextLimit(model, models),
    });
    if (resetEffort) {
      const text = `Reasoning effort reset to auto because ${model} does not report support for ${effort}.`;
      const chatId = randomUUID();
      this.#appendChat({ id: chatId, role: "notice", text });
      this.#enqueue(async () => {
        await this.store.append("model.selected", { model });
        await this.store.append("effort.selected", { effort: null });
        await this.store.append("notice", { chatId, text });
      });
    } else this.#enqueue(() => this.store.append("model.selected", { model }));
  }

  pin(text: string): void {
    if (!text) return;
    if (this.#resetPending) {
      this.#update({ error: "Wait for the new session to finish opening before pinning constraints." });
      return;
    }
    const id = randomUUID();
    this.#appendChat({ id, role: "notice", text: `Pinned constraint: ${text}` });
    this.#enqueue(async () => {
      await this.store.addPin(text);
      await this.store.append("notice", { chatId: id, text: `Pinned constraint: ${text}` });
    });
  }

  /** Explicit opt-in refresh; construction never waits on the network. */
  async refreshModels(signal?: AbortSignal): Promise<ModelOption[]> {
    await this.#ready;
    const catalog = await fetchOpenRouterModelCatalog({ apiKey: this.#apiKey, signal });
    await saveModelCatalog(this.options.cwd, catalog);
    const custom = this.#snapshot.model ? [this.#snapshot.model] : [];
    const models = mergeModelOptions(catalog, custom);
    const selected = models.find((option) => option.id === this.#snapshot.model);
    const effort = this.#snapshot.effort;
    const resetEffort = effort !== undefined && !selected?.reasoningEfforts?.includes(effort);
    this.#update({
      models,
      contextLimit: this.#contextLimit(this.#snapshot.model, models),
      ...(resetEffort ? { effort: undefined } : {}),
    });
    if (resetEffort) {
      const text = `Reasoning effort reset to auto because ${this.#snapshot.model} no longer reports support for ${effort}.`;
      await this.store.append("effort.selected", { effort: null });
      await this.#notice(text);
    }
    return models;
  }

  async ready(): Promise<void> {
    await this.#ready;
  }

  async #initialize(): Promise<void> {
    const restored = await this.#hydrateStore(this.store, this.options.model);
    this.#snapshot = restored.snapshot;
    this.#projectInstructions = restored.projectInstructions;
    this.#projectSkills = restored.projectSkills;
    this.#emit();
  }

  async #hydrateStore(store: SessionStore, modelOverride?: string): Promise<{
    snapshot: AgentSnapshot;
    projectInstructions: ProjectInstructionsSnapshot;
    projectSkills: ProjectSkillsSnapshot;
  }> {
    await store.initialize();
    const fresh = store.events.every((event) => event.type === "session.created");
    const projectInstructions = await this.#loadSessionProjectInstructions(store);
    const projectSkills = await this.#loadSessionProjectSkills(store, fresh);
    const recovered = await store.recoverInterruptedToolCalls();
    const cachedCatalog = await loadCachedModelCatalog(this.options.cwd);
    const storedModel = store.latestModel();
    const model = modelOverride ?? storedModel ?? this.#snapshot.model ?? "";
    const storedEffort = store.latestEffort();
    const restoredEffort = storedEffort && REASONING_EFFORT_SET.has(storedEffort)
      ? storedEffort
      : undefined;
    const models = mergeModelOptions(cachedCatalog, model ? [model] : []);
    const selected = models.find((option) => option.id === model);
    const changedModel = modelOverride !== undefined && model !== storedModel;
    const resetRestoredEffort = restoredEffort !== undefined && (
      selected?.reasoningEfforts !== undefined
        ? !selected.reasoningEfforts.includes(restoredEffort)
        : changedModel
    );
    const effort = resetRestoredEffort ? undefined : restoredEffort;
    if (resetRestoredEffort) {
      const support = selected?.reasoningEfforts === undefined
        ? "its effort support is unknown"
        : `it does not support ${restoredEffort}`;
      const text = `Reasoning effort reset to auto because the resumed session selected ${model} and ${support}.`;
      const chatId = randomUUID();
      await store.append("effort.selected", { effort: null });
      await store.append("notice", { chatId, text });
    }
    const messages: ChatEntry[] = [];
    const executionEvents: ExecutionEvent[] = [];
    let cachedTokens = 0;
    let lastPromptTokens = 0;

    for (const event of store.events) {
      if (event.type === "planner.message") {
        const data = event.data as {
          message?: PlannerMessage;
          chatId?: string;
          reasoningChatId?: string;
          usage?: Record<string, number>;
        };
        const message = data.message;
        if (!message) continue;
        if (data.usage) {
          cachedTokens += data.usage.cachedTokens ?? 0;
          lastPromptTokens = data.usage.promptTokens ?? lastPromptTokens;
        }
        if (message.role === "assistant" && message.reasoning) {
          messages.push({
            id: data.reasoningChatId ?? `reasoning-${event.id}`,
            role: "thinking",
            text: message.reasoning,
          });
        }
        const rendered = chatText(message);
        if (rendered && (message.role === "user" || message.role === "assistant")) {
          messages.push({
            id: data.chatId ?? event.id,
            role: message.role,
            text: rendered,
          });
        }
      } else if (event.type === "notice") {
        messages.push({
          id: String(event.data.chatId ?? event.id),
          role: "notice",
          text: String(event.data.text ?? ""),
        });
      } else if (event.type === "execution.event" && event.data.event) {
        executionEvents.push(event.data.event as ExecutionEvent);
      }
    }
    if (recovered.length) {
      messages.push({
        id: `recovered-${store.events.at(-1)?.id ?? randomUUID()}`,
        role: "notice",
        text: `${recovered.length} unfinished graph call${recovered.length === 1 ? " was" : "s were"} marked interrupted. The planner will decide recovery.`,
      });
    }
    const snapshot: AgentSnapshot = {
      ...this.#snapshot,
      messages,
      events: executionEvents,
      sessionId: store.sessionId,
      sessionName: store.displayName(),
      model,
      models,
      contextLimit: this.#contextLimit(model, models),
      cachedTokens,
      contextTokens: lastPromptTokens,
      effort,
      busy: false,
      phase: "idle",
      activityStartedAt: undefined,
      error: undefined,
    };
    if (fresh) {
      if (model) await store.append("model.selected", { model });
      await store.append("effort.selected", { effort: effort ?? null });
    }
    return { snapshot, projectInstructions, projectSkills };
  }

  async #loadSessionProjectInstructions(store: SessionStore): Promise<ProjectInstructionsSnapshot> {
    const persisted = store.projectInstructions();
    if (persisted) return persisted;
    const snapshot = await loadProjectInstructions(store.cwd);
    await store.append("project.instructions", { path: snapshot.path, text: snapshot.text });
    return snapshot;
  }

  async #loadSessionProjectSkills(store: SessionStore, fresh: boolean): Promise<ProjectSkillsSnapshot> {
    const persisted = store.projectSkills();
    if (persisted) return persisted;
    // Sessions predating skill discovery had no advertised skills. Preserve that on resume.
    const snapshot = fresh ? await loadProjectSkills(store.cwd) : emptyProjectSkills(store.cwd);
    await store.append("project.skills", { ...snapshot });
    for (const text of snapshot.diagnostics) await store.append("notice", { chatId: randomUUID(), text });
    return snapshot;
  }

  async #refreshPluginCatalog(publish = true): Promise<string | undefined> {
    let catalog: string;
    try {
      catalog = await this.options.getPluginCatalog();
    } catch (error) {
      await this.#notice(`Plugin catalog could not be refreshed: ${errorMessage(error)}`);
      return undefined;
    }
    const changed = catalog !== this.store.latestPluginCatalog();
    if (changed) await this.store.append("plugin.catalog", { catalog });
    if (publish && catalog !== this.store.latestPublishedPluginCatalog()) {
      await this.#publishPluginCatalog(catalog);
    }
    return changed ? catalog : undefined;
  }

  async #publishPluginCatalog(catalog: string): Promise<void> {
    if (catalog === this.store.latestPublishedPluginCatalog()) return;
    await this.store.appendMessage({
      role: "system",
      content: `Extractor plugin catalog update (append-only):\n${catalog || "(no plugins installed)"}`,
    }, undefined, { pluginCatalog: catalog });
  }

  async #plannerLoop(signal: AbortSignal): Promise<void> {
    // A turn ends when the model answers or the user interrupts it. Long tasks may
    // legitimately need many tool rounds, so there is no artificial round ceiling.
    while (true) {
      if (signal.aborted) throw signal.reason;
      const requestStore = this.store;
      this.#setPhase("thinking");
      const model = this.#snapshot.model;
      const contextLimit = this.#contextLimit(model, this.#snapshot.models);
      const capabilities = structuredClone(this.options.getRuntimeContext?.() ?? runtimeContext(requestStore.cwd, this.options.demo));
      capabilities.execution.streamingGraphs = Boolean(this.options.supportsStreaming);
      const prefix: PlannerMessage[] = [
        { role: "system", content: plannerSystemPrompt(requestStore.cwd, this.#projectInstructions, this.#projectSkills) },
        { role: "system", content: runtimeContextMessage(capabilities) },
      ];
      // Persist the exact instructions/tools once per change, not another copy every round.
      // The prefix is supplied anew even after compaction or a resumed session.
      const contextData = { messages: prefix, toolSchemas: this.#toolSchemas, runtime: capabilities };
      const hash = createHash("sha256").update(JSON.stringify(contextData)).digest("hex");
      let snapshot = requestStore.events.findLast(event => event.type === "planner.context");
      if (snapshot?.data.hash !== hash) snapshot = await requestStore.append("planner.context", { hash, ...contextData });
      const context = new DeterministicContext(
        requestStore,
        prefix,
        {
          contextLimit,
          fixedTokenCost: estimateTokens(this.#toolSchemas),
        },
      );
      const prepared = await context.prepare();
      const effort = this.#snapshot.effort ?? defaultEffortFor(this.#snapshot.models.find((option) => option.id === model));
      await requestStore.append("planner.request", {
        contextSequence: snapshot!.sequence,
        historyThroughSequence: requestStore.events.at(-1)?.sequence,
        compactionSequence: requestStore.events.findLast(event => event.type === "context.compacted")?.sequence,
        model, effort, estimatedTokens: prepared.estimatedTokens,
      });
      this.#update({ contextTokens: prepared.estimatedTokens, contextLimit });

      const streamId = `stream-${randomUUID()}`;
      const reasoningId = `reasoning-${randomUUID()}`;
      let streamed = false;
      let reasoned = false;
      let completion: OpenRouterCompletion;
      const building = new GraphBuildingRound({
        store: requestStore, signal, execute: this.options.execute,
        supportsStreaming: this.options.supportsStreaming,
        onEvent: event => {
          if (this.store !== requestStore) return;
          if (["graph.started", "node.created", "node.started", "node.output", "edge.ready", "plugin.activity", "jev.request", "jev.response", "node.finished", "graph.finished"].includes(event.type)) {
            this.#setPhase("executing");
          } else if (this.#snapshot.phase !== "executing") this.#setPhase("building");
          this.#update({ events: [...this.#snapshot.events, event] });
        },
      });
      try {
        completion = await this.#client!.complete({
          model,
          sessionId: requestStore.sessionId,
          messages: prepared.messages,
          toolSchema: this.#toolSchemas,
          effort,
          signal,
          onRetry: (notice) => {
            if (this.store !== requestStore) return;
            // Nothing of this attempt reached the transcript, so the round simply pauses.
            this.#update({ retry: { attempt: notice.attempt, attempts: notice.attempts, resumesAt: Date.now() + notice.delayMs, reason: notice.reason } });
            this.#enqueue(() => requestStore.append("transport.retry", {
              attempt: notice.attempt, attempts: notice.attempts, delayMs: notice.delayMs,
              reason: notice.reason, message: notice.error.message,
              ...(notice.error.status ? { status: notice.error.status } : {}),
            }));
          },
          onReasoning: (delta) => {
            if (this.store !== requestStore) return;
            if (this.#snapshot.phase !== "executing") this.#setPhase("thinking");
            // Reasoning is the bulk of a tool-only round; stream it into the
            // transcript so the history is more than the occasional reply.
            if (!delta) return;
            if (!reasoned) {
              reasoned = true;
              this.#insertChatBefore({ id: reasoningId, role: "thinking", text: delta }, streamId);
            } else {
              this.#update({
                messages: this.#snapshot.messages.map((message) =>
                  message.id === reasoningId ? { ...message, text: message.text + delta } : message,
                ),
              });
            }
          },
          onToolCall: async delta => {
            if (this.store !== requestStore) return;
            if (this.#snapshot.phase !== "executing") this.#setPhase("building");
            await building.receive(delta);
          },
          onContent: (delta) => {
            if (this.store !== requestStore) return;
            if (this.#snapshot.phase !== "executing") this.#setPhase("responding");
            // Streams often open with an empty content delta; an entry for it
            // would sit in the transcript as a bare reply marker.
            if (!delta) return;
            if (!streamed) {
              streamed = true;
              this.#appendChat({ id: streamId, role: "assistant", text: delta });
            } else {
              const messages = this.#snapshot.messages.map((message) =>
                message.id === streamId ? { ...message, text: message.text + delta } : message,
              );
              this.#update({ messages });
            }
          },
        });
        await building.finish(completion.message.tool_calls ?? []);
        if (this.#snapshot.retry) this.#update({ retry: undefined });
      } catch (error) {
        await building.interrupt(errorMessage(error));
        if (streamed) {
          const messages = this.#snapshot.messages.map((message) =>
            message.id === streamId
              ? { ...message, text: `${message.text}\n\n[Response interrupted; this partial text was not added to planner history.]` }
              : message,
          );
          this.#update({ messages });
        }
        throw error;
      }
      this.#update({
        contextTokens: completion.usage.promptTokens || prepared.estimatedTokens,
        cachedTokens: this.#snapshot.cachedTokens + completion.usage.cachedTokens,
      });
      const reasoningText = completion.message.reasoning;
      if (reasoningText && !reasoned) {
        reasoned = true;
        this.#insertChatBefore({ id: reasoningId, role: "thinking", text: reasoningText }, streamId);
      }
      const finalText = chatText(completion.message);
      if (finalText && !streamed) this.#appendChat({ id: streamId, role: "assistant", text: finalText });
      await this.store.appendMessage(completion.message, finalText ? streamId : undefined, {
        ...(reasoned ? { reasoningChatId: reasoningId } : {}),
        requestedModel: model,
        returnedModel: completion.model,
        ...(completion.provider ? { provider: completion.provider } : {}),
        usage: usageMetadata(completion.usage),
      });

      const calls = completion.message.tool_calls ?? [];
      if (calls.length === 0) return;
      let unpublishedCatalog: string | undefined;
      for (const [index, call] of calls.entries()) {
        if (signal.aborted) { await building.interrupt(errorMessage(signal.reason)); throw signal.reason; }
        this.#setPhase("executing");
        await this.#executeToolCall(call.id, call.function.name, call.function.arguments, signal, building.states.get(index), building);
        const changedCatalog = await this.#refreshPluginCatalog(false);
        if (changedCatalog !== undefined) unpublishedCatalog = changedCatalog;
      }
      if (unpublishedCatalog !== undefined) {
        await this.#publishPluginCatalog(unpublishedCatalog);
      }
    }
  }

  async #executeToolCall(
    callId: string,
    name: string,
    argumentsText: string,
    signal: AbortSignal,
    building?: BuildingGraph,
    round?: GraphBuildingRound,
  ): Promise<void> {
    if (name === GRAPH_MOD_TOOL_NAME) {
      await this.#executeGraphMod(callId, argumentsText, signal);
      return;
    }
    if (name !== GRAPH_TOOL_NAME) {
      const content = JSON.stringify({
        status: "error",
        error: `Unknown tool ${JSON.stringify(name)}. The available tools are ${GRAPH_TOOL_NAME} and ${GRAPH_MOD_TOOL_NAME}.`,
      });
      await this.store.appendMessage(terminalToolResult(callId, name, content));
      this.#update({ error: `Planner attempted unavailable tool ${name}.` });
      return;
    }

    if (building?.run) {
      await this.store.append("graph.started", { callId, graphId: building.id, graph: building.graph });
      const outcome = await building.run;
      await round?.flush();
      await this.store.append("graph.finished", { callId, graphId: building.id, ...outcome });
      // Arguments that stopped parsing after the first commitment end this call, not the turn:
      // the planner reads what already ran here and resubmits only the remaining work.
      const streamError = building.error
        ? `The graph arguments stopped being readable after committed work had already started: ${building.error} — the effects in this report really happened and were not replayed. Resubmit a corrected graph for the remaining work only.`
        : undefined;
      if (outcome.report) await this.#appendGraphReport(callId, name, outcome.report, building.parser.repairs, undefined, streamError);
      else {
        // The executor wrote graph.json when the stream committed, so the failed graph is editable.
        await this.store.appendMessage(terminalToolResult(callId, name, toolErrorContent({
          error: streamError ?? outcome.error ?? "Graph execution failed.", graphId: building.id, replayed: false, rerun: rerunHint(building.id),
        })));
      }
      await this.store.append("graph.stream.published", { streamId: building.id, callId });
      if (streamError) this.#update({ error: `Graph generation failed: ${building.error}` });
      return;
    }

    const provisionalGraphId = building?.id ?? provisionalGraphIdFor(callId);
    let graph: Graph;
    let repairs: string[];
    try {
      ({ graph, repairs } = parsedGraph(argumentsText));
    } catch (error) {
      const message = errorMessage(error);
      await this.store.appendMessage(terminalToolResult(callId, name, toolErrorContent({ error: message })));
      this.#update({ error: message });
      return;
    }
    if (building?.error) {
      // The streamed arguments parsed but failed the contract. Save them so one edit can fix them.
      const saved = await this.#saveForEditing(provisionalGraphId, graph);
      await this.store.appendMessage(terminalToolResult(callId, name, toolErrorContent({
        error: building.error,
        ...(saved ? { graphId: provisionalGraphId, rerun: rerunHint(provisionalGraphId) } : {}),
      })));
      this.#update({ error: building.error });
      return;
    }
    await this.#runGraph({ callId, name, graph, repairs, signal, provisionalGraphId, building, round });
  }

  /** execute_graph_mod: load the saved base, apply edits to its decoded values, then run it like any graph. */
  async #executeGraphMod(callId: string, argumentsText: string, signal: AbortSignal): Promise<void> {
    const name = GRAPH_MOD_TOOL_NAME;
    const fail = async (error: string, fields: Record<string, unknown> = {}) => {
      await this.store.appendMessage(terminalToolResult(callId, name, toolErrorContent({ error, ...fields })));
      this.#update({ error });
    };
    let call: ReturnType<typeof parseGraphModCall>;
    try {
      call = parseGraphModCall(argumentsText);
    } catch (error) {
      await fail(errorMessage(error));
      return;
    }
    let base: unknown;
    try {
      base = call.base !== undefined
        ? await loadSavedGraph(this.options.cwd, call.base)
        : await loadGraphFile(this.options.cwd, call.file!);
    } catch (error) {
      await fail(errorMessage(error), { base: call.base, file: call.file });
      return;
    }
    let edited: unknown;
    let applied: string[];
    try {
      ({ graph: edited, applied } = applyGraphEdits(base, call.edits));
    } catch (error) {
      await fail(errorMessage(error), { base: call.base, file: call.file, hint: "The source is unchanged and nothing ran. Fix the failing edit and resend the whole edits list against the same source." });
      return;
    }
    if (call.label && edited && typeof edited === "object" && !Array.isArray(edited)) {
      (edited as Record<string, unknown>).label = call.label;
    }
    const repaired = repairGraph(edited);
    await this.#runGraph({
      callId, name, graph: repaired.value as Graph, repairs: repaired.repairs, signal,
      provisionalGraphId: provisionalGraphIdFor(callId),
      startedFields: { ...(call.base !== undefined ? { base: call.base } : { file: call.file }), edits: call.edits },
      applied,
    });
  }

  /** Shared non-streaming execution path: record intent, execute, record the outcome, answer the tool call. */
  async #runGraph(input: {
    callId: string;
    name: string;
    graph: Graph;
    repairs: string[];
    signal: AbortSignal;
    provisionalGraphId: string;
    building?: BuildingGraph;
    round?: GraphBuildingRound;
    /** Extra fields for the graph.started event, e.g. the base and edits of a rerun. */
    startedFields?: Record<string, unknown>;
    applied?: string[];
  }): Promise<void> {
    const { callId, name, graph, repairs, signal, provisionalGraphId, building, round } = input;
    await this.store.append("graph.started", {
      callId,
      graphId: provisionalGraphId,
      graph,
      ...(input.startedFields ?? {}),
    });
    const pendingEvents: Promise<unknown>[] = [];
    let report: GraphReport;
    try {
      report = await this.options.execute(graph, signal, (event) => {
        if (building && round) round.emit(building, event);
        else {
          this.#update({ events: [...this.#snapshot.events, event] });
          pendingEvents.push(this.store.append("execution.event", { callId, event }));
        }
      }, building ? { graphId: building.id } : this.options.supportsStreaming ? { graphId: provisionalGraphId } : undefined);
      await Promise.all(pendingEvents);
      await round?.flush();
      await this.store.append("graph.finished", {
        callId,
        graphId: report.graphId,
        report,
      });
    } catch (error) {
      await Promise.allSettled(pendingEvents);
      const aborted = isAbort(error, signal);
      const message = aborted ? "Graph execution was interrupted." : errorMessage(error);
      await this.store.append(aborted ? "graph.interrupted" : "graph.finished", {
        callId,
        graphId: provisionalGraphId,
        status: aborted ? "interrupted" : "error",
        error: message,
      });
      // Validation rejects before the executor writes graph.json; save it so the planner can edit instead of resend.
      const saved = aborted ? false : await this.#saveForEditing(provisionalGraphId, graph);
      await this.store.appendMessage(
        terminalToolResult(callId, name, aborted
          ? JSON.stringify({ status: "interrupted", graphId: provisionalGraphId, error: message, replayed: false })
          : toolErrorContent({
            graphId: provisionalGraphId, error: message, replayed: false,
            ...(saved ? { rerun: rerunHint(provisionalGraphId) } : {}),
          })),
      );
      if (aborted) throw error;
      this.#update({ error: `Graph execution failed: ${message}` });
      return;
    }

    await this.#appendGraphReport(callId, name, report, repairs, input.applied);
  }

  async #saveForEditing(graphId: string, graph: unknown): Promise<boolean> {
    try {
      await saveGraphForEditing(this.options.cwd, graphId, graph);
      return true;
    } catch (error) {
      await this.#notice(`Could not save graph ${graphId} for editing: ${errorMessage(error)}`);
      return false;
    }
  }

  async #appendGraphReport(
    callId: string,
    name: string,
    report: GraphReport,
    repairs: string[] = [],
    applied?: string[],
    streamError?: string,
  ): Promise<void> {
    // The report keeps its own status: it describes what really ran, which is what the planner
    // has to reason about even when the arguments that produced it were malformed.
    const serialized = JSON.stringify({
      ...(streamError ? { error: streamError } : {}),
      ...report,
      ...(repairs.length ? { repairs: repairs.map(repair => `${repair}. Send the corrected shape next time.`) } : {}),
      ...(applied ? { applied } : {}),
      rerun: rerunHint(report.graphId),
    });
    const maxInline = Math.max(
      4_000,
      Math.min(48_000, Math.floor(this.#snapshot.contextLimit * 0.6)),
    );
    const content = await excerptOversizedOutput(
      this.store,
      `${report.graphId}-planner-result.json`,
      serialized,
      maxInline,
    );
    await this.store.appendMessage(terminalToolResult(callId, name, content));
    if (report.status === "done" && !streamError) this.#update({ error: undefined });
  }

  #scheduleAutoName(store: SessionStore): void {
    const generate = this.options.generateSessionName;
    if (!generate || store.namingAttempted() || this.#namingSessions.has(store.sessionId)) return;
    const messageEvents = store.plannerMessageEvents();
    const firstUserIndex = messageEvents.findIndex((event) => event.data.message.role === "user");
    if (firstUserIndex < 0) return;
    const userMessage = chatText(messageEvents[firstUserIndex]!.data.message);
    if (!userMessage) return;
    const assistantMessage = messageEvents
      .slice(firstUserIndex + 1)
      .map((event) => event.data.message)
      .find((message) => message.role === "assistant" && chatText(message));
    this.#namingSessions.add(store.sessionId);
    void (async () => {
      try {
        const name = await generate({
          sessionId: store.sessionId,
          userMessage,
          ...(assistantMessage && chatText(assistantMessage)
            ? { assistantMessage: chatText(assistantMessage) }
            : {}),
        });
        // A manual name entered while generation was running always wins.
        if (store.latestName()) return;
        const saved = await store.setName(
          name,
          "generated",
          this.options.sessionNamingModel ?? SESSION_NAMING_MODEL,
        );
        if (this.store === store) this.#update({ sessionName: saved });
      } catch (error) {
        await store.append("session.name.failed", {
          model: this.options.sessionNamingModel ?? SESSION_NAMING_MODEL,
          attempts: SESSION_NAMING_RETRIES + 1,
          error: errorMessage(error).slice(0, 500),
        }).catch(() => undefined);
      } finally {
        this.#namingSessions.delete(store.sessionId);
      }
    })();
  }

  #contextLimit(model: string, models: readonly ModelOption[]): number {
    return models.find((option) => option.id === model)?.contextLength ?? DEFAULT_CONTEXT_LIMIT;
  }

  #assertEffortTarget(
    store: SessionStore,
    model: string,
    revision: number,
  ): void {
    if (
      this.store !== store ||
      this.#snapshot.model !== model ||
      this.#controlRevision !== revision ||
      this.#resetPending ||
      this.#activeSubmission ||
      this.#snapshot.busy
    ) {
      throw new Error(
        "Reasoning effort change was cancelled because the session, model, or active request changed while model metadata was loading.",
      );
    }
  }

  #setPhase(phase: NonNullable<AgentSnapshot["phase"]>): void {
    if (this.#snapshot.phase === phase) return;
    this.#update({
      phase,
      // The clock belongs to the turn, not to the phase within it: thinking handing over to
      // building and back is one stretch of work, so it keeps running until the turn goes idle.
      activityStartedAt: phase === "idle" ? undefined : this.#snapshot.activityStartedAt ?? Date.now(),
    });
  }

  #enqueue(operation: () => Promise<unknown>): void {
    this.#sideEffects = this.#sideEffects.then(async () => {
      await this.#ready;
      return operation();
    }).catch((error) => {
      this.#update({ error: `Session persistence error: ${errorMessage(error)}` });
    });
  }

  async #fail(message: string, cause?: unknown): Promise<void> {
    this.#update({ error: message });
    await this.#notice(message);
    await this.store.append("transport.error", {
      message,
      ...(cause instanceof OpenRouterError && cause.status ? { status: cause.status } : {}),
      ...(cause instanceof OpenRouterError && cause.details !== undefined
        ? { details: cause.details }
        : {}),
    });
  }

  async #notice(text: string): Promise<void> {
    const id = randomUUID();
    this.#appendChat({ id, role: "notice", text });
    await this.store.append("notice", { chatId: id, text });
  }

  #appendChat(entry: ChatEntry): void {
    this.#update({ messages: [...this.#snapshot.messages, entry] });
  }

  /**
   * Reasoning belongs above the reply it produced. Providers may deliver it
   * after content has already streamed, so place it before that entry when
   * the entry exists and append otherwise.
   */
  #insertChatBefore(entry: ChatEntry, beforeId: string): void {
    const messages = this.#snapshot.messages;
    const index = messages.findIndex((message) => message.id === beforeId);
    if (index < 0) { this.#appendChat(entry); return; }
    this.#update({ messages: [...messages.slice(0, index), entry, ...messages.slice(index)] });
  }

  #update(patch: Partial<AgentSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try { listener(); } catch { /* UI listeners cannot break the agent loop. */ }
    }
  }
}

export function createAgent(options: AgentOptions): AgentController {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  const namer = apiKey && options.generateSessionName === undefined
    ? new OpenRouterSessionNamer({ apiKey })
    : undefined;
  return new GraphAgentController({
    ...options,
    ...(apiKey ? { apiKey } : {}),
    ...(options.generateSessionName
      ? {}
      : namer ? { generateSessionName: namer.generate } : {}),
    sessionNamingModel: options.sessionNamingModel ?? SESSION_NAMING_MODEL,
  });
}
