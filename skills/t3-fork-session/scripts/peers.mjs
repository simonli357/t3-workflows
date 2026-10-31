#!/usr/bin/env node
// Links T3 environments so worker tools and session messages reach each other.
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
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

/**
 * A client for a linked environment. A V1 link is a token in peer-environments.bin and the client
 * talks to that environment's own server. A V2 link lives in the local server, which is the only
 * thing that can reach the other environment, so the client plans through the local server.
 */
export function peerClient(nameOrId, { home, timeout } = {}) {
  const peers = readPeers(home);
  if (peers.length || !nameOrId) {
    const peer = findPeer(peers, nameOrId);
    return { peer, client: new T3Client({ server: peer.url, token: peer.token, timeout }) };
  }
  const client = new LinkedClient(nameOrId, { home, timeout });
  return { peer: { label: nameOrId }, client };
}

const cliJson = async (args, { home = defaultHome(), cli = defaultCli() } = {}) =>
  JSON.parse((await promisify(execFile)(cli, [...args, "--base-dir", home, "--json"], { encoding: "utf8", timeout: 30000 })).stdout.replace(/^[^{[]*(?=[{[])/s, ""));

/** The scopes a pairing code must carry for an access level; the same table the server checks (mcpClientScopes). */
export const accessScopes = (access) => access === "read-only" ? ["orchestration:read"]
  : access === "full-access" ? ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"]
    : ["orchestration:read", "orchestration:operate"];
export const ACCESS_LEVELS = ["read-only", "approval-required", "auto-accept-edits", "auto", "full-access"];

export const linkMatches = (link, nameOrId) => link.environmentId === nameOrId || link.label.toLowerCase() === String(nameOrId).toLowerCase();

/** A linked environment of a V2 server, as `t3w` plans against it: placement advice carries its projects. */
export class LinkedClient extends T3Client {
  constructor(name, options = {}) {
    super({ timeout: options.timeout, ...(options.server ? { server: options.server } : {}) });
    this.linkName = name;
    this.linked = true;
  }

  async connect() {
    await super.connect();
    requireV2(this.protocol, `${this.linkName} is a linked environment, and links of a V1 server live in peer-environments.bin.`);
    const { links } = await this.rpc("peerLinks.list", {}).promise;
    const matches = links.filter((link) => linkMatches(link, this.linkName));
    if (matches.length !== 1) throw new Error(matches.length ? `${this.linkName} names several linked environments; use its environment ID.` : `No linked environment named ${this.linkName}. Run t3w peer link first.`);
    this.link = matches[0];
    if (this.link.status !== "reachable") throw new Error(`${this.link.label} is ${this.link.status}${this.link.lastError ? `: ${this.link.lastError}` : ""}.`);
  }

  /** The other computer's checkouts of a local project's repository, from placement advice. */
  async checkouts(localProjectId) {
    const response = await this.rpc("providerAllocation.execute", { _tag: "placement", request: { projectId: localProjectId, environmentId: this.link.environmentId } }).promise;
    return response.placement.hosts.find((host) => host.environmentId === this.link.environmentId)?.projects ?? [];
  }

  /** Remote projects are named by ID or title; one that matches a local project resolves through its repository. */
  async shell() {
    const local = await super.http("/api/orchestration/shell");
    const hint = this.projectHint;
    const localProject = hint && local.projects.find((p) => [p.id, p.title, p.workspaceRoot].some((v) => v && v.toLowerCase?.() === String(hint).toLowerCase()));
    const found = localProject ? await this.checkouts(localProject.id) : [];
    // A checkout found through the local project answers to the name the caller used for it.
    const projects = found.length ? found.map((p) => ({ id: p.id, title: p.title, workspaceRoot: hint })) : hint ? [{ id: hint, title: hint, workspaceRoot: hint }] : [];
    return { projects, threads: [] };
  }

  async http(route, body) {
    if (route.startsWith("/api/auth/")) return super.http(route, body);
    if (route === "/api/orchestration/shell" && body === undefined) return this.shell();
    throw new Error(`${this.link?.label ?? this.linkName} is reached through this server's link. ${route} needs a direct connection; use the T3 MCP tools with environmentId instead.`);
  }

  /** The destination's catalog is not readable from here, so its accounts and models are checked by its own server when the work starts. */
  rpc(tag, payload, onValue) {
    if (tag !== "server.getConfig") return super.rpc(tag, payload, onValue);
    const id = "linked-config";
    const promise = super.rpc(tag, payload, onValue).promise.then((config) => ({ ...config, environment: { ...config.environment, environmentId: this.link.environmentId, label: this.link.label } }));
    return { id, promise };
  }

  async thread() { throw new Error(`${this.link.label} runs on a linked computer; read or settle its sessions with the T3 MCP tools (t3_thread_read, t3_thread_organize) and environmentId.`); }
}

function requireV2(protocol, message) {
  if (protocol !== 2) throw new Error(message);
}

/** Runs `use` with a connected client of this computer's own server. */
async function withLocal(connection, use) {
  const client = new T3Client({ timeout: 30, ...(connection.server ? { server: connection.server } : {}), ...(connection.home ? { home: connection.home } : {}), ...(connection.cli ? { cli: connection.cli } : {}) });
  try { await client.connect(); return await use(client); }
  finally { await client.close(); }
}
const localEnvironment = (connection = {}) => withLocal(connection, async (client) => (await client.rpc("server.getConfig", {}).promise).environment);
/** 2 when this computer's server is T3 V2, whose links it holds itself; 1 when it uses peer-environments.bin. */
const localProtocol = async (connection = {}) => {
  const client = new T3Client({ timeout: 15, ...(connection.server ? { server: connection.server } : {}) });
  return client.detect();
};

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
  const quote = (arg) => /[^\w@%+=:,./\\-]/.test(arg) ? JSON.stringify(arg) : arg;
  return execFileSync("ssh", ["-o", "BatchMode=yes", ssh, [command, ...args.map(quote)].join(" ")], {
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

function issueToken(label, ttl, { home = defaultHome(), cli = defaultCli() } = {}) {
  return JSON.parse(execFileSync(cli, ["auth", "session", "issue", "--base-dir", home, "--ttl", ttl, "--label", label, "--json"], {
    encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
  })).token;
}

// V2: this server holds the links. The pairing code the other side mints is exchanged for a session there.
const linkSummary = (link) => ({ environmentId: link.environmentId, label: link.label, url: link.urls[0], urls: link.urls, access: link.access,
  status: link.status, linkedAt: link.linkedAt, expiresAt: link.expiresAt, lastReachedAt: link.lastReachedAt, lastError: link.lastError });

async function linkV2(connection, input) {
  return withLocal(connection, (client) => client.rpc("peerLinks.link", input).promise);
}

/** The pairing code the other environment links with, limited to what the chosen access needs. */
async function pairingCode(label, access, ttl, connection) {
  const scopes = accessScopes(access).flatMap((scope) => ["--scope", scope]);
  return (await cliJson(["auth", "pairing", "create", "--ttl", ttl, "--label", label, ...scopes], connection)).credential;
}

async function mainV2(command, values, positionals, connection) {
  const access = values.access ?? "full-access";
  if (!ACCESS_LEVELS.includes(access)) throw new Error(`--access must be one of ${ACCESS_LEVELS.join(", ")}.`);
  if (command === "issue") {
    // Prints a pairing code for the other environment; only `peer link` should call this.
    const environment = await localEnvironment(connection);
    console.log(JSON.stringify({ protocol: 2, environmentId: environment.environmentId, label: environment.label,
      pairingCode: await pairingCode(values.label ?? "peer link", access, values["code-ttl"], connection) }));
  } else if (command === "add") {
    const pairing = readFileSync(0, "utf8").trim();
    if (!values.url || !values["environment-id"]) throw new Error("Usage: t3w peer add --environment-id ID --label NAME --url URL [--access ACCESS] < pairing-code");
    const link = await linkV2(connection, { url: values.url, pairingCode: pairing, access, expectedEnvironmentId: values["environment-id"], ...(values.label ? { expectedLabel: values.label } : {}) });
    console.log(`Linked ${link.label} (${link.environmentId}) at ${values.url}.`);
  } else if (command === "remove") {
    const removed = await withLocal(connection, async (client) => {
      const { links } = await client.rpc("peerLinks.list", {}).promise;
      const matches = links.filter((link) => linkMatches(link, positionals[0]));
      if (matches.length !== 1) throw new Error(matches.length ? `${positionals[0]} names several linked environments; use its environment ID.` : `No linked environment named ${positionals[0]}.`);
      await client.rpc("peerLinks.unlink", { environmentId: matches[0].environmentId }).promise;
      return matches[0];
    });
    console.log(`Removed the link to ${removed.label}. Revoke this environment's session in that one's Connections settings to end it there too.`);
  } else if (command === "list" || command === "check") {
    const { links } = await withLocal(connection, (client) => client.rpc("peerLinks.list", {}).promise);
    if (command === "list") { console.log(JSON.stringify(links.map(linkSummary), null, 2)); return; }
    let failed = false;
    for (const link of links) {
      if (link.status === "reachable") console.log(`ok ${link.label} ${link.environmentId}`);
      else { failed = true; console.log(`FAILED ${link.label} ${link.urls[0]}: ${link.lastError ?? link.status}`); }
    }
    process.exitCode = failed ? 1 : 0;
  } else if (command === "link") {
    const ssh = positionals[0];
    if (!ssh || !values["local-url"] || !values["remote-url"]) throw new Error("Usage: t3w peer link SSH_ALIAS --local-url URL --remote-url URL [--remote-command CMD] [--access ACCESS]");
    const cmd = remoteCommand(ssh, values["remote-command"]);
    const local = await localEnvironment(connection);
    const theirs = JSON.parse(remote(ssh, cmd, ["peer", "issue", "--label", `peer-${local.label}`, "--access", access, "--code-ttl", values["code-ttl"]]));
    if (theirs.protocol !== 2) throw new Error(`${ssh} runs T3 V1; a V2 server and a V1 server cannot be linked.`);
    const ours = await pairingCode(`peer-${theirs.label}`, access, values["code-ttl"], connection);
    const link = await linkV2(connection, { url: values["remote-url"], pairingCode: theirs.pairingCode, access, expectedEnvironmentId: theirs.environmentId, expectedLabel: theirs.label });
    remote(ssh, cmd, ["peer", "add", "--environment-id", local.environmentId, "--label", local.label, "--url", values["local-url"], "--access", access], ours);
    const back = remote(ssh, cmd, ["peer", "check"]);
    console.log(`Linked ${local.label} <-> ${link.label} (${link.environmentId}).\n${back.trim()}`);
  } else usage(command);
}

function usage(command) {
  console.log("t3w peer link SSH_ALIAS --local-url URL --remote-url URL [--remote-command CMD] [--access ACCESS] [--ttl 365d]\nt3w peer list | check | remove NAME_OR_ID\n(peer issue / peer add are run by link on the other machine)\nCommon: --server URL --home PATH --cli PATH select this computer's T3 server.\nT3 V2 servers hold their own links: --access (read-only, approval-required, auto-accept-edits, auto, full-access; default full-access) is what each side's agents may do on the other. Placement advice, remote workers and moves are peer requests, which a server accepts only from a full-access link; a lower access limits the link to the other server's own MCP tools. V1 servers use bearer tokens in peer-environments.bin.");
  if (command && !["help", "--help", "-h"].includes(command)) process.exitCode = 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    label: { type: "string" }, ttl: { type: "string", default: "365d" }, "code-ttl": { type: "string", default: "10m" }, access: { type: "string" },
    "environment-id": { type: "string" },
    url: { type: "string" }, "local-url": { type: "string" }, "remote-url": { type: "string" },
    "remote-command": { type: "string" }, json: { type: "boolean", default: false },
    server: { type: "string" }, home: { type: "string" }, cli: { type: "string" },
  } });
  const connection = { server: values.server, home: values.home, cli: values.cli };
  const home = values.home ?? defaultHome();
  if (!command || ["help", "--help", "-h"].includes(command)) return usage(command);
  if (await localProtocol(connection) === 2) return mainV2(command, values, positionals, connection);
  if (command === "issue") {
    // Prints a token for the other environment; only `peer link` should call this.
    const environment = await localEnvironment(connection);
    console.log(JSON.stringify({ environmentId: environment.environmentId, label: environment.label, token: issueToken(values.label ?? "peer link", values.ttl, connection) }));
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
    const from = (await localEnvironment(connection)).environmentId;
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
    const local = await localEnvironment(connection);
    const theirs = JSON.parse(remote(ssh, cmd, ["peer", "issue", "--label", `peer-${local.label}`, "--ttl", values.ttl]));
    if (theirs.protocol === 2) throw new Error(`${ssh} runs T3 V2; a V1 server and a V2 server cannot be linked.`);
    const ours = issueToken(`peer-${theirs.label}`, values.ttl, connection);
    writePeers(home, upsertPeer(readPeers(home), { environmentId: theirs.environmentId, label: theirs.label, url: values["remote-url"], token: theirs.token }));
    remote(ssh, cmd, ["peer", "add", "--environment-id", local.environmentId, "--label", local.label, "--url", values["local-url"]], ours);
    const reply = await ping(findPeer(readPeers(home), theirs.environmentId), local.environmentId);
    const back = remote(ssh, cmd, ["peer", "check"]);
    console.log(`Linked ${local.label} <-> ${reply.label} (${reply.environmentId}).\n${back.trim()}`);
  } else usage(command);
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
