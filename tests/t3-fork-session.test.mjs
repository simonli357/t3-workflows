import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MODELS, PROVIDERS, T3Client, planFork, runFork, workerInput } from "../skills/t3-fork-session/scripts/fork-session.mjs";

function fixture() {
  const project = { id: "control", title: "SControl", workspaceRoot: "/scandy/ScandyControl" };
  const threads = Object.entries(PROVIDERS).map(([alias, p]) => ({
    id: randomUUID(), projectId: project.id, title: p.base,
    modelSelection: { instanceId: p.instanceId, model: MODELS[p.models[0]].slug, options: [{ id: MODELS[p.models[0]].option, value: "low" }, { id: "contextWindow", value: "1m" }, { id: "fastMode", value: false }] },
    runtimeMode: "full-access", interactionMode: "default", branch: "main", worktreePath: null,
    session: null, latestTurn: null, messages: [{ id: "base-context", role: "user", text: "Base context" }],
  }));
  const providers = Object.values(PROVIDERS).map((p) => ({
    instanceId: p.instanceId, enabled: true, installed: true,
    models: p.models.map((key) => ({ slug: MODELS[key].slug, capabilities: { optionDescriptors: [
      { id: MODELS[key].option, type: "select", options: ["low", "high", "xhigh", "max"].map((id) => ({ id })) },
      ...(key === "opus" || key === "sonnet" ? [{ id: "contextWindow", type: "select", options: [{ id: "1m" }] }] : []),
      ...(key === "opus" ? [{ id: "fastMode", type: "boolean" }] : []),
    ] } })),
  }));
  return { shell: { projects: [project], threads }, config: { providers }, input: { provider: "SL", model: "sol", name: "camera_c344_sol", task: "First line\nLiteral `code` and $(text).", threadId: randomUUID(), project: project.workspaceRoot } };
}

class FakeClient {
  constructor(data) { Object.assign(this, data); this.calls = []; this.created = 0; }
  async http() { return this.shell; }
  rpc() { return { promise: Promise.resolve(this.config) }; }
  async thread(id) { return structuredClone(this.shell.threads.find((t) => t.id === id)); }
  async fork({ sourceThreadId, threadId }) {
    this.calls.push("fork");
    if (!this.shell.threads.some((t) => t.id === threadId)) {
      const source = structuredClone(this.shell.threads.find((t) => t.id === sourceThreadId));
      this.shell.threads.push({ ...source, id: threadId, title: `${source.title} (fork)` });
      this.created++;
    }
    if (this.failFork) { this.failFork = false; throw new Error("Disconnected after native fork"); }
    return { threadId };
  }
  async dispatch(command) {
    this.calls.push(command.type);
    const thread = this.shell.threads.find((t) => t.id === command.threadId);
    if (command.type === "thread.meta.update") Object.assign(thread, { title: command.title, modelSelection: command.modelSelection });
    else {
      thread.messages.push({ id: command.message.messageId, text: command.message.text, role: "user" });
      if (this.failDispatch) { this.failDispatch = false; throw new Error("Disconnected after task accepted"); }
    }
  }
  async waitForTurn(plan, messageId) {
    this.calls.push("wait");
    assert.equal(this.shell.threads.find((t) => t.id === plan.threadId).messages.filter((m) => m.id === messageId).length, 1);
    return { threadId: plan.threadId, state: "started" };
  }
}

test("all account/model choices fix effort and retain only compatible inherited options", () => {
  const data = fixture();
  const cases = [["XL", "opus", "claude_xinya", "xhigh"], ["XL", "sonnet", "claude_xinya", "max"], ["ES", "opus", "claude_eol", "xhigh"], ["ES", "sonnet", "claude_eol", "max"], ["ARA", "opus", "claudeAgent", "xhigh"], ["ARA", "sonnet", "claudeAgent", "max"], ["AD", "sol", "codex_antoine", "max"], ["AD", "astra", "codex_antoine", "high"], ["SL", "sol", "codex", "max"], ["SL", "astra", "codex", "high"], ["DS", "flash", "deepseek_codex", "max"]];
  for (const [provider, model, instanceId, effort] of cases) {
    const plan = planFork(data.shell, data.config, { ...data.input, provider, model });
    assert.equal(plan.modelSelection.instanceId, instanceId);
    assert.equal(plan.effort, effort);
    assert.equal(plan.modelSelection.options.find((o) => o.id === MODELS[model].option).value, effort);
    assert.equal(plan.modelSelection.options.some((o) => o.id === "fastMode"), model === "opus");
    assert.equal(plan.modelSelection.options.some((o) => o.id === "contextWindow"), model === "opus" || model === "sonnet");
    assert.equal(plan.sourceThreadId, data.shell.threads.find((t) => t.title === `${provider.toLowerCase()}_base`).id);
  }
  assert.equal(planFork(data.shell, data.config, { ...data.input, model: "gpt-6.1-sol", name: "User chosen title" }).name, "User chosen title");
});

