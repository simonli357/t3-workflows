import assert from "node:assert/strict";
import test from "node:test";
import { findMatches } from "../skills/t3-fork-session/scripts/find-session.mjs";
import { sessionActivity } from "../skills/t3-fork-session/scripts/capacity-load.mjs";
import { T3Client, usageLimit } from "../skills/t3-fork-session/scripts/fork-session.mjs";
import { forkCommand, normalizeShell, normalizeThread, protocolOf, translateCommand } from "../skills/t3-fork-session/scripts/protocol.mjs";
import { ACCESS_LEVELS, LinkedClient, accessScopes, linkMatches } from "../skills/t3-fork-session/scripts/peers.mjs";

const selection = { instanceId: "codex", model: "gpt", options: [{ id: "reasoningEffort", value: "high" }] };
const shellThread = (extra) => ({ id: "t1", projectId: "p1", title: "Camera", modelSelection: selection, providerInstanceId: "codex", runtimeMode: "full-access",
  interactionMode: "default", branch: null, worktreePath: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T01:00:00Z", archivedAt: null,
  deletedAt: null, settledOverride: null, settledAt: null, status: "idle", activeRunId: null, latestRunId: null, pendingRuntimeRequest: null, pendingBackgroundTasks: [], ...extra });

test("servers announce protocol 2 in their environment descriptor", () => {
  assert.equal(protocolOf({ orchestrationProtocolVersion: 2 }), 2);
  assert.equal(protocolOf({ orchestrationProtocolVersion: 1 }), 1);
  assert.equal(protocolOf({}), 1);
  assert.equal(protocolOf(undefined), 1);
});

test("a V2 shell reads as the V1 shell the scripts expect", () => {
  const shell = normalizeShell({ projects: [{ id: "p1", title: "Cam", workspaceRoot: "/cam" }], archivedThreads: [], threads: [
    shellThread({}),
    shellThread({ id: "t2", status: "running", activeRunId: "r2", latestRunId: "r2", latestRunStartedAt: "2026-10-01T02:00:00Z" }),
    shellThread({ id: "t3", status: "waiting", activeRunId: "r3", latestRunId: "r3", pendingRuntimeRequest: { id: "q", kind: "command_execution_approval" } }),
    shellThread({ id: "t4", status: "failed", latestRunId: "r4", latestRunCompletedAt: "2026-10-01T02:00:00Z", lastError: "You have hit your usage limit", usageLimitResetAt: "2026-10-02T00:00:00Z" }),
    shellThread({ id: "t5", settledOverride: "active", settledAt: "2026-09-01T00:00:00Z", pendingBackgroundTasks: [{ id: "b" }] }),
  ] });
  const [idle, running, waiting, limited, unsettled] = shell.threads;
  assert.equal(sessionActivity(idle), null);
  assert.deepEqual([running.session.status, running.session.activeTurnId, running.latestTurn.state, sessionActivity(running)], ["running", "r2", "running", "working"]);
  assert.equal(sessionActivity(waiting), "waiting");
  assert.deepEqual([limited.session.status, limited.latestTurn.state], ["error", "error"]);
  assert.match(limited.session.lastError, /usage limit/);
  assert.equal(usageLimit(limited, new Date("2026-10-01T12:00:00Z")).active, true);
  assert.equal(unsettled.settledAt, null);
  assert.equal(sessionActivity(unsettled), "backgroundOnly");
  assert.deepEqual(findMatches({ ...shell, threads: [limited] }, { name: "camera" }).threads.map((t) => t.id), ["t4"]);
});

test("a V2 thread detail carries its messages and the run an assignment started", () => {
  const thread = normalizeThread({ projection: {
    thread: { ...shellThread({}), pinnedAt: null },
    runs: [
      { id: "r1", ordinal: 1, status: "completed", userMessageId: "m1", providerInstanceId: "codex", requestedAt: "a", startedAt: "b", completedAt: "c" },
      { id: "r2", ordinal: 2, status: "running", userMessageId: "m3", providerInstanceId: "codex", requestedAt: "d", startedAt: null },
    ],
    messages: [{ id: "m1", role: "user", text: "hi", createdAt: "a", runId: "r1" }, { id: "s", role: "system", text: "x", createdAt: "a", runId: null }, { id: "m2", role: "assistant", text: "yo", createdAt: "b", runId: "r1" }],
    providerSessions: [],
  } });
  assert.deepEqual(thread.messages.map((m) => m.id), ["m1", "m2"]);
  assert.deepEqual([thread.session.status, thread.session.activeTurnId, thread.latestTurn.turnId, thread.latestTurn.userMessageId], ["running", "r2", "r2", "m3"]);
  assert.equal(thread.runs.find((run) => run.userMessageId === "m1").status, "completed");
});

