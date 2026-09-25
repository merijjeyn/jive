import type { SessionEvent, CompactionEventData, MessageEventData, PlannerMessage } from "./types.ts";
import { SessionStore } from "./store.ts";

export interface ContextPolicy {
  contextLimit: number;
  outputReserve?: number;
  toolResultReserve?: number;
  retentionRatio?: number;
  fixedTokenCost?: number;
}

export interface PreparedContext {
  messages: PlannerMessage[];
  estimatedTokens: number;
  contextLimit: number;
  compacted: boolean;
  archivePath?: string;
}

export class ContextCapacityError extends Error {
  readonly estimatedTokens: number;
  readonly availableTokens: number;

  constructor(estimatedTokens: number, availableTokens: number) {
    super(
      `The planner context requires approximately ${estimatedTokens} tokens, but only ${availableTokens} input tokens are available. Save or narrow oversized input before retrying.`,
    );
    this.name = "ContextCapacityError";
    this.estimatedTokens = estimatedTokens;
    this.availableTokens = availableTokens;
  }
}

export function estimateTokens(value: unknown): number {
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(1, Math.ceil(new TextEncoder().encode(encoded ?? "").byteLength / 4));
}

function messageTokens(message: PlannerMessage): number {
  // A native reply is the whole message as its provider sees it; the rest duplicates it.
  if (message.native !== undefined) return 4 + estimateTokens({ role: message.role, native: message.native });
  return 4 + estimateTokens(message);
}