test("invalid choices, unavailable effort, missing or ambiguous bases cannot fork", async () => {
  for (const change of [
    (d) => { d.input.provider = undefined; },
    (d) => { d.input.model = undefined; },
    (d) => { d.input.model = "opus"; },
    (d) => { d.shell.threads = []; },
    (d) => { d.shell.threads.push(structuredClone(d.shell.threads.find((t) => t.title === "sl_base"))); },
    (d) => { d.shell.threads.find((t) => t.title === "sl_base").modelSelection.instanceId = "codex_antoine"; },
    (d) => { d.shell.threads.find((t) => t.title === "sl_base").session = { activeTurnId: "active" }; },
    (d) => { d.config.providers.find((p) => p.instanceId === "codex").installed = false; },
    (d) => { d.config.providers.find((p) => p.instanceId === "codex").models[0].capabilities.optionDescriptors[0].options = [{ id: "low" }]; },
  ]) {
    const data = fixture(); change(data);
    const client = new FakeClient(data);
    await assert.rejects(runFork(client, data.input));
    assert.deepEqual(client.calls, []);
  }
});

test("dry-run checks the selection without creating or assigning work", async () => {
  const data = fixture(); const client = new FakeClient(data);
  const result = await runFork(client, { ...data.input, dryRun: true });
  assert.equal(result.modelSelection.model, "gpt-6.1-sol");
  assert.deepEqual(client.calls, []);
  assert.equal(data.shell.threads.length, Object.keys(PROVIDERS).length);
});

test("fork, configure and exact task assignment preserve the base", async () => {
  const data = fixture(); const client = new FakeClient(data);
  const bases = structuredClone(data.shell.threads);
  await runFork(client, data.input);
  assert.deepEqual(client.calls, ["fork", "thread.meta.update", "thread.turn.start", "wait"]);
  assert.deepEqual(data.shell.threads.slice(0, bases.length), bases);
  const worker = data.shell.threads.at(-1);
  assert.equal(worker.title, "camera_c344_sol");
  assert.equal(worker.messages.at(-1).text, data.input.task);
  assert.deepEqual(worker.messages.slice(0, -1), bases.find((t) => t.title === "sl_base").messages);
});

test("an explicit worker source preserves its context and modes without changing the source", async () => {
  const data = fixture();
  const source = { ...structuredClone(data.shell.threads.find((t) => t.title === "sl_base")), id: randomUUID(), title: "AUTONOMY576_SOL", branch: "simonli357/mesh", worktreePath: "/scandy/mesh", interactionMode: "plan", messages: [{ id: "prior-result", role: "assistant", text: "Prior implementation evidence" }] };
  data.shell.threads.push(source);
  data.input.sourceThreadId = source.id;
  const before = structuredClone(data.shell.threads);
  const plan = planFork(data.shell, data.config, data.input);
  assert.equal(plan.sourceThreadId, source.id);
  assert.equal(plan.branch, source.branch);
  assert.equal(plan.worktreePath, source.worktreePath);
  assert.equal(plan.interactionMode, source.interactionMode);
  await runFork(new FakeClient(data), data.input);
  assert.deepEqual(data.shell.threads.slice(0, -1), before);
  assert.deepEqual(data.shell.threads.at(-1).messages.slice(0, -1), source.messages);
  assert.equal(data.shell.threads.at(-1).messages.at(-1).text, data.input.task);
});

test("an explicit source cannot fall back to a base or cross project/account boundaries", async () => {
  for (const change of [
    (d, source) => { d.input.sourceThreadId = randomUUID(); },
    (_d, source) => { source.projectId = "another-project"; },
    (_d, source) => { source.modelSelection.instanceId = "codex_antoine"; },
    (_d, source) => { source.latestTurn = { state: "running" }; },
    (d, source) => { d.input.threadId = source.id; },
  ]) {
    const data = fixture();
    const source = structuredClone(data.shell.threads.find((t) => t.title === "sl_base"));
    source.id = randomUUID(); source.title = "Prior worker";
    data.shell.threads.push(source);
    data.input.sourceThreadId = source.id;
    change(data, source);
    const client = new FakeClient(data);
    await assert.rejects(runFork(client, data.input));
    assert.deepEqual(client.calls, []);
  }
});

