import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecutionEvent, GraphReport } from "../src/core/types.ts";
import { GraphAgentController } from "../src/planner/agent.ts";
import { mergeModelOptions, saveModelCatalog } from "../src/providers/index.ts";
import { SessionStore } from "../src/session/store.ts";

const originalFetch = globalThis.fetch;
const directories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function cwd(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "jev-session-controls-"));
  directories.push(path);
  return path;
}

function sse(events: unknown[]): Response {
  const bytes = new TextEncoder().encode(events.map((event) =>
    `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`).join(""));
  return new Response(bytes, { headers: { "Content-Type": "text/event-stream" } });
}

function answer(text = "done"): Response {
  return sse([
    { choices: [{ delta: { content: text }, finish_reason: "stop" }] },
    "[DONE]",
  ]);
}

function graphCall(): Response {
  return sse([
    { choices: [{ delta: { tool_calls: [{
      index: 0,
      id: "call-control",
      function: {
        name: "execute_graph",
        arguments: JSON.stringify({ version: 1, label: "control", nodes: {} }),
      },
    }] }, finish_reason: "tool_calls" }] },
    "[DONE]",
  ]);
}

const toolSchema = {
  name: "execute_graph",
  description: "execute",
  parameters: { type: "object" },
};

function report(path: string, status: GraphReport["status"] = "done"): GraphReport {
  return {
    graphId: "control-graph",
    label: "control",
    status,
    previews: [],
    requested: {},
    recordPath: path,
  };
}

