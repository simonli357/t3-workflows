import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readReports, summarize } from "../skills/t3-fork-session/scripts/report-stats.mjs";

test("report stats rank masters and their busiest workers, counting digests separately", () => {
  const rows = [
    { id: "report:a:1", worker_id: "a", target_id: "m", kind: "done" },
    { id: "report:a:2", worker_id: "a", target_id: "m", kind: "done" },
    { id: "report:b:1", worker_id: "b", target_id: "m", kind: "blocked" },
    { id: "report:b:2", worker_id: "b", target_id: "m", kind: "review" },
    { id: "notice:x:terminal", worker_id: "b", target_id: "m", kind: "notice" },
    { id: "digest:m:report:a:1", worker_id: "a", target_id: "m", kind: "done" },
    { id: "report:c:1", worker_id: "c", target_id: "n", kind: "done" },
  ];
  const [first, second] = summarize(rows, new Map([["m", "sim master"], ["a", "worker_a"]]), 2);
  assert.deepEqual(
    { master: first.master, reports: first.reports, perHour: first.perHour, done: first.done, review: first.review, blocked: first.blocked, notices: first.notices, digests: first.digests },
    { master: "sim master", reports: 5, perHour: 2.5, done: 2, review: 1, blocked: 1, notices: 1, digests: 1 },
  );
  assert.deepEqual(first.busiestWorkers, [{ worker: "b", reports: 3 }, { worker: "worker_a", reports: 2 }]);
  assert.equal(second.master, "n");
});

test("report stats read the database of the server's protocol when both files exist", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "t3w-reports-"));
  mkdirSync(path.join(home, "userdata"));
  const seed = (file, titleTable, master, prompts) => {
    const db = new DatabaseSync(path.join(home, "userdata", file));
    db.exec(`CREATE TABLE custom_worker_jobs (id TEXT, worker_id TEXT, target_id TEXT, kind TEXT, prompt TEXT, created_at TEXT);
      CREATE TABLE ${titleTable} (thread_id TEXT, title TEXT);`);
    db.prepare(`INSERT INTO ${titleTable} VALUES ('m', ?)`).run(master);
    for (const [index, [kind, prompt]] of prompts.entries())
      db.prepare("INSERT INTO custom_worker_jobs VALUES (?, 'w', 'm', ?, ?, ?)").run(`report:w:${index}`, kind, prompt, new Date().toISOString());
    db.close();
  };
  try {
    seed("state.sqlite", "projection_threads", "v1 master", [["done", "[h]\nWorker: w\nOutcome: done\nFinished."], ["done", "[h]\nWorker: w\nOutcome: done, needs review\nPlease merge."], ["blocked", "[h]\nWorker: w\nOutcome: blocked, needs the user\nKey."]]);
    seed("statev2.sqlite", "orchestration_v2_projection_threads", "v2 master", [["done", "[h]\nWorker: w\nOutcome: done\nStale."]]);
    const [v1] = await readReports({ home, protocol: 1, hours: 1 });
    assert.deepEqual({ master: v1.master, done: v1.done, review: v1.review, blocked: v1.blocked }, { master: "v1 master", done: 1, review: 1, blocked: 1 });
    const [v2] = await readReports({ home, protocol: 2, hours: 1 });
    assert.deepEqual({ master: v2.master, reports: v2.reports }, { master: "v2 master", reports: 1 });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
