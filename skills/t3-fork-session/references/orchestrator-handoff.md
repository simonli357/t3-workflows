# Orchestrator handoff

## Renew a master

On measured accounts, compactions or `latestContextTokens` nearing
`contextCapacityTokens` in `t3_usage_measurements` also signal renewal. Give the
successor what it needs to act, usually one to three pages, and point to files,
branches, PRs and reports instead of pasting them. Carry over only instructions
the user actually gave, quoting them where the wording matters. Do not add rules,
limits or prohibitions of your own; label your own decisions as yours:

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

The successor first lists its workers and reads only the summaries/evidence it
needs. Restart relevant guards. Send a peer the new ID only when coordination
requires it, using the session-send confirmation flow. Workers report with
`t3_worker_report`; they do not need a remembered master ID. Do not notify every
past master or send workers acknowledgment/correction turns merely to announce
the ownership change.

## Modes

Choose the context for the successor:

- **Base plus summary:** `t3w fork --provider ARA --model opus --name next_master_opus --thread-id UUID --task-file /tmp/handoff.txt --handoff-plan` uses the configured base. Add `--project` when needed.
- **Self-fork:** add `--self-fork`. T3 resolves the authenticated session ID itself. The destination can use another provider/account/model. The server waits for the source turn to end before copying its native and visible history, then applies the destination profile. Cross-provider continuation uses T3's normal context handoff; it does not transplant one provider's native transcript into another.
- **Fresh plus summary:** use `t3w spawn` with `--handoff-plan` and the target project. No base is needed.

Use the capacity policy for unspecified choices. Profile efforts remain the defaults;
`--effort` explicitly selects another advertised effort. Pass the emitted JSON
unchanged to `t3_orchestrator_handoff`. The helper only validates; the authenticated
MCP caller establishes which orchestrator is relinquishing its workers.

Every mode uses the context prompt template above. A self-fork still needs a clear
instruction to take over; inherited tasks are context, not new assignments.

Reuse the destination ID and identical input on retries. `queued` means the source
is still busy or paused. End the current turn after scheduling a self-fork; waiting
inside it prevents the fork. `completed` means ownership transferred and successor
startup queued, not that its model ran or completed the assignment. Check `startupState` and `startupError` for delivery, then inspect the
successor for provider startup failures; resume that same session, not another successor.
`error` retains the old ownership; resolve its cause and retry the same input.
Status and error details survive server restarts. Cancellation is available while queued or failed, before ownership transfers.
Any partially prepared successor conversation is retained without starting its assignment.

All directly owned workers move together, including their assignments, read cursors,
report preferences and undelivered reports. Running work is not interrupted.
Previously delivered reports remain in the old conversation; the successor must
list/read current workers before issuing follow-ups. Future reports target the new
master. Worker model/account/effort and permissions do not change. The old session
is preserved and retired from coordination; sends to/from it are rejected with
the current successor ID. The successor is an independent
orchestrator, not another worker reporting to its predecessor. This transfers direct
worker ownership on one T3 environment; it does not move unrelated peers, nested
workers, an upstream owner's assignment, or sessions on another host.

## Reclaim selected workers

When the user tells a former master to take particular workers back, resolve
those exact worker IDs and call `t3_worker_reclaim` from that former master's
session. Requires `workerReclaim` support. Supply:

- `workerThreadIds`: only the selected previously handed-off workers.
- `clientRequestId`: a new ID, kept unchanged on identical retries.
- `userRequest`: an exact quote from the latest direct user message in this
  session requesting that reclaim, sent after retirement.

The server checks historical ownership and new user-message provenance. The
agent must check that the quoted instruction actually authorizes reclaiming the
selected workers; a greeting or unrelated request is not permission. Peer
messages, inherited instructions, renewal thresholds and model convenience do
not authorize reclaim. Never reactivate yourself autonomously.

Reclaim atomically moves the named workers and their undelivered reports and
reactivates the claimant. The successor stays active and keeps its other
workers. Running assignments, profiles, report preferences and read cursors are
preserved, including workers running on a linked machine. Inspect current work
before issuing a concrete follow-up; reclaim itself sends no new assignment.
An identical retry returns the original receipt. The tool refuses unrelated
sessions and broader worker permissions. A pending digest from an older build
may need review before a partial reclaim; do not bypass that check.
