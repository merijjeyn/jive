import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { ModelOption } from "../core/types.ts";
import { CURATED_MODEL_IDS, builtinProviders } from "./builtin.ts";

export interface OpenRouterCatalogModel {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    supported_efforts?: string[] | null;
    default_effort?: string;
  };
}

export interface ModelCatalog {
  fetchedAt: string;
  models: OpenRouterCatalogModel[];
}

export interface FetchModelCatalogOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  apiKey?: string;
  headers?: Record<string, string>;
  endpoint?: string;
}

/** OpenRouter's gateway-wide effort vocabulary, highest effort first. */
export const GATEWAY_REASONING_EFFORTS = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
] as const;

export function modelCatalogCachePath(cwd: string): string {
  return join(resolve(cwd), ".jev", "openrouter-models.json");
}

export async function loadCachedModelCatalog(cwd: string): Promise<ModelCatalog | undefined> {
  try {
    const parsed = JSON.parse(await readFile(modelCatalogCachePath(cwd), "utf8")) as ModelCatalog;
    if (!Array.isArray(parsed.models) || typeof parsed.fetchedAt !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function saveModelCatalog(cwd: string, catalog: ModelCatalog): Promise<void> {
  const path = modelCatalogCachePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
}

export async function fetchOpenRouterModelCatalog(
  options: FetchModelCatalogOptions = {},
): Promise<ModelCatalog> {
  const transport = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? "https://openrouter.ai/api/v1/models?supported_parameters=tools";
  const response = await transport(endpoint, {
    method: "GET",
    headers: { ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}), ...options.headers },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`OpenRouter model catalog request failed (${response.status}).`);
  }
  const body = await response.json() as { data?: OpenRouterCatalogModel[] };
  if (!Array.isArray(body.data)) throw new Error("OpenRouter returned an invalid model catalog.");
  return {
    fetchedAt: new Date().toISOString(),
    models: body.data.filter(
      (model) =>
        typeof model.id === "string" &&
        Array.isArray(model.supported_parameters) &&
        model.supported_parameters.includes("tools"),
    ),
  };
}

/** What OpenRouter's catalog says about one model; nothing when it does not list it. */
export function openRouterMetadata(catalog: ModelCatalog | undefined, id: string): Partial<ModelOption> {
  const live = catalog?.models.find((model) => model.id === id);
  if (!live) return {};
  const reasoning = live.reasoning;
  let reasoningEfforts: string[];
  if (reasoning?.supported_efforts === null) {
    reasoningEfforts = [...GATEWAY_REASONING_EFFORTS];
  } else if (Array.isArray(reasoning?.supported_efforts)) {
    reasoningEfforts = reasoning.supported_efforts.filter(
      (effort): effort is string => typeof effort === "string",
    );
  } else reasoningEfforts = [];
  if (reasoning?.mandatory) reasoningEfforts = reasoningEfforts.filter((effort) => effort !== "none");
  return {
    ...(live.name ? { name: live.name } : {}),
    ...(typeof live.context_length === "number" ? { contextLength: live.context_length } : {}),
    reasoningEfforts,
    ...(typeof reasoning?.default_effort === "string" ? { reasoningDefault: reasoning.default_effort } : {}),
    ...(typeof reasoning?.mandatory === "boolean" ? { reasoningMandatory: reasoning.mandatory } : {}),
  };
}

/** The curated OpenRouter models plus any custom IDs, with catalog metadata where known. */
export function mergeModelOptions(
  catalog?: ModelCatalog,
  customIds: readonly string[] = [],
): ModelOption[] {
  const openRouter = builtinProviders().find((provider) => provider.id === "openrouter")!;
  const ids = [...new Set([...CURATED_MODEL_IDS, ...customIds])];
  return ids.map((id) => ({
    id,
    name: openRouter.models.find((model) => model.id === id)?.name ?? id,
    provider: "openrouter",
    providerName: openRouter.name,
    ...openRouterMetadata(catalog, id),
  }));
}

/** Model IDs an OpenAI-compatible server lists at `GET {baseUrl}/models`. */
export interface ModelList {
  fetchedAt: string;
  ids: string[];
}

export function modelListCachePath(cwd: string, providerId: string): string {
  return join(resolve(cwd), ".jev", "provider-models", `${providerId}.json`);
}

export async function loadCachedModelList(cwd: string, providerId: string): Promise<ModelList | undefined> {
  try {
    const parsed = JSON.parse(await readFile(modelListCachePath(cwd, providerId), "utf8")) as ModelList;
    if (!Array.isArray(parsed.ids) || typeof parsed.fetchedAt !== "string") return undefined;
    return { fetchedAt: parsed.fetchedAt, ids: parsed.ids.filter((id): id is string => typeof id === "string") };
  } catch {
    return undefined;
  }
}

export async function saveModelList(cwd: string, providerId: string, list: ModelList): Promise<void> {
  const path = modelListCachePath(cwd, providerId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(list, null, 2)}\n`, "utf8");
}

export async function fetchModelList(options: {
  baseUrl: string;
  providerName: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<ModelList> {
  const transport = options.fetch ?? globalThis.fetch;
  const response = await transport(`${options.baseUrl.replace(/\/+$/, "")}/models`, {
    method: "GET",
    headers: {
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      ...options.headers,
    },
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`${options.providerName} model list request failed (${response.status}).`);
  const body = await response.json() as { data?: Array<{ id?: unknown }> };
  if (!Array.isArray(body.data)) throw new Error(`${options.providerName} returned an invalid model list.`);
  const ids = body.data.map((model) => model.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  return { fetchedAt: new Date().toISOString(), ids: [...new Set(ids)].sort() };
}
