import type { ModelOption } from "../core/types.ts";
import { builtinProviders } from "./builtin.ts";
import {
  fetchModelList,
  fetchOpenRouterModelCatalog,
  loadCachedModelCatalog,
  loadCachedModelList,
  openRouterMetadata,
  saveModelCatalog,
  saveModelList,
  type ModelCatalog,
  type ModelList,
} from "./catalog.ts";
import {
  applyConfigSources,
  interpolate,
  isCommand,
  loadConfigSources,
  resolveConfigValue,
  type ConfigSource,
  type Env,
} from "./config.ts";
import { ProviderError } from "./errors.ts";
import { formatModelRef, parseModelRef } from "./model-ref.ts";
import type { ModelSpec, ProviderCompat, ProviderSpec } from "./types.ts";

export interface ResolvedModel {
  provider: ProviderSpec;
  model: ModelSpec;
  /** The canonical reference. */
  ref: string;
}

export interface ProviderAuth {
  apiKey?: string;
  headers: Record<string, string>;
}

export interface RegistryOptions {
  cwd: string;
  env?: Env;
  /** Keys supplied at runtime, by provider ID; they win over configuration and environment. */
  keys?: Readonly<Record<string, string>>;
  /** Use these instead of reading configuration files. */
  sources?: readonly ConfigSource[];
}

function detectedCompat(provider: ProviderSpec): ProviderCompat {
  let host = "";
  try { host = new URL(provider.baseUrl).hostname; } catch { /* reported when the request fails */ }
  if (provider.api === "openai-completions") {
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai")
      ? { reasoningFormat: "openrouter", openRouterRouting: true, cacheControl: "openrouter-auto", streamUsage: true }
      : { reasoningFormat: "openai", openRouterRouting: false, cacheControl: "none", streamUsage: true };
  }
  if (provider.api === "anthropic-messages") {
    // Beta fields that Anthropic's own API accepts; proxies and cloud platforms may reject them.
    const first = host === "api.anthropic.com";
    return { thinkingBindingControls: first, eagerToolStreaming: first };
  }
  return {};
}

/**
 * Every provider Jive can reach: the built-ins, changed or extended by
 * `~/.config/jive/models.json` and then the project's `.jive/models.json`.
 */
export class ProviderRegistry {
  readonly diagnostics: string[];
  /** The configured default model reference, if any. */
  readonly configuredDefault?: string;
  readonly namingModel?: string | false;
  readonly #providers: Map<string, ProviderSpec>;
  readonly #env: Env;
  readonly #keys: Readonly<Record<string, string>>;
  #openRouterCatalog?: ModelCatalog;
  readonly #lists = new Map<string, ModelList>();

