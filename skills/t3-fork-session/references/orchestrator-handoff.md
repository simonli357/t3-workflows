# Orchestrator handoff

## Renew a master

On measured accounts, compactions or `latestContextTokens` nearing
`contextCapacityTokens` in `t3_usage_measurements` also signal renewal. Give the
successor what it needs to act, usually one to three pages, and point to files,
branches, PRs and reports instead of pasting them:

```text
You are <successor title> (<successor ID>), the new master, taking over from
<old title> (<old ID>). Its workers are now yours and report to you.

Objective: the user's goal in their words, and what finished means.
Standing instructions: permissions, approvals needed, account/budget rules with
  expiry, anything the user ruled out.
Decisions so far, with reasons, so they are not reopened.
Workers, one line each: title, ID, environment, account/model, assignment, state,
  next check.
Peers you coordinate with: title, ID, environment, what they expect.
Open items and next actions, in order.
Evidence: paths to reports, branches, PRs, logs.
Guards that wake the master, with the command to restart them for <successor ID>.
```

The successor first reads its workers (`t3_worker_list`, `t3_worker_read`),
restarts the guards, sends each listed peer its ID once, and tells any worker still
messaging the old ID to use `t3_worker_report` instead (`t3_worker_send`).

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
is preserved and should stop directing those workers. The successor is an independent
orchestrator, not another worker reporting to its predecessor. This transfers direct
worker ownership on one T3 environment; it does not move unrelated peers, nested
workers, an upstream owner's assignment, or sessions on another host.
