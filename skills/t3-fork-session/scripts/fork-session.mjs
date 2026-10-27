#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { accounts, models, settings, resolveProject, baseFor } from "./config.mjs";
export const PROVIDERS = accounts;
export const MODELS = models;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function single(items, description) {
  requireValue(items.length === 1, `Expected one ${description}; found ${items.length}.`);
  return items[0];
}

// Projects in another environment may use that machine's path style, e.g. C:\Users\me.
function sameWorkspace(root, wanted, remote) {
  if (!remote) return path.resolve(root) === path.resolve(wanted);
  const norm = (value) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(root) === norm(wanted);
}

function sameSelection(left, right) {
  const options = (value) => JSON.stringify([...(value.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)));
  return left.instanceId === right.instanceId && left.model === right.model && options(left) === options(right);
}

export function planFork(shell, config, input) {
  requireValue(!input.selfFork || (input.handoffPlan && !input.fresh && !input.sourceThreadId), "--self-fork requires --handoff-plan and cannot combine with --fresh or --source-thread.");
  requireValue(!(input.fresh && input.sourceThreadId), "Choose a fresh session or --source-thread, not both.");
  if (input.handoffPlan) requireValue(config.environment?.capabilities?.orchestratorHandoff === true,
    "This T3 server needs orchestratorHandoff support before preparing a handoff.");
  if (input.fresh && input.mcpPlan) requireValue(config.environment?.capabilities?.workerFreshSessions === true,
    "This T3 server does not support managed fresh sessions yet. Activate a build with workerFreshSessions support; do not substitute an unmanaged session.");
  const providerName = input.provider?.toUpperCase();
  const choice = PROVIDERS[providerName];
  requireValue(choice, `Select a provider: ${Object.keys(PROVIDERS).join(", ")}.`);
  const modelName = Object.keys(MODELS).find((key) => key === input.model || MODELS[key].slug === input.model);
  requireValue(choice.models.includes(modelName), `Provider ${providerName} supports: ${choice.models.join(", ")}.`);
  requireValue(input.name?.trim(), "A worker name is required.");
  requireValue(input.task?.trim(), "A nonempty task is required.");
  requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.threadId), "Destination thread ID must be a UUID.");
  const remote = Boolean(input.environment);
  if (remote && input.mcpPlan) requireValue(config.environment?.capabilities?.peerEnvironments === true && input.localPeerEnvironments === true,
    "Both environments need a build with peerEnvironments support before linking workers across them.");
  const project = single(shell.projects.filter((p) => (remote && [p.id, p.title].includes(input.project)) || sameWorkspace(p.workspaceRoot, input.project, remote)), "T3 project for this workspace");
  const sourceName = input.sourceThreadId ?? baseFor(providerName, input.project);
  const source = (input.fresh || input.selfFork) ? null : single(shell.threads.filter((t) => t.projectId === project.id && (input.sourceThreadId ? t.id === input.sourceThreadId : t.title.toLowerCase() === baseFor(providerName, input.project))), `${sourceName} in ${project.title}`);
  if (source) {
    requireValue(source.id !== input.threadId, "The destination must differ from the source session.");
    requireValue(input.handoffPlan || source.modelSelection.instanceId === choice.instanceId, `${source.title} belongs to another provider instance.`);
  }
  const provider = single(config.providers.filter((p) => p.instanceId === choice.instanceId), `configured ${providerName} provider`);
  requireValue(provider.enabled && provider.installed && provider.availability !== "unavailable", `Provider ${providerName} is disabled or unavailable.`);
  const profile = MODELS[modelName];
  const model = single(provider.models.filter((m) => m.slug === profile.slug), `${profile.slug} model for ${providerName}`);
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const chosenEffort = input.effort ?? profile.effort;
  const effort = descriptors.find((d) => d.id === profile.option);
  requireValue(effort?.options?.some((o) => o.id === chosenEffort), `${profile.slug} does not advertise ${chosenEffort} effort.`);
  const options = (source?.modelSelection.options ?? []).filter((o) => {
    const descriptor = descriptors.find((d) => d.id === o.id);
    return descriptor && o.id !== profile.option && (descriptor.type !== "select" || descriptor.options.some((v) => v.id === o.value));
  });
  options.push({ id: profile.option, value: chosenEffort });
  const destination = shell.threads.find((t) => t.id === input.threadId);
  if (source && !destination && !input.handoffPlan) {
    requireValue(!source.session?.activeTurnId && source.session?.status !== "starting" && source.latestTurn?.state !== "running", `${source.title} is busy; wait for its turn to finish.`);
  }
  return {
    ...(input.selfFork ? { selfFork: true } : {}),
    ...(remote ? { environment: input.environment } : {}),
    threadId: input.threadId, sourceThreadId: source?.id ?? null, base: source?.title ?? null,
    projectId: project.id, project: project.workspaceRoot, name: input.name.trim(),
    provider: providerName, modelSelection: { instanceId: choice.instanceId, model: profile.slug, options },
    effort: chosenEffort, runtimeMode: source?.runtimeMode ?? input.runtimeMode ?? "approval-required",
    interactionMode: source?.interactionMode ?? input.interactionMode ?? "default",
    branch: source?.branch ?? null, worktreePath: source?.worktreePath ?? null,
  };
}

