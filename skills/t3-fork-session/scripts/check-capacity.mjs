#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MODELS, PROVIDERS, T3Client, usageLimit } from "./fork-session.mjs";
import { settings } from "./config.mjs";
import { sessionActivity, sessionProfile, summarizeLoad, accountIdentity, loadOnlyReport } from "./capacity-load.mjs";
import { checkHosts } from "./capacity-hosts.mjs";

const workerName = /^(?:(?:CONTROL|AUTONOMY)\d+|(?:[a-z]+\d+_)?[a-z]+\d+_[a-z][a-z0-9]*|(?:[ac]\d+|[a-z][a-z0-9]*)_[ac]\d+|[a-z0-9_]+_worker)_(?:SOL|ASTRA|OPUS|SONNET|FLASH)$/i;

export function capacityReport(shell, config, { now = new Date(), refreshErrors = [] } = {}) {
  const accounts = Object.entries(PROVIDERS).map(([account, profile]) => {
    const provider = config.providers.find((p) => p.instanceId === profile.instanceId);
    const sessions = shell.threads.filter((t) => sessionProfile(t).instanceId === profile.instanceId)
      .filter((t) => sessionActivity(t))
      .map((t) => ({
        threadId: t.id, title: t.title, projectId: t.projectId,
        ...sessionProfile(t), options: t.modelSelection.options ?? [], activity: sessionActivity(t),
        turnStartedAt: t.latestTurn?.startedAt ?? null, sessionCreatedAt: t.createdAt ?? null,
        sessionStatus: t.session?.status ?? null, turnState: t.latestTurn?.state ?? null,
        backgroundLiveness: t.backgroundLiveness ?? null,
        workerByNamingConvention: workerName.test(t.title),
      }));
    const limitedSessions = shell.threads.filter((t) => t.modelSelection.instanceId === profile.instanceId)
      .filter((t) => t.session?.status === "error" && /usage limit/i.test(t.session?.lastError ?? ""))
      .map((t) => ({ threadId: t.id, title: t.title, lastError: t.session.lastError, updatedAt: t.updatedAt }));
    const limits = provider?.usageLimits;
    const checkedTime = Date.parse(limits?.checkedAt);
    return {
      account, instanceId: profile.instanceId, configured: Boolean(provider),
      identity: accountIdentity(provider),
      enabled: provider?.enabled ?? false, installed: provider?.installed ?? false,
      status: provider?.status ?? null, availability: provider?.availability ?? null,
      authStatus: provider?.auth?.status ?? null,
      profiles: profile.models.map((key) => {
        const model = MODELS[key];
        const advertised = provider?.models.find((m) => m.slug === model.slug);
        return { model: key, nativeModel: model.slug, effort: model.effort,
          advertised: Boolean(advertised),
          effortSupported: advertised?.capabilities?.optionDescriptors?.some((d) => d.id === model.option && d.options?.some((o) => o.id === model.effort)) ?? false };
      }),
      quota: {
        checkedAt: limits?.checkedAt ?? null,
        scopeCaution: account === "DS" ? "Codex harness limits may describe its OpenAI login, not the DeepSeek backend. Verify attribution before using them as DeepSeek capacity." : null,
        ageSeconds: Number.isFinite(checkedTime) ? Math.max(0, Math.round((now.getTime() - checkedTime) / 1000)) : null,
        unavailable: limits?.unavailable ?? (limits ? null : { reason: "notReported" }),
        resetCredits: limits?.resetCredits ? { availableCount: limits.resetCredits.availableCount,
          nextExpiresAt: limits.resetCredits.nextExpiresAt ?? null } : null,
        windows: (limits?.windows ?? []).map((w) => {
          const resetMs = Date.parse(w.resetsAt);
          const secondsUntilReset = Number.isFinite(resetMs) ? Math.max(0, Math.round((resetMs - now.getTime()) / 1000)) : null;
          return {
          id: w.id, kind: w.kind, label: w.label, usedPercent: w.usedPercent,
          remainingPercent: 100 - w.usedPercent,
          resetsAt: w.resetsAt ?? null, windowDurationMins: w.windowDurationMins ?? null,
          secondsUntilReset,
          sustainablePercentPerHour: secondsUntilReset > 0 && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100
            ? (100 - w.usedPercent) / (secondsUntilReset / 3600) : null,
        }; }),
      },
      limitedSessions,
      activeSessionCount: sessions.length,
      load: summarizeLoad(sessions),
      activeWorkersByNameCount: sessions.filter((t) => t.workerByNamingConvention).length,
      activeSessions: sessions,
      bases: shell.threads.filter((t) => t.title.toLowerCase() === profile.base).map((t) => ({
        threadId: t.id, projectId: t.projectId, providerInstanceId: t.modelSelection.instanceId,
        model: t.modelSelection.model,
        busy: Boolean(t.session?.activeTurnId || ["starting", "running"].includes(t.session?.status) || t.latestTurn?.state === "running" || t.backgroundLiveness),
      })),
    };
  });
  const groups = new Map();
  for (const account of accounts) {
    const p = config.providers.find((p) => p.instanceId === account.instanceId);
    const identity = p?.usageLimits?.credentialFingerprint || p?.auth?.email?.toLowerCase();
    if (!identity) continue;
    const key = `${p.driver}:${identity}`;
    groups.set(key, [...(groups.get(key) ?? []), account.account]);
  }
  return {
    observedAt: now.toISOString(), snapshotSequence: shell.snapshotSequence,
    environment: config.environment ? { environmentId: config.environment.environmentId,
      label: config.environment.label, serverVersion: config.environment.serverVersion } : null,
    accounts, sharedLoginGroups: [...groups.values()].filter((g) => g.length > 1),
    refreshErrors,
    limitations: [
      "Counts cover this T3 environment only, across all projects; terminal sessions and other machines are not visible.",
      "Worker counts use the naming convention, not ownership. All active sessions also consume capacity. Use t3_worker_list for this master's actual workers and queued assignments.",
      "Background liveness includes monitoring and does not prove ongoing model usage. Missing quota windows do not mean unlimited capacity; refresh failures may retain older data.",
      "Provider quota availability varies by account and runtime. limitedUntil comes from the latest usage-limit rejection seen in this environment and is null when none is active.",
      "Shared-account grouping is best effort; aliases and model-specific windows may share quota. This report does not rank accounts or select a model.",
      "load separates working/starting turns from input waits, background-only monitoring and inconsistent state. Native subagents are not counted. Model/effort are thread selections, not proof of an in-flight provider configuration.",
      "sustainablePercentPerHour is remaining allowance divided by time until reset, not a predicted consumption rate. Expired resets and missing effort stay unknown.",
    ],
  };
}

