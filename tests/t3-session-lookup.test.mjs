import assert from "node:assert/strict";
import test from "node:test";
import { findMatches, lookupSession, MAX_MESSAGES } from "../skills/t3-fork-session/scripts/find-session.mjs";

const project = { id: "p", title: "Scandy", workspaceRoot: "/scandy" };
const thread = (id, title, extra = {}) => ({ id, title, projectId: "p", modelSelection: { instanceId: "claude_eol", model: "opus" }, ...extra });
function fixture(extra = {}) {
  const session = thread("old", "camera_c344_sol", { worktreePath: "/scandy-worker", branch: "fix", archivedAt: "2026-10-01", ...extra });
  const calls = [];
  const history = { messages: [{ messageId: "final", role: "assistant", kind: "final", text: "See /tmp/result" }], view: "final", messageLimit: 3, page: { hasMore: true, beforeMessageId: "older" } };
  return {
    session, calls, history,
    client: {
      rpc(tag) { assert.equal(tag, "orchestration.getArchivedShellSnapshot"); return { promise: Promise.resolve({ projects: [project], threads: [session] }) }; },
      async http(route) {
        calls.push(route);
        if (route === "/api/orchestration/shell") return { projects: [project], threads: [] };
        assert.ok(route.startsWith("/api/orchestration/threads/old/messages?"));
        return history;
      },
    },
  };
}

test("exact names win and duplicate names need disambiguation across projects", () => {
  const shell = { projects: [project], threads: [thread("idle", "AUTONOMY611_OPUS"), thread("busy", "AUTONOMY611_OPUS", { session: { status: "running" } }), thread("other", "AUTONOMY611_OPUS extra")] };
  assert.deepEqual(findMatches(shell, { name: "autonomy611_opus" }).threads.map((t) => t.id), ["idle", "busy"]);
  assert.equal(findMatches(shell, { threadId: "idle" }).threads.length, 1);
  assert.equal(findMatches(shell, { name: "611" }).threads.length, 3);
  assert.equal(findMatches(shell, { name: "611", project: "missing" }).threads.length, 0);
  assert.equal(findMatches(shell, { name: "611", project: "/scandy" }).threads.length, 3);
  assert.throws(() => findMatches(shell, { name: " " }), /Provide/);
});

test("archived session reads request three final/prompt messages and reserve space for metadata", async () => {
  const data = fixture();
  const result = await lookupSession(data.client, { name: "camera_c344_sol" });
  assert.equal(result.session.workingDirectory, "/scandy-worker");
  assert.equal(result.messages[0].text, "See /tmp/result");
  assert.equal(result.page.beforeMessageId, "older");
  assert.equal(data.calls.length, 2);
  const query = new URL(data.calls[1], "http://t3").searchParams;
  assert.equal(query.get("messageLimit"), "3");
  assert.equal(query.get("view"), "final");
  assert.ok(Number(query.get("maxChars")) < 16000);
  assert.equal(result.checkpoints, undefined);
  assert.equal(result.matches, undefined);
  data.calls.length = 0;
  await lookupSession(data.client, { name: "camera", list: true });
  assert.equal(data.calls.length, 1);
});

test("callers select 1, 3, 5 or 15 messages and opt into intermediate content explicitly", async () => {
  for (const messages of [1, 3, 5, 15]) {
    const data = fixture();
    await lookupSession(data.client, { threadId: "old", messages, includeIntermediate: messages === 5, before: "older" });
    const query = new URL(data.calls[1], "http://t3").searchParams;
    assert.equal(query.get("messageLimit"), String(messages));
    assert.equal(query.get("view"), messages === 5 ? "all" : "final");
    assert.equal(query.get("beforeMessageId"), "older");
  }
});

test("specific-message continuation never downloads an unbounded thread snapshot", async () => {
  const data = fixture();
  await lookupSession(data.client, { threadId: "old", messageId: "final", offset: 123 });
  const query = new URL(data.calls[1], "http://t3").searchParams;
  assert.equal(query.get("messageId"), "final");
  assert.equal(query.get("offset"), "123");
  assert.equal(query.get("view"), "final");
});

test("invalid counts and size budgets fail before reading", async () => {
  for (const messages of [0, 16, 1.5, Infinity]) {
    const data = fixture();
    await assert.rejects(lookupSession(data.client, { name: "camera", messages }), /--messages/);
    assert.deepEqual(data.calls, []);
  }
  for (const chars of [0, 2047, 64001, Infinity]) {
    const data = fixture();
    await assert.rejects(lookupSession(data.client, { name: "camera", chars }), /--chars/);
    assert.deepEqual(data.calls, []);
  }
  await assert.rejects(lookupSession(fixture().client, { name: "camera", offset: 1 }), /--message-id/);
});

test("large candidate sets and metadata fit the complete response budget", async () => {
  const data = fixture();
  data.client.http = async () => ({ projects: [project], threads: Array.from({length: 2000}, (_, i) => thread(String(i), "same", {session: {lastError: "x".repeat(20000)}})) });
  data.client.rpc = () => ({promise: Promise.resolve({projects: [], threads: []})});
  const result = await lookupSession(data.client, { name: "same", chars: 2048 });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.totalMatches, 2000);
  assert.ok(result.matches.length <= MAX_MESSAGES);
  assert.equal(result.hasMoreMatches, true);
  assert.ok(JSON.stringify(result).length + 1 <= 2048);
  const large = fixture({title: "long".repeat(1000), worktreePath: "/".repeat(20000), session: {lastError: "error".repeat(10000)}});
  const output = await lookupSession(large.client, { threadId: "old", chars: 2048 });
  assert.ok(JSON.stringify(output).length + 1 <= 2048);
});

test("an oversized server response is rejected instead of entering agent context", async () => {
  const data = fixture();
  data.history.messages[0].text = "x".repeat(20000);
  await assert.rejects(lookupSession(data.client, { name: "camera", chars: 2048 }), /exceeded/);
});

test("missing server support produces an upgrade error without a full-history fallback", async () => {
  const data = fixture();
  const http = data.client.http;
  data.client.http = async (route) => { if (route.includes("/messages?")) throw new Error("HTTP 404"); return http(route); };
  await assert.rejects(lookupSession(data.client, { name: "camera" }), /boundedSessionHistory/);
});
