# Side-by-side V2 read/import trial (Linux)

Use this before a production decision. It creates a separate process on a loopback
port, from an explicit read-only V1 source. It uses its own transient user systemd
service in `t3w-trials.slice`, independent of production and the calling agent. It never invokes the release controller,
service launcher, runtime selector, updater, agent slice, or Tailscale. It does not
establish feature parity or authorize a production switch.

In a described workenv job, check capacity for the retained input, active V1 copy,
V2 import, runtime and later archived generations. The source needs a consistent
read-only SQLite `VACUUM INTO`; no live database file is copied directly.

```sh
t3w release trial prepare --job /absolute/job \
  --source-home /home/USER/.t3 --runtime /absolute/prebuilt-v2 --port 4773
t3w release trial start --job /absolute/job
t3w release trial status --job /absolute/job
t3w release trial verify --job /absolute/job
t3w release trial restart --job /absolute/job
t3w release trial stop --job /absolute/job
```

`start` is idempotent. `restart` uses the existing data and runtime. `verify` checks
full import and retained-table counts, the transcript import ledger, and sampled
project fields, thread metadata/model selection and message text/attachments/context.
The preservation build retains the legacy projection tables for history hydration
and checkpoint recovery; verification rejects missing tables. V2 compacts imported
legacy thread events/receipts. Verification
checks that missing legacy rows belong only to successfully imported threads; all raw
input remains retained. These checks do not establish feature parity.
It fails if import is incomplete or sampled content differs; inspect the generation's
`verification.json`. Counts alone do not pass. HTTP readiness may precede transcript
hydration. The default startup deadline is 900 seconds; `--ready-seconds` overrides it.

Only an explicit refresh copies live data again:

```sh
t3w release trial stop --job /absolute/job
t3w release trial refresh --job /absolute/job
# Optional: refresh --runtime /absolute/new-prebuilt-v2
t3w release trial start --job /absolute/job
```

Refresh refuses a running trial, stages new inputs before publishing the current
pointer, and retains the entire previous generation with an archive receipt.
Trial-only data, failed staging directories and old binaries are never deleted.
A failed refresh leaves the old generation selected. The new generation gets a
fresh environment identity and authentication. Use `--trial /absolute/job/name`
for multiple trials; each must use a different port. Source and trial cannot overlap.

Each generation retains a private `input/userdata` snapshot, file hashes and a
receipt. Every SQLite file is snapshotted read-only (including an old statev2 file,
if present); only the V1 state.sqlite is used to initialize this trial. Other files
are copied individually, so this is not a transaction spanning all config files.
Symlinks and special files are recorded, not followed. Preserve the job with
`workenv keep` according to workstation policy: inputs can contain private credentials.

The active home deliberately differs from the retained input:

- Copied jobs, worker notifications, moves, renewals, handoffs and schedules are disabled.
  Legacy provider resume state is cleared. Original rows remain in the input snapshot.
- Original settings, secrets, peer identities, computer configuration and provider homes
  stay outside the active home. The active settings disable restart continuation,
  linked environments and idle compaction; authentication and environment identity are fresh.
- Presentation assets and attachments are copied into the active home. Original project
  paths and thread metadata are retained for comparison, but their workspaces are inaccessible.
- A user systemd manager, Landlock (ABI 3+) and libseccomp are mandatory. The process and its descendants can
  read their staged runtime and required system files and write only their own active
  home. Outbound socket operations and interference with other processes are denied.
  The process uses a private HOME, temp/cache directories and an explicit clean environment.

These are isolation controls, not claims that V2 preserved logins, custom settings,
peer behavior, provider execution, scheduled work or workspace integration. Assess those
separately against the untouched input. The trial is for inspecting imported data;
it cannot execute real agent work. Do not remove containment to make a feature test pass.