test("retry after a lost fork reply reuses its native destination", async () => {
  const data = fixture(); const client = new FakeClient(data); client.failFork = true;
  await assert.rejects(runFork(client, data.input), /Disconnected/);
  await runFork(client, data.input);
  assert.equal(client.created, 1);
  assert.equal(client.calls.filter((c) => c === "thread.turn.start").length, 1);
});

test("retry after lost task acknowledgement sends neither another fork nor another task", async () => {
  const data = fixture(); const client = new FakeClient(data); client.failDispatch = true;
  await assert.rejects(runFork(client, data.input), /Disconnected/);
  data.shell.threads.find((t) => t.title === "sl_base").session = { activeTurnId: "another-turn" };
  await runFork(client, data.input);
  assert.equal(client.created, 1);
  assert.equal(client.calls.filter((c) => c === "fork").length, 1);
  assert.equal(client.calls.filter((c) => c === "thread.turn.start").length, 1);
  await assert.rejects(runFork(client, { ...data.input, task: "A different assignment" }), /different task/);
});

test("saved prompts cannot mask provider failure or a downgraded effort", async () => {
  const data = fixture(); const plan = planFork(data.shell, data.config, data.input);
  const createdAt = new Date().toISOString();
  for (const failure of ["Provider authentication failed", "wrong effort"]) {
    const client = new T3Client({ timeout: 1 });
    client.socket = { send() {} };
    client.rpc = () => ({ id: "stream", promise: new Promise(() => {}) });
    client.thread = async () => ({
      id: plan.threadId, title: plan.name,
      modelSelection: failure === "wrong effort" ? { ...plan.modelSelection, options: [{ id: "reasoningEffort", value: "low" }] } : plan.modelSelection,
      session: { providerInstanceId: "codex", lastError: failure === "wrong effort" ? null : failure },
      messages: [{ id: "task", createdAt }], latestTurn: { requestedAt: createdAt, startedAt: createdAt, state: "running" },
    });
    await assert.rejects(client.waitForTurn(plan, "task", "started"), failure === "wrong effort" ? /different model or effort/ : /authentication failed/);
  }
});

test("a pending task cannot inherit a previous turn's completion", async () => {
  const data = fixture(); const plan = planFork(data.shell, data.config, data.input);
  const createdAt = "2026-10-05T20:26:36.765Z";
  const thread = {
    id: plan.threadId, title: plan.name, modelSelection: plan.modelSelection,
    session: { providerInstanceId: "codex", lastError: null },
    messages: [{ id: "task", createdAt }],
    latestTurn: { turnId: "previous", requestedAt: "2026-10-05T20:12:13.530Z", startedAt: "2026-10-05T20:12:13.530Z", state: "completed" },
  };
  const client = new T3Client({ timeout: 1 });
  client.socket = { send() {} };
  let update;
  client.rpc = (_tag, _payload, onValue) => { update = onValue; return { id: "stream", promise: new Promise(() => {}) }; };
  client.thread = async () => structuredClone(thread);
  let reported = false;
  const pending = client.waitForTurn(plan, "task", "completed").then((value) => { reported = true; return value; });
  await new Promise(setImmediate);
  assert.equal(reported, false);
  thread.latestTurn = { turnId: "assigned", requestedAt: createdAt, startedAt: createdAt, state: "running" };
  update();
  await new Promise(setImmediate);
  assert.equal(reported, false);
  thread.latestTurn.state = "completed";
  update();
  assert.equal((await pending).turnId, "assigned");
});

test("MCP plans retain each selected base, fixed model profile, and literal task", () => {
  const data = fixture();
  for (const [provider, profile] of Object.entries(PROVIDERS)) {
    for (const model of profile.models) {
      const plan = planFork(data.shell, data.config, { ...data.input, provider, model });
      const input = workerInput(plan, data.input.task);
      assert.equal(input.sourceThreadId, data.shell.threads.find((t) => t.title === profile.base).id);
      assert.equal(input.threadId, data.input.threadId);
      assert.equal(input.prompt, data.input.task);
      assert.equal(input.modelSelection.instanceId, profile.instanceId);
      assert.equal(input.modelSelection.options.find((o) => o.id === MODELS[model].option).value, MODELS[model].effort);
      assert.equal(input.ownerThreadId, undefined);
    }
  }
});
