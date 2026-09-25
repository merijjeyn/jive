import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import Ajv from "ajv";
import { API_KINDS, type ModelSpec, type ProviderCompat, type ProviderSpec } from "./types.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export interface ModelConfig extends Omit<ModelSpec, "compat"> {
  compat?: ProviderCompat;
}

export interface ProviderConfig {
  name?: string;
  api?: ProviderSpec["api"];
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string | string[];
  keyless?: boolean;
  headers?: Record<string, string>;
  compat?: ProviderCompat;
  models?: ModelConfig[];
  defaultModel?: string;
  catalog?: "list" | "none";
}

export interface ModelsConfig {
  /** Global file only: directories whose `.jive/models.json` may be used, subdirectories included. */
  trustedProjects?: string[];
  /** A model reference used when neither `--model` nor the session chooses one. */
  defaultModel?: string;
  /** A model reference for naming sessions, or false to keep generated fallback names. */
  namingModel?: string | false;
  providers?: Record<string, ProviderConfig>;
}

/** One configuration file. Only trusted files may run `!command` values. */
export interface ConfigSource {
  path: string;
  trusted: boolean;
  config: ModelsConfig;
}

const compatSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reasoningFormat: { enum: ["openrouter", "openai", "chat-template", "none"] },
    openRouterRouting: { type: "boolean" },
    cacheControl: { enum: ["openrouter-auto", "none"] },
    streamUsage: { type: "boolean" },
    thinkingBindingControls: { type: "boolean" },
    eagerToolStreaming: { type: "boolean" },
  },
} as const;

const modelSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1 },
    name: { type: "string" },
    contextWindow: { type: "integer", minimum: 1 },
    maxTokens: { type: "integer", minimum: 1 },
    reasoningEfforts: { type: "array", items: { enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] } },
    reasoningDefault: { type: "string" },
    reasoningMandatory: { type: "boolean" },
    thinking: { enum: ["adaptive", "budget", "none"] },
    compat: compatSchema,
  },
} as const;

const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    $schema: { type: "string" },
    trustedProjects: { type: "array", items: { type: "string", minLength: 1 } },
    defaultModel: { type: "string", minLength: 1 },
    namingModel: { anyOf: [{ type: "string", minLength: 1 }, { const: false }] },
    providers: {
      type: "object",
      propertyNames: { pattern: "^[a-z0-9][a-z0-9_-]*$" },
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          api: { enum: [...API_KINDS] },
          baseUrl: { type: "string", pattern: "^https?://" },
          apiKey: { type: "string" },
          apiKeyEnv: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
          keyless: { type: "boolean" },
          headers: { type: "object", additionalProperties: { type: "string" } },
          compat: compatSchema,
          models: { type: "array", items: modelSchema },
          defaultModel: { type: "string", minLength: 1 },
          catalog: { enum: ["list", "none"] },
        },
      },
    },
  },
} as const;

const validate = new Ajv({ allErrors: true }).compile(configSchema);

/** `~/.config/jive`, or `$JIVE_CONFIG_DIR`, or `$XDG_CONFIG_HOME/jive`. */
export function globalConfigDirectory(env: Env = process.env): string {
  if (env.JIVE_CONFIG_DIR) return resolve(env.JIVE_CONFIG_DIR);
  return join(env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(homedir(), ".config"), "jive");
}

export function configPaths(cwd: string, env: Env = process.env): { global: string; project: string } {
  return {
    global: join(globalConfigDirectory(env), "models.json"),
    project: join(resolve(cwd), ".jive", "models.json"),
  };
}

/** JSON with `//` and `/* *\/` comments, which people use to annotate provider entries. */
export function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      result += char;
      if (char === "\\") result += text[++index] ?? "";
      else if (char === "\"") inString = false;
    } else if (char === "\"") {
      inString = true;
      result += char;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      result += "\n";
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 1;
    } else result += char;
  }
  return result;
}

