import assert from "node:assert/strict";
import test from "node:test";
import { findMatches, readPage, lookupSession } from "../skills/t3-fork-session/scripts/find-session.mjs";

const project = { id: "p", title: "Scandy", workspaceRoot: "/scandy" };
const thread = (id, title, extra = {}) => ({ id, title, projectId: "p", modelSelection: { instanceId: "claude_eol", model: "opus" }, ...extra });

test("exact name wins over substring; duplicates need disambiguation, including idle and running copies", () => {
  const shell = { projects: [project], threads: [thread("idle", "AUTONOMY611_OPUS"), thread("busy", "AUTONOMY611_OPUS", { session: { status: "running" } }), thread("other", "AUTONOMY611_OPUS extra")] };
  assert.deepEqual(findMatches(shell, { name: "autonomy611_opus" }).threads.map((t) => t.id), ["idle", "busy"]);
  assert.equal(findMatches(shell, { threadId: "idle" }).threads.length, 1);
  assert.equal(findMatches(shell, { name: "611" }).threads.length, 3);
  assert.equal(findMatches(shell, { name: "611", project: "missing" }).threads.length, 0);
  assert.equal(findMatches(shell, { name: "611", project: "/scandy" }).threads.length, 3);
  assert.throws(() => findMatches(shell, { name: " " }), /Provide/);
});

test("reading includes archived sessions, correct worktree, and recent replies without dispatching", async () => {
  const t = thread("old", "camera_c344_sol", { worktreePath: "/scandy-worker", branch: "fix", archivedAt: "2026-10-01", messages: [{ id: "m", role: "assistant", text: "See /tmp/result" }], checkpoints: [] });
  const calls = [];
  const client = {
    rpc(tag) { assert.equal(tag, "orchestration.getArchivedShellSnapshot"); return { promise: Promise.resolve({ projects: [project], threads: [t] }) }; },
    async http(route) {
      calls.push(route);
      if (route === "/api/orchestration/shell") return { projects: [project], threads: [] };
      assert.equal(route, "/api/orchestration/threads/old?turnLimit=3");
      return { thread: t, page: { hasMore: true, beforeCursor: "older" } };
    },
  };
  const result = await lookupSession(client, { name: "camera_c344_sol" });
  assert.equal(result.session.workingDirectory, "/scandy-worker");
  assert.equal(result.messages[0].text, "See /tmp/result");
  assert.equal(result.page.beforeCursor, "older");
  assert.equal(calls.length, 2);
  calls.length = 0;
  await lookupSession(client, { name: "camera", list: true });
  assert.equal(calls.length, 1);
});

test("ambiguous and missing names never fetch an arbitrary conversation", async () => {
  const client = {
    rpc() { return { promise: Promise.resolve({ projects: [], threads: [] }) }; },
    async http(route) { assert.equal(route, "/api/orchestration/shell"); return { projects: [project], threads: [thread("one", "same"), thread("two", "same")] }; },
  };
  assert.equal((await lookupSession(client, { name: "same" })).status, "ambiguous");
  assert.equal((await lookupSession(client, { name: "absent" })).status, "not_found");
});

test("bounded output exposes continuation and omitted IDs without dropping reasoning into replies", () => {
  const snapshot = { thread: { messages: [{ id: "u", role: "user", text: "task" }, { id: "reason", role: "reasoning", text: "hidden" }, { id: "a", role: "assistant", text: "abcdefghijkl" }] } };
  const first = readPage(snapshot, { chars: 5 });
  assert.equal(first.messages[0].text, "abcde");
  assert.equal(first.messages[0].nextOffset, 5);
  assert.deepEqual(first.omittedMessages.map((m) => m.messageId), ["u"]);
  const next = readPage(snapshot, { messageId: "a", offset: 5, chars: 20 });
  assert.equal(next.messages[0].text, "fghijkl");
  assert.equal(next.messages[0].nextOffset, null);
  assert.throws(() => readPage(snapshot, { messageId: "missing" }), /not found/);
});
