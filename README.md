# T3 Workflows

Global Codex/Claude skill and CLI for prepared-base workers and maintaining a custom T3 build. Requires Node 22+, Git, and authenticated T3/gh CLIs. Provider credentials stay in their existing homes.

Clone this private repository into `~/t3-workflows`, create `~/.config/t3-workflows/config.json` from `profiles/config.example.json`, then run `node bin/install.mjs`. The installer links the whole skill directory into each configured account home and `~/.agents/skills`; it refuses to overwrite unrelated installations. On Windows it uses directory junctions and installs `~/.local/bin/t3w.cmd` (add that folder to user PATH). Start a new agent session to load the global skill.

```sh
t3w doctor
t3w profile --project scandy
t3w capacity
t3w find 'c344_camera_sol'
t3w refresh-bases --project scandy --apply
t3w update
```

`fork` accepts the existing helper's options. Inside T3, use `--mcp-plan` and pass the result to `t3_worker_spawn`. Global installation does not replace the server's custom worker tools. They run on the custom stable build; preserve their behavior when integrating selected upstream changes.

Project resolution uses `--project` (profile name or path), then `T3_WORKFLOWS_PROJECT`, then the current primary Git checkout matched to the machine's project profiles. It never infers a project from the installed skill location. Unknown projects use their own checkout, not Scandy's bases. ScandyAutonomy and ScandyControl intentionally share bases in ScandyControl. Profile names, paths, base prompts/names, account overrides and enabled accounts are configuration. Default account/model profiles live in the skill's `references/accounts.json`; project naming policy lives in the selected profile. There is no scripted account ranking.

`T3_WORKFLOWS_CONFIG` overrides the config path. `skillHomes` lists account configuration roots. `enabledAccounts` can limit the aliases used on a machine; other accounts are not assumed installed. The connection settings accept explicit server/home/CLI overrides as before.

## Weekly upstream review

Stay on `custom-stable`. Fetch official stable, main and nightly changes weekly as review material. The report recommends individual changes to take, defer or skip; the user chooses which ones to integrate. Backport selected changes and test them against our custom behavior and existing phone/desktop clients before deployment. Reviewing nightly changes does not authorize switching the installed build to nightly. Stable-base upgrades are separate, explicit decisions.

`t3w check-upstream` fetches upstream and collects release notes, new commits, patch-equivalent changes, customization metadata, and the live local environment version. `--review` runs the configured Codex reviewer read-only and writes `~/.local/state/t3-workflows/upstream/latest.md`, then notifies the desktop. It never merges or deploys. The review cursor advances only after a successful report. A failed run keeps its evidence and retries through systemd; a lock prevents overlapping reviews. Inspect the PID in a stale lock before removing it after an interrupted run.

`t3w install-schedule` installs a Monday 10:00 local-time user timer, with up to ten minutes jitter and catch-up after downtime. Run it on one coordinator only. Configure `upstream.remoteEnvironments` with trusted SSH aliases and `t3w environment` commands to inspect other machines on each run. Offline environments are reported as unavailable; any timestamped installation records are kept distinct from live observations. Native phone app version is not inferred from server version. `t3w check-upstream --review --force` requests an immediate review; normal scheduled runs skip if successfully reviewed within six days.

Use this package’s `customizations.json` (configured by `upstream.customizationsFile`) to record the supported behavior, upstream replacements and adapted-backport commits. Git ancestry alone cannot identify manually ported features. Update deployment records whenever a build is actually activated.
