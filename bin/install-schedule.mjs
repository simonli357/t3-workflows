#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
if(process.platform!=="linux")throw new Error("Install the weekly timer on the Linux coordinator; Windows consumes the same reports and does not schedule duplicate reviews.");
const directory=path.join(homedir(),".config","systemd","user");
mkdirSync(directory,{recursive:true});
const script=fileURLToPath(new URL("./check-upstream.mjs",import.meta.url));
writeFileSync(path.join(directory,"t3-upstream-review.service"),`[Unit]\nDescription=Review upstream T3 releases without installing updates\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=oneshot\nEnvironment="PATH=${process.env.PATH}"\nExecStart="${process.execPath}" "${script}" --review\nTimeoutStartSec=25min\nRestart=on-failure\nRestartSec=1h\n`);
writeFileSync(path.join(directory,"t3-upstream-review.timer"),`[Unit]\nDescription=Weekly upstream T3 review\n\n[Timer]\nOnCalendar=Mon *-*-* 10:00:00\nPersistent=true\nRandomizedDelaySec=10min\n\n[Install]\nWantedBy=timers.target\n`);
execFileSync("systemctl",["--user","daemon-reload"],{stdio:"inherit"});
execFileSync("systemctl",["--user","enable","--now","t3-upstream-review.timer"],{stdio:"inherit"});
execFileSync("systemctl",["--user","list-timers","t3-upstream-review.timer","--no-pager"],{stdio:"inherit"});