test("V1 dispatch bodies become V2 commands with retry-stable IDs", () => {
  const create = translateCommand({ type: "thread.create", commandId: "worker:1:create", threadId: "t", projectId: "p", title: "W", modelSelection: selection,
    runtimeMode: "approval-required", interactionMode: "default", branch: null, worktreePath: null, createdAt: "now" });
  assert.deepEqual(create.map((c) => [c.type, c.commandId, c.createdBy, c.creationSource]), [["thread.create", "worker:1:create", "agent", "mcp"]]);
  const configure = translateCommand({ type: "thread.meta.update", commandId: "worker:1:configure", threadId: "t", title: "W", modelSelection: selection });
  assert.deepEqual(configure.map((c) => [c.type, c.commandId]), [["thread.metadata.update", "worker:1:configure:title"], ["thread.model-selection.set", "worker:1:configure:model"]]);
  const [start] = translateCommand({ type: "thread.turn.start", commandId: "worker:1:start", threadId: "t", message: { messageId: "worker:1:task", role: "user", text: "go", attachments: [] }, modelSelection: selection });
  assert.deepEqual([start.type, start.messageId, start.text, start.dispatchMode], ["message.dispatch", "worker:1:task", "go", { type: "start_immediately" }]);
  assert.deepEqual(translateCommand({ type: "thread.settle", commandId: "s", threadId: "t" }), [{ type: "thread.settle", commandId: "s", threadId: "t" }]);
  assert.throws(() => translateCommand({ type: "thread.meta.update", commandId: "c", threadId: "t", title: "base", isBase: true }), /baseSessions/);
  assert.throws(() => translateCommand({ type: "thread.checkpoint.revert", commandId: "c", threadId: "t" }), /cannot send/);
  assert.deepEqual(forkCommand({ sourceThreadId: "a", threadId: "b" }).sourcePoint, { type: "latest_stable" });
});

test("a V2 client maps the V1 routes the scripts call without a connection of its own", async () => {
  const client = new T3Client({ server: "http://127.0.0.1:1", token: "t", timeout: 1 });
  client.protocol = 2;
  const calls = [];
  client.rawHttp = async (route) => { calls.push(route); return { projects: [], archivedThreads: [], threads: [shellThread({})] }; };
  client.rpc = (tag, payload) => { calls.push([tag, payload.type]); return { promise: Promise.resolve({ sequence: 4 }) }; };
  assert.deepEqual((await client.http("/api/orchestration/shell")).threads.map((t) => t.session.status), ["ready"]);
  assert.deepEqual(await client.dispatch({ type: "thread.meta.update", commandId: "c", threadId: "t", title: "N", modelSelection: selection }), { sequence: 4 });
  assert.deepEqual(await client.fork({ sourceThreadId: "a", threadId: "b" }), { threadId: "b" });
  assert.deepEqual(calls, ["/api/orchestration/shell", ["orchestration.dispatchCommand", "thread.metadata.update"], ["orchestration.dispatchCommand", "thread.model-selection.set"], ["orchestration.dispatchCommand", "thread.fork"]]);
});

test("a pairing code carries only the scopes its access level needs", () => {
  assert.deepEqual(accessScopes("read-only"), ["orchestration:read"]);
  assert.deepEqual(accessScopes("auto"), ["orchestration:read", "orchestration:operate"]);
  assert.equal(accessScopes("full-access").length, 4);
  assert.equal(ACCESS_LEVELS.length, 5);
  assert.equal(linkMatches({ environmentId: "e1", label: "MyAlien" }, "myalien"), true);
  assert.equal(linkMatches({ environmentId: "e1", label: "MyAlien" }, "e1"), true);
  assert.equal(linkMatches({ environmentId: "e1", label: "MyAlien" }, "other"), false);
});

test("a linked environment's project resolves through the local project's repository", async () => {
  const client = new LinkedClient("alien", { timeout: 1 });
  client.link = { environmentId: "e2", label: "alien" };
  client.protocol = 2;
  const local = { projects: [{ id: "p1", title: "Cam", workspaceRoot: "/home/me/cam" }], threads: [] };
  client.rawHttp = async () => ({ projects: local.projects, threads: [], archivedThreads: [] });
  client.rpc = (tag, payload) => ({ promise: Promise.resolve({ placement: { hosts: [{ environmentId: "e2", projects: payload.request.projectId === "p1" ? [{ id: "remote-cam", title: "cam-checkout" }] : [] }] } }) });
  client.projectHint = "/home/me/cam";
  assert.deepEqual(await client.http("/api/orchestration/shell"), { projects: [{ id: "remote-cam", title: "cam-checkout", workspaceRoot: "/home/me/cam" }], threads: [] });
  client.projectHint = "Remote Name";
  assert.deepEqual((await client.http("/api/orchestration/shell")).projects, [{ id: "Remote Name", title: "Remote Name", workspaceRoot: "Remote Name" }]);
  await assert.rejects(client.http("/api/orchestration/threads/x"), /direct connection/);
  await assert.rejects(client.thread("x"), /t3_thread_organize/);
});
