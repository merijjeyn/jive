export class ProviderError extends Error {
  readonly status?: number;
  readonly details?: unknown;
  /** Set when the same request could plausibly succeed on a second attempt. */
  readonly retryable: boolean;
  /** A delay the provider asked for, in milliseconds. */
  readonly retryAfterMs?: number;
  /** Display name of the provider that failed, e.g. "OpenRouter". */
  readonly providerName?: string;

  constructor(message: string, options: {
    status?: number;
    details?: unknown;
    cause?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
    providerName?: string;
  } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.status = options.status;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.providerName = options.providerName;
  }
}

/** Statuses that describe congestion or a provider hiccup rather than a bad request. */
export const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
/** Wording providers use for the same conditions when they arrive inside the stream. */
export const TRANSIENT_TEXT = /rate.?limit|temporarily|overloaded|capacity|timed? ?out|timeout|try again|unavailable|upstream|internal server error|server.?error|connection (?:reset|closed)|socket hang up|network|fetch failed/i;
const MAX_HONOURED_RETRY_AFTER_MS = 30_000;

export interface RetryPolicy {
  /** Total attempts including the first; 1 disables retrying. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { attempts: 4, baseDelayMs: 800, maxDelayMs: 8000 };

export interface RetryNotice {
  attempt: number;
  attempts: number;
  delayMs: number;
  /** Two or three words for a status line, e.g. "rate limited". */
  reason: string;
  error: ProviderError;
}

/** A mid-stream error payload: the provider's own code decides, and its wording otherwise. */
export function transientPayload(payload: unknown, message: string): boolean {
  const code = payload && typeof payload === "object" ? (payload as Record<string, unknown>).code : undefined;
  const numeric = typeof code === "number" ? code : typeof code === "string" && /^\d+$/.test(code) ? Number(code) : undefined;
  if (numeric !== undefined) return TRANSIENT_STATUS.has(numeric);
  return TRANSIENT_TEXT.test(message) || (typeof code === "string" && TRANSIENT_TEXT.test(code));
}

/** `Retry-After` in seconds or as an HTTP date. */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function retryReason(error: ProviderError): string {
  if (error.status === 429 || /rate.?limit/i.test(error.message)) return "rate limited";
  if (error.status !== undefined && error.status >= 500) return `provider error ${error.status}`;
  if (/Could not reach/.test(error.message)) return "network error";
  if (/stream/i.test(error.message)) return "stream interrupted";
  return "transient error";
}

/** How long to wait before attempt `attempt + 1`, or undefined when the error must stand. */
export function retryDelay(error: unknown, attempt: number, policy: RetryPolicy): number | undefined {
  if (!(error instanceof ProviderError) || !error.retryable) return undefined;
  if (attempt >= policy.attempts) return undefined;
  const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  // Jitter keeps several sessions from returning to a busy provider in lockstep.
  const jittered = Math.round(backoff * (0.7 + Math.random() * 0.6));
  const asked = Math.min(error.retryAfterMs ?? 0, MAX_HONOURED_RETRY_AFTER_MS);
  return Math.max(asked, jittered);
}

export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); done(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** An HTTP failure: the body's own error message, bounded, with retry facts from the status. */
export async function responseError(response: Response, providerName: string): Promise<ProviderError> {
  const raw = await response.text();
  let details: unknown = raw.slice(0, 4_000);
  try { details = JSON.parse(raw); } catch { /* keep bounded text */ }
  const remoteMessage = details && typeof details === "object" && "error" in details
    ? JSON.stringify((details as Record<string, unknown>).error)
    : raw.slice(0, 500);
  return new ProviderError(
    `${providerName} request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""}): ${remoteMessage || "empty response"}`,
    {
      status: response.status,
      details,
      retryable: TRANSIENT_STATUS.has(response.status),
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      providerName,
    },
  );
}
