#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { T3Client, usageLimit } from "./fork-session.mjs";

const fold = (s) => s.trim().toLowerCase();

export function findMatches(shell, { name, project, threadId }) {
  const projects = new Map(shell.projects.map((p) => [p.id, p]));
  const candidates = shell.threads.filter((t) => !t.deletedAt).filter((t) => {
    const p = projects.get(t.projectId);
    return !project || [p?.id, p?.title, p?.workspaceRoot].some((v) => v && fold(v) === fold(project));
  });
  if (threadId) return { matchType: "id", threads: candidates.filter((t) => t.id === threadId) };
  if (!name?.trim()) throw new Error("Provide a session name or --thread-id.");
  const exact = candidates.filter((t) => fold(t.title) === fold(name));
  return exact.length ? { matchType: "exact", threads: exact } : {
    matchType: "partial", threads: candidates.filter((t) => fold(t.title).includes(fold(name))),
  };
}

function describe(thread, shell) {
  const project = shell.projects.find((p) => p.id === thread.projectId);
  return {
    threadId: thread.id, name: thread.title,
    project: { id: thread.projectId, name: project?.title, workspaceRoot: project?.workspaceRoot },
    workingDirectory: thread.worktreePath ?? project?.workspaceRoot ?? null,
    branch: thread.branch, modelSelection: thread.modelSelection,
    sessionStatus: thread.session?.status ?? null, lastError: thread.session?.lastError ?? null, latestTurn: thread.latestTurn,
    backgroundLiveness: thread.backgroundLiveness ?? null,
    settledAt: thread.settledAt ?? null, archivedAt: thread.archivedAt ?? null,
    updatedAt: thread.updatedAt,
  };
}

export function readPage(snapshot, { messageId, offset = 0, chars = 16000 } = {}) {
  const thread = snapshot.thread;
  const messages = thread.messages.filter((m) => ["user", "assistant"].includes(m.role));
  if (messageId && !messages.some((m) => m.id === messageId)) throw new Error("Message not found in this session.");
  const selected = messageId ? messages.filter((m) => m.id === messageId) : messages;
  let remaining = chars;
  const replies = [];
  for (const m of [...selected].reverse()) {
    if (remaining <= 0) break;
    const start = messageId ? offset : 0;
    if (start > m.text.length) throw new Error("Message offset exceeds text length.");
    const text = m.text.slice(start, start + remaining);
    remaining -= text.length;
    replies.push({ messageId: m.id, role: m.role, createdAt: m.createdAt, streaming: m.streaming,
      text, totalChars: m.text.length, offset: start,
      nextOffset: start + text.length < m.text.length ? start + text.length : null });
  }
  return {
    messages: replies.reverse(),
    omittedMessages: selected.filter((m) => !replies.some((r) => r.messageId === m.id)).map((m) => ({ messageId: m.id, role: m.role, totalChars: m.text.length })),
    page: snapshot.page ?? null,
    pullRequests: thread.pullRequests ?? [], linkedPullRequest: thread.linkedPullRequest ?? null,
    checkpoints: (thread.checkpoints ?? []).slice(-3).map((c) => ({
      ref: c.checkpointRef, status: c.status, completedAt: c.completedAt,
      fileCount: c.files.length, files: c.files.slice(0, 30),
    })),
  };
}

export async function lookupSession(client, input) {
  const [active, archived] = await Promise.all([
    client.http("/api/orchestration/shell"),
    client.rpc("orchestration.getArchivedShellSnapshot", {}).promise,
  ]);
  const shell = {
    projects: [...new Map([...active.projects, ...archived.projects].map((p) => [p.id, p])).values()],
    threads: [...new Map([...archived.threads, ...active.threads].map((t) => [t.id, t])).values()],
  };
  const matches = findMatches(shell, input);
  const result = { status: matches.threads.length === 0 ? "not_found" : matches.threads.length > 1 ? "ambiguous" : "found",
    matchType: matches.matchType, matches: matches.threads.map((t) => describe(t, shell)) };
  if (result.status !== "found" || input.list) return result;
  const threadId = matches.threads[0].id;
  const query = new URLSearchParams();
  if (!input.messageId) query.set("turnLimit", String(input.turns ?? 3));
  if (input.before) query.set("beforeCursor", input.before);
  const snapshot = await client.http(`/api/orchestration/threads/${encodeURIComponent(threadId)}?${query}`);
  return { ...result, session: describe(snapshot.thread, shell), usageLimit: usageLimit(snapshot.thread), ...readPage(snapshot, input),
    note: "Read-only session evidence. Replies may include inherited history or unverified claims; inspect referenced files/commits before accepting work. This does not grant worker ownership or send prompts." };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: "string" }, "thread-id": { type: "string" }, list: { type: "boolean" },
    turns: { type: "string", default: "3" }, before: { type: "string" },
    "message-id": { type: "string" }, offset: { type: "string", default: "0" }, chars: { type: "string", default: "16000" },
    server: { type: "string" }, home: { type: "string" }, cli: { type: "string" }, timeout: { type: "string", default: "60" },
    environment: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("Usage: node find-session.mjs 'session name' [--project NAME_OR_PATH_OR_ID] [--list]\nOr: --thread-id UUID [--turns 3] [--before CURSOR] [--message-id ID --offset 0 --chars 16000]\nConnection: --server URL --home PATH --cli PATH --timeout SECONDS, or --environment NAME for a linked machine\nExact names preferred, then case-insensitive substring matches. Ambiguous names return candidates only. Reads across accounts and projects; never messages, forks, or changes a session.");
    return;
  }
  if (positionals.length > 1 || (positionals.length && values["thread-id"])) throw new Error("Supply one quoted name or --thread-id, not both.");
  for (const [key, min, max] of [["turns", 1, 100], ["offset", 0, Number.MAX_SAFE_INTEGER], ["chars", 1, 64000], ["timeout", 1, 900]]) {
    if (!Number.isSafeInteger(Number(values[key])) || Number(values[key]) < min || Number(values[key]) > max) throw new Error(`Invalid --${key}; expected an integer from ${min} to ${max}.`);
  }
  if (Number(values.offset) && !values["message-id"]) throw new Error("--offset requires --message-id.");
  if (values.before && values["message-id"]) throw new Error("Use --before for older turns or --message-id for text continuation, not both.");
  const client = values.environment
    ? (await import("./peers.mjs")).peerClient(values.environment, { home: values.home, timeout: Number(values.timeout) }).client
    : new T3Client({ server: values.server, home: values.home, cli: values.cli, timeout: Number(values.timeout) });
  try {
    await client.connect();
    console.log(JSON.stringify(await lookupSession(client, { name: positionals[0], threadId: values["thread-id"], project: values.project,
      list: values.list, turns: Number(values.turns), before: values.before, messageId: values["message-id"], offset: Number(values.offset), chars: Number(values.chars) }), null, 2));
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