export class T3Client {
  constructor({ server = process.env.T3_FORK_SERVER_URL ?? settings.connection?.server ?? "http://127.0.0.1:3773", home = process.env.T3CODE_HOME ?? settings.connection?.home ?? path.join(homedir(), ".t3"), cli = process.env.T3_FORK_CLI ?? settings.connection?.cli ?? "t3", timeout = 180, token } = {}) {
    this.server = server.replace(/\/$/, "");
    this.home = home;
    this.cli = cli;
    this.timeout = timeout * 1000;
    this.token = token ?? process.env.T3_FORK_TOKEN;
    this.requests = new Map();
    this.nextId = 0;
  }

  async connect() {
    if (!this.token) {
      const issued = JSON.parse(execFileSync(this.cli, ["auth", "session", "issue", "--base-dir", this.home, "--ttl", "15m", "--label", "T3 fork skill", "--json"], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }));
      this.token = issued.token;
      this.authSessionId = issued.sessionId;
    }
    const { ticket } = await this.http("/api/auth/websocket-ticket", {});
    const url = new URL("/ws", this.server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket);
    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", (event) => {
      try { this.receive(JSON.parse(event.data)); }
      catch (error) { this.failPending(error); }
    });
    this.socket.addEventListener("close", () => this.failPending(new Error("T3 WebSocket closed; reuse the same destination ID when retrying.")));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("T3 WebSocket connection timed out.")), 15000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Could not connect to the authenticated T3 WebSocket.")); }, { once: true });
    });
  }

  receive(data) {
    for (const message of Array.isArray(data) ? data : [data]) {
      const request = this.requests.get(String(message.requestId));
      if (!request) continue;
      if (message._tag === "Chunk") {
        for (const value of message.values) request.onValue?.(value);
        this.socket.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
      } else if (message._tag === "Exit") {
        this.requests.delete(String(message.requestId));
        clearTimeout(request.timer);
        if (message.exit._tag === "Success") request.resolve(message.exit.value);
        else request.reject(new Error(JSON.stringify(message.exit.cause)));
      }
    }
  }

  failPending(error) {
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error); }
    this.requests.clear();
  }

  rpc(tag, payload, onValue) {
    const id = String(++this.nextId);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`T3 ${tag} timed out; reuse the same destination ID when retrying.`));
      }, this.timeout);
      this.requests.set(id, { resolve, reject, timer, onValue });
      this.socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
    return { id, promise };
  }

  async http(route, body) {
    const response = await fetch(this.server + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeout),
    });
    const text = await response.text();
    requireValue(response.ok, `T3 ${route} failed (HTTP ${response.status}): ${text}`);
    return JSON.parse(text);
  }

  async thread(id) { return (await this.http(`/api/orchestration/threads/${encodeURIComponent(id)}`)).thread; }
  async dispatch(command) { return this.http("/api/orchestration/dispatch", command); }
  async fork(input) { return this.rpc("agentSessions.fork", input).promise; }

  async waitForTurn(plan, messageId, wait) {
    let subscription;
    let refreshing = false;
    let dirty = false;
    let settled = false;
    let timer;
    const result = new Promise((resolve, reject) => {
      const refresh = async () => {
        if (settled) return;
        if (refreshing) { dirty = true; return; }
        refreshing = true;
        try {
          do {
            dirty = false;
            const thread = await this.thread(plan.threadId);
            const task = thread.messages.find((m) => m.id === messageId);
            const turn = thread.latestTurn;
            const matchingTurn = task && turn?.requestedAt === task.createdAt;
            const failure = thread.session?.lastError || (matchingTurn && turn.state === "error" ? "Provider turn failed." : null);
            if (failure) throw new Error(failure);
            if (matchingTurn && turn.state === "interrupted") throw new Error("Worker turn was interrupted.");
            if (matchingTurn && turn.startedAt && (wait !== "completed" || turn.state === "completed")) {
              requireValue(sameSelection(thread.modelSelection, plan.modelSelection), "Worker started with a different model or effort.");
              requireValue(thread.session?.providerInstanceId === plan.modelSelection.instanceId, "Worker started under a different provider account.");
              settled = true;
              resolve({ threadId: plan.threadId, name: thread.title, provider: plan.provider, model: thread.modelSelection.model, effort: plan.effort, state: turn.state === "completed" ? "completed" : "started", turnId: turn.turnId });
              return;
            }
          } while (dirty && !settled);
        } catch (error) { settled = true; reject(error); }
        finally { refreshing = false; }
      };
      timer = setTimeout(() => { settled = true; reject(new Error(`Worker did not reach '${wait}' within ${this.timeout / 1000}s. Reuse destination ${plan.threadId}; its task may already be saved.`)); }, this.timeout);
      subscription = this.rpc("orchestration.subscribeThread", { threadId: plan.threadId, requestCompletionMarker: true, turnLimit: 1 }, refresh);
      subscription.promise.catch((error) => { if (!settled) { settled = true; reject(error); } });
      void refresh();
    });
    try { return await result; }
    finally {
      clearTimeout(timer);
      if (subscription) {
        this.socket.send(JSON.stringify({ _tag: "Interrupt", requestId: subscription.id, interruptors: [] }));
        const request = this.requests.get(subscription.id);
        if (request) { clearTimeout(request.timer); request.resolve(); this.requests.delete(subscription.id); }
      }
    }
  }

  async close() {
    this.failPending(new Error("T3 client closed."));
    this.socket?.close();
    if (this.authSessionId) execFileSync(this.cli, ["auth", "session", "revoke", "--base-dir", this.home, this.authSessionId], { timeout: 30000, stdio: "ignore" });
  }
}

