# Connection options, other worker controls, use outside T3

## Connection and project

The scripts use the running T3 server and CLI authentication. All accept
`--server`, `--home`, `--cli` and `--timeout SECONDS` (environment:
`T3_FORK_SERVER_URL`, `T3CODE_HOME`, `T3_FORK_CLI`; `T3_FORK_TOKEN` supplies a
bearer credential). Never print or commit credentials.

The project is `--project PROFILE_OR_PATH`, else the current checkout's primary
repository; outside a checkout it is required. Forks use the profile's shared
base project, fresh sessions the repository itself. Configuration is
`~/.config/t3-workflows/config.json` or `T3_WORKFLOWS_CONFIG`.

## Other worker controls

- `t3_worker_wait` waits up to 55 seconds for one assignment's `requestId`; a
  timeout cancels nothing.
- `t3_worker_control` pauses or resumes a worker's reports (`notifications`),
  cancels a queued assignment (`cancelRequestId`), or accepts a profile change
  made in the UI (`adoptCurrentSettings: true`). Stop running work with T3's Stop
  control.
- `t3w reports [--hours N]` counts reports per master and worker, to spot
  assignments sliced too thin.

## Outside T3

Without `--mcp-plan`, `t3w spawn` and `t3w fork` create a standalone session.
It has no master and sends no reports: say so instead of inventing a master ID.
Fresh standalone sessions start as `approval-required` and `default`;
`--runtime-mode full-access` and `--interaction-mode plan` change that.
`--dry-run` validates without creating anything; `--wait completed` waits for a
short task instead of only for startup.

Inside T3, missing worker tools mean the provider session must reconnect to the
T3 server. Do not fall back to a standalone session.
