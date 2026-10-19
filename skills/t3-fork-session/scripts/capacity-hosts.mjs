import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { combineCapacity } from "./capacity-load.mjs";

const run = promisify(execFile);

export async function readRemoteCapacity(remote, { cached = false, loadOnly = false, timeout = 90 } = {}) {
  if (!remote.label || !remote.ssh || !remote.command) throw new Error("Each capacity remote needs label, ssh and command.");
  const flags = ` --local-only --timeout ${timeout}${cached ? " --cached" : ""}${loadOnly ? " --load-only" : ""}`;
  const { stdout } = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", remote.ssh, remote.command + flags],
    { timeout: (timeout + 15) * 1000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const report = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  if (!report.environment?.environmentId || !Array.isArray(report.accounts) || report.accounts.some((a) => !a.load)) {
    throw new Error("Remote capacity helper is outdated or did not return a load report; update its global t3-workflows installation.");
  }
  return report;
}

export async function checkHosts(local, remotes, { label = "local", readRemote = readRemoteCapacity, ...options } = {}) {
  const hosts = await Promise.all(remotes.map(async (remote) => {
    try { return { label: remote.label, report: await readRemote(remote, options) }; }
    catch (error) { return { label: remote.label, error: String(error.message ?? error) }; }
  }));
  return combineCapacity([{ label, report: local }, ...hosts]);
}
