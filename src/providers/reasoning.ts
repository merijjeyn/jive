import { createHash } from "node:crypto";

import type { PlannerMessage } from "../session/types.ts";
import type { ApiKind } from "./types.ts";

/**
 * Explicit thinking budgets for Anthropic models that take one, by effort level. OpenRouter
 * turns reasoning.effort into a percentage of max_tokens for these models, and the planner
 * never sets max_tokens there, so even "low" became a five-figure budget that Claude used
 * freely. A fixed budget makes each level mean something.
 */
export const ANTHROPIC_REASONING_BUDGETS: Readonly<Record<string, number>> = {
  minimal: 1024,
  low: 2048,
  medium: 6144,
  high: 12288,
  xhigh: 24576,
  max: 32768,
};

/**
 * Whether a stored assistant message was produced by this exact model over this protocol.
 * Opaque reasoning state is replayed only then: it is provider state, not conversation.
 * Messages from before provider support carry no `api` and came from OpenRouter.
 */
export function producedBy(message: PlannerMessage, ref: string, api: ApiKind): boolean {
  if (message.model && message.model !== ref) return false;
  return (message.api ?? "openai-completions") === api;
}

/**
 * A tool-call ID reduced to the characters and length strict APIs accept. Safe IDs pass through
 * unchanged; any other gets a hash of the original, so two IDs never collapse into one.
 */
export function portableCallId(id: string): string {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return id;
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 10);
  return `${id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 53)}_${hash}`;
}