export async function runFork(client, input, emit = () => {}) {
  const [shell, config] = await Promise.all([client.http("/api/orchestration/shell"), client.rpc("server.getConfig", {}).promise]);
  const plan = planFork(shell, config, input);
  emit({ phase: input.dryRun ? "dry-run" : "planned", ...plan });
  if (input.dryRun) return plan;
  const messageId = `worker:${plan.threadId}:task`;
  const existing = shell.threads.some((t) => t.id === plan.threadId) ? await client.thread(plan.threadId) : null;
  requireValue(!existing || existing.projectId === plan.projectId, "This destination belongs to another project.");
  const accepted = existing?.messages.find((m) => m.id === messageId);
  if (accepted) {
    requireValue(accepted.text === input.task && existing.title === plan.name && sameSelection(existing.modelSelection, plan.modelSelection), "This destination already has a different task, name, or model. Do not reuse its ID.");
  } else {
    if (plan.sourceThreadId) {
      const forked = await client.fork({ sourceThreadId: plan.sourceThreadId, threadId: plan.threadId });
      requireValue(forked.threadId === plan.threadId, "T3 returned a different destination thread ID.");
      await client.dispatch({ type: "thread.meta.update", commandId: `worker:${plan.threadId}:configure`, threadId: plan.threadId, title: plan.name, modelSelection: plan.modelSelection });
    } else if (!existing) {
      await client.dispatch({ type: "thread.create", commandId: `worker:${plan.threadId}:create`, threadId: plan.threadId,
        projectId: plan.projectId, title: plan.name, modelSelection: plan.modelSelection,
        runtimeMode: plan.runtimeMode, interactionMode: plan.interactionMode,
        branch: plan.branch, worktreePath: plan.worktreePath, createdAt: new Date().toISOString() });
    } else {
      requireValue(existing.messages.length === 0 && existing.title === plan.name && sameSelection(existing.modelSelection, plan.modelSelection)
        && existing.runtimeMode === plan.runtimeMode && existing.interactionMode === plan.interactionMode
        && existing.branch === plan.branch && existing.worktreePath === plan.worktreePath,
      "This destination already has different history or settings. Do not reuse its ID.");
    }
    const configured = await client.thread(plan.threadId);
    requireValue(configured.title === plan.name && sameSelection(configured.modelSelection, plan.modelSelection), "T3 did not apply the worker name, model, and effort.");
    await client.dispatch({
      type: "thread.turn.start", commandId: `worker:${plan.threadId}:start`, threadId: plan.threadId,
      message: { messageId, role: "user", text: input.task, attachments: [] },
      modelSelection: plan.modelSelection, runtimeMode: plan.runtimeMode,
      interactionMode: plan.interactionMode, createdAt: new Date().toISOString(),
    });
  }
  return client.waitForTurn(plan, messageId, input.wait ?? "started");
}

