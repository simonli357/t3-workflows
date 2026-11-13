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

## 2. List the user's tasks

List every task the user has given this session or its predecessors (the
conversation, the handoff it started from, and the task list in the state file),
in the user's own short wording, including ones given in passing. Keep finished
tasks on the list until they have been reported as done once.

## 3. Collect the facts now

Do not answer from memory; check each item you will state.

- **Each task from step 2:** its status and the fact that proves it.

- **Work in progress:** your workers' state and last message (the T3 skill's
  session lookup), live runs and jobs on every computer used, and when each is
  expected to finish.
- **Finished since the last report:** worker reports, merged and open pull
  requests, installs and deploys, results written to evidence folders.
- **Not done:** assigned but unfinished, queued, not started, and waiting on
  something (name what).
- **Blockers:** errors, usage limits, hosts that do not answer, memory or disk
  that is short, and anything only the user can decide or do.

## 4. Pictures and videos

When a result is visual (a cloud, a view of the app, a render, a recording), copy
its newest pictures or video to this computer, look at them yourself, and embed
two to four with absolute paths, each with one line saying what it shows and any
defect visible in it. Prefer a picture next to its reference (photograph, before).
Say which result on disk is the current best and give its path. Skip this section
when nothing is visual or nothing is new.

## 5. Write the report

About half a page, in plain words. Name each item by what it is; an issue or pull
request number may follow it as a reference, never stand alone.

1. One opening sentence: the overall state, and whether the user has to do anything.
2. **Your tasks**: a table with one row per task from step 2: the task, its status
   (`Done`, `In progress`, `Blocked`, `Not started`), and why in a few words: what
   proves it done, what is running and when it should finish, what blocks it and
   who can unblock it, or what it waits for. Never mark a task done that was not
   verified; say "reported by a worker, not checked" when that is the case.
3. **Done since `<time>`**: outcomes, with the number that proves each.
4. **Running now**: what, where, expected finish.
5. **Not done or not started**: one line each, with what it waits for.
6. **Blockers and decisions for you**: only what the user must act on; leave the
   heading out when there is none.

Do not repeat in sections 3 to 5 what the task table already says. Mark what you
verified yourself and what a worker only reported. Give an item that has not
changed since the last report one line at most.

## 6. Remember this report

Write to the state file from step 1, replacing its content: the time, the task
list with each task's status, and one line per item reported as done, running and
open.
