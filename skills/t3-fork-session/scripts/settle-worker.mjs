#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { T3Client } from "./fork-session.mjs";

export async function settleWorker(client, threadId) {
  const thread = await client.thread(threadId);
  if (thread.session?.activeTurnId || thread.latestTurn?.state === "running")
    throw new Error(`${thread.title} has a running turn; review it after it finishes or stop it in T3 before settling.`);
  await client.dispatch({ type: "thread.settle", commandId: `settle:${threadId}:${randomUUID()}`, threadId });
  const settled = await client.thread(threadId);
  if (!settled.settledAt) throw new Error(`${settled.title} was not marked settled.`);
  return { threadId, title: settled.title, settledAt: settled.settledAt };
}

async function main() {
  const { values } = parseArgs({ options: {
    "thread-id": { type: "string" }, server: { type: "string" }, home: { type: "string" }, cli: { type: "string" },
    timeout: { type: "string", default: "60" }, environment: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help || !values["thread-id"]) {
    console.log("Usage: node settle-worker.mjs --thread-id UUID [--server URL] [--home PATH] [--cli PATH] [--timeout SECONDS] [--environment PEER]\nSettle an accepted worker this master owns and verify T3 marks it settled. Refuses while a turn is running.");
    if (!values.help) process.exitCode = 1;
    return;
  }
  // A worker on a linked machine is settled on that machine's server.
  const client = values.environment
    ? (await import("./peers.mjs")).peerClient(values.environment, { home: values.home, timeout: Number(values.timeout) }).client
    : new T3Client({ server: values.server, home: values.home, cli: values.cli, timeout: Number(values.timeout) });
  try {
    await client.connect();
    console.log(JSON.stringify(await settleWorker(client, values["thread-id"]), null, 2));
  } finally { await client.close(); }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
