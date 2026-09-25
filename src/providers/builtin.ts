import type { ModelSpec, ProviderSpec } from "./types.ts";

/** OpenRouter model IDs shown in the picker before the live catalog has been fetched. */
export const CURATED_MODEL_IDS = [
  "anthropic/claude-fable-5.1",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-5",
  "openai/gpt-6-astra",
  "openai/gpt-6-sol",
  "openai/gpt-5.6-sol",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.8-flash",
  "moonshotai/kimi-k3",
  "meta/muse-spark-1.3",
  "deepseek/deepseek-v4-pro-0813",
  "z-ai/glm-5.3",
] as const;

export type CuratedModelId = (typeof CURATED_MODEL_IDS)[number];

const CURATED_NAMES: Record<CuratedModelId, string> = {
  "anthropic/claude-fable-5.1": "Anthropic: Claude Fable 5.1",
  "anthropic/claude-opus-5.5": "Anthropic: Claude Opus 5.5",
  "anthropic/claude-sonnet-5": "Anthropic: Claude Sonnet 5",
  "openai/gpt-6-astra": "OpenAI: GPT-6 Astra",
  "openai/gpt-6-sol": "OpenAI: GPT-6 Sol",
  "openai/gpt-5.6-sol": "OpenAI: GPT-5.6 Sol",
  "google/gemini-3.1-pro-preview": "Google: Gemini 3.1 Pro Preview",
  "google/gemini-3.8-flash": "Google: Gemini 3.8 Flash",
  "moonshotai/kimi-k3": "MoonshotAI: Kimi K3",
  "meta/muse-spark-1.3": "Meta: Muse Spark 1.3",
  "deepseek/deepseek-v4-pro-0813": "DeepSeek: DeepSeek V4 Pro 0813",
  "z-ai/glm-5.3": "Z.ai: GLM 5.3",
};

/** The planner model when nothing else chooses one and OpenRouter is configured. */
export const OPENROUTER_DEFAULT_MODEL = "google/gemini-3.8-flash";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function claude(id: string, name: string, extra: Partial<ModelSpec> = {}): ModelSpec {
  // Fable 5.1 and Opus 5.5 always think; effort is their only control.
  return { id, name, contextWindow: 1_000_000, maxTokens: 64_000, thinking: "adaptive", reasoningEfforts: EFFORTS, reasoningMandatory: true, ...extra };
}

function gpt(id: string, name: string, efforts: string[]): ModelSpec {
  // Input above 272K tokens is billed at the long-context rate, so compaction keeps below it.
  return { id, name, contextWindow: 272_000, maxTokens: 128_000, reasoningEfforts: efforts, reasoningMandatory: !efforts.includes("none") };
}

type BuiltinProvider = Omit<ProviderSpec, "compat" | "headers" | "allowCommands" | "sources" | "keyless" | "modelDefaults"> &
  Partial<Pick<ProviderSpec, "compat" | "keyless" | "modelDefaults">>;

const BUILTIN: BuiltinProvider[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: ["OPENROUTER_API_KEY"],
    models: CURATED_MODEL_IDS.map((id) => ({ id, name: CURATED_NAMES[id] })),
    // Effort support comes from OpenRouter's catalog; unknown until it has been fetched.
    modelDefaults: {},
    catalog: "openrouter",
    defaultModel: OPENROUTER_DEFAULT_MODEL,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    models: [
      claude("claude-fable-5-1", "Claude Fable 5.1"),
      claude("claude-opus-5-5", "Claude Opus 5.5"),
      claude("claude-sonnet-5", "Claude Sonnet 5", { reasoningEfforts: ["none", ...EFFORTS], reasoningMandatory: false }),
      claude("claude-haiku-4-5", "Claude Haiku 4.5", {
        contextWindow: 200_000,
        thinking: "budget",
        reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        reasoningMandatory: false,
      }),
    ],
    modelDefaults: { contextWindow: 1_000_000, maxTokens: 64_000, thinking: "adaptive", reasoningEfforts: EFFORTS },
    defaultModel: "claude-sonnet-5",
  },
  {
    id: "openai",
    name: "OpenAI",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    models: [
      gpt("gpt-6-astra", "GPT-6 Astra", EFFORTS),
      gpt("gpt-6-sol", "GPT-6 Sol", ["none", ...EFFORTS]),
      gpt("gpt-5.6-sol", "GPT-5.6 Sol", ["none", ...EFFORTS]),
    ],
    defaultModel: "gpt-6-sol",
  },
  {
    id: "google",
    name: "Google",
    api: "openai-completions",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    models: [
      { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", contextWindow: 1_048_576, reasoningEfforts: ["low", "medium", "high"], reasoningMandatory: true },
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", contextWindow: 1_048_576, reasoningEfforts: ["low", "medium", "high"], reasoningMandatory: true },
    ],
    defaultModel: "gemini-3.8-flash",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: ["DEEPSEEK_API_KEY"],
    models: [],
    catalog: "list",
  },
  {
    id: "groq",
    name: "Groq",
    api: "openai-completions",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: ["GROQ_API_KEY"],
    models: [],
    catalog: "list",
  },
  {
    id: "ollama",
    name: "Ollama",
    api: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: [],
    keyless: true,
    models: [],
    catalog: "list",
  },
];

/** Fresh copies of the built-in providers; configuration may change them. */
export function builtinProviders(): ProviderSpec[] {
  return BUILTIN.map((provider) => ({
    ...structuredClone(provider),
    compat: provider.compat ?? {},
    headers: {},
    keyless: provider.keyless ?? false,
    // Models the provider does not list get no effort control unless configured otherwise.
    modelDefaults: provider.modelDefaults ?? { reasoningEfforts: [] },
    allowCommands: true,
    sources: ["built-in"],
  }));
}
