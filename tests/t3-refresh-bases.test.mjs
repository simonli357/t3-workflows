import assert from "node:assert/strict";
import test from "node:test";
import { BASE_PROMPT, planRefresh, refreshBase } from "../skills/t3-fork-session/scripts/refresh-bases.mjs";

function fixture() {
  const old = { id: "old-base", title: "xl_base", projectId: "control", modelSelection: { instanceId: "claude_xinya", model: "claude-opus-5-5", options: [{ id: "effort", value: "xhigh" }] }, runtimeMode: "full-access", interactionMode: "default", branch: "main", worktreePath: null, latestTurn: { turnId: "old-turn", state: "completed" }, messages: [] };
  const worker = { ...structuredClone(old), id: "worker", title: "camera_c344_opus" };
  const shell = { projects: [{ id: "control", title: "SControl", workspaceRoot: "/control" }], threads: [old, worker] };
  const config = { providers: [{ instanceId: "claude_xinya", enabled: true, installed: true, models: [{ slug: "claude-opus-5-5", capabilities: { optionDescriptors: [{ id: "effort", type: "select", options: [{ id: "xhigh" }] }] } }] }] };
  const client = {
    commands: [], failTurn: false,
    async http() { return structuredClone(shell); },
    async thread(id) { return structuredClone(shell.threads.find((t) => t.id === id)); },
    async dispatch(command) {
      this.commands.push(command);
      if (command.type === "thread.create") shell.threads.push({ ...command, id: command.threadId, messages: [] });
      if (command.type === "thread.turn.start") shell.threads.find((t) => t.id === command.threadId).messages.push({ ...command.message, id: command.message.messageId });
      if (command.type === "thread.pin") shell.threads.find((t) => t.id === command.threadId).pinnedAt = new Date().toISOString();
      if (command.type === "thread.delete") shell.threads = shell.threads.filter((t) => t.id !== command.threadId);
      if (command.type === "thread.meta.update") shell.threads.find((t) => t.id === command.threadId).title = command.title;
    },
    async waitForTurn(plan) {
      if (this.failTurn) throw new Error("Provider unavailable");
      const thread = shell.threads.find((t) => t.id === plan.threadId);
      thread.latestTurn = { turnId: "new-turn", state: "completed" };
      thread.messages.push({ role: "assistant", text: "Project understood." });
      this.onCompleted?.();
    },
  };
  const plan = () => planRefresh(shell, config, { project: "/control", providers: ["XL"] })[0];
  return { shell, client, plan, old, worker };
}

test("refresh creates an independent base with the exact prompt and preserves existing forks", async () => {
  const f = fixture();
  const before = structuredClone(f.worker);
  const plan = f.plan();
  await refreshBase(f.client, plan);
  assert.deepEqual(f.client.commands.map((c) => c.type), ["thread.create", "thread.turn.start", "thread.pin", "thread.delete", "thread.meta.update"]);
  assert.equal(f.client.commands[1].message.text, "understand project");
  assert.equal(BASE_PROMPT, "understand project");
  assert.deepEqual(f.shell.threads.find((t) => t.id === before.id), before);
  assert.equal(f.shell.threads.find((t) => t.title === "xl_base").id, plan.threadId);
  assert.equal(f.shell.threads.some((t) => t.id === f.old.id), false);
  assert.ok(f.shell.threads.find((t) => t.id === plan.threadId).pinnedAt);
});

test("failed preparation retains old base and retry reuses the pending session and prompt", async () => {
  const f = fixture();
  f.client.failTurn = true;
  const plan = f.plan();
  await assert.rejects(refreshBase(f.client, plan), /Provider unavailable/);
  assert.ok(f.shell.threads.some((t) => t.id === f.old.id));
  f.client.failTurn = false;
  const retry = f.plan();
  assert.equal(retry.threadId, plan.threadId);
  await refreshBase(f.client, retry);
  assert.equal(f.client.commands.filter((c) => c.type === "thread.create").length, 1);
  assert.equal(f.client.commands.filter((c) => c.type === "thread.turn.start").length, 1);
});

test("a retry adopts a pending base whose prompt was answered in a turn resumed after a server restart", async () => {
  const f = fixture();
  f.client.failTurn = true;
  const plan = f.plan();
  await assert.rejects(refreshBase(f.client, plan), /Provider unavailable/);
  const pending = f.shell.threads.find((t) => t.id === plan.threadId);
  pending.latestTurn = { turnId: "resumed-turn", state: "completed" };
  pending.messages.push({ role: "assistant", text: "Repositories understood." });
  await refreshBase(f.client, f.plan());
  assert.equal(f.shell.threads.find((t) => t.title === "xl_base").id, plan.threadId);
  assert.equal(f.shell.threads.some((t) => t.id === f.old.id), false);
  assert.equal(f.client.commands.filter((c) => c.type === "thread.turn.start").length, 1);
});

test("busy or ambiguous bases stop preflight, and a newly used old base is not deleted", async () => {
  const f = fixture();
  f.old.latestTurn.state = "running";
  assert.throws(f.plan, /busy/);
  f.old.latestTurn.state = "completed";
  f.shell.threads.push({ ...f.old, id: "duplicate" });
  assert.throws(f.plan, /Duplicate/);
  f.shell.threads.pop();
  const plan = f.plan();
  f.client.onCompleted = () => { f.old.latestTurn.turnId = "a-new-user-turn"; };
  await assert.rejects(refreshBase(f.client, plan), /changed or became busy/);
  assert.equal(f.client.commands.some((c) => c.type === "thread.delete"), false);
});

test("a missing account base is created without deleting another account's session", async () => {
  const f = fixture();
  f.shell.threads = [f.worker];
  const plan = f.plan();
  assert.equal(plan.oldId, null);
  await refreshBase(f.client, plan);
  assert.equal(f.client.commands.some((c) => c.type === "thread.delete"), false);
  assert.equal(f.shell.threads.find((t) => t.title === "xl_base").modelSelection.instanceId, "claude_xinya");
});
