/** Bare IDs belong to OpenRouter, whose IDs always contain a slash before any colon. */
export const DEFAULT_PROVIDER = "openrouter";

export interface ModelRef {
  provider: string;
  model: string;
}

/** `provider:model`, split at the first colon; anything else is an OpenRouter ID. */
export function parseModelRef(ref: string): ModelRef {
  const colon = ref.indexOf(":");
  if (colon > 0) {
    const provider = ref.slice(0, colon);
    if (!provider.includes("/")) return { provider, model: ref.slice(colon + 1) };
  }
  return { provider: DEFAULT_PROVIDER, model: ref };
}

export function formatModelRef(provider: string, model: string): string {
  return provider === DEFAULT_PROVIDER ? model : `${provider}:${model}`;
}
