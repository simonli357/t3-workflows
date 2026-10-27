#!/usr/bin/env node
// Links T3 environments so worker tools and session messages reach each other.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { settings } from "./config.mjs";
import { T3Client } from "./fork-session.mjs";

export const PEER_ROUTE = "/api/peer/v1";
const defaultHome = () => process.env.T3CODE_HOME ?? settings.connection?.home ?? path.join(homedir(), ".t3");
const defaultCli = () => process.env.T3_FORK_CLI ?? settings.connection?.cli ?? "t3";
/** The server reads this secret on each request, so changes apply without a restart. */
export const peerFile = (home = defaultHome()) => path.join(home, "userdata", "secrets", "peer-environments.bin");

export function readPeers(home) {
  const file = peerFile(home);
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf8")).peers ?? [];
}

export function writePeers(home, peers) {
  const file = peerFile(home);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ peers }, null, 2), { mode: 0o600 });
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

export function upsertPeer(peers, peer) {
  for (const key of ["environmentId", "label", "url", "token"])
    if (typeof peer[key] !== "string" || !peer[key].trim()) throw new Error(`Peer ${key} is required.`);
  return [...peers.filter((p) => p.environmentId !== peer.environmentId && p.label.toLowerCase() !== peer.label.toLowerCase()), peer];
}

export function findPeer(peers, nameOrId) {
  const peer = peers.find((p) => p.environmentId === nameOrId || p.label.toLowerCase() === String(nameOrId).toLowerCase());
  if (!peer) throw new Error(`No linked environment named ${nameOrId}. Run t3w peer link first.`);
  return peer;
}

/** A client for a linked environment's own server, authenticated with its peer token. */
export function peerClient(nameOrId, { home, timeout } = {}) {
  const peer = findPeer(readPeers(home), nameOrId);
  return { peer, client: new T3Client({ server: peer.url, token: peer.token, timeout }) };
}

async function localEnvironment() {
  const client = new T3Client({ timeout: 30 });
  try { await client.connect(); return (await client.rpc("server.getConfig", {}).promise).environment; }
  finally { await client.close(); }
}

async function ping(peer, from) {
  const response = await fetch(new URL(PEER_ROUTE, peer.url), {
    method: "POST",
    headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, request: { _tag: "ping" } }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// The remote side runs this same script through its own t3w (for example on Windows).
function remote(ssh, command, args, input) {
  return execFileSync("ssh", ["-o", "BatchMode=yes", ssh, [command, ...args].join(" ")], {
    encoding: "utf8", timeout: 120000, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

function remoteCommand(ssh, explicit) {
  if (explicit) return explicit;
  const entry = [...(settings.upstream?.remoteEnvironments ?? []), ...(settings.capacity?.remoteEnvironments ?? [])]
    .find((e) => e.ssh === ssh && /t3w\.mjs/.test(e.command));
  if (!entry) throw new Error(`Pass --remote-command for ${ssh}, e.g. "node C:/Users/me/t3-workflows/bin/t3w.mjs".`);
  return entry.command.slice(0, entry.command.indexOf("t3w.mjs") + "t3w.mjs".length);
}

function issueToken(label, ttl) {
  return JSON.parse(execFileSync(defaultCli(), ["auth", "session", "issue", "--base-dir", defaultHome(), "--ttl", ttl, "--label", label, "--json"], {
    encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
  })).token;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    label: { type: "string" }, ttl: { type: "string", default: "365d" }, "environment-id": { type: "string" },
    url: { type: "string" }, "local-url": { type: "string" }, "remote-url": { type: "string" },
    "remote-command": { type: "string" }, json: { type: "boolean", default: false },
  } });
  const home = defaultHome();
  if (command === "issue") {
    // Prints a token for the other environment; only `peer link` should call this.
    const environment = await localEnvironment();
    console.log(JSON.stringify({ environmentId: environment.environmentId, label: environment.label, token: issueToken(values.label ?? "peer link", values.ttl) }));
  } else if (command === "add") {
    const token = readFileSync(0, "utf8").trim();
    writePeers(home, upsertPeer(readPeers(home), { environmentId: values["environment-id"], label: values.label, url: values.url, token }));
    console.log(`Linked ${values.label} (${values["environment-id"]}) at ${values.url}.`);
  } else if (command === "remove") {
    const peer = findPeer(readPeers(home), positionals[0]);
    writePeers(home, readPeers(home).filter((p) => p.environmentId !== peer.environmentId));
    console.log(`Removed the link to ${peer.label}. Revoke its token on that machine with t3 auth session revoke.`);
  } else if (command === "list") {
    console.log(JSON.stringify(readPeers(home).map(({ token, ...peer }) => peer), null, 2));
  } else if (command === "check") {
    const from = (await localEnvironment()).environmentId;
    let failed = false;
    for (const peer of readPeers(home)) {
      try { const reply = await ping(peer, from); console.log(`ok ${peer.label} ${reply.environmentId}`); }
      catch (error) { failed = true; console.log(`FAILED ${peer.label} ${peer.url}: ${error.message}`); }
    }
    process.exitCode = failed ? 1 : 0;
  } else if (command === "link") {
    const ssh = positionals[0];
    if (!ssh || !values["local-url"] || !values["remote-url"]) throw new Error("Usage: t3w peer link SSH_ALIAS --local-url URL --remote-url URL [--remote-command CMD]");
    const cmd = remoteCommand(ssh, values["remote-command"]);
    const local = await localEnvironment();
    const theirs = JSON.parse(remote(ssh, cmd, ["peer", "issue", "--label", `peer-${local.label}`, "--ttl", values.ttl]));
    const ours = issueToken(`peer-${theirs.label}`, values.ttl);
    writePeers(home, upsertPeer(readPeers(home), { environmentId: theirs.environmentId, label: theirs.label, url: values["remote-url"], token: theirs.token }));
    remote(ssh, cmd, ["peer", "add", "--environment-id", local.environmentId, "--label", local.label, "--url", values["local-url"]], ours);
    const reply = await ping(findPeer(readPeers(home), theirs.environmentId), local.environmentId);
    const back = remote(ssh, cmd, ["peer", "check"]);
    console.log(`Linked ${local.label} <-> ${reply.label} (${reply.environmentId}).\n${back.trim()}`);
  } else {
    console.log("t3w peer link SSH_ALIAS --local-url URL --remote-url URL [--remote-command CMD] [--ttl 365d]\nt3w peer list | check | remove NAME_OR_ID\n(peer issue / peer add are run by link on the other machine)");
    if (command && !["help", "--help", "-h"].includes(command)) process.exitCode = 1;
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
