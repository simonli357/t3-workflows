#!/usr/bin/env node
// Read-only helper for whoever authors a failed-before-closure decision: observes, now, exactly what the decision has
// to pin (every retained failure file and staging tree, the listener identity, the pinned successor) and prints it.
// Writes nothing except --out. A decision is only as good as its review: compare every value independently
// (Get-FileHash, Get-CimInstance Win32_Process) before using it with `cli.mjs reconcile`.
//
//   node prepared-decision.mjs --config HOSTS.json --manifest SUCCESSOR.json --target HOST --id OLD_DEPLOYMENT_ID
//        [--reviewed-current-files FILE.json] [--out decision.json]
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { check, read, save, validateManifest, DeployError } from './core.mjs';
import { makeNative, hostPaths, validateTarget } from './native.mjs';
import { describePrepared } from './prepared-review.mjs';

export function describe(values) {
  check(values.config && values.manifest && values.target && values.id, 'usage', 'Needs --config, --manifest, --target and --id');
  const config = read(path.resolve(values.config)), manifestPath = path.resolve(values.manifest), m = validateManifest(read(manifestPath));
  const t = config.targets?.[values.target]; check(t, 'config', 'Unknown target: ' + values.target);
  validateTarget(t);
  const locations = hostPaths(t, m);
  const reviewedCurrentFiles = values['reviewed-current-files'] ? read(path.resolve(values['reviewed-current-files'])) : undefined;
  return describePrepared({ root: locations.root, id: values.id, successor: m, target: t, listener: makeNative(t, m, manifestPath).listenerIdentity(), reviewedCurrentFiles });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), options: { config: { type: 'string' }, manifest: { type: 'string' }, target: { type: 'string' }, id: { type: 'string' }, 'reviewed-current-files': { type: 'string' }, out: { type: 'string' } } });
    const decision = describe(values);
    if (values.out) save(path.resolve(values.out), decision);
    console.log(JSON.stringify(decision, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ phase: 'blocked', code: error.code ?? 'io', message: error instanceof DeployError ? error.message : String(error.message ?? error) }));
    process.exitCode = 1;
  }
}
