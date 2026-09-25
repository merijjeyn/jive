import { normalizeSessionName } from "./names.ts";
import type { PlannerMessage } from "./types.ts";

/** Used through OpenRouter when it is configured and no naming model is. */
export const SESSION_NAMING_MODEL = "google/gemma-3-27b-it";
export const SESSION_NAMING_RETRIES = 3;
const SESSION_NAME_MAX_LENGTH = 48;

export interface SessionNamingInput {
  sessionId: string;
  /** The session's planner model, used when the namer has no model of its own. */
  model?: string;
  userMessage: string;
  assistantMessage?: string;
}

export type SessionNameGenerator = (
  input: SessionNamingInput,
  signal?: AbortSignal,
) => Promise<string>;

/** The shape of ProviderClient.complete that naming needs. */
export type NamingCompletion = (request: {
  model: string;
  sessionId: string;
  messages: PlannerMessage[];
  effort?: string;
  signal?: AbortSignal;
  retry?: { attempts: number };
}) => Promise<{ message: PlannerMessage }>;

export interface ModelSessionNamerOptions {
  complete: NamingCompletion;
  /** A model reference; each session's own model when unset. */
  model?: string;
  /** The lightest effort a model accepts, if it takes one. */
  effortFor?: (model: string) => string | undefined;
  /** Retries after the initial request. */
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Session naming was aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** A model may answer with the requested JSON object or with the bare title. */
function nameFromContent(content: string | null): string {
  if (!content) return "";
  const trimmed = content.trim();
  try {
    const parsed = JSON.parse(trimmed.replace(/^```(?:json)?\s*|\s*```$/g, "")) as { name?: unknown };
    if (typeof parsed.name === "string") return parsed.name;
  } catch {
    // A validated plain-text title is safe.
  }
  return trimmed;
}

/** Small, isolated request used only for cosmetic session naming. */
export class ModelSessionNamer {
  readonly model?: string;
  readonly retries: number;
  readonly retryDelayMs: number;
  readonly timeoutMs: number;
  readonly #complete: NamingCompletion;
  readonly #effortFor?: (model: string) => string | undefined;

  constructor(options: ModelSessionNamerOptions) {
    this.#complete = options.complete;
    this.#effortFor = options.effortFor;
    if (options.model) this.model = options.model;
    this.retries = options.retries ?? SESSION_NAMING_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  generate: SessionNameGenerator = async (input, signal) => {
    const model = this.model ?? input.model;
    if (!model) throw new Error("No model is available for naming sessions.");
    const effort = this.#effortFor?.(model);
    const messages: PlannerMessage[] = [
      {
        role: "system",
        content: [
          "Name this coding-agent session.",
          "Return a concrete 3-7 word title, at most 48 characters, as JSON: {\"name\": \"...\"}.",
          "Preserve useful issue IDs, filenames, and commands.",
          "Do not use quotes, Markdown, trailing punctuation, or generic words such as Session or Task.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `First request:\n${input.userMessage.slice(0, 4_000)}`,
          input.assistantMessage
            ? `\nFirst outcome:\n${input.assistantMessage.slice(0, 2_000)}`
            : "",
        ].join(""),
      },
    ];
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      signal?.throwIfAborted();
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const { message } = await this.#complete({
          model,
          sessionId: input.sessionId,
          messages,
          ...(effort ? { effort } : {}),
          signal: requestSignal,
          retry: { attempts: 1 },
        });
        const name = normalizeSessionName(nameFromContent(message.content), SESSION_NAME_MAX_LENGTH);
        if (!name) throw new Error("The naming model returned an empty session name.");
        return name;
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error;
        if (attempt < this.retries) {
          await wait(this.retryDelayMs * 2 ** attempt, signal);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}
