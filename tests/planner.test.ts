import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphReport } from "../src/core/types.ts";
import { saveGraphForEditing } from "../src/core/graph-edits.ts";
import { executeGraph } from "../src/core/executor.ts";
import { runtimeContext } from "../src/planner/runtime-context.ts";
import { validateGraph } from "../src/core/schema.ts";
import { defaultEffortFor, GraphAgentController } from "../src/planner/agent.ts";
import { mergeModelOptions, ProviderClient, ProviderRegistry } from "../src/providers/index.ts";

const temporaryDirectories: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function splitSse(events: unknown[], splitEvery = 7): Response {
  const text = events
    .map((event) => event === "[DONE]" ? "data: [DONE]\r\n\r\n" : `data: ${JSON.stringify(event)}\r\n\r\n`)
    .join("");
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += splitEvery) {
        controller.enqueue(bytes.slice(offset, offset + splitEvery));
      }
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function toolResponse() {
  return splitSse([
    {
      model: "test/model",
      provider: "test-provider",
      choices: [{ delta: {
        reasoning_details: [{ type: "opaque", data: "keep-me" }],
        tool_calls: [{ index: 0, id: "call_", function: { name: "execute_", arguments: "{\"vers" } }],
      } }],
    },
    {
      choices: [{ delta: {
        tool_calls: [{ index: 0, id: "1", function: {
          name: "graph",
          arguments: "ion\":1,\"label\":\"streamed\",\"nodes\":{}}",
        } }],
      }, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 75, cache_write_tokens: 10 },
      },
    },
    "[DONE]",
  ]);
}

