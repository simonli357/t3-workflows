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

## Providers and bases

| User choice | Provider instance | Base in the ScandyControl T3 project |
| --- | --- | --- |
| XL | Claude Xinya (`claude_xinya`) | `xl_base` |
| ES | Claude Eol | `es_base` |
| ARA | Claude | `ara_base` |
| AD | Codex Antoine | `ad_base` |
| SL | Codex | `sl_base` |
| DS | DeepSeek through Codex | `ds_base` |

Honor the user's selected account; otherwise use the agent's capacity-informed
choice. Resolve the default base by project and name each time; refuse missing or ambiguous matches. An explicit `--source-thread`
selects an existing worker in that project on the same provider account. Preserve
the source's project, working directory, branch, runtime mode, and interaction
mode. The new worker receives its own native conversation; its assigned task must
not modify the source session.

## Models and fixed effort

| User choice | Helper model | Native model | Providers | Fixed reasoning effort |
| --- | --- | --- | --- | --- |
| Sol 6.1 Max | `sol` | `gpt-6.1-sol` | AD, SL | `max` |
| Astra 6 High | `astra` | `gpt-6-astra` | AD, SL | `high` |
| Opus 5.5 XHigh | `opus` | `claude-opus-5-5` | ES, ARA, XL | `xhigh` |
| Sonnet 5.5 Max | `sonnet` | `claude-sonnet-5-5` | ES, ARA, XL | `max` |
| DeepSeek Flash 4.1 Max | `flash` | `deepseek-flash` | DS | `max` |

The helper also accepts the exact native model IDs. Treat the full names in
this table as model profiles: effort is fixed and is not independently selected.
Codex and DS use `reasoningEffort`; Claude uses `effort`. The helper verifies the
selected model and effort against the server's live model catalog. Preserve
other inherited model options only when the selected model supports them.

Pass an explicit compatible provider and model to the fork helper. The agent
fills unspecified choices after inspecting current capacity as described in
SKILL.md; the diagnostic tool does not choose. Honor user constraints and retain
the selected profile for retries and follow-ups. Fixed efforts do not change.
