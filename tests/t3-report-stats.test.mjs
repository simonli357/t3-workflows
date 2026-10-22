import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "../skills/t3-fork-session/scripts/report-stats.mjs";

test("report stats rank masters and their busiest workers, counting digests separately", () => {
  const rows = [
    { id: "report:a:1", worker_id: "a", target_id: "m", kind: "done" },
    { id: "report:a:2", worker_id: "a", target_id: "m", kind: "done" },
    { id: "report:b:1", worker_id: "b", target_id: "m", kind: "blocked" },
    { id: "notice:x:terminal", worker_id: "b", target_id: "m", kind: "notice" },
    { id: "digest:m:report:a:1", worker_id: "a", target_id: "m", kind: "done" },
    { id: "report:c:1", worker_id: "c", target_id: "n", kind: "done" },
  ];
  const [first, second] = summarize(rows, new Map([["m", "sim master"], ["a", "worker_a"]]), 2);
  assert.deepEqual(
    { master: first.master, reports: first.reports, perHour: first.perHour, done: first.done, blocked: first.blocked, notices: first.notices, digests: first.digests },
    { master: "sim master", reports: 4, perHour: 2, done: 2, blocked: 1, notices: 1, digests: 1 },
  );
  assert.deepEqual(first.busiestWorkers, [{ worker: "worker_a", reports: 2 }, { worker: "b", reports: 2 }]);
  assert.equal(second.master, "n");
});
