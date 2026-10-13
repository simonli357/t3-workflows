#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MODELS, PROVIDERS, T3Client } from "./fork-session.mjs";

const workerName = /^(?:(?:CONTROL|AUTONOMY)\d+|(?:[ac]\d+|[a-z][a-z0-9]*)_[ac]\d+|[a-z0-9_]+_worker)_(?:SOL|ASTRA|OPUS|SONNET|FLASH)$/i;

export function capacityReport(shell, config, { now = new Date(), refreshErrors = [] } = {}) {
  const accounts = Object.entries(PROVIDERS).map(([account, profile]) => {
    const provider = config.providers.find((p) => p.instanceId === profile.instanceId);
    const sessions = shell.threads.filter((t) => t.modelSelection.instanceId === profile.instanceId)
      .filter((t) => t.session?.activeTurnId || ["starting", "running"].includes(t.session?.status) || t.latestTurn?.state === "running" || t.backgroundLiveness)
      .map((t) => ({
        threadId: t.id, title: t.title, projectId: t.projectId,
        model: t.modelSelection.model, options: t.modelSelection.options ?? [],
        sessionStatus: t.session?.status ?? null, turnState: t.latestTurn?.state ?? null,
        backgroundLiveness: t.backgroundLiveness ?? null,
        workerByNamingConvention: workerName.test(t.title),
      }));
    const limits = provider?.usageLimits;
    const checkedTime = Date.parse(limits?.checkedAt);
    return {
      account, instanceId: profile.instanceId, configured: Boolean(provider),
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
        windows: (limits?.windows ?? []).map((w) => ({
          id: w.id, kind: w.kind, label: w.label, usedPercent: w.usedPercent,
          remainingPercent: 100 - w.usedPercent,
          resetsAt: w.resetsAt ?? null, windowDurationMins: w.windowDurationMins ?? null,
        })),
      },
      activeSessionCount: sessions.length,
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
    accounts, sharedLoginGroups: [...groups.values()].filter((g) => g.length > 1),
    refreshErrors,
    limitations: [
      "Counts cover this T3 environment only, across all projects; terminal sessions and other machines are not visible.",
      "Worker counts use the naming convention, not ownership. All active sessions also consume capacity. Use t3_worker_list for this master's actual workers and queued assignments.",
      "Background liveness includes monitoring and does not prove ongoing model usage. Missing quota windows do not mean unlimited capacity; refresh failures may retain older data.",
      "Shared-account grouping is best effort; aliases and model-specific windows may share quota. This report does not rank accounts or select a model.",
    ],
  };
}

export async function checkCapacity(client, { refresh = true } = {}) {
  const refreshErrors = [];
  if (refresh) {
    const results = await Promise.allSettled(Object.values(PROVIDERS).map((p) => client.rpc("server.refreshProviders", { instanceId: p.instanceId }).promise));
    results.forEach((r, i) => {
      if (r.status === "rejected") refreshErrors.push({ account: Object.keys(PROVIDERS)[i], message: String(r.reason?.message ?? r.reason) });
    });
  }
  const [shell, config] = await Promise.all([client.http("/api/orchestration/shell"), client.rpc("server.getConfig", {}).promise]);
  return capacityReport(shell, config, { refreshErrors });
}

async function main() {
  const { values } = parseArgs({ options: {
    server: { type: "string" }, home: { type: "string" }, cli: { type: "string" },
    timeout: { type: "string", default: "90" }, cached: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("Usage: node check-capacity.mjs [--cached] [--server URL] [--home PATH] [--cli PATH] [--timeout SECONDS]\nRead account limits, available profiles, and active sessions. Refreshes provider status by default; never starts workers or chooses a profile.");
    return;
  }
  if (!(Number(values.timeout) > 0 && Number(values.timeout) <= 900)) throw new Error("--timeout must be between 1 and 900 seconds.");
  const client = new T3Client({ server: values.server, home: values.home, cli: values.cli, timeout: Number(values.timeout) });
  try {
    await client.connect();
    console.log(JSON.stringify(await checkCapacity(client, { refresh: !values.cached }), null, 2));
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
