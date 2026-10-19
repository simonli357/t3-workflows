# Account and model selection

Apply this policy when the user leaves the account or model unspecified. Choose
using the evidence; no script ranks accounts or routes sessions.

## Priorities

1. Honor explicit account/model/effort choices and compatible project profiles.
   An explicit fork source fixes its account. Preserve the selected profile for
   retries and follow-ups; use worker controls for an authorized change.
2. If the user designates account X for using a banked reset **this week**,
   prioritize X for suitable work while capacity allows. Retain that preference
   and its expiry in the master's task context and handoff; do not infer a
   preference merely because credits exist or carry it into the next week.
   Priority is not permission to redeem a credit. Redemption still needs explicit
   authorization; an exhausted account cannot run until a fresh reading confirms
   usable capacity. If multiple accounts are designated, compare their capacity
   and expiry times unless the user specified an order.
3. Otherwise prefer Claude accounts when their five-hour and weekly allowance can
   sustain the existing load plus the proposed work until the relevant resets.
4. A Codex account has **equal priority with Claude** in its current weekly window
   while weekly usage is **below 70% used** (more than 30% remaining). At 70% used
   or above, Claude regains preference. A newly verified weekly reset renews this
   eligibility. Do not invent a fixed number of hours for "right after reset";
   the below-70% period is the exception. The five-hour limit still applies.
   Use the account-wide weekly window, not a model-specific bucket or DeepSeek's
   Codex harness limits. A missing/stale weekly reading cannot establish eligibility.
5. Within the preferred tier, choose a task-suitable model/account with sustainable
   headroom, considering current load and reset proximity. Equal priority does
   not mean round-robin or always picking Codex. If Claude cannot sustain the
   work, consider another suitable allowed provider, including Codex above 70%,
   with a brief explanation. DeepSeek is not part of the Codex weekly exception.

Use the actual reported reset timestamps, rather than hardcoding Sunday for all
Claude accounts. A reset timestamp in the past is not evidence of replenishment.
Respect active usage-limit rejections and `limitedUntil`; do not keep retrying
an exhausted account.

## Judge sustainable consumption

Read `t3w capacity --all-hosts` before choosing. Compare remaining allowance and
time until reset in **both** short and weekly windows, their ages, active
account/model/effort counts, and queued workers this master just assigned.
Use the freshest trustworthy quota observation for the same account/window;
never sum duplicate quota percentages across machines. Check login identity
hints: an alias may represent different logins on different hosts.

`sustainablePercentPerHour` is remaining percentage divided by hours until reset.
Compare it with recent measured account consumption and uncertainty, allowing
headroom for the additional worker and workload changes. For example, 80% left
with four hours to reset allows 20 percentage points/hour on average; a measured
40 points/hour with unchanged load would exhaust it early. A lull is not proof
that another heavy worker is sustainable, nor is one short spike a reliable
long-term rate. Check sample counts, covered time, stale/saturated readings and
reset boundaries before extrapolating. Do not present exact exhaustion forecasts
when the evidence cannot support them.

Only **SL and ARA** contribute consumption history and model/effort baselines.
Other accounts may be shared: use current quota and visible T3 load as incomplete
evidence, not a private-account burn-rate estimate. SL/ARA baselines may suggest
relative demand for comparable tasks, models, effort and context sizes; do not
transfer an exact percentage/hour to a different account or subscription.

Model/effort/context-band token baselines are not per-model subscription quota
rates. Account-wide quota deltas can include terminal sessions, other hosts and
native subagents. Never divide a mixed account delta by the worker count and
call it an Opus or Astra rate. Consider context size, cache reuse, turn duration,
session age and expected remaining work without treating idle/tool time as model
compute. Unknown measurements remain unknown; start conservatively and reassess
before adding workers rather than pretending a theoretical percentage is known.

## Model and effort

Choose among the project's advertised compatible profiles using the task's
reasoning needs and the available evidence. Use stronger profiles for difficult
reasoning or consequential reviews; a smaller suitable profile can handle
bounded routine work. Do not weaken a user-specified model or sacrifice task
requirements merely to consume a preferred account's quota. Use the configured
fixed effort for the chosen profile unless the user explicitly overrides it.

Briefly state account/model/effort, the priority applied, remaining windows/reset
times, and relevant load or uncertainty. Recheck active load before each added
worker; reuse a recent quota snapshot when relevant rather than hammering refresh.
If there is no suitable supported choice, state the specific gap instead of
silently routing to an unavailable account or changing the task.
