# Scandy Worker Conventions

## Names

Use lowercase for the entire worker name, including the selected model suffix: `_sol`,
`_astra`, `_opus`, `_sonnet`, or `_flash`. Append it once, after the issue name
or `_worker`. The base-session names remain `es_base`, `ara_base`, `ad_base`,
`sl_base`, `ds_base`, and `xl_base`.

For a GitHub issue, use `<prefix>_<issue>_<model>`:

- `<issue>` is `a` plus the issue number for ScandyAutonomy, or `c` plus the
  issue number for ScandyControl. Use lowercase `a`/`c` without a literal `#`.
  The owning repository determines the letter, not the files being changed.
- If the issue has an established epic, use that epic's repository letter and
  number as the prefix. Example: `a569_a635_opus`; a Control issue under an
  Autonomy epic could be `a569_c344_sol`.
- Otherwise choose one lowercase keyword most relevant to the issue's subject,
  such as `camera_c344_sol` or `localization_a635_opus`. Use one word, not a
  phrase, generic task verb, account name, or date.

Read the issue's parent/epic relationship or explicit epic reference to determine
its epic. For nested tasks, use the closest explicitly identified epic, not an
arbitrary related issue or every intermediate parent. If no epic is identified,
use the keyword form; do not invent an epic number or block creation on naming.
Keep the full repository and issue reference in the assignment text.

Apply these names to new workers. Existing workers remain addressable by thread
ID and need not be renamed; do not change a title during an idempotent spawn retry.

For other work, use one or two short descriptive words followed by `worker`,
in lowercase, with underscores between words, then the lowercase model suffix.
Examples: `camera_worker_flash`, `camera_preview_worker_opus`, and
`release_review_worker_astra`.

Beyond the required model suffix, do not append provider names, dates, or a task
summary to an issue worker's name. The helper accepts the title chosen by the
agent and does not enforce these naming conventions.

## Accounts, bases and fixed model efforts

Run `t3w profile --project scandy` for the current configured account aliases,
base names, native models, and fixed efforts. Both Scandy repositories share the
configured Scandy base project. These values belong to configuration, not a
second inventory in this document.
