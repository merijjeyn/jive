import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import type { AgentController, AgentSnapshot, ExecutionEvent } from "../src/core/types.ts";
import { App, runWithRenderer } from "../src/ui/app.tsx";
import { COMMANDS, filterCommands, parseComposerInput, slashQuery } from "../src/ui/commands.ts";
import { EDGE_SWEEP_MS_PER_CELL, edgeCellState, foldableIds, groupSummary, gutterText, layoutGraph, layoutToText, sweepActive, visibleRows } from "../src/ui/graph/layout.ts";
import { countStatuses, edgeReady, reduceGraphs, statusTone, type UIExecutionEvent } from "../src/ui/graph/model.ts";
import { orbSize, orbToString, renderOrb } from "../src/ui/orb.ts";
import { BUILD_WORDS, buildingTitle, changeBadge, changeLines, GraphView, toneColor } from "../src/ui/components/GraphView.tsx";
import { BUILDING_LABEL } from "../src/core/graph-stream.ts";
import { palette } from "../src/ui/theme.ts";

// ---------------------------------------------------------------------------
// Fixtures

function eventFactory(graphId = "g1", baseTime = 1_000_000) {
  let seq = 0;
  return (type: ExecutionEvent["type"], nodeId: string | undefined, data: Record<string, unknown>, time?: number): ExecutionEvent => {
    seq += 1;
    return { sequence: seq, time: time ?? baseTime + seq * 10, graphId, type, nodeId, data };
  };
}

/** A join (pick needs scan+grep), a foreach group with children, and a downstream join on the group. */
function sampleEvents(): ExecutionEvent[] {
  const ev = eventFactory();
  return [
    ev("graph.started", undefined, { label: "investigate expiry" }),
    ev("node.created", "scan", { label: "scan repo", type: "bash", needs: [] }),
    ev("node.created", "grep", { label: "grep tests", type: "bash", needs: [] }),
    ev("node.created", "pick", { label: "pick file", type: "jev", needs: ["scan", "grep"] }),
    ev("node.created", "loop", { label: "per file", type: "foreach", needs: ["pick"] }),
    ev("node.created", "loop/0/read", { label: "read a.ts", type: "bash", needs: ["pick"], parent: "loop" }),
    ev("node.created", "loop/1/read", { label: "read b.ts", type: "bash", needs: ["pick"], parent: "loop" }),
    ev("node.created", "verify", { label: "verify", type: "bash", needs: ["loop", "scan"] }),
    ev("node.started", "scan", { label: "scan repo", type: "bash" }),
    ev("node.started", "grep", { type: "bash" }),
    ev("node.output", "scan", { chunk: "src/a.ts\n" }),
    ev("node.output", "scan", { chunk: "src/b.ts\n" }),
    ev("node.finished", "scan", { result: { id: "scan", label: "scan repo", type: "bash", status: "done", output: { stdout: "src/a.ts\nsrc/b.ts\n", exitCode: 0 }, artifact: ".jev/artifacts/scan.json" } }),
    ev("edge.ready", undefined, { from: "scan", to: "pick" }),
    ev("edge.ready", undefined, { from: "scan", to: "verify" }),
    ev("node.finished", "grep", { result: { id: "grep", label: "grep tests", type: "bash", status: "failed", error: "exit 2: no matches" } }),
    ev("node.finished", "pick", { result: { id: "pick", label: "pick file", type: "jev", status: "blocked" } }),
  ];
}

function jevEvents(): ExecutionEvent[] {
  const ev = eventFactory("g2");
  return [
    ev("graph.started", undefined, { label: "decide" }),
    ev("node.created", "judge", { label: "judge candidate", type: "jev", needs: [] }),
    ev("node.started", "judge", { type: "jev" }),
    ev("jev.request", "judge", { model: "jev-1.13.0", state: { observation: { test: "refreshes an expired session" } }, questions: { pick: { type: "choice", instructions: "Select the file", choices: ["a", "b", "none"] } } }),
    ev("jev.response", "judge", { model: "jev-1.13.0", answers: { pick: { choice: "a", probability: 0.8 } } }),
    ev("node.finished", "judge", { result: { id: "judge", label: "judge candidate", type: "jev", status: "yielded", output: { pick: "a" } } }),
    ev("graph.finished", undefined, { status: "yielded", reason: "acceptance criteria not met" }),
  ];
}

/** Streaming construction preview followed by the real run, sharing graphId "g3". */
function previewEvents(base = 1_000_000): UIExecutionEvent[] {
  let seq = 0;
  const ev = (type: UIExecutionEvent["type"], nodeId: string | undefined, data: Record<string, unknown>): UIExecutionEvent => {
    seq += 1;
    return { sequence: seq, time: base + seq * 10, graphId: "g3", type, nodeId, data };
  };
  return [
    ev("graph.building", undefined, { label: "draft plan" }),
    ev("graph.preview", undefined, { graph: { nodes: { scan: { type: "bash", label: "scan repo", script: "ls" } } } }),
    ev("graph.preview", undefined, {
      graph: {
        nodes: { scan: { type: "bash", label: "scan repo", script: "ls" }, pick: { type: "jev", label: "pick file", needs: ["scan"], state: {}, questions: {} } },
        groups: { loop: { kind: "foreach", label: "per file", needs: ["pick"], items: [], template: "t", maxItems: 3 } },
      },
    }),
  ];
}

function previewRuntimeEvents(base = 1_000_000): UIExecutionEvent[] {
  let seq = 100;
  const ev = (type: UIExecutionEvent["type"], nodeId: string | undefined, data: Record<string, unknown>): UIExecutionEvent => {
    seq += 1;
    return { sequence: seq, time: base + seq * 10, graphId: "g3", type, nodeId, data };
  };
  return [
    ev("graph.building.finished", undefined, { status: "ready" }),
    ev("graph.started", undefined, { label: "draft plan" }),
    ev("node.created", "scan", { label: "scan repo", type: "bash", needs: [] }),
    ev("node.created", "pick", { label: "pick file", type: "jev", needs: ["scan"] }),
    ev("node.created", "loop", { label: "per file", type: "foreach", needs: ["pick"] }),
    ev("node.started", "scan", { type: "bash" }),
  ];
}

/** Events typed as the core union so they fit AgentSnapshot; the reducer accepts both. */
const asCore = (events: UIExecutionEvent[]): ExecutionEvent[] => events as unknown as ExecutionEvent[];

interface MockController extends AgentController {
  calls: string[];
  update(patch: Partial<AgentSnapshot>): void;
}

