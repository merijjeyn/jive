import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { ProviderClient, ProviderRegistry, parseRetryAfter, reasoningParameters, retryDelay, ProviderError, DEFAULT_RETRY_POLICY, type RetryNotice, type RetryPolicy } from "../src/providers/index";

/** A client for OpenRouter-shaped responses, with no configuration files involved. */
function openRouterClient(options: { fetch: typeof fetch; retry?: Partial<RetryPolicy> }) {
  return new ProviderClient({ registry: new ProviderRegistry({ cwd: tmpdir(), sources: [], keys: { openrouter: "test" } }), ...options });
}

function completion(finishReason?: string, tool = true) {
  const chunk = { choices: [{
    delta: tool ? { tool_calls: [{ index: 0, id: "call-1", function: {
      name: "execute_graph", arguments: JSON.stringify({ version: 1, nodes: {} }),
    } }] } : { reasoning: "Still thinking" },
    finish_reason: finishReason,
  }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
}

test("truncated or filtered completions cannot yield executable graphs even with valid JSON", async () => {
  for (const reason of ["length", "content_filter", "error", undefined]) {
    const client = openRouterClient({
      retry: { attempts: 1 }, fetch: (async () => completion(reason)) as unknown as typeof fetch,
    });
    await expect(client.complete({
      model: "test", sessionId: "test", messages: [],
      toolSchema: { name: "execute_graph", parameters: { type: "object" } },
    })).rejects.toThrow(/before the full tool call was accepted|did not confirm/);
  }
});

test("reasoning without an answer or tool call does not silently finish the task", async () => {
  const client = openRouterClient({
    retry: { attempts: 1 }, fetch: (async () => completion("stop", false)) as unknown as typeof fetch,
  });
  await expect(client.complete({ model: "test", sessionId: "test", messages: [], toolSchema: {} }))
    .rejects.toThrow("no answer or tool call");
});

test("Anthropic models get an explicit thinking budget per level; other models get the effort name", () => {
  expect(reasoningParameters("anthropic/claude-sonnet-5", "low")).toEqual({ max_tokens: 2048 });
  expect(reasoningParameters("anthropic/claude-sonnet-5", "medium")).toEqual({ max_tokens: 6144 });
  expect(reasoningParameters("anthropic/claude-sonnet-5", "max")).toEqual({ max_tokens: 32768 });
  expect(reasoningParameters("anthropic/claude-sonnet-5", "none")).toEqual({ enabled: false });
  expect(reasoningParameters("openai/gpt-5.6-sol", "low")).toEqual({ effort: "low" });
  expect(reasoningParameters("google/gemini-3.8-flash", "high")).toEqual({ effort: "high" });
  expect(reasoningParameters("anthropic/claude-sonnet-5", undefined)).toBeUndefined();
});

test("the request body carries the mapped reasoning object", async () => {
  const bodies: any[] = [];
  const client = openRouterClient({
    fetch: (async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return completion("stop"); }) as unknown as typeof fetch,
  });
  await client.complete({ model: "anthropic/claude-sonnet-5", sessionId: "t", messages: [], toolSchema: {}, effort: "low" }).catch(() => undefined);
  await client.complete({ model: "openai/gpt-5.6-sol", sessionId: "t", messages: [], toolSchema: {}, effort: "low" }).catch(() => undefined);
  await client.complete({ model: "openai/gpt-5.6-sol", sessionId: "t", messages: [], toolSchema: {} }).catch(() => undefined);
  expect(bodies[0].reasoning).toEqual({ max_tokens: 2048 });
  expect(bodies[1].reasoning).toEqual({ effort: "low" });
  expect(bodies[2]).not.toHaveProperty("reasoning");
});

// ---------------------------------------------------------------------------
// Retrying transient failures

/** The shape OpenRouter uses when a provider refuses mid-stream. */
function streamError(message: string, code?: number) {
  return new Response(`data: ${JSON.stringify({ error: { message, ...(code === undefined ? {} : { code }) } })}\n\n`);
}

const fast = { attempts: 4, baseDelayMs: 1, maxDelayMs: 2 };

test("a provider that is briefly rate-limited is retried until it answers", async () => {
  let attempts = 0;
  const notices: RetryNotice[] = [];
  const client = openRouterClient({
    retry: fast,
    fetch: (async () => {
      attempts += 1;
      return attempts < 3
        ? streamError("google/gemini-3.8-flash is temporarily rate-limited upstream. Please retry shortly", 429)
        : completion("stop");
    }) as unknown as typeof fetch,
  });
  const result = await client.complete({
    model: "google/gemini-3.8-flash", sessionId: "t", messages: [], toolSchema: {},
    onRetry: (notice) => notices.push(notice),
  });
  expect(attempts).toBe(3);
  expect(result.message.tool_calls).toHaveLength(1);
  expect(notices.map((notice) => notice.reason)).toEqual(["rate limited", "rate limited"]);
  expect(notices.map((notice) => notice.attempt)).toEqual([1, 2]);
});

test("a rejected request is reported at once, and a hopeless one stops after the last attempt", async () => {
  let attempts = 0;
  const rejecting = openRouterClient({
    retry: fast,
    fetch: (async () => { attempts += 1; return new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 400 }); }) as unknown as typeof fetch,
  });
  await expect(rejecting.complete({ model: "test", sessionId: "t", messages: [], toolSchema: {} })).rejects.toThrow("model not found");
  expect(attempts).toBe(1);

  let overloaded = 0;
  const failing = openRouterClient({
    retry: fast,
    fetch: (async () => { overloaded += 1; return new Response("busy", { status: 503 }); }) as unknown as typeof fetch,
  });
  await expect(failing.complete({ model: "test", sessionId: "t", messages: [], toolSchema: {} })).rejects.toThrow("503");
  expect(overloaded).toBe(fast.attempts);
});

