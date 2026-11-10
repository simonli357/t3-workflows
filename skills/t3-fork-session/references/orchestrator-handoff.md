# Switch, renew, hand off, reclaim

Each keyword below authorizes the action without further questions. Keep every
profile constraint the user did not change.

## "switch WORKER to ACCOUNT [model] [effort]"

Keeps the session and its conversation.

1. `t3w worker-profile --thread-id ID --provider ACCOUNT [--model M] [--effort E]
   [--environment PEER]` validates without changing anything. Omitted values stay.
2. Pass its JSON to `t3_worker_control`.

A running turn finishes on the old profile. A turn that already stopped is not
retried: resume it with `t3_worker_send`. An assignment queued behind a usage
limit starts on the new account at once. Another provider receives a summary, not
the native history. The title keeps its old model suffix.

## "renew WORKER [on ACCOUNT [model]]"

Replaces the worker with a new session, fresh unless the user says "from base".

1. Wait until the worker has no running turn (the user can Stop it).
2. Write its full assignment, progress, branch and worktree, evidence and next
   steps to a file, with the 5-minute wait line and only rules the user gave.
3. Start the replacement as any new worker (`t3w fork --mcp-plan` for "from base").
   If the name would not change, add 2 to the keyword (`c344_camera_opus` →
   `c344_camera2_opus`).
4. Settle the old worker.

## "renew yourself"

Hands this master and its workers to a successor. Defaults: same project, account,
model and effort; fresh context; the title's generation number incremented, or 2
appended (`simulator7_es_master` → `simulator8_es_master`, `vio_stream_res_bug` →
`vio_stream_res_bug2`). "From base" forks the account's base. The successor must
be on this computer.

A working-time warning does not require this. When automatic renewal is enabled
T3 starts the successor itself: never create a competing one.

1. Act on reports that need a decision now, or list them in the prompt.
2. Write the prompt below to a temporary file.
3. With one ID from `node -p 'crypto.randomUUID()'`, run
   `t3w spawn --handoff-plan --project P --provider ACCOUNT --model MODEL --name TITLE --thread-id ID --task-file FILE`
   (`t3w fork --handoff-plan` for base; `--effort` selects another effort). Use
   `--self-fork` only when the user asks to keep the full history: it copies what
   renewal is meant to shed. After scheduling a self-fork, end the turn.
4. Pass the JSON unchanged to `t3_orchestrator_handoff`.
5. Give the user the successor's title and ID, stop guards that wake this
   session, and end the turn.

Results: `completed` means the workers moved and the successor's first turn is
queued, not that it ran. Check `startupState` and `startupError`; on a startup
failure resume that same session, never start another successor. `queued` means
this session is still busy. `error` keeps the old ownership: fix the cause and
retry the identical input and ID. `t3_orchestrator_handoff_status` inspects a
handoff, or cancels it before ownership moves.

Afterwards the workers and their future reports belong to the successor. Do not
forward stray messages to it or to past masters. If the user gives this session
new work, create and supervise new workers directly, without asking and without
reclaiming.

### Prompt

One to three pages. Point to files, branches, PRs and reports instead of pasting
them. Carry over only instructions the user gave, quoted where wording matters;
label your own decisions as yours.

```text
You are <successor title> (<successor ID>), the new master, taking over from
<old title> (<old ID>). Its workers are now yours and report to you.

Objective: the user's goal in their words, and what finished means.
Standing instructions, only as the user gave them: permissions, approvals needed,
  account/budget rules with expiry, anything the user ruled out.
Decisions so far, with reasons, so they are not reopened.
Workers, one line each: title, ID, environment, account/model, assignment, state,
  next check.
Peers you coordinate with: title, ID, environment, what they expect.
Open items and next actions, in order.
Evidence: paths to reports, branches, PRs, logs.
Guards that wake the master, with the command to restart them for <successor ID>.
```

The successor lists its workers and reads them before any follow-up, restarts the
guards, and sends a peer its new ID only when coordination requires it. It does
not announce the change to workers or past masters.

## "reclaim WORKERS"

A former master takes back selected workers it handed off: call
`t3_worker_reclaim` with `workerThreadIds` and a stable `clientRequestId`. No
user approval is needed. The successor keeps its other workers. Running work is
not interrupted and nothing new is sent, so read each worker before following up.

## Assign, transfer or release ownership

Read `t3_session_ownership_read`, then call `t3_session_ownership` with the
current owner and revision, the target owner (null to release) and a stable
request ID. No user approval is needed. The worker's computer and the new owner
must be online. Retry an uncertain response with the same request and ID.
