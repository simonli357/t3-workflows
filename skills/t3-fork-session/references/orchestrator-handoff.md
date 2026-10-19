# Orchestrator handoff

## Renew a long-running master

Renewal is a handoff to a fresh or base-forked successor whose only knowledge of
the work is the context prompt below. Keep the role and increment a generation
number in its title, for example `simulator7_es_master` → `simulator8_es_master`.
On accounts with usage measurements, compactions or `latestContextTokens` nearing
`contextCapacityTokens` in `t3_usage_measurements` mean it is time to renew.

Write what the successor needs to act, usually one to three pages. Point to files,
branches, PRs and reports rather than pasting them. Use this template:

```text
You are <successor title> (<successor ID>), the new master. You take over from
<old title> (<old ID>). Its workers are now yours and report to you.

Objective: the user's goal, in their words, and what finished means.
Standing instructions: permissions, what needs the user's approval, account and
  budget rules (with expiry dates), anything the user said not to do.
Decisions so far: settled choices and the reason, so they are not reopened.
Workers: one line each with title, ID, environment, account/model, current
  assignment, state, and what to check next.
Peers: other masters or sessions you coordinate with, with title, ID,
  environment, and what they expect from you.
Open items and next actions, in order.
Evidence: paths to reports, branches, PRs and logs.
Guards: background monitors or scripts that wake the master, with the command to
  restart them so they target <successor ID>.
```

The successor starts with `t3_worker_list` and `t3_worker_read` for each worker,
then restarts the guards for itself. It sends each listed peer its new session ID
once, as a coordination update. A worker that was told to message the old ID
directly gets a correction with `t3_worker_send` to use `t3_worker_report`.

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