test("once a delta has been handed to the caller the attempt cannot be replayed", async () => {
  let attempts = 0;
  const seen: string[] = [];
  const client = openRouterClient({
    retry: fast,
    fetch: (async () => {
      attempts += 1;
      // Text first, then a transient failure: replaying would repeat what is already on screen.
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Half an answer" } }] })}`,
        `data: ${JSON.stringify({ error: { message: "temporarily overloaded", code: 429 } })}`,
        "",
      ].join("\n\n"));
    }) as unknown as typeof fetch,
  });
  await expect(client.complete({
    model: "test", sessionId: "t", messages: [], toolSchema: {}, onContent: (delta) => seen.push(delta),
  })).rejects.toThrow("temporarily overloaded");
  expect(attempts).toBe(1);
  expect(seen).toEqual(["Half an answer"]);
});

test("an interrupted turn is not retried", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const client = openRouterClient({
    retry: { attempts: 4, baseDelayMs: 5000, maxDelayMs: 5000 },
    fetch: (async () => { attempts += 1; controller.abort(new Error("interrupted")); return streamError("temporarily unavailable", 503); }) as unknown as typeof fetch,
  });
  await expect(client.complete({ model: "test", sessionId: "t", messages: [], toolSchema: {}, signal: controller.signal }))
    .rejects.toThrow("interrupted");
  expect(attempts).toBe(1);
});

test("the wait honours Retry-After and grows between attempts", () => {
  expect(parseRetryAfter("2")).toBe(2000);
  expect(parseRetryAfter(null)).toBeUndefined();
  expect(parseRetryAfter("not a date")).toBeUndefined();
  const transient = new ProviderError("busy", { status: 503, retryable: true });
  const first = retryDelay(transient, 1, DEFAULT_RETRY_POLICY)!;
  const third = retryDelay(transient, 3, DEFAULT_RETRY_POLICY)!;
  expect(first).toBeGreaterThan(0);
  expect(third).toBeGreaterThan(first);
  expect(retryDelay(transient, DEFAULT_RETRY_POLICY.attempts, DEFAULT_RETRY_POLICY)).toBeUndefined();
  expect(retryDelay(new ProviderError("bad request", { status: 400 }), 1, DEFAULT_RETRY_POLICY)).toBeUndefined();
  const asked = new ProviderError("busy", { status: 429, retryable: true, retryAfterMs: 4000 });
  expect(retryDelay(asked, 1, DEFAULT_RETRY_POLICY)).toBeGreaterThanOrEqual(4000);
});
