#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { accounts, models, settings, configPath, resolveProject, projectProfile } from "../skills/t3-fork-session/scripts/config.mjs";
import { T3Client } from "../skills/t3-fork-session/scripts/fork-session.mjs";
const [command, ...args] = process.argv.slice(2);
const routes = { "worker-profile": "../skills/t3-fork-session/scripts/worker-profile.mjs", fork: "../skills/t3-fork-session/scripts/fork-session.mjs", capacity: "../skills/t3-fork-session/scripts/check-capacity.mjs", find: "../skills/t3-fork-session/scripts/find-session.mjs", "refresh-bases": "../skills/t3-fork-session/scripts/refresh-bases.mjs", peer: "../skills/t3-fork-session/scripts/peers.mjs", install: "./install.mjs", doctor: "./install.mjs", "check-upstream": "./check-upstream.mjs", "install-schedule": "./install-schedule.mjs" };
try {
  if (command === "environment") {
    const client = new T3Client({ timeout: 30 });
    try { await client.connect(); console.log(JSON.stringify((await client.rpc("server.getConfig", {}).promise).environment)); }
    finally { await client.close(); }
  } else if (command === "profile") {
    const i = args.indexOf("--project");
    const project = resolveProject(i >= 0 ? args[i + 1] : undefined);
    console.log(JSON.stringify({ configPath, project, profile: projectProfile(project) ?? { baseProject: project, basePrompt: "understand project" }, accounts, models }, null, 2));
  } else if (command === "update") {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const run = (cmd, argv) => { const r = spawnSync(cmd, argv, { cwd: root, stdio: "inherit" }); if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${r.error?.message ?? "see output"}`); };
    const dirty = spawnSync("git", ["status", "--porcelain"], {cwd:root,encoding:"utf8"});
    if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error("Commit or resolve local package changes before updating.");
    run("git", ["pull", "--ff-only"]);
    run(process.execPath, [fileURLToPath(new URL("./run-checks.mjs", import.meta.url))]);
    run(process.execPath, [fileURLToPath(new URL("./install.mjs", import.meta.url))]);
  } else if (command === "spawn" || routes[command]) {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL(routes[command === "spawn" ? "fork" : command], import.meta.url)), ...(command === "spawn" ? ["--fresh"] : []), ...(command === "doctor" ? ["--check"] : []), ...args], { stdio: "inherit" });
    if (r.error) throw r.error;
    process.exitCode = r.status ?? 1;
  } else {
    console.log("t3w profile [--project NAME_OR_PATH]\nt3w capacity [--cached]\nt3w spawn --project NAME_OR_PATH --provider ACCOUNT --model MODEL --name TITLE --task-file FILE --mcp-plan [--environment PEER]\nt3w fork --project NAME_OR_PATH --provider ACCOUNT --model MODEL --name TITLE --task-file FILE [--source-thread UUID] --mcp-plan\nt3w worker-profile --thread-id UUID [--provider ACCOUNT] [--model MODEL] [--effort EFFORT] [--environment PEER]\nt3w fork --self-fork --provider ACCOUNT --model MODEL --name TITLE --task-file FILE --handoff-plan\nt3w find NAME [--environment NAME]\nt3w peer link SSH_ALIAS --local-url URL --remote-url URL | peer list | peer check | peer remove NAME\nt3w refresh-bases --project NAME_OR_PATH [--apply]\nt3w check-upstream [--review] [--force]\nt3w environment | install | doctor | update | install-schedule");
    if (command && !["help", "--help", "-h"].includes(command)) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
