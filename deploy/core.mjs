import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class DeployError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function check(ok, code, message) { if (!ok) throw new DeployError(code, message); }
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temp, file); break; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  if (process.platform !== 'win32') { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
}
export function sha(file, deadlineMs = Infinity) {
  check(Date.now() < deadlineMs, 'deadline', 'File verification deadline exceeded');
  const h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), b = Buffer.allocUnsafe(1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, b, 0, b.length, null))) { check(Date.now() < deadlineMs, 'deadline', 'File verification deadline exceeded'); h.update(b.subarray(0, n)); } } finally { fs.closeSync(fd); }
  check(Date.now() < deadlineMs, 'deadline', 'File verification deadline exceeded');
  return h.digest('hex');
}
export function relative(value) {
  check(typeof value === 'string' && value.length > 0 && !/[\\:\x00-\x1f]/.test(value) && !value.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p)), 'manifest', 'Unsafe relative artifact path');
  return value;
}
export function fileAt(root, rel) {
  relative(rel);
  const realRoot = fs.realpathSync(root), full = path.join(realRoot, rel);
  check(realRoot === path.resolve(root), 'path', 'Use a canonical artifact root without junction aliases');
  let current = realRoot;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    try { check(!fs.lstatSync(current).isSymbolicLink(), 'path', 'Symlink/reparse artifact paths are unsupported'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return full;
}
const exact = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export function validateManifest(m) {
  check(m.schema === 1 && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(m.id), 'manifest', 'Expected schema 1 and a safe deployment id');
  check(exact.test(m.version) && /^[a-f0-9]{40}$/.test(m.commit), 'manifest', 'Pin an exact version and full source commit');
  check(m.compatibility?.fromVersions?.length && m.compatibility.fromVersions.every(v => exact.test(v)), 'manifest', 'List compatible old versions');
  check(['none', 'forward-only'].includes(m.compatibility.migrations) && m.compatibility.rollback === 'never' && m.compatibility.review?.length > 10, 'manifest', 'Declare migration expectations, rollback=never, and review evidence');
  check(m.compatibility.continuation === 'native-v1', 'unsupported', 'Native continuation contract review is required');
  const database = m.compatibility.database;
  const ids = values => Array.isArray(values) && values.length > 0 && values.every((v, i) => Number.isSafeInteger(v) && v > 0 && (i === 0 || v > values[i - 1]));
  check(database && ids(database.fromMigrations) && ids(database.toMigrations) && /^[a-f0-9]{64}$/.test(database.fromSchemaSha256) && /^[a-f0-9]{64}$/.test(database.toSchemaSha256), 'manifest', 'Pin old/new migration ledgers and schema fingerprints from rehearsal');
  check(Number.isSafeInteger(database.maxExtraBytes) && database.maxExtraBytes >= 0, 'manifest', 'Provide the reviewed peak extra migration disk bound');
  if (database.backup !== undefined) {
    const b = database.backup;
    check(m.compatibility.migrations === 'forward-only' && typeof b.environmentId === 'string' && b.environmentId.length > 0 && Number.isInteger(b.seconds) && b.seconds >= 270 && b.seconds <= 900 && Number.isSafeInteger(b.maxSourceBytes) && b.maxSourceBytes > 0 && /^[a-f0-9]{64}$/.test(b.rehearsal?.sha256), 'manifest', 'Backup timing profile needs an environment, bounded 270..900 second budget, measured size and hashed proof');
    relative(b.rehearsal.source);
    if (b.checksumSeconds !== undefined) {
      check(Number.isInteger(b.checksumSeconds) && b.checksumSeconds >= 30 && b.checksumSeconds <= 120 && /^[a-f0-9]{64}$/.test(b.checksumRehearsal?.sha256), 'manifest', 'Final checksum needs a bounded 30..120 second budget and hashed measured proof');
      relative(b.checksumRehearsal.source);
    } else check(b.checksumRehearsal === undefined, 'manifest', 'Checksum proof requires an explicit checksum budget');
  }
  if (m.compatibility.migrations === 'none') check(JSON.stringify(database.fromMigrations) === JSON.stringify(database.toMigrations) && database.fromSchemaSha256 === database.toSchemaSha256, 'manifest', 'Code-only release cannot change its expected database schema');
  else {
    check(database.toMigrations.length > database.fromMigrations.length && database.fromMigrations.every((id, i) => database.toMigrations[i] === id), 'manifest', 'Forward migrations must extend the existing ordered ledger');
    check(database.rehearsal && /^[a-f0-9]{64}$/.test(database.rehearsal.sha256) && database.recovery?.length > 20, 'manifest', 'Forward migrations require hashed rehearsal evidence and a forward recovery procedure');
    relative(database.rehearsal.source);
    check(Number.isSafeInteger(database.maxSourceBytes) && database.maxSourceBytes > 0 && database.maxExtraBytes > 0, 'manifest', 'Forward migrations need a measured source-size ceiling and positive peak-extra bound');
  }
  check(Array.isArray(m.requiredCapabilities) && m.requiredCapabilities.every(v => /^[A-Za-z][A-Za-z0-9]+$/.test(v)), 'manifest', 'List required capabilities');
  check(Array.isArray(m.minimumCapabilities) && m.minimumCapabilities.every(v => /^[A-Za-z][A-Za-z0-9]+$/.test(v)), 'manifest', 'List minimum capabilities of the old installation separately');
  check(Array.isArray(m.payloads) && m.payloads.length > 0, 'manifest', 'Missing platform payloads');
  const platforms = new Set();
  for (const p of m.payloads) {
    check(['linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'].includes(p.platform) && !platforms.has(p.platform), 'manifest', 'Duplicate or unsupported platform'); platforms.add(p.platform);
    check(['boot-service', 'desktop-files'].includes(p.kind) && p.version === m.version && p.commit === m.commit, 'manifest', 'Payload release identity differs');
    check(exact.test(p.clientVersion) && p.files?.length, 'manifest', 'Pin the hosted client version and full file inventory');
    if (p.clientVersion !== m.version) check(p.clientCompatibilityReview?.length > 10, 'manifest', 'Reused client needs explicit compatibility evidence');
    const names = new Set();
    for (const f of p.files) {
      relative(f.path); relative(f.source);
      check(!names.has(f.path.toLowerCase()) && /^[a-f0-9]{64}$/.test(f.sha256) && Number.isSafeInteger(f.bytes) && f.bytes >= 0 && [0o644, 0o755].includes(f.mode), 'manifest', 'Invalid or duplicate artifact inventory'); names.add(f.path.toLowerCase());
      check(f.path !== '.install-complete', 'manifest', 'Installer sentinel is generated after verification');
      check(['server', 'client', 'desktop', 'support'].includes(f.role), 'manifest', 'Classify server/client/desktop/support artifacts');
    }
    check(p.files.some(f => f.role === 'client' && f.path === 'client/index.html') && p.files.some(f => f.role === 'server'), 'manifest', 'Server and hosted client payloads are required');
    if (p.kind === 'boot-service') check(p.platform.startsWith('linux-') && p.files.some(f => f.path === 't3' && f.mode === 0o755), 'manifest', 'Boot service needs an executable t3');
    else if (p.kind === 'desktop-files') {
      check(p.platform.startsWith('win32-') && p.files.some(f => f.path === 'server.asar') && p.files.some(f => f.path === 'app.asar'), 'unsupported', 'Desktop file updates require server/app ASARs');
      check(p.smokeReview?.length > 10, 'manifest', 'Record an isolated packaged desktop/server version and client verification');
      check(p.files.every(f => f.path.startsWith('client/') || ['server.asar', 'app.asar'].includes(f.path) || f.path.startsWith('server.asar.unpacked/')), 'unsupported', 'Desktop file payload can replace only reviewed application resources');
    }
  }
  return m;
}
export function inventory(root, prefix = '') {
  check(!fs.lstatSync(root).isSymbolicLink(), 'path', 'Artifact inventory root must not be a link');
  const result = [];
  for (const d of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name; relative(rel);
    check(!d.isSymbolicLink(), 'path', 'Package symlinks as regular files before inventorying');
    if (d.isDirectory()) result.push(...inventory(root, rel));
    else { check(d.isFile(), 'path', 'Only regular package files are supported'); result.push(rel); }
  }
  return result.sort();
}
export function verifyFiles(root, files, source = false, complete = false) {
  for (const f of files) {
    const file = fileAt(root, source ? f.source : f.path);
    check(fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size === f.bytes && sha(file) === f.sha256, 'checksum', 'Artifact missing or checksum/size differs: ' + f.path);
    if (!source && process.platform !== 'win32') check((fs.statSync(file).mode & 0o777) === f.mode, 'checksum', 'Staged executable permissions differ: ' + f.path);
  }
  if (complete) check(JSON.stringify(inventory(root).filter(p => p !== '.install-complete')) === JSON.stringify(files.map(f => f.path).sort()), 'checksum', 'Unexpected staged files');
}
export function budget(disks, requirements) {
  const grouped = new Map();
  for (const r of requirements) {
    const d = disks.find(x => x.path === r.path); check(d, 'disk', 'Missing filesystem measurement');
    check(!['tmpfs', 'ramfs', 'usb', 'removable'].includes(d.type), 'disk', 'RAM and removable storage are not deployment staging');
    check(Number.isSafeInteger(d.freeBytes) && d.freeBytes >= 0, 'disk', 'Invalid free bytes');
    const floor = d.class === 'kingston' ? 100 * 2 ** 30 : d.class === 'wd' ? 60 * 2 ** 30 : 0;
    check(['kingston', 'wd', 'other'].includes(d.class) && Number.isSafeInteger(d.reserveBytes) && d.reserveBytes > 0 && d.reserveBytes >= floor && Number.isSafeInteger(d.growthBytes) && d.growthBytes >= 0, 'disk', 'Disk reserve or concurrent growth budget is invalid');
    const old = grouped.get(d.device) ?? { device: d.device, freeBytes: d.freeBytes, reserveBytes: 0, growthBytes: 0, extraBytes: 0 };
    old.freeBytes = Math.min(old.freeBytes, d.freeBytes); old.reserveBytes = Math.max(old.reserveBytes, d.reserveBytes); old.growthBytes = Math.max(old.growthBytes, d.growthBytes); old.extraBytes += r.bytes; grouped.set(d.device, old);
  }
  for (const d of grouped.values()) check(d.freeBytes >= d.reserveBytes + d.growthBytes + d.extraBytes, 'headroom', `Insufficient headroom: free=${d.freeBytes}, reserve=${d.reserveBytes}, growth=${d.growthBytes}, peakExtra=${d.extraBytes}`);
  return [...grouped.values()];
}
export function eligible(s) { return !s.archivedAt && !s.snoozedUntil && !s.settledAt && !s.deletedAt && s.status === 'running' && Boolean(s.activeTurnId); }
export function checkSessions(snapshot) {
  for (const s of snapshot.sessions) {
    const running = s.status === 'running' || s.status === 'starting' || Boolean(s.activeTurnId);
    check(!running || eligible(s), 'unsupported', 'Starting, stopped/snoozed/settled, or ambiguous active sessions must settle before deployment');
    check(!s.marker || eligible(s), 'unsupported', 'Stale continuation marker needs supported reconciliation before deployment');
    if (eligible(s)) check(s.nativeId && s.profile && s.instance && s.bindingStatus === 'running' && s.provider === 'codex', 'unsupported', 'Running sessions require verified Codex promptless native continuation; other adapters must finish first');
  }
}
export function preservation(before, after, reconciledBindings = [], reconciledActivity = [], reconciledRoutes = []) {
  const failures = [], pending = [], failed = [];
  const oldModels = new Map(before.bindingModels ?? []), newModels = new Map(after.bindingModels ?? []);
  for (const key of ['projects', 'profiles', 'bindings', 'history', 'historyContent', 'ownership', 'jobs', 'routes']) {
    const next = new Map(after[key] ?? []);
    for (const [id, hash] of before[key] ?? []) if (next.get(id) !== hash) {
      // Only a transition TO the authoritative persisted selection is benign.
      // Legacy receipts lack this extra fingerprint and need independently
      // verified reconstruction evidence; never replace their original hashes.
      const normalized = oldModels.get(id)?.sha256 && newModels.get(id)?.normalized === true && oldModels.get(id).sha256 === newModels.get(id).sha256;
      const reconciled = reconciledBindings.some(entry => entry.id === id && entry.fromSha256 === hash && entry.toSha256 === next.get(id));
      const acceptedCatalog = key === 'routes' && id === 'file:connection-catalog.json' && reconciledRoutes.some(entry => entry.id === id && entry.acceptance === 'reviewed-current-catalog' && (entry.historicalEquality === 'unproven' || entry.historicalEquality === false) && entry.fromSha256 === hash && entry.toSha256 === next.get(id));
      if (!acceptedCatalog && (key !== 'bindings' || (!normalized && !reconciled))) failures.push(`${key}:${id}`);
    }
  }
  for (const old of before.sessions) {
    const next = after.sessions.find(s => s.id === old.id);
    if (eligible(old)) {
      if (!next || next.nativeId !== old.nativeId || next.instance !== old.instance || next.provider !== old.provider || next.profile !== old.profile) failures.push(`native-profile:${old.id}`);
      else if (next.status === 'error' || next.lastError) failed.push(old.id);
      else if (next.marker || !next.lastTurnId || (next.lastTurnId === old.lastTurnId && !(next.lastTurnState === 'completed' && next.lastTurnCompletedAt && next.lastTurnCompletedAt !== old.lastTurnCompletedAt))) pending.push(old.id);
    } else if (!next || next.lastTurnId !== old.lastTurnId || Boolean(next.activeTurnId) !== Boolean(old.activeTurnId) || ['archivedAt', 'deletedAt', 'snoozedUntil', 'settledAt'].some(key => next[key] !== old[key]) || (['running', 'starting'].includes(next.status) && next.status !== old.status)) {
      // Only the read-only host reconstruction can supply these exact turn
      // receipts. It proves every new turn, not merely the most recent one.
      const activity = next && reconciledActivity.find(entry => entry.id === old.id && entry.fromLastTurnId === old.lastTurnId && entry.toLastTurnId === next.lastTurnId && (entry.turnIds?.includes(next.lastTurnId) || (entry.kind === 'idle-settlement' && entry.turnIds?.length === 0)));
      const settled = next && activity?.settlement?.settledAt === next.settledAt && Boolean(next.settledAt) && !next.activeTurnId && next.lastTurnState === 'completed' && (!old.settledAt || activity.unsettled === true);
      const lifecycle = next && ['archivedAt', 'deletedAt', 'snoozedUntil'].every(key => next[key] === old[key]) && (next.settledAt === old.settledAt || (old.settledAt && next.settledAt === null && activity?.unsettled === true) || settled);
      const idleSettlement = activity?.kind === 'idle-settlement' && settled && !old.settledAt && !old.activeTurnId && ['ready', 'stopped'].includes(old.status) && next.status === 'stopped' && next.lastTurnId === old.lastTurnId && old.lastTurnState === 'completed' && Boolean(old.lastTurnCompletedAt) && next.lastTurnCompletedAt === old.lastTurnCompletedAt;
      const turnMatches = idleSettlement || (next && next.lastTurnId !== old.lastTurnId && (next.activeTurnId
        ? next.activeTurnId === next.lastTurnId && next.status === 'running' && next.lastTurnState === 'running'
        : next.lastTurnState === 'completed' && ['ready', 'stopped'].includes(next.status)));
      if (!activity || !lifecycle || !turnMatches) failures.push(`inactive-session-changed:${old.id}`);
      else if (['nativeId', 'instance', 'provider', 'profile'].some(key => !old[key] || next[key] !== old[key])) failures.push(`native-profile:${old.id}`);
      else if (next.status === 'error' || next.lastError) failed.push(old.id);
      else if (next.marker) pending.push(old.id);
    } else if (next.marker) pending.push(old.id);
  }
  const jobStates = new Map(after.jobStates ?? []);
  for (const [id, status] of before.jobStates ?? []) if (!['failed', 'error', 'cancelled', 'interrupted'].includes(status) && ['failed', 'error', 'cancelled', 'interrupted'].includes(jobStates.get(id))) failed.push(`worker-job:${id}`);
  return { ok: !failures.length && !pending.length && !failed.length, failures, pending, failed };
}
export function checkDatabase(manifest, observed, after = false) {
  const expected = manifest.compatibility.database;
  check(observed && JSON.stringify(observed.migrationIds) === JSON.stringify(after ? expected.toMigrations : expected.fromMigrations) && observed.schemaSha256 === (after ? expected.toSchemaSha256 : expected.fromSchemaSha256), 'migration', 'Database migration ledger/schema differs from the reviewed expected state');
}
export async function preflight(m, t, adapter, { staged = false, after = false } = {}) {
  validateManifest(m);
  check(m.compatibility.fromVersions.includes(t.expectedVersion), 'version', 'Expected old version is outside compatibility review');
  const payload = m.payloads.find(p => p.platform === t.platform);
  check(payload && payload.kind === t.kind, 'unsupported', 'No matching host payload');
  const live = await adapter.inspect();
  checkDatabase(m, live.snapshot.database, after);
  if (!after && m.compatibility.migrations === 'forward-only') check(live.snapshot.database.logicalBytes <= m.compatibility.database.maxSourceBytes, 'migration', 'Current database exceeds the source size covered by the reviewed migration-space bound');
  if (!after && m.compatibility.database.backup) check(live.snapshot.database.logicalBytes <= m.compatibility.database.backup.maxSourceBytes, 'backup', 'Current database exceeds the measured backup timing ceiling');
  check(live.environmentId === t.environmentId, 'identity', 'Live environment identity differs');
  check(live.version === (after ? m.version : t.expectedVersion), 'version', 'Live version differs from expected state');
  check(live.clientSha256 === (after ? payload.files.find(f => f.path === 'client/index.html').sha256 : t.expectedClientSha256), 'client', 'Served client differs');
  check(live.installSha256 === (after ? payload.files.find(f => f.role === 'server').sha256 : t.expectedServerSha256), 'install', 'Installed server artifact differs');
  check(live.kind === t.kind && live.platform === t.platform && live.portOwnerVerified, 'install', 'Listener/install/launcher identity differs');
  check((after ? m.requiredCapabilities : m.minimumCapabilities).every(k => live.capabilities[k] === true), 'capability', 'Required capability is absent');
  check(!live.conflictingUpdate, 'conflict', 'Another update is pending');
  if (!after) {
    checkSessions(live.snapshot);
    if (m.dormantMoveRecovery) {
      check(typeof adapter.verifyDormantMove === 'function', 'move-recovery', 'Native recovery proof is unavailable');
      live.dormantMoveRecovery = await adapter.verifyDormantMove(live.snapshot);
    } else check(!(live.snapshot.blockingOperations?.length), 'unsupported', 'An ownership transaction or native move is in flight; let its supported reconciliation finish before deployment');
    check(live.snapshot.sessions.filter(eligible).every(s => s.continueOnShutdown === true), 'unsupported', 'Every active session needs its existing effective continueThreadsAfterServerUpdate setting enabled');
  }
  if (!after) await adapter.validatePayload(payload, staged);
  const disk = await adapter.capacity(payload, staged, after);
  return { live, payload, disk };
}

// All mutating calls run under the host's OS file lock. The durable claim prevents
// a different release from taking over a partial activation after that process exits.
export async function execute(m, t, adapter, state, command) {
  const hash = digest(JSON.stringify(m));
  check(!m.measurementOnly || command === 'status', 'recovery', 'Measurement plans cannot activate; adopt their completed proof under a distinct release id');
  check(['plan', 'stage', 'apply', 'resume', 'status', 'cancel'].includes(command), 'usage', 'Unknown deployment operation');
  check(!state.manifestHash || state.manifestHash === hash, 'conflict', 'Deployment id was reused for another manifest');
  check(!state.targetHash || state.targetHash === digest(JSON.stringify(t)), 'conflict', 'Target configuration changed; inspect the retained receipt');
  const persist = phase => { Object.assign(state, { manifestHash: hash, targetHash: digest(JSON.stringify(t)), id: m.id, phase, updatedAt: new Date().toISOString() }); adapter.save(state); };
  if (command === 'status') return state;
  if (state.phase === 'cancelled') {
    check(command === 'cancel', 'cancelled', 'This release was cancelled before activation; use a new deployment id');
    return state;
  }
  if (command === 'cancel') {
    check(state.phase === 'staged', 'cancel', 'Only a staged release can be cancelled before activation');
    return adapter.cancel(state);
  }
  if (state.phase === 'accepted') return state;
  if (['handoff', 'verifying', 'recovery-required'].includes(state.phase)) {
    check(command !== 'stage', 'recovery', 'Activation is uncertain; use resume to verify without issuing another update');
    persist('verifying');
    try {
      await adapter.resumeActivation?.();
      const proof = await adapter.verify(m, t, state.before);
      state.proof = proof;
      persist(proof.ok ? 'accepted' : 'recovery-required');
    } catch (error) { state.error = { code: error.code ?? 'verification', message: error instanceof DeployError ? error.message : 'Verification failed; retained installation and history require inspection' }; persist('recovery-required'); }
    return state;
  }
  try {
    const result = await preflight(m, t, adapter, { staged: state.phase === 'staged' });
    if (command === 'plan') return { phase: 'ready', release: m.id, version: m.version, environmentId: t.environmentId, disk: result.disk, activeSessions: result.live.snapshot.sessions.filter(eligible).map(s => s.id) };
    if (state.phase !== 'staged') {
      persist('staging'); await adapter.stage(result.payload); persist('staged');
    }
    if (command === 'stage') return state;
    // Observe again immediately before handoff. Do not reuse a stale plan snapshot.
    const fresh = await preflight(m, t, adapter, { staged: true });
    state.before = fresh.live.snapshot;
    state.previous = { version: t.expectedVersion, installSha256: t.expectedServerSha256 };
    // Persist uncertainty BEFORE stopping anything: a lost result must never cause
    // a second activation. Host journals distinguish verified closure from doubt.
    persist('handoff');
    try { state.handoff = await adapter.activate(m, fresh.payload); }
    catch (error) { state.handoff = { uncertain: true, code: error.code ?? 'updater' }; }
    persist('verifying');
    const proof = await adapter.verify(m, t, state.before);
    state.proof = proof; persist(proof.ok ? 'accepted' : 'recovery-required');
  } catch (error) {
    state.error = { code: error.code ?? 'io', message: error instanceof DeployError ? error.message : 'Operation failed; check paths, connectivity, permissions and retained receipt' };
    persist(['handoff', 'verifying'].includes(state.phase) ? 'recovery-required' : 'preflight-failed');
  }
  return state;
}
