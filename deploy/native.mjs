import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, checkDatabase, DeployError, read, save, sha, digest, fileAt, verifyFiles, inventory, budget, preflight, preservation } from './core.mjs';
import { inspectServiceDropIns } from './service-config.mjs';
import { assertUnactivated, readDeployment } from './cancel.mjs';
import { inspectRecovery, reviewRecovery, assertMeasurementPlan, assertAdoption, reconcilablePhases } from './recovery.mjs';
import { FORWARD_POLICY } from './forward-review.mjs';
import { WINDOWS_PROFILE_POLICY } from './windows-profile-review.mjs';
import { readWindowsCatalogProof } from './windows-catalog-review.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export function validRunningMainPid(value) {
  const pid = value.trim();
  return /^[1-9][0-9]*$/.test(pid) && Number.isSafeInteger(Number(pid));
}
export function remainingRunnerMs() {
  const value = process.env.T3W_RUNNER_DEADLINE_MS;
  if (value === undefined) return Infinity;
  check(/^\d+$/.test(value) && Number.isSafeInteger(Number(value)), 'deadline', 'Invalid runner deadline');
  return Number(value) - Date.now() - 15000;
}
// This is the same final independent read for fresh copies and retained-copy
// resume. The detached guard is the hard backstop for a blocked filesystem read.
export function verifyBackupChecksum(file, proof, checksumSeconds = 30) {
  check(Number.isInteger(checksumSeconds) && checksumSeconds >= 30 && checksumSeconds <= 120, 'backup', 'Invalid final checksum budget');
  check(remainingRunnerMs() >= checksumSeconds * 1000, 'deadline', 'Insufficient runner lifetime for final backup checksum');
  check(proof.integrity === 'ok' && proof.automaticRestore === false && proof.bytes === fs.statSync(file).size && proof.database?.logicalBytes === proof.bytes, 'backup', 'Consistent pre-migration backup metadata did not verify');
  const started = Date.now();
  const checksum = sha(file, started + checksumSeconds * 1000);
  check(proof.sha256 === checksum, 'backup', 'Consistent pre-migration backup did not verify');
  return { phase: 'complete', budgetSeconds: checksumSeconds, elapsedSeconds: (Date.now() - started) / 1000, bytes: proof.bytes, sha256: checksum };
}
export function readActivityReconciliation(python, deployment, checksumSeconds = 30, runCommand = run) {
  check(Number.isInteger(checksumSeconds) && checksumSeconds >= 30 && checksumSeconds <= 120, 'backup', 'Invalid activity checksum budget');
  // Reuse the reviewed full-backup checksum allowance, plus the ordinary 30s
  // helper allowance for SQLite reconstruction and startup. Never silently
  // clamp that checksum inside a shorter child or remaining runner lifetime.
  const timeout = (checksumSeconds + 30) * 1000;
  check(remainingRunnerMs() >= timeout, 'deadline', 'Insufficient runner lifetime for activity evidence');
  return JSON.parse(runCommand(python, [path.join(here, 'host.py'), 'activity-reconciliation', JSON.stringify({ deployment, checksumSeconds })], { timeout }));
}
// Exact primary-reviewed current-state decisions. These are not a claim of
// historical equality, nor permission to accept other files or later catalogs.
export function readCatalogReconciliation(deployment, manifestHash, targetHash, before, after) {
  const input = name => {
    const file = path.join(deployment, name);
    check(fs.realpathSync(file) === path.resolve(file) && !fs.lstatSync(file).isSymbolicLink(), 'catalog-acceptance', 'Noncanonical catalog evidence');
    return file;
  };
  check(remainingRunnerMs() >= 10000, 'deadline', 'Insufficient runner lifetime for catalog evidence');
  const decisionFile = input('catalog-current-state-acceptance.json'), functionalFile = input('catalog-current-functional-proof.json');
  const reviewedPairs = [
    ['96c77b9ffba0ff914cd97c7d5360f11f073ca30fa582565a6173d9353d4edd4c', '6873066fa623a52b8e22864224c408221727073d907b778a20aff8fb224bbcf8'],
    ['69cf916624707a94ef063289e9c62757cf40353460428563b92e4125a3249f24', 'a99a5ffd24727257a4ced903611b82f0be4990ade4f58e8ad9e31512fc41e01b'],
    ['e5b3e8bd11512a1297653f85bc63b0f00e7b24bb8ee278d4ea2f3ae46741797b', 'c3ca3d967e57ff2c1b7347f8a0994013ccd19d083bfb9a004f5e0a72520bf86e'],
  ];
  check(reviewedPairs.some(([decisionSha, functionalSha]) => sha(decisionFile) === decisionSha && sha(functionalFile) === functionalSha), 'catalog-acceptance', 'Catalog decision or functional evidence differs from primary review');
  const decision = read(decisionFile), functional = read(functionalFile), receipt = read(input('receipt.json'));
  const originalFile = input('catalog-original-recovery-receipt.json'), closedFile = input('closed-snapshot.json');
  check(sha(originalFile) === decision.originalRecoveryReceiptSha256 && sha(closedFile) === decision.closedSnapshotSha256, 'catalog-acceptance', 'Original catalog boundary evidence changed');
  const original = read(originalFile), closed = read(closedFile), journal = read(input('desktop-activation.json'));
  check(decision.decision === 'accept-current-intended-catalog' && decision.deploymentId === path.basename(deployment) && receipt.id === decision.deploymentId && original.id === receipt.id && ['verifying', 'recovery-required', 'accepted'].includes(receipt.phase) && original.phase === 'recovery-required', 'catalog-acceptance', 'Catalog decision deployment differs');
  check(manifestHash === decision.manifestDigest && targetHash === decision.targetDigest && receipt.manifestHash === manifestHash && receipt.targetHash === targetHash && original.manifestHash === manifestHash && original.targetHash === targetHash, 'catalog-acceptance', 'Catalog decision manifest or target differs');
  check(JSON.stringify(before) === JSON.stringify(original.before) && JSON.stringify(receipt.before) === JSON.stringify(original.before) && journal.phase === 'started' && journal.closedSnapshotSha256 === decision.closedSnapshotSha256, 'catalog-acceptance', 'Original snapshot or started activation differs');
  const id = 'file:connection-catalog.json';
  check(new Map(before.routes).get(id) === decision.originalCatalogCiphertextSha256 && new Map(closed.routes).get(id) === decision.originalCatalogCiphertextSha256 && new Map(after.routes).get(id) === decision.currentCatalogCiphertextSha256, 'catalog-acceptance', 'Catalog transition differs from primary review');
  // Exact current ciphertext binds the current catalog to the pinned decrypted
  // semantic/function proof. A refresh or semantic change needs fresh review.
  const catalog = path.resolve(deployment, '../../..', 'userdata/connection-catalog.json');
  check(fs.realpathSync(catalog) === catalog && !fs.lstatSync(catalog).isSymbolicLink() && sha(catalog) === decision.currentCatalogCiphertextSha256, 'catalog-acceptance', 'Current catalog changed after snapshot');
  check(functional.ciphertextSha256 === decision.currentCatalogCiphertextSha256 && functional.semanticSha256 === decision.currentSemanticSha256 && functional.durableFieldsSha256 === decision.currentDurableFieldsSha256, 'catalog-acceptance', 'Catalog semantic evidence differs');
  const historicalEquality = decision.historicalEquality ?? 'unproven';
  check(historicalEquality === 'unproven' || historicalEquality === false, 'catalog-acceptance', 'Cannot claim historical equality');
  return { kind: 'reviewed-current-catalog', historicalEquality, decisionSha256: sha(decisionFile), functionalProofSha256: sha(functionalFile), originalReceiptSha256: decision.originalRecoveryReceiptSha256, closedSnapshotSha256: decision.closedSnapshotSha256, currentSemanticSha256: decision.currentSemanticSha256,
    entries: [{ id, fromSha256: decision.originalCatalogCiphertextSha256, toSha256: decision.currentCatalogCiphertextSha256, acceptance: 'reviewed-current-catalog', historicalEquality }] };
}
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('T3') && !key.startsWith('VITE_') && key !== 'ELECTRON_RUN_AS_NODE'));
// Match the reviewed archive installer's protocol-3 unit. Refuse custom units:
// `service install` renders this file again and must not erase host settings.
export function standardServiceUnit(base, version) {
  const escape = value => value.replaceAll('%', '%%');
  const quote = value => { const escaped = escape(value); return /[\s"'\\]/.test(escaped) ? `"${escaped.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : escaped; };
  const log = escape(path.join(base, 'userdata/logs/boot-service.log'));
  return ['[Unit]', 'Description=T3 Code server', 'StartLimitIntervalSec=300', 'StartLimitBurst=5', '',
    '[Service]', 'Type=simple', 'WorkingDirectory=%h', `Environment=T3CODE_HOME=${quote(base)}`,
    'Environment=T3_BOOT_SERVICE_UNIT=t3code.service', `ExecStart=${quote(path.join(base, 'runtime/versions', version, 't3'))} __service-launcher`,
    'KillMode=mixed', 'OOMPolicy=continue', 'Restart=always', 'RestartSec=5', 'CPUWeight=1000', 'IOWeight=1000',
    'ManagedOOMPreference=avoid', `StandardOutput=append:${log}`, `StandardError=append:${log}`, '', '[Install]', 'WantedBy=default.target', ''].join('\n');
}
export function run(executable, args, options = {}) {
  const { acceptedExitCodes = [], ...execution } = options;
  check(remainingRunnerMs() > 0, 'deadline', 'Runner lifetime exhausted; retain the current phase for recovery');
  execution.timeout = Math.min(execution.timeout ?? 30000, remainingRunnerMs());
  try { return execFileSync(executable, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: cleanEnv(), ...execution }); }
  catch (error) { if (acceptedExitCodes.includes(error.status) && typeof error.stdout === 'string') return error.stdout; throw new DeployError('command', 'A fixed host command failed; check executable, access and host support'); }
}
export function validateTarget(t, { platform = process.platform, arch = process.arch } = {}) {
  check(['boot-service', 'desktop-files'].includes(t.kind) && t.platform === `${platform}-${arch}`, 'unsupported', 'Run the host adapter on its matching platform');
  for (const key of ['baseDir', 'python']) check(typeof t[key] === 'string' && path.isAbsolute(t[key]) && fs.existsSync(t[key]), 'config', `Existing absolute ${key} is required`);
  check(fs.realpathSync(t.baseDir) === path.resolve(t.baseDir), 'config', 'Use the canonical T3 base path, without junction aliases');
  for (const rel of ['runtime', 'runtime/versions', 'runtime/t3w-deploy', 'userdata']) if (fs.existsSync(path.join(t.baseDir, rel))) check(fs.realpathSync(path.join(t.baseDir, rel)) === path.resolve(t.baseDir, rel), 'config', 'Deployment and userdata paths must not redirect to another filesystem');
  const url = new URL(t.origin);
  check(['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && url.protocol === 'http:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'config', 'Host runners use a loopback HTTP origin; remote access uses pinned SSH');
  check(t.environmentId && t.expectedVersion && /^[a-f0-9]{64}$/.test(t.expectedServerSha256) && /^[a-f0-9]{64}$/.test(t.expectedClientSha256), 'config', 'Pin expected environment, old version, server and client hashes');
  check(Array.isArray(t.disks) && t.disks.length > 0, 'config', 'Configure disk reserves and concurrent growth per storage root');
  for (const disk of t.disks) check(path.isAbsolute(disk.root) && ['kingston', 'wd', 'other'].includes(disk.class), 'config', 'Each disk needs an absolute root and class');
  if (t.kind === 'boot-service') check(t.service === 't3code.service', 'unsupported', 'This installer supports the standard t3code.service user unit only');
  else {
    for (const key of ['desktopExecutable', 'serverFile']) check(path.isAbsolute(t[key] ?? ''), 'config', `Absolute ${key} is required for desktop deployment`);
    if (t.kind === 'desktop-files') check(t.expectedFiles && typeof t.expectedFiles === 'object', 'config', 'Pin the old desktop resource file hashes');
    check(fs.realpathSync(path.dirname(t.serverFile)) === path.resolve(path.dirname(t.serverFile)), 'config', 'Desktop resources must not redirect across filesystems');
  }
  check(t.verifySeconds === undefined || (Number.isInteger(t.verifySeconds) && t.verifySeconds >= 1 && t.verifySeconds <= 180), 'config', 'Verification deadline must be 1..180 seconds');
}
export function hostPaths(t, m) {
  const root = path.join(t.baseDir, 'runtime', 't3w-deploy');
  const deployment = path.join(root, m.id);
  return { root, deployment, receipt: path.join(deployment, 'receipt.json'), claim: path.join(root, 'claim.json'), stage: path.join(deployment, 'payload'), runtime: path.join(t.baseDir, 'runtime', 'versions', m.version) };
}

const nativeRun = run;
export function makeNative(t, m, manifestPath, dependencies = {}) {
  const run = dependencies.run ?? nativeRun;
  const replace = dependencies.replace ?? fs.renameSync;
  const platform = dependencies.platform ?? process.platform, arch = dependencies.arch ?? process.arch;
  validateTarget(t, { platform, arch });
  const locations = hostPaths(t, m), sourceRoot = path.dirname(manifestPath);
  const currentServer = () => t.kind === 'boot-service' ? path.join(t.baseDir, 'runtime', 'versions', read(path.join(t.baseDir, 'runtime/service-state.json')).activeVersion, 't3') : t.serverFile;
  const backupSeconds = m.compatibility.database.backup?.seconds ?? (m.measurementOnly ? m.measurementBudget?.seconds : 270);
  const checksumSeconds = m.compatibility.database.backup?.checksumSeconds ?? (m.measurementOnly ? m.measurementBudget?.checksumSeconds : 30);
  function requireBackupLifetime(beforeStop = false) {
    if (m.compatibility.migrations !== 'forward-only') return;
    // Leave the install/start timeout, native recovery verification and receipt
    // margin intact; do not spend those on a long copy or checksum.
    const required = backupSeconds + checksumSeconds + 150 + (t.verifySeconds ?? 120) + 30 + (beforeStop ? 150 : 0);
    check(remainingRunnerMs() >= required * 1000, 'deadline', 'Insufficient runner lifetime for backup, checksum and acceptance; resume the retained phase with a fresh runner');
  }
  const python = (operation, arg) => JSON.parse(run(t.python, [path.join(here, 'host.py'), operation, arg], { timeout: operation === 'backup' ? backupSeconds * 1000 : 30000 }));
  const snapshot = () => python('snapshot', path.join(t.baseDir, 'userdata/state.sqlite'));
  async function get(route, json = true) {
    let response;
    // Synchronous snapshots/hashes can outlast server keep-alive while blocking
    // socket-close callbacks. Each sparse host probe needs a fresh connection.
    try { response = await fetch(t.origin.replace(/\/$/, '') + route, { signal: AbortSignal.timeout(5000), redirect: 'error', cache: 'no-store', headers: { connection: 'close' } }); }
    catch { throw new DeployError('offline', 'Host is unreachable; keep this target pending'); }
    check(response.ok, 'http', 'Host endpoint did not return success');
    return json ? response.json() : Buffer.from(await response.arrayBuffer());
  }
  function serviceConfiguration() {
    const homeDir = dependencies.homeDir ?? os.homedir();
    const file = path.join(homeDir, '.config/systemd/user/t3code.service');
    const actual = run('systemctl', ['--user', 'show', t.service, '-p', 'FragmentPath', '--value']).trim();
    check(actual === file && fs.realpathSync(file) === path.resolve(file), 'unsupported', 'Service unit must be the standard canonical user unit');
    const dropInPaths = run('systemctl', ['--user', 'show', t.service, '-p', 'DropInPaths', '--value']);
    const version = read(path.join(t.baseDir, 'runtime/service-state.json')).activeVersion;
    check(fs.readFileSync(file, 'utf8') === standardServiceUnit(t.baseDir, version), 'unsupported', 'Customized service unit would be overwritten by the supported installer');
    const configuration = inspectServiceDropIns(t, file, homeDir, version, dropInPaths, run);
    fs.accessSync(path.dirname(file), fs.constants.W_OK);
    return { path: file, contents: fs.readFileSync(file, 'utf8'), sha256: sha(file), ...configuration };
  }
  const serviceUnit = () => serviceConfiguration().path;
  const storagePaths = () => [t.baseDir, t.kind !== 'boot-service' ? path.dirname(t.desktopExecutable) : path.dirname(serviceUnit())];
  const desktopRequest = path.join(locations.deployment, 'desktop-request.json');
  const desktopJournal = path.join(locations.deployment, 'desktop-activation.json');
  const closedSnapshot = path.join(locations.deployment, 'closed-snapshot.json');
  const databaseBackup = path.join(locations.deployment, 'before-migrations.sqlite');
  const resourceRoot = t.serverFile ? path.dirname(t.serverFile) : null;
  const desktopFiles = payload => payload.files.filter(f => !f.path.startsWith('client/'));
  function checkBackupRehearsal() {
    const b = m.compatibility.database.backup;
    if (!b) return;
    const proofFile = fileAt(sourceRoot, b.rehearsal.source);
    check(b.environmentId === t.environmentId, 'backup', 'Backup timing budget belongs to another environment');
    check(sha(proofFile) === b.rehearsal.sha256, 'backup', 'Backup timing rehearsal changed');
    const proof = read(proofFile);
    check(proof.phase === 'complete' && proof.freshBackup === true && proof.budgetSeconds === b.seconds && Number.isFinite(proof.elapsedSeconds) && proof.elapsedSeconds > 0 && proof.elapsedSeconds <= b.seconds * 0.75 && proof.backup?.integrity === 'ok' && proof.backup.automaticRestore === false && /^[a-f0-9]{64}$/.test(proof.backup.sha256) && proof.backup.bytes === proof.backup.database?.logicalBytes && proof.backup.bytes >= b.maxSourceBytes, 'backup', 'Backup rehearsal must prove a fresh complete copy at the supported size with 25% time headroom');
    checkDatabase(m, proof.backup.database);
    if (b.checksumSeconds !== undefined) {
      const file = fileAt(sourceRoot, b.checksumRehearsal.source);
      check(sha(file) === b.checksumRehearsal.sha256, 'backup', 'Final checksum rehearsal changed');
      const measured = read(file);
      check(measured.phase === 'complete' && measured.sourceUnchanged === true && measured.budgetSeconds === checksumSeconds && Number.isFinite(measured.elapsedSeconds) && measured.elapsedSeconds > 0 && measured.elapsedSeconds <= checksumSeconds * 0.75 && measured.sha256 === proof.backup.sha256 && measured.bytes === proof.backup.bytes, 'backup', 'Final checksum rehearsal must match the complete backup with 25% time headroom');
    }
  }
  async function prepareDatabase(payload) {
    checkBackupRehearsal();
    const current = snapshot(); checkDatabase(m, current.database);
    // The last running-host plan precedes shutdown writes. Reuse this closed,
    // consistent measurement for the ceiling, peak budget and backup request.
    if (m.compatibility.migrations === 'forward-only') check(current.database.logicalBytes <= m.compatibility.database.maxSourceBytes, 'migration', 'Closed database exceeds the rehearsed source-size ceiling; retain the closed install for review');
    if (m.compatibility.database.backup) check(current.database.logicalBytes <= m.compatibility.database.backup.maxSourceBytes, 'backup', 'Closed database exceeds the measured backup timing ceiling; retain the closed install');
    await adapter.capacity(payload, true, true, true, current);
    if (fs.existsSync(closedSnapshot)) {
      const retained = read(closedSnapshot), comparable = { ...current };
      // Retain legacy evidence verbatim; never upgrade its boundary on resume.
      if (!('activityBoundary' in retained)) delete comparable.activityBoundary;
      check(digest(JSON.stringify(retained)) === digest(JSON.stringify(comparable)), 'recovery', 'Closed database metadata changed externally; retain both states for review');
    }
    else save(closedSnapshot, current);
    if ('activityBoundary' in read(closedSnapshot)) {
      const journal = t.kind === 'desktop-files' ? desktopJournal : path.join(locations.deployment, 'service-activation.json');
      const activation = read(journal), closedSnapshotSha256 = sha(closedSnapshot);
      check(!activation.closedSnapshotSha256 || activation.closedSnapshotSha256 === closedSnapshotSha256, 'recovery', 'Closed snapshot seal changed');
      save(journal, { ...activation, closedSnapshotSha256 });
    }
    if (m.compatibility.migrations !== 'forward-only') return;
    const request = path.join(locations.deployment, 'backup-request.json');
    requireBackupLifetime();
    save(request, { source: path.join(t.baseDir, 'userdata/state.sqlite'), destination: databaseBackup, migrationIds: m.compatibility.database.fromMigrations, schemaSha256: m.compatibility.database.fromSchemaSha256, maxSourceBytes: Math.min(m.compatibility.database.maxSourceBytes, m.compatibility.database.backup?.maxSourceBytes ?? Infinity), expectedLogicalBytes: current.database.logicalBytes, budgetSeconds: backupSeconds });
    const proof = python('backup', request);
    verifyBackupChecksum(databaseBackup, proof, checksumSeconds);
  }
  function desktopPort() { return JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(here, 'windows-port.ps1'), '-Request', desktopRequest])).listening; }
  function finishDesktop(payload) {
    if (!fs.existsSync(desktopJournal)) return;
    const journal = read(desktopJournal);
    if (!['closed', 'replacing', 'installed'].includes(journal.phase)) return;
    if (desktopPort()) { check(journal.phase === 'installed', 'recovery', 'Port reclaimed during a partial installation; leave files for manual review'); return; }
    for (const f of desktopFiles(payload)) {
      const destination = fileAt(resourceRoot, f.path), next = fileAt(resourceRoot, f.path + '.t3w-' + m.id + '.next');
      if (sha(destination) === f.sha256) continue;
      check(sha(destination) === t.expectedFiles[f.path] && fs.existsSync(next) && sha(next) === f.sha256, 'recovery', 'Partially installed resource differs from both approved old/new payloads');
      save(desktopJournal, { ...journal, phase: 'replacing' });
      replace(next, destination);
    }
    for (const f of desktopFiles(payload)) check(sha(fileAt(resourceRoot, f.path)) === f.sha256, 'checksum', 'Installed desktop resources differ');
    save(desktopJournal, { ...journal, phase: 'installed' });
    const started = python('start-desktop', desktopRequest);
    check(started.started === true, 'recovery', 'Desktop did not launch');
    save(desktopJournal, { ...journal, phase: 'started', pid: started.pid });
  }
  function windowsInfo(verifyOwner = true) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3w-inspect-'));
    const request = path.join(dir, 'request.json');
    try {
      save(request, { port: Number(new URL(t.origin).port || 80), executable: t.desktopExecutable, paths: storagePaths(), verifyOwner });
      return JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(here, 'windows-inspect.ps1'), '-Request', request]));
    } finally { fs.rmSync(request, { force: true }); fs.rmdirSync(dir); }
  }
  function linuxOwner() {
    const main = Number(run('systemctl', ['--user', 'show', t.service, '-p', 'MainPID', '--value']).trim());
    check(main > 0, 'install', 'Actual boot service is not running');
    const port = Number(new URL(t.origin).port || 80);
    const lines = run('ss', ['-H', '-ltnp', `sport = :${port}`]);
    const ids = [...new Set([...lines.matchAll(/pid=(\d+)/g)].map(match => Number(match[1])))];
    check(ids.length === 1, 'install', 'Listener owner is not unique or is not visible');
    check(fs.realpathSync(`/proc/${ids[0]}/exe`) === fs.realpathSync(currentServer()), 'install', 'Listener executable differs from installed runtime');
    let pid = ids[0], owned = false;
    for (let n = 0; n < 8 && pid > 1; n++) {
      if (pid === main) { owned = true; break; }
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    }
    check(owned, 'install', 'Listener is not owned by the configured service'); return true;
  }
  function measuredDisks() {
    const disks = t.kind !== 'boot-service' ? windowsInfo(false).disks : storagePaths().map(p => {
      const s = fs.statfsSync(p), mount = JSON.parse(run('findmnt', ['--json', '--target', p, '--output', 'SOURCE,FSTYPE'])).filesystems[0];
      const block = JSON.parse(run('lsblk', ['--json', '--paths', '--output', 'NAME,MODEL,TRAN,PKNAME']));
      const flat = []; const walk = xs => { for (const d of xs) { flat.push(d); if (d.children) walk(d.children); } }; walk(block.blockdevices);
      let device = flat.find(d => d.name === mount.source), model = device?.model ?? '', transport = device?.tran;
      if (device?.pkname) { device = flat.find(d => d.name === device.pkname); model += ' ' + (device?.model ?? ''); transport ||= device?.tran; }
      check(device && ['ext4', 'xfs', 'btrfs'].includes(mount.fstype), 'disk', 'Only identified fixed local Linux filesystems are supported');
      return { path: p, device: String(fs.statSync(p).dev), freeBytes: s.bavail * s.bsize, blockBytes: s.bsize, type: transport === 'usb' ? 'usb' : mount.fstype, model };
    });
    return disks.map(d => {
      const policy = t.disks.filter(x => { const r = path.relative(path.resolve(x.root), path.resolve(d.path)); return !r.startsWith('..') && !path.isAbsolute(r); }).sort((a, b) => b.root.length - a.root.length)[0];
      check(policy, 'disk', 'No reserve policy covers a deployment filesystem');
      // Generic reserves are explicit host policy, independent of hardware brand.
      const detected = policy.class === 'other' ? 'other' : /kingston/i.test(d.model) ? 'kingston' : /western|\bwd/i.test(d.model) ? 'wd' : policy.class;
      check(detected === policy.class, 'disk', 'Backing disk model contradicts reserve policy');
      return { ...d, class: detected, reserveBytes: policy.reserveBytes, growthBytes: policy.growthBytes };
    });
  }
  function reuseTreeIfPresent(from, to, currentRoot = undefined) {
    if (!fs.existsSync(from)) return;
    check(fs.realpathSync(from) === path.resolve(from) && fs.statSync(from).dev === fs.statSync(locations.root).dev, 'recovery', 'Retained copies must share the canonical deployment filesystem');
    fs.mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const rel of inventory(from)) {
      const source = fileAt(from, rel), destination = fileAt(to, rel);
      if (currentRoot) { const current = fileAt(currentRoot, rel); if (!fs.existsSync(current) || sha(current) !== sha(source)) continue; }
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      if (fs.existsSync(destination)) check(sha(source) === sha(destination), 'recovery', 'Retained copy differs');
      else fs.linkSync(source, destination);
    }
  }
  function assertClosed(portRequest = desktopRequest) {
    if (t.kind === 'desktop-files') {
      check(!JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(here, 'windows-port.ps1'), '-Request', portRequest])).listening, 'recovery', 'Desktop listener was reclaimed');
      for (const [rel, expected] of Object.entries(t.expectedFiles)) check(sha(fileAt(resourceRoot, rel)) === expected, 'recovery', 'Old native resource changed');
    } else {
      check(run('systemctl', ['--user', 'show', t.service, '-p', 'MainPID', '--value']).trim() === '0', 'recovery', 'Service was reopened');
      check(!run('ss', ['-H', '-ltnp', `sport = :${Number(new URL(t.origin).port || 80)}`]).trim(), 'recovery', 'Service port was reclaimed');
      serviceConfiguration();
    }
    check(sha(currentServer()) === t.expectedServerSha256, 'recovery', 'Original installation changed');
  }
  // True only while the original app/service is demonstrably still up. Used to retry a close that never confirmed.
  function originalStillRunning() {
    if (t.kind === 'desktop-files') { save(desktopRequest, { port: Number(new URL(t.origin).port || 80), executable: t.desktopExecutable }); return desktopPort(); }
    return validRunningMainPid(run('systemctl', ['--user', 'show', t.service, '-p', 'MainPID', '--value']));
  }
  async function closeForUpdate() {
    if (t.kind === 'desktop-files') {
      save(desktopRequest, { port: Number(new URL(t.origin).port || 80), executable: t.desktopExecutable });
      save(desktopJournal, { phase: 'prepared', release: m.id });
      const closed = JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(here, 'windows-close.ps1'), '-Request', desktopRequest], { timeout: 135000 }));
      check(closed.closed, 'recovery', 'Desktop closure was not verified');
      save(desktopJournal, { phase: 'closed', release: m.id, processes: closed });
    } else {
      const journal = path.join(locations.deployment, 'service-activation.json');
      save(path.join(locations.deployment, 'previous-service-unit.json'), serviceConfiguration());
      save(journal, { phase: 'stopping', service: t.service });
      run('systemctl', ['--user', 'stop', t.service], { timeout: 150000 });
      check(run('systemctl', ['--user', 'show', t.service, '-p', 'MainPID', '--value']).trim() === '0', 'recovery', 'Service did not stop');
      save(journal, { phase: 'closed', service: t.service });
    }
  }
  const adapter = {
    save(state) { save(locations.receipt, state); },
    async measureBackup(decision) {
      assertMeasurementPlan(m);
      const recordFile = path.join(locations.deployment, 'measurement.json');
      let record = fs.existsSync(recordFile) ? read(recordFile) : null;
      if (record) check(record.manifestHash === digest(JSON.stringify(m)) && record.targetHash === digest(JSON.stringify(t)), 'recovery', 'Measurement identity changed');
      if (!record) {
        let inspected, terminal;
        if (decision.kind === 'accepted-predecessor') {
          const claim = read(locations.claim), prior = path.join(locations.root, claim.id);
          const state = readDeployment({ ...locations, deployment: prior, receipt: path.join(prior, 'receipt.json') });
          check(state.phase === 'accepted' && state.id === decision.id && state.manifestHash === claim.manifestHash && sha(path.join(prior, 'receipt.json')) === decision.receiptSha256, 'recovery', 'Accepted predecessor differs');
          inspected = await preflight(m, t, adapter);
        } else {
          const reviewed = await adapter.reconcilePreflight(decision);
          check(!reviewed.summary.alreadyReconciled, 'recovery', 'Missing measurement record after reconciliation; inspect retained state');
          inspected = reviewed.inspected; terminal = reviewed.terminal;
        }
        record = { schema: 1, manifest: m, manifestHash: digest(JSON.stringify(m)), targetHash: digest(JSON.stringify(t)), before: inspected.live.snapshot, decision, phase: 'staging' };
        save(recordFile, record);
        if (terminal) save(path.join(locations.root, decision.id, 'superseded.json'), terminal);
        save(locations.claim, { id: m.id, manifestHash: record.manifestHash });
        save(locations.receipt, { phase: 'measuring', id: m.id, manifestHash: record.manifestHash, targetHash: record.targetHash, before: record.before });
      }
      let claim = read(locations.claim);
      if (claim.id !== m.id && record.phase === 'staging' && claim.id === decision.id) {
        const prior = path.join(locations.root, decision.id), state = readDeployment({ ...locations, deployment: prior, receipt: path.join(prior, 'receipt.json') });
        if (reconcilablePhases(decision.kind).includes(state.phase)) { const reviewed = await adapter.reconcilePreflight(decision); save(path.join(prior, 'superseded.json'), reviewed.terminal); }
        else check((decision.kind === 'accepted-predecessor' && state.phase === 'accepted' && sha(path.join(prior, 'receipt.json')) === decision.receiptSha256) || (state.phase === 'superseded' && state.supersession.successor.manifestHash === record.manifestHash), 'recovery', 'Incomplete measurement metadata differs from predecessor');
        save(locations.claim, { id: m.id, manifestHash: record.manifestHash }); claim = read(locations.claim);
      }
      check(claim.id === m.id && claim.manifestHash === record.manifestHash, 'recovery', 'Measurement no longer owns the claim');
      if (record.phase === 'measured') return { phase: 'measured', id: m.id, proof: path.join(locations.deployment, 'measurement-timing.json') };
      const payload = m.payloads.find(p => p.platform === t.platform);
      const journalFile = t.kind === 'desktop-files' ? desktopJournal : path.join(locations.deployment, 'service-activation.json');
      // A close that never confirmed (graceful exit timed out, or the runner died before the closed journal) while the
      // original app is still up closed nothing: restart from staging so the baseline is refreshed before closing again.
      if (record.phase === 'closing' && (!fs.existsSync(journalFile) || ['prepared', 'stopping'].includes(read(journalFile).phase)) && originalStillRunning()) { record.phase = 'staging'; save(recordFile, record); }
      if (record.phase === 'staging') {
        if (t.kind === 'desktop-files') reuseTreeIfPresent(path.join(locations.root, decision.id, 'previous-desktop'), path.join(locations.deployment, 'previous-desktop'), path.dirname(t.desktopExecutable));
        await adapter.stage(payload);
        const fresh = await preflight(m, t, adapter, { staged: true });
        record.before = fresh.live.snapshot; record.phase = 'closing'; save(recordFile, record);
        save(locations.receipt, { phase: 'measuring', id: m.id, manifestHash: record.manifestHash, targetHash: record.targetHash, before: record.before });
        await closeForUpdate();
      }
      // A crash before the closed journal remains explicit and cannot infer a
      // safe closure from an absent listener alone.
      check(fs.existsSync(journalFile) && read(journalFile).phase === 'closed', 'recovery', 'Measurement closure is uncertain; retain the exact journal');
      assertClosed();
      const closed = snapshot(); checkDatabase(m, closed.database);
      check(closed.database.logicalBytes <= m.compatibility.database.maxSourceBytes, 'migration', 'Closed source exceeds native migration rehearsal');
      await adapter.capacity(payload, true, true, true, closed);
      if (fs.existsSync(closedSnapshot)) check(digest(JSON.stringify(read(closedSnapshot))) === digest(JSON.stringify(closed)), 'recovery', 'Closed measurement baseline changed');
      else save(closedSnapshot, closed);
      save(journalFile, { ...read(journalFile), closedSnapshotSha256: sha(closedSnapshot) });
      record.closed = closed; record.phase = 'closed'; save(recordFile, record);
      requireBackupLifetime();
      const request = path.join(locations.deployment, 'measurement-backup-request.json');
      save(request, { source: path.join(t.baseDir, 'userdata/state.sqlite'), destination: databaseBackup, migrationIds: closed.database.migrationIds, schemaSha256: closed.database.schemaSha256, maxSourceBytes: closed.database.logicalBytes, expectedLogicalBytes: closed.database.logicalBytes, budgetSeconds: 900 });
      const retainedTiming = path.join(locations.deployment, 'measurement-timing.json');
      if (!fs.existsSync(retainedTiming) && fs.existsSync(databaseBackup + '.timing.json')) { const previous = read(databaseBackup + '.timing.json'); if (previous.phase === 'complete' && previous.freshBackup === true) save(retainedTiming, previous); }
      const proof = python('backup', request);
      const timing = read(databaseBackup + '.timing.json');
      // Resume may verify an already-complete copy. Preserve the first fresh
      // measurement separately before a later retained-copy timing can replace it.
      const timingFile = path.join(locations.deployment, 'measurement-timing.json');
      if (!fs.existsSync(timingFile)) { check(timing.freshBackup === true, 'recovery', 'Fresh timing evidence must be recovered, never fabricated'); save(timingFile, timing); }
      const measured = verifyBackupChecksum(databaseBackup, proof, 120);
      assertClosed(); check(digest(JSON.stringify(snapshot())) === digest(JSON.stringify(closed)), 'recovery', 'Source changed during measurement');
      save(path.join(locations.deployment, 'measurement-checksum.json'), { ...measured, sourceUnchanged: true });
      check(read(timingFile).elapsedSeconds <= 675 && measured.elapsedSeconds <= 90, 'backup', 'Measured copy/checksum lacks required 25 percent headroom');
      // Receipt first: a retry returns early once the record says measured, so the record must be the last write.
      save(locations.receipt, { phase: 'measured', id: m.id, manifestHash: record.manifestHash, targetHash: record.targetHash, before: record.before, closedSnapshotSha256: sha(closedSnapshot), timingSha256: sha(timingFile) });
      record.phase = 'measured'; save(recordFile, record);
      return { phase: 'measured', id: m.id, bytes: proof.bytes, timing: timingFile, checksum: path.join(locations.deployment, 'measurement-checksum.json'), activationPerformed: false };
    },
    async adoptBackup(decision) {
      if (fs.existsSync(locations.receipt)) { const existing = readDeployment(locations); check(existing.manifestHash === digest(JSON.stringify(m)) && existing.targetHash === digest(JSON.stringify(t)) && ['handoff', 'verifying', 'recovery-required', 'accepted'].includes(existing.phase), 'recovery', 'Existing adoption identity differs'); return { phase: existing.phase, id: m.id, nextOperation: 'resume' }; }
      check(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(decision.preparationId) && decision.preparationId !== m.id, 'recovery', 'Distinct measured preparation required');
      const prior = path.join(locations.root, decision.preparationId), previousReceipt = path.join(prior, 'receipt.json');
      check(sha(previousReceipt) === decision.receiptSha256, 'recovery', 'Measured receipt changed');
      const receipt = read(previousReceipt), record = read(path.join(prior, 'measurement.json'));
      check(receipt.phase === 'measured' && record.phase === 'measured' && receipt.manifestHash === record.manifestHash && record.manifestHash === digest(JSON.stringify(record.manifest)), 'recovery', 'Measurement is incomplete');
      const timing = read(path.join(prior, 'measurement-timing.json')), checksum = read(path.join(prior, 'measurement-checksum.json'));
      check(digest(JSON.stringify(record.before)) === digest(JSON.stringify(receipt.before)) && digest(JSON.stringify(record.closed)) === digest(JSON.stringify(read(path.join(prior, 'closed-snapshot.json')))) && sha(path.join(prior, 'closed-snapshot.json')) === receipt.closedSnapshotSha256 && sha(path.join(prior, 'measurement-timing.json')) === receipt.timingSha256, 'recovery', 'Prepared preservation boundary changed');
      assertAdoption(record, m, t, timing, checksum); checkBackupRehearsal();
      check(sha(fileAt(sourceRoot, m.compatibility.database.backup.rehearsal.source)) === sha(path.join(prior, 'measurement-timing.json')) && sha(fileAt(sourceRoot, m.compatibility.database.backup.checksumRehearsal.source)) === sha(path.join(prior, 'measurement-checksum.json')), 'recovery', 'Final controls must retain the exact measured proof bytes');
      const claim = read(locations.claim);
      check((claim.id === record.manifest.id && claim.manifestHash === record.manifestHash) || (claim.id === m.id && claim.manifestHash === digest(JSON.stringify(m))), 'recovery', 'Another release owns the host');
      // The adopted request later selects the executable that is launched and the port that proves closure.
      if (t.kind === 'desktop-files') check(JSON.stringify(read(path.join(prior, 'desktop-request.json'))) === JSON.stringify({ port: Number(new URL(t.origin).port || 80), executable: t.desktopExecutable }), 'recovery', 'Prepared desktop request differs from the pinned target');
      assertClosed(path.join(prior, 'desktop-request.json'));
      const current = snapshot(); check(digest(JSON.stringify(current)) === digest(JSON.stringify(record.closed)), 'recovery', 'Current authorized baseline differs from measurement');
      const payload = m.payloads.find(p => p.platform === t.platform);
      await adapter.validatePayload(payload, false);
      verifyBackupChecksum(path.join(prior, 'before-migrations.sqlite'), timing.backup, 120);
      // Both directories are canonical children of the same deployment root.
      // These are retained immutable-copy links, never links to live userdata.
      const link = (from, to) => { if (fs.existsSync(to)) check(sha(from) === sha(to), 'recovery', 'Adopted retained file differs'); else fs.linkSync(from, to); };
      budget(measuredDisks(), [{ path: t.baseDir, bytes: 4 * Buffer.byteLength(JSON.stringify(record)) + 32 * 1024 * 1024 }]);
      fs.mkdirSync(locations.deployment, { recursive: true, mode: 0o700 });
      link(path.join(prior, 'before-migrations.sqlite'), databaseBackup);
      if (!fs.existsSync(databaseBackup + '.json')) save(databaseBackup + '.json', { ...timing.backup, path: databaseBackup, adoptedFrom: path.join(prior, 'before-migrations.sqlite') });
      if (t.kind === 'desktop-files') { reuseTreeIfPresent(path.join(prior, 'previous-desktop'), path.join(locations.deployment, 'previous-desktop'), path.dirname(t.desktopExecutable)); reuseTreeIfPresent(path.join(prior, 'payload'), locations.stage); }
      await adapter.capacity(payload, true, false);
      await adapter.stage(payload);
      if (!fs.existsSync(closedSnapshot)) save(closedSnapshot, read(path.join(prior, 'closed-snapshot.json')));
      check(sha(closedSnapshot) === receipt.closedSnapshotSha256, 'recovery', 'Adopted closed snapshot differs');
      const journalName = t.kind === 'desktop-files' ? 'desktop-activation.json' : 'service-activation.json';
      const journal = read(path.join(prior, journalName)); check(journal.phase === 'closed' && journal.closedSnapshotSha256 === sha(closedSnapshot), 'recovery', 'Prepared journal changed');
      if (t.kind === 'desktop-files') {
        save(desktopRequest, read(path.join(prior, 'desktop-request.json')));
        for (const f of desktopFiles(payload)) {
          const next = fileAt(resourceRoot, f.path + '.t3w-' + m.id + '.next');
          if (!fs.existsSync(next)) fs.copyFileSync(fileAt(locations.stage, f.path), next);
          check(sha(next) === f.sha256, 'checksum', 'Adopted resource sibling differs');
          const fd = fs.openSync(next, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
      }
      save(path.join(locations.deployment, journalName), { ...journal, release: m.id, adoptedFrom: record.manifest.id });
      assertClosed(); check(digest(JSON.stringify(snapshot())) === digest(JSON.stringify(record.closed)), 'recovery', 'Source changed during adoption');
      const evidence = Object.fromEntries(['receipt.json', 'closed-snapshot.json', journalName, 'measurement.json', 'measurement-timing.json', 'measurement-checksum.json'].map(n => [n, sha(path.join(prior, n))]));
      const terminal = { schema: 1, phase: 'superseded', kind: 'measured-adoption', id: receipt.id, manifestHash: receipt.manifestHash, targetHash: receipt.targetHash, originalReceiptSha256: sha(previousReceipt), evidence, successor: { id: m.id, manifestHash: digest(JSON.stringify(m)), targetHash: digest(JSON.stringify(t)) }, currentSnapshotSha256: digest(JSON.stringify(record.closed)), originalFailureAccepted: false };
      if (!fs.existsSync(path.join(prior, 'superseded.json'))) save(path.join(prior, 'superseded.json'), terminal);
      save(locations.receipt, { phase: 'handoff', id: m.id, manifestHash: digest(JSON.stringify(m)), targetHash: digest(JSON.stringify(t)), before: record.before, measuredPreparation: { id: record.manifest.id, receiptSha256: decision.receiptSha256 } });
      save(locations.claim, { id: m.id, manifestHash: digest(JSON.stringify(m)) });
      return { phase: 'handoff', id: m.id, activationPerformed: false, nextOperation: 'resume' };
    },
    async reconcilePreflight(decision) {
      const priorDir = path.join(locations.root, decision.id ?? 'INVALID');
      check(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(decision.id), 'recovery', 'Invalid predecessor');
      const prior = readDeployment({ ...locations, deployment: priorDir, receipt: path.join(priorDir, 'receipt.json') });
      if (prior.phase === 'superseded') {
        check(prior.supersession.successor.id === m.id && prior.supersession.successor.manifestHash === digest(JSON.stringify(m)) && prior.supersession.successor.targetHash === digest(JSON.stringify(t)) && JSON.stringify(prior.supersession.evidence) === JSON.stringify(decision.evidence), 'recovery', 'Retained supersession differs from retry');
        return { terminal: prior.supersession, summary: { predecessor: decision.id, successor: m.id, originalFailureAccepted: false, alreadyReconciled: true } };
      }
      const context = inspectRecovery(locations.root, decision, m, t, dependencies.requestPath);
      const result = await preflight(m, t, adapter);
      const installed = {};
      if (t.kind === 'desktop-files') for (const rel of Object.keys(context.request.target.expectedFiles)) installed[rel] = sha(fileAt(resourceRoot, rel));
      const reconciliations = {};
      if (decision.windowsProfileReview) {
        check(decision.kind === 'reopened-before-replacement' && decision.windowsProfileReview.policySha256 === digest(JSON.stringify(WINDOWS_PROFILE_POLICY)), 'recovery', 'Unreviewed Windows effort policy');
        const input = { deployment: context.deployment, policy: WINDOWS_PROFILE_POLICY, review: decision.windowsProfileReview, currentSnapshotSha256: digest(JSON.stringify(result.live.snapshot)) };
        check(remainingRunnerMs() >= 30000, 'deadline', 'Insufficient lifetime for Windows effort proof');
        reconciliations.windowsProfile = JSON.parse(run(t.python, [path.join(here, 'windows-profile-proof.py'), JSON.stringify(input)], { timeout: 30000 }));
      }
      if (decision.windowsCatalogReview) reconciliations.windowsCatalog = readWindowsCatalogProof(t.baseDir, decision.windowsCatalogReview, run);
      if (decision.kind === 'installed-forward-repair') {
        const original = context.deployment;
        const bindingFile = path.join(original, 'binding-reconciliation.json');
        if (fs.existsSync(bindingFile)) reconciliations.bindings = python('binding-reconciliation-check', original).entries;
        const p = preservation(context.receipt.before, result.live.snapshot, reconciliations.bindings);
        if (decision.forwardReview) {
          check(decision.forwardReview.policySha256 === digest(JSON.stringify(FORWARD_POLICY)), 'recovery', 'Unreviewed forward policy');
          const input = { deployment: original, policy: FORWARD_POLICY, review: decision.forwardReview, currentSnapshotSha256: digest(JSON.stringify(result.live.snapshot)), currentSessions: result.live.snapshot.sessions.filter(s => FORWARD_POLICY.activitySessionIds.includes(s.id)) };
          check(remainingRunnerMs() >= 30000, 'deadline', 'Insufficient lifetime for forward proof');
          reconciliations.forward = JSON.parse(run(t.python, [path.join(here, 'forward-proof.py'), JSON.stringify(input)], { timeout: 30000 }));
          verifyBackupChecksum(path.join(original, 'before-migrations.sqlite'), read(path.join(original, 'before-migrations.sqlite.json')), checksumSeconds);
        } else if (p.failures.some(f => f.startsWith('inactive-session-changed:'))) reconciliations.activity = readActivityReconciliation(t.python, original, checksumSeconds, run).entries;
        else verifyBackupChecksum(path.join(original, 'before-migrations.sqlite'), read(path.join(original, 'before-migrations.sqlite.json')), checksumSeconds);
        reconciliations.schema = JSON.parse(run(t.python, ['-c', "import sqlite3,json,sys,pathlib; d=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True); d.execute('PRAGMA query_only=ON'); print(json.dumps(list(d.execute(\"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name\"))))", path.join(t.baseDir, 'userdata/state.sqlite')]));
      }
      const terminal = reviewRecovery(context, result.live, installed, reconciliations);
      // Recheck immutable evidence after the bounded read-only reconstruction.
      inspectRecovery(locations.root, decision, m, t, dependencies.requestPath);
      return { terminal, inspected: result, summary: { predecessor: decision.id, successor: m.id, originalFailureAccepted: false, disk: result.disk } };
    },
    async reconcile(decision) {
      const { terminal, summary } = await adapter.reconcilePreflight(decision);
      // Called only under the existing OS lock. Writing this terminal sidecar
      // does not rewrite the failed receipt, release resources or stop the app.
      if (!summary.alreadyReconciled) save(path.join(locations.root, decision.id, 'superseded.json'), terminal);
      return { phase: 'reconciled', ...summary };
    },
    async cancelPreflight(state, requestBytes = 0) {
      assertUnactivated(locations, state, dependencies.requestPath);
      const live = await adapter.inspect();
      check(live.environmentId === t.environmentId && live.version === t.expectedVersion && live.installSha256 === t.expectedServerSha256 && live.clientSha256 === t.expectedClientSha256, 'cancel', 'Live identity/version/install/client changed; cancellation refused');
      check(live.portOwnerVerified && !live.conflictingUpdate && m.minimumCapabilities.every(key => live.capabilities[key] === true), 'cancel', 'Live owner or updater state changed; cancellation refused');
      checkDatabase(m, live.snapshot.database);
      if (t.kind === 'boot-service') serviceConfiguration();
      else for (const [rel, expected] of Object.entries(t.expectedFiles)) {
        check(sha(fileAt(resourceRoot, rel)) === expected, 'cancel', 'An installed desktop resource changed');
        check(!fs.existsSync(fileAt(resourceRoot, rel + '.t3w-' + m.id + '.next')), 'cancel', 'Prepared activation resources block cancellation');
      }
      const observed = { environmentId: live.environmentId, version: live.version, installSha256: live.installSha256, clientSha256: live.clientSha256, snapshotSha256: digest(JSON.stringify(live.snapshot)) };
      const terminal = { schema: 1, kind: 'before-activation', phase: 'cancelled', id: state.id, manifestHash: state.manifestHash, targetHash: state.targetHash, originalReceiptSha256: sha(locations.receipt), cancelledAt: new Date().toISOString(), observed };
      // No backup/migration/payload allocation: this operation writes metadata
      // only, measured at its actual serialized size plus filesystem overhead.
      const bytes = requestBytes * 2 + Buffer.byteLength(JSON.stringify(terminal)) * 2 + 16384;
      const disk = budget(measuredDisks(), [{ path: t.baseDir, bytes }]);
      fs.accessSync(locations.deployment, fs.constants.W_OK);
      assertUnactivated(locations, state, dependencies.requestPath);
      return { terminal, disk };
    },
    async cancel(state) {
      const { terminal } = await adapter.cancelPreflight(state);
      check(!fs.existsSync(path.join(locations.deployment, 'cancelled.json')), 'cancel', 'Cancellation was already recorded; reread its durable status');
      save(path.join(locations.deployment, 'cancelled.json'), terminal);
      return readDeployment(locations);
    },
    async inspect() {
      const descriptor = await get('/.well-known/t3/environment');
      const state = t.kind === 'boot-service' ? read(path.join(t.baseDir, 'runtime/service-state.json')) : null;
      check(descriptor.capabilities?.serverUpdateThreadContinuation === true, 'unsupported', 'Server does not advertise native update continuation');
      const supported = descriptor.capabilities?.serverSelfUpdate === (t.kind === 'boot-service' ? 'boot-service' : 'desktop-managed');
      // Descriptor name is schema-defined; absent capabilities are never guessed.
      check(supported, 'unsupported', 'Expected supported updater capability is absent');
      if (state) check(state.protocol === 3 && state.activeVersion === descriptor.serverVersion, 'unsupported', 'Boot launcher protocol/version differs');
      return { environmentId: descriptor.environmentId, version: descriptor.serverVersion, capabilities: descriptor.capabilities,
        kind: t.kind, platform: `${platform}-${arch}`, portOwnerVerified: t.kind === 'boot-service' ? (dependencies.linuxOwner ?? linuxOwner)() : windowsInfo().portOwnerVerified,
        clientSha256: digest(await get('/', false)), installSha256: sha(currentServer()), conflictingUpdate: state?.update?.status === 'pending', snapshot: snapshot() };
    },
    async validatePayload(payload, staged) {
      verifyFiles(sourceRoot, payload.files, true);
      if (staged) verifyFiles(t.kind === 'boot-service' ? locations.runtime : locations.stage, payload.files, false, true);
      fs.accessSync(t.baseDir, fs.constants.W_OK);
      if (m.compatibility.migrations === 'forward-only') {
        const database = m.compatibility.database, file = fileAt(sourceRoot, database.rehearsal.source);
        check(sha(file) === database.rehearsal.sha256, 'migration', 'Migration rehearsal evidence changed');
        const evidence = read(file);
        check(evidence.commit === m.commit && evidence.version === m.version && evidence.platforms?.includes(t.platform) && evidence.integrity === 'ok' && evidence.preservation === 'passed' && Number.isSafeInteger(evidence.maxExtraBytes) && evidence.maxExtraBytes <= database.maxExtraBytes && evidence.maxExtraBytes > 0 && Number.isSafeInteger(evidence.maxSourceBytes) && evidence.maxSourceBytes >= database.maxSourceBytes, 'migration', 'Rehearsal does not attest this release, platform, preservation and space bound');
        checkDatabase(m, evidence.before); checkDatabase(m, evidence.after, true);
        checkBackupRehearsal();
      }
      if (t.kind === 'boot-service') {
        serviceUnit();
        const bin = staged ? path.join(locations.runtime, 't3') : fileAt(sourceRoot, payload.files.find(f => f.path === 't3').source);
        const result = JSON.parse(run(bin, ['__service-preflight', '--database-path', path.join(t.baseDir, 'userdata/state.sqlite'), '--launcher-protocol', '3']));
        check(result.status === 'ready' && result.version === m.version && result.launcherProtocol === 3, 'compatibility', 'Pinned server preflight rejected release or launcher');
        run('systemctl', ['--user', 'show-environment']);
      } else if (t.kind === 'desktop-files') {
        for (const f of desktopFiles(payload)) {
          check(/^[a-f0-9]{64}$/.test(t.expectedFiles[f.path] ?? ''), 'config', 'Pin every replaced old resource hash');
          check(sha(fileAt(resourceRoot, f.path)) === t.expectedFiles[f.path], 'install', 'Old desktop resource changed');
        }
      }
    },
    async capacity(payload, staged, after, beforeStart = false, closed = undefined) {
      const disks = measuredDisks(), block = disks[0].blockBytes || 4096;
      const filesBytes = payload.files.reduce((sum, f) => sum + Math.ceil(f.bytes / block) * block + block, 0);
      const current = closed ?? snapshot();
      const metadataBytes = Buffer.byteLength(JSON.stringify(current)) * 6 + Buffer.byteLength(JSON.stringify({ m, t })) * 4 + (t.serviceDropIns ?? []).reduce((n, pin) => n + fs.statSync(pin.path).size * 2, 0) + 64 * 1024;
      const requirements = [{ path: t.baseDir, bytes: metadataBytes + (staged || after ? 0 : filesBytes) }];
      if (t.kind === 'boot-service') requirements.push({ path: path.dirname(serviceUnit()), bytes: 16384 });
      if (m.compatibility.migrations === 'forward-only' && (!after || beforeStart)) {
        check(Number.isSafeInteger(current.database.logicalBytes) && current.database.logicalBytes > 0, 'migration', 'Could not measure database backup size');
        check(current.database.logicalBytes <= m.compatibility.database.maxSourceBytes, 'migration', 'Database exceeds the source-size ceiling covered by migration rehearsal');
        if (m.compatibility.database.backup) check(current.database.logicalBytes <= m.compatibility.database.backup.maxSourceBytes, 'backup', 'Database exceeds the measured backup timing ceiling');
        requirements[0].bytes += (fs.existsSync(databaseBackup) ? 0 : current.database.logicalBytes) + m.compatibility.database.maxExtraBytes;
      }
      if (t.kind === 'desktop-files') requirements.push({ path: path.dirname(t.desktopExecutable), bytes: after ? 0 : filesBytes });
      if (t.kind !== 'boot-service' && !staged && !after) {
        const oldRoot = path.dirname(t.desktopExecutable);
        requirements[0].bytes += inventory(oldRoot).reduce((n, rel) => n + Math.ceil(fs.statSync(path.join(oldRoot, rel)).size / block) * block + block, 0);
      }
      return budget(disks, requirements);
    },
    async stage(payload) {
      if (t.kind === 'boot-service' && fs.existsSync(locations.runtime)) {
        verifyFiles(locations.runtime, payload.files, false, true);
        check(fs.readFileSync(path.join(locations.runtime, '.install-complete'), 'utf8').trim() === m.version, 'conflict', 'Existing runtime has no valid install sentinel'); return;
      }
      fs.mkdirSync(locations.stage, { recursive: true, mode: 0o700 });
      if (t.kind !== 'boot-service') {
        const oldRoot = path.dirname(t.desktopExecutable), backup = path.join(locations.deployment, 'previous-desktop');
        fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
        for (const rel of inventory(oldRoot)) {
          const from = fileAt(oldRoot, rel), to = fileAt(backup, rel);
          fs.mkdirSync(path.dirname(to), { recursive: true });
          if (fs.existsSync(to)) check(sha(from) === sha(to), 'conflict', 'Previous desktop changed since partial backup');
          else { fs.copyFileSync(from, to); check(sha(from) === sha(to), 'checksum', 'Previous desktop backup differs'); const fd = fs.openSync(to, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
        }
      }
      for (const f of payload.files) {
        const target = fileAt(locations.stage, f.path); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        if (fs.existsSync(target)) { check(sha(target) === f.sha256, 'checksum', 'Interrupted staged file differs; retain and inspect it'); continue; }
        // A failed copy only damages this owned partial file. Resume can replace it
        // after revalidating source; final names are never published prematurely.
        const tmp = fileAt(locations.stage, f.path + '.partial');
        fs.copyFileSync(fileAt(sourceRoot, f.source), tmp); check(sha(tmp) === f.sha256, 'checksum', 'Copied file checksum differs');
        fs.chmodSync(tmp, f.mode); const fd = fs.openSync(tmp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, target);
      }
      verifyFiles(locations.stage, payload.files, false, true);
      if (t.kind === 'boot-service') {
        const result = JSON.parse(run(path.join(locations.stage, 't3'), ['__service-preflight', '--database-path', path.join(t.baseDir, 'userdata/state.sqlite'), '--launcher-protocol', '3']));
        check(result.version === m.version && result.status === 'ready', 'compatibility', 'Staged server failed preflight');
        fs.writeFileSync(path.join(locations.stage, '.install-complete'), m.version + '\n', { mode: 0o600, flush: true });
        fs.mkdirSync(path.dirname(locations.runtime), { recursive: true });
        fs.renameSync(locations.stage, locations.runtime);
      }
    },
    async activate(release, payload) {
      requireBackupLifetime(true);
      if (t.kind === 'desktop-files') {
        // Prepare all resource siblings while the old app still runs, then close
        // its captured listener/parent. The existing shutdown hook saves native
        // markers under the already-enabled per-project continuation setting.
        for (const f of desktopFiles(payload)) {
          const destination = fileAt(resourceRoot, f.path), next = fileAt(resourceRoot, f.path + '.t3w-' + m.id + '.next');
          if (fs.existsSync(next)) check(sha(next) === f.sha256, 'conflict', 'Resource staging sibling changed');
          else fs.copyFileSync(fileAt(locations.stage, f.path), next);
          check(sha(next) === f.sha256, 'checksum', 'Resource staging sibling differs');
          const fd = fs.openSync(next, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
      }
      await closeForUpdate();
      await adapter.resumeActivation();
      return { method: t.kind === 'desktop-files' ? 'desktop-files' : 'boot-service-install' };
    },
    async resumeActivation() {
      const payload = m.payloads.find(p => p.platform === t.platform);
      if (t.kind === 'desktop-files') {
        if (fs.existsSync(desktopJournal) && ['closed', 'replacing', 'installed'].includes(read(desktopJournal).phase)) {
          if (!desktopPort()) await prepareDatabase(payload);
        }
        finishDesktop(payload); return;
      }
      const journal = path.join(locations.deployment, 'service-activation.json');
      if (!fs.existsSync(journal) || read(journal).phase !== 'closed') return;
      check(run('systemctl', ['--user', 'show', t.service, '-p', 'MainPID', '--value']).trim() === '0', 'recovery', 'Service was restarted externally; verify before retrying');
      const serviceState = read(path.join(t.baseDir, 'runtime/service-state.json'));
      check(serviceState.activeVersion === t.expectedVersion && serviceState.update?.status !== 'pending', 'recovery', 'Service state changed after preflight; retain the closed installation for review');
      await prepareDatabase(payload);
      verifyFiles(locations.runtime, m.payloads.find(p => p.platform === t.platform).files, false, true);
      serviceConfiguration(); // Recheck drift after backup, immediately before install/reload.
      save(journal, { ...read(journal), phase: 'installing', service: t.service });
      run(path.join(locations.runtime, 't3'), ['service', 'install', '--base-dir', t.baseDir, '--allow-downgrade'], { timeout: 150000 });
      save(journal, { ...read(journal), phase: 'started', service: t.service });
    },
    async verify(release, target, before) {
      const deadline = Date.now() + (t.verifySeconds ?? 120) * 1000;
      let last = { ok: false, reason: 'Replacement has not verified' };
      let assetsVerified = false;
      while (Date.now() < deadline) {
        try {
          const result = await preflight(release, target, adapter, { staged: true, after: true });
          if (!assetsVerified) {
            if (t.kind === 'boot-service') verifyFiles(locations.runtime, result.payload.files, false, true);
            else for (const f of desktopFiles(result.payload)) check(sha(fileAt(resourceRoot, f.path)) === f.sha256, 'checksum', 'Installed desktop payload differs');
            const html = (await get('/', false)).toString('utf8');
            const entries = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)].map(match => match[1].replace(/^\.\//, '').replace(/^\//, ''));
            check(entries.some(p => p.endsWith('.js')), 'client', 'Served client has no verifiable script entry');
            for (const entry of new Set(entries)) check(result.payload.files.some(f => f.path === 'client/' + entry), 'client', 'Client entry is absent from pinned inventory');
            // Request the entire pinned tree, including dynamic imports, workers,
            // CSS and fonts. For desktop this binds the embedded ASAR client to
            // the separately reviewed inventory, rather than trusting its label.
            for (const file of result.payload.files.filter(f => f.path.startsWith('client/'))) {
              const route = file.path === 'client/index.html' ? '/' : '/' + file.path.slice(7).split('/').map(encodeURIComponent).join('/');
              check(digest(await get(route, false)) === file.sha256, 'client', 'Served client inventory differs from pinned payload: ' + file.path);
            }
            assetsVerified = true;
          }
          const reconciliationFile = path.join(locations.deployment, 'binding-reconciliation.json');
          const bindingReconciliation = fs.existsSync(reconciliationFile) ? python('binding-reconciliation-check', locations.deployment) : undefined;
          const catalogFile = path.join(locations.deployment, 'catalog-current-state-acceptance.json');
          const catalogReconciliation = fs.existsSync(catalogFile) ? readCatalogReconciliation(locations.deployment, digest(JSON.stringify(m)), digest(JSON.stringify(t)), before, result.live.snapshot) : undefined;
          let recovery = preservation(before, result.live.snapshot, bindingReconciliation?.entries, [], catalogReconciliation?.entries);
          // An idle baseline is not a lifetime ban on new work. Reconstruct
          // explicit post-activation requests from the sealed backup and live
          // event log; missing/ambiguous evidence keeps the original failure.
          let activityReconciliation;
          if (recovery.failures.some(f => f.startsWith('inactive-session-changed:') || f.startsWith('bindings:'))) {
            try { activityReconciliation = readActivityReconciliation(t.python, locations.deployment, checksumSeconds, run); }
            catch { activityReconciliation = { entries: [], blocked: [{ reason: 'activity-evidence-unavailable' }] }; }
          }
          if (activityReconciliation) recovery = preservation(before, result.live.snapshot, [...(bindingReconciliation?.entries ?? []), ...(activityReconciliation.bindingEntries ?? [])], activityReconciliation.entries, catalogReconciliation?.entries);
          if (fs.existsSync(closedSnapshot)) {
            const closed = read(closedSnapshot); closed.sessions = [];
            const closedProof = preservation(closed, result.live.snapshot, activityReconciliation?.bindingEntries, [], catalogReconciliation?.entries);
            recovery.failures.push(...closedProof.failures); recovery.ok &&= closedProof.ok;
          }
          last = { ...recovery, ...(catalogReconciliation ? { catalogReconciliation } : {}), ...(bindingReconciliation ? { bindingReconciliation } : {}), ...(activityReconciliation ? { activityReconciliation } : {}), environmentId: result.live.environmentId, version: result.live.version, clientSha256: result.live.clientSha256 };
          if (recovery.ok || recovery.failed.length || recovery.failures.length) return last;
        } catch (error) { last = { ok: false, code: error.code ?? 'verification', reason: error instanceof DeployError ? error.message : 'Replacement verification pending' }; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      return last;
    },
  };
  return adapter;
}