export async function checkCapacity(client, { refresh = true, loadOnly = false } = {}) {
  const refreshErrors = [];
  if (refresh && !loadOnly) {
    const results = await Promise.allSettled(Object.values(PROVIDERS).map((p) => client.rpc("server.refreshProviders", { instanceId: p.instanceId }).promise));
    results.forEach((r, i) => {
      if (r.status === "rejected") refreshErrors.push({ account: Object.keys(PROVIDERS)[i], message: String(r.reason?.message ?? r.reason) });
    });
  }
  const [shell, config] = await Promise.all([client.http("/api/orchestration/shell"), client.rpc("server.getConfig", {}).promise]);
  const report = capacityReport(shell, config, { refreshErrors });
  if (loadOnly) return loadOnlyReport(report);
  try {
    const measurements = await client.http("/api/orchestration/usage-measurements");
    if (!Array.isArray(measurements?.monitoredInstanceIds)) throw new Error("Server did not return usage measurements.");
    report.measurements = measurements;
    report.measurementError = null;
  } catch (error) {
    report.measurements = null;
    report.measurementError = String(error?.message ?? error);
  }
  for (const account of report.accounts) {
    for (const session of account.limitedSessions) Object.assign(session, { usageLimit: usageLimit(await client.thread(session.threadId)) });
    const resets = account.limitedSessions.map((s) => s.usageLimit).filter((l) => l?.active).map((l) => l.resetsAt).sort();
    account.limitedUntil = resets.at(-1) ?? null;
  }
  return report;
}

async function main() {
  const { values } = parseArgs({ options: {
    server: { type: "string" }, home: { type: "string" }, cli: { type: "string" },
    timeout: { type: "string", default: "90" }, cached: { type: "boolean", default: false },
    "all-hosts": { type: "boolean", default: false }, "local-only": { type: "boolean", default: false },
    "load-only": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("Usage: node check-capacity.mjs [--all-hosts | --local-only] [--load-only] [--cached] [--server URL] [--home PATH] [--cli PATH] [--timeout SECONDS]\nRead limits and account/model/effort load. --all-hosts queries capacity.remoteEnvironments over SSH. --load-only skips quota refresh/history and returns compact counts. Never starts workers or chooses a profile.");
    return;
  }
  if (!(Number(values.timeout) > 0 && Number(values.timeout) <= 900)) throw new Error("--timeout must be between 1 and 900 seconds.");
  if (values["all-hosts"] && values["local-only"]) throw new Error("Choose --all-hosts or --local-only.");
  const remotes = settings.capacity?.remoteEnvironments ?? [];
  if (values["all-hosts"] && !remotes.length) throw new Error("No capacity.remoteEnvironments configured; use --local-only for this host or configure the other hosts first.");
  const client = new T3Client({ server: values.server, home: values.home, cli: values.cli, timeout: Number(values.timeout) });
  try {
    await client.connect();
    let report = await checkCapacity(client, { refresh: !values.cached, loadOnly: values["load-only"] });
    if (values["all-hosts"]) report = await checkHosts(report, remotes, { label: settings.capacity?.label ?? report.environment?.label ?? "local",
      cached: values.cached, loadOnly: values["load-only"], timeout: Number(values.timeout) });
    console.log(JSON.stringify(report, null, 2));
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