function makeController(initial: Partial<AgentSnapshot> = {}): MockController {
  let state: AgentSnapshot = {
    messages: [],
    busy: false,
    model: "anthropic/claude-sonnet-5",
    models: [
      { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 200_000 },
      { id: "openai/gpt-6-astra", name: "GPT-6 Astra", contextLength: 400_000, reasoningEfforts: ["low", "high"] },
    ],
    events: [],
    sessionId: "sess-1234abcd",
    sessionName: "Amber Finch",
    contextTokens: 1234,
    contextLimit: 200_000,
    cachedTokens: 800,
    ...initial,
  };
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const notify = () => listeners.forEach((l) => l());
  return {
    calls,
    // A fresh object each call, like a real controller might do.
    getSnapshot: () => ({ ...state, messages: [...state.messages], events: [...state.events] }),
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    submit: async (text) => {
      calls.push(`submit:${text}`);
    },
    interrupt: () => {
      calls.push("interrupt");
    },
    setModel: (id) => {
      calls.push(`model:${id}`);
      state = { ...state, model: id };
      notify();
    },
    pin: (text) => {
      calls.push(`pin:${text}`);
    },
    setEffort: async (effort) => {
      calls.push(`effort:${effort}`);state={...state,effort:effort==="auto"?undefined:effort,error:undefined};notify();
    },
    newSession: async () => {
      calls.push("new");state={...state,sessionId:crypto.randomUUID(),sessionName:"Blue Lantern",messages:[],events:[],busy:false,error:undefined};notify();
    },
    listSessions: async () => [{id:state.sessionId,name:state.sessionName,nameSource:"fallback",createdAt:new Date(0).toISOString(),updatedAt:new Date().toISOString(),messageCount:state.messages.length}],
    resumeSession: async (id) => {calls.push(`resume:${id}`);state={...state,sessionId:id,sessionName:`Session ${id}`,messages:[],events:[],busy:false,error:undefined};notify();},
    setSessionName: async (name) => {calls.push(`name:${name}`);state={...state,sessionName:name};notify();},
    update: (patch) => {
      state = { ...state, ...patch };
      notify();
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function mount(controller: MockController, width = 90, height = 30, onQuit: () => void = () => {}, initialInput?: string) {
  const setup = await testRender(<App controller={controller} onQuit={onQuit} initialInput={initialInput} />, { width, height, exitOnCtrlC: false });
  // Timers in the app update state outside act(); silence the act() warnings.
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
  // React commits key-driven updates through its own macrotask scheduler, so
  // yield to it before asking the renderer to flush.
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await sleep(8);
      await setup.flush();
    }
  };
  const frame = async () => {
    await settle();
    return setup.captureCharFrame();
  };
  type Key = Parameters<TestRendererSetup["mockInput"]["pressKey"]>[0];
  type Mods = Parameters<TestRendererSetup["mockInput"]["pressKey"]>[1];
  const press = async (key: Key, modifiers?: Mods) => {
    setup.mockInput.pressKey(key, modifiers);
    await settle();
  };
  const arrow = async (direction: "up" | "down" | "left" | "right") => {
    setup.mockInput.pressArrow(direction);
    await settle();
  };
  const enter = async () => {
    setup.mockInput.pressEnter();
    await settle();
  };
  const escape = async () => {
    setup.mockInput.pressEscape();
    // Legacy terminals wait 20 ms to distinguish bare Esc from Alt+key.
    // Let that parser boundary finish before testing the resulting UI state.
    await sleep(22);
    await settle();
  };
  const tab = async () => {
    setup.mockInput.pressTab();
    await settle();
  };
  const type = async (text: string) => {
    await setup.mockInput.typeText(text);
    await settle();
  };
  return { setup, settle, frame, press, arrow, enter, escape, tab, type };
}

// ---------------------------------------------------------------------------
// Pure helpers

describe("reduceGraphs", () => {
  test("derives node status, edges and readiness from events", () => {
    const [g] = reduceGraphs(sampleEvents());
    expect(g).toBeDefined();
    expect(g!.label).toBe("investigate expiry");
    expect(g!.order).toEqual(["scan", "grep", "pick", "loop", "loop/0/read", "loop/1/read", "verify"]);
    expect(g!.nodes.scan!.status).toBe("done");
    expect(g!.nodes.grep!.status).toBe("failed");
    expect(g!.nodes.pick!.status).toBe("blocked");
    expect(g!.nodes.verify!.status).toBe("pending");
    expect(g!.nodes.scan!.artifact).toBe(".jev/artifacts/scan.json");
    expect(g!.nodes.scan!.output).toBe("src/a.ts\nsrc/b.ts\n");
    expect(g!.nodes.grep!.error).toBe("exit 2: no matches");
    expect(g!.nodes["loop/0/read"]!.parent).toBe("loop");
    expect(edgeReady(g!, "scan", "pick")).toBe(true);
    expect(edgeReady(g!, "grep", "pick")).toBe(false);
    expect(edgeReady(g!, "scan", "verify")).toBe(true);
    expect(g!.edges.filter((e) => e.to === "verify").map((e) => e.from).sort()).toEqual(["loop", "scan"]);
    const counts = countStatuses(g!);
    expect(counts).toEqual({ total: 7, done: 1, running: 0, warn: 1, blocked: 1, pending: 4, building: 0 });
  });

  test("keeps the exact jev request and response, and the graph outcome", () => {
    const [g] = reduceGraphs(jevEvents());
    const judge = g!.nodes.judge!;
    expect(judge.status).toBe("yielded");
    expect(judge.jevRequests).toHaveLength(1);
    expect(judge.jevRequests[0]!.data.state).toEqual({ observation: { test: "refreshes an expired session" } });
    expect(judge.jevResponses[0]!.data.answers).toEqual({ pick: { choice: "a", probability: 0.8 } });
    expect(g!.status).toBe("yielded");
    expect(g!.reason).toBe("acceptance criteria not met");
  });

  test("separates graphs and tolerates events for unknown nodes", () => {
    const events = [...sampleEvents(), ...jevEvents()];
    const ev = eventFactory("g1");
    events.push({ ...ev("node.started", "ghost", { type: "bash" }), sequence: 999 });
    const graphs = reduceGraphs(events);
    expect(graphs.map((g) => g.id)).toEqual(["g1", "g2"]);
    expect(graphs[0]!.nodes.ghost!.status).toBe("running");
  });

  test("maps statuses to the design's colour tones", () => {
    expect(statusTone("done")).toBe("done");
    expect(statusTone("failed")).toBe("warn");
    expect(statusTone("yielded")).toBe("warn");
    expect(statusTone("exhausted")).toBe("warn");
    expect(statusTone("blocked")).toBe("blocked");
    expect(statusTone("skipped")).toBe("blocked");
    expect(statusTone("cancelled")).toBe("blocked");
    expect(statusTone("running")).toBe("running");
    expect(statusTone("pending")).toBe("pending");
  });
});

describe("construction previews", () => {
  test("preview nodes are 'building' and runtime events overwrite them without duplicates", () => {
    const [g] = reduceGraphs(previewEvents());
    expect(g!.phase).toBe("building");
    expect(g!.label).toBe("draft plan");
    expect(g!.order).toEqual(["scan", "pick", "loop"]);
    expect(g!.nodes.scan!.status).toBe("building");
    expect(g!.nodes.scan!.revealedAt).toBe(1_000_020);
    expect(g!.nodes.pick!.revealedAt).toBe(1_000_030);
    expect(g!.nodes.loop!.type).toBe("foreach");
    expect(g!.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["scan>pick", "pick>loop"]);
    expect(countStatuses(g!).building).toBe(3);

    const [after] = reduceGraphs([...previewEvents(), ...previewRuntimeEvents()]);
    expect(after!.phase).toBe("running");
    expect(after!.order).toEqual(["scan", "pick", "loop"]);
    expect(after!.nodes.scan!.status).toBe("running");
    expect(after!.nodes.pick!.status).toBe("pending");
    expect(after!.nodes.loop!.status).toBe("pending");
    expect(after!.nodes.scan!.revealedAt).toBe(1_000_020); // reveal time is kept, status is not
    expect(after!.edges).toHaveLength(2);
  });

  test("building.finished records ready, interrupted and failed outcomes", () => {
    const fin = (status: string, error?: string): UIExecutionEvent => ({ sequence: 50, time: 1_000_500, graphId: "g3", type: "graph.building.finished", data: error ? { status, error } : { status } });
    expect(reduceGraphs([...previewEvents(), fin("ready")])[0]!.phase).toBe("ready");
    expect(reduceGraphs([...previewEvents(), fin("interrupted")])[0]!.phase).toBe("interrupted");
    const failed = reduceGraphs([...previewEvents(), fin("failed", "invalid reference /nodes/nope")])[0]!;
    expect(failed.phase).toBe("failed");
    expect(failed.buildError).toBe("invalid reference /nodes/nope");
    expect(statusTone("building")).toBe("building");
  });
});

describe("graph presentation", () => {
  const view = async (events: ExecutionEvent[], width = 90) => {
    const graph = reduceGraphs(events)[0]!;
    const setup = await testRender(
      <GraphView graph={graph} width={width} expanded={new Set()} folded={new Set()} selectedRow={-1} focused={false} />,
      { width, height: 12 },
    );
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      await setup.flush();
      return setup.captureCharFrame().split("\n").map((line) => line.trimEnd()).filter(Boolean);
    } finally {
      setup.renderer.destroy();
    }
  };
  const single = (finish: Record<string, unknown> = { status: "done" }) => {
    const ev = eventFactory("solo");
    return [
      ev("graph.started", undefined, { label: "Inspect the manifest" }),
      ev("node.created", "read", { label: "read", type: "bash", needs: [] }),
      ev("node.finished", "read", { result: { id: "read", label: "read", type: "bash", status: "done" } }),
      ev("graph.finished", undefined, finish),
    ];
  };

  test("a graph of one node is drawn as that node, carrying the graph's title", async () => {
    const lines = await view(single());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Inspect the manifest");
    expect(lines[0]).not.toContain("bash");
    expect(lines[0]).not.toContain("done");
    // The node's own key would be a second, emptier title for the same call.
    expect(lines[0]).not.toContain("read");
  });

  test("the progress counter covers this graph's own nodes, and only once there are more than five", async () => {
    const sized = (count: number) => {
      const ev = eventFactory(`sized-${count}`);
      const events = [ev("graph.started", undefined, { label: "walk the tree" })];
      for (let i = 0; i < count; i++) events.push(ev("node.created", `n${i}`, { label: `step ${i}`, type: "bash", needs: [] }));
      events.push(ev("node.finished", "n0", { result: { id: "n0", label: "step 0", type: "bash", status: "done" } }));
      return events;
    };
    // Six nodes, one of them finished: the counter reports this graph alone.
    expect((await view(sized(6))).join("\n")).toContain("1/6 done");
    // Five is still small enough to read off the rows themselves.
    const small = (await view(sized(5))).join("\n");
    expect(small).not.toContain("1/5 done");
    expect(small).toContain("walk the tree");
  });

  test("a failed call shows one inline error and a clickable copy control", async () => {
    const ev = eventFactory("failed-call");
    const events = [
      ev("graph.started", undefined, { label: "Run checks" }),
      ev("node.created", "check", { label: "check", type: "bash", needs: [] }),
      ev("node.finished", "check", { result: { id: "check", label: "check", type: "bash", status: "failed", error: "Command exited with 1", output: { stderr: "tests broke", exitCode: 1 } } }),
      ev("graph.finished", undefined, { status: "partial", reason: "Command exited with 1" }),
    ];
    const copied: string[] = [];
    const setup = await testRender(
      <GraphView graph={reduceGraphs(events)[0]!} width={70} expanded={new Set()} folded={new Set()} selectedRow={-1} focused={false} onCopyFailure={(text) => copied.push(text)} />,
      { width: 70, height: 8, useMouse: true },
    );
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      await setup.flush();
      const frame = setup.captureCharFrame();
      expect(frame.split("Command exited with 1")).toHaveLength(2);
      expect(frame).toContain("[⧉]");
      expect(frame).not.toMatch(/Run checks\s+bash|Run checks\s+failed|\d+\.\d+s/);
      const lines = frame.split("\n");
      const y = lines.findIndex((line) => line.includes("[⧉]"));
      const x = lines[y]!.indexOf("⧉");
      await setup.mockMouse.click(x, y);
      expect(copied).toEqual([`Command exited with 1\n\n${JSON.stringify({ stderr: "tests broke", exitCode: 1 }, null, 2)}`]);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("a graph still being assembled keeps its title, however few nodes it has so far", async () => {
    const ev = eventFactory("draft");
    const lines = await view([
      ev("graph.building" as ExecutionEvent["type"], undefined, { label: "Inspect the manifest" }),
      ev("graph.preview" as ExecutionEvent["type"], undefined, { graph: { label: "Inspect the manifest", nodes: { read: { type: "bash", label: "read" } } } }),
    ]);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toContain("◌ Inspect the manifest");
  });

  test("an unnamed graph under construction cycles a word instead of a placeholder", async () => {
    const ev = eventFactory("unnamed");
    const lines = await view([
      ev("graph.building" as ExecutionEvent["type"], undefined, { label: BUILDING_LABEL }),
      ev("graph.preview" as ExecutionEvent["type"], undefined, { graph: { nodes: { read: { type: "bash", label: "read" } } } }),
    ]);
    expect(lines[0]).not.toContain(BUILDING_LABEL);
    expect(lines[0]).toMatch(new RegExp(`◌ (${BUILD_WORDS.join("|")})`));
    // One build keeps the word it opened with: only the dots move while it runs.
    const word = (id: string, now: number) => buildingTitle(id, now).trimEnd().replace(/\.+$/, "");
    expect(word("unnamed", 0)).toBe(word("unnamed", 97_000));
    // The header carries the state on its own: no second line waiting on nodes.
    expect(lines.join("\n")).not.toContain("waiting for");
  });

  test("several nodes keep the title line above them", async () => {
    const [g] = reduceGraphs(sampleEvents());
    const lines = await view(sampleEvents());
    expect(lines[0]).toContain("investigate expiry");
    expect(lines.length).toBeGreaterThan(Object.keys(g!.nodes).length);
  });

  test("changed files are summarised in the title and named one per line", async () => {
    const changes = {
      total: 3, added: 42, removed: 7,
      files: [
        { path: "src/core/graph-stream.ts", kind: "modified", added: 31, removed: 5 },
        { path: "notes.md", kind: "added", added: 11, removed: 0 },
        { path: "old.txt", kind: "deleted" },
      ],
    };
    const ev = eventFactory("changed");
    const lines = await view([
      ev("graph.started", undefined, { label: "Rewrite the parser" }),
      ev("node.created", "one", { label: "first", type: "bash", needs: [] }),
      ev("node.created", "two", { label: "second", type: "bash", needs: ["one"] }),
      ev("graph.finished", undefined, { status: "done", changes }),
    ]);
    expect(lines[0]).toContain("✎ 3 files +42 −7");
    expect(lines[1]).toContain("✎ src/core/graph-stream.ts +31 −5");
    expect(lines[2]).toContain("notes.md +11");
    expect(lines[2]).not.toContain("✎");
    expect(lines[3]).toContain("old.txt deleted");

    // A single-node call carries the same badge on its one row.
    const solo = await view(single({ status: "done", changes }));
    expect(solo[0]).toContain("✎ 3 files +42 −7");
  });

  test("the named files stack one per line, capped, with a count for the rest", () => {
    const changes = {
      total: 9, added: 12, removed: 3,
      files: [
        { path: "a/very/long/path/to/a/file.ts", kind: "modified" as const, added: 8, removed: 1 },
        { path: "another/long/path/second.ts", kind: "modified" as const, added: 4, removed: 2 },
        { path: "third.ts", kind: "added" as const, added: 0, removed: 0 },
      ],
    };
    expect(changeBadge(changes)).toBe("✎ 9 files +12 −3");
    expect(changeBadge(undefined)).toBeNull();
    const wide = changeLines(changes, 120);
    // One file per line, in the order the summary gives them, and the rest as a count.
    expect(wide).toEqual(["a/very/long/path/to/a/file.ts +8 −1", "another/long/path/second.ts +4 −2", "third.ts", "+6 more"]);
    const narrow = changeLines(changes, 24);
    expect(narrow.every((line) => line.length <= 24)).toBe(true);
    // A path that cannot fit gives up its leading directories, never its counts.
    expect(narrow[0]).toBe("…path/to/a/file.ts +8 −1");
    expect(narrow.at(-1)).toBe("+6 more");
    // A long changeset stops at the cap and says how many it left out.
    const many = { total: 12, added: 0, removed: 0, files: Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.ts`, kind: "modified" as const, added: 1, removed: 0 })) };
    expect(changeLines(many, 40)).toHaveLength(7);
    expect(changeLines(many, 40).at(-1)).toBe("+6 more");
  });
});

describe("toneColor", () => {
  test("a completed Jev judgement is purple; everything else done is green", () => {
    expect(toneColor("done", "jev")).toBe(palette.purple);
    expect(toneColor("done", "bash")).toBe(palette.green);
    expect(toneColor("done")).toBe(palette.green);
    expect(toneColor("running", "jev")).toBe(palette.accent);
  });
});

describe("layoutGraph", () => {
  test("draws joins, branches and folded groups in creation order", () => {
    const [g] = reduceGraphs(sampleEvents());
    const layout = layoutGraph(g!, { expanded: new Set(), folded: new Set(["loop"]) });
    expect(layout.rows.map((r) => r.id)).toEqual(["scan", "grep", "pick", "loop", "verify"]);
    expect(layout.hidden).toBe(2);
    const text = layoutToText(layout);
    expect(text).toBe(["●   scan repo [done]", "│ ✖ grep tests [failed]", "├─○ pick file [blocked]", "│ ○ ▸ ≡ per file [pending]", "○─╯ verify [pending]"].join("\n"));
  });

  test("a loop draws its body once and moves back and forth over the same rows as passes run", () => {
    const ev = eventFactory("loop");
    const child = (id: string, iteration: number, key: string, needs: string[] = []) =>
      ev("node.created", `${id}[${iteration}]/${key}`, { label: key, type: "bash", needs: needs.map((n) => `${id}[${iteration}]/${n}`), parent: id, iteration });
    const events = [
      ev("graph.started", undefined, { label: "crawl" }),
      ev("node.created", "rounds", { label: "rounds", type: "repeat", needs: [], template: "round", maxIterations: 5 }),
      ev("node.started", "rounds", { type: "repeat" }),
      child("rounds", 0, "fetch"),
      child("rounds", 0, "merge", ["fetch"]),
      ev("node.started", "rounds[0]/fetch", {}),
      ev("node.finished", "rounds[0]/fetch", { result: { status: "done" } }),
      ev("edge.ready", undefined, { from: "rounds[0]/fetch", to: "rounds[0]/merge" }),
      ev("node.started", "rounds[0]/merge", {}),
      ev("node.finished", "rounds[0]/merge", { result: { status: "done" } }),
      ev("node.created", "report", { label: "report", type: "bash", needs: ["rounds"] }),
    ];
    const [afterFirst] = reduceGraphs(events);
    expect(afterFirst!.nodes.rounds!.loop).toEqual({ template: "round", max: 5 });
    expect(afterFirst!.nodes["rounds[0]/merge"]!.iteration).toBe(0);
    // Groups open by default; the body is one row per template entry with a loop-back lane.
    const first = layoutGraph(afterFirst!, { expanded: new Set() });
    expect(layoutToText(first)).toBe([
      "⠋     ▾ ↻ rounds [running]",
      "│ ╭─●   fetch [done]",
      "│ ╰─●   merge [done]",
      "○     report [pending]",
    ].join("\n"));
    expect(first.rows.map((r) => r.id)).toEqual(["rounds", "rounds[*]/fetch", "rounds[*]/merge", "report"]);
    expect(groupSummary(first.rows[0]!)).toBe("repeat · 1/5");
    const loopCells = first.rows[1]!.cells.filter((c) => c.kind === "loop");
    expect(loopCells.map((c) => c.ch)).toEqual(["╭"]);
    expect(loopCells[0]!.from).toBe("rounds");
    expect(first.rows[2]!.cells[1]).toMatchObject({ ch: "╰", kind: "loop", hright: true });
    // The lane between body rows tracks the instance behind the row, so it sweeps per pass.
    expect(first.rows[2]!.cells[2]).toMatchObject({ kind: "node" });
    expect(first.rows[2]!.above[2]).toMatchObject({ kind: "pass", from: "rounds[0]/fetch", targets: ["rounds[0]/merge"] });
    expect(first.rows[1]!.instance!.id).toBe("rounds[0]/fetch");

    // The next pass reuses the rows: the same ids, now showing iteration 1.
    const second = reduceGraphs([...events, child("rounds", 1, "fetch"), child("rounds", 1, "merge", ["fetch"]), ev("node.started", "rounds[1]/fetch", {})])[0]!;
    const layout = layoutGraph(second, { expanded: new Set() });
    expect(layoutToText(layout)).toBe([
      "⠋     ▾ ↻ rounds [running]",
      "│ ╭─⠋   fetch [running]",
      "│ ╰─○   merge [pending]",
      "○     report [pending]",
    ].join("\n"));
    expect(layout.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
    expect(layout.rows[1]!.instance!.id).toBe("rounds[1]/fetch");
    expect(layout.rows[2]!.above[2]).toMatchObject({ from: "rounds[1]/fetch", targets: ["rounds[1]/merge"] });
    expect(layout.rows[1]!.parentId).toBe("rounds");
    expect(groupSummary(layout.rows[0]!)).toBe("repeat · 2/5");
    expect(layout.hidden).toBe(0);

    const folded = layoutGraph(second, { expanded: new Set(), folded: new Set(["rounds"]) });
    expect(folded.rows.map((r) => r.id)).toEqual(["rounds", "report"]);
    expect(folded.hidden).toBe(4);
    expect(foldableIds(second)).toEqual(["rounds"]);
  });

  test("a loop that has not run yet shows its template body as ghost rows, nested loops included", () => {
    const ev = eventFactory("ghost");
    const preview = ev("graph.preview", undefined, { graph: {
      templates: {
        expand: { nodes: { links: { type: "bash", script: "curl" }, pick: { type: "jev", label: "pick next", state: { $ref: "/nodes/links/output/stdout" }, questions: {} } } },
        round: { groups: { expand: { kind: "foreach", items: { $ref: "/state/frontier" }, template: "expand", maxItems: 20 } }, nodes: { merge: { type: "bash", stdin: { $ref: "/groups/expand/output/items" }, script: "python3" } } },
      },
      groups: { crawl: { kind: "repeat", label: "crawl", template: "round", initial: {}, next: {}, until: { op: "exists", args: [1] }, maxIterations: 8 } },
    } });
    const [g] = reduceGraphs([ev("graph.building", undefined, {}), preview]);
    expect(Object.keys(g!.templates)).toEqual(["expand", "round"]);
    expect(g!.templates.round!.map((e) => `${e.key}:${e.type}:${e.needs.join(",")}`)).toEqual(["merge:bash:expand", "expand:foreach:"]);
    const layout = layoutGraph(g!, { expanded: new Set() });
    // merge is defined before the group it consumes; rows follow dependencies so lanes run downward.
    // Each loop gets its own loop-back lane, nested bodies included.
    expect(layoutToText(layout)).toBe([
      "◌       ▾ ↻ crawl [building]",
      "╭─◌       ▾ ≡ expand [body]",
      "│ │ ╭─◌     links [body]",
      "│ │ ╰─◌     pick next [body]",
      "╰─◌       merge [body]",
    ].join("\n"));
    expect(layout.rows.map((r) => r.id)).toEqual(["crawl", "crawl[*]/expand", "crawl[*]/expand[*]/links", "crawl[*]/expand[*]/pick", "crawl[*]/merge"]);
    expect(layout.rows.at(-1)!.cells[1]!.kind).toBe("node");
    expect(layout.rows[2]!.cells[1]).toMatchObject({ kind: "pass", targets: ["crawl[*]/merge"] });
    expect(layout.rows.slice(1).every((r) => r.kind === "body" && r.instance === undefined)).toBe(true);
    expect(layout.hidden).toBe(0);
    expect(groupSummary(layout.rows[0]!)).toBe("repeat · ≤8 iterations");
    expect(groupSummary(layout.rows[1]!)).toBe("foreach · ≤20 items");
    expect(foldableIds(g!)).toEqual(["crawl", "crawl[*]/expand"]);

    // Once a pass starts, the same rows pick up the instances that exist so far.
    const started = reduceGraphs([ev("graph.building", undefined, {}), preview, ev("graph.started", undefined, { label: "crawl" }),
      ev("node.created", "crawl", { label: "crawl", type: "repeat", needs: [], template: "round" }), ev("node.started", "crawl", {}),
      ev("node.created", "crawl[0]/merge", { label: "merge", type: "bash", needs: [], parent: "crawl", iteration: 0 }), ev("node.started", "crawl[0]/merge", {})])[0]!;
    const running = layoutGraph(started, { expanded: new Set() });
    expect(running.rows.map((r) => `${r.id}:${r.instance?.id ?? "-"}`)).toEqual(["crawl:crawl", "crawl[*]/expand:-", "crawl[*]/expand[*]/links:-", "crawl[*]/expand[*]/pick:-", "crawl[*]/merge:crawl[0]/merge"]);
    expect(running.rows.at(-1)!.node.status).toBe("running");
  });

  test("the connector line above a row carries every lane that is still alive there", () => {
    const [g] = reduceGraphs(sampleEvents());
    const layout = layoutGraph(g!, { expanded: new Set(), folded: new Set(["loop"]) });
    const above = layout.rows.map((row) => row.above.map((cell) => cell.ch).join(""));
    // Lanes that end on a row arrive from above just like the ones passing through it.
    expect(above).toEqual(["  ", "│ ", "││", "││", "││"]);

    const ev = eventFactory("g2");
    const fanIn = reduceGraphs([
      ev("graph.started", undefined, { label: "fan in" }),
      ev("node.created", "a", { label: "a", type: "bash", needs: [] }),
      ev("node.created", "b", { label: "b", type: "bash", needs: [] }),
      ev("node.created", "c", { label: "c", type: "bash", needs: [] }),
      ev("node.created", "sum", { label: "sum", type: "bash", needs: ["a", "b", "c"] }),
    ])[0]!;
    const joined = layoutGraph(fanIn, { expanded: new Set() });
    expect(joined.rows.at(-1)!.above.map((cell) => cell.ch).join("")).toBe("│││");
    expect(gutterText(joined.rows.at(-1)!)).toBe("●─┴─╯ ");
    for (const row of joined.rows) expect(row.above).toHaveLength(joined.laneCount);
  });

  test("expanding a group inserts its children without reordering existing rows", () => {
    const [g] = reduceGraphs(sampleEvents());
    const folded = layoutGraph(g!, { expanded: new Set(), folded: new Set(["loop"]) });
    const open = layoutGraph(g!, { expanded: new Set(["loop"]) });
    // Without a template, the body is reconstructed from the instances: one row per key,
    // showing the latest item (older records name children group/index/key).
    expect(open.rows.map((r) => r.id)).toEqual(["scan", "grep", "pick", "loop", "loop[*]/read", "verify"]);
    expect(open.rows.filter((r) => r.depth === 1).map((r) => r.id)).toEqual(["loop[*]/read"]);
    const body = open.rows.find((r) => r.id === "loop[*]/read")!;
    expect(body.kind).toBe("body");
    expect(body.instance!.id).toBe("loop/1/read");
    expect(body.node.label).toBe("read b.ts");
    expect(body.cells.find((c) => c.kind === "loop")!.ch).toBe("↻");
    // Rows above the group keep their columns.
    for (const id of ["scan", "grep", "pick"]) {
      expect(open.rows.find((r) => r.id === id)!.col).toBe(folded.rows.find((r) => r.id === id)!.col);
    }
    expect(visibleRows(g!, new Set(["loop"])).length).toBe(6);
    expect(visibleRows(g!, new Set(), new Set(["loop"])).length).toBe(5);
  });

  test("dynamically created nodes append rows and leave earlier rows in place", () => {
    const events = sampleEvents();
    const before = layoutGraph(reduceGraphs(events)[0]!, { expanded: new Set() });
    const ev = eventFactory();
    const extra = { ...ev("node.created", "report", { label: "report", type: "bash", needs: ["verify"] }), sequence: 500 };
    const after = layoutGraph(reduceGraphs([...events, extra])[0]!, { expanded: new Set() });
    expect(after.rows.map((r) => r.id)).toEqual([...before.rows.map((r) => r.id), "report"]);
    before.rows.forEach((row, i) => expect(after.rows[i]!.col).toBe(row.col));
  });

  test("edge cells sweep green outward from the completed node over time", () => {
    const [g] = reduceGraphs(sampleEvents());
    const layout = layoutGraph(g!, { expanded: new Set() });
    const readyAt = g!.edges.find((e) => e.from === "scan" && e.to === "pick")!.readyAt!;
    const pickRow = layout.rows.find((r) => r.id === "pick")!;
    const corner = pickRow.cells[0]!; // "├" where scan's lane meets pick
    expect(corner.from).toBe("scan");
    expect(corner.dist).toBe(2);
    expect(edgeCellState(g!, corner, readyAt - 1)).toBe("sweeping");
    expect(edgeCellState(g!, corner, readyAt)).toBe("sweeping");
    expect(edgeCellState(g!, corner, readyAt + corner.dist * EDGE_SWEEP_MS_PER_CELL)).toBe("ready");
    // grep failed, so its edge into pick never became ready.
    const grepCell = pickRow.cells[1]!;
    expect(grepCell.kind).toBe("node");
    const grepRow = layout.rows.find((r) => r.id === "grep")!;
    const passThrough = grepRow.cells[0]!;
    expect(passThrough.kind).toBe("pass");
    expect(edgeCellState(g!, passThrough, readyAt + 10_000)).toBe("ready");
    expect(sweepActive(g!, layout, readyAt)).toBe(true);
    expect(sweepActive(g!, layout, readyAt + 60_000)).toBe(false);
    const idle = layoutGraph(reduceGraphs(sampleEvents().filter((e) => e.type !== "edge.ready"))[0]!, { expanded: new Set() });
    expect(edgeCellState(idle.rows[2]!.node && reduceGraphs(sampleEvents().filter((e) => e.type !== "edge.ready"))[0]!, idle.rows[2]!.cells[0]!, readyAt + 60_000)).toBe("idle");
  });
});

describe("parseComposerInput", () => {
  test("recognises commands and plain prompts", () => {
    expect(parseComposerInput("hello world")).toEqual({ kind: "submit", text: "hello world" });
    expect(parseComposerInput("   ")).toEqual({ kind: "empty" });
    expect(parseComposerInput("/model")).toEqual({ kind: "model" });
    expect(parseComposerInput("/model openai/gpt-6-astra")).toEqual({ kind: "model", id: "openai/gpt-6-astra" });
    expect(parseComposerInput("/pin keep tests green")).toEqual({ kind: "pin", text: "keep tests green" });
    expect(parseComposerInput("/resume")).toEqual({ kind: "resume" });
    expect(parseComposerInput("/resume 018f-abcd")).toEqual({ kind: "resume", id: "018f-abcd" });
    expect(parseComposerInput("/sessions")).toEqual({ kind: "sessions" });
    expect(parseComposerInput("/name Fix session restore")).toEqual({ kind: "name", text: "Fix session restore" });
    expect(parseComposerInput("/rename Better title")).toEqual({ kind: "name", text: "Better title" });
    expect(parseComposerInput("/quit")).toEqual({ kind: "quit" });
    expect(parseComposerInput("/nope")).toEqual({ kind: "unknown", name: "nope" });
    expect(parseComposerInput("/g")).toEqual({ kind: "graph" });
  });

  test("slash popup query and filtering", () => {
    expect(slashQuery("hello")).toBeNull();
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/mo")).toBe("mo");
    expect(slashQuery("/model x")).toBeNull();
    expect(slashQuery("/pin\nmore")).toBeNull();
    expect(filterCommands("").map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
    expect(filterCommands("gr").map((c) => c.name)).toEqual(["graph"]);
    expect(filterCommands("q").map((c) => c.name)).toEqual(["quit"]);
    expect(filterCommands("zzz")).toEqual([]);
  });
});

describe("orb", () => {
  test("renders a flower that fits the available space and animates", () => {
    const size = orbSize(80, 20);
    expect(size.width).toBe(size.height * 2 + 1);
    const frame = renderOrb(12, size.width, size.height);
    const lines = orbToString(frame).split("\n");
    expect(lines).toHaveLength(size.height);
    const filled = (line: string) => line.replace(/ /g, "").length;
    expect(filled(lines[Math.floor(size.height / 3)]!)).toBeGreaterThan(filled(lines[0]!));
    expect(orbToString(renderOrb(13.5, size.width, size.height))).not.toBe(orbToString(frame));
    const colours = new Set(frame.rows.flat().map((r) => r.color));
    expect(colours.size).toBeGreaterThan(4); // background plus shaded brightness levels
  });
});

// ---------------------------------------------------------------------------
// Rendered UI

describe("App", () => {
  test("does not repeat controller errors above the composer", async () => {
    const c=makeController({error:"Planner request failed",messages:[{id:"n1",role:"notice",text:"Planner request failed"}]});
    const {setup,frame}=await mount(c,80,18);
    try{
      const f=await frame();
      expect(f.split("Planner request failed")).toHaveLength(2);
      expect(f).not.toContain("⚠");
    }finally{setup.renderer.destroy();}
  });

  test("effort slider and shorthand commands apply exact levels", async () => {
    const c=makeController({models:[{id:"anthropic/claude-sonnet-5",name:"Test model",reasoningEfforts:["low","medium","high","xhigh"]}]});
    const {setup,type,enter,frame,press,escape}=await mount(c);
    try{
      await type("/effort");await enter();
      expect(await frame()).toContain("←/→ adjust");
      await press("END");
      expect(await frame()).toContain("xhigh reasoning effort");
      await enter();expect(c.calls).toContain("effort:xhigh");
      await type("/effort high");await enter();expect(c.calls).toContain("effort:high");
      await type("/effort");await enter();await press("HOME");await escape();
      expect(c.getSnapshot().effort).toBe("high");
      await type("/effort auto");await enter();expect(c.getSnapshot().effort).toBeUndefined();
    }finally{setup.renderer.destroy();}
  });

  test("new and clear both replace the session and clear the displayed conversation", async () => {
    const c=makeController({messages:[{id:"old",role:"user",text:"old task"}],events:sampleEvents()});
    const {setup,type,enter,frame}=await mount(c);
    try{
      let session=c.getSnapshot().sessionId;
      await type("/new");await enter();
      expect(c.getSnapshot().sessionId).not.toBe(session);
      expect(await frame()).not.toContain("old task");
      expect(await frame()).not.toContain("scan repo");
      session=c.getSnapshot().sessionId;c.update({messages:[{id:"second",role:"user",text:"second task"}]});
      await type("/clear");await enter();
      expect(c.getSnapshot().sessionId).not.toBe(session);
      expect(await frame()).not.toContain("second task");
      expect(c.calls.filter(call=>call==="new")).toHaveLength(2);
    }finally{setup.renderer.destroy();}
  });

  test("sessions and resume use the picker or a direct id, and name aliases persist titles", async () => {
    const c=makeController();
    c.listSessions=async()=>[
      {id:"target-12345678",name:"Repair Resume Flow",nameSource:"generated",createdAt:new Date(1).toISOString(),updatedAt:new Date().toISOString(),model:"test/model",messageCount:4},
      {id:c.getSnapshot().sessionId,name:c.getSnapshot().sessionName,nameSource:"fallback",createdAt:new Date(0).toISOString(),updatedAt:new Date(2).toISOString(),messageCount:0},
    ];
    const {setup,type,enter,frame,escape}=await mount(c);
    try{
      await type("/sessions");await enter();
      let f=await frame();
      expect(f).toContain("sessions");
      expect(f).toContain("Repair Resume Flow");
      expect(f).toContain("type to search");
      await enter();
      expect(c.calls).toContain("resume:target-12345678");
      expect(c.getSnapshot().sessionId).toBe("target-12345678");

      await type("/resume direct-87654321");await enter();
      expect(c.calls).toContain("resume:direct-87654321");

      await type("/name First explicit title");await enter();
      await type("/rename Final explicit title");await enter();
      expect(c.calls).toContain("name:First explicit title");
      expect(c.calls).toContain("name:Final explicit title");
      expect(c.getSnapshot().sessionName).toBe("Final explicit title");

      await type("/resume");await enter();
      expect(await frame()).toContain("sessions");
      await escape();
      expect(await frame()).not.toContain("type to search by name");
    }finally{setup.renderer.destroy();}
  });

  test("thinking indicators track activity and disappear when the turn ends", async () => {
    const c=makeController({busy:true,phase:"thinking",activityStartedAt:Date.now()-1000});
    const {setup,frame}=await mount(c);
    try{
      expect(await frame()).toContain("Thinking ·");
      c.update({phase:"responding"});expect(await frame()).toContain("Writing ·");
      c.update({busy:false,phase:"idle"});expect(await frame()).not.toContain("Writing ·");
    }finally{setup.renderer.destroy();}
  });

  test("sending a message snaps back to the latest content after scrolling up", async () => {
    const history=Array.from({length:30},(_,index)=>({id:`m${index}`,role:"user" as const,text:`Earlier question ${index}`}));
    const c=makeController({messages:history});
    c.submit=async(text)=>{c.calls.push(`submit:${text}`);c.update({messages:[...history,{id:"newest",role:"user",text}]});};
    const {setup,frame,press,type,enter}=await mount(c,80,24);
    try{
      expect(await frame()).toContain("Earlier question 29");
      for(let i=0;i<8;i++)await press("\u001b[5~");
      expect(await frame()).not.toContain("Earlier question 29");
      await type("My newest question");await enter();
      expect(await frame()).toContain("My newest question");
      expect(await frame()).toContain("Earlier question 29");
    }finally{setup.renderer.destroy();}
  });

  test("planner reasoning stays collapsed to a title that follows the newest paragraph", async () => {
    const c = makeController({
      messages: [
        { id: "u1", role: "user", text: "find the expiry bug" },
        { id: "t1", role: "thinking", text: "**Checking the store**\n\nThe session store is read before any test runs, so the expiry path matters." },
        { id: "a1", role: "assistant", text: "The expiry check runs before the refresh." },
      ],
    });
    const { setup, frame } = await mount(c, 80, 24);
    try {
      let f = await frame();
      expect(f).toContain("▸ The session store is read before any test…");
      expect(f).not.toContain("Checking the store");
      expect(f).not.toContain("expiry path matters");
      expect(f).toContain("The expiry check runs before the refresh.");
      expect(f).toContain("find the expiry bug");
      c.update({ messages: [...c.getSnapshot().messages.map((m) => (m.id === "t1" ? { ...m, text: `${m.text}\n\nNow reading the refresh tests.` } : m))] });
      f = await frame();
      expect(f).toContain("▸ Now reading the refresh tests.");
      expect(f).not.toContain("The session store is read");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("Ctrl+O opens every round's reasoning in full and closes it again", async () => {
    const c = makeController({
      messages: [
        { id: "u1", role: "user", text: "find the expiry bug" },
        { id: "t1", role: "thinking", text: "Checking the store first.\n\nThe session store is read before any test runs." },
        { id: "a1", role: "assistant", text: "The expiry check runs before the refresh." },
      ],
    });
    const { setup, frame, press } = await mount(c, 80, 24);
    try {
      expect(await frame()).not.toContain("Checking the store first.");
      await press("o", { ctrl: true });
      let f = await frame();
      expect(f).toContain("▾");
      expect(f).toContain("Checking the store first.");
      expect(f).toContain("The session store is read before any test runs.");
      expect(f).toContain("reasoning shown");
      // Replies and prompts are untouched by the toggle.
      expect(f).toContain("The expiry check runs before the refresh.");
      await press("o", { ctrl: true });
      f = await frame();
      expect(f).not.toContain("Checking the store first.");
      expect(f).toContain("▸ The session store is read before any test…");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("Ctrl+O says so when the session has no reasoning to show", async () => {
    const c = makeController({ messages: [{ id: "u1", role: "user", text: "go" }] });
    const { setup, frame, press } = await mount(c, 110, 24);
    try {
      await press("o", { ctrl: true });
      expect(await frame()).toContain("no reasoning recorded yet");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("a reply with no text yet leaves no bare marker in the transcript", async () => {
    const c = makeController({
      messages: [
        { id: "u1", role: "user", text: "go" },
        { id: "a1", role: "assistant", text: "" },
      ],
      busy: true,
    });
    const { setup, frame } = await mount(c, 80, 24);
    try {
      expect(await frame()).not.toContain("◆");
      c.update({ messages: [{ id: "u1", role: "user", text: "go" }, { id: "a1", role: "assistant", text: "Done." }] });
      expect(await frame()).toContain("◆ Done.");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("a long message wraps inside the composer card instead of scrolling one row", async () => {
    const c = makeController();
    const { setup, frame, type } = await mount(c, 60, 20);
    try {
      await type("this is a really long message that should wrap onto more than one line in the composer box");
      const lines = (await frame()).split("\n");
      const first = lines.findIndex((l) => l.includes("❯ this is a really long"));
      expect(first).toBeGreaterThan(-1);
      // The continuation sits on the next row, indented under the text, and the
      // card's right border survives: nothing painted over it.
      expect(lines[first + 1]).toContain("composer box");
      expect(lines[first]!.trimEnd()).toMatch(/│$/);
      expect(lines[first + 1]!.trimEnd()).toMatch(/│$/);
      expect(lines[first + 1]).toMatch(/│ {3}\S/);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("empty session shows the orb with the composer pinned at the bottom", async () => {
    const c = makeController();
    const { setup, frame } = await mount(c);
    try {
      const f = await frame();
      const lines = f.split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBe(30);
      // Composer card: side margins of 2, rounded border flush with the
      // bottom of the viewport, and a blank padding row under the top border.
      expect(lines[29]).toMatch(/^ {2}╰─+╯ {2}$/);
      expect(lines[28]).toContain("│ ❯ Ask, or type / for commands");
      expect(lines[27]).toMatch(/^ {2}│ +│ {2}$/);
      expect(lines[26]).toMatch(/^ {2}╭─+╮ {2}$/);
      expect(lines[25]).toContain("Claude Sonnet 5");
      expect(f).not.toContain("graph · bash · jev");
      expect(f).not.toContain("Describe a task");
      expect(f).toMatch(/[░▒▓█]{8,}/); // Block-shaded flower
    } finally {
      setup.renderer.destroy();
    }
  });

  test("shows messages and graph rows with their states", async () => {
    const c = makeController({
      messages: [
        { id: "m1", role: "user", text: "Find where sessions expire" },
        { id: "m2", role: "assistant", text: "Scanning the repository first." },
      ],
      busy: true,
      events: sampleEvents(),
    });
    const { setup, frame } = await mount(c);
    try {
      const f = await frame();
      const lines = f.split("\n");
      const youLine = lines.find((l) => /│\s+you\s*$/.test(l))!;
      expect(youLine).toBeDefined();
      expect(youLine.indexOf("│")).toBe(3); // left aligned with the conversation padding
      expect(lines.find((l) => l.includes("Find where sessions expire"))).toMatch(/^ {3}│ {2}Find where sessions expire/);
      expect(f).toContain("◆ Scanning the repository first.");
      expect(f).toContain("investigate expiry");
      const scanLine = lines.find((line) => line.includes("scan repo"))!;
      const failedLine = lines.find((line) => line.includes("grep tests"))!;
      const pickLine = lines.find((line) => line.includes("pick file"))!;
      expect(scanLine).not.toMatch(/bash|done|\d+\.\d+s/);
      expect(failedLine).toMatch(/✖\s+grep tests.*exit 2: no matches.*\[⧉\]/);
      expect(failedLine).not.toMatch(/bash|failed|\d+\.\d+s/);
      expect(pickLine).toMatch(/├─○\s+pick file/);
      expect(pickLine).not.toMatch(/jev|blocked|\d+\.\d+s/);
      // Loops open by default: the group row names the loop and its body shows the latest item.
      expect(f).toMatch(/▾ ≡ per file\s+foreach · 2 items/);
      expect(f).toMatch(/↻─○\s+read b\.ts/);
      expect(f).not.toContain("read a.ts");
      expect(f).toMatch(/╯\s+verify/);
      expect(f).not.toContain("folded");
      expect(f).toMatch(/Thinking · \d+\.\d+s/);
      expect(f).toContain("⎘"); // artifact marker
    } finally {
      setup.renderer.destroy();
    }
  });

  test("graph focus expands groups and the inspector shows the exact jev request", async () => {
    const c = makeController({ messages: [{ id: "m1", role: "user", text: "go" }], events: [...sampleEvents(), ...jevEvents()] });
    const { setup, frame, press, arrow, enter, escape } = await mount(c);
    try {
      await press("g", { ctrl: true }); // focus the latest graph (g2)
      let f = await frame();
      expect(f).toContain("◆ decide");
      await press("[");
      f = await frame();
      expect(f).toContain("◆ investigate expiry");
      await arrow("down");
      await arrow("down");
      await arrow("down");
      await arrow("left"); // fold the (open by default) group
      f = await frame();
      expect(f).toContain("▸ ≡ per file");
      expect(f).not.toContain("read a.ts");
      expect(f).toContain("2 folded");
      await arrow("right");
      f = await frame();
      expect(f).toContain("▾ ≡ per file");
      expect(f).toContain("read b.ts");
      expect(f).not.toContain("folded");
      await arrow("down"); // the body row inspects the instance behind it
      await enter();
      f = await frame();
      expect(f).toContain(" read b.ts ");
      expect(f).toContain("loop/1/read · bash · pending");
      await escape();
      await press("c");
      f = await frame();
      expect(f).toContain("▸ ≡ per file");
      expect(f).toContain("2 folded");
      await press("e");
      f = await frame();
      expect(f).toContain("read b.ts");
      expect(f).not.toContain("folded");
      await press("]");
      await enter();
      f = await frame();
      expect(f).toContain("judge candidate");
      expect(f).toContain("jev request · state");
      expect(f).toContain('"test": "refreshes an expired session"');
      expect(f).toContain("jev request · questions");
      expect(f).toContain('"instructions": "Select the file"');
      expect(f).toContain("yielded");
      for (let i = 0; i < 12; i++) await arrow("down"); // scroll the inspector
      f = await frame();
      expect(f).toContain("jev response · answers");
      expect(f).toContain('"choice": "a"');
      await escape();
      await escape();
      f = await frame();
      expect(f).not.toContain("jev request · state");
      expect(f).toContain("· compose");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("composer submits prompts, commands and handles Ctrl+C", async () => {
    let quit = 0;
    const c = makeController();
    const { setup, settle, frame, press, arrow, enter, type } = await mount(c, 90, 30, () => quit++);
    try {
      await type("hello there");
      await enter();
      expect(c.calls).toEqual(["submit:hello there"]);
      let f = await frame();
      expect(f).toContain("❯ Ask, or type / for commands"); // cleared after submit

      await type("/pin keep tests green");
      await enter();
      expect(c.calls).toContain("pin:keep tests green");

      await type("/model");
      await enter();
      f = await frame();
      expect(f).toContain(" model ");
      expect(f).toContain("Claude Sonnet 5");
      expect(f).toContain("GPT-6 Astra");
      expect(f).toContain("/model provider:id for others");
      // Name only: no ids, context sizes or effort levels in the list.
      expect(f).not.toContain("anthropic/claude-sonnet-5");
      expect(f).not.toContain("k ctx");
      await arrow("down");
      await enter();
      expect(c.calls).toContain("model:openai/gpt-6-astra");
      f = await frame();
      expect(f).not.toContain("/model <id> for a custom id");
      expect(f).toContain("GPT-6 Astra");

      // Ctrl+C while busy interrupts; twice while idle quits.
      c.update({ busy: true });
      await press("c", { ctrl: true });
      expect(c.calls).toContain("interrupt");
      expect(quit).toBe(0);
      c.update({ busy: false });
      await settle();
      await press("c", { ctrl: true });
      expect(quit).toBe(0);
      await press("c", { ctrl: true });
      expect(quit).toBe(1);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("initial task prompt is an editable draft and is submitted only on Enter", async () => {
    const c = makeController();
    const draft = "Inspect this repository.\nPreserve existing changes.";
    const { setup, frame, type, enter } = await mount(c, 90, 30, () => {}, draft);
    try {
      const initialFrame = await frame();
      expect(initialFrame).toContain("❯ Inspect this repository.");
      expect(initialFrame).toContain("Preserve existing changes.");
      expect(c.calls).toEqual([]);
      expect(c.getSnapshot().messages).toEqual([]);
      await type(" Also explain the result.");
      c.update({ contextTokens: 2345 });
      await frame();
      expect(c.calls).toEqual([]);
      await enter();
      expect(c.calls).toEqual([`submit:${draft} Also explain the result.`]);
      expect(await frame()).toContain("❯ Ask, or type / for commands");
      c.update({ busy: false });
      expect(await frame()).not.toContain("Preserve existing changes.");
      await enter();
      expect(c.calls).toHaveLength(1);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("narrow terminals keep the graph readable", async () => {
    const c = makeController({ messages: [{ id: "m1", role: "user", text: "go" }], events: sampleEvents() });
    const { setup, frame } = await mount(c, 44, 24);
    try {
      const f = await frame();
      const lines = f.split("\n");
      expect(lines.every((l) => l.length <= 44)).toBe(true);
      expect(f).toContain("scan repo");
      expect(f).toContain("done");
      expect(f).toContain("exit 2: no m…");
      expect(f).toContain("[⧉]");
      expect(f).not.toMatch(/scan repo\s+(bash|done)|grep tests.*\b(failed|bash)\b/);
      expect(lines.slice(-6).some((l) => l.includes("❯"))).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("runWithRenderer interrupts active work and destroys the renderer on /quit", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16, exitOnCtrlC: false });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
    const c = makeController({ busy: true });
    let resolved = false;
    const done = runWithRenderer(c, setup.renderer).then(() => {
      resolved = true;
    });
    await sleep(10);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("❯ Ask, or type / for commands");
    await setup.mockInput.typeText("/quit");
    setup.mockInput.pressEnter();
    await done;
    expect(resolved).toBe(true);
    expect(c.calls).toEqual(["interrupt"]);
    expect(setup.renderer.isDestroyed).toBe(true);
  });

  test("a short history sits at the bottom and grows upward in order", async () => {
    const c = makeController({ messages: [{ id: "m1", role: "user", text: "first question" }] });
    const { setup, frame } = await mount(c, 80, 24);
    try {
      let f = await frame();
      let lines = f.split("\n");
      const q1 = lines.findIndex((l) => l.includes("first question"));
      expect(q1).toBeGreaterThanOrEqual(15); // bottom-aligned above the status bar and composer
      expect(lines.slice(0, 10).every((l) => l.trim() === "")).toBe(true);
      c.update({ messages: [{ id: "m1", role: "user", text: "first question" }, { id: "m2", role: "assistant", text: "first answer" }, { id: "m3", role: "user", text: "second question" }] });
      f = await frame();
      lines = f.split("\n");
      const i1 = lines.findIndex((l) => l.includes("first question"));
      const i2 = lines.findIndex((l) => l.includes("first answer"));
      const i3 = lines.findIndex((l) => l.includes("second question"));
      expect(i1).toBeLessThan(q1); // older content moved up
      expect(i1).toBeLessThan(i2);
      expect(i2).toBeLessThan(i3);
      expect(i3).toBeGreaterThanOrEqual(15);
      expect(lines[i3]!.indexOf("│")).toBe(3);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("slash popup filters, navigates and dispatches commands", async () => {
    let quit = 0;
    const c = makeController();
    const { setup, frame, arrow, enter, escape, tab, type, press } = await mount(c, 90, 30, () => quit++);
    try {
      await type("/");
      let f = await frame();
      for (const spec of COMMANDS) expect(f).toContain(spec.usage);
      expect(f).toMatch(/▸ \/model/);
      await arrow("down");
      f = await frame();
      expect(f).toMatch(/▸ \/graph/);
      await arrow("up");
      await arrow("up");
      f = await frame();
      expect(f).toMatch(/▸ \/model/);
      await escape();
      f = await frame();
      expect(f).not.toContain("/quit ");
      expect(f).toContain("❯ /");
      await type("gr");
      f = await frame();
      expect(f).toContain("/graph");
      expect(f).not.toContain("/model [id]");
      await tab();
      f = await frame();
      expect(f).toContain("❯ /graph ");
      expect(f).not.toContain("browse and inspect");

      // /pin stays editable; nothing is dispatched.
      await press("u", { ctrl: true }); // delete to line start
      await type("/p");
      await enter();
      f = await frame();
      expect(f).toContain("❯ /pin ");
      expect(c.calls).toEqual([]);
      await type("keep tests green");
      await enter();
      expect(c.calls).toEqual(["pin:keep tests green"]);

      // /model opens the picker; /help opens the command list; /quit quits.
      await type("/mo");
      await enter();
      f = await frame();
      expect(f).toContain(" model ");
      expect(f).toContain("GPT-6 Astra");
      await escape();
      await type("/help");
      await enter();
      f = await frame();
      expect(f).toContain(" commands ");
      expect(f).toContain("↑/↓ choose · Enter run");
      for (let i = 0; i < COMMANDS.findIndex(command=>command.name==="quit"); i++) await arrow("down");
      f = await frame();
      expect(f).toMatch(/▸ \/quit/);
      await enter();
      expect(quit).toBe(1);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("streaming previews render as drafted rows and hand over to runtime without duplicates", async () => {
    const c = makeController({ messages: [{ id: "m1", role: "user", text: "plan it" }] });
    const { setup, frame } = await mount(c, 90, 30);
    try {
      const base = Date.now();
      c.update({ events: asCore(previewEvents(base)) });
      let f = await frame();
      expect(f).toContain("draft plan");
      expect(f).toMatch(/[◆◌] draft plan/);
      expect(f).not.toContain("assembling");
      // Three rows count themselves; the progress counter stays off below the threshold.
      expect(f).not.toContain("3 nodes");
      expect(f).toMatch(/· scan repo/);
      expect(f).toMatch(/· pick file/);
      expect(f).toMatch(/· ▾ ≡ per file\s+foreach · ≤3 items/);
      expect(f).not.toContain("running");
      await sleep(350);
      f = await frame();
      expect(f).toMatch(/◌ scan repo/); // reveal finished: settled glyph
      c.update({ events: asCore([...previewEvents(base), ...previewRuntimeEvents(base)]) });
      f = await frame();
      expect(f).not.toContain("drafted");
      expect(f).not.toContain("assembling");
      expect(f.split("scan repo").length - 1).toBe(1);
      expect(f.split("pick file").length - 1).toBe(1);
      expect(f.split("per file").length - 1).toBe(1);
      const runtimeLines = f.split("\n");
      expect(runtimeLines.find((line) => line.includes("scan repo"))).not.toMatch(/bash|running/);
      expect(runtimeLines.find((line) => line.includes("pick file"))).not.toMatch(/jev|pending/);
      expect(f).toContain("1 running");
      // A failed assembly reports its error instead of pretending to execute.
      const failed: UIExecutionEvent = { sequence: 60, time: base + 900, graphId: "g3", type: "graph.building.finished", data: { status: "failed", error: "cycle detected" } };
      c.update({ events: asCore([...previewEvents(base), failed]) });
      f = await frame();
      expect(f).toContain("assembly failed · cycle detected");
      expect(f).not.toContain("running");
    } finally {
      setup.renderer.destroy();
    }
  });
});
