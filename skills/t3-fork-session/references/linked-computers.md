# Linked computers

`t3w peer list` shows the linked computers, for example `sliara` and `myalien`.

- **Find:** `t3w find NAME --environment LABEL`. A missing local match does not
  prove the session is absent elsewhere.
- **Message:** add `environment: "LABEL"` to `t3_session_send`. `queued` means the
  computer is offline and delivery is retried; `dispatched` means it accepted the
  message. A message from another computer names it ("in environment myalien");
  reply with that `environment`.
- **Fresh worker:** the normal start with the target's `environmentId` and its own
  `projectId`. Keep both unchanged on retries.
- **Fork:** `t3w fork --environment LABEL --project TARGET_PROJECT --mcp-plan`,
  then `t3_worker_spawn`. The base or source must be on that computer and account.
- **Manage:** the worker tools work as for local workers. `state: "unreachable"`
  means the computer is offline. Settle with
  `settle-worker.mjs --environment LABEL --thread-id UUID`.
- **Not supported:** a handoff successor on another computer, and refreshing
  another computer's bases (run it there).

## Link two computers

```bash
t3w peer link <ssh-alias> --local-url <this server's tailnet URL> --remote-url <that server's tailnet URL>
t3w peer check            # retest the links
t3w peer remove <label>
```

A peer token grants full control of the other T3 server: keep both addresses
tailnet-only, and after removing a peer revoke its token on that computer
(`t3 auth session revoke`).