function answerResponse() {
  return splitSse([
    { model: "test/model", choices: [{ delta: { content: "All " } }] },
    {
      choices: [{ delta: { content: "done." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 130, completion_tokens: 5, total_tokens: 135, prompt_tokens_details: { cached_tokens: 90 } },
    },
    "[DONE]",
  ], 5);
}

/** A tool round that streams visible reasoning text before the call. */
function reasoningToolResponse() {
  return splitSse([
    {
      model: "test/model",
      choices: [{ delta: { reasoning: "Checking the session " } }],
    },
    {
      choices: [{ delta: {
        reasoning: "store first.",
        tool_calls: [{ index: 0, id: "1", function: {
          name: "execute_graph",
          arguments: "{\"version\":1,\"label\":\"streamed\",\"nodes\":{}}",
        } }],
      }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    },
    "[DONE]",
  ], 7);
}

function twoToolResponse() {
  return splitSse([
    {
      model: "test/model",
      choices: [{
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "first-call",
              function: {
                name: "execute_graph",
                arguments: JSON.stringify({ version: 1, label: "first", nodes: {} }),
              },
            },
            {
              index: 1,
              id: "second-call",
              function: {
                name: "execute_graph",
                arguments: JSON.stringify({ version: 1, label: "second", nodes: {} }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      }],
    },
    "[DONE]",
  ]);
}

async function makeCwd(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "jev-planner-test-"));
  temporaryDirectories.push(cwd);
  return cwd;
}

const toolSchema = {
  name: "execute_graph",
  description: "execute",
  parameters: { type: "object" },
};

describe("OpenRouter planner", () => {
  test("records the actual prompt and capabilities without credentials, refreshes facts on resume", async () => {
    const cwd = await makeCwd();
    const bodies: any[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return answerResponse();
    }) as unknown as typeof fetch;
    const env = { JEV_API_TOKEN: "never-log-this", JEV_MODEL: "custom-judge", UNRELATED_SECRET: "also-private" };
    const options = {
      cwd, model: "test/model", sessionId: "context-provenance", apiKey: "planner-secret", toolSchema,
      getRuntimeContext: () => runtimeContext(cwd, false, env), getPluginCatalog: async () => "catalog v1",
      execute: async () => { throw new Error("no graph expected"); },
    };
    const controller = new GraphAgentController(options);
    await controller.ready();
    await controller.submit("first");
    await controller.submit("second");
    const snapshots = controller.store.events.filter(e => e.type === "planner.context");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.data.messages).toEqual(bodies[0].messages.slice(0, 2));
    expect(snapshots[0]!.data.toolSchemas).toEqual(bodies[0].tools.map((t: any) => t.function));
    expect(snapshots[0]!.data.runtime.jev).toMatchObject({ credentialsConfigured: true, model: "custom-judge" });
    expect(controller.store.events.filter(e => e.type === "planner.request").map(e => e.data.contextSequence)).toEqual([snapshots[0]!.sequence, snapshots[0]!.sequence]);
    const log = await readFile(controller.store.logPath, "utf8");
    for (const secret of ["never-log-this", "also-private", "planner-secret"]) expect(log).not.toContain(secret);
    env.JEV_API_TOKEN = "";
    const resumed = new GraphAgentController(options);
    await resumed.ready();
    await resumed.submit("third");
    const updated = resumed.store.events.filter(e => e.type === "planner.context");
    expect(updated).toHaveLength(2);
    expect(updated[1]!.data.runtime.jev.credentialsConfigured).toBe(false);
    expect(bodies[2].messages[1].content).toContain('"credentialsConfigured":false');
  });
  test("snapshots AGENTS.md in the system prompt for the lifetime of a session", async () => {
    const cwd = await makeCwd();
    const agentsPath = join(cwd, "AGENTS.md");
    await writeFile(agentsPath, "Use the original session instructions.\n");
    const requestBodies: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return answerResponse();
    }) as unknown as typeof fetch;
    const options = {
      cwd,
      model: "test/model",
      sessionId: "agents-snapshot-test",
      apiKey: "test-key",
      toolSchema,
      getPluginCatalog: async () => "",
      execute: async () => { throw new Error("no graph expected"); },
    };
    const controller = new GraphAgentController(options);
    await controller.ready();

    await writeFile(agentsPath, "Use replacement instructions.\n");
    await controller.submit("first turn");
    await controller.submit("second turn");

    const firstSystemPrompt = requestBodies[0]!.messages[0].content as string;
    expect(firstSystemPrompt).toContain(`Project instructions from ${agentsPath}`);
    expect(firstSystemPrompt).toContain("Use the original session instructions.");
    expect(firstSystemPrompt).not.toContain("Use replacement instructions.");
    expect(requestBodies[1]!.messages[0].content).toBe(firstSystemPrompt);
    expect(controller.store.events.filter((event) => event.type === "project.instructions")).toHaveLength(1);

    const resumed = new GraphAgentController(options);
    await resumed.ready();
    await resumed.submit("resumed turn");
    expect(requestBodies[2]!.messages[0].content).toBe(firstSystemPrompt);
    expect(resumed.store.events.filter((event) => event.type === "project.instructions")).toHaveLength(1);

    await resumed.newSession();
    await resumed.submit("new session turn");
    const newSessionPrompt = requestBodies[3]!.messages[0].content as string;
    expect(newSessionPrompt).toContain("Use replacement instructions.");
    expect(newSessionPrompt).not.toContain("Use the original session instructions.");
  });

  test("parses split SSE and fragmented tool arguments", async () => {
    const client = new ProviderClient({
      registry: new ProviderRegistry({ cwd: tmpdir(), sources: [], keys: { openrouter: "test-key" } }),
      fetch: (async () => toolResponse()) as unknown as typeof fetch,
    });
    const result = await client.complete({
      model: "test/model",
      sessionId: "session",
      messages: [{ role: "user", content: "go" }],
      toolSchema,
    });
    expect(result.message.tool_calls).toEqual([{
      id: "call_1",
      type: "function",
      function: {
        name: "execute_graph",
        arguments: '{"version":1,"label":"streamed","nodes":{}}',
      },
    }]);
    expect(result.message.reasoning_details).toEqual([{ type: "opaque", data: "keep-me" }]);
    expect(result.usage.cachedTokens).toBe(75);
  });

  test("controller executes a streamed graph once and preserves reasoning in the tool round", async () => {
    const cwd = await makeCwd();
    const requestBodies: Array<Record<string, any>> = [];
    let fetches = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      fetches += 1;
      return fetches === 1 ? toolResponse() : answerResponse();
    }) as unknown as typeof fetch;
    let executions = 0;
    const report: GraphReport = {
      graphId: "graph-1",
      label: "streamed",
      status: "done",
      previews: [],
      requested: {},
      recordPath: join(cwd, "graph-1.json"),
    };
    const controller = new GraphAgentController({
      cwd,
      model: "test/model",
      sessionId: "stream-test",
      apiKey: "test-key",
      toolSchema,
      getPluginCatalog: async () => "plugin-a v1",
      execute: async (graph) => {
        executions += 1;
        expect(graph.label).toBe("streamed");
        return report;
      },
    });
    await controller.ready();
    await controller.submit("do the work");

    expect(executions).toBe(1);
    expect(fetches).toBe(2);
    expect(controller.getSnapshot().messages.at(-1)?.text).toBe("All done.");
    expect(controller.getSnapshot().cachedTokens).toBe(165);
    const secondAssistant = requestBodies[1]!.messages.find(
      (message: Record<string, unknown>) => message.role === "assistant" && message.tool_calls,
    );
    expect(secondAssistant.reasoning_details).toEqual([{ type: "opaque", data: "keep-me" }]);
    expect(requestBodies[0]!.session_id).toBe("stream-test");
    expect(requestBodies[0]!.provider).toEqual({ allow_fallbacks: false });
  });

  test("a turn can continue beyond the former 24 tool-round ceiling", async () => {
    const cwd = await makeCwd();
    let fetches = 0;
    globalThis.fetch = (async () => ++fetches <= 25 ? toolResponse() : answerResponse()) as unknown as typeof fetch;
    let executions = 0;
    const controller = new GraphAgentController({
      cwd, model: "test/model", sessionId: "long-turn-test", apiKey: "test-key", toolSchema,
      getPluginCatalog: async () => "",
      execute: async () => ({
        graphId: `graph-${++executions}`, label: "streamed", status: "done", previews: [], requested: {},
        recordPath: join(cwd, `graph-${executions}.json`),
      }),
    });
    await controller.ready();
    await controller.submit("keep going until the work is complete");

    expect(executions).toBe(25);
    expect(fetches).toBe(26);
    expect(controller.getSnapshot().messages.at(-1)?.text).toBe("All done.");
    expect(controller.getSnapshot().error).toBeUndefined();
  });

  test("a tool round's reasoning becomes a transcript entry and survives a resume", async () => {
    const cwd = await makeCwd();
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return fetches === 1 ? reasoningToolResponse() : answerResponse();
    }) as unknown as typeof fetch;
    const report: GraphReport = {
      graphId: "graph-1", label: "streamed", status: "done", previews: [], requested: {},
      recordPath: join(cwd, "graph-1.json"),
    };
    const options = {
      cwd, model: "test/model", sessionId: "reasoning-test", apiKey: "test-key", toolSchema,
      getPluginCatalog: async () => "plugin-a v1",
      execute: async () => report,
    };
    const controller = new GraphAgentController(options);
    await controller.ready();
    await controller.submit("do the work");

    const roles = controller.getSnapshot().messages.map((m) => m.role);
    expect(roles).toEqual(["user", "thinking", "assistant"]);
    const thinking = controller.getSnapshot().messages[1]!;
    expect(thinking.text).toBe("Checking the session store first.");

    // The same rows come back when the session is reopened.
    const resumed = new GraphAgentController(options);
    await resumed.ready();
    const restored = resumed.getSnapshot().messages;
    expect(restored.map((m) => m.role)).toEqual(["user", "thinking", "assistant"]);
    expect(restored[1]!.text).toBe("Checking the session store first.");
    expect(restored[1]!.id).toBe(thinking.id);
  });

  test("reasoning that arrives after the reply is placed above it and empty content deltas leave no entry", async () => {
    const cwd = await makeCwd();
    globalThis.fetch = (async () => splitSse([
      { choices: [{ delta: { role: "assistant", content: "" } }] },
      { choices: [{ delta: { content: "The fix " } }] },
      { choices: [{ delta: { content: "is in place." } }] },
      { choices: [{ delta: { reasoning: "Reviewing the earlier runs." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
      "[DONE]",
    ])) as unknown as typeof fetch;
    const controller = new GraphAgentController({
      cwd, model: "test/model", sessionId: "late-reasoning", apiKey: "test-key", toolSchema,
      getPluginCatalog: async () => "", execute: async () => { throw new Error("no graph expected"); },
    });
    await controller.ready();
    await controller.submit("fix it");
    const messages = controller.getSnapshot().messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "thinking", "assistant"]);
    expect(messages[1]!.text).toBe("Reviewing the earlier runs.");
    expect(messages[2]!.text).toBe("The fix is in place.");
  });

  test("does not retry an executed graph when the following transport call fails", async () => {
    const cwd = await makeCwd();
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      if (fetches === 1) return toolResponse();
      throw new Error("network vanished");
    }) as unknown as typeof fetch;
    let executions = 0;
    const controller = new GraphAgentController({
      cwd,
      model: "test/model",
      sessionId: "no-retry-test",
      apiKey: "test-key",
      toolSchema,
      // The transport itself retries; the graph behind the first call must not run again.
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      getPluginCatalog: async () => "",
      execute: async () => {
        executions += 1;
        return {
          graphId: "graph-once",
          label: "streamed",
          status: "done",
          previews: [],
          requested: {},
          recordPath: "record.json",
        };
      },
    });
    await controller.ready();
    await controller.submit("execute once");

    expect(executions).toBe(1);
    expect(fetches).toBe(4);
    expect(controller.getSnapshot().error).toContain("Could not reach OpenRouter");
    const raw = await readFile(join(cwd, ".jev", "sessions", "no-retry-test", "session.jsonl"), "utf8");
    const records = raw.trim().split("\n").map(line=>JSON.parse(line));
    expect(records.filter(event=>event.type==="graph.started")).toHaveLength(1);
    expect(records.filter(event=>event.type==="graph.finished")).toHaveLength(1);
  });

  test("cancellation closes every emitted tool call before the next user message", async () => {
    const cwd = await makeCwd();
    const requestBodies: Array<Record<string, any>> = [];
    let fetches = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      fetches += 1;
      return fetches === 1 ? twoToolResponse() : answerResponse();
    }) as unknown as typeof fetch;

    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let executions = 0;
    const controller = new GraphAgentController({
      cwd,
      model: "test/model",
      sessionId: "cancel-batch-test",
      apiKey: "test-key",
      toolSchema,
      getPluginCatalog: async () => "stable catalog",
      execute: async (_graph, signal) => {
        executions += 1;
        signalStarted();
        return await new Promise<GraphReport>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    await controller.ready();
    const firstSubmit = controller.submit("start both graphs");
    await started;
    controller.interrupt();
    await firstSubmit;

    const closedResults = controller.store.plannerMessageEvents()
      .map((event) => event.data.message)
      .filter((message) => message.role === "tool");
    expect(closedResults.map((message) => message.tool_call_id)).toEqual([
      "first-call",
      "second-call",
    ]);
    expect(closedResults[1]?.content).toContain('"status":"cancelled"');

    await controller.submit("decide recovery safely");
    expect(executions).toBe(1);
    expect(fetches).toBe(2);
    const messages = requestBodies[1]!.messages as Array<Record<string, any>>;
    const assistantIndex = messages.findIndex((message) => message.tool_calls?.length === 2);
    expect(messages[assistantIndex + 1]?.tool_call_id).toBe("first-call");
    expect(messages[assistantIndex + 2]?.tool_call_id).toBe("second-call");
    expect(messages.slice(assistantIndex + 3).some(
      (message) => message.role === "user" && message.content === "decide recovery safely",
    )).toBe(true);
  });

  test("publishes a changed plugin catalog before the next planning request", async () => {
    const cwd = await makeCwd();
    const requestBodies: Array<Record<string, any>> = [];
    let fetches = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      fetches += 1;
      return fetches === 1 ? toolResponse() : answerResponse();
    }) as unknown as typeof fetch;
    let catalogReads = 0;
    const controller = new GraphAgentController({
      cwd,
      model: "test/model",
      sessionId: "plugin-refresh-test",
      apiKey: "test-key",
      toolSchema,
      getPluginCatalog: async () => ++catalogReads === 1 ? "plugin-a v1" : "plugin-a v1\nplugin-new v1",
      execute: async () => ({
        graphId: "plugin-authoring-graph",
        label: "streamed",
        status: "done",
        previews: [],
        requested: {},
        recordPath: "record.json",
      }),
    });
    await controller.ready();
    await controller.submit("author then use a plugin");

    expect(catalogReads).toBe(2);
    expect(requestBodies[1]!.messages.some(
      (message: Record<string, unknown>) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes("plugin-new v1"),
    )).toBe(true);
    expect(controller.store.events.filter((event) => event.type === "plugin.catalog")).toHaveLength(2);
  });

  test("auto effort resolves to medium or the nearest supported level, and to nothing without an effort control", () => {
    expect(defaultEffortFor(undefined)).toBe("medium");
    expect(defaultEffortFor({ id: "m", name: "m" })).toBe("medium");
    expect(defaultEffortFor({ id: "m", name: "m", reasoningEfforts: ["low", "medium", "high"] })).toBe("medium");
    expect(defaultEffortFor({ id: "m", name: "m", reasoningEfforts: ["xhigh", "high"] })).toBe("high");
    expect(defaultEffortFor({ id: "m", name: "m", reasoningEfforts: ["low", "high"] })).toBe("low");
    expect(defaultEffortFor({ id: "m", name: "m", reasoningEfforts: ["max"] })).toBe("max");
    expect(defaultEffortFor({ id: "m", name: "m", reasoningEfforts: ["none"], reasoningMandatory: true })).toBeUndefined();
    expect(defaultEffortFor({ id: "m", name: "m", reasoningEfforts: [] })).toBeUndefined();
  });

  test("uses only reasoning efforts returned by model metadata", () => {
    const models = mergeModelOptions({
      fetchedAt: "2026-09-18T00:00:00.000Z",
      models: [
        {
          id: "openai/gpt-6-astra",
          supported_parameters: ["tools", "reasoning"],
          reasoning: { supported_efforts: ["minimal", "medium", "xhigh"] },
        },
        {
          id: "openai/gpt-5.6-sol",
          supported_parameters: ["tools", "reasoning"],
        },
      ],
    });
    expect(models.find((model) => model.id === "openai/gpt-6-astra")?.reasoningEfforts)
      .toEqual(["minimal", "medium", "xhigh"]);
    expect(models.find((model) => model.id === "openai/gpt-5.6-sol")?.reasoningEfforts)
      .toEqual([]);
  });

  test("missing key is actionable and never reports fake success", async () => {
    const cwd = await makeCwd();
    const oldKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const controller = new GraphAgentController({
        cwd,
        model: "test/model",
        sessionId: "no-key-test",
        toolSchema,
        getPluginCatalog: async () => "",
        execute: async () => { throw new Error("must not execute"); },
      });
      await controller.ready();
      await controller.submit("hello");
      expect(controller.getSnapshot().error).toContain("OPENROUTER_API_KEY");
      expect(controller.getSnapshot().messages.at(-1)?.role).toBe("notice");
    } finally {
      if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = oldKey;
    }
  });

  function graphCallResponse(argumentsText: string) {
    return splitSse([
      { model: "test/model", choices: [{ delta: {
        tool_calls: [{ index: 0, id: "call-1", function: { name: "execute_graph", arguments: argumentsText } }],
      }, finish_reason: "tool_calls" }] },
      "[DONE]",
    ]);
  }

  async function runOneGraph(argumentsText: string, execute: (graph: any) => Promise<GraphReport>) {
    const cwd = await makeCwd();
    const bodies: Array<Record<string, any>> = [];
    let fetches = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return ++fetches === 1 ? graphCallResponse(argumentsText) : answerResponse();
    }) as unknown as typeof fetch;
    const controller = new GraphAgentController({
      cwd, model: "test/model", sessionId: "repair-test", apiKey: "test-key", toolSchema,
      getPluginCatalog: async () => "", execute,
    });
    await controller.ready();
    await controller.submit("go");
    const toolMessage = bodies[1]!.messages.find((message: Record<string, unknown>) => message.role === "tool");
    return { controller, toolResult: JSON.parse(toolMessage.content) };
  }

  test("repairs a string version and JSON-encoded nodes, executes, and tells the model what changed", async () => {
    const sent = JSON.stringify({ version: "1", label: "repaired", nodes: JSON.stringify({ a: { type: "bash", script: "ls" } }) });
    const executed: any[] = [];
    const { controller, toolResult } = await runOneGraph(sent, async (graph) => {
      executed.push(graph);
      return { graphId: "g", label: graph.label, status: "done", previews: [], requested: {}, recordPath: "/dev/null" };
    });
    expect(executed).toHaveLength(1);
    expect(executed[0]).toEqual({ version: 1, label: "repaired", nodes: { a: { type: "bash", script: "ls" } } });
    expect(toolResult.status).toBe("done");
    expect(toolResult.repairs).toEqual([
      '/version: coerced the string "1" to the number 1. Send the corrected shape next time.',
      "/nodes: parsed a JSON-encoded string into an object; send an object directly. Send the corrected shape next time.",
    ]);
    expect(controller.getSnapshot().error).toBeUndefined();
  });

  test("schema rejections carry a readable message, a hint, and a minimal example", async () => {
    const { toolResult } = await runOneGraph("{}", async () => { throw new Error("must not execute"); });
    expect(toolResult.status).toBe("error");
    // A missing version or label is repaired, not rejected; only the work itself is required.
    expect(toolResult.error).toBe('Invalid graph: / is missing required property "nodes"');
    expect(toolResult.hint).toContain("version is the JSON number 1");
    expect(toolResult.example).toEqual({ version: 1, label: "List files", nodes: { list: { type: "bash", script: "ls -la" } }, returns: ["list"] });
  });

  test("rejected node types are reported once with the allowed options", async () => {
    const sent = JSON.stringify({ version: 2, label: "bad", nodes: { a: { type: "shell", script: "ls" } } });
    const { toolResult } = await runOneGraph(sent, async () => { throw new Error("must not execute"); });
    expect(toolResult.error).toBe(
      'Invalid graph: /version must be the number 1 (received the number 2); /nodes/a/type must be one of "bash", "jev" (received the string "shell")',
    );
    expect(toolResult.hint).toBeDefined();
  });

  type ToolResults = Array<{ name: string; result: any }>;
  interface PlannedCall { id: string; name: string; arguments: unknown | ((previous: ToolResults) => unknown) }

  function callResponse(calls: PlannedCall[], previous: ToolResults) {
    return splitSse([
      { model: "test/model", choices: [{ delta: {
        tool_calls: calls.map((call, index) => ({ index, id: call.id, function: {
          name: call.name,
          arguments: JSON.stringify(typeof call.arguments === "function" ? call.arguments(previous) : call.arguments),
        } })),
      }, finish_reason: "tool_calls" }] },
      "[DONE]",
    ]);
  }

  function toolResultsIn(body: Record<string, any>): ToolResults {
    return body.messages
      .filter((message: Record<string, unknown>) => message.role === "tool")
      .map((message: Record<string, any>) => ({ name: message.name, result: JSON.parse(message.content) }));
  }

  /** Runs one planner turn whose rounds are the given tool calls, then a final answer. Later rounds may read earlier results. */
  async function runRounds(
    cwd: string,
    rounds: PlannedCall[][],
    execute: (graph: any) => Promise<GraphReport>,
  ) {
    const bodies: Array<Record<string, any>> = [];
    let fetches = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const round = rounds[fetches++];
      return round ? callResponse(round, toolResultsIn(body)) : answerResponse();
    }) as unknown as typeof fetch;
    const controller = new GraphAgentController({
      cwd, model: "test/model", sessionId: "mod-test", apiKey: "test-key", toolSchema,
      supportsStreaming: true, getPluginCatalog: async () => "", execute,
    });
    await controller.ready();
    await controller.submit("go");
    return { controller, bodies, toolResults: toolResultsIn(bodies.at(-1)!) };
  }

  test("execute_graph_mod loads the saved base, applies edits, executes the result, and records the rerun", async () => {
    const cwd = await makeCwd();
    await saveGraphForEditing(cwd, "g-base", {
      version: 1, label: "base", nodes: { a: { type: "bash", script: "ls", env: { X: "1" } }, b: { type: "bash", script: "pwd" } }, returns: ["a"],
    });
    const executed: any[] = [];
    const { controller, toolResults, bodies } = await runRounds(cwd, [[{
      id: "call-mod", name: "execute_graph_mod",
      arguments: { base: "g-base", label: "fixed", edits: [
        { path: "/nodes/a/script", old: "ls", new: "ls -la" },
        { path: "/nodes/b", new: null },
      ] },
    }]], async (graph) => {
      executed.push(graph);
      return { graphId: "g-next", label: graph.label, status: "done", previews: [], requested: {}, recordPath: "/dev/null" };
    });
    expect(bodies[0]!.tools.map((tool: any) => tool.function.name)).toEqual(["execute_graph", "execute_graph_mod"]);
    expect(executed).toEqual([{ version: 1, label: "fixed", nodes: { a: { type: "bash", script: "ls -la", env: { X: "1" } } }, returns: ["a"] }]);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].name).toBe("execute_graph_mod");
    expect(toolResults[0].result.status).toBe("done");
    expect(toolResults[0].result.applied).toEqual(["/nodes/a/script: replaced 2 characters", "/nodes/b: deleted"]);
    expect(toolResults[0].result.rerun).toContain('execute_graph_mod with base "g-next"');
    const started = controller.store.events.find((event) => event.type === "graph.started");
    expect(started?.data).toMatchObject({ callId: "call-mod", base: "g-base", edits: [{ path: "/nodes/a/script", old: "ls", new: "ls -la" }, { path: "/nodes/b", new: null }] });
    expect(started?.data.graph.nodes.a.script).toBe("ls -la");
    expect(controller.getSnapshot().error).toBeUndefined();
  });

  test("file and unchanged ID replay execute real graphs in session cwd and preserve sources", async () => {
    const cwd = await makeCwd();
    const graph = { version: 1, label: "replay", nodes: { a: { type: "bash", script: "pwd > location.txt; printf ok", } }, returns: ["a"] };
    const file = await saveGraphForEditing(cwd, "original", graph);
    const { controller, toolResults } = await runRounds(cwd, [
      [{ id: "from-file", name: "execute_graph_mod", arguments: { file: ".jev/runs/original/graph.json" } }],
      [{ id: "unchanged", name: "execute_graph_mod", arguments: (previous: ToolResults) => ({ base: previous[0]!.result.graphId }) }],
      [{ id: "edited", name: "execute_graph_mod", arguments: { file, edits: [{ path: "/nodes/a/script", new: "printf edited" }] } }],
    ], graph => executeGraph(graph, { cwd, trackFileChanges: false }));
    expect(toolResults.map(r => r.result.status)).toEqual(["done", "done", "done"]);
    expect(toolResults.map(r => r.result.requested.a.output.stdout)).toEqual(["ok", "ok", "edited"]);
    expect(new Set(toolResults.map(r => r.result.graphId)).size).toBe(3);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(graph);
    expect((await readFile(join(cwd, "location.txt"), "utf8")).trim()).toBe(await realpath(cwd));
    expect(controller.store.events.filter(e => e.type === "graph.started")[0]!.data.file).toBe(".jev/runs/original/graph.json");
  });

  test("invalid file graphs fail validation before effects and remain editable", async () => {
    const cwd = await makeCwd();
    await writeFile(join(cwd, "bad.json"), JSON.stringify({ version: 1, label: "bad", nodes: { a: { type: "shell", script: "touch must-not-exist" } } }));
    const { toolResults } = await runRounds(cwd, [[{ id: "invalid", name: "execute_graph_mod", arguments: { file: "bad.json" } }]],
      graph => executeGraph(graph, { cwd, trackFileChanges: false }));
    expect(toolResults[0]!.result.status).toBe("error");
    expect(toolResults[0]!.result.error).toContain("/nodes/a/type");
    expect(toolResults[0]!.result.graphId).toBeDefined();
    await expect(readFile(join(cwd, "must-not-exist"))).rejects.toThrow();
  });

  test("a schema-rejected graph is saved under the returned graphId so one edit can fix it", async () => {
    const cwd = await makeCwd();
    const executed: any[] = [];
    const { controller, toolResults } = await runRounds(cwd, [
      [{ id: "call-1", name: "execute_graph", arguments: { version: 1, label: "big", nodes: { a: { type: "shell", script: "ls" }, b: { type: "bash", script: "pwd" } } } }],
      [{ id: "call-2", name: "execute_graph_mod", arguments: (previous: ToolResults) => ({ base: previous[0]!.result.graphId, edits: [{ path: "/nodes/a/type", new: "bash" }] }) }],
    ], async (graph) => {
      validateGraph(graph);
      executed.push(graph);
      return { graphId: "g-fixed", label: graph.label, status: "done", previews: [], requested: {}, recordPath: "/dev/null" };
    });
    expect(toolResults.map((entry: any) => entry.result.status), JSON.stringify(toolResults)).toEqual(["error", "done"]);
    expect(controller.getSnapshot().error).toBeUndefined();
    expect(toolResults[0].result.error).toContain("/nodes/a/type must be one of");
    const rejectedId = toolResults[0].result.graphId;
    expect(rejectedId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(toolResults[0].result.rerun).toContain(`execute_graph_mod with base "${rejectedId}"`);
    expect(toolResults[0].result.hint).toContain("call execute_graph_mod with that base");
    expect(await readFile(join(cwd, ".jev", "runs", rejectedId, "graph.json"), "utf8")).toContain('"type": "shell"');
    expect(executed).toEqual([{ version: 1, label: "big", nodes: { a: { type: "bash", script: "ls" }, b: { type: "bash", script: "pwd" } } }]);
  });

  test("an unknown base or a non-matching edit answers the call without executing anything", async () => {
    const cwd = await makeCwd();
    await saveGraphForEditing(cwd, "g-base", { version: 1, label: "base", nodes: { a: { type: "bash", script: "ls" } } });
    const { controller, toolResults } = await runRounds(cwd, [[
      { id: "m1", name: "execute_graph_mod", arguments: { base: "nope", edits: [{ path: "/nodes/a/script", new: "x" }] } },
      { id: "m2", name: "execute_graph_mod", arguments: { base: "g-base", edits: [{ path: "/nodes/a/script", old: "pwd", new: "x" }] } },
      { id: "m3", name: "execute_graph_mod", arguments: { base: "g-base", edits: "not edits" } },
    ]], async () => { throw new Error("must not execute"); });
    expect(toolResults.map((entry: any) => entry.result.status)).toEqual(["error", "error", "error"]);
    expect(toolResults[0].result.error).toBe('No saved graph with graphId "nope". Use the graphId from an earlier execute_graph result; saved graphs live under .jev/runs/.');
    expect(toolResults[0].result.base).toBe("nope");
    expect(toolResults[1].result.error).toContain("old was not found. Current value:\nls");
    expect(toolResults[1].result.hint).toContain("nothing ran");
    expect(toolResults[2].result.error).toContain("edits must be an array");
    expect(controller.store.events.some((event) => event.type === "graph.started")).toBe(false);
  });
});
