#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MODELS, PROVIDERS, T3Client, planFork } from "./fork-session.mjs";

import { resolveProject, baseFor, projectProfile } from "./config.mjs";

export const BASE_PROMPT = "understand project";
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const idle = (thread) => !thread.session?.activeTurnId && thread.session?.status !== "starting" && thread.latestTurn?.state !== "running" && !thread.backgroundLiveness;
const selectionKey = (selection) => JSON.stringify({ ...selection, options: [...(selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)) });

export function planRefresh(shell, config, { project, providers = Object.keys(PROVIDERS), prompt }) {
  const projects = shell.projects.filter((p) => path.resolve(p.workspaceRoot) === path.resolve(project));
  ensure(projects.length === 1, `Expected one T3 project for ${project}; found ${projects.length}.`);
  return providers.map((account) => {
    const configured = PROVIDERS[account];
    const profile = configured && { ...configured, base: baseFor(account, project) };
    ensure(profile, `Unknown provider ${account}. Choose ${Object.keys(PROVIDERS).join(", ")}.`);
    const find = (title) => shell.threads.filter((t) => t.projectId === projects[0].id && t.title.toLowerCase() === title);
    const bases = find(profile.base);
    const pending = find(`${profile.base}_refresh`);
    ensure(bases.length <= 1 && pending.length <= 1, `Duplicate ${profile.base} or refresh sessions; resolve them before refreshing.`);
    const old = bases[0];
    ensure(!old || idle(old), `${profile.base} is busy; wait before refreshing.`);
    const source = old ?? pending[0] ?? {
      id: randomUUID(), projectId: projects[0].id, title: profile.base,
      modelSelection: {
        instanceId: profile.instanceId,
        model: MODELS[profile.models.includes("astra") ? "astra" : profile.models[0]].slug,
        options: profile.models.includes("opus") ? [{ id: "contextWindow", value: "1m" }, { id: "fastMode", value: false }] : [],
      },
      runtimeMode: "full-access", interactionMode: "default", branch: "main", worktreePath: null,
    };
    ensure(source.modelSelection.instanceId === profile.instanceId, `${profile.base} uses another account; resolve its settings first.`);
    const model = profile.models.find((key) => MODELS[key].slug === source.modelSelection.model);
    ensure(model, `${profile.base} uses an unsupported model: ${source.modelSelection.model}.`);
    const threadId = pending[0]?.id ?? randomUUID();
    const plan = planFork({ ...shell, threads: [{ ...source, id: "refresh-template", title: profile.base }, ...shell.threads.filter((t) => t.id !== old?.id)] }, config, {
      project, provider: account, model, threadId, sourceThreadId: "refresh-template", name: `${profile.base}_refresh`, task: BASE_PROMPT,
    });
    return { ...plan, base: profile.base, oldId: old?.id ?? null, oldTurnId: old?.latestTurn?.turnId ?? null,
      prompt: prompt ?? projectProfile(project)?.basePrompt ?? BASE_PROMPT, oldSelection: old?.modelSelection ?? null };
  });
}

const answered = (thread) => idle(thread) && thread.messages.some((m) => m.role === "assistant" && m.text?.trim());

