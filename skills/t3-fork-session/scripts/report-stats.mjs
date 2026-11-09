#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
// Counts worker reports per master and worker, to spot assignments sliced too thin.
// Reads this machine's T3 database read-only; it changes nothing.
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { settings } from "./config.mjs";
import { T3Client } from "./fork-session.mjs";

export function summarize(rows, titles, hours) {
  const masters = new Map();
  for (const row of rows) {
    const master = masters.get(row.target_id) ?? { masterId: row.target_id, master: titles.get(row.target_id) ?? row.target_id, done: 0, review: 0, blocked: 0, notices: 0, digests: 0, workers: new Map() };
    const key = row.id.startsWith("digest:") ? "digests" : row.kind === "notice" ? "notices" : row.kind;
    master[key] += 1;
    if (key !== "digests") master.workers.set(row.worker_id, (master.workers.get(row.worker_id) ?? 0) + 1);
    masters.set(row.target_id, master);
  }
  return [...masters.values()].map((m) => {
    const reports = m.done + m.review + m.blocked + m.notices;
    return {
      master: m.master, masterId: m.masterId, reports, perHour: Number((reports / hours).toFixed(1)),
      done: m.done, review: m.review, blocked: m.blocked, notices: m.notices, digests: m.digests,
      busiestWorkers: [...m.workers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([id, count]) => ({ worker: titles.get(id) ?? id, reports: count })),
    };
  }).sort((a, b) => b.reports - a.reports);
}

/**
 * Reports created in the last `hours`, read from the state file of the server's protocol.
 * A machine that has tried T3 V2 keeps both files, so which exist says nothing about which is live.
 */
export async function readReports({ home, protocol, hours }) {
  const { DatabaseSync } = await import("node:sqlite");
  // V2 keeps its state in statev2.sqlite with namespaced projection tables; the worker tables are shared.
  const v2 = protocol === 2;
  const db = new DatabaseSync(path.join(home, "userdata", v2 ? "statev2.sqlite" : "state.sqlite"), { readOnly: true });
  const titleTable = v2 ? "orchestration_v2_projection_threads" : "projection_threads";
  try {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    // Finished work that needs review is stored as done; its outcome line tells them apart.
    const rows = db.prepare(`SELECT id, worker_id, target_id,
        CASE WHEN id LIKE 'report:%' AND instr(prompt, char(10) || 'Outcome: done, needs review' || char(10)) > 0 THEN 'review' ELSE kind END AS kind
      FROM custom_worker_jobs
      WHERE kind IN ('done', 'blocked', 'notice') AND created_at >= ? AND target_id NOT LIKE 'peer:%'`).all(since);
    const ids = [...new Set(rows.flatMap((row) => [row.worker_id, row.target_id]))];
    const titles = new Map(ids.length ? db.prepare(`SELECT thread_id, title FROM ${titleTable} WHERE thread_id IN (${ids.map(() => "?").join(",")})`).all(...ids).map((r) => [r.thread_id, r.title]) : []);
    return summarize(rows, titles, hours);
  } finally { db.close(); }
}

async function main() {
  const { values } = parseArgs({ options: { hours: { type: "string", default: "24" }, home: { type: "string" }, server: { type: "string" }, json: { type: "boolean", default: false } } });
  const hours = Number(values.hours);
  if (!(hours > 0)) throw new Error("--hours must be a positive number.");
  const home = values.home ?? process.env.T3CODE_HOME ?? settings.connection?.home ?? path.join(homedir(), ".t3");
  const result = await readReports({ home, protocol: await new T3Client({ server: values.server, home }).detect(), hours });
  if (values.json) { console.log(JSON.stringify({ hours, masters: result }, null, 2)); return; }
  if (!result.length) { console.log(`No worker reports in the last ${hours} h.`); return; }
  console.log(`Worker reports in the last ${hours} h (digests = merged deliveries):`);
  for (const m of result) {
    console.log(`${m.master}: ${m.reports} reports (${m.perHour}/h) — done ${m.done}, needs review ${m.review}, blocked ${m.blocked}, runtime notices ${m.notices}, digests ${m.digests}`);
    for (const w of m.busiestWorkers) console.log(`    ${w.worker}: ${w.reports}`);
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
