import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeNative, standardServiceUnit } from '../deploy/native.mjs';
import { digest, sha, save, preflight, execute } from '../deploy/core.mjs';

// Exact reviewed MyAcer bytes. Only the enclosing fixture path is substituted.
const network = '[Service]\nEnvironment="PATH=/home/slsecret/.local/bin:/usr/local/bin:/usr/bin:/bin"\nEnvironment="T3CODE_HOST=0.0.0.0"\nEnvironment="T3CODE_PORT=3773"\nEnvironment="T3CODE_NO_BROWSER=1"\n';
const networkHash = 'e917ac129e48ca8b29ca6ae6cdffa94a2b029faf91934a277a4497e1979fccdd';
function fixture(t, withNetwork = true) {
  const parent = path.resolve(process.env.T3W_TEST_TMP ?? os.tmpdir()), dir = fs.mkdtempSync(path.join(parent, 't3w-network-'));
  assert.ok(!/\s/.test(dir), 'Use T3W_TEST_TMP without whitespace for these systemd fixtures');
  t.after(() => { assert.equal(path.dirname(dir), parent); fs.rmSync(dir, { recursive: true, force: true }); });
  const baseDir = path.join(dir, 'state'), oldVersion = '0.0.45+custom.35', version = '0.0.45+custom.36';
  const unit = path.join(dir, '.config/systemd/user/t3code.service'), drop = path.join(unit + '.d', '10-acer-network.conf');
  const oldRuntime = path.join(baseDir, 'runtime/versions', oldVersion), payload = path.join(dir, 'payload');
  for (const directory of [oldRuntime, path.join(baseDir, 'userdata'), path.dirname(unit), payload]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(oldRuntime, 't3'), 'old'); save(path.join(baseDir, 'runtime/service-state.json'), { protocol: 3, activeVersion: oldVersion });
  fs.writeFileSync(unit, standardServiceUnit(baseDir, oldVersion));
  if (withNetwork) { fs.mkdirSync(path.dirname(drop)); fs.writeFileSync(drop, network); assert.equal(sha(drop), networkHash); }
  const files = [['t3', 'server', 'new'], ['client/index.html', 'client', '<script src="/assets/main.js"></script>'], ['client/assets/main.js', 'client', 'ready']].map(([rel, role, body]) => {
    const full = path.join(payload, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, body);
    return { path: rel, source: 'payload/' + rel, role, bytes: Buffer.byteLength(body), sha256: sha(full), mode: rel === 't3' ? 0o755 : 0o644 };
  });
  const database = { migrationIds: [1], schemaSha256: digest('schema'), logicalBytes: 4096 };
  const snapshot = { database, projects: [], profiles: [], bindings: [], history: [], historyContent: [], ownership: [], jobs: [], routes: [], sessions: [] };
  const manifest = { schema: 1, id: 'network-release', commit: 'a'.repeat(40), version, compatibility: { fromVersions: [oldVersion], migrations: 'none', rollback: 'never', continuation: 'native-v1', review: 'Reviewed code-only service configuration fixture', database: { fromMigrations: [1], toMigrations: [1], fromSchemaSha256: database.schemaSha256, toSchemaSha256: database.schemaSha256, maxExtraBytes: 0 } }, minimumCapabilities: [], requiredCapabilities: [], payloads: [{ platform: 'linux-x64', kind: 'boot-service', commit: 'a'.repeat(40), version, clientVersion: version, files }] };
  const target = { kind: 'boot-service', platform: 'linux-x64', service: 't3code.service', baseDir, python: process.execPath, origin: 'http://127.0.0.1:3773', environmentId: 'fixture', expectedVersion: oldVersion, expectedServerSha256: digest('old'), expectedClientSha256: digest('old-index'), disks: [{ root: dir, class: 'other', reserveBytes: 0, growthBytes: 0 }], ...(withNetwork ? { serviceDropIns: [{ path: drop, sha256: networkHash }] } : {}) };
  const control = { stops: 0, installs: 0, running: true, current: oldVersion, overrides: {}, loadedPaths: null };
  function effective() {
    const server = path.join(baseDir, 'runtime/versions', control.current, 't3');
    return { NeedDaemonReload: 'no', Type: 'simple', Restart: 'always', WorkingDirectory: dir, KillMode: 'mixed', KillSignal: '15', RestartKillSignal: '15', FinalKillSignal: '9', SendSIGKILL: 'yes', OOMPolicy: 'continue',
      Environment: `T3CODE_HOME=${baseDir} T3_BOOT_SERVICE_UNIT=t3code.service PATH=/home/slsecret/.local/bin:/usr/local/bin:/usr/bin:/bin T3CODE_HOST=0.0.0.0 T3CODE_PORT=3773 T3CODE_NO_BROWSER=1`,
      ExecStart: `{ path=${server} ; argv[]=${server} __service-launcher ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`, ...control.overrides };
  }
  function run(executable, args) {
    if (args.includes('snapshot')) return JSON.stringify(snapshot);
    if (executable === 'systemctl') {
      if (args.includes('--all')) return Object.entries(effective()).map(([key, value]) => key + '=' + value).join('\n') + '\n';
      if (args.includes('FragmentPath')) return unit;
      if (args.includes('DropInPaths')) return control.loadedPaths ?? (fs.existsSync(unit + '.d') ? fs.readdirSync(unit + '.d').filter(x => x.endsWith('.conf')).map(x => path.join(unit + '.d', x)).join(' ') : '');
      if (args.includes('show-environment')) return '';
      if (args.includes('MainPID')) return control.running ? '123' : '0';
      if (args.includes('stop')) { control.stops++; control.running = false; return ''; }
    }
    if (executable === 'findmnt') return JSON.stringify({ filesystems: [{ source: '/dev/fixture', fstype: 'ext4' }] });
    if (executable === 'lsblk') return JSON.stringify({ blockdevices: [{ name: '/dev/fixture', model: 'fixture', tran: 'nvme' }] });
    if (args[0] === '__service-preflight') return JSON.stringify({ status: 'ready', version, launcherProtocol: 3 });
    if (args[0] === 'service') {
      assert.deepEqual(args, ['service', 'install', '--base-dir', baseDir, '--allow-downgrade']); assert.equal(control.running, false);
      control.installs++; control.current = version; control.running = true;
      // Supported installer replaces the main unit, not the .d directory.
      fs.writeFileSync(unit, standardServiceUnit(baseDir, version)); save(path.join(baseDir, 'runtime/service-state.json'), { protocol: 3, activeVersion: version }); return '';
    }
    throw new Error('Unexpected fixture host command');
  }
  const adapter = makeNative(target, manifest, path.join(dir, 'release.json'), { run, platform: 'linux', arch: 'x64', homeDir: dir });
  adapter.inspect = async () => ({ environmentId: target.environmentId, version: control.current, capabilities: {}, kind: target.kind, platform: target.platform, portOwnerVerified: control.running, clientSha256: control.current === oldVersion ? target.expectedClientSha256 : files[1].sha256, installSha256: sha(path.join(baseDir, 'runtime/versions', control.current, 't3')), snapshot });
  adapter.verify = async () => { try { await preflight(manifest, target, adapter, { staged: true, after: true }); return { ok: true }; } catch (e) { return { ok: false, code: e.code }; } };
  return { dir, unit, drop, baseDir, target, manifest, control, adapter, state: {} };
}

