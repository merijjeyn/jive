import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { fetchOpenRouterModelCatalog, loadCachedModelCatalog, ProviderRegistry, saveModelCatalog } from "../../src/providers/index";
import type { ModelOption } from "../../src/core/types";
import { primarySource } from "./source";
import { dataDirectory } from "./storage";
import type { Agent } from "./agents";

export interface AgentModels { models: ModelOption[]; notice?: string }
const pending = new Map<Agent, { until: number; result: Promise<AgentModels> }>();

export function codexModels(catalog: any): ModelOption[] {
  return (Array.isArray(catalog?.models) ? catalog.models : []).filter((m: any) => typeof m.slug === "string" && m.visibility === "list").map((m: any) => ({
    id: m.slug, name: m.display_name || m.slug,
    reasoningEfforts: (m.supported_reasoning_levels ?? []).map((entry: any) => entry.effort).filter((s: unknown) => typeof s === "string"),
    reasoningDefault: m.default_reasoning_level,
  }));
}

export function claudeModels(models: any): ModelOption[] {
  return (Array.isArray(models) ? models : []).filter((m: any) => typeof m.value === "string").map((m: any) => ({
    id: m.value, name: m.displayName || m.value,
    reasoningEfforts: m.supportsEffort ? m.supportedEffortLevels?.filter((s: unknown) => typeof s === "string") : [],
  }));
}

/** Initialization returns model capabilities; no prompt, inference, or session is submitted. */
async function discoverClaude(): Promise<ModelOption[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--bare"], { stdio: ["pipe", "pipe", "ignore"] });
    let settled = false;
    const finish = (error?: Error, models?: ModelOption[]) => {
      if (settled) return; settled = true; clearTimeout(timer); lines.close(); child.kill();
      if (error) reject(error); else resolve(models!);
    };
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => finish(new Error("Claude model discovery timed out")), 6000);
    child.once("error", error => finish(error));
    child.stdin.on("error", error => finish(error));
    child.once("exit", () => finish(new Error("Claude did not return its model list")));
    lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.type === "control_response" && message.response?.request_id === "taskground-models") {
          const models = claudeModels(message.response.response?.models);
          finish(models.length ? undefined : new Error("Claude model metadata is unavailable"), models);
        }
      } catch { /* Unrelated diagnostic output. */ }
    });
    child.stdin.write(JSON.stringify({ type: "control_request", request_id: "taskground-models", request: { subtype: "initialize" } }) + "\n");
  });
}

async function discover(agent: Agent): Promise<AgentModels> {
  if (agent === "jive") {
    const data = await dataDirectory();
    const source = await primarySource();
    let catalog = await loadCachedModelCatalog(data) ?? await loadCachedModelCatalog(source.directory);
    let notice: string | undefined;
    if (!catalog || Date.now() - Date.parse(catalog.fetchedAt) > 3600_000) {
      try {
        catalog = await fetchOpenRouterModelCatalog({ signal: AbortSignal.timeout(5000) });
        await saveModelCatalog(data, catalog);
      } catch { notice = catalog ? "Using cached model capabilities." : "Effort metadata is unavailable; use the model's default effort."; }
    }
    // Every provider Jive can reach from the source checkout, with OpenRouter's live metadata.
    const registry = new ProviderRegistry({ cwd: source.directory });
    await registry.loadCachedCatalogs(source.directory);
    if (catalog) registry.useOpenRouterCatalog(catalog);
    const models = registry.modelOptions().filter((model) => model.available !== false || model.provider === "openrouter");
    return { models, notice };
  }
  try {
    if (agent === "codex") {
      const cache = JSON.parse(await readFile(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json"), "utf8"));
      const models = codexModels(cache);
      return { models, ...(models.length ? {} : { notice: "Open Codex once to load its available models." }) };
    }
    return { models: await discoverClaude() };
  } catch { return { models: [], notice: `Model discovery is unavailable. Open ${agent === "codex" ? "Codex" : "Claude"} once, then refresh; the agent default is still available.` }; }
}

export function getAgentModels(agent: Agent): Promise<AgentModels> {
  const cached = pending.get(agent);
  if (cached && cached.until > Date.now()) return cached.result;
  const result = discover(agent);
  pending.set(agent, { until: Date.now() + 60_000, result });
  result.catch(() => pending.delete(agent));
  return result;
}

export function validateModelSelection(catalog: AgentModels, model?: string, effort?: string) {
  if (!model && effort) throw new Error("Choose a model before setting thinking effort");
  if (!model) return;
  const selected = catalog.models.find(entry => entry.id === model);
  if (!selected) throw new Error("Choose a model from this agent's available options");
  if (effort && !selected.reasoningEfforts?.includes(effort)) throw new Error("This model does not support the selected thinking effort");
}
