# Quota, load and usage diagnostics

Read-only; none of this starts a worker or stops a start. Starts use the server's
recommendation, so run these only when the user asks about capacity or a start
needs explaining.

```bash
t3w capacity               # this computer, quotas refreshed first
t3w capacity --cached      # skip the provider refresh
t3w capacity --all-hosts   # add the configured peers
t3w capacity --load-only   # only agent counts by account, model and effort
```

Reading the report:

- Each account lists its quota windows (used/remaining, reset time, reading age)
  and active sessions. `limitedSessions` and `limitedUntil` come from past provider
  rejections: surface them as a warning, not a veto of an explicit account choice.
- `load.byModelEffort` separates `working`, `starting`, `waiting`,
  `backgroundOnly` and `uncertain`. Masters count too. A worker-style name is not
  proof of ownership; `t3_worker_list` gives your actual workers.
- A failed or unreachable computer is unknown, not zero. Check `complete` before
  estimating spare capacity. Never add quota percentages from different computers.

`t3_usage_measurements` gives context size, session age, timing, token usage and
quota rates, for SL and ARA only (`monitoredInstanceIds`). Quota rates are
account-wide: do not attribute a change to one worker, or convert tokens or API
prices into subscription percentages. Session age includes idle time.

Peers are listed in `~/.config/t3-workflows/config.json` under
`capacity.remoteEnvironments`, each with `label`, SSH alias `ssh`, and `command`
(`node /path/to/t3-workflows/skills/t3-fork-session/scripts/check-capacity.mjs` on
that computer).