test('exact MyAcer network/PATH drop-in survives stage/install/resume with pinned receipt', async t => {
  const f = fixture(t); const before = fs.statSync(f.drop);
  await preflight(f.manifest, f.target, f.adapter);
  await execute(f.manifest, f.target, f.adapter, f.state, 'apply'); assert.equal(f.state.phase, 'accepted', JSON.stringify(f.state));
  await execute(f.manifest, f.target, f.adapter, f.state, 'resume'); assert.equal(f.control.stops, 1); assert.equal(f.control.installs, 1);
  assert.equal(fs.readFileSync(f.drop, 'utf8'), network); assert.equal(fs.statSync(f.drop).mtimeMs, before.mtimeMs); assert.equal(fs.statSync(f.drop).mode, before.mode);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.baseDir, 'runtime/t3w-deploy', f.manifest.id, 'previous-service-unit.json')));
  assert.deepEqual(receipt.dropIns, [{ path: f.drop, sha256: networkHash, bytes: Buffer.byteLength(network), contents: network }]);
  assert.ok(receipt.effectiveEnvironment.includes('T3CODE_HOST=0.0.0.0'));
});
test('existing empty-drop-in installation still deploys', async t => { const f = fixture(t, false); await execute(f.manifest, f.target, f.adapter, f.state, 'apply'); assert.equal(f.state.phase, 'accepted'); });

