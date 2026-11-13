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

The table gives a model and effort for the scores. It runs on the account with
the most room; with similar room, the earlier account in the preference order
wins. A model is drained on an account when a usage window that applies to it
is used up, a provider limit rejection is in force, or a hard cap is reached.
Nothing softer changes the model. Drained on every account, it is replaced by
the nearest ladder model that has room. When none has, routine work goes to the
fallback model and the rest is refused with `drainedUntil`. Codex never changes
model.

Never retune the policy, clear errors, redeem reset credits or start test turns
to make an account usable. Forks, moves, follow-ups and handoffs keep their
account and model.

## Policy

`t3_allocation_policy` with no fields reads it. `account` is the alias or
instance ID and covers that login on every computer. It sets the preference
order and its margin, hard caps, the ladder, the fallback, table entries
(`showTable` returns a table) and how long a limited worker waits for a reset
before changing model. Change it only when the user asks.
