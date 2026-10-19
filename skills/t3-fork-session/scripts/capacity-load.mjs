import { createHash } from "node:crypto";

const states = ["working", "starting", "waiting", "backgroundOnly", "uncertain"];
const emptyCounts = () => Object.fromEntries(states.map((key) => [key, 0]));

export function sessionActivity(thread) {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "waiting";
  const session = thread.session;
  const turn = thread.latestTurn;
  const active = Boolean(session?.activeTurnId || session?.status === "running" || turn?.state === "running");
  if (active && (["error", "stopped", "interrupted"].includes(session?.status) ||
    (session?.status === "ready" && !session.activeTurnId && turn?.state === "running") ||
    (turn?.completedAt && turn?.turnId === session?.activeTurnId))) return "uncertain";
  if (session?.status === "starting") return "starting";
  if (active) return "working";
  return thread.backgroundLiveness ? "backgroundOnly" : null;
}

export function sessionProfile(thread) {
  const selection = thread.modelSelection;
  const liveInstance = thread.session?.activeTurnId ? thread.session.providerInstanceId : null;
  if (liveInstance && liveInstance !== selection.instanceId) {
    return { instanceId: liveInstance, model: null, effort: null, profileSource: "account-switch-in-progress" };
  }
  const effort = selection.options?.find((option) => ["effort", "reasoningEffort"].includes(option.id))?.value;
  return { instanceId: selection.instanceId, model: selection.model,
    effort: typeof effort === "string" ? effort : null, profileSource: "thread-selection" };
}

export function summarizeLoad(sessions) {
  const counts = emptyCounts();
  const groups = new Map();
  for (const session of sessions) {
    if (!states.includes(session.activity)) continue;
    counts[session.activity]++;
    const key = JSON.stringify([session.model, session.effort]);
    const group = groups.get(key) ?? { model: session.model, effort: session.effort, ...emptyCounts() };
    group[session.activity]++;
    groups.set(key, group);
  }
  return { ...counts, byModelEffort: [...groups.values()].sort((a, b) =>
    JSON.stringify([a.model, a.effort]).localeCompare(JSON.stringify([b.model, b.effort]))) };
}

export function accountIdentity(provider) {
  const email = provider?.auth?.email?.trim().toLowerCase();
  return email ? createHash("sha256").update(`${provider.driver}:${email}`).digest("hex") : null;
}

export function combineCapacity(hosts) {
  const seen = new Set();
  const accounts = new Map();
  const includedHosts = hosts.map((host) => {
    if (host.error) return host;
    const id = host.report.environment?.environmentId;
    if (id && seen.has(id)) return { ...host, duplicateEnvironment: true };
    if (id) seen.add(id);
    for (const account of host.report.accounts) {
      if (!account.configured && !account.activeSessionCount) continue;
      const combined = accounts.get(account.account) ?? { account: account.account, ...emptyCounts(), byModelEffort: [], hosts: [] };
      for (const state of states) combined[state] += account.load[state];
      for (const row of account.load.byModelEffort) {
        let target = combined.byModelEffort.find((g) => g.model === row.model && g.effort === row.effort);
        if (!target) { target = { model: row.model, effort: row.effort, ...emptyCounts() }; combined.byModelEffort.push(target); }
        for (const state of states) target[state] += row[state];
      }
      combined.hosts.push({ label: host.label, environmentId: id ?? null, identity: account.identity,
        observedAt: host.report.observedAt, load: account.load });
      accounts.set(account.account, combined);
    }
    return host;
  });
  for (const account of accounts.values()) {
    const identities = account.hosts.map((host) => host.identity);
    account.loginIdentity = identities.some((id) => !id) ? "unverified" :
      new Set(identities).size > 1 ? "different-logins" : "matching-login";
  }
  return { observedAt: new Date().toISOString(), complete: hosts.every((host) => !host.error),
    hosts: includedHosts, loadByAccount: [...accounts.values()],
    limitations: [
      "Totals group configured account aliases. Check loginIdentity and host details before treating them as one quota pool; a matching login is not proof of the same organization or subscription.",
      "Quotas remain per-host observations and are never added. Use the freshest trustworthy reading for the same account/window.",
      "Working counts are T3 active turns, not measured model compute. Background-only, input waits, and inconsistent state are separate. Native subagents, terminal sessions, and unqueried hosts are not counted.",
      "Model and effort come from thread selections and may differ from an in-flight turn after a settings change; missing effort remains null.",
    ] };
}

export function loadOnlyReport(report) {
  const slim = (value) => ({ observedAt: value.observedAt, environment: value.environment,
    accounts: value.accounts.map((a) => ({ account: a.account, configured: a.configured, identity: a.identity,
      activeSessionCount: a.activeSessionCount, load: a.load })), limitations: value.limitations });
  if (!report.hosts) return slim(report);
  return { ...report, hosts: report.hosts.map((host) => host.report ? { ...host, report: slim(host.report) } : host) };
}