const cases = {
  changed: f => fs.appendFileSync(f.drop, '# drift\n'),
  missing: f => fs.unlinkSync(f.drop),
  extra: f => fs.writeFileSync(path.join(path.dirname(f.drop), '20-extra.conf'), '[Service]\n'),
  'extra not yet loaded': f => { f.control.loadedPaths = f.drop; fs.writeFileSync(path.join(path.dirname(f.drop), '20-extra.conf'), '[Service]\n'); },
  'unreviewed existing file': f => { delete f.target.serviceDropIns; },
  'stale effective environment': f => { f.control.overrides.Environment = 'T3CODE_HOME=/wrong'; },
  'stale daemon cache': f => { f.control.overrides.NeedDaemonReload = 'yes'; },
  'effective extra launcher argument': f => { f.control.overrides.ExecStart = '{ path=/other ; argv[]=/other __service-launcher --port 9999 ; ignore_errors=no ; pid=0 }'; },
  'effective environment file': f => { f.control.overrides.EnvironmentFiles = '/private/settings (ignore_errors=no)'; },
  'effective kill policy': f => { f.control.overrides.KillMode = 'control-group'; },
  'effective extra stop command': f => { f.control.overrides.ExecStop = '/other'; },
};
for (const [name, change] of Object.entries(cases)) test(`drop-in preflight rejects ${name} before stop`, async t => {
  const f = fixture(t); change(f); await assert.rejects(preflight(f.manifest, f.target, f.adapter));
  await execute(f.manifest, f.target, f.adapter, f.state, 'apply'); assert.equal(f.state.phase, 'preflight-failed'); assert.equal(f.control.stops, 0); assert.equal(f.control.installs, 0);
});
for (const line of ['ExecStart=/other', 'EnvironmentFile=/private/settings', 'Environment="T3CODE_HOME=/other"', 'KillMode=control-group', 'Environment="T3CODE_PORT=9999"', 'Environment="PATH=:/bin"', 'Environment="T3CODE_HOST=%H"']) test(`even a pinned hash cannot authorize unsupported drop-in directive: ${line.split('=')[0]}`, async t => {
  const f = fixture(t); fs.writeFileSync(f.drop, '[Service]\n' + line + '\n'); f.target.serviceDropIns[0].sha256 = sha(f.drop);
  await execute(f.manifest, f.target, f.adapter, f.state, 'apply'); assert.equal(f.state.phase, 'preflight-failed'); assert.equal(f.control.stops, 0);
});
test('drift between last preflight and stop is rejected by activation itself', async t => {
  const f = fixture(t); const activate = f.adapter.activate;
  f.adapter.activate = async (...args) => { fs.appendFileSync(f.drop, '# drift\n'); return activate(...args); };
  await execute(f.manifest, f.target, f.adapter, f.state, 'apply'); assert.equal(f.state.phase, 'recovery-required'); assert.equal(f.control.stops, 0); assert.equal(f.control.installs, 0);
});
test('closed-phase drift after capacity/backup preparation blocks install and resume until exact bytes return', async t => {
  const f = fixture(t); const capacity = f.adapter.capacity; let injected = false;
  f.adapter.capacity = async (...args) => { const result = await capacity(...args); if (args[3] && !injected) { injected = true; fs.appendFileSync(f.drop, '# late drift\n'); } return result; };
  await execute(f.manifest, f.target, f.adapter, f.state, 'apply'); assert.equal(f.state.phase, 'recovery-required'); assert.equal(f.control.stops, 1); assert.equal(f.control.installs, 0);
  await execute(f.manifest, f.target, f.adapter, f.state, 'resume'); assert.equal(f.state.phase, 'recovery-required'); assert.equal(f.control.installs, 0);
  fs.writeFileSync(f.drop, network); await execute(f.manifest, f.target, f.adapter, f.state, 'resume'); assert.equal(f.state.phase, 'accepted', JSON.stringify(f.state)); assert.equal(f.control.stops, 1); assert.equal(f.control.installs, 1);
});
