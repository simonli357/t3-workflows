# Worker conventions

Run `t3w profile [--project NAME_OR_PATH]` for account aliases, native model IDs,
fixed efforts, base names, and the selected project's naming policy. These are
configuration, not hardcoded script decisions. Respect explicit user choices;
for fresh work, supply task scores and host constraints to the deterministic
[selection policy](selection-policy.md), which recommends unspecified profiles/accounts. The master chooses the account
and starts it; quota and pacing warnings are advisory.

All new worker names are lowercase, including the model suffix. For issue work,
use `<epic>_<repository-prefix><issue-number>_<keyword>_<model>`. Omit `<epic>_`
when no epic is identified. Choose exactly one lowercase word that best describes
the work, immediately before the model suffix. Use the project's configured
repository prefixes and nearest explicit epic. For example:
`a569_a635_localization_opus`, `a569_c344_camera_sol`, or `c344_camera_sol`
without an epic. For other work use `<short-description>_worker_<model>`.
Preserve full issue references in the assignment. Scandy's exact conventions are
in [scandy.md](scandy.md); apply them only to the Scandy profile.

Choose a fresh session when inherited context is unnecessary; no base is required.
For forks, resolve bases by project and name each time, rejecting missing or
ambiguous matches. Ordinary worker forks require the source account and project. Orchestrator
handoffs can change the destination profile after copying the source. Preserve source modes, working directory, and branch. Never assign work
to a base or modify its context while forking. Reuse an owned worker for corrections.

Automatic fresh-work effort comes from the configured service policy. Exact
user/model overrides and legacy/fork profiles use applicable fixed-profile defaults
for omitted options; explicit options stay exact. Selections are checked against
the target catalog. Preserve supported inherited options, explicit constraints,
and the entire pinned allocation/start input on retries. Name from the returned
model; do not manually choose a different model to fit an existing suffix.