export async function refreshBase(client, plan, emit = () => {}) {
  const snapshot = await client.http("/api/orchestration/shell");
  const existing = snapshot.threads.find((t) => t.id === plan.threadId);
  if (!existing) {
    await client.dispatch({ type: "thread.create", commandId: `base:${plan.threadId}:create`, threadId: plan.threadId,
      projectId: plan.projectId, title: plan.name, modelSelection: plan.modelSelection,
      runtimeMode: plan.runtimeMode, interactionMode: plan.interactionMode,
      branch: plan.branch, worktreePath: plan.worktreePath, createdAt: new Date().toISOString() });
  }
  const fresh = await client.thread(plan.threadId);
  ensure(fresh.projectId === plan.projectId && fresh.title === plan.name && selectionKey(fresh.modelSelection) === selectionKey(plan.modelSelection)
    && fresh.runtimeMode === plan.runtimeMode && fresh.interactionMode === plan.interactionMode
    && fresh.branch === plan.branch && fresh.worktreePath === plan.worktreePath,
  `${plan.name} has different settings; inspect it before retrying.`);
  const messageId = `base:${plan.threadId}:prompt`;
  const users = fresh.messages.filter((m) => m.role === "user");
  ensure(users.length === 0 || (users.length === 1 && users[0].id === messageId && users[0].text === (plan.prompt ?? BASE_PROMPT)), `${plan.name} contains other prompts; inspect it before retrying.`);
  if (!users.length) {
    ensure(idle(fresh), `${plan.name} is busy without the expected prompt.`);
    await client.dispatch({ type: "thread.turn.start", commandId: `base:${plan.threadId}:start`, threadId: plan.threadId,
      message: { messageId, role: "user", text: plan.prompt ?? BASE_PROMPT, attachments: [] }, modelSelection: plan.modelSelection,
      runtimeMode: plan.runtimeMode, interactionMode: plan.interactionMode, createdAt: new Date().toISOString() });
  }
  emit({ phase: "preparing", base: plan.base, threadId: plan.threadId });
  if (!(users.length && answered(fresh))) await client.waitForTurn(plan, messageId, "completed");
  const completed = await client.thread(plan.threadId);
  ensure(answered(completed), `${plan.name} has no finished response or still has background work; old base retained.`);
  await client.dispatch({ type: "thread.pin", commandId: `base:${plan.threadId}:pin`, threadId: plan.threadId });
  ensure((await client.thread(plan.threadId)).pinnedAt, `Could not pin ${plan.name}; old base retained.`);
  const shell = await client.http("/api/orchestration/shell");
  const matches = shell.threads.filter((t) => t.projectId === plan.projectId && t.title.toLowerCase() === plan.base);
  ensure(matches.length === (plan.oldId ? 1 : 0) && (!plan.oldId || matches[0].id === plan.oldId), `${plan.base} changed during refresh; old base retained.`);
  if (plan.oldId) {
    const old = await client.thread(plan.oldId);
    ensure(idle(old) && (old.latestTurn?.turnId ?? null) === plan.oldTurnId && selectionKey(old.modelSelection) === selectionKey(plan.oldSelection), `${plan.base} changed or became busy; old base retained.`);
    await client.dispatch({ type: "thread.delete", commandId: `base:${plan.threadId}:delete-old`, threadId: plan.oldId });
  }
  await client.dispatch({ type: "thread.meta.update", commandId: `base:${plan.threadId}:promote`, threadId: plan.threadId, title: plan.base });
  const promoted = await client.thread(plan.threadId);
  ensure(promoted.title === plan.base && promoted.pinnedAt, `Could not rename ${plan.threadId} to ${plan.base}.`);
  emit({ phase: "ready", base: plan.base, threadId: plan.threadId, deletedThreadId: plan.oldId });
}

async function main() {
  const { values } = parseArgs({ options: {
    apply: { type: "boolean", default: false }, provider: { type: "string", multiple: true },
    project: { type: "string" }, prompt: { type: "string" }, server: { type: "string" }, home: { type: "string" }, cli: { type: "string" },
    timeout: { type: "string", default: "600" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log('Usage: node refresh-bases.mjs [--apply] [--provider XL ...] [--project PATH] [--prompt TEXT] [--timeout SECONDS] [--server URL] [--home PATH] [--cli PATH]\nDefault previews all bases. --apply starts fresh sessions with "understand project" (or a project profile basePrompt, or --prompt), waits for each response, deletes each old T3 base and assigns its name to the pinned replacement. Existing forks are untouched. Failed preparations retain the old base and a *_base_refresh session for retry.');
    return;
  }
  const timeout = Number(values.timeout);
  ensure(timeout > 0 && timeout <= 600, "--timeout must be between 1 and 600 seconds per base.");
  const project = resolveProject(values.project);
  const options = { server: values.server, home: values.home, cli: values.cli, timeout };
  const client = new T3Client(options);
  let plans;
  try {
    await client.connect();
    const [shell, config] = await Promise.all([client.http("/api/orchestration/shell"), client.rpc("server.getConfig", {}).promise]);
    plans = planRefresh(shell, config, { project, prompt: values.prompt, providers: values.provider ? [...new Set(values.provider.map((p) => p.toUpperCase()))] : undefined });
  } finally { await client.close(); }
  const emit = (value) => console.log(JSON.stringify(value));
  for (const plan of plans) emit({ phase: "preview", base: plan.base, oldId: plan.oldId, threadId: plan.threadId, modelSelection: plan.modelSelection, prompt: plan.prompt });
  if (!values.apply) return;
  for (const plan of plans) {
    const connection = new T3Client(options);
    try { await connection.connect(); await refreshBase(connection, plan, emit); }
    catch (error) { throw new Error(`${plan.base} (${plan.threadId}): ${error.message} Stopped; inspect this session before retrying with --provider ${plan.provider}.`); }
    finally { await connection.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
