# Pins and allocation rules

## Pin what the user chose for this worker

In `t3_start_allocated_assignment`, with `selection: "automatic"`:

- Account: `request.explicitInstanceId`.
- Model: `request.override: {driver, model, reason}` keeps the table's effort; add
  `options` to pin the effort too. The driver must be in `allowedDrivers`.
- Everything: the `selection: "explicit"` request takes `driver`, `model` and
  `options` directly.
- Exact scores instead of a tier, only when the user gives them:
  `request.assessment` with 0-10 difficulty and stakes and their reasons.

Preserve every explicit option on retries. `t3_allocate_account` with
`preview: true` shows what would be chosen without starting anything.

Never change a tier, retune the policy, clear historical errors, redeem reset
credits or start test turns to make an account eligible. Quota pressure never
selects a weaker model or another computer.

Forks, moves, follow-ups and handoffs keep their existing account and model; they
are not fresh allocations. Use `reassessment` only after a substantive failure or
scope change, with new assignment and thread IDs, and get the user's consent
before moving to another provider family. A quota warning, transport failure or
renewal does not justify it.

## Allocation rules

`t3_allocation_policy` with no fields reads the policy. `account` is the alias or
instance ID and covers that login on every computer.

| The user says                     | Input                                                                |
| --------------------------------- | -------------------------------------------------------------------- |
| "AD is exhausted until it resets" | `setRules: [{account: "AD", kind: "exclude", expiresAt: RESET_TIME}]` |
| "XL is fine again"                | `clearRules: [{account: "XL", kind: "exclude"}]`                     |

Rules are per account, not per task type: for "AD for rendering workers", pin
`explicitInstanceId` on those starts. The same tool sets pacing curves, hard caps
and timed overrides when the user asks for them.
