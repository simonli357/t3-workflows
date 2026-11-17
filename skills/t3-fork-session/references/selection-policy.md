# Pins and allocation policy

## Pin what the user chose for this worker

In `t3_start_allocated_assignment`, and in `t3_allocate_account`, which previews
the same choice without starting anything:

- Account: `account`, its instance ID. Exact: drained there means refused.
- Model: `model`, the model ID, with the table's effort; add `effort` to pin that
  too. A pinned model that is drained everywhere is replaced like any other.
- Codex: `driver: "codex"`, only when the user asked for Codex.

Preserve every pin on retries.

## A pin ends after 24 hours

A pin is for the worker the user named. When he gives a choice for more than
one worker ("change the ES workers to XY Fable", "use ARA from now on", "only
Opus"), it covers the workers he named and new starts for at most 24 hours from
his message. This holds for account, model, effort and computer.

- Note the time he said it, and name the pin and its end in your report each
  time you start a worker under it.
- After 24 hours stop pinning and let the server choose. Tell him in one line
  the first time. Never extend a pin yourself, and do not ask him to renew it.
- When unsure whether his words cover a new worker, do not pin.
- A choice that should last belongs in the allocation policy (order, goals,
  caps, Fable accounts), where he can see and change it: offer that instead of
  keeping a pin.
- In a handoff, pass a pin with the time it was given and when it ends. Never
  pass one that has ended.

## How the server chooses

The table gives a model and effort for the scores. Each account's limits are
projected to the job's end (learned costs, every working session on the login,
outside use). Of accounts lasting the job, the one furthest behind its daily
goal leads; close ones on the same side follow the order. Only a
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

Fable mode is per Claude account: `fableAccounts` is the whole list of accounts
in it, by alias or instance ID (`["XY"]` for only XY, `["XL", "ARA"]` for XL and
ARA, `[]` for none). A worker on one of them runs Fable low, medium or high,
only those stand in, and the account is out while its Fable limit is used up; a
worker on any other account gets the table's choice, and each account is judged
on what it would run. A pinned model is kept. Turning an account on turns
`fableWorkers` on, and `fableWorkers: false` empties the list.
