---
name: report-progress
description: Give the user a brief progress report - what was done since the last report, what is running now, what is not done or not started, blockers and decisions needed - with pictures or videos embedded where the work is visual. Use when the user types /report-progress or "report progress", or asks what is going on, what was done, or what is left.
---

# Report progress

A report only: start, stop or change nothing while making it, and never message a
worker to ask for status.

## 1. Since when

Run `date -u`. The last report's time and items are in
`~/.local/state/report-progress/<session id>.md` (`$CLAUDE_CODE_SESSION_ID`, or
`$CODEX_THREAD_ID`). With no file, report since this session started or took over
from its predecessor, and say which.

## 2. Collect the facts now

Do not answer from memory; check each item you will state.

- **Work in progress:** your workers' state and last message (the T3 skill's
  session lookup), live runs and jobs on every computer used, and when each is
  expected to finish.
- **Finished since the last report:** worker reports, merged and open pull
  requests, installs and deploys, results written to evidence folders.
- **Not done:** assigned but unfinished, queued, not started, and waiting on
  something (name what).
- **Blockers:** errors, usage limits, hosts that do not answer, memory or disk
  that is short, and anything only the user can decide or do.

## 3. Pictures and videos

When a result is visual (a cloud, a view of the app, a render, a recording), copy
its newest pictures or video to this computer, look at them yourself, and embed
two to four with absolute paths, each with one line saying what it shows and any
defect visible in it. Prefer a picture next to its reference (photograph, before).
Say which result on disk is the current best and give its path. Skip this section
when nothing is visual or nothing is new.

## 4. Write the report

About half a page, in plain words. Name each item by what it is; an issue or pull
request number may follow it as a reference, never stand alone.

1. One opening sentence: the overall state, and whether the user has to do anything.
2. **Done since `<time>`**: outcomes, with the number that proves each.
3. **Running now**: what, where, expected finish.
4. **Not done or not started**: one line each, with what it waits for.
5. **Blockers and decisions for you**: only what the user must act on; leave the
   heading out when there is none.

Mark what you verified yourself and what a worker only reported. Give an item that
has not changed since the last report one line at most.

## 5. Remember this report

Write the time and one line per item reported as done, running and open to the
state file from step 1, replacing its content.
