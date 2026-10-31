// Orchestration protocol 2 (T3 V2) adapter. The scripts were written against the V1 shell,
// thread and command shapes; on a V2 server T3Client runs everything through these functions,
// so each script keeps one code path for both. V1 servers never reach this file's functions.

export const PROTOCOL_HEADER = "x-t3-orchestration-protocol";
export const PROTOCOL_QUERY = "orchestrationProtocol";

/** V2 servers describe themselves at /.well-known/t3/environment; servers without the field are V1. */
export const protocolOf = (descriptor) => (descriptor?.orchestrationProtocolVersion === 2 ? 2 : 1);

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const STARTING = new Set(["preparing", "queued", "starting"]);
const TURN_STATE = { completed: "completed", failed: "error", interrupted: "interrupted", cancelled: "interrupted", rolled_back: "interrupted" };
const turnState = (status) => TURN_STATE[status] ?? "running";

/** The V1 `session` object: what the thread's provider is doing now. */
function sessionOf({ status, providerInstanceId, activeRunId, lastError }) {
  const active = ACTIVE.has(status);
  return {
    status: active ? (STARTING.has(status) ? "starting" : "running") : lastError && status === "failed" ? "error" : "ready",
    providerInstanceId: providerInstanceId ?? null,
    activeTurnId: active ? (activeRunId ?? null) : null,
    lastError: lastError ?? null,
  };
}

const settledAtOf = (thread) => (thread.settledOverride === "active" ? null : thread.settledAt ?? null);

/** A V2 shell thread as the V1 shell entry the scripts read. */
export function normalizeShellThread(thread) {
  const status = thread.status ?? "idle";
  const lastError = thread.lastError ?? null;
  const request = thread.pendingRuntimeRequest;
  return {
    id: thread.id, projectId: thread.projectId, title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode,
    branch: thread.branch ?? null, worktreePath: thread.worktreePath ?? null,
    createdAt: thread.createdAt, updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt ?? null, deletedAt: thread.deletedAt ?? null,
    settledAt: settledAtOf(thread), pinnedAt: thread.pinnedAt ?? null, isBase: false,
    usageLimitResetAt: thread.usageLimitResetAt ?? null,
    session: sessionOf({ status, providerInstanceId: thread.providerInstanceId, activeRunId: thread.activeRunId, lastError }),
    latestTurn: thread.latestRunId ? {
      turnId: thread.latestRunId,
      state: ACTIVE.has(status) ? "running" : lastError ? "error" : "completed",
      requestedAt: thread.latestRunRequestedAt ?? null, startedAt: thread.latestRunStartedAt ?? null,
      completedAt: thread.latestRunCompletedAt ?? null,
    } : null,
    hasPendingApprovals: Boolean(request) && request.kind !== "user_input",
    hasPendingUserInput: request?.kind === "user_input",
    backgroundLiveness: thread.pendingBackgroundTasks?.length ? { tasks: thread.pendingBackgroundTasks.length } : null,
  };
}

/** `threads` are the active ones, as in V1; archived shells come from normalizeArchived. */
export function normalizeShell(shell) {
  return { projects: shell.projects, threads: shell.threads.map(normalizeShellThread) };
}

export function normalizeArchived(archived) {
  return { projects: archived.projects ?? [], threads: (archived.threads ?? archived.archivedThreads ?? []).map(normalizeShellThread) };
}

/** `GET /api/orchestration/threads/:id` of a V2 server as the V1 thread with its messages. */
export function normalizeThread(detail) {
  const { thread, runs, messages, providerSessions } = detail.projection;
  const latest = [...runs].sort((a, b) => a.ordinal - b.ordinal).at(-1);
  const status = latest?.status ?? "idle";
  const session = sessionOf({ status, providerInstanceId: latest?.providerInstanceId ?? thread.providerInstanceId, activeRunId: latest?.id });
  return {
    id: thread.id, projectId: thread.projectId, title: thread.title, modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode,
    branch: thread.branch ?? null, worktreePath: thread.worktreePath ?? null,
    createdAt: thread.createdAt, updatedAt: thread.updatedAt, archivedAt: thread.archivedAt ?? null, deletedAt: thread.deletedAt ?? null,
    settledAt: settledAtOf(thread), pinnedAt: thread.pinnedAt ?? null, isBase: false,
    // The per-run user message ties a turn to the assignment that started it.
    messages: messages.filter((m) => m.role !== "system").map((m) => ({ id: m.id, role: m.role, text: m.text, createdAt: m.createdAt, turnId: m.runId })),
    session: { ...session, providerInstanceId: session.providerInstanceId ?? providerSessions?.at(-1)?.providerInstanceId ?? null },
    latestTurn: latest ? { turnId: latest.id, state: turnState(latest.status), requestedAt: latest.requestedAt,
      startedAt: latest.startedAt ?? latest.workStartedAt ?? null, completedAt: latest.completedAt ?? null, userMessageId: latest.userMessageId } : null,
    // Only a limit reached by the latest run is reported; V1 kept the whole activity log.
    usageLimitResetAt: thread.limitRecovery?.resetAt ?? null,
    activities: [],
    backgroundLiveness: null,
    runs,
  };
}

const creation = { createdBy: "agent", creationSource: "mcp" };

/** The V2 commands for a V1 dispatch body, each with a command ID derived from the original so retries stay idempotent. */
export function translateCommand(command) {
  const { commandId, threadId } = command;
  switch (command.type) {
    case "thread.create":
      return [{ type: "thread.create", ...creation, commandId, threadId, projectId: command.projectId, title: command.title,
        modelSelection: command.modelSelection, runtimeMode: command.runtimeMode, interactionMode: command.interactionMode,
        branch: command.branch ?? null, worktreePath: command.worktreePath ?? null }];
    case "thread.meta.update":
      if (command.isBase) throw new Error("This T3 server has no Base sessions; refresh-bases needs a server with the baseSessions capability.");
      return [
        ...(command.title === undefined ? [] : [{ type: "thread.metadata.update", commandId: `${commandId}:title`, threadId, title: command.title }]),
        ...(command.modelSelection === undefined ? [] : [{ type: "thread.model-selection.set", commandId: `${commandId}:model`, threadId, modelSelection: command.modelSelection }]),
      ];
    case "thread.turn.start":
      return [{ type: "message.dispatch", ...creation, commandId, threadId, messageId: command.message.messageId, text: command.message.text,
        attachments: command.message.attachments ?? [], modelSelection: command.modelSelection, dispatchMode: { type: "start_immediately" } }];
    case "thread.settle": case "thread.delete": case "thread.pin": case "thread.unpin": case "thread.archive": case "thread.unarchive":
      return [{ type: command.type, commandId, threadId }];
    default:
      throw new Error(`This script cannot send ${command.type} to a T3 server with orchestration protocol 2.`);
  }
}

export const forkCommand = ({ sourceThreadId, threadId }) => ({
  type: "thread.fork", ...creation, commandId: `fork:${threadId}`, sourceThreadId, targetThreadId: threadId, sourcePoint: { type: "latest_stable" },
});