  constructor(options: RegistryOptions) {
    const diagnostics: string[] = [];
    this.#env = options.env ?? process.env;
    this.#keys = options.keys ?? {};
    const sources = options.sources ?? loadConfigSources(options.cwd, this.#env, diagnostics);
    const providers = applyConfigSources(builtinProviders(), sources, diagnostics);
    this.#providers = new Map(providers.map((provider) => [provider.id, provider]));
    for (const source of sources) {
      if (source.config.defaultModel !== undefined) this.configuredDefault = source.config.defaultModel;
      if (source.config.namingModel !== undefined) this.namingModel = source.config.namingModel;
    }
    for (const [label, ref] of [["defaultModel", this.configuredDefault], ["namingModel", this.namingModel]] as const) {
      if (typeof ref === "string" && !this.#providers.has(parseModelRef(ref).provider)) {
        diagnostics.push(`${label} ${JSON.stringify(ref)} names an unknown provider "${parseModelRef(ref).provider}".`);
      }
    }
    this.diagnostics = diagnostics;
  }

  providers(): ProviderSpec[] {
    return [...this.#providers.values()];
  }

  provider(id: string): ProviderSpec | undefined {
    return this.#providers.get(id);
  }

  canonical(ref: string): string {
    const parsed = parseModelRef(ref.trim());
    return formatModelRef(parsed.provider, parsed.model);
  }

  resolve(ref: string): ResolvedModel {
    const parsed = parseModelRef(ref.trim());
    const provider = this.#providers.get(parsed.provider);
    if (!provider) {
      const known = [...this.#providers.keys()].join(", ");
      throw new ProviderError(`Unknown provider "${parsed.provider}" in model ${JSON.stringify(ref)}. Known providers: ${known}.`);
    }
    if (!parsed.model) throw new ProviderError(`Model ${JSON.stringify(ref)} has no model ID after the provider.`);
    const listed = provider.models.find((model) => model.id === parsed.model);
    const model: ModelSpec = { ...provider.modelDefaults, ...listed, id: parsed.model };
    if (provider.catalog === "openrouter") {
      // The catalog is authoritative; curated names and declared metadata are fallbacks for it.
      const live = openRouterMetadata(this.#openRouterCatalog, parsed.model);
      if (live.name) model.name = live.name;
      if (live.contextLength !== undefined && listed?.contextWindow === undefined) model.contextWindow = live.contextLength;
      if (live.reasoningEfforts !== undefined && listed?.reasoningEfforts === undefined) model.reasoningEfforts = live.reasoningEfforts;
      if (live.reasoningDefault !== undefined && listed?.reasoningDefault === undefined) model.reasoningDefault = live.reasoningDefault;
      if (live.reasoningMandatory !== undefined && listed?.reasoningMandatory === undefined) model.reasoningMandatory = live.reasoningMandatory;
    }
    return { provider, model, ref: formatModelRef(provider.id, parsed.model) };
  }

  /** Dialect flags for one model: detected, then provider configuration, then model configuration. */
  compat(provider: ProviderSpec, model: ModelSpec): ProviderCompat {
    return { ...detectedCompat(provider), ...provider.compat, ...model.compat };
  }

  /** Whether a request could authenticate, without running any configured command. */
  hasCredentials(providerOrRef: string): boolean {
    const provider = this.#providers.get(providerOrRef) ?? this.#providers.get(parseModelRef(providerOrRef).provider);
    if (!provider) return false;
    if (provider.keyless || this.#keys[provider.id]) return true;
    if (provider.apiKey !== undefined) {
      if (isCommand(provider.apiKey)) return provider.allowCommands;
      const { value, missing } = interpolate(provider.apiKey, this.#env);
      if (value && missing.length === 0) return true;
    }
    return provider.apiKeyEnv.some((name) => Boolean(this.#env[name]));
  }

  /**
   * Whether to reach out to a provider unprompted. A built-in local server such as Ollama needs no
   * key, but is only assumed to be running once the user has configured it.
   */
  #inUse(provider: ProviderSpec): boolean {
    if (!this.hasCredentials(provider.id)) return false;
    return !provider.keyless || provider.sources.some((source) => source !== "built-in");
  }

  /** How to name the missing credential, for an error the user can act on. */
  missingCredentialsMessage(provider: ProviderSpec): string {
    const options = [
      ...(provider.apiKeyEnv.length ? [`set ${provider.apiKeyEnv.join(" or ")}`] : []),
      `add "apiKey" for "${provider.id}" in ~/.config/jive/models.json`,
    ];
    return `${provider.name} API key is missing. ${options.join(", or ").replace(/^./, (first) => first.toUpperCase())}, then restart or start a new session.`;
  }

  /** The key and headers for one request. Runtime keys win, then configuration, then environment. */
  async resolveAuth(provider: ProviderSpec, signal?: AbortSignal): Promise<ProviderAuth> {
    const context = { env: this.#env, allowCommands: provider.allowCommands, ...(signal ? { signal } : {}) };
    const headers: Record<string, string> = {};
    try {
      for (const [name, value] of Object.entries(provider.headers)) {
        headers[name] = await resolveConfigValue(value, { ...context, what: `Header ${name} for ${provider.name}` });
      }
      let apiKey: string | undefined = this.#keys[provider.id];
      let unset: string[] = [];
      if (!apiKey && provider.apiKey !== undefined) {
        // A key that names an unset variable steps aside for the provider's environment variables.
        unset = isCommand(provider.apiKey) ? [] : interpolate(provider.apiKey, this.#env).missing;
        if (!unset.length) apiKey = await resolveConfigValue(provider.apiKey, { ...context, what: `The API key for ${provider.name}` });
      }
      apiKey ||= provider.apiKeyEnv.map((name) => this.#env[name]).find(Boolean);
      if (!apiKey && !provider.keyless) {
        throw new Error(unset.length
          ? `The API key for ${provider.name} needs ${unset.map((name) => `$${name}`).join(", ")}, which ${unset.length === 1 ? "is" : "are"} not set.`
          : this.missingCredentialsMessage(provider));
      }
      return { ...(apiKey ? { apiKey } : {}), headers };
    } catch (error) {
      signal?.throwIfAborted();
      throw new ProviderError(error instanceof Error ? error.message : String(error), { cause: error, providerName: provider.name });
    }
  }

  /** The model chosen when nothing else chooses: configuration, then the first provider with credentials. */
  defaultModel(): string | undefined {
    if (this.configuredDefault) return this.canonical(this.configuredDefault);
    for (const provider of this.#providers.values()) {
      const model = provider.defaultModel ?? provider.models[0]?.id;
      if (model && this.#inUse(provider)) return formatModelRef(provider.id, model);
    }
    return undefined;
  }

  /**
   * Picker entries: every listed model of every provider, then `include` (such as the
   * selected model) when no provider lists it. Providers without credentials are marked.
   */
  modelOptions(include: readonly string[] = []): ModelOption[] {
    const options: ModelOption[] = [];
    const seen = new Set<string>();
    const add = (provider: ProviderSpec, id: string) => {
      const ref = formatModelRef(provider.id, id);
      if (seen.has(ref)) return;
      seen.add(ref);
      const { model } = this.resolve(ref);
      options.push({
        id: ref,
        name: model.name ?? id,
        provider: provider.id,
        providerName: provider.name,
        available: this.hasCredentials(provider.id),
        ...(model.contextWindow !== undefined ? { contextLength: model.contextWindow } : {}),
        ...(model.reasoningEfforts !== undefined ? { reasoningEfforts: model.reasoningEfforts } : {}),
        ...(model.reasoningDefault !== undefined ? { reasoningDefault: model.reasoningDefault } : {}),
        ...(model.reasoningMandatory !== undefined ? { reasoningMandatory: model.reasoningMandatory } : {}),
      });
    };
    for (const provider of this.#providers.values()) {
      for (const model of provider.models) add(provider, model.id);
      for (const id of this.#lists.get(provider.id)?.ids ?? []) add(provider, id);
    }
    for (const ref of include) {
      if (!ref) continue;
      const parsed = parseModelRef(ref);
      const provider = this.#providers.get(parsed.provider);
      if (provider && parsed.model) add(provider, parsed.model);
      else if (!seen.has(ref)) {
        seen.add(ref);
        options.push({ id: ref, name: ref, available: false });
      }
    }
    return options;
  }

  get openRouterCatalog(): ModelCatalog | undefined {
    return this.#openRouterCatalog;
  }

  useOpenRouterCatalog(catalog: ModelCatalog): void {
    this.#openRouterCatalog = catalog;
  }

  /** Cached catalogs from an earlier refresh; never touches the network. */
  async loadCachedCatalogs(cwd: string): Promise<void> {
    this.#openRouterCatalog = await loadCachedModelCatalog(cwd) ?? this.#openRouterCatalog;
    for (const provider of this.#providers.values()) {
      if (provider.catalog !== "list") continue;
      const list = await loadCachedModelList(cwd, provider.id);
      if (list) this.#lists.set(provider.id, list);
    }
  }

  /**
   * Fetches live model metadata for providers that publish it and caches it under `.jev`.
   * Providers without credentials are skipped unless named. Returns one message per failure.
   */
  async refreshCatalogs(cwd: string, options: { providers?: readonly string[]; signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {}): Promise<string[]> {
    const failures: string[] = [];
    const targets = [...this.#providers.values()].filter((provider) =>
      provider.catalog && (options.providers ? options.providers.includes(provider.id) : provider.catalog === "openrouter" || this.#inUse(provider)));
    await Promise.all(targets.map(async (provider) => {
      try {
        const auth = this.hasCredentials(provider.id) ? await this.resolveAuth(provider, options.signal) : { headers: {} };
        if (provider.catalog === "openrouter") {
          // The provider's own endpoint: a relocated `openrouter` must not send its key to openrouter.ai.
          const catalog = await fetchOpenRouterModelCatalog({
            ...auth,
            endpoint: `${provider.baseUrl.replace(/\/+$/, "")}/models?supported_parameters=tools`,
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
          });
          await saveModelCatalog(cwd, catalog);
          this.#openRouterCatalog = catalog;
        } else {
          const list = await fetchModelList({
            baseUrl: provider.baseUrl, providerName: provider.name, ...auth,
            ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.signal ? { signal: options.signal } : {}),
          });
          await saveModelList(cwd, provider.id, list);
          this.#lists.set(provider.id, list);
        }
      } catch (error) {
        options.signal?.throwIfAborted();
        failures.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    return failures;
  }
}
