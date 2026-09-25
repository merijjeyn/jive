import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AsyncQueue } from "../core/async-queue";
import { BUILDING_LABEL, GraphStreamParser } from "../core/graph-stream";
import type { ExecutionEvent, Graph, GraphReport } from "../core/types";
import type { SessionStore } from "../session/store";
import type { AgentOptions } from "./agent";
import type { ToolCallDelta } from "../providers/types.ts";

export interface BuildingGraph {
  id: string;
  parser: GraphStreamParser;
  length: number;
  sequence: number;
  error?: string;
  graph?: Graph;
  queue: AsyncQueue<Graph>;
  abort: AbortController;
  run?: Promise<{ report?: GraphReport; error?: string }>;
  callId?: string;
}

function isWholeObject(text: string): boolean {
  if (!text.trimEnd().endsWith("}")) return false;
  try {
    const value: unknown = JSON.parse(text);
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** UI previews and committed execution share one identity throughout a planner turn. */
export class GraphBuildingRound {
  readonly states = new Map<number, BuildingGraph>();
  private pending: Promise<unknown>[] = [];
  constructor(private options: {
    store: SessionStore;
    signal: AbortSignal;
    execute: AgentOptions["execute"];
    supportsStreaming?: boolean;
    onEvent: (event: ExecutionEvent) => void;
  }) {}

  emit(state: BuildingGraph, event: Omit<ExecutionEvent, "sequence" | "graphId">): void {
    const actual: ExecutionEvent = { ...event, graphId: state.id, sequence: ++state.sequence };
    this.options.onEvent(actual);
    this.pending.push(this.options.store.append("execution.event", { streamId: state.id, event: actual }));
  }

  async receive(delta: ToolCallDelta): Promise<void> {
    if (this.states.has(delta.index) && delta.name !== "execute_graph") {
      throw new Error("A streamed tool call cannot change its committed execute_graph name");
    }
    if (delta.name !== "execute_graph") return;
    let state = this.states.get(delta.index);
    if (!state) {
      state = { id: randomUUID(), parser: new GraphStreamParser(Boolean(this.options.supportsStreaming) && delta.index === 0), length: 0, sequence: 0,
        queue: new AsyncQueue(), abort: new AbortController() };
      this.states.set(delta.index, state);
      this.emit(state, { time: Date.now(), type: "graph.building", data: { label: BUILDING_LABEL } });
    }
    if (state.error) return;
    const fresh = delta.arguments.slice(state.length);
    // Some providers (Gemini) deliver a finished call in one fragment, re-serialized with its keys
    // in arbitrary order. Nothing was streamed, so validate it as a whole graph, like a replay,
    // rather than committing entries and freezing settings in the order they happen to appear.
    if (state.length === 0 && isWholeObject(fresh)) state.parser = new GraphStreamParser(false);
    state.length = delta.arguments.length;
    try {
      for (const update of state.parser.push(fresh)) {
        state.graph = update.graph;
        this.emit(state, { time: Date.now(), type: "graph.preview", data: { graph: update.graph } });
        if (update.kind === "commit" && this.options.supportsStreaming && delta.index === 0) {
          if (!state.run) {
            // Durable intent precedes the first command, even before a complete assistant message exists.
            await this.options.store.append("graph.stream.started", {
              streamId: state.id, graphId: state.id, graph: update.graph,
              recordPath: join(this.options.store.cwd, ".jev", "runs", state.id),
            });
            const executing = state;
            state.run = this.options.execute(update.graph,
              AbortSignal.any([this.options.signal, state.abort.signal]),
              event => this.emit(executing, event), { graphId: state.id, updates: state.queue },
            ).then(async report => {
              await this.options.store.append("graph.stream.finished", { streamId: executing.id, graphId: executing.id, report });
              return { report };
            }, async error => {
              const message = error instanceof Error ? error.message : String(error);
              await this.options.store.append("graph.stream.finished", { streamId: executing.id, graphId: executing.id, error: message });
              return { error: message };
            });
          } else state.queue.push(update.graph);
        }
      }
    } catch (error) {
      // Committed effects cannot be undone, so a broken tail stops the remaining work and is
      // reported as this call's result. Tearing down the whole turn would only force the user
      // to ask the planner to continue from evidence it can already read here.
      state.error = error instanceof Error ? error.message : String(error);
      state.abort.abort(new Error(state.error));
      state.queue.close();
    }
  }

  async finish(calls: Array<{id:string}>): Promise<void> {
    const states = [...this.states.entries()].sort(([a],[b]) => a-b);
    for (const [index, state] of states) {
      state.callId = calls[index]?.id;
      if (!state.error) {
        try {
          state.graph = state.parser.finish();
          if (state.run) state.queue.push(state.graph);
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error);
          state.abort.abort(new Error(state.error));
        }
      }
      state.queue.close();
      this.emit(state, { time: Date.now(), type: "graph.building.finished", data: {
        status: state.error ? "failed" : "ready", error: state.error,
      } });
      if (state.run && state.callId) await this.options.store.append("graph.stream.bound", {
        streamId: state.id, callId: state.callId, graphId: state.id,
      });
    }
    await this.flush();
  }

  async interrupt(reason: string): Promise<void> {
    for (const state of this.states.values()) {
      state.abort.abort(new Error(reason));
      state.queue.close();
      this.emit(state, { time: Date.now(), type: "graph.building.finished", data: { status: "interrupted", error: reason } });
    }
    await Promise.all([...this.states.values()].map(state => state.run));
    await this.flush();
    await this.options.store.recoverInterruptedToolCalls({
      status: this.options.signal.aborted ? "cancelled" : "interrupted",
      reason: `Graph generation stopped: ${reason}. Completed effects remain saved; unfinished work was not replayed.`,
    });
  }

  async flush(): Promise<void> { await Promise.all(this.pending); this.pending = []; }
}
