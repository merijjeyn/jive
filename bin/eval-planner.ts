#!/usr/bin/env bun
/** Opt-in live behavior evaluation. Uses real planner/Jev calls and retains isolated artifacts. */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { plannerCases } from "../evals/planner/cases.ts";
import { hasSemanticContinuation, verifyOutputs } from "../evals/planner/verify.ts";
import { GraphAgentController } from "../src/planner/agent.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import { executeGraph } from "../src/core/executor.ts";
import { runtimeCatalog } from "../src/core/catalog.ts";
import { dependencies, validateGraph } from "../src/core/schema.ts";
import { graphToolParameters } from "../src/core/tool-schema.ts";

const { values } = parseArgs({ options: {
  model: { type: "string" }, case: { type: "string" }, out: { type: "string" },
  timeout: { type: "string", default: "120" }, help: { type: "boolean" },
} });
if (values.help) {
  console.log("bun run eval:planner --model MODEL [--case NAME] [--out report.json] [--timeout SECONDS]\nLive API calls; requires credentials for the model's provider (e.g. OPENROUTER_API_KEY) and JEV_API_TOKEN (or TYPESAFE_API_KEY) for semantic-batch. Workspaces are retained under a fresh temporary directory. Report heuristics and inspect traces alongside task correctness.");
  process.exit(0);
}
const selected = plannerCases.filter(c => !values.case || c.name === values.case);
if (!selected.length) throw new Error(`Unknown case. Choose: ${plannerCases.map(c => c.name).join(", ")}`);
if (selected.some(c => c.semantic) && !(process.env.JEV_API_TOKEN || process.env.TYPESAFE_API_KEY)) throw new Error("Semantic evaluation requires configured Jev credentials.");
const timeoutMs = Number(values.timeout) * 1000;
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeout must be a positive number of seconds.");
const providers = new ProviderRegistry({ cwd: process.cwd() });
const model = values.model ?? process.env.JIVE_MODEL ?? process.env.OPENROUTER_MODEL ?? providers.defaultModel();
if (!model) throw new Error("No model is configured; pass --model or set a provider key such as OPENROUTER_API_KEY.");
if (!providers.hasCredentials(model)) throw new Error(providers.missingCredentialsMessage(providers.resolve(model).provider));
const root = await mkdtemp(join(tmpdir(), "jive-planner-eval-"));
const results = [];
console.log(`Evaluation workspace: ${root}`);
for (const scenario of selected) {
  const cwd = join(root, scenario.name);
  await mkdir(cwd);
  await Promise.all(Object.entries(scenario.files).map(async ([file, content]) => {
    await mkdir(dirname(join(cwd, file)), { recursive: true });
    await writeFile(join(cwd, file), content);
  }));
  const controller = new GraphAgentController({
    cwd, model, providers, toolSchema: graphToolParameters,
    supportsStreaming: true, getPluginCatalog: () => runtimeCatalog(cwd),
    execute: (graph, signal, onEvent, streaming) => executeGraph(graph, { cwd, signal, onEvent, ...streaming, trackFileChanges: false }),
  });
  await controller.ready();
  const started = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.interrupt(); }, timeoutMs);
  try { await controller.submit(scenario.prompt); }
  finally { clearTimeout(timer); }
  const events = controller.store.events;
  const requests = events.filter(e => e.type === "planner.request");
  const graphs = events.filter(e => e.type === "graph.started").map(e => e.data.graph).filter(g => {
    try { validateGraph(g); return true; } catch { return false; }
  });
  const executionEvents = events.filter(e => e.type === "execution.event").map(e => e.data.event);
  const judgments = executionEvents.filter(e => e.type === "jev.request");
  const definitions = graphs.flatMap(g => [g, ...Object.values(g.templates ?? {})] as any[]);
  const nodes = definitions.flatMap(g => Object.values(g.nodes ?? {}) as any[]);
  const scripts = nodes.filter(n => n.type === "bash").map(n => n.script as string);
  // Diagnostics are intentionally heuristics; task outputs and the full trace are authoritative.
  const introspection = scripts.filter(s => /jive\s+--(?:help|schema)|which\s+(?:jive|jev)|printenv|env\s*\||src\/(?:jev|core\/executor)/.test(s));
  const outcomes = await verifyOutputs(scenario, cwd);
  const semanticContinuations = graphs.filter(hasSemanticContinuation).length;
  const toolCalls = events.filter(e => e.type === "planner.message" && e.data.message.role === "assistant").flatMap(e => e.data.message.tool_calls ?? []);
  const fileReplay = toolCalls.some(c => { try { return c.function.name === "execute_graph_mod" && JSON.parse(c.function.arguments).file === "workflow.json"; } catch { return false; } });
  const behavior = {
    noCapabilityProbes: introspection.length === 0,
    appropriateJudging: scenario.semantic ? judgments.length > 0 : judgments.length === 0,
    ...(scenario.semantic ? { inGraphSemanticContinuation: semanticContinuations > 0 } : {}),
    ...(scenario.replay ? { nativeFileReplay: fileReplay } : {}),
  };
  const firstJudgment = events.find(e => e.type === "execution.event" && e.data.event.type === "jev.request");
  const result = {
    case: scenario.name, model, cwd, session: controller.store.logPath,
    passed: Object.values(outcomes).every(Boolean) && Object.values(behavior).every(Boolean) && !controller.getSnapshot().error && !timedOut,
    outputs: outcomes, behavior, error: controller.getSnapshot().error, timedOut,
    metrics: {
      elapsedMs: Date.now() - started, plannerRequests: requests.length, graphCalls: toolCalls.length,
      jevCalls: judgments.length, firstJudgmentRound: firstJudgment ? requests.filter(r => r.sequence < firstJudgment.sequence).length : null,
      semanticContinuationGraphs: semanticContinuations,
      rejectedToolCalls: events.filter(e => e.type === "planner.message" && e.data.message.role === "tool").filter(e => { try { return JSON.parse(e.data.message.content).status === "error"; } catch { return false; } }).length,
      maxIndependentRootEntries: Math.max(0, ...graphs.map(g => Object.values({ ...g.nodes, ...g.groups }).filter(n => dependencies(n as any).length === 0).length)),
      foreachGroups: definitions.flatMap(g => Object.values(g.groups ?? {}) as any[]).filter(g => g.kind === "foreach").length,
      conditionalNodes: nodes.filter(n => n.when).length, capabilityProbeScripts: introspection.length,
      promptTokens: events.filter(e => e.type === "planner.message").reduce((n, e) => n + (e.data.usage?.promptTokens ?? 0), 0),
    },
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
const report = { model, workspace: root, results, passed: results.every(r => r.passed) };
const output = resolve(values.out ?? join(root, "report.json"));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2));
console.log(`Report: ${output}`);
if (!report.passed) process.exitCode = 1;
