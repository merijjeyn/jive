import type { JevAdapter, JevRequest, JevResponse } from "../core/types";
import { DEFAULT_JEV_MODEL } from "../core/runtime-contract.ts";
import { appendFile } from "node:fs/promises";

async function recordAttempt(type: "attempt" | "retry"): Promise<void> {
  const path = process.env.JEV_METRICS_FILE;
  if (!path) return;
  // Telemetry is deliberately best-effort and contains no request, response, model, URL, or token.
  try { await appendFile(path, JSON.stringify({ time: Date.now(), type }) + "\n", "utf8"); } catch { /* metrics must never affect evaluation */ }
}

export function validateQuestions(questions: Record<string, any>): void {
  if (!questions || Array.isArray(questions) || typeof questions !== "object" || !Object.keys(questions).length) throw new Error("Jev requires a nonempty question map");
  for (const [id, q] of Object.entries(questions)) {
    if (!q || !["choice", "score", "noul"].includes(q.type) || q.instructions == null) throw new Error(`Invalid Jev question ${id}: type and instructions are required`);
    if (q.type === "choice" && (!q.criteria || Array.isArray(q.criteria) || Object.keys(q.criteria).length < 2 || Object.keys(q.criteria).length > 255)) throw new Error(`${id}: choice requires 2–255 options`);
    if (q.type === "score" && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10)) throw new Error(`${id}: score requires 2–10 levels`);
  }
}
/** A Jev answer the engine refused. `payload` is the raw response so the rejection stays inspectable. */
export class JevAnswerError extends Error {
  constructor(message: string, readonly payload: unknown) { super(message); this.name = "JevAnswerError"; }
}

/**
 * Jev reports probabilities rounded to two decimals. Over N options the rounded values can drift
 * from 1 by up to N * 0.005, so the check tolerates that drift and renormalizes in place; anything
 * beyond it is a genuinely broken distribution.
 */
export function distributionTolerance(optionCount: number): number { return optionCount * .005 + 1e-6; }

export function validateAnswer(request: JevRequest, response: JevResponse): void {
  const reject = (message: string): never => { throw new JevAnswerError(message, response); };
  if (!response?.answers || typeof response.model !== "string") reject("Malformed Jev response");
  const keys = Object.keys(request.questions);
  if (Object.keys(response.answers).length !== keys.length) reject("Jev returned a different question set");
  for (const id of keys) {
    const q = request.questions[id] as any, a = response.answers[id];
    if (!a || a.type !== q.type) reject(`Jev answer type mismatch for ${id}`);
    const probability = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
    if (q.type === "noul") { if (!probability(a.noul)) reject(`Invalid probability for ${id}`); continue; }
    if (!probability(a.confidence) || !a.probabilities || !Object.values(a.probabilities).every(probability)) reject(`Invalid distribution for ${id}`);
    const expected = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_: unknown, index: number) => String(index));
    if (Object.keys(a.probabilities).length !== expected.length || expected.some((key: string) => !Object.hasOwn(a.probabilities, key))) reject(`Incomplete distribution for ${id}`);
    let values = Object.values(a.probabilities) as number[];
    const sum = values.reduce((total, v) => total + v, 0);
    if (Math.abs(sum - 1) > distributionTolerance(values.length)) reject(`Unnormalized distribution for ${id} (sum ${sum.toFixed(4)}): ${JSON.stringify(a.probabilities)}`);
    if (sum > 0 && sum !== 1) {
      for (const key of Object.keys(a.probabilities)) a.probabilities[key] = a.probabilities[key] / sum;
      values = Object.values(a.probabilities) as number[];
    }
    if (q.type === "choice" && (!Object.hasOwn(q.criteria, a.choice) || a.probabilities[a.choice] < Math.max(...values) - 1e-8)) reject(`Invalid selected choice for ${id}`);
    if (q.type === "score" && (typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < 0 || a.score > q.criteria.length - 1)) reject(`Invalid score for ${id}`);
  }
}
export class JevClient implements JevAdapter {
  constructor(private options: { apiKey?: string; model?: string; baseUrl?: string; fetch?: typeof fetch; retries?: number } = {}) {}
  async evaluate(request: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    validateQuestions(request.questions);
    const apiKey = this.options.apiKey ?? process.env.JEV_API_TOKEN ?? process.env.TYPESAFE_API_KEY;
    if (!apiKey) throw new Error("Set JEV_API_TOKEN in .env to execute Jev nodes");
    const model = request.model ?? this.options.model ?? process.env.JEV_MODEL ?? DEFAULT_JEV_MODEL;
    // Jev samples: a malformed answer or an upstream 5xx usually clears on the next attempt.
    const attempts = 1 + (this.options.retries ?? 1);
    for (let attempt = 1; ; attempt++) {
      try {
        await recordAttempt("attempt");
        return await this.#call(request, model, apiKey, signal);
      } catch (error) {
        const retryable = error instanceof JevAnswerError || (error instanceof JevHttpError && error.status >= 500);
        if (!retryable || attempt >= attempts || signal?.aborted) throw error;
        await recordAttempt("retry");
      }
    }
  }
  async #call(request: JevRequest, model: string, apiKey: string, signal?: AbortSignal): Promise<JevResponse> {
    const localSignal = AbortSignal.timeout(60000);
    const requestSignal = signal ? AbortSignal.any([signal, localSignal]) : localSignal;
    const response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl ?? process.env.JEV_BASE_URL ?? "https://api.typesafe.ai/v1"}/systemone`, {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, model }), signal: requestSignal,
    });
    if (!response.ok) throw new JevHttpError(response.status, (await response.text()).slice(0, 1500));
    const data = await response.json() as JevResponse;
    validateAnswer(request, data);
    return data;
  }
}
export class JevHttpError extends Error {
  constructor(readonly status: number, body: string) { super(`Jev HTTP ${status}: ${body}`); this.name = "JevHttpError"; }
}
