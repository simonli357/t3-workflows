# Recommend, choose, start

Start on the recommendation. The service picks model/effort from the difficulty/stakes
table and the account from allocation and its account rules, gives computer advice, and
records all three next to the actual choice. Pin only what the user specified for this
worker; a pinned choice that differs starts as it is. Quota, pacing and stale-reading
warnings are advice, never an admission veto. Never retune policies just to make an
account eligible. Actual provider failures remain failures.

## Allocation rules

When the user states an allocation rule, set it once with `t3_allocation_policy` and
never restate it per start. Give `expiresAt` whenever the rule is for a duration; it
then stops applying by itself.

| The user says                     | `setRules` entry                                                    |
| --------------------------------- | ------------------------------------------------------------------- |
| "never XL"                        | `{account: "XL", kind: "exclude"}`                                  |
| "1 ARA max"                       | `{account: "ARA", kind: "maxWorkers", value: 1}`                    |
| "prefer ES until Friday"          | `{account: "ES", kind: "priority", value: 10, expiresAt: ISO_TIME}` |
| "AD is exhausted until it resets" | `{account: "AD", kind: "exclude", expiresAt: RESET_TIME}`           |

`account` is the alias or native instance ID and covers that login on every computer.
Excluded accounts and accounts at their worker limit are never recommended, and a start
pinned to one is refused with the rule as its error: report that instead of working
around it. A higher priority wins while the account has quota headroom. `clearRules:
[{account, kind?}]` removes rules; a call with no fields reads the policy with account
labels. The same tool sets pacing curves, hard caps and timed overrides when the user
asks. Rules are per account, not per task type: for "AD for rendering workers", pin
`explicitInstanceId` on those starts.

## Ordinary managed workflow

1. Choose the execution computer and project within the user's constraints and its
   workstation resource rules. Resolve real environment/project IDs and native
   account/model aliases with `t3w profile` and the target catalog.
   When the user named no computer, call `t3_recommend_computer` first (advice only; it
   reserves nothing and never blocks a start) with the task's `needs`, `projectId` and exact
   runtime. Use its `recommendedEnvironmentId` with that computer's project ID from
   `hosts[].projects`; null means no computer was recommended, so choose explicitly. A
   computer the user named is passed as `environmentId` and is never replaced.
2. Call `t3_start_allocated_assignment` with `kind: "worker"`, one assignment ID and
   destination thread ID, the target `projectId`, convention-based `title` and complete
   `prompt` including the 5-minute wait line. Use `selection: "automatic"` with
   `allowedDrivers`; add `tier: "routine" | "normal" | "hard"` when the assignment is
   clearly lighter or heavier than normal. T3 authenticates the master and inherits its
   permission/interaction modes. Do not supply an owner ID or invent mode fields.
3. Inspect returned worker/assignment receipts and provider state. `submitted`
   means startup was accepted, not that the task completed or quota was guaranteed.
   Retry the entire original start input after a lost response, including IDs,
   project, title and prompt. The durable receipt prevents duplicate work.

```json
{
  "kind": "worker",
  "projectId": "target-project-id",
  "title": "c344_camera",
  "prompt": "complete assignment text",
  "tier": "hard",
  "request": {
    "selection": "automatic",
    "assignmentId": "stable-assignment-id",
    "threadId": "stable-destination-thread-id",
    "environmentId": "chosen-execution-environment-id",
    "allowedDrivers": ["codex", "claudeAgent"]
  }
}
```

Use actual IDs, not these placeholders. For choices the user made for this worker:
`explicitInstanceId` pins the account; `override: {driver, model, reason}` pins the
model with the table's effort, and its `options` pin the effort too (the driver must be
in `allowedDrivers`); the exact request variant takes `driver`, `model` and `options`
directly. Preserve every explicit option. `t3_allocate_account` with `preview: true`
shows what would be chosen without starting or reserving; it is optional.

## Existing proposals and retries

A previously denied or Observation-only proposal can start on the same assignment
and thread IDs, and the account may still change before startup. Unused expired
accounting can be renewed on the same identity. Once a start was attempted, preserve
the entire input and reconcile its receipt before changing anything.

A live older server returning `observation` has started nothing; do not report it as a
running worker. Unsupported profiles, ownership conflicts, unavailable execution
connections and actual provider auth/quota errors must be surfaced honestly. An
unreachable coordinator does not fail a start: the requesting computer decides from its
own readings and the coordinator's last known account rules, and records "Allocation
coordinator unavailable" in the warnings, plus "Account rules were not checked" when it
holds no copy of the policy. Historical warnings are not proof that a fresh provider
attempt will fail, and low numeric usage is not a guarantee of success. Never clear
historical errors, redeem reset credits, or start extra test turns to obtain an allowed
receipt.

## Tiers and native continuity

A tier is one score on both axes of the table: routine 2, normal 5 (the default), hard 8.
Give `assessment` (`request.assessment` with `selection: "automatic"`) with exact 0-10
difficulty and stakes scores and reasons only when the user asks for them. Do not copy
the table's mapping into prompts or change a tier for quota. Only configured capability
alternatives may fill unsupported automatic profiles; quota pressure never selects a
weaker model or another computer.

An existing native session is not a fresh allocation. Forks, moves, resumes,
follow-ups and orchestration handoff retain their dedicated continuity/ownership
workflows. Fresh Start does not replace a native identity. Reassessment is for a
substantive failure or scope change, uses its existing lineage semantics and new
assignment/thread identity, and needs consent for a fresh provider family. A quota
warning, transport failure or renewal alone does not justify reassessment.

## Availability and tools

Inspect the actual MCP schemas: `t3_allocation_policy`, `t3_allocate_account` and
`t3_start_allocated_assignment`. Reconnect discovery after deployment. Do not infer
support from a version string or infer absence from a network failure. The explicitly
requested legacy bootstrap/fork workflows remain available for their intended use.
