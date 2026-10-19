import { PROVIDERS } from "../skills/t3-fork-session/scripts/fork-session.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { capacityReport, checkCapacity } from "../skills/t3-fork-session/scripts/check-capacity.mjs";
import { combineCapacity, sessionActivity } from "../skills/t3-fork-session/scripts/capacity-load.mjs";
import { checkHosts } from "../skills/t3-fork-session/scripts/capacity-hosts.mjs";

const now = new Date("2026-10-07T12:00:00Z");
const active = (id, instanceId, title, extra = {}) => ({ id, projectId: "one", title, modelSelection: { instanceId, model: "claude-opus-5-5" }, latestTurn: { state: "running" }, ...extra });

test("capacity preserves quota scopes and uncertainty without ranking or leaking login identities", () => {
  const windows = [
    { id: "five_hour", kind: "session", label: "Session", usedPercent: 80, windowDurationMins: 300, resetsAt: "2026-10-07T13:00:00Z" },
    { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 45 },
    { id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable", usedPercent: 100 },
  ];
  const provider = { instanceId: "claudeAgent", driver: "claudeAgent", auth: { status: "authenticated", email: "private@example.test" }, models: [], usageLimits: { checkedAt: "2026-10-07T11:58:00Z", credentialFingerprint: "private-fingerprint", windows } };
  const config = { providers: [provider, { ...provider, instanceId: "claude_xinya", usageLimits: { ...provider.usageLimits, credentialFingerprint: "another-fingerprint" } }, { ...provider, instanceId: "claude_eol" }, { instanceId: "deepseek_codex", models: [], usageLimits: { checkedAt: now.toISOString(), windows: [], unavailable: { reason: "unsupported" } } }] };
  const report = capacityReport({ threads: [] }, config, { now });
  const ara = report.accounts.find((a) => a.account === "ARA");
  assert.deepEqual(ara.quota.windows.map((w) => [w.id, w.remainingPercent]), [["five_hour", 20], ["seven_day", 55], ["seven_day_fable", 0]]);
  assert.equal(ara.quota.ageSeconds, 120);
  const xl = report.accounts.find((a) => a.account === "XL");
  assert.equal(xl.instanceId, "claude_xinya");
  assert.deepEqual(xl.quota.windows, ara.quota.windows);
  assert.equal(ara.quota.windows[0].resetsAt, windows[0].resetsAt);
  assert.deepEqual(report.sharedLoginGroups, [["ES", "ARA"]]);
  assert.equal(report.accounts.find((a) => a.account === "SL").quota.unavailable.reason, "notReported");
  assert.equal(report.accounts.find((a) => a.account === "DS").quota.unavailable.reason, "unsupported");
  assert.match(report.accounts.find((a) => a.account === "DS").quota.scopeCaution, /not the DeepSeek/);
  assert.equal(report.selected, undefined);
  assert.equal(report.accounts.some((a) => "score" in a || "rank" in a), false);
  assert.equal(JSON.stringify(report).includes("private"), false);
});

test("load includes all projects and background sessions once, distinguishing named workers from masters", () => {
  const shell = { threads: [
    active("worker", "claudeAgent", "AUTONOMY598_OPUS", { session: { activeTurnId: "turn", status: "running" }, backgroundLiveness: "working" }),
    active("master", "claudeAgent", "Review work", { projectId: "two" }),
    active("idle", "claudeAgent", "AUTONOMY599_OPUS", { latestTurn: { state: "completed" }, settledAt: now.toISOString() }),
    active("background", "claudeAgent", "camera_worker_OPUS", { latestTurn: { state: "completed" }, backgroundLiveness: "monitoring" }),
    active("starting", "codex", "CONTROL344_SOL", { latestTurn: null, session: { status: "starting" } }),
    active("base", "codex", "sl_base", { latestTurn: null }),
  ] };
  const report = capacityReport(shell, { providers: [] }, { now });
  const ara = report.accounts.find((a) => a.account === "ARA");
  assert.equal(ara.activeSessionCount, 3);
  assert.equal(ara.activeWorkersByNameCount, 2);
  assert.deepEqual(ara.activeSessions.map((s) => s.threadId), ["worker", "master", "background"]);
  const sl = report.accounts.find((a) => a.account === "SL");
  assert.equal(sl.activeSessionCount, 1);
  assert.equal(sl.bases[0].busy, false);
});

test("refresh failures remain visible, cached inspection skips probes, and neither path dispatches work", async () => {
  for (const refresh of [true, false]) {
    const calls = [];
    const client = {
      rpc(tag, input) {
        calls.push([tag, input]);
        if (tag === "server.refreshProviders") return { promise: input.instanceId === "codex" ? Promise.reject(new Error("Probe timed out")) : Promise.resolve({}) };
        assert.equal(tag, "server.getConfig");
        return { promise: Promise.resolve({ providers: [] }) };
      },
      async http(route) { assert.equal(route, "/api/orchestration/shell"); return { threads: [] }; },
    };
    const report = await checkCapacity(client, { refresh });
    assert.equal(calls.filter(([tag]) => tag === "server.refreshProviders").length, refresh ? Object.keys(PROVIDERS).length : 0);
    assert.deepEqual(report.refreshErrors, refresh ? [{ account: "SL", message: "Probe timed out" }] : []);
    assert.equal(calls.some(([, input]) => input.refreshModels), false);
  }
});


test("worker counts recognize epic and keyword names while retaining legacy and non-issue workers", () => {
  const names = ["a569_a635_opus", "a569_c344_sol", "c300_c344_astra", "camera_c344_sol", "localization_a635_sonnet", "AUTONOMY598_OPUS", "CONTROL344_SOL", "camera_preview_worker_flash", "sl_base", "Review issue a635", "a569_a635"];
  const shell = { threads: names.map((name, i) => active(String(i), "codex", name)) };
  const sl = capacityReport(shell, { providers: [] }, { now }).accounts.find((a) => a.account === "SL");
  assert.equal(sl.activeSessionCount, 11);
  assert.equal(sl.activeWorkersByNameCount, 8);
  assert.deepEqual(sl.activeSessions.filter((s) => s.workerByNamingConvention).map((s) => s.title), names.slice(0, 8));
});


test("worker counts include descriptive issue names with and without epics", () => {
  const valid = ["a569_a635_localization_opus", "a569_c344_camera_sol", "c344_camera_sol", "a635_localization_astra", "e7_s9_capture_sonnet"];
  const names = [...valid, "a569_a635_localization", "c344_camera_unknown", "sl_base"];
  const shell = { threads: names.map((name, i) => active(String(i), "codex", name)) };
  const sl = capacityReport(shell, { providers: [] }, { now }).accounts.find((a) => a.account === "SL");
  assert.equal(sl.activeWorkersByNameCount, valid.length);
  assert.deepEqual(sl.activeSessions.filter(s => s.workerByNamingConvention).map(s => s.title), valid);
});

test("capacity exposes server measurements without ranking and handles older servers", async () => {
  for (const supported of [true, false]) {
    const measurements = { monitoredInstanceIds: ["codex", "claudeAgent"], profiles: [], turns: [], accounts: [] };
    const client = {
      rpc() { return { promise: Promise.resolve({ providers: [] }) }; },
      async http(route) {
        if (route === "/api/orchestration/shell") return { threads: [] };
        assert.equal(route, "/api/orchestration/usage-measurements");
        if (!supported) throw new Error("404 not found");
        return measurements;
      },
    };
    const report = await checkCapacity(client, { refresh: false });
    assert.deepEqual(report.measurements, supported ? measurements : null);
    assert.equal(report.measurementError, supported ? null : "404 not found");
    assert.equal(report.selected, undefined);
  }
});

test("load groups selected models and efforts without turning missing effort into a default", () => {
  const thread = (id, model, effort, extra = {}) => active(id, "codex", id, {
    modelSelection: { instanceId: "codex", model, options: effort ? [{ id: "reasoningEffort", value: effort }] : [] }, ...extra });
  const shell = { threads: [
    thread("one", "gpt-6-astra", "high"), thread("two", "gpt-6-astra", "xhigh"),
    thread("three", "gpt-6-astra", "high"), thread("unknown", "gpt-6.1-sol", null),
    thread("wait", "gpt-6.1-sol", "max", { hasPendingUserInput: true }),
    thread("monitor", "gpt-6.1-sol", "max", { latestTurn: { state: "completed" }, backgroundLiveness: "monitoring" }),
    thread("inconsistent", "gpt-6.1-sol", "max", { session: { status: "ready", activeTurnId: null } }),
    thread("starting", "gpt-6.1-sol", "max", { latestTurn: null, session: { status: "starting" } }),
  ] };
  const sl = capacityReport(shell, { providers: [] }, { now }).accounts.find((a) => a.account === "SL");
  assert.deepEqual([sl.load.working, sl.load.starting, sl.load.waiting, sl.load.backgroundOnly, sl.load.uncertain], [4, 1, 1, 1, 1]);
  assert.equal(sl.load.byModelEffort.find((r) => r.effort === "high").working, 2);
  assert.equal(sl.load.byModelEffort.find((r) => r.effort === "xhigh").working, 1);
  assert.equal(sl.load.byModelEffort.find((r) => r.effort === null).working, 1);
  assert.equal(sessionActivity(thread("idle", "gpt-6-astra", "high", { latestTurn: { state: "completed" }, session: { status: "ready" } })), null);
  assert.equal(sessionActivity(thread("stale", "gpt-6-astra", "high", { latestTurn: { turnId: "old", completedAt: now.toISOString() }, session: { activeTurnId: "old", status: "running" } })), "uncertain");
});

test("an account switch in flight is attributed to the running account with unknown model and effort", () => {
  const shell = { threads: [active("switch", "codex_antoine", "master", {
    session: { status: "running", activeTurnId: "turn", providerInstanceId: "codex" },
    modelSelection: { instanceId: "codex_antoine", model: "gpt-6.1-sol", options: [{ id: "reasoningEffort", value: "max" }] },
  })] };
  const report = capacityReport(shell, { providers: [] }, { now });
  assert.equal(report.accounts.find((a) => a.account === "AD").load.working, 0);
  const sl = report.accounts.find((a) => a.account === "SL");
  assert.equal(sl.load.working, 1);
  assert.deepEqual([sl.load.byModelEffort[0].model, sl.load.byModelEffort[0].effort], [null, null]);
});

test("pacing exposes time until reset without forecasting usage or treating an expired reset as replenished", () => {
  const report = capacityReport({ threads: [] }, { providers: [{ instanceId: "codex", models: [], usageLimits: {
    resetCredits: { availableCount: 2, nextCreditId: "do-not-expose" }, windows: [
      { id: "fresh", usedPercent: 20, resetsAt: "2026-10-07T16:00:00Z" },
      { id: "expired", usedPercent: 100, resetsAt: "2026-10-07T11:00:00Z" },
      { id: "unknown", usedPercent: 20 },
    ],
  } }] }, { now });
  const sl = report.accounts.find((a) => a.account === "SL");
  assert.deepEqual(sl.quota.windows.map((w) => [w.secondsUntilReset, w.sustainablePercentPerHour]), [[14400, 20], [0, null], [null, null]]);
  assert.equal(sl.quota.windows[1].usedPercent, 100);
  assert.deepEqual(sl.quota.resetCredits, { availableCount: 2, nextExpiresAt: null });
});

test("multi-host load deduplicates environments, retains quota observations, and flags different logins", () => {
  const host = (label, environmentId, email, count) => ({ label, report: capacityReport({ threads: Array.from({ length: count }, (_, i) => active(String(i), "codex", "master")) }, {
    environment: { environmentId, label }, providers: [{ instanceId: "codex", driver: "codex", models: [], auth: { email }, usageLimits: { windows: [{ id: "weekly", usedPercent: 40 }] } }],
  }, { now }) });
  const combined = combineCapacity([host("laptop", "one", "a@example.test", 2), host("same-laptop", "one", "a@example.test", 2), host("desktop", "two", "b@example.test", 3), { label: "offline", error: "unreachable" }]);
  assert.equal(combined.complete, false);
  assert.equal(combined.hosts[1].duplicateEnvironment, true);
  const sl = combined.loadByAccount.find((a) => a.account === "SL");
  assert.equal(sl.working, 5);
  assert.equal(sl.loginIdentity, "different-logins");
  assert.equal(sl.hosts.length, 2);
  assert.equal(sl.quota, undefined);
  assert.equal(combined.hosts[0].report.accounts.find((a) => a.account === "SL").quota.windows[0].usedPercent, 40);
});

test("remote failures remain explicit, and load-only inspection never probes quotas or reads transcripts", async () => {
  const calls = [];
  const client = {
    rpc(tag) { calls.push(tag); assert.equal(tag, "server.getConfig"); return { promise: Promise.resolve({ environment: { environmentId: "local" }, providers: [] }) }; },
    async http(route) { calls.push(route); assert.equal(route, "/api/orchestration/shell"); return { threads: [] }; },
  };
  const local = await checkCapacity(client, { loadOnly: true });
  const combined = await checkHosts(local, [{ label: "remote" }], { readRemote: async () => { throw new Error("SSH unavailable"); } });
  assert.deepEqual(calls.sort(), ["/api/orchestration/shell", "server.getConfig"]);
  assert.equal(combined.complete, false);
  assert.equal(combined.hosts[1].error, "SSH unavailable");
  assert.equal(combined.hosts[1].report, undefined);
});
