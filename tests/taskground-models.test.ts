import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codexModels, claudeModels, validateModelSelection } from "../taskground/app/models";
import { agentCommand } from "../taskground/app/agents";
import { saveModelCatalog } from "../src/providers/index";

test("model catalogues preserve per-model efforts and omit hidden Codex models", () => {
  expect(codexModels({ models: [
    { slug: "visible", display_name: "Visible", visibility: "list", supported_reasoning_levels: [{ effort: "high" }, { effort: "xhigh" }] },
    { slug: "hidden", visibility: "hide" },
  ] })).toEqual([{ id: "visible", name: "Visible", reasoningEfforts: ["high", "xhigh"], reasoningDefault: undefined }]);
  const models = claudeModels([
    { value: "capable", displayName: "Capable", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
    { value: "simple", displayName: "Simple" },
    { value: "unknown", supportsEffort: true },
  ]);
  expect(models[0]!.reasoningEfforts).toEqual(["low", "high"]);
  expect(models[1]!.reasoningEfforts).toEqual([]);
  expect(models[2]!.reasoningEfforts).toBeUndefined();
  expect(() => validateModelSelection({ models }, "capable", "high")).not.toThrow();
  expect(() => validateModelSelection({ models }, "capable", "medium")).toThrow("does not support");
  expect(() => validateModelSelection({ models }, "freeform")).toThrow("available options");
  expect(() => validateModelSelection({ models }, "simple", "low")).toThrow();
  expect(() => validateModelSelection({ models }, undefined, "high")).toThrow("Choose a model");
  expect(() => validateModelSelection({ models })).not.toThrow();
});

test("each native launch receives the selected effort using its own CLI option", () => {
  const base = { workspace: "/tmp/task", prompt: "Do the task", headless: true, model: "chosen", effort: "high", finalPath: "/tmp/final" };
  for (const agent of ["jive", "claude"] as const) {
    const args = agentCommand({ ...base, agent });
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", "high"]);
  }
  expect(agentCommand({ ...base, agent: "codex" })).toContain('model_reasoning_effort="high"');
  expect(agentCommand({ ...base, effort: undefined, agent: "codex" }).some(arg => arg.includes("model_reasoning_effort"))).toBe(false);
});

test("managed terminals submit the task in the native UI while local interactive launches keep their draft behavior", () => {
  const base = { workspace: "/tmp/task", prompt: "Do the task", headless: false, finalPath: "/tmp/final" };
  for (const agent of ["jive", "claude", "codex"] as const) {
    const args = agentCommand({ ...base, agent, autoSubmit: true });
    expect(args.at(-1)).toBe(base.prompt);
    for (const flag of ["--headless", "--json", "--print", "--prefill", "exec"]) expect(args).not.toContain(flag);
    const local = agentCommand({ ...base, agent });
    if (agent === "codex") expect(local).not.toContain(base.prompt);
    else expect(local).toContain("--prefill");
  }
});

test("Jive CLI applies effort before submission without an inference request", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "taskground-effort-"));
  try {
    await saveModelCatalog(cwd, { fetchedAt: new Date().toISOString(), models: [{ id: "test/model", supported_parameters: ["tools"], reasoning: { supported_efforts: ["low", "high"] } }] });
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.tsx"), "--cwd", cwd, "--headless", "--model", "test/model", "--effort", "high"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENROUTER_API_KEY: "offline-test-key" } });
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    expect(code).toBe(1); expect(error).toContain("Headless planner requires");
    const sessions = await readdir(join(cwd, ".jev/sessions"));
    const events = (await readFile(join(cwd, ".jev/sessions", sessions[0]!, "session.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.findLast(e => e.type === "effort.selected")?.data.effort).toBe("high");
    expect(events.some(e => e.type === "planner.request")).toBe(false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
