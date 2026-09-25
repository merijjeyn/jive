import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FALLBACK_SESSION_NAMES,
  fallbackSessionName,
  listSessions,
  normalizeSessionName,
  ModelSessionNamer,
  resolveSessionReference,
  SESSION_NAMING_MODEL,
  SessionStore,
} from "../src/session/index.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function cwd(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "jive-session-discovery-"));
  directories.push(path);
  return path;
}

describe("session discovery and names", () => {
  test("fallback names come only from the fixed list and are stable", () => {
    const name = fallbackSessionName("018f-test-session");
    expect(FALLBACK_SESSION_NAMES).toContain(name as typeof FALLBACK_SESSION_NAMES[number]);
    expect(fallbackSessionName("018f-test-session")).toBe(name);
    expect(normalizeSessionName("  **Fix auth refresh**\nignored  ")).toBe("Fix auth refresh");
  });

  test("lists derived metadata newest first and resolves exact or unique-prefix IDs", async () => {
    const root = await cwd();
    const older = new SessionStore({ cwd: root, sessionId: "alpha-111" });
    await older.initialize();
    await older.append("model.selected", { model: "old/model" });
    await older.appendMessage({ role: "user", content: "old request" });
    await Bun.sleep(2);
    const newer = new SessionStore({ cwd: root, sessionId: "beta-222" });
    await newer.initialize();
    await newer.append("model.selected", { model: "new/model" });
    await newer.append("effort.selected", { effort: "high" });
    await newer.appendMessage({ role: "user", content: "new request" });
    await newer.setName("Repair session picker", "generated", SESSION_NAMING_MODEL);

    const sessions = await listSessions(root);
    expect(sessions.map((session) => session.id)).toEqual(["beta-222", "alpha-111"]);
    expect(sessions[0]).toMatchObject({
      name: "Repair session picker",
      nameSource: "generated",
      model: "new/model",
      effort: "high",
      messageCount: 1,
    });
    expect(sessions[1]!.name).toBe(fallbackSessionName("alpha-111"));
    expect(await resolveSessionReference(root, "beta")).toBe("beta-222");
    expect(await resolveSessionReference(root, "alpha-111")).toBe("alpha-111");

    const another = new SessionStore({ cwd: root, sessionId: "alpha-222" });
    await another.initialize();
    await expect(resolveSessionReference(root, "alpha")).rejects.toThrow("ambiguous");
    await expect(resolveSessionReference(root, "missing")).rejects.toThrow("not found");
    expect(await new SessionStore({ cwd: root, sessionId: "missing" }).exists()).toBe(false);
  });

  test("existing-only stores never turn a missing resume target into a new session", async () => {
    const root = await cwd();
    const store = new SessionStore({ cwd: root, sessionId: "does-not-exist", existingOnly: true });
    await expect(store.initialize()).rejects.toThrow("does not exist");
    expect(await store.exists()).toBe(false);
  });

  test("a queued generated title cannot overwrite a manual name", async () => {
    const root = await cwd();
    const store = new SessionStore({ cwd: root, sessionId: "manual-name-wins" });
    await store.initialize();
    await Promise.all([
      store.setName("Chosen by the user", "manual"),
      store.setName("Generated in the background", "generated", SESSION_NAMING_MODEL),
    ]);
    expect(store.displayName()).toBe("Chosen by the user");
    expect(store.events.filter((event) => event.type === "session.named")).toHaveLength(1);
  });
});

describe("Session naming", () => {
  test("asks the naming model with light effort and retries three times after the first failure", async () => {
    const requests: Array<Record<string, any>> = [];
    const namer = new ModelSessionNamer({
      model: "google/gemma-3-27b-it",
      retries: 3,
      retryDelayMs: 0,
      effortFor: () => "none",
      complete: async (request) => {
        requests.push(request);
        if (requests.length < 4) throw new Error("unavailable");
        return { message: { role: "assistant", content: JSON.stringify({ name: "Fix Resume Picker" }) } };
      },
    });
    await expect(namer.generate({ sessionId: "s", model: "anthropic:claude-opus-5-5", userMessage: "resume sessions" }))
      .resolves.toBe("Fix Resume Picker");
    expect(requests).toHaveLength(4);
    expect(requests[0]!.model).toBe("google/gemma-3-27b-it");
    expect(requests[0]!.effort).toBe("none");
    // The namer owns its retries; the client must not multiply them.
    expect(requests[0]!.retry).toEqual({ attempts: 1 });
  });

  test("falls back to the session's own model and accepts a bare title", async () => {
    const models: string[] = [];
    const namer = new ModelSessionNamer({
      retries: 0,
      complete: async (request) => {
        models.push(request.model);
        return { message: { role: "assistant", content: "Trace Flaky Upload Test" } };
      },
    });
    await expect(namer.generate({ sessionId: "s", model: "corp:qwen3-coder", userMessage: "why does upload flake" }))
      .resolves.toBe("Trace Flaky Upload Test");
    expect(models).toEqual(["corp:qwen3-coder"]);
  });

  test("keeps failure cosmetic after all four attempts", async () => {
    let requests = 0;
    const namer = new ModelSessionNamer({
      model: "google/gemma-3-27b-it",
      retries: 3,
      retryDelayMs: 0,
      complete: async () => { requests += 1; throw new Error("request failed"); },
    });
    await expect(namer.generate({ sessionId: "s", userMessage: "anything" })).rejects.toThrow("failed");
    expect(requests).toBe(4);
  });
});

