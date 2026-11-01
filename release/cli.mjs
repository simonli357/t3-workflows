#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const trial = process.argv[2] === 'trial';
const result = spawnSync(process.env.T3W_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
  [fileURLToPath(new URL(trial ? './trial.py' : './release.py', import.meta.url)), ...process.argv.slice(trial ? 3 : 2)], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
