import { PROVIDERS } from "../skills/t3-fork-session/scripts/fork-session.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { capacityReport, checkCapacity } from "../skills/t3-fork-session/scripts/check-capacity.mjs";

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
