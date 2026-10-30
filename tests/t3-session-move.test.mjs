import { test } from "node:test";
import assert from "node:assert/strict";
import { planMove } from "../skills/t3-fork-session/scripts/move-session.mjs";
const selection = { instanceId: "codex", model: "gpt-6.1-sol", options: [{ id: "reasoningEffort", value: "max" }] };
const provider = { instanceId: "codex", driver: "codex", enabled: true, auth: { status: "authenticated" }, models: [{ slug: selection.model, capabilities: { optionDescriptors: [{ id: "reasoningEffort", type: "select", options: [{ id: "max" }] }] } }] };
const source = { projects: [{ id: "source", title: "Project", workspaceRoot: "/source" }], threads: [{ id: "thread", title: "Session", projectId: "source", modelSelection: selection }] };
const destination = { projects: [{ id: "target", title: "Project", workspaceRoot: "D:/target" }], threads: [] };
const config = (id, providers = [provider]) => ({ environment: { environmentId: id, capabilities: { nativeSessionMoves: true } }, providers });
test("plans native moves from shell metadata with an unchanged provider/model and stable request ID", () => {
  assert.deepEqual(planMove(source, config("alpha"), destination, config("beta"), { name: "Session", requestId: "stable" }), { requestId: "stable", threadId: "thread", environment: "beta", projectId: "target" });
});
test("requires compatible hosts, an unambiguous session and project, and an authenticated same-provider destination", () => {
  assert.throws(() => planMove(source, config("alpha"), destination, config("alpha"), { name: "Session" }), /different computer/);
  const old = config("beta");old.environment.capabilities.nativeSessionMoves = false;
  assert.throws(() => planMove(source, config("alpha"), destination, old, { name: "Session" }), /Both computers/);
  assert.throws(() => planMove({ ...source, threads: [...source.threads, { ...source.threads[0], id: "other" }] }, config("alpha"), destination, config("beta"), { name: "Session" }), /ambiguous/);
  assert.throws(() => planMove(source, config("alpha"), { projects: [...destination.projects, { ...destination.projects[0], id: "other" }] }, config("beta"), { name: "Session" }), /destination project/);
  assert.throws(() => planMove(source, config("alpha"), destination, config("beta", [{ ...provider, driver: "claudeAgent" }]), { name: "Session" }), /same provider/);
  assert.throws(() => planMove(source, config("alpha"), destination, config("beta", [{ ...provider, auth: { status: "unauthenticated" } }]), { name: "Session" }), /authenticated/);
});
test("maps an explicit same-provider account but refuses unsupported models or effort", () => {
  assert.equal(planMove(source, config("alpha"), destination, config("beta", [{ ...provider, instanceId: "other-account" }]), { threadId: "thread", providerInstanceId: "other-account" }).providerInstanceId, "other-account");
  assert.throws(() => planMove(source, config("alpha"), destination, config("beta", [{ ...provider, models: [] }]), { name: "Session" }), /saved model/);
  assert.throws(() => planMove(source, config("alpha"), destination, config("beta", [{ ...provider, models: [{ slug: selection.model }] }]), { name: "Session" }), /model options/);
});
test("plans a DeepSeek Harness move with its saved reasoning option", () => {
  const harnessSelection = { instanceId: "deepseekHarness", model: "deepseek-v4-flash", options: [{ id: "reasoning_effort", value: "max" }] };
  const harnessProvider = {
    instanceId: "deepseekHarness", driver: "deepseekHarness", enabled: true, auth: { status: "authenticated" },
    models: [{ slug: "deepseek-v4-flash", capabilities: { optionDescriptors: [
      { id: "reasoning_effort", type: "select", options: [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }] },
    ] } }],
  };
  const harnessSource = { ...source, threads: [{ ...source.threads[0], modelSelection: harnessSelection }] };
  assert.deepEqual(
    planMove(harnessSource, config("alpha", [harnessProvider]), destination, config("beta", [harnessProvider]), { name: "Session", requestId: "stable" }),
    { requestId: "stable", threadId: "thread", environment: "beta", projectId: "target" },
  );
});
