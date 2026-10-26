import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execute, preflight, validateManifest, checkSessions, preservation, budget, digest, sha, save, verifyFiles, fileAt, DeployError } from '../deploy/core.mjs';
import { main, remoteArgs, shellQuote, psQuote } from '../deploy/cli.mjs';
import { makeNative } from '../deploy/native.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const python = process.env.T3W_TEST_PYTHON ?? 'python3';
const fixtureRoot = process.env.T3W_TEST_TMP ?? os.tmpdir();
function fixture(t) { const p = fs.mkdtempSync(path.join(fixtureRoot, 't3w deploy [quote] ')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }
const blank = () => ({ database: { migrationIds: [1], schemaSha256: digest('schema-one'), logicalBytes: 8192 }, projects: [], profiles: [], history: [], ownership: [], jobs: [], routes: [], sessions: [] });
const session = () => ({ id: 'working', status: 'running', bindingStatus: 'running', activeTurnId: 'old-turn', lastTurnId: 'old-turn', nativeId: 'native-hash', instance: 'account', provider: 'codex', profile: 'astra-high', continueOnShutdown: true });
function scenario() {
  const m = { schema: 1, id: 'release-42', version: '0.0.45+custom.42', commit: 'a'.repeat(40), compatibility: { fromVersions: ['0.0.45+custom.41'], migrations: 'none', rollback: 'never', continuation: 'native-v1', review: 'Reviewed source and migration comparison' }, requiredCapabilities: ['nativeSessionMoves'], payloads: [{ platform: 'linux-x64', kind: 'boot-service', version: '0.0.45+custom.42', commit: 'a'.repeat(40), clientVersion: '0.0.45+custom.42', files: [{ path: 't3', source: 'payload/t3', bytes: 3, sha256: digest('new'), mode: 0o755, role: 'server' }, { path: 'client/index.html', source: 'payload/client/index.html', bytes: 4, sha256: digest('html'), mode: 0o644, role: 'client' }] }] };
  const t = { environmentId: 'env1', kind: 'boot-service', platform: 'linux-x64', expectedVersion: '0.0.45+custom.41', expectedServerSha256: digest('old'), expectedClientSha256: digest('old-html') };
  const state = {}, calls = [], snapshot = blank(); snapshot.sessions.push(session());
  m.compatibility.database = { fromMigrations: [1], toMigrations: [1], fromSchemaSha256: digest('schema-one'), toSchemaSha256: digest('schema-one'), maxExtraBytes: 0 };
  m.minimumCapabilities = ['nativeSessionMoves'];
  let live = { environmentId: 'env1', kind: t.kind, platform: t.platform, version: t.expectedVersion, capabilities: { nativeSessionMoves: true }, portOwnerVerified: true, installSha256: t.expectedServerSha256, clientSha256: t.expectedClientSha256, snapshot };
  const adapter = {
    save(s) { calls.push(['save', s.phase]); },
    async inspect() { calls.push(['inspect']); return structuredClone(live); },
    async validatePayload() { calls.push(['validate']); },
    async capacity() { return budget([{ path: 'base', device: 'fixed', freeBytes: 1000000, reserveBytes: 10000, growthBytes: 100, class: 'other', type: 'fixed' }], [{ path: 'base', bytes: 7 }]); },
    async stage() { calls.push(['stage']); },
    async activate() { calls.push(['activate']); live = { ...live, version: m.version, installSha256: m.payloads[0].files[0].sha256, clientSha256: m.payloads[0].files[1].sha256 }; live.snapshot.sessions[0].lastTurnId = 'native-resumed-turn'; live.snapshot.database = { ...live.snapshot.database, migrationIds: m.compatibility.database.toMigrations, schemaSha256: m.compatibility.database.toSchemaSha256 }; return { method: 'boot-service', updateId: 'one' }; },
    async verify() { calls.push(['verify']); const after = await preflight(m, t, adapter, { staged: true, after: true }); return preservation(state.before, after.live.snapshot); },
  };
  return { m, t, state, adapter, calls, get live() { return live; } };
}
test('stage, activate and safe retry preserve native profile and never repeat a successful update', async () => {
  const s = scenario(); await execute(s.m, s.t, s.adapter, s.state, 'stage'); assert.equal(s.state.phase, 'staged');
  await execute(s.m, s.t, s.adapter, s.state, 'apply'); assert.equal(s.state.phase, 'accepted');
  await execute(s.m, s.t, s.adapter, s.state, 'resume'); assert.equal(s.calls.filter(c => c[0] === 'activate').length, 1);
  assert.ok(s.calls.findIndex(c => c[0] === 'save' && c[1] === 'handoff') < s.calls.findIndex(c => c[0] === 'activate'));
});
for (const [name, mutate, code] of [
  ['wrong environment', s => { s.live.environmentId = 'other'; }, 'identity'],
  ['advanced version', s => { s.live.version = '0.0.45+custom.99'; }, 'version'],
  ['wrong served client', s => { s.live.clientSha256 = digest('wrong'); }, 'client'],
  ['changed installed binary', s => { s.live.installSha256 = digest('wrong'); }, 'install'],
  ['capability missing', s => { s.live.capabilities = {}; }, 'capability'],
  ['concurrent updater', s => { s.live.conflictingUpdate = true; }, 'conflict'],
  ['insufficient headroom', s => { s.adapter.capacity = async () => { throw new DeployError('headroom', 'reserve'); }; }, 'headroom'],
]) test(name + ' uses identical plan and apply validation', async () => {
  const s = scenario(); mutate(s);
  await assert.rejects(preflight(s.m, s.t, s.adapter), e => e.code === code);
  await execute(s.m, s.t, s.adapter, s.state, 'apply'); assert.equal(s.state.error.code, code); assert.ok(!s.calls.some(c => c[0] === 'activate'));
});
test('offline peer stays pending while another explicit host is independently evaluated', async t => {
  const dir = fixture(t), s = scenario(); save(path.join(dir, 'release.json'), s.m);
  save(path.join(dir, 'hosts.json'), { targets: { absent: { remote: { ssh: 'invalid-deploy-test-host', shell: 'posix', node: '/usr/bin/node', entry: '/missing/deploy.mjs', config: '/missing/hosts.json', manifest: '/missing/release.json', target: 'self' } }, local: { ...s.t, baseDir: dir } } });
  const result = await main(['plan', '--config', path.join(dir, 'hosts.json'), '--manifest', path.join(dir, 'release.json'), '--target', 'absent', '--target', 'local']);
  assert.equal(result.targets[0].result.phase, 'pending'); assert.equal(result.targets[1].result.phase, 'blocked');
});
test('interrupted stage can retry without activating prematurely', async () => {
  const s = scenario(); const stage = s.adapter.stage; s.adapter.stage = async () => { throw new Error('copy interrupted'); };
  await execute(s.m, s.t, s.adapter, s.state, 'stage'); assert.equal(s.state.phase, 'preflight-failed');
  s.adapter.stage = stage; await execute(s.m, s.t, s.adapter, s.state, 'stage'); assert.equal(s.state.phase, 'staged'); assert.ok(!s.calls.some(c => c[0] === 'activate'));
});
test('lost updater response and interrupted verifier remain uncertain and never issue another update', async () => {
  const s = scenario(); const activate = s.adapter.activate, verify = s.adapter.verify;
  s.adapter.activate = async () => { await activate(); throw new Error('socket closed'); };
  s.adapter.verify = async () => { throw new Error('agent stopped'); };
  await execute(s.m, s.t, s.adapter, s.state, 'apply'); assert.equal(s.state.phase, 'recovery-required');
  s.adapter.verify = verify; await execute(s.m, s.t, s.adapter, s.state, 'resume'); assert.equal(s.state.phase, 'accepted'); assert.equal(s.calls.filter(c => c[0] === 'activate').length, 1);
});
test('updater rejection leaves recoverable receipt; no blind retry or database rollback', async () => {
  const s = scenario(); s.adapter.activate = async () => { throw new Error('updater failed'); };
  await execute(s.m, s.t, s.adapter, s.state, 'apply'); assert.equal(s.state.phase, 'recovery-required'); assert.equal(s.state.error.code, 'version');
  await execute(s.m, s.t, s.adapter, s.state, 'resume'); assert.equal(s.state.phase, 'recovery-required');
});
test('manifest reuse and changed target config conflict before mutation', async () => {
  const s = scenario(); await execute(s.m, s.t, s.adapter, s.state, 'stage');
  await assert.rejects(execute({ ...s.m, commit: 'b'.repeat(40) }, s.t, s.adapter, s.state, 'apply'), /manifest/);
  await assert.rejects(execute(s.m, { ...s.t, environmentId: 'changed' }, s.adapter, s.state, 'apply'), /configuration/);
});
test('reviewed forward-only migrations can activate but have no automatic rollback path', async () => {
  const s = scenario(); s.m.compatibility.migrations = 'forward-only';
  Object.assign(s.m.compatibility.database, { toMigrations: [1, 2], toSchemaSha256: digest('schema-two'), maxExtraBytes: 4096, maxSourceBytes: 8192, rehearsal: { source: 'rehearsal.json', sha256: digest('evidence') }, recovery: 'Restart the pinned new release against the retained current database; never restore older history.' });
  validateManifest(s.m);
  s.adapter.verify = async () => ({ ok: false, reason: 'migration or native recovery failed' });
  await execute(s.m, s.t, s.adapter, s.state, 'apply'); assert.equal(s.state.phase, 'recovery-required'); assert.ok(s.calls.some(c => c[0] === 'activate'));
  s.m.compatibility.rollback = 'restore-database'; assert.throws(() => validateManifest(s.m));
});
test('inactive and unsupported provider sessions are not resumed; stale markers block before stop', () => {
  for (const property of ['snoozedUntil', 'settledAt', 'archivedAt', 'deletedAt']) { const b = blank(); b.sessions.push({ ...session(), [property]: 'date' }); assert.throws(() => checkSessions(b)); }
  const b = blank(); b.sessions.push({ ...session(), status: 'stopped', activeTurnId: null, marker: true }); assert.throws(() => checkSessions(b));
  b.sessions[0] = { ...session(), provider: 'claude' }; assert.throws(() => checkSessions(b));
  b.sessions[0] = { ...session(), status: 'stopped', activeTurnId: null }; checkSessions(b);
});
test('native binding/profile changes, failed continuation, lost work and changed inactive threads cannot pass readiness', () => {
  const b = blank(); b.sessions.push(session()); b.history = [['message', 'hash']]; b.historyContent = [['message', 'content-hash']]; b.jobs = [['queued-job', 'hash']];
  const a = structuredClone(b); a.sessions[0].lastTurnId = 'new'; assert.equal(preservation(b, a).ok, true);
  for (const key of ['nativeId', 'instance', 'profile']) { const bad = structuredClone(a); bad.sessions[0][key] = 'changed'; assert.equal(preservation(b, bad).ok, false); }
  const failed = structuredClone(a); failed.sessions[0].status = 'error'; assert.deepEqual(preservation(b, failed).failed, ['working']);
  const corrupted = structuredClone(a); corrupted.historyContent[0][1] = 'changed'; assert.equal(preservation(b, corrupted).ok, false);
  a.jobs = []; assert.equal(preservation(b, a).ok, false);
  const inactive = blank(); inactive.sessions.push({ ...session(), status: 'stopped', activeTurnId: null }); const resumed = structuredClone(inactive); resumed.sessions[0].lastTurnId = 'bad-resume'; assert.equal(preservation(inactive, resumed).ok, false);
  const unsnoozed = structuredClone(inactive); inactive.sessions[0].snoozedUntil = '2099-01-01'; assert.equal(preservation(inactive, unsnoozed).ok, false);
});
test('measured metadata fits without blanket 2 GiB; Kingston/WD reserves and concurrent growth stay enforced', () => {
  const d = { path: 'base', device: 'disk', freeBytes: 100 * 2 ** 30 + 1024 ** 2, reserveBytes: 100 * 2 ** 30, growthBytes: 4096, class: 'kingston', type: 'fixed' };
  assert.equal(budget([d], [{ path: 'base', bytes: 8192 }])[0].extraBytes, 8192);
  assert.throws(() => budget([{ ...d, reserveBytes: 99 * 2 ** 30 }], [{ path: 'base', bytes: 1 }]));
  assert.throws(() => budget([{ ...d, class: 'wd', reserveBytes: 59 * 2 ** 30 }], [{ path: 'base', bytes: 1 }]));
  assert.throws(() => budget([{ ...d, growthBytes: 2 * 1024 ** 2 }], [{ path: 'base', bytes: 1 }]));
  assert.throws(() => budget([{ ...d, type: 'tmpfs' }], [{ path: 'base', bytes: 1 }]));
  const two = { ...d, path: 'install' }; assert.equal(budget([d, two], [{ path: 'base', bytes: 4096 }, { path: 'install', bytes: 8192 }])[0].extraBytes, 12288);
});
test('Windows literal paths and SSH commands cannot introduce shell arguments', () => {
  const dangerous = "C:\\A path [1]\\O'Brien;$()` & test\\cli.mjs";
  assert.equal(psQuote(dangerous), "'" + dangerous.replaceAll("'", "''") + "'");
  assert.equal(shellQuote("one'two;$(bad)"), "'one'\\''two;$(bad)'");
  const args = remoteArgs({ ssh: 'pinned-host', shell: 'powershell', node: 'C:\\Program Files\\node.exe', entry: dangerous, config: 'C:\\conf.json', manifest: 'C:\\rel.json', target: 'host' }, 'plan', 'a'.repeat(64));
  const script = Buffer.from(args.at(-1).split(' ').at(-1), 'base64').toString('utf16le'); assert.ok(script.includes(psQuote(dangerous)));
  assert.throws(() => remoteArgs({ ssh: '-oProxyCommand=bad' }, 'plan', 'a'));
});
test('real inventory/manifest command detects altered artifact, unsafe path, reused client and mixed commits', async t => {
  const dir = fixture(t), s = scenario(); fs.mkdirSync(path.join(dir, 'payload/client'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'payload/t3'), 'new'); fs.writeFileSync(path.join(dir, 'payload/client/index.html'), 'html');
  const p = s.m.payloads[0]; delete p.files; p.root = 'payload'; p.executableFiles = ['t3']; save(path.join(dir, 'spec.json'), s.m);
  await main(['manifest', '--spec', path.join(dir, 'spec.json'), '--out', path.join(dir, 'release.json')]);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'))); verifyFiles(dir, m.payloads[0].files, true);
  fs.writeFileSync(path.join(dir, 'payload/t3'), 'bad'); assert.throws(() => verifyFiles(dir, m.payloads[0].files, true), /checksum/);
  assert.throws(() => fileAt(dir, '../bad')); assert.throws(() => fileAt(dir, 'C:/bad')); assert.throws(() => fileAt(dir, 'con.txt'));
  m.payloads[0].commit = 'b'.repeat(40); assert.throws(() => validateManifest(m)); m.payloads[0].commit = m.commit;
  m.payloads[0].clientVersion = '0.0.45+custom.41'; assert.throws(() => validateManifest(m));
});
test('actual Python OS lock excludes a concurrent invocation and releases after owned child exits', async t => {
  const dir = fixture(t), nodeEntry = path.join(dir, 'hold.mjs'), req = path.join(dir, 'request.json');
  fs.writeFileSync(nodeEntry, "import fs from 'node:fs'; if(process.env.T3W_GUARD_GATE) fs.readFileSync(0); console.log('holding'); process.stdin.resume(); setTimeout(()=>process.exit(0),1000);\n");
  save(req, { node: process.execPath, entry: nodeEntry, target: { baseDir: dir } });
  const helper = path.join(root, 'deploy/host.py');
  const child = spawn(python, [helper, 'guard', req], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = new Promise(resolve => child.once('close', (code) => resolve(code)));
  await new Promise((resolve, reject) => { child.stdout.once('data', b => b.toString().includes('holding') ? resolve() : reject(new Error(b.toString()))); child.once('error', reject); });
  const second = spawnSync(python, [helper, 'guard', req], { encoding: 'utf8', windowsHide: true }); assert.equal(second.status, 3, second.stdout + second.stderr); assert.equal(JSON.parse(second.stdout).phase, 'busy');
  assert.equal(await exit, 0);
  fs.writeFileSync(nodeEntry, "import fs from 'node:fs'; if(process.env.T3W_GUARD_GATE) fs.readFileSync(0); console.log('finished');\n");
  const third = spawnSync(python, [helper, 'guard', req], { encoding: 'utf8', windowsHide: true }); assert.equal(third.status, 0, third.stdout + third.stderr);
});
test('Windows custom ASAR replacement resumes an interrupted install and starts only after coherent resources', { skip: process.platform !== 'win32' }, async t => {
  const dir = fixture(t), s = scenario(), resources = path.join(dir, 'installed/resources'), payloadDir = path.join(dir, 'payload');
  fs.mkdirSync(resources, { recursive: true }); fs.mkdirSync(payloadDir);
  const files = [['server.asar', 'server'], ['app.asar', 'desktop'], ['client/index.html', 'client']].map(([rel, role]) => {
    const source = path.join(payloadDir, rel); fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, 'new-' + rel);
    if (role !== 'client') fs.writeFileSync(path.join(resources, rel), 'old-' + rel);
    return { path: rel, source: 'payload/' + rel, bytes: fs.statSync(source).size, sha256: sha(source), mode: 0o644, role };
  });
  s.m.payloads = [{ ...s.m.payloads[0], platform: `${process.platform}-${process.arch}`, kind: 'desktop-files', files, smokeReview: 'Isolated packaged smoke fixture confirms version and served client' }];
  const target = { ...s.t, platform: `${process.platform}-${process.arch}`, kind: 'desktop-files', baseDir: dir, python: process.execPath, clientModule: path.join(root, 'deploy/core.mjs'), origin: 'http://127.0.0.1:3773', desktopExecutable: path.join(dir, 'installed/T3 Code [Alpha].exe'), serverFile: path.join(resources, 'server.asar'), cliEntry: path.join(resources, 'server.asar/apps/server/dist/bin.mjs'), disks: [{ root: dir, class: 'other', reserveBytes: 0, growthBytes: 0 }], expectedFiles: { 'server.asar': digest('old-server.asar'), 'app.asar': digest('old-app.asar') } };
  fs.writeFileSync(target.desktopExecutable, 'fake executable');
  let listening = true, starts = 0, replacements = 0;
  const commands = [];
  const fakeRun = (exe, args) => {
    commands.push([exe, ...args]);
    if (args.includes('snapshot')) return JSON.stringify(blank());
    if (args.includes('start-desktop')) { assert.ok(!listening); for (const f of files.filter(f => f.role !== 'client')) assert.equal(sha(path.join(resources, f.path)), f.sha256); listening = true; starts++; return JSON.stringify({ started: true, pid: 123 }); }
    if (args.some(a => a.endsWith('windows-port.ps1'))) return JSON.stringify({ listening });
    if (args.some(a => a.endsWith('windows-close.ps1'))) { listening = false; return JSON.stringify({ closed: true, main: 1, backend: 2 }); }
    throw new Error('Unexpected command');
  };
  const adapter = makeNative(target, s.m, path.join(dir, 'release.json'), { run: fakeRun, replace(from, to) { if (++replacements === 2) throw new Error('power loss during replace'); fs.renameSync(from, to); } });
  adapter.capacity = async () => [];
  await adapter.stage(s.m.payloads[0]);
  await assert.rejects(adapter.activate(s.m, s.m.payloads[0]), /power loss/); assert.equal(starts, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'runtime/t3w-deploy', s.m.id, 'previous-desktop/resources/server.asar'), 'utf8'), 'old-server.asar');
  await adapter.resumeActivation(); assert.equal(starts, 1); await adapter.resumeActivation(); assert.equal(starts, 1);
  assert.equal(commands.filter(c => c.some(x => x.endsWith('windows-close.ps1'))).length, 1);
});
test('migration expectation mismatch blocks plan/apply before stop and must also match after restart', async () => {
  const s = scenario(); s.live.snapshot.database.migrationIds.push(2);
  await assert.rejects(preflight(s.m, s.t, s.adapter), e => e.code === 'migration');
  await execute(s.m, s.t, s.adapter, s.state, 'apply'); assert.equal(s.state.error.code, 'migration'); assert.ok(!s.calls.some(c => c[0] === 'activate'));
});
test('consistent SQLite backup survives retry and never overwrites later user history', async t => {
  const dir = fixture(t), db = path.join(dir, 'live.sqlite'), destination = path.join(dir, 'before.sqlite'), helper = path.join(root, 'deploy/host.py');
  const setup = `import sqlite3,sys,json\nd=sqlite3.connect(sys.argv[1]); d.executescript('CREATE TABLE effect_sql_migrations(migration_id INTEGER PRIMARY KEY,name TEXT); INSERT INTO effect_sql_migrations VALUES(1,"initial"); CREATE TABLE history(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO history VALUES(1,"retained");'); d.commit(); d.close()`;
  const made = spawnSync(python, ['-c', setup, db], { encoding: 'utf8', windowsHide: true }); assert.equal(made.status, 0, made.stderr);
  const invoke = (op, arg) => { const r = spawnSync(python, [helper, op, arg], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(r.stdout); };
  const before = invoke('database-info', db), req = path.join(dir, 'backup-request.json');
  save(req, { source: db, destination, migrationIds: before.migrationIds, schemaSha256: before.schemaSha256 });
  const proof = invoke('backup', req); assert.equal(proof.integrity, 'ok'); assert.equal(proof.automaticRestore, false); assert.equal(proof.sha256, sha(destination));
  assert.deepEqual(invoke('backup', req), proof);
  // Simulate forward migration and new user history in the source, not the backup.
  const changed = spawnSync(python, ['-c', 'import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.executescript("ALTER TABLE history ADD COLUMN owner TEXT; INSERT INTO effect_sql_migrations VALUES(2,\'hierarchy\'); INSERT INTO history(id,body) VALUES(2,\'new user work\');"); d.close()', db], { encoding: 'utf8', windowsHide: true }); assert.equal(changed.status, 0, changed.stderr);
  assert.deepEqual(invoke('database-info', db).migrationIds, [1, 2]); assert.deepEqual(invoke('database-info', destination).migrationIds, [1]);
  assert.deepEqual(invoke('backup', req), proof); assert.deepEqual(invoke('database-info', db).migrationIds, [1, 2]);
  fs.appendFileSync(destination, 'corrupt');
  const corrupt = spawnSync(python, [helper, 'backup', req], { encoding: 'utf8', windowsHide: true }); assert.equal(corrupt.status, 1); assert.deepEqual(invoke('database-info', db).migrationIds, [1, 2]);
});
test('SQLite backup reads committed WAL without checkpointing or modifying the live source', async t => {
  const dir = fixture(t), db = path.join(dir, 'wal.sqlite'), request = path.join(dir, 'request.json'), helper = path.join(root, 'deploy/host.py');
  const writer = spawn(python, ['-u', '-c', 'import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.execute("PRAGMA journal_mode=WAL"); d.executescript("CREATE TABLE effect_sql_migrations(migration_id INTEGER PRIMARY KEY); INSERT INTO effect_sql_migrations VALUES(1); CREATE TABLE history(body TEXT); INSERT INTO history VALUES(\'committed in WAL\');"); print("ready",flush=True); sys.stdin.readline(); d.close()', db], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const done = new Promise(resolve => writer.once('close', resolve));
  await new Promise((resolve, reject) => { writer.stdout.once('data', resolve); writer.once('error', reject); });
  try {
    assert.ok(fs.statSync(db + '-wal').size > 0); const oldMain = sha(db), oldWal = sha(db + '-wal');
    const info = JSON.parse(spawnSync(python, [helper, 'database-info', db], { encoding: 'utf8', windowsHide: true }).stdout);
    save(request, { source: db, destination: path.join(dir, 'copy.sqlite'), migrationIds: info.migrationIds, schemaSha256: info.schemaSha256 });
    const result = spawnSync(python, [helper, 'backup', request], { encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stdout + result.stderr);
    const copied = spawnSync(python, ['-c', 'import sqlite3,sys; d=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(d.execute("SELECT body FROM history").fetchone()[0]); d.close()', path.join(dir, 'copy.sqlite')], { encoding: 'utf8', windowsHide: true });
    assert.equal(copied.stdout.trim(), 'committed in WAL'); assert.equal(sha(db), oldMain); assert.equal(sha(db + '-wal'), oldWal);
  } finally { writer.stdin.end('\n'); assert.equal(await done, 0); }
});
test('hidden detached runner continues after its initiating launcher has exited', { skip: process.platform !== 'win32' }, async t => {
  const dir = fixture(t), entry = path.join(dir, 'independent.mjs'), request = path.join(dir, 'request.json');
  fs.writeFileSync(entry, `import fs from 'node:fs'; import path from 'node:path'; if(process.env.T3W_GUARD_GATE)fs.readFileSync(0); const dir=path.dirname(process.argv[3]); const watch=fs.watch(dir,()=>{if(fs.existsSync(path.join(dir,'finish'))){watch.close();fs.writeFileSync(path.join(dir,'done'),'done');process.exit(0);}});fs.writeFileSync(path.join(dir,'ready'),'ready');setTimeout(()=>process.exit(5),15000);`);
  save(request, { node: process.execPath, entry, target: { baseDir: dir } });
  const observed = name => new Promise((resolve, reject) => {
    let timer; const watcher = fs.watch(dir, () => { if (fs.existsSync(path.join(dir, name))) { clearTimeout(timer); watcher.close(); resolve(); } });
    timer = setTimeout(() => { watcher.close(); reject(new Error('Detached runner did not produce ' + name)); }, 10000);
    if (fs.existsSync(path.join(dir, name))) { clearTimeout(timer); watcher.close(); resolve(); }
  });
  const launched = spawnSync(python, [path.join(root, 'deploy/host.py'), 'launch', request], { encoding: 'utf8', windowsHide: true });
  assert.equal(launched.status, 0, launched.stdout + launched.stderr); assert.equal(JSON.parse(launched.stdout).mechanism, 'windows-breakaway');
  await observed('ready');
  // This signal is created only after the initiating Python has exited.
  const completed = observed('done'); fs.writeFileSync(path.join(dir, 'finish'), 'finish'); await completed;
  const runner = path.basename(request) + '.runner.json';
  await new Promise((resolve, reject) => {
    let timer; const watcher = fs.watch(dir, () => { if (JSON.parse(fs.readFileSync(path.join(dir, runner))).phase === 'finished') { clearTimeout(timer); watcher.close(); resolve(); } });
    timer = setTimeout(() => { watcher.close(); reject(new Error('Guard did not finish: ' + fs.readFileSync(path.join(dir, runner), 'utf8'))); }, 10000);
    if (JSON.parse(fs.readFileSync(path.join(dir, runner))).phase === 'finished') { clearTimeout(timer); watcher.close(); resolve(); }
  });
});
test('desktop native shutdown support is mandatory for each working session', async () => {
  const s = scenario(); s.t.kind = 'desktop-files'; s.t.platform = 'win32-x64'; s.live.kind = s.t.kind; s.live.platform = s.t.platform;
  const p = s.m.payloads[0]; p.kind = s.t.kind; p.platform = s.t.platform; p.smokeReview = 'Verified isolated packaged runtime';
  p.files[0].path = 'server.asar'; p.files.push({ ...p.files[0], path: 'app.asar', role: 'desktop' });
  s.live.snapshot.sessions[0].continueOnShutdown = false;
  await assert.rejects(preflight(s.m, s.t, s.adapter), /continueThreads/);
  s.live.snapshot.sessions[0].continueOnShutdown = true; await preflight(s.m, s.t, s.adapter);
});

// The opt-in must not affect the ordinary gate or later preservation acceptance.
test('dormant recovery requires native proof and rechecks after staging', async () => {
  const s = scenario(); s.live.snapshot.blockingOperations = ['move:678bac1d-7caf-45cc-a6fb-a69039215c46'];
  await assert.rejects(preflight(s.m, s.t, s.adapter), { code: 'unsupported' });
  s.m.dormantMoveRecovery = { source: 'review.json', sha256: 'a'.repeat(64) };
  await assert.rejects(preflight(s.m, s.t, s.adapter), { code: 'move-recovery' });
  let proofs = 0;
  s.adapter.verifyDormantMove = () => { if (++proofs > 1) throw new DeployError('move-recovery', 'Destination reservation appeared'); return {}; };
  await execute(s.m, s.t, s.adapter, s.state, 'apply');
  assert.equal(s.state.phase, 'preflight-failed'); assert.equal(proofs, 2);
  assert.equal(s.calls.some(c => c[0] === 'activate'), false);
});
