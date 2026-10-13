#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { accounts, models, settings, configPath, resolveProject, projectProfile } from "../skills/t3-fork-session/scripts/config.mjs";
const [command, ...args] = process.argv.slice(2);
const routes = { fork: "../skills/t3-fork-session/scripts/fork-session.mjs", capacity: "../skills/t3-fork-session/scripts/check-capacity.mjs", find: "../skills/t3-fork-session/scripts/find-session.mjs", "refresh-bases": "../skills/t3-fork-session/scripts/refresh-bases.mjs", install: "./install.mjs", doctor: "./install.mjs", "check-upstream": "./check-upstream.mjs", "install-schedule": "./install-schedule.mjs" };
try {
  if (command === "profile") {
    const i = args.indexOf("--project");
    const project = resolveProject(i >= 0 ? args[i + 1] : undefined);
    console.log(JSON.stringify({ configPath, project, profile: projectProfile(project) ?? { baseProject: project, basePrompt: "understand project" }, accounts, models }, null, 2));
  } else if (command === "update") {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const run = (cmd, argv) => { const r = spawnSync(cmd, argv, { cwd: root, stdio: "inherit" }); if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${r.error?.message ?? "see output"}`); };
    const dirty = spawnSync("git", ["status", "--porcelain"], {cwd:root,encoding:"utf8"});
    if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error("Commit or resolve local package changes before updating.");
    run("git", ["pull", "--ff-only"]);
    run(process.execPath, [fileURLToPath(new URL("./test.mjs", import.meta.url))]);
    run(process.execPath, [fileURLToPath(new URL("./install.mjs", import.meta.url))]);
  } else if (routes[command]) {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL(routes[command], import.meta.url)), ...(command === "doctor" ? ["--check"] : []), ...args], { stdio: "inherit" });
    if (r.error) throw r.error;
    process.exitCode = r.status ?? 1;
  } else {
    console.log("t3w profile [--project NAME_OR_PATH]\nt3w capacity [--cached]\nt3w fork --project NAME_OR_PATH --provider ACCOUNT --model MODEL --name TITLE --task TEXT --mcp-plan\nt3w find NAME\nt3w refresh-bases --project NAME_OR_PATH [--apply]\nt3w check-upstream [--review] [--force]\nt3w install | doctor | update | install-schedule");
    if (command && !["help", "--help", "-h"].includes(command)) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