/** Parses and validates one file; problems become diagnostics and the file is skipped. */
export function readConfigFile(path: string, diagnostics: string[]): ModelsConfig | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
  } catch (error) {
    diagnostics.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (!validate(value)) {
    for (const issue of validate.errors ?? []) {
      const where = issue.instancePath ? issue.instancePath.slice(1).replaceAll("/", ".") : "(root)";
      const allowed = issue.params && "allowedValues" in issue.params ? ` (${(issue.params.allowedValues as unknown[]).join(", ")})` : "";
      const extra = issue.params && "additionalProperty" in issue.params ? ` "${String(issue.params.additionalProperty)}"` : "";
      diagnostics.push(`${path}: ${where} ${issue.message}${extra}${allowed}`);
    }
    return undefined;
  }
  return value as ModelsConfig;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** Whether `directory` is one of `roots` or inside one. */
export function withinTrusted(directory: string, roots: readonly string[]): boolean {
  const target = resolve(directory);
  return roots.some((root) => {
    const base = resolve(expandHome(root));
    return target === base || target.startsWith(`${base}${sep}`);
  });
}

/**
 * The global file, then the project's file when the global file trusts the project. A repository
 * can otherwise point a provider at its own host, or name the user's secrets, and receive them.
 */
export function loadConfigSources(cwd: string, env: Env = process.env, diagnostics: string[] = []): ConfigSource[] {
  const paths = configPaths(cwd, env);
  const sources: ConfigSource[] = [];
  const global = readConfigFile(paths.global, diagnostics);
  if (global) sources.push({ path: paths.global, trusted: true, config: global });
  if (paths.project !== paths.global && existsSync(paths.project)) {
    if (withinTrusted(cwd, global?.trustedProjects ?? [])) {
      const project = readConfigFile(paths.project, diagnostics);
      if (project) sources.push({ path: paths.project, trusted: true, config: project });
    } else {
      diagnostics.push(`${paths.project} was not loaded. To use it, add ${JSON.stringify(resolve(cwd))} to "trustedProjects" in ${paths.global}.`);
    }
  }
  return sources;
}

function mergeModels(existing: ModelSpec[], additions: ModelConfig[]): ModelSpec[] {
  const merged = existing.map((model) => ({ ...model }));
  for (const addition of additions) {
    const index = merged.findIndex((model) => model.id === addition.id);
    if (index < 0) merged.push({ ...addition });
    else merged[index] = { ...merged[index]!, ...addition, compat: { ...merged[index]!.compat, ...addition.compat } };
  }
  return merged;
}

/**
 * Applies configuration files in order over the built-in providers. A file may add a provider
 * (it then needs `api` and `baseUrl`) or change any field of an existing one; models merge by ID.
 */
export function applyConfigSources(
  builtins: readonly ProviderSpec[],
  sources: readonly ConfigSource[],
  diagnostics: string[],
): ProviderSpec[] {
  const providers = new Map(builtins.map((provider) => [provider.id, structuredClone(provider)]));
  for (const source of sources) {
    for (const [id, entry] of Object.entries(source.config.providers ?? {})) {
      const current = providers.get(id);
      if (!current && (!entry.api || !entry.baseUrl)) {
        diagnostics.push(`${source.path}: provider "${id}" needs "api" and "baseUrl" (it is not built in).`);
        continue;
      }
      if (!source.trusted && [entry.apiKey, ...Object.values(entry.headers ?? {})].some((value) => value?.startsWith("!"))) {
        diagnostics.push(`${source.path}: provider "${id}" uses a !command value; only trusted configuration may run commands, so it will not run.`);
      }
      const base: ProviderSpec = current ?? {
        id,
        name: id,
        api: entry.api!,
        baseUrl: entry.baseUrl!,
        apiKeyEnv: [],
        keyless: false,
        headers: {},
        compat: {},
        models: [],
        // A configured endpoint's models are described by its configuration, not guessed at.
        modelDefaults: { reasoningEfforts: [] },
        allowCommands: true,
        sources: [],
      };
      const apiKeyEnv = entry.apiKeyEnv === undefined ? base.apiKeyEnv : [entry.apiKeyEnv].flat();
      providers.set(id, {
        ...base,
        ...(entry.name !== undefined ? { name: entry.name } : {}),
        ...(entry.api !== undefined ? { api: entry.api } : {}),
        ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
        ...(entry.apiKey !== undefined ? { apiKey: entry.apiKey } : {}),
        ...(entry.keyless !== undefined ? { keyless: entry.keyless } : {}),
        ...(entry.defaultModel !== undefined ? { defaultModel: entry.defaultModel } : {}),
        ...(entry.catalog === "none" ? { catalog: undefined } : entry.catalog ? { catalog: entry.catalog } : {}),
        apiKeyEnv,
        headers: { ...base.headers, ...entry.headers },
        compat: { ...base.compat, ...entry.compat },
        models: mergeModels(base.models, entry.models ?? []),
        allowCommands: base.allowCommands && source.trusted,
        sources: [...new Set([...base.sources, source.path])],
      });
    }
  }
  return [...providers.values()];
}

const VARIABLE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** `$NAME` and `${NAME}` from the environment; `$$` is a literal dollar sign. */
export function interpolate(value: string, env: Env): { value: string; missing: string[] } {
  const missing: string[] = [];
  const result = value.replace(VARIABLE, (match, braced?: string, bare?: string) => {
    if (match === "$$") return "$";
    const name = braced ?? bare!;
    const found = env[name];
    if (found === undefined || found === "") missing.push(name);
    return found ?? "";
  });
  return { value: result, missing };
}

export function isCommand(value: string): boolean {
  return value.startsWith("!");
}

/** Runs a `!command` value through the shell and returns its trimmed output. */
export function runCommand(command: string, env: Env, signal?: AbortSignal): Promise<string> {
  return new Promise((done, fail) => {
    execFile("/bin/sh", ["-c", command], { timeout: 10_000, env: { ...process.env, ...env } as NodeJS.ProcessEnv, ...(signal ? { signal } : {}) }, (error, stdout) => {
      if (error) { fail(new Error(`Command \`${command}\` failed: ${error.message}`)); return; }
      const output = String(stdout).trim();
      if (!output) { fail(new Error(`Command \`${command}\` printed nothing.`)); return; }
      done(output);
    });
  });
}

/** A configured value: a literal, `$NAME` interpolation, or `!command` output. */
export async function resolveConfigValue(value: string, options: { env: Env; allowCommands: boolean; signal?: AbortSignal; what: string }): Promise<string> {
  if (isCommand(value)) {
    if (!options.allowCommands) throw new Error(`${options.what} uses a !command, which project configuration may not run.`);
    return runCommand(value.slice(1), options.env, options.signal);
  }
  const { value: resolved, missing } = interpolate(value, options.env);
  if (missing.length) throw new Error(`${options.what} needs ${missing.map((name) => `$${name}`).join(", ")}, which ${missing.length === 1 ? "is" : "are"} not set.`);
  return resolved;
}
