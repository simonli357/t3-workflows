# Move a session to another computer

For "move/transfer this session to COMPUTER". The conversation keeps its native
session ID and full context on the same provider.

1. `t3w move NAME --to COMPUTER --project DESTINATION_PROJECT --mcp-plan` (or
   `--thread-id UUID`). Keep the selected model and options. Use
   `--provider-instance-id` only for an explicit destination account of the same
   provider.
2. Call `t3_session_move` with the printed input from the source session, or from
   its owner for a local worker. After requesting your own move, end your turn:
   the move cannot start while it runs.
3. Keep the request ID. Check with `t3_session_move_status` or
   `t3w move --status ID`; add `--cancel` before commit begins. Retry with the
   identical input and request ID.

The source becomes an archived read-only copy and the destination gets its own
worktree. Tell the user what does not travel: credentials, running terminal
processes, ignored build outputs, external services and machine-specific tools.
Committed, staged, unstaged and nonignored untracked files do. Moving back works
the same way.
