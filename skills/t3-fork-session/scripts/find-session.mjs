#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { T3Client } from "./fork-session.mjs";

export const DEFAULT_MESSAGES = 3;
export const MAX_MESSAGES = 15;
export const DEFAULT_CHARS = 16000;
export const MAX_CHARS = 64000;
const MIN_CHARS = 2048;

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
  const clip = (value, limit = 512) => typeof value === "string" ? value.slice(0, limit) : value ?? null;
  return {
    threadId: thread.id, name: clip(thread.title, 160),
    project: { id: thread.projectId, name: clip(project?.title, 160), workspaceRoot: clip(project?.workspaceRoot) },
    workingDirectory: clip(thread.worktreePath ?? project?.workspaceRoot),
    branch: clip(thread.branch, 160),
    modelSelection: { instanceId: clip(thread.modelSelection?.instanceId, 100), model: clip(thread.modelSelection?.model, 100) },
    sessionStatus: thread.session?.status ?? null, lastError: clip(thread.session?.lastError),
    latestTurn: thread.latestTurn ? { turnId: thread.latestTurn.turnId, state: thread.latestTurn.state, completedAt: thread.latestTurn.completedAt ?? null } : null,
    settledAt: thread.settledAt ?? null, archivedAt: thread.archivedAt ?? null,
    updatedAt: thread.updatedAt,
  };
}

export async function lookupSession(client, input) {
  const messageLimit = input.messages ?? input.turns ?? DEFAULT_MESSAGES;
  const chars = input.chars ?? DEFAULT_CHARS;
  if (!Number.isSafeInteger(messageLimit) || messageLimit < 1 || messageLimit > MAX_MESSAGES)
    throw new Error(`--messages must be between 1 and ${MAX_MESSAGES}.`);
  if (!Number.isSafeInteger(chars) || chars < MIN_CHARS || chars > MAX_CHARS)
    throw new Error(`--chars must be between ${MIN_CHARS} and ${MAX_CHARS}; it caps the complete JSON response.`);
  if ((input.offset && !input.messageId) || (input.before && input.messageId))
    throw new Error("Use --message-id with --offset, or --before, not both.");
  const [active, archived] = await Promise.all([
    client.http("/api/orchestration/shell"),
    client.rpc("orchestration.getArchivedShellSnapshot", {}).promise,
  ]);
  const shell = {
    projects: [...new Map([...active.projects, ...archived.projects].map((p) => [p.id, p])).values()],
    threads: [...new Map([...archived.threads, ...active.threads].map((t) => [t.id, t])).values()],
  };
  const matches = findMatches(shell, input);
  const status = matches.threads.length === 0 ? "not_found" : matches.threads.length > 1 ? "ambiguous" : "found";
  if (status !== "found" || input.list) {
    const result = { status, matchType: matches.matchType, totalMatches: matches.threads.length,
      matches: matches.threads.slice(0, MAX_MESSAGES).map((t) => describe(t, shell)), hasMoreMatches: matches.threads.length > MAX_MESSAGES };
    while (JSON.stringify(result).length + 1 > chars && result.matches.length) {
      result.matches.pop(); result.hasMoreMatches = true;
    }
    return result;
  }
  const threadId = matches.threads[0].id;
  let metadata = { status, matchType: matches.matchType, session: describe(matches.threads[0], shell) };
  if (JSON.stringify(metadata).length + 1026 > chars)
    metadata = { status, matchType: matches.matchType, session: { threadId } };
  const available = chars - JSON.stringify(metadata).length - 2;
  if (available < 1024) throw new Error("Session metadata exceeds the requested size budget.");
  const query = new URLSearchParams({ messageLimit: String(messageLimit), maxChars: String(available), view: input.includeIntermediate ? "all" : "final" });
  if (input.before) query.set("beforeMessageId", input.before);
  if (input.messageId) query.set("messageId", input.messageId);
  if (input.offset) query.set("offset", String(input.offset));
  let history;
  try { history = await client.http(`/api/orchestration/threads/${encodeURIComponent(threadId)}/messages?${query}`); }
  catch (error) {
    if (/HTTP 404/.test(error.message)) throw new Error("This T3 server needs boundedSessionHistory support. Activate the updated server before reading messages.");
    throw error;
  }
  const result = { ...metadata, ...history };
  if (JSON.stringify(result).length + 1 > chars) throw new Error("The server exceeded the requested history response budget.");
  return result;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: "string" }, "thread-id": { type: "string" }, list: { type: "boolean" },
    messages: { type: "string" }, turns: { type: "string" }, before: { type: "string" },
    "include-intermediate": { type: "boolean", default: false },
    "message-id": { type: "string" }, offset: { type: "string", default: "0" }, chars: { type: "string", default: "16000" },
    server: { type: "string" }, home: { type: "string" }, cli: { type: "string" }, timeout: { type: "string", default: "60" },
    environment: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("Usage: t3w find 'session name' [--project NAME_OR_PATH_OR_ID] [--list]\nOr: --thread-id UUID [--messages 3] [--before MESSAGE_ID] [--message-id ID --offset 0] [--chars 16000] [--include-intermediate]\nDefaults: last 3 individual user prompts/final replies; maximum 15 messages. --chars caps the entire compact JSON response, including metadata (2048..64000). Intermediate assistant messages require --include-intermediate. --turns is a deprecated alias for --messages.\nConnection: --server URL --home PATH --cli PATH --timeout SECONDS, or --environment NAME for a linked machine\nExact names preferred; ambiguous names return bounded candidates only. Requires boundedSessionHistory server support. Offsets count Unicode characters.");
    return;
  }
  if (positionals.length > 1 || (positionals.length && values["thread-id"])) throw new Error("Supply one quoted name or --thread-id, not both.");
  if (values.messages && values.turns) throw new Error("Use --messages or its deprecated --turns alias, not both.");
  for (const [key, min, max] of [["messages", 1, MAX_MESSAGES], ["turns", 1, MAX_MESSAGES], ["offset", 0, Number.MAX_SAFE_INTEGER], ["chars", MIN_CHARS, MAX_CHARS], ["timeout", 1, 900]]) {
    if (values[key] === undefined) continue;
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
      list: values.list, messages: Number(values.messages ?? values.turns ?? DEFAULT_MESSAGES), includeIntermediate: values["include-intermediate"],
      before: values.before, messageId: values["message-id"], offset: Number(values.offset), chars: Number(values.chars) })));
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
