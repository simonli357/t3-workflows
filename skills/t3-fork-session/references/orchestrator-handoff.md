# Orchestrator handoff

Choose the context for the successor:

- **Base plus summary:** `t3w fork --provider ARA --model opus --name next_master_opus --thread-id UUID --task-file /tmp/handoff.txt --handoff-plan` uses the configured base. Add `--project` when needed.
- **Self-fork:** add `--self-fork`. T3 resolves the authenticated session ID itself. The destination can use another provider/account/model. The server waits for the source turn to end before copying its native and visible history, then applies the destination profile. Cross-provider continuation uses T3's normal context handoff; it does not transplant one provider's native transcript into another.
- **Fresh plus summary:** use `t3w spawn` with `--handoff-plan` and the target project. No base is needed.

Use the capacity policy for unspecified choices. Profile efforts remain the defaults;
`--effort` explicitly selects another advertised effort. Pass the emitted JSON
unchanged to `t3_orchestrator_handoff`. The helper only validates; the authenticated
MCP caller establishes which orchestrator is relinquishing its workers.

Write a moderate-length handoff prompt containing the user's actual objective,
permissions and constraints, completed decisions, remaining acceptance criteria,
worker responsibilities, relevant files/branches/PRs, dependencies and next actions.
Reference durable evidence instead of copying entire logs. A self-fork still needs
a clear instruction to take over; inherited tasks are context, not new assignments.

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