export function usageLimit(thread, now = new Date()) {
  const hit = [...(thread.activities ?? [])].reverse().find((a) => Number.isFinite(a.payload?.detail?.resetsAt));
  if (!hit) return null;
  const resetsAt = new Date(hit.payload.detail.resetsAt * 1000);
  return { rateLimitType: hit.payload.detail.rateLimitType ?? null, resetsAt: resetsAt.toISOString(),
    reportedAt: hit.createdAt, active: resetsAt > now };
}

export function workerInput(plan, task) {
  return { ...(plan.selfFork ? { selfFork: true } : {}), ...(plan.environment ? { environment: plan.environment } : {}), ...(plan.sourceThreadId ? { sourceThreadId: plan.sourceThreadId } : { projectId: plan.projectId }), threadId: plan.threadId,
    title: plan.name, modelSelection: plan.modelSelection, prompt: task };
}

async function main() {
  const { values } = parseArgs({ options: {
    effort: { type: "string" }, "handoff-plan": { type: "boolean", default: false },
    provider: { type: "string" }, model: { type: "string" }, name: { type: "string" },
    task: { type: "string" }, "task-file": { type: "string" }, "thread-id": { type: "string" },
    "source-thread": { type: "string" },
    "self-fork": { type: "boolean", default: false },
    fresh: { type: "boolean", default: false },
    "runtime-mode": { type: "string" }, "interaction-mode": { type: "string" },
    project: { type: "string" }, server: { type: "string" }, home: { type: "string" }, cli: { type: "string" },
    timeout: { type: "string", default: "180" }, wait: { type: "string", default: "started" },
    "mcp-plan": { type: "boolean", default: false }, environment: { type: "string" },
    "dry-run": { type: "boolean", default: false }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("--handoff-plan emits input for t3_orchestrator_handoff, allowing a busy self source and a different destination account. --effort overrides the profile default only when advertised.\nUsage: node fork-session.mjs --provider XL|ES|ARA|AD|SL|DS --model opus|sonnet|sol|astra|flash --name TITLE --task-file FILE [--fresh | --source-thread UUID] [--thread-id UUID] [--dry-run | --mcp-plan] [--wait started|completed] [--timeout SECONDS] [--project PATH] [--server URL] [--home PATH] [--cli PATH]\n--fresh creates an empty session without a base; otherwise fork the explicit source or configured base. Use --task TEXT instead of --task-file; --task-file - accepts stdin. Standalone fresh sessions default to approval-required/default; --runtime-mode and --interaction-mode override them. Managed fresh sessions inherit the master's modes. --environment NAME plans a managed worker on a linked machine (with --mcp-plan; --project is that machine's path, project title or ID). See references/conventions.md for names and fixed effort.");
    return;
  }
  requireValue(Boolean(values.task) !== Boolean(values["task-file"]), "Provide exactly one of --task or --task-file.");
  requireValue(["started", "completed"].includes(values.wait), "--wait must be started or completed.");
  requireValue(Number(values.timeout) > 0 && Number(values.timeout) <= 900, "--timeout must be between 1 and 900 seconds.");
  requireValue(!values["runtime-mode"] || (values.fresh && !values["mcp-plan"] && ["approval-required", "full-access"].includes(values["runtime-mode"])), "--runtime-mode is for standalone fresh sessions: approval-required or full-access.");
  requireValue(!values["interaction-mode"] || (values.fresh && !values["mcp-plan"] && ["default", "plan"].includes(values["interaction-mode"])), "--interaction-mode is for standalone fresh sessions: default or plan.");
  const task = values["task-file"] ? readFileSync(values["task-file"] === "-" ? 0 : values["task-file"], "utf8") : values.task;
  requireValue(!(values["handoff-plan"] && values["mcp-plan"]), "Choose --handoff-plan or --mcp-plan.");
  requireValue(!values.environment || ((values["mcp-plan"] || values["dry-run"]) && !values["handoff-plan"] && values.project),
    "--environment plans a managed worker: use it with --mcp-plan (or --dry-run) and that machine's --project.");
  const input = {
    handoffPlan: values["handoff-plan"], selfFork: values["self-fork"], effort: values.effort, provider: values.provider, model: values.model, name: values.name, task,
    threadId: values["thread-id"] ?? randomUUID(), environment: values.environment,
    project: values.environment ? values.project : resolveProject(values.project, process.cwd(), settings, { fresh: values.fresh || values["self-fork"] }),
    sourceThreadId: values["source-thread"], fresh: values.fresh, mcpPlan: values["mcp-plan"],
    runtimeMode: values["runtime-mode"], interactionMode: values["interaction-mode"],
    dryRun: values["dry-run"] || values["mcp-plan"] || values["handoff-plan"], wait: values.wait };
  const local = new T3Client({ server: values.server, home: values.home, cli: values.cli, timeout: Number(values.timeout) });
  let client = local;
  if (values.environment) {
    await local.connect();
    try { input.localPeerEnvironments = (await local.rpc("server.getConfig", {}).promise).environment.capabilities?.peerEnvironments === true; }
    finally { await local.close(); }
    const { peerClient } = await import("./peers.mjs");
    client = peerClient(values.environment, { home: values.home, timeout: Number(values.timeout) }).client;
  }
  try {
    await client.connect();
    const result = await runFork(client, input, (value) => { if (!values["mcp-plan"] && !values["handoff-plan"]) console.log(JSON.stringify(value)); });
    if (values["mcp-plan"] || values["handoff-plan"]) console.log(JSON.stringify(workerInput(result, input.task)));
    if (!input.dryRun) console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, threadId: input.threadId, retry: "Keep this destination ID and the same task when retrying." }));
    process.exitCode = 1;
  } finally { await client.close(); }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => { console.error(`ERROR ${error.message}`); process.exitCode = 1; });
}
