#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { check, DeployError, read, save, sha, digest, inventory, validateManifest, execute, preflight } from './core.mjs';
import { run, makeNative, hostPaths, validateTarget } from './native.mjs';
import { readDeployment } from './cancel.mjs';

const entry = fileURLToPath(import.meta.url), here = path.dirname(entry);
export const shellQuote = text => "'" + String(text).replaceAll("'", "'\\''") + "'";
export const psQuote = text => "'" + String(text).replaceAll("'", "''") + "'";
export function remoteArgs(remote, command, expectedHash, dryRun = false) {
  check(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(remote.ssh), 'config', 'Use an existing pinned SSH alias, without options');
  check(['posix', 'powershell'].includes(remote.shell), 'config', 'Select the remote login shell');
  const args = [remote.node, remote.entry, command, '--config', remote.config, '--manifest', remote.manifest, '--target', remote.target, '--manifest-sha', expectedHash];
  if (dryRun) { check(command === 'cancel', 'usage', '--dry-run is supported for cancel only'); args.push('--dry-run'); }
  check(args.every(a => typeof a === 'string' && a.length && !/[\x00-\x1f]/.test(a)), 'config', 'Invalid remote path or argument');
  const commandText = remote.shell === 'posix' ? args.map(shellQuote).join(' ') : 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from('& ' + args.map(psQuote).join(' ') + '; exit $LASTEXITCODE', 'utf16le').toString('base64');
  return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '--', remote.ssh, commandText];
}
export function checkClaim(locations, manifestHash) {
  if (!fs.existsSync(locations.claim)) return;
  check(fs.lstatSync(locations.claim).isFile() && !fs.lstatSync(locations.claim).isSymbolicLink() && fs.realpathSync(locations.claim) === path.resolve(locations.claim), 'conflict', 'Claim must be a canonical regular file');
  const claim = read(locations.claim);
  if (claim.manifestHash === manifestHash) return;
  check(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(claim.id), 'conflict', 'Invalid existing claim');
  const deployment = path.join(locations.root, claim.id);
  const receipt = readDeployment({ ...locations, deployment, receipt: path.join(deployment, 'receipt.json') });
  check(receipt.id === claim.id && receipt.manifestHash === claim.manifestHash && (['accepted', 'cancelled'].includes(receipt.phase) || (receipt.phase === 'superseded' && receipt.supersession.successor.manifestHash === manifestHash)), 'conflict', 'Another release owns an unfinished deployment; inspect its receipt');
}
export async function hostRun(request, requestPath) {
  const { manifest: m, target: t, manifestPath, command } = request;
  validateManifest(m); validateTarget(t);
  check(!m.measurementOnly || ['measure-backup', 'status'].includes(command), 'recovery', 'Measurement plans cannot activate');
  const locations = hostPaths(t, m), manifestHash = digest(JSON.stringify(m));
  const state = readDeployment(locations);
  check(!state.manifestHash || state.manifestHash === manifestHash, 'conflict', 'Deployment manifest changed since prior receipt');
  check(!state.targetHash || state.targetHash === digest(JSON.stringify(t)), 'conflict', 'Target configuration changed since prior receipt');
  check(state.phase !== 'superseded' || command === 'status', 'recovery', 'Failed release superseded; use its pinned successor');
  if (state.phase === 'cancelled') {
    check(['cancel', 'status'].includes(command), 'cancelled', 'This release was cancelled before activation; use a new deployment id');
    return state;
  }
  if (['measure-backup', 'adopt-backup'].includes(command)) {
    const adapter = makeNative(t, m, manifestPath, { requestPath });
    return command === 'measure-backup' ? adapter.measureBackup(request.recovery) : adapter.adoptBackup(request.recovery);
  }
  if (command === 'reconcile') {
    const adapter = makeNative(t, m, manifestPath, { requestPath });
    return adapter.reconcile(request.recovery);
  }
  checkClaim(locations, manifestHash);
  // This method is reached only from the Python OS-lock holder.
  if (command !== 'cancel') save(locations.claim, { id: m.id, manifestHash });
  const adapter = makeNative(t, m, manifestPath, { requestPath });
  return execute(m, t, adapter, state, command);
}
function makeManifest(specPath, output) {
  const spec = read(specPath), root = path.dirname(output);
  const payloads = spec.payloads.map(p => {
    const payloadRoot = path.resolve(path.dirname(specPath), p.root);
    const { root: ignored, ...metadata } = p;
    const files = inventory(payloadRoot).filter(f => f !== '.install-complete').map(rel => {
      const full = path.join(payloadRoot, rel), stat = fs.statSync(full);
      return { path: rel, source: path.relative(root, full).replaceAll('\\', '/'), bytes: stat.size, sha256: sha(full), mode: p.executableFiles?.includes(rel) ? 0o755 : 0o644,
        role: rel.startsWith('client/') ? 'client' : ['t3', 'server.asar'].includes(rel) ? 'server' : ['installer.exe', 'app.asar'].includes(rel) ? 'desktop' : 'support' };
    });
    delete metadata.executableFiles;
    return { ...metadata, version: spec.version, commit: spec.commit, files };
  });
  const result = validateManifest({ ...spec, payloads }); save(output, result);
  return { manifest: output, sha256: digest(JSON.stringify(result)), files: payloads.reduce((n, p) => n + p.files.length, 0) };
}
export async function main(argv) {
  if (argv[0] === '--host-run') {
    if (process.env.T3W_GUARD_GATE === '1') {
      const gate = fs.readFileSync(0, 'utf8');
      check(gate === 'go\n', 'lock', 'Host lock was not acquired');
    } else { check(process.platform !== 'win32' && /^\d+$/.test(process.env.T3W_GUARD_FD ?? '') && fs.fstatSync(Number(process.env.T3W_GUARD_FD)).isFile(), 'lock', 'Internal runner must be invoked through the OS-lock helper'); }
    return hostRun(read(argv[1]), path.resolve(argv[1]));
  }
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { config: { type: 'string' }, manifest: { type: 'string' }, target: { type: 'string', multiple: true }, spec: { type: 'string' }, out: { type: 'string' }, recovery: { type: 'string' }, 'manifest-sha': { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  const [command] = positionals;
  if (!command || command === 'help') return { usage: 't3w deploy manifest --spec SPEC --out MANIFEST | plan|stage|apply|resume|status|cancel --config HOSTS --manifest MANIFEST --target HOST [--target HOST] [--dry-run for cancel]', note: 'cancel preserves staged payload and original receipt; apply/resume starts a bounded independent host runner. No implicit all-host deployment.' };
  check(positionals.length === 1, 'usage', 'Unexpected positional arguments');
  if (command === 'manifest') { check(values.spec && values.out, 'usage', 'manifest needs --spec and --out'); return makeManifest(path.resolve(values.spec), path.resolve(values.out)); }
  check(['plan', 'stage', 'apply', 'resume', 'status', 'cancel', 'reconcile', 'measure-backup', 'adopt-backup'].includes(command) && values.config && values.manifest && values.target?.length, 'usage', 'Choose plan/stage/apply/resume/status/cancel and explicit config, manifest and targets');
  check(!values['dry-run'] || ['cancel', 'reconcile', 'measure-backup', 'adopt-backup'].includes(command), 'usage', '--dry-run is supported for cancel only');
  const config = read(path.resolve(values.config)), manifestPath = path.resolve(values.manifest), m = validateManifest(read(manifestPath)), hash = digest(JSON.stringify(m));
  check(!values['manifest-sha'] || values['manifest-sha'] === hash, 'manifest', 'Remote release manifest differs from the coordinator');
  check(new Set(values.target).size === values.target.length, 'usage', 'Duplicate target');
  check(!m.measurementOnly || ['measure-backup', 'status'].includes(command), 'recovery', 'Measurement plans cannot activate');
  const results = [];
  for (const name of values.target) {
    const t = config.targets?.[name]; check(t, 'config', 'Unknown target: ' + name);
    try {
      if (t.remote) {
        check(!['reconcile', 'measure-backup', 'adopt-backup'].includes(command), 'recovery', 'Run recovery explicitly on the target with its local decision');
        let value;
        try { value = JSON.parse(run('ssh', remoteArgs(t.remote, command, hash, values['dry-run']), { timeout: ['stage', 'apply', 'resume', 'cancel'].includes(command) ? 900000 : 60000, acceptedExitCodes: [2] })); }
        catch { value = { phase: 'pending', code: 'remote-unavailable', message: 'SSH target unavailable or command did not complete; inspect remote status before retry' }; }
        results.push({ target: name, result: value }); continue;
      }
      validateTarget(t);
      const locations = hostPaths(t, m);
      const state = readDeployment(locations);
      check(!state.manifestHash || state.manifestHash === hash, 'conflict', 'Deployment manifest changed since prior receipt');
      check(!state.targetHash || state.targetHash === digest(JSON.stringify(t)), 'conflict', 'Target configuration changed since prior receipt');
      if (command === 'status') { const { before, ...summary } = state; results.push({ target: name, result: summary }); continue; }
      check(state.phase !== 'superseded', 'recovery', 'Failed release superseded; use its pinned successor');
      if (state.phase === 'cancelled') {
        check(command === 'cancel', 'cancelled', 'This release was cancelled before activation; use a new deployment id');
        results.push({ target: name, result: state }); continue;
      }
      if (['measure-backup', 'adopt-backup'].includes(command)) {
        check(values.recovery && !values['dry-run'], 'recovery', 'Explicit local recovery input required');
        const requestPath = path.join(locations.deployment, 'request-' + crypto.randomUUID() + '.json');
        save(requestPath, { node: process.execPath, entry, manifest: m, manifestPath, target: t, command, recovery: read(path.resolve(values.recovery)) });
        const launched = JSON.parse(run(t.python, [path.join(here, 'host.py'), 'launch', requestPath]));
        results.push({ target: name, result: { ...launched, runnerReceipt: requestPath + '.runner.json', receipt: locations.receipt } }); continue;
      }
      if (command === 'reconcile') {
        check(!t.remote && values.recovery && state.phase === 'not-started', 'recovery', 'Reconcile locally with an exact decision before staging a distinct successor');
        const decision = read(path.resolve(values.recovery));
        const adapter = makeNative(t, m, manifestPath);
        const reviewed = await adapter.reconcilePreflight(decision);
        if (values['dry-run']) { results.push({ target: name, result: { phase: 'reconcile-ready', ...reviewed.summary } }); continue; }
        const requestPath = path.join(locations.deployment, 'request-' + crypto.randomUUID() + '.json');
        save(requestPath, { node: process.execPath, entry, manifest: m, manifestPath, target: t, command, recovery: decision });
        const result = JSON.parse(run(t.python, [path.join(here, 'host.py'), 'guard', requestPath], { timeout: 900000, acceptedExitCodes: [1, 2, 3, 4] }));
        results.push({ target: name, result }); continue;
      }
      checkClaim(locations, hash);
      const adapter = makeNative(t, m, manifestPath);
      if (command === 'cancel') {
        const requestPath = path.join(locations.deployment, 'request-' + crypto.randomUUID() + '.json');
        const request = { node: process.execPath, entry, manifest: m, manifestPath, target: t, command };
        const result = await adapter.cancelPreflight(state, Buffer.byteLength(JSON.stringify(request)) + 256);
        if (values['dry-run']) { results.push({ target: name, result: { phase: 'cancel-ready', locked: false, originalReceiptSha256: result.terminal.originalReceiptSha256, observed: result.terminal.observed, disk: result.disk } }); continue; }
        save(requestPath, request);
        const cancelled = JSON.parse(run(t.python, [path.join(here, 'host.py'), 'guard', requestPath], { timeout: 900000, acceptedExitCodes: [1, 2, 3, 4] }));
        results.push({ target: name, result: cancelled }); continue;
      }
      if (command === 'plan') {
        check(!state.manifestHash || state.manifestHash === hash, 'conflict', 'Manifest changed since prior receipt');
        const result = await preflight(m, t, adapter, { staged: state.phase === 'staged', after: state.phase === 'accepted' });
        results.push({ target: name, result: { phase: 'ready', environmentId: t.environmentId, version: result.live.version, disk: result.disk } }); continue;
      }
      if (state.phase === 'accepted') { results.push({ target: name, result: { phase: 'accepted', id: m.id } }); continue; }
      // Stage runs synchronously under the same OS lock as activation. Applying
      // always stages first, so detached-runner failures leave a valid old host.
      if (!['handoff', 'verifying', 'recovery-required'].includes(state.phase)) {
        // Capacity and writable staging are validated before even creating receipts.
        await preflight(m, t, adapter, { staged: state.phase === 'staged' });
      }
      const req = { node: process.execPath, entry, manifest: m, manifestPath, target: t, command: 'stage' };
      fs.mkdirSync(locations.deployment, { recursive: true, mode: 0o700 });
      const requestPath = path.join(locations.deployment, 'request-' + crypto.randomUUID() + '.json');
      if (command === 'stage' || !['handoff', 'verifying', 'recovery-required'].includes(state.phase)) {
        save(requestPath, req);
        const staged = JSON.parse(run(t.python, [path.join(here, 'host.py'), 'guard', requestPath], { timeout: 900000, acceptedExitCodes: [2, 3, 4] }));
        if (command === 'stage' || staged.phase !== 'staged') { const { before, ...summary } = staged; results.push({ target: name, result: summary }); continue; }
      }
      // Each launch gets immutable request bytes; simultaneous attempts cannot
      // overwrite arguments underneath the running lock owner.
      const activationPath = path.join(locations.deployment, 'request-' + crypto.randomUUID() + '.json');
      save(activationPath, { ...req, command });
      const launched = JSON.parse(run(t.python, [path.join(here, 'host.py'), 'launch', activationPath]));
      results.push({ target: name, result: { ...launched, receipt: locations.receipt, runnerReceipt: activationPath + '.runner.json' } });
    } catch (error) { results.push({ target: name, result: { phase: error.code === 'offline' ? 'pending' : 'blocked', code: error.code ?? 'io', message: error instanceof DeployError ? error.message : 'Host inspection failed; check explicit configuration and schema' } }); }
  }
  const result = { release: m.id, manifestSha256: hash, command, targets: results };
  if (values.out) save(path.resolve(values.out), result);
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === entry) {
  try {
    const result = await main(process.argv.slice(2)); console.log(JSON.stringify(result));
    const failed = value => value.targets ? value.targets.some(item => failed(item.result)) : ['blocked', 'pending', 'busy', 'failed', 'preflight-failed', 'recovery-required'].includes(value.phase);
    if (failed(result)) process.exitCode = 2;
  }
  catch (error) { console.log(JSON.stringify({ phase: 'blocked', code: error.code ?? 'io', message: error instanceof DeployError ? error.message : 'Deployment command failed; inspect configuration and retained status' })); process.exitCode = 1; }
}