function sumMessageTokens(messages: readonly PlannerMessage[]): number {
  return messages.reduce((total, message) => total + messageTokens(message), 0);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface MessageUnit {
  events: Array<SessionEvent<MessageEventData>>;
  tokens: number;
  toolExchange: boolean;
}

/**
 * Tool calls and all of their contiguous results are atomic. Every other
 * message is independently compactable, allowing a long autonomous task to
 * shed old graph rounds without losing the original user task.
 */
export function plannerMessageUnits(
  events: Array<SessionEvent<MessageEventData>>,
): MessageUnit[] {
  const units: MessageUnit[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const message = event.data.message;
    const callIds = message.role === "assistant"
      ? new Set((message.tool_calls ?? []).map((call) => call.id))
      : new Set<string>();
    if (callIds.size === 0) {
      units.push({ events: [event], tokens: messageTokens(message), toolExchange: false });
      continue;
    }

    const exchange = [event];
    while (index + 1 < events.length && callIds.size > 0) {
      const result = events[index + 1]!;
      const resultMessage = result.data.message;
      if (
        resultMessage.role !== "tool" ||
        !resultMessage.tool_call_id ||
        !callIds.has(resultMessage.tool_call_id)
      ) break;
      index += 1;
      exchange.push(result);
      callIds.delete(resultMessage.tool_call_id);
    }
    units.push({
      events: exchange,
      tokens: sumMessageTokens(exchange.map((entry) => entry.data.message)),
      toolExchange: callIds.size === 0,
    });
  }
  return units;
}

function originalTaskEvent(
  events: Array<SessionEvent<MessageEventData>>,
): SessionEvent<MessageEventData> | undefined {
  return events.find((event) => event.data.message.role === "user");
}

function latestCatalogMessageEvent(
  events: Array<SessionEvent<MessageEventData>>,
): SessionEvent<MessageEventData> | undefined {
  return events.findLast(
    (event) =>
      event.data.message.role === "system" &&
      event.data.message.content?.startsWith("Extractor plugin catalog update (append-only):") === true,
  );
}

function latestCompaction(
  events: readonly SessionEvent[],
): SessionEvent<CompactionEventData> | undefined {
  return events.findLast(
    (event): event is SessionEvent<CompactionEventData> => event.type === "context.compacted",
  );
}

function pinMessages(store: SessionStore, throughSequence = Number.POSITIVE_INFINITY): PlannerMessage[] {
  return store.events
    .filter((event) => event.type === "pin.added" && event.sequence <= throughSequence)
    .map((event) => String(event.data.text))
    .map((text) => ({
    role: "system" as const,
    content: `Pinned constraint (verbatim):\n${text}`,
  }));
}

function isPinnedConstraintMessage(
  message: PlannerMessage,
  pins: readonly PlannerMessage[],
): boolean {
  return message.role === "system" && pins.some((pin) => pin.content === message.content);
}

function activeMessagesFromEpoch(
  store: SessionStore,
  allMessages: Array<SessionEvent<MessageEventData>>,
  compaction: SessionEvent<CompactionEventData> | undefined,
): PlannerMessage[] {
  if (!compaction) return allMessages.map((event) => event.data.message);

  const retained = new Set(compaction.data.retainedSequences);
  const mandatory = new Set(compaction.data.mandatorySequences ?? []);
  const task = originalTaskEvent(allMessages);
  const catalog = latestCatalogMessageEvent(
    allMessages.filter((event) => event.sequence <= compaction.sequence),
  );
  const messages: PlannerMessage[] = [];
  const compactedPins = pinMessages(store, compaction.sequence);
  messages.push(...compactedPins);
  if (catalog) messages.push(catalog.data.message);
  messages.push(compaction.data.archiveMessage);
  if (task) messages.push(task.data.message);
  for (const event of allMessages) {
    if (retained.has(event.sequence) || mandatory.has(event.sequence) || event.sequence > compaction.sequence) {
      if (event.sequence === task?.sequence) continue;
      if (event.sequence === catalog?.sequence) continue;
      if (
        event.sequence <= compaction.sequence &&
        isPinnedConstraintMessage(event.data.message, compactedPins)
      ) continue;
      // Pins are lifted into their stable, canonical block at compaction time.
      // New pin messages (after the marker) still append normally.
      messages.push(event.data.message);
    }
  }
  return messages;
}

export class DeterministicContext {
  readonly store: SessionStore;
  readonly stablePrefix: readonly PlannerMessage[];
  readonly policy: Required<ContextPolicy>;

  constructor(
    store: SessionStore,
    stablePrefix: readonly PlannerMessage[],
    policy: ContextPolicy,
  ) {
    this.store = store;
    this.stablePrefix = structuredClone(stablePrefix);
    this.policy = {
      contextLimit: policy.contextLimit,
      outputReserve: policy.outputReserve ?? Math.min(16_384, Math.floor(policy.contextLimit * 0.2)),
      toolResultReserve: policy.toolResultReserve ?? Math.min(12_000, Math.floor(policy.contextLimit * 0.15)),
      retentionRatio: policy.retentionRatio ?? 0.3,
      fixedTokenCost: policy.fixedTokenCost ?? 0,
    };
  }

  get availableInputTokens(): number {
    return Math.max(
      1,
      this.policy.contextLimit -
        this.policy.outputReserve -
        this.policy.toolResultReserve,
    );
  }

  async prepare(): Promise<PreparedContext> {
    await this.store.initialize();
    await this.store.flush();
    const allMessages = this.store.plannerMessageEvents();
    const existingCompaction = latestCompaction(this.store.events);
    const active = activeMessagesFromEpoch(this.store, allMessages, existingCompaction);
    const current = [...this.stablePrefix, ...active];
    const currentTokens = sumMessageTokens(current) + this.policy.fixedTokenCost;
    if (currentTokens <= this.availableInputTokens) {
      return {
        messages: current,
        estimatedTokens: currentTokens,
        contextLimit: this.policy.contextLimit,
        compacted: false,
        ...(existingCompaction ? { archivePath: existingCompaction.data.archivePath } : {}),
      };
    }

    const compacted = await this.#compact(allMessages, existingCompaction);
    const messages = [...this.stablePrefix, ...compacted.messages];
    const estimatedTokens = sumMessageTokens(messages) + this.policy.fixedTokenCost;
    if (estimatedTokens > this.availableInputTokens) {
      throw new ContextCapacityError(estimatedTokens, this.availableInputTokens);
    }
    return {
      messages,
      estimatedTokens,
      contextLimit: this.policy.contextLimit,
      compacted: true,
      archivePath: this.store.logPath,
    };
  }

  async #compact(
    allMessages: Array<SessionEvent<MessageEventData>>,
    existing: SessionEvent<CompactionEventData> | undefined,
  ): Promise<{ messages: PlannerMessage[] }> {
    const task = originalTaskEvent(allMessages);
    const catalog = latestCatalogMessageEvent(allMessages);
    const pins = pinMessages(this.store);
    const target = Math.max(1, Math.floor(this.availableInputTokens * this.policy.retentionRatio));
    const units = plannerMessageUnits(allMessages);
    const retainedUnits: MessageUnit[] = [];
    let retainedTokens = 0;
    let retainedToolExchange = false;
    const hasToolExchange = units.some((unit) => unit.toolExchange);

    for (let index = units.length - 1; index >= 0; index -= 1) {
      const unit = units[index]!;
      // Always retain the newest complete unit. Thereafter stop at the closest
      // complete boundary at or above the approximate target, after including
      // the newest intact tool exchange when the history contains one.
      if (
        retainedUnits.length > 0 &&
        retainedTokens >= target &&
        (!hasToolExchange || retainedToolExchange)
      ) break;
      retainedUnits.unshift(unit);
      retainedTokens += unit.tokens;
      retainedToolExchange ||= unit.toolExchange;
    }

    const retainedEvents = retainedUnits.flatMap((unit) => unit.events);
    const retainedSequences = retainedEvents
      .map((event) => event.sequence)
      .filter((sequence) => sequence !== task?.sequence && sequence !== catalog?.sequence);
    const mandatorySequences = catalog ? [catalog.sequence] : [];
    const retainedFrom = retainedSequences.length
      ? Math.min(...retainedSequences)
      : task?.sequence ?? 0;
    const omitted = allMessages.filter(
      (event) =>
        event.sequence < retainedFrom &&
        event.sequence !== task?.sequence &&
        event.sequence !== catalog?.sequence &&
        !isPinnedConstraintMessage(event.data.message, pins),
    );
    const oldestOmitted = omitted.at(0)?.sequence ?? 0;
    const newestOmitted = omitted.at(-1)?.sequence ?? 0;
    const archiveMessage: PlannerMessage = {
      role: "system",
      content: [
        "Earlier session records were archived verbatim; no model summary was generated.",
        `Archive: ${this.store.logPath}`,
        `Omitted planner event sequences: ${oldestOmitted}-${newestOmitted}.`,
        `Search with execute_graph/bash, for example: rg -n --fixed-strings '<query>' ${shellQuote(this.store.logPath)}`,
        "Retrieved excerpts must cite their event sequence or artifact path.",
      ].join("\n"),
    };

    if (
      existing &&
      existing.data.retainedSequences.length === retainedSequences.length &&
      existing.data.retainedSequences.every((sequence, index) => sequence === retainedSequences[index]) &&
      (existing.data.mandatorySequences ?? []).length === mandatorySequences.length &&
      (existing.data.mandatorySequences ?? []).every(
        (sequence, index) => sequence === mandatorySequences[index],
      )
    ) {
      const existingMessages = activeMessagesFromEpoch(this.store, allMessages, existing);
      const tokens = sumMessageTokens([...this.stablePrefix, ...existingMessages]) + this.policy.fixedTokenCost;
      throw new ContextCapacityError(tokens, this.availableInputTokens);
    }

    await this.store.append("context.compacted", {
      retainedFrom: Number.isFinite(retainedFrom) ? retainedFrom : 0,
      omittedThrough: newestOmitted,
      archivePath: this.store.logPath,
      archiveMessage,
      retainedSequences,
      mandatorySequences,
    });

    const selected: PlannerMessage[] = [];
    selected.push(...pins);
    if (catalog) selected.push(catalog.data.message);
    selected.push(archiveMessage);
    if (task) selected.push(task.data.message);
    for (const event of retainedEvents) {
      if (
        event.sequence !== task?.sequence &&
        event.sequence !== catalog?.sequence &&
        !isPinnedConstraintMessage(event.data.message, pins)
      ) selected.push(event.data.message);
    }
    return { messages: selected };
  }
}

export { excerptOversizedOutput } from "./excerpts";
