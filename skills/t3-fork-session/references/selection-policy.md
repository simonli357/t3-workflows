# Recommend, choose, start

Allocation is advisory. The service recommends compatible accounts and profiles,
shows forecasts and warnings, and records assignment accounting. The master decides.
Pacing, borrowing, reserves, missing/stale quota estimates and historical rejection
projections are not admission vetoes. Never retune scores or policies just to make
an account eligible. Actual provider failures remain failures.

**Every worker creation is scored and recommended.** The master always scores the
assignment (difficulty and stakes, each 0-10 with a reason): `request.assessment` for
`selection: "automatic"`, otherwise top-level `assessment` on `t3_start_allocated_assignment`
and `t3_worker_spawn` (`t3w spawn|fork --mcp-plan --difficulty N --difficulty-reason TEXT
--stakes N --stakes-reason TEXT`). The server always runs all three recommendations,
model/effort from the difficulty/stakes table, account from allocation and computer
advice, and records them next to the actual choice. Pin only what the user specified;
the rest comes from the recommendation. User choices are recorded overrides: a pinned
choice that differs from its recommendation needs `overrides.model`, `overrides.account`
or `overrides.computer` with the reason, such as "user specified ES Opus xhigh". A fork
keeps its source's account and model; the server records that continuity reason itself.
Recommendations are advice, never an admission veto; unavailable advice is recorded and
the start proceeds.

The priorities below guide the master's own judgment when reviewing the recorded
recommendation or choosing what the user left open.

## Ordinary managed workflow

1. Choose the execution computer and project within the user's constraints and its
   workstation resource rules. Resolve real environment/project IDs and native
   account/model aliases with `t3w profile` and the target catalog. Preserve exact
   user-selected model, effort, speed, family and host.
   When the user named no computer, call `t3_recommend_computer` first (advice only; it
   reserves nothing and never blocks a start) with the task's `needs`, `projectId` and exact
   runtime. Use its `recommendedEnvironmentId` with that computer's project ID from
   `hosts[].projects`; null means no computer was recommended, so choose explicitly. A
   computer the user named is passed as `environmentId` and is never replaced.
2. Keep one assignment ID and destination thread ID. Call `t3_allocate_account`
   with `preview: true`. For unspecified profiles use `selection: "automatic"`,
   `allowedDrivers` and an assessment; for an already exact profile use the exact
   request variant. A preview starts nothing and holds no reservation.
3. Read the recommendation and its warnings. The master chooses the account by
   setting `request.explicitInstanceId` to its native ID. This is an ordinary choice,
   not an override approval flag. Keep the selected model/options and execution
   host. If using an assessed request, keep its assessment and returned model-policy
   version. An explicit account cannot silently lower effort or switch model.
4. Call `t3_start_allocated_assignment` with `kind: "worker"`, that request, the
   target `projectId`, convention-based `title` and complete `prompt` including
   the worker reporting instruction. T3 authenticates the master and inherits its
   permission/interaction modes. Do not supply an owner ID or invent mode fields.
5. Inspect returned worker/assignment receipts and provider state. `submitted`
   means startup was accepted, not that the task completed or quota was guaranteed.
   Retry the entire original start input after a lost response, including IDs,
   project, title and prompt. The durable receipt prevents duplicate work.

For example, retain an existing request and choose a native account:

```json
{
  "preview": true,
  "request": {
    "selection": "automatic",
    "assignmentId": "existing-assignment-id",
    "threadId": "existing-destination-thread-id",
    "environmentId": "chosen-execution-environment-id",
    "allowedDrivers": ["codex"],
    "explicitInstanceId": "chosen-native-account-id",
    "assessment": {
      "difficulty": 7,
      "difficultyReason": "Interacting behavior needs careful reasoning.",
      "stakes": 6,
      "stakesReason": "Incorrect work is consequential but recoverable."
    }
  }
}
```

Use actual IDs, not these placeholders. Pass the same request to Start with the
project/title/prompt. Explicit existing task choices take precedence over this
example. For an assessed exact model, use `override: {driver, model, options,
reason}`; its driver must be in `allowedDrivers`. Preserve every explicit option.
The exact request variant instead takes `driver`, `model` and `options` directly.
Neither request requires an extra quota override or approval flag.

## Existing proposals and retries

A previously denied or Observation-only proposal can start on the same assignment
and thread IDs. Before startup, the master can choose AD, SL or another permitted
account using `explicitInstanceId`; resolve aliases through the target profile.
Keep the prior task assessment, exact profile and host. Do not fabricate new IDs
or weaken constraints to escape a recommendation. Unused expired accounting can
be renewed on the same identity. Once a start was attempted, preserve the entire
input and reconcile its receipt before changing anything.

A live older server returning `observation` has started nothing. Use the reviewed
advisory-capable deployment; do not misreport that result as a running worker.
Unsupported profiles, ownership conflicts, unavailable coordinator/execution
connections and actual provider auth/quota errors must be surfaced honestly.
Historical warnings are not proof that a fresh provider attempt will fail, and
low numeric usage is not a guarantee of success. Never clear historical errors,
redeem reset credits, or start extra test turns to obtain an allowed receipt.

## Assessments and native continuity

Score the scoped assignment on difficulty and stakes, each an integer from 0 to 10
with its own concise reason (1-500 characters). Difficulty covers reasoning,
uncertainty and interacting components; stakes covers impact, reversibility and
detectability. The rubric is 0-3 routine/low, 4-6 moderate, 7 high, 8 very high,
9 extreme, 10 exceptional. Each provider table has 121 independently editable
exact difficulty/stakes pairs (0-10 on each axis); the rubric does not group
editable cells. Older saved tables retain every pair's choice when read. The
table recommends exact model/effort profiles. Do not copy its mapping into
prompts, alter scores for quota, or assume model/effort is a linear cost scale.
Only configured capability alternatives may fill unsupported automatic profiles;
quota pressure never selects a weaker model or another computer. Use the configured
table's effort for the chosen profile unless the user explicitly overrides it.

An existing native session is not a fresh allocation. Forks, moves, resumes,
follow-ups and orchestration handoff retain their dedicated continuity/ownership
workflows. Fresh Start does not replace a native identity. Reassessment is for a
substantive failure or scope change, uses its existing lineage semantics and new
assignment/thread identity, and needs consent for a fresh provider family. A quota
warning, transport failure or renewal alone does not justify reassessment.

## Availability and tools

Inspect the actual MCP schemas: `t3_allocate_account` and
`t3_start_allocated_assignment` provide recommendations and managed startup.
Reconnect discovery after deployment. Do not infer support from a version string
or infer absence from a network failure. The existing explicitly requested legacy
bootstrap/fork workflows remain available for their intended use; no fallback
maze is needed for an ordinary recommendation with warnings.
