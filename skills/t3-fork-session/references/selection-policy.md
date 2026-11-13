# Pins and allocation policy

## Pin what the user chose for this worker

In `t3_start_allocated_assignment`, and in `t3_allocate_account`, which previews
the same choice without starting anything:

- Account: `account`, its instance ID. Exact: drained there means refused.
- Model: `model`, the model ID, with the table's effort; add `effort` to pin that
  too. A pinned model that is drained everywhere is replaced like any other.
- Codex: `driver: "codex"`, only when the user asked for Codex.

Preserve every pin on retries.

## How the server chooses

The table gives a model and effort for the scores. Each account's limits are
projected to the job's end (learned costs, every working session on the login,
outside use). Accounts that last the job within their daily goal lead, by most
room until the tightest reset; close ones follow the preference order. Only a
used-up window, a provider rejection or a hard cap stops an account. Fitting
nowhere, a start waits for a reset within 30 minutes (45 at stakes 8+), else
takes the nearest rung that fits (two at most), else the fallback, else the
account lasting longest. Codex never changes model.

Never retune the policy, clear errors, redeem reset credits or start test turns
to make an account usable. Forks, moves, follow-ups and handoffs keep their
account and model.

## Policy

`t3_allocation_policy` with no fields reads it. `account` is the alias or
instance ID and covers that login on every computer. It sets the preference
order and its margin, hard caps, daily goals, `fableWorkers`, the ladder, the
fallback, table entries (`showTable` returns one) and how long a limited worker
waits before changing model. Change it only when the user asks.
