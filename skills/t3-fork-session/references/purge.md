# Purge old settled sessions

Only when the user asks, and only on the computers they named. Never purge by
editing the database, and never purge just to test this procedure.

1. Dry run: `t3 threads purge-settled --days N`. Show the user what it would
   remove and what it keeps, with the reasons.
2. Before the real run, save each listed thread's metadata on each computer:
   environment ID/name, thread ID, project ID/name/workspace root, provider and
   account label. Read it from `/api/orchestration/shell` and
   `orchestration.getArchivedShellSnapshot`; the purge report has no project
   labels and the records are gone afterwards. Also record free space on the
   affected filesystems.
3. After the user confirms, add `--yes`. Prefer the CLI: the
   `t3_purge_settled_threads` tool can time out on large databases.

It deletes each thread and its exact Claude/Codex transcript files. Worktrees
stay. `state.sqlite` does not shrink; do not run VACUUM to improve the numbers.

## Report

From the real run's results, never the preview, with the age threshold and
execution time:

- Sessions deleted, grouped **computer → project → provider**, with account labels
  where several accounts share a provider and workspace roots where project names
  are ambiguous. Match by environment ID and thread ID, not title; a label you
  cannot resolve is `unknown`. Group counts must add up to the totals.
- Per computer: successful, skipped and failed counts, skip reasons, failures,
  **transcript bytes removed** (successful results only) and the observed
  free-space change, or "not measured". Keep missing-transcript notes visible.
- A computer that was unreachable or not run is not zero deletions. An interrupted
  or timed-out request is not a success.
- `databaseReusableBytes` is total reusable space, not space freed by this run;
  show it separately.

A dry run may use the same tables with every figure labeled **would delete**.
