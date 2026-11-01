import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LinkedClient, findPeer, writePeers } from "../skills/t3-fork-session/scripts/peers.mjs";
import { T3Client, runFork, workerInput, MODELS, PROVIDERS } from "../skills/t3-fork-session/scripts/fork-session.mjs";
import { lookupSession } from "../skills/t3-fork-session/scripts/find-session.mjs";
import { settleWorker } from "../skills/t3-fork-session/scripts/settle-worker.mjs";

const shellThread = (id, extra = {}) => ({ id, title: `Session ${id}`, projectId: "p", modelSelection: { instanceId: "codex_sl", model: "gpt-6-astra" }, providerInstanceId: "codex_sl", status: "idle", activeRunId: null, latestRunId: null, settledAt: null, deletedAt: null, ...extra });
const clientOf = () => { const client = new LinkedClient("remote", { timeout: 1 }); client.protocol = 2; client.link = { environmentId: "e2", label: "Remote", status: "reachable" }; return client; };

async function httpFixture(t, respond) {
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    try { const body = await respond(req.url, text ? JSON.parse(text) : undefined, req.headers); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); }
    catch (error) { res.statusCode = 400; res.end(JSON.stringify({ message: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("typed HTTP uses the selected environment and rejects wrong provenance or unsupported local fallbacks", async (t) => {
  const seen = [];
  let identity = "e2";
  const server = await httpFixture(t, (url, input, headers) => { seen.push({ url, input, auth: headers.authorization }); return { environmentId: identity, threads: [], nextCursor: null }; });
  const client = clientOf(); client.server = server; client.token = "fixture-token";
  await client.query("list", { environmentId: "cannot-override", operation: "cannot-override" });
  assert.deepEqual(seen[0], { url: "/api/orchestration/linked-sessions/query", input: { environmentId: "e2", operation: "list" }, auth: "Bearer fixture-token" });
  identity = "elsewhere";
  await assert.rejects(client.query("list"), /different environment/);
  await assert.rejects(client.http("/api/arbitrary"), /Unsupported linked/);
  await assert.rejects(client.dispatch({ type: "thread.delete" }), /Unsupported linked/);
  assert.equal(seen.length, 2);
});

test("full shell paging includes every project and session, and rejects a stuck cursor", async () => {
  const client = clientOf();
  const threads = Array.from({ length: 207 }, (_, i) => shellThread(`t${i}`));
  const projects = Array.from({ length: 112 }, (_, i) => ({ id: `p${i}`, title: `Project ${i}`, workspaceRoot: `D:/p${i}` }));
  client.query = async (operation, { cursor, limit }) => { const values = operation === "projects" ? projects : threads; return { [operation === "projects" ? "projects" : "threads"]: values.slice(cursor, cursor + limit), nextCursor: cursor + limit < values.length ? cursor + limit : null }; };
  const shell = await client.shell();
  assert.equal(shell.threads.length, 207); assert.deepEqual(shell.projects, projects);
  client.query = async () => ({ projects: [], nextCursor: 0 });
  await assert.rejects(client.pages("projects", {}, "projects"), /non-advancing/);
});

test("bounded lookup uses remote filters and provenance; exact duplicate names stay ambiguous", async () => {
  const client = clientOf(); const calls = [];
  client.query = async (operation, input) => {
    calls.push([operation, input]);
    if (operation === "projects") return { projects: [{ id: "p", title: "Remote Project", workspaceRoot: "D:/actual" }], nextCursor: null };
    if (operation === "list") return { threads: input.location === "archive" ? [] : [shellThread("t")], nextCursor: null };
    return { history: { messages: [{ messageId: "m", role: "user", text: "remote prompt" }], page: { hasMore: false, beforeMessageId: null } } };
  };
  const result = await lookupSession(client, { name: "Session t", chars: 2048 });
  assert.equal(result.environmentId, "e2"); assert.equal(result.session.workingDirectory, "D:/actual");
  assert.ok(JSON.stringify(result).length <= 2048);
  assert.equal(calls.find(([op]) => op === "list")[1].titleContains, "Session t");
  assert.equal(calls.find(([op]) => op === "history")[1].messageLimit, 3);
  client.lookupShell = async () => ({ projects: [], threads: [shellThread("t"), shellThread("other", { title: "Session t" })] });
  const ambiguous = await lookupSession(client, { name: "Session t" });
  assert.equal(ambiguous.status, "ambiguous"); assert.equal(ambiguous.totalMatches, 2);
});

test("complete reads follow older pages and Unicode text continuations exactly once", async () => {
  const client = clientOf(); const calls = [];
  const message = (id, text, nextOffset = null, offset = 0) => ({ messageId: id, role: "user", text, nextOffset, offset, turnId: null, createdAt: "2026-01-01" });
  client.query = async (operation, input) => {
    calls.push(input);
    if (operation === "list") return { threads: [shellThread("t")], nextCursor: null };
    if (input.messageId) return { history: { messages: [message("new", "tail", null, 1)], page: { hasMore: false, beforeMessageId: null } } };
    if (input.beforeMessageId) return { history: { messages: [message("old", "first")], page: { hasMore: false, beforeMessageId: null } } };
    return { history: { messages: [message("new", "🦉", 1)], page: { hasMore: true, beforeMessageId: "new" } } };
  };
  const result = await client.thread("t");
  assert.deepEqual(result.messages.map((m) => [m.id, m.text]), [["old", "first"], ["new", "🦉tail"]]);
  assert.equal(calls.length, 4); assert.equal(calls[2].offset, 1);
  client.query = async (operation) => operation === "list" ? { threads: [shellThread("t")] } : { history: { messages: [], page: { hasMore: true, beforeMessageId: "same" } } };
  await assert.rejects(client.thread("t"), /non-advancing history/);
});

test("settle refuses activity, verifies the remote result, and supports the reverse operation", async () => {
  const client = clientOf(); let current = shellThread("t", { status: "running", activeRunId: "r" }); const actions = [];
  client.query = async () => ({ threads: [current], nextCursor: null });
  client.command = async (operation, input) => { actions.push([operation, input.action]); current = { ...current, settledAt: input.action === "settle" ? "2026-01-01" : null }; return { sequence: 1 }; };
  await assert.rejects(settleWorker(client, "t"), /running turn/); assert.deepEqual(actions, []);
  current = shellThread("t");
  assert.equal((await settleWorker(client, "t")).environmentId, "e2");
  await client.dispatch({ type: "thread.unsettle", threadId: "t" });
  assert.equal((await client.thread("t", { messages: false })).settledAt, null);
  client.command = async () => ({ sequence: 2 });
  await assert.rejects(settleWorker(client, "t"), /not marked settled/);
});

test("worker plans use the destination's catalog, projects and base, including effort validation", async () => {
  const client = clientOf();
  const profile = MODELS.astra;
  const provider = { instanceId: PROVIDERS.SL.instanceId, enabled: true, installed: true, models: [{ slug: profile.slug, capabilities: { optionDescriptors: [{ id: profile.option, type: "select", options: [{ id: profile.effort }] }] } }] };
  client.query = async (operation) => operation === "catalog" ? { environment: { environmentId: "e2", capabilities: { peerEnvironments: true, workerFreshSessions: true } }, providers: [provider] }
    : operation === "projects" ? { projects: [{ id: "p", title: "Remote", workspaceRoot: "D:/actual" }], nextCursor: null }
    : { threads: [shellThread("base", { title: "sl_base", modelSelection: { instanceId: provider.instanceId, model: profile.slug } })], nextCursor: null };
  const input = { provider: "SL", model: "astra", name: "review", task: "Review the change", threadId: "12345678-1234-1234-1234-123456789abc", environment: "e2", project: "p", mcpPlan: true, localPeerEnvironments: true, dryRun: true };
  const plan = await runFork(client, input);
  assert.equal(plan.project, "D:/actual"); assert.equal(plan.sourceThreadId, "base");
  assert.equal(workerInput(plan, input.task).environment, "e2");
  assert.equal(plan.modelSelection.options[0].value, profile.effort);
  provider.models[0].capabilities.optionDescriptors[0].options = [];
  await assert.rejects(runFork(client, input), /does not advertise/);
});

test("connection selection keeps V1 credentials, exact IDs, ambiguity and offline failures distinct", async (t) => {
  let version = 2;
  const server = await httpFixture(t, () => ({ orchestrationProtocolVersion: version }));
  let links = [{ environmentId: "e2", label: "Same", status: "reachable" }, { environmentId: "e3", label: "Same", status: "reachable" }];
  t.mock.method(T3Client.prototype, "connect", async function () {});
  t.mock.method(T3Client.prototype, "rpc", () => ({ promise: Promise.resolve({ links }) }));
  await assert.rejects(new LinkedClient("Same", { server }).connect(), /several/);
  const exact = new LinkedClient("e2", { server }); await exact.connect(); assert.equal(exact.link.environmentId, "e2");
  await assert.rejects(new LinkedClient("missing", { server }).connect(), /No linked/);
  links = [{ ...links[0], status: "unreachable" }];
  await assert.rejects(new LinkedClient("e2", { server }).connect(), /unreachable/);
  const home = mkdtempSync(path.join(tmpdir(), "linked-v1-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  writePeers(home, [{ environmentId: "v1", label: "Legacy", url: "http://legacy.invalid", token: "fixture" }]);
  version = 1;
  const legacy = new LinkedClient("Legacy", { server, home }); await legacy.connect();
  assert.equal(legacy.linked, false); assert.equal(legacy.server, "http://legacy.invalid"); assert.equal(legacy.token, "fixture");
  t.mock.method(T3Client.prototype, "thread", async (id) => ({ id, title: "Legacy" }));
  assert.deepEqual(await legacy.thread("legacy"), { id: "legacy", title: "Legacy" });
  assert.throws(() => findPeer([{ environmentId: "a", label: "x" }, { environmentId: "b", label: "x" }], "x"), /several/);
});