describe("session controls", () => {
  test("resume swaps to an existing session and restores its complete visible state", async () => {
    const root = await cwd();
    const target = new SessionStore({ cwd: root, sessionId: "resume-target-123" });
    await target.initialize();
    await target.append("model.selected", { model: "saved/model" });
    await target.append("effort.selected", { effort: "high" });
    await target.setName("Restore saved investigation", "generated", "google/gemma-3-27b-it");
    await target.appendMessage({ role: "user", content: "saved question" }, "saved-user");
    await target.appendMessage({ role: "assistant", content: "saved answer", reasoning: "saved reasoning" }, "saved-answer", { reasoningChatId: "saved-thinking" });
    const event: ExecutionEvent = { sequence: 1, time: Date.now(), graphId: "saved-graph", type: "graph.started", data: { label: "saved graph" } };
    await target.append("execution.event", { event });
    const finished: ExecutionEvent = { sequence: 2, time: Date.now(), graphId: "saved-graph", type: "graph.finished", data: { status: "done" } };
    await target.append("execution.event", { event: finished });

    const controller = new GraphAgentController({
      cwd: root,
      sessionId: "current-session",
      model: "current/model",
      apiKey: "key",
      toolSchema,
      getPluginCatalog: async () => "",
      execute: async () => report("unused"),
    });
    await controller.ready();
    await controller.resumeSession("resume-target");

    const snapshot = controller.getSnapshot();
    expect(snapshot.sessionId).toBe("resume-target-123");
    expect(snapshot.sessionName).toBe("Restore saved investigation");
    expect(snapshot.model).toBe("saved/model");
    expect(snapshot.effort).toBe("high");
    expect(snapshot.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "saved question"],
      ["thinking", "saved reasoning"],
      ["assistant", "saved answer"],
    ]);
    expect(snapshot.events).toEqual([event, finished]);
  });

  test("a failed resume leaves the current session active, and manual names persist", async () => {
    const root = await cwd();
    const controller = new GraphAgentController({
      cwd: root,
      sessionId: "kept-session",
      model: "test/model",
      apiKey: "key",
      toolSchema,
      getPluginCatalog: async () => "",
      execute: async () => report("unused"),
    });
    await controller.ready();
    await controller.setSessionName("My explicit name");
    expect(controller.getSnapshot().sessionName).toBe("My explicit name");
    await expect(controller.resumeSession("missing-session")).rejects.toThrow("not found");
    expect(controller.getSnapshot().sessionId).toBe("kept-session");
    expect(controller.getSnapshot().sessionName).toBe("My explicit name");

    const reopened = new SessionStore({ cwd: root, sessionId: "kept-session", existingOnly: true });
    await reopened.initialize();
    expect(reopened.latestName()).toMatchObject({ name: "My explicit name", source: "manual" });
  });

  test("automatic naming is best-effort and preserves the fallback after failure", async () => {
    const root = await cwd();
    globalThis.fetch = (async () => answer("planner answer")) as unknown as typeof fetch;
    const controller = new GraphAgentController({
      cwd: root,
      sessionId: "auto-name-failure",
      model: "test/model",
      apiKey: "key",
      toolSchema,
      generateSessionName: async () => { throw new Error("namer unavailable"); },
      getPluginCatalog: async () => "",
      execute: async () => report("unused"),
    });
    await controller.ready();
    const fallback = controller.getSnapshot().sessionName;
    await controller.submit("Investigate the flaky session test");
    for (let attempt = 0; attempt < 20 && !controller.store.namingAttempted(); attempt += 1) {
      await Bun.sleep(1);
    }
    expect(controller.getSnapshot().sessionName).toBe(fallback);
    expect(controller.store.events.some((event) => event.type === "session.name.failed")).toBe(true);
  });

  test("newSession archives the old session and exposes a clean session with preserved controls", async () => {
    const root = await cwd();
    let fetches = 0;
    globalThis.fetch = (async () => ++fetches === 1 ? graphCall() : answer("old answer")) as unknown as typeof fetch;
    const phases: string[] = [];
    const controller = new GraphAgentController({
      cwd: root,
      sessionId: "old-session",
      model: "test/model",
      apiKey: "key",
      toolSchema,
      getPluginCatalog: async () => "catalog-v1",
      execute: async (_graph, _signal, onEvent) => {
        const event: ExecutionEvent = {
          sequence: 1,
          time: Date.now(),
          graphId: "control-graph",
          type: "graph.started",
          data: {},
        };
        onEvent(event);
        return report(join(root, "old-report.json"));
      },
    });
    controller.subscribe(() => phases.push(controller.getSnapshot().phase ?? "unset"));
    await controller.ready();
    controller.pin("old pinned constraint");
    await controller.submit("old evidence");
    expect(controller.getSnapshot().events.length).toBeGreaterThan(0);
    expect(phases).toContain("building");
    expect(phases).toContain("executing");

    const oldStore = controller.store;
    const oldDirectory = controller.sessionDirectory;
    await controller.newSession();

    const snapshot = controller.getSnapshot();
    expect(snapshot.sessionId).not.toBe("old-session");
    expect(controller.sessionDirectory).not.toBe(oldDirectory);
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.events).toEqual([]);
    expect(snapshot.contextTokens).toBe(0);
    expect(snapshot.cachedTokens).toBe(0);
    expect(snapshot.model).toBe("test/model");
    expect(snapshot.phase).toBe("idle");
    expect(snapshot.error).toBeUndefined();
    expect(controller.store.pins()).toEqual([]);

    const oldLog = await readFile(oldStore.logPath, "utf8");
    const newLog = await readFile(controller.store.logPath, "utf8");
    expect(oldLog).toContain("old evidence");
    expect(oldLog).toContain("old pinned constraint");
    expect(newLog).not.toContain("old evidence");
    expect(newLog).not.toContain("old pinned constraint");
    expect(newLog).toContain('"type":"model.selected"');
    expect(newLog).toContain('"type":"effort.selected"');
  });

  test("newSession cancels and drains active graph work before swapping stores", async () => {
    const root = await cwd();
    globalThis.fetch = (async () => graphCall()) as unknown as typeof fetch;
    let started!: () => void;
    const graphStarted = new Promise<void>((resolve) => { started = resolve; });
    let drained = false;
    const controller = new GraphAgentController({
      cwd: root,
      sessionId: "drain-old",
      model: "test/model",
      apiKey: "key",
      toolSchema,
      getPluginCatalog: async () => "",
      execute: async (_graph, signal) => {
        started();
        return await new Promise<GraphReport>((resolve) => {
          signal.addEventListener("abort", () => setTimeout(() => {
            drained = true;
            resolve(report(join(root, "drained-report.json"), "cancelled"));
          }, 15), { once: true });
        });
      },
    });
    await controller.ready();
    const oldStore = controller.store;
    const submitting = controller.submit("long graph");
    await graphStarted;
    const resetting = controller.newSession();
    expect(controller.store).toBe(oldStore);
    await resetting;
    await submitting;

    expect(drained).toBe(true);
    expect(controller.store).not.toBe(oldStore);
    expect(controller.getSnapshot().sessionId).not.toBe("drain-old");
    expect(controller.getSnapshot().messages).toEqual([]);
    expect(controller.getSnapshot().events).toEqual([]);
    expect(controller.getSnapshot().busy).toBe(false);
    expect((await readFile(oldStore.logPath, "utf8"))).toContain("long graph");
  });

  test("explicit effort is persisted, restored and sent; auto sends the supported level nearest medium", async () => {
    const root = await cwd();
    await saveModelCatalog(root, {
      fetchedAt: new Date().toISOString(),
      models: [{
        id: "test/model",
        supported_parameters: ["tools", "reasoning"],
        reasoning: { supported_efforts: ["xhigh", "high"], default_effort: "high", mandatory: false },
      }],
    });
    const bodies: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return answer();
    }) as unknown as typeof fetch;
    const options = {
      cwd: root,
      sessionId: "effort-session",
      model: "test/model",
      apiKey: "key",
      toolSchema,
      getPluginCatalog: async () => "",
      execute: async () => report("unused"),
    };
    const first = new GraphAgentController(options);
    await first.ready();
    await first.setEffort("xhigh");
    await first.submit("explicit effort");
    expect(bodies[0]?.reasoning).toEqual({ effort: "xhigh" });

    const restored = new GraphAgentController(options);
    await restored.ready();
    expect(restored.getSnapshot().effort).toBe("xhigh");
    await restored.setEffort("default");
    await restored.submit("provider default");
    // medium is not offered by this model; high is the nearest supported level.
    expect(bodies[1]?.reasoning).toEqual({ effort: "high" });
    expect(restored.getSnapshot().effort).toBeUndefined();
  });

  test("effort support is exact, including null and mandatory catalog metadata", async () => {
    const models = mergeModelOptions({
      fetchedAt: new Date().toISOString(),
      models: [
        { id: "all/model", supported_parameters: ["tools"], reasoning: { supported_efforts: null, mandatory: false } },
        { id: "mandatory/model", supported_parameters: ["tools"], reasoning: { supported_efforts: null, mandatory: true } },
        { id: "unsupported/model", supported_parameters: ["tools", "reasoning"], reasoning: { mandatory: false } },
      ],
    }, ["all/model", "mandatory/model", "unsupported/model"]);
    expect(models.find((model) => model.id === "all/model")?.reasoningEfforts)
      .toEqual(["max", "xhigh", "high", "medium", "low", "minimal", "none"]);
    expect(models.find((model) => model.id === "mandatory/model")?.reasoningEfforts)
      .toEqual(["max", "xhigh", "high", "medium", "low", "minimal"]);
    expect(models.find((model) => model.id === "unsupported/model")?.reasoningEfforts).toEqual([]);

    const root = await cwd();
    await saveModelCatalog(root, {
      fetchedAt: new Date().toISOString(),
      models: [{
        id: "limited/model",
        supported_parameters: ["tools", "reasoning"],
        reasoning: { supported_efforts: ["high", "low"] },
      }],
    });
    const controller = new GraphAgentController({
      cwd: root,
      model: "limited/model",
      apiKey: "key",
      toolSchema,
      getPluginCatalog: async () => "",
      execute: async () => report("unused"),
    });
    await controller.ready();
    await expect(controller.setEffort("xhigh")).rejects.toThrow("not supported");
    expect(controller.getSnapshot().effort).toBeUndefined();
  });

  test("setEffort refreshes unknown metadata and model changes clear incompatible effort", async () => {
    const root = await cwd();
    let catalogRequests = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/models")) {
        catalogRequests += 1;
        return Response.json({ data: [
          {
            id: "refresh/model",
            supported_parameters: ["tools", "reasoning"],
            reasoning: { supported_efforts: ["max", "xhigh"], default_effort: "xhigh" },
          },
          {
            id: "other/model",
            supported_parameters: ["tools", "reasoning"],
            reasoning: { supported_efforts: ["high", "low"] },
          },
        ] });
      }
      return answer();
    }) as unknown as typeof fetch;
    const controller = new GraphAgentController({
      cwd: root,
      sessionId: "refresh-effort",
      model: "refresh/model",
      apiKey: "key",
      toolSchema,
      getPluginCatalog: async () => "",
      execute: async () => report("unused"),
    });
    await controller.ready();
    expect(controller.getSnapshot().models.find((model) => model.id === "refresh/model")?.reasoningEfforts)
      .toBeUndefined();
    await controller.setEffort("xhigh");
    expect(catalogRequests).toBe(1);
    expect(controller.getSnapshot().effort).toBe("xhigh");

    controller.setModel("other/model");
    expect(controller.getSnapshot().effort).toBeUndefined();
    expect(controller.getSnapshot().messages.at(-1)?.text).toContain("reset to auto");
    const oldStore = controller.store;
    await controller.newSession();
    const restoredOld = new GraphAgentController({
      cwd: root,
      sessionId: oldStore.sessionId,
      apiKey: "key",
      toolSchema,
      getPluginCatalog: async () => "",
      execute: async () => report("unused"),
    });
    await restoredOld.ready();
    expect(restoredOld.getSnapshot().model).toBe("other/model");
    expect(restoredOld.getSnapshot().effort).toBeUndefined();
  });

  test("a delayed effort metadata refresh cannot update a replacement session", async () => {
    const root = await cwd();
    let catalogRequested!: () => void;
    const requested = new Promise<void>((resolve) => { catalogRequested = resolve; });
    let resolveCatalog!: (response: Response) => void;
    globalThis.fetch = (async () => {
      catalogRequested();
      return await new Promise<Response>((resolve) => { resolveCatalog = resolve; });
    }) as unknown as typeof fetch;
    const controller = new GraphAgentController({
      cwd: root,
      sessionId: "stale-effort",
      model: "unknown/model",
      apiKey: "key",
      toolSchema,
      getPluginCatalog: async () => "",
      execute: async () => report("unused"),
    });
    await controller.ready();
    const oldStore = controller.store;
    const setting = controller.setEffort("high");
    await requested;
    await controller.newSession();
    const replacement = controller.store;
    resolveCatalog(Response.json({ data: [{
      id: "unknown/model",
      supported_parameters: ["tools", "reasoning"],
      reasoning: { supported_efforts: ["high"] },
    }] }));

    await expect(setting).rejects.toThrow("session, model, or active request changed");
    expect(controller.store).toBe(replacement);
    expect(controller.store).not.toBe(oldStore);
    expect(controller.getSnapshot().effort).toBeUndefined();
    expect(controller.store.latestEffort()).toBeUndefined();
  });

  test("resume resets an incompatible saved effort after an explicit model override", async () => {
    const root = await cwd();
    const store = new SessionStore({ cwd: root, sessionId: "override-effort" });
    await store.initialize();
    await store.append("model.selected", { model: "original/model" });
    await store.append("effort.selected", { effort: "xhigh" });
    await store.flush();

    const sameModel = new GraphAgentController({
      cwd: root,
      sessionId: store.sessionId,
      apiKey: "key",
      toolSchema,
      getPluginCatalog: async () => "",
      execute: async () => report("unused"),
    });
    await sameModel.ready();
    expect(sameModel.getSnapshot().model).toBe("original/model");
    expect(sameModel.getSnapshot().effort).toBe("xhigh");

    await saveModelCatalog(root, {
      fetchedAt: new Date().toISOString(),
      models: [{
        id: "replacement/model",
        supported_parameters: ["tools", "reasoning"],
        reasoning: { supported_efforts: ["high", "low"] },
      }],
    });
    const overridden = new GraphAgentController({
      cwd: root,
      sessionId: store.sessionId,
      model: "replacement/model",
      apiKey: "key",
      toolSchema,
      getPluginCatalog: async () => "",
      execute: async () => report("unused"),
    });
    await overridden.ready();

    expect(overridden.getSnapshot().model).toBe("replacement/model");
    expect(overridden.getSnapshot().effort).toBeUndefined();
    expect(overridden.getSnapshot().messages.at(-1)?.text).toContain("reset to auto");
    expect(overridden.store.latestEffort()).toBeUndefined();
  });

  test("reasoning-only activity remains thinking before text transitions to responding", async () => {
    const root = await cwd();
    let release!: () => void;
    const releaseContent = new Promise<void>((resolve) => { release = resolve; });
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: "opaque" } }] })}\n\n`));
        await releaseContent;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
        controller.close();
      },
    }))) as unknown as typeof fetch;
    const controller = new GraphAgentController({
      cwd: root,
      model: "test/model",
      apiKey: "key",
      toolSchema,
      getPluginCatalog: async () => "",
      execute: async () => report("unused"),
    });
    const phases: Array<{ phase?: string; started?: number }> = [];
    controller.subscribe(() => phases.push({
      phase: controller.getSnapshot().phase,
      started: controller.getSnapshot().activityStartedAt,
    }));
    await controller.ready();
    const submitting = controller.submit("think first");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(controller.getSnapshot().phase).toBe("thinking");
    expect(controller.getSnapshot().activityStartedAt).toBeNumber();
    const thinkingStarted = controller.getSnapshot().activityStartedAt;
    release();
    await submitting;
    expect(phases.some((entry) => entry.phase === "responding" && typeof entry.started === "number")).toBe(true);
    // The clock times the whole turn, so handing over to another phase does not restart it.
    expect(phases.filter((entry) => entry.phase && entry.phase !== "idle").every((entry) => entry.started === thinkingStarted)).toBe(true);
    expect(controller.getSnapshot().phase).toBe("idle");
    expect(controller.getSnapshot().activityStartedAt).toBeUndefined();
  });
});
