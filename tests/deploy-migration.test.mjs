import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest, sha, save, execute, preflight } from '../deploy/core.mjs';
import { makeNative, standardServiceUnit } from '../deploy/native.mjs';

const helper = fileURLToPath(new URL('../deploy/host.py', import.meta.url));
const python = process.env.T3W_TEST_PYTHON ?? 'python3';
const sql = (database, statement) => {
  const result = spawnSync(python, ['-c', 'import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.executescript(sys.argv[2]); d.close()', database, statement], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
};
const helperCall = (operation, arg) => {
  const result = spawnSync(python, [helper, operation, arg], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(result.stdout);
};

for (const kind of ['desktop-files', 'boot-service']) for (const continuationFails of [false, true]) test(`isolated ${kind} forward migration with ${continuationFails ? 'failed' : 'verified'} native continuation retains old backup and new history`, async t => {
  const dir = fs.mkdtempSync(path.join(process.env.T3W_TEST_TMP ?? os.tmpdir(), 't3w migration [fixture] '));
  const base = path.join(dir, 'state'), install = path.join(dir, 'installed'), resources = path.join(install, 'resources'), payload = path.join(dir, 'payload');
  for (const p of [path.join(base, 'userdata'), resources, payload]) fs.mkdirSync(p, { recursive: true });
  const database = path.join(base, 'userdata/state.sqlite');
  const initial = 'CREATE TABLE effect_sql_migrations(migration_id INTEGER PRIMARY KEY,name TEXT); INSERT INTO effect_sql_migrations VALUES(1,"initial"); CREATE TABLE history(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO history VALUES(1,"old history");';
  const migration = 'ALTER TABLE history ADD COLUMN owner TEXT; INSERT INTO effect_sql_migrations VALUES(2,"hierarchy"); INSERT INTO history(id,body) VALUES(2,"new user history");';
  sql(database, initial);
  const reference = path.join(dir, 'rehearsal.sqlite'); sql(reference, initial + migration);
  const beforeDatabase = helperCall('database-info', database), afterDatabase = helperCall('database-info', reference);
  const version = '0.0.45+custom.42', oldVersion = '0.0.45+custom.41', commit = 'd'.repeat(40);
  const platform = kind === 'boot-service' ? 'linux' : 'win32', platformKey = `${platform}-x64`;
  const runtime = path.join(base, 'runtime/versions', oldVersion); fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 't3'), 'old-server'); save(path.join(base, 'runtime/service-state.json'), { protocol: 3, activeVersion: oldVersion });
  const unit = path.join(dir, '.config/systemd/user/t3code.service');
  fs.mkdirSync(path.dirname(unit), { recursive: true }); fs.writeFileSync(unit, standardServiceUnit(base, oldVersion));
  const html = '<html><script type="module" src="/assets/main.js"></script></html>', javascript = 'globalThis.__fixture = true;';
  const artifacts = [...(kind === 'boot-service' ? [['t3', 'server', 'new-server']] : [['server.asar', 'server', 'new-server'], ['app.asar', 'desktop', 'new-app']]), ['client/index.html', 'client', html], ['client/assets/main.js', 'client', javascript]];
  const files = artifacts.map(([rel, role, bytes]) => {
    const file = path.join(payload, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    return { path: rel, source: 'payload/' + rel, role, mode: rel === 't3' ? 0o755 : 0o644, bytes: Buffer.byteLength(bytes), sha256: sha(file) };
  });
  fs.writeFileSync(path.join(resources, 'server.asar'), 'old-server'); fs.writeFileSync(path.join(resources, 'app.asar'), 'old-app');
  fs.writeFileSync(path.join(install, 'T3 Code [fixture].exe'), 'fixture-only-not-executable');
  const rehearsal = { commit, version, platforms: [platformKey], before: beforeDatabase, after: afterDatabase, integrity: 'ok', preservation: 'passed', maxSourceBytes: 1024 * 1024, maxExtraBytes: 1024 * 1024 };
  save(path.join(dir, 'rehearsal.json'), rehearsal);
  const m = { schema: 1, id: 'forward-42', commit, version,
    compatibility: { fromVersions: [oldVersion], migrations: 'forward-only', rollback: 'never', continuation: 'native-v1', review: 'Reviewed fixture forward-only migration; restart same pinned new binary on current database', database: { fromMigrations: beforeDatabase.migrationIds, toMigrations: afterDatabase.migrationIds, fromSchemaSha256: beforeDatabase.schemaSha256, toSchemaSha256: afterDatabase.schemaSha256, maxSourceBytes: rehearsal.maxSourceBytes, maxExtraBytes: rehearsal.maxExtraBytes, rehearsal: { source: 'rehearsal.json', sha256: sha(path.join(dir, 'rehearsal.json')) }, recovery: 'Restart the exact new code against the current database. Retain the pre-migration backup; never replace new user history.' } },
    minimumCapabilities: ['serverUpdateThreadContinuation'], requiredCapabilities: ['serverUpdateThreadContinuation', 'nativeSessionMoves'],
    payloads: [{ platform: platformKey, kind, commit, version, clientVersion: version, smokeReview: 'Fixture packaged server and hosted client are exercised through isolated HTTP', files }] };
  let activated = false, closed = false, starts = 0, stops = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/.well-known/t3/environment') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ environmentId: 'fixture-environment', serverVersion: activated ? version : oldVersion, capabilities: { serverUpdateThreadContinuation: true, nativeSessionMoves: true, serverSelfUpdate: kind === 'boot-service' ? 'boot-service' : 'desktop-managed' } })); }
    else if (req.url === '/assets/main.js') res.end(javascript);
    else res.end(activated ? html : 'old-index');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(dir), path.resolve(process.env.T3W_TEST_TMP ?? os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const target = { kind, platform: platformKey, service: 't3code.service', baseDir: base, python: process.execPath, origin: `http://127.0.0.1:${server.address().port}`, environmentId: 'fixture-environment', expectedVersion: oldVersion, expectedServerSha256: digest('old-server'), expectedClientSha256: digest('old-index'), desktopExecutable: path.join(install, 'T3 Code [fixture].exe'), serverFile: path.join(resources, 'server.asar'), expectedFiles: { 'server.asar': digest('old-server'), 'app.asar': digest('old-app') }, disks: [{ root: dir, class: 'other', reserveBytes: 8192, growthBytes: 4096 }], verifySeconds: 1 };
  const snapshot = () => ({ database: helperCall('database-info', database), projects: [['project', 'workspace-hash']], profiles: [['session', 'profile-hash']], history: [['message', 'history-hash']], ownership: [['worker', 'master-hash']], jobs: [['queue', 'queued-work-hash']], routes: [], sessions: [{ id: 'session', status: activated && continuationFails ? 'error' : 'running', bindingStatus: 'running', activeTurnId: activated ? 'new-turn' : 'old-turn', lastTurnId: activated ? 'new-turn' : 'old-turn', provider: 'codex', instance: 'AD', nativeId: 'same-native-id-hash', profile: 'astra-high', continueOnShutdown: true, lastError: activated && continuationFails }] });
  const fakeRun = (exe, args) => {
    if (args.includes('snapshot')) return JSON.stringify(snapshot());
    if (args.includes('backup')) return JSON.stringify(helperCall('backup', args.at(-1)));
    if (exe === 'systemctl') {
      assert.equal(args[0], '--user');
      if (args.includes('FragmentPath')) return unit;
      if (args.includes('DropInPaths')) return '';
      if (args.includes('stop')) { assert.equal(args.at(-1), 't3code.service'); stops++; closed = true; return ''; }
      if (args.includes('show')) return closed ? '0\n' : '99\n';
      if (args.includes('show-environment')) return '';
    }
    if (exe === 'findmnt') return JSON.stringify({ filesystems: [{ source: '/dev/fixture', fstype: 'ext4' }] });
    if (exe === 'lsblk') return JSON.stringify({ blockdevices: [{ name: '/dev/fixture', model: 'fixture', tran: 'nvme' }] });
    if (args[0] === '__service-preflight') return JSON.stringify({ status: 'ready', version, launcherProtocol: 3 });
    if (args[0] === 'service') {
      assert.deepEqual(args, ['service', 'install', '--base-dir', base, '--allow-downgrade']); assert.equal(exe, path.join(base, 'runtime/versions', version, 't3')); assert.ok(closed);
      starts++; sql(database, migration); activated = true; closed = false; save(path.join(base, 'runtime/service-state.json'), { protocol: 3, activeVersion: version }); fs.writeFileSync(unit, standardServiceUnit(base, version)); return '';
    }
    if (args.includes('start-desktop')) { assert.ok(closed); starts++; sql(database, migration); activated = true; closed = false; return JSON.stringify({ started: true, pid: 123 }); }
    if (args.some(a => a.endsWith('windows-close.ps1'))) { stops++; closed = true; return JSON.stringify({ closed: true, main: 10, backend: 11 }); }
    if (args.some(a => a.endsWith('windows-port.ps1'))) return JSON.stringify({ listening: !closed });
    if (args.some(a => a.endsWith('windows-inspect.ps1'))) {
      const request = JSON.parse(fs.readFileSync(args.at(-1)));
      return JSON.stringify({ portOwnerVerified: !closed, disks: request.paths.map(p => ({ path: p, device: 'fixture-fixed-volume', freeBytes: 1024 ** 3, blockBytes: 4096, type: 'fixed', model: 'fixture' })) });
    }
    throw new Error('Unexpected host command in fixture');
  };
  const adapter = makeNative(target, m, path.join(dir, 'release.json'), { run: fakeRun, platform, arch: 'x64', linuxOwner: () => !closed, homeDir: dir });
  const plan = await preflight(m, target, adapter);
  assert.ok(plan.disk[0].extraBytes >= beforeDatabase.logicalBytes + rehearsal.maxExtraBytes);
  if (kind === 'boot-service') {
    fs.appendFileSync(unit, '\nEnvironment=NETWORK_OVERRIDE=1\n');
    await assert.rejects(preflight(m, target, adapter), /Customized service unit/); assert.equal(stops, 0);
    fs.writeFileSync(unit, standardServiceUnit(base, oldVersion));
  }
  // Incorrect evidence must fail before either graceful close or resource mutation.
  const evidencePath = path.join(dir, 'rehearsal.json'), evidenceBytes = fs.readFileSync(evidencePath);
  fs.appendFileSync(evidencePath, ' '); await assert.rejects(preflight(m, target, adapter), /rehearsal/); assert.equal(stops, 0); fs.writeFileSync(evidencePath, evidenceBytes);
  const state = {}; await execute(m, target, adapter, state, 'apply');
  assert.equal(state.phase, continuationFails ? 'recovery-required' : 'accepted', JSON.stringify(state.proof ?? state.error));
  const backup = path.join(base, 'runtime/t3w-deploy', m.id, 'before-migrations.sqlite');
  assert.deepEqual(helperCall('database-info', backup).migrationIds, [1]); assert.deepEqual(helperCall('database-info', database).migrationIds, [1, 2]);
  const currentBytes = sha(database); await execute(m, target, adapter, state, 'resume');
  assert.equal(sha(database), currentBytes); assert.equal(stops, 1); assert.equal(starts, 1);
});
