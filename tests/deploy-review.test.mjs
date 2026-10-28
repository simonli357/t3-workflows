import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest, sha, save, preservation, preflight, execute } from '../deploy/core.mjs';
import { makeNative, standardServiceUnit } from '../deploy/native.mjs';

const python = process.env.T3W_TEST_PYTHON ?? 'python3';
const helper = fileURLToPath(new URL('../deploy/host.py', import.meta.url));
function sql(database, statement) {
  const r = spawnSync(python, ['-c', 'import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.executescript(sys.argv[2]); d.close()', database, statement], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
}
function call(op, arg) {
  const r = spawnSync(python, [helper, op, arg], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(r.stdout);
}
function snapshots(database, statements) {
  const code = `import importlib.util,json,sqlite3,sys
spec=importlib.util.spec_from_file_location('deploy_host',sys.argv[1]); host=importlib.util.module_from_spec(spec); spec.loader.exec_module(host)
result=[]
for statement in json.load(sys.stdin):
    with sqlite3.connect(sys.argv[2]) as db: db.executescript(statement)
    result.append(host.snapshot(sys.argv[2]))
print(json.dumps(result))`;
  const r = spawnSync(python, ['-B', '-c', code, helper, database], { input: JSON.stringify(statements), encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
}
const schema = `
CREATE TABLE effect_sql_migrations(migration_id INTEGER PRIMARY KEY,name TEXT);
INSERT INTO effect_sql_migrations VALUES(1,'initial');
CREATE TABLE projection_projects(project_id TEXT,workspace_root TEXT);
CREATE TABLE projection_threads(thread_id TEXT,project_id TEXT,model_selection_json TEXT,runtime_mode TEXT,interaction_mode TEXT,branch TEXT,worktree_path TEXT,archived_at TEXT,deleted_at TEXT,snoozed_until TEXT,settled_at TEXT);
CREATE TABLE projection_thread_sessions(thread_id TEXT,status TEXT,active_turn_id TEXT,last_error TEXT);
CREATE TABLE provider_session_runtime(thread_id TEXT,provider_name TEXT,provider_instance_id TEXT,status TEXT,runtime_mode TEXT,resume_cursor_json TEXT,runtime_payload_json TEXT);
CREATE TABLE projection_turns(row_id INTEGER PRIMARY KEY,thread_id TEXT,turn_id TEXT,state TEXT,completed_at TEXT);
CREATE TABLE projection_thread_messages(message_id TEXT,thread_id TEXT,turn_id TEXT,created_at TEXT,role TEXT,text TEXT,attachments_json TEXT,context_json TEXT,is_streaming INTEGER);
CREATE TABLE custom_workers(thread_id TEXT,owner_id TEXT,source_id TEXT,plan_json TEXT,state TEXT);
CREATE TABLE custom_worker_jobs(id TEXT,worker_id TEXT,target_id TEXT,kind TEXT,prompt TEXT,created_at TEXT,state TEXT);
CREATE TABLE custom_orchestrator_authority(thread_id TEXT PRIMARY KEY,active INTEGER,successor_id TEXT,retired_sequence INTEGER,revision INTEGER);
CREATE TABLE custom_session_moves(id TEXT PRIMARY KEY,thread_id TEXT,target_thread_id TEXT,direction TEXT,peer_environment_id TEXT,state TEXT,locked INTEGER,input_json TEXT,manifest_json TEXT,error TEXT,created_at TEXT,updated_at TEXT);
CREATE TABLE custom_session_move_job_aliases(incoming_id TEXT PRIMARY KEY,job_id TEXT,thread_id TEXT);
CREATE TABLE custom_orchestrator_handoffs(thread_id TEXT PRIMARY KEY,owner_id TEXT,plan_json TEXT,state TEXT,error TEXT,transferred_json TEXT,ownership_started INTEGER);
CREATE TABLE custom_session_ownership_changes(id TEXT PRIMARY KEY,request_json TEXT,result_json TEXT,announced INTEGER);
CREATE TABLE custom_ownership_transactions(id TEXT PRIMARY KEY,request_json TEXT,state TEXT,participants_json TEXT,patch_json TEXT,result_json TEXT,error TEXT);
CREATE TABLE custom_ownership_reservation(singleton INTEGER PRIMARY KEY,id TEXT,coordinator TEXT);
CREATE TABLE custom_worker_reclaims(id TEXT PRIMARY KEY,owner_id TEXT,request_json TEXT,user_message_id TEXT,result_json TEXT);
CREATE TABLE padding(value BLOB);
`;
function temporary(t) {
  const parent = path.resolve(process.env.T3W_TEST_TMP ?? os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, 't3w review [fixture] '));
  t.after(() => { assert.equal(path.dirname(dir), parent); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const move = (id, direction, state, locked) => `INSERT INTO custom_session_moves VALUES('${id}','${id}','target','${direction}','peer','${state}',${locked},'{}','{}',NULL,'created','updated');`;

// Actual Python snapshots; no fabricated binding/route preservation observations.
for (const [provider, cursor] of [['codex', { threadId: 'native' }], ['claude', { resume: 'native', cwd: '/work', sessionId: 'native' }], ['cursor', { sessionId: 'native' }], ['opencode', { schemaVersion: 1, sessionId: 'native' }], ['grok', { schemaVersion: 1, sessionId: 'native' }], ['antigravity', { schemaVersion: 1, sessionId: 'native' }]]) {
  test(`real SQLite preserves inactive ${provider} binding, account, profile, cursor and workspace without starting`, t => {
    const database = path.join(temporary(t), 'state.sqlite');
    const payload = { cwd: '/workspace', model: 'pinned-model', modelSelection: { instanceId: 'account', model: 'pinned-model', options: [{ id: 'reasoningEffort', value: 'high' }] } };
    const binding = `INSERT INTO provider_session_runtime VALUES('idle','${provider}','account','stopped','full-access','${JSON.stringify(cursor)}','${JSON.stringify(payload)}');`;
    sql(database, schema + `INSERT INTO projection_projects VALUES('p','/workspace'); INSERT INTO projection_threads VALUES('idle','p','{}','full-access','default',NULL,'/workspace',NULL,NULL,NULL,NULL); INSERT INTO projection_thread_sessions VALUES('idle','stopped',NULL,NULL); INSERT INTO projection_turns VALUES(1,'idle','turn','completed','done');` + binding);
    for (const lifecycle of ['stopped', 'settled_at', 'snoozed_until', 'archived_at']) {
      const changes = [
        'DELETE FROM provider_session_runtime;',
        "UPDATE provider_session_runtime SET provider_name='different';",
        "UPDATE provider_session_runtime SET provider_instance_id='different';",
        "UPDATE provider_session_runtime SET runtime_mode='different';",
        "UPDATE provider_session_runtime SET resume_cursor_json='{}';",
        ...['cwd', 'model', 'modelSelection'].map(key => `UPDATE provider_session_runtime SET runtime_payload_json='${JSON.stringify({ ...payload, [key]: 'changed' })}';`),
      ];
      const reset = 'DELETE FROM provider_session_runtime;' + binding;
      const [before, unchanged, ...changed] = snapshots(database, [
        `UPDATE projection_threads SET settled_at=NULL,snoozed_until=NULL,archived_at=NULL; ${lifecycle === 'stopped' ? '' : `UPDATE projection_threads SET ${lifecycle}='saved';`}` + reset,
        '', ...changes.map(change => reset + change),
      ]);
      assert.equal(preservation(before, unchanged).ok, true);
      changed.forEach((after, i) => assert.ok(preservation(before, after).failures.includes('bindings:idle'), lifecycle + ': ' + changes[i]));
      // Shutdown progress/status changes must not masquerade as native identity loss.
      const [progress] = snapshots(database, [reset + `UPDATE provider_session_runtime SET status='running',runtime_payload_json='${JSON.stringify({ ...payload, activeTurnId: null, lastRuntimeEventAt: 'later', continueAfterServerUpdate: null })}';`]);
      assert.equal(preservation(before, progress).ok, true);
    }
  });
}

test('actual move and authority/ownership route deletion or change fails; understood progress can advance', t => {
  const database = path.join(temporary(t), 'state.sqlite'); sql(database, schema);
  const records = [
    ['custom_session_moves', move('move', 'in', 'complete', 0), "peer_environment_id='other'", "updated_at='later',error='diagnostic'"],
    ['custom_orchestrator_authority', "INSERT INTO custom_orchestrator_authority VALUES('master',0,'successor',100,2);", "active=1,successor_id=NULL,revision=0", null],
    ['custom_session_move_job_aliases', "INSERT INTO custom_session_move_job_aliases VALUES('alias','job','worker');", "job_id='other'", null],
    ['custom_orchestrator_handoffs', "INSERT INTO custom_orchestrator_handoffs VALUES('successor','master','{}','completed',NULL,'[\"worker\"]',1);", "owner_id='other'", "error='diagnostic'"],
    ['custom_session_ownership_changes', "INSERT INTO custom_session_ownership_changes VALUES('change','{}','{\"owner\":\"master\"}',0);", "result_json='{}'", 'announced=1'],
    ['custom_ownership_transactions', "INSERT INTO custom_ownership_transactions VALUES('transaction','{}','complete','[]','{}','{}',NULL);", "patch_json='{\"owner\":\"other\"}'", "error='diagnostic'"],
    ['custom_worker_reclaims', "INSERT INTO custom_worker_reclaims VALUES('reclaim','master','{}','message','{}');", "owner_id='other'", null],
  ];
  for (const [table, insert, mutation, progress] of records) {
    sql(database, insert); const before = call('snapshot', database);
    sql(database, `DELETE FROM ${table};`); assert.equal(preservation(before, call('snapshot', database)).ok, false, table + ' deletion');
    sql(database, insert + `UPDATE ${table} SET ${mutation};`); assert.equal(preservation(before, call('snapshot', database)).ok, false, table + ' mutation');
    sql(database, `DELETE FROM ${table};` + insert);
    if (progress) { sql(database, `UPDATE ${table} SET ${progress};`); assert.equal(preservation(before, call('snapshot', database)).ok, true, table + ' progress'); }
    sql(database, `DELETE FROM ${table};`);
  }
  const [remote, local] = snapshots(database, ["INSERT INTO custom_workers VALUES('worker','owner','source','{}','remote');", "UPDATE custom_workers SET state='ready';"]);
  assert.ok(preservation(remote, local).failures.includes('ownership:worker'));
  const [progress] = snapshots(database, ["UPDATE custom_workers SET state='running';"]);
  assert.equal(preservation(local, progress).ok, true);
});

async function installation(t, kind) {
  const dir = temporary(t), base = path.join(dir, 'base'), install = path.join(dir, 'installed'), resources = path.join(install, 'resources'), payload = path.join(dir, 'payload');
  for (const p of [path.join(base, 'userdata'), resources, payload]) fs.mkdirSync(p, { recursive: true });
  const database = path.join(base, 'userdata/state.sqlite'), reference = path.join(dir, 'reference.sqlite');
  const migration = "ALTER TABLE padding ADD COLUMN extra TEXT; INSERT INTO effect_sql_migrations VALUES(2,'forward');";
  sql(database, schema); sql(reference, schema + migration);
  const before = call('database-info', database), after = call('database-info', reference);
  const version = '0.0.45+custom.42', oldVersion = '0.0.45+custom.41', commit = 'd'.repeat(40), platform = kind === 'boot-service' ? 'linux' : 'win32';
  const runtime = path.join(base, 'runtime/versions', oldVersion); fs.mkdirSync(runtime, { recursive: true }); fs.writeFileSync(path.join(runtime, 't3'), 'old-server'); save(path.join(base, 'runtime/service-state.json'), { protocol: 3, activeVersion: oldVersion });
  const unit = path.join(dir, '.config/systemd/user/t3code.service'); fs.mkdirSync(path.dirname(unit), { recursive: true }); fs.writeFileSync(unit, standardServiceUnit(base, oldVersion));
  const client = { 'index.html': '<script type="module" src="/assets/bootstrap.js"></script>', 'assets/bootstrap.js': "void import('./main.js');", 'assets/main.js': "import('./lazy.js');", 'assets/lazy.js': 'export const ready = true;', 'assets/lazy.css': 'body{color:black}', 'assets/font.woff2': 'font-bytes' };
  const files = [...(kind === 'boot-service' ? [['t3', 'server', 'new-server']] : [['server.asar', 'server', 'new-server'], ['app.asar', 'desktop', 'new-app']]), ...Object.entries(client).map(([rel, body]) => ['client/' + rel, 'client', body])].map(([rel, role, body]) => {
    const file = path.join(payload, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
    return { path: rel, source: 'payload/' + rel, role, mode: rel === 't3' ? 0o755 : 0o644, bytes: Buffer.byteLength(body), sha256: sha(file) };
  });
  fs.writeFileSync(path.join(resources, 'server.asar'), 'old-server'); fs.writeFileSync(path.join(resources, 'app.asar'), 'old-app'); fs.writeFileSync(path.join(install, 'fixture.exe'), 'not-executable');
  const rehearsal = { commit, version, platforms: [platform + '-x64'], before, after, integrity: 'ok', preservation: 'passed', maxSourceBytes: before.logicalBytes, maxExtraBytes: 1024 * 1024 };
  save(path.join(dir, 'rehearsal.json'), rehearsal);
  const m = { schema: 1, id: 'review-release', version, commit, minimumCapabilities: [], requiredCapabilities: [], compatibility: { fromVersions: [oldVersion], migrations: 'forward-only', rollback: 'never', continuation: 'native-v1', review: 'Reviewed fixture-only forward migration', database: { fromMigrations: [1], toMigrations: [1, 2], fromSchemaSha256: before.schemaSha256, toSchemaSha256: after.schemaSha256, maxExtraBytes: rehearsal.maxExtraBytes, maxSourceBytes: rehearsal.maxSourceBytes, rehearsal: { source: 'rehearsal.json', sha256: sha(path.join(dir, 'rehearsal.json')) }, recovery: 'Restart exact new code against current database; no restore.' } }, payloads: [{ platform: platform + '-x64', kind, version, commit, clientVersion: version, smokeReview: 'Fixture-only packaged client verification', files }] };
  const control = { activated: false, closed: false, starts: 0, stops: 0, backups: 0, growAtClose: false, brokenAsset: null, wrongBytes: false, requests: [] };
  const server = http.createServer((req, res) => {
    control.requests.push(req.url);
    if (req.url === '/.well-known/t3/environment') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ environmentId: 'fixture', serverVersion: control.activated ? version : oldVersion, capabilities: { serverUpdateThreadContinuation: true, serverSelfUpdate: kind === 'boot-service' ? 'boot-service' : 'desktop-managed' } })); }
    if (req.url === '/') return res.end(control.activated ? client['index.html'] : 'old-index');
    if (req.url === control.brokenAsset) { res.statusCode = control.wrongBytes ? 200 : 404; return res.end('incorrect'); }
    const body = client[req.url.slice(1)]; if (body === undefined) res.statusCode = 404; res.end(body ?? 'missing');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const target = { kind, platform: platform + '-x64', service: 't3code.service', baseDir: base, python, origin: `http://127.0.0.1:${server.address().port}`, environmentId: 'fixture', expectedVersion: oldVersion, expectedServerSha256: digest('old-server'), expectedClientSha256: digest('old-index'), desktopExecutable: path.join(install, 'fixture.exe'), serverFile: path.join(resources, 'server.asar'), expectedFiles: { 'server.asar': digest('old-server'), 'app.asar': digest('old-app') }, disks: [{ root: dir, class: 'other', reserveBytes: 8192, growthBytes: 4096 }], verifySeconds: 1 };
  const close = () => { control.stops++; control.closed = true; if (control.onClose) control.onClose(); if (control.growAtClose) sql(database, 'INSERT INTO padding(value) VALUES(zeroblob(2097152));'); return JSON.stringify({ closed: true, main: 123, backend: 124 }); };
  const start = () => { assert.ok(control.closed); control.starts++; sql(database, migration); control.activated = true; control.closed = false; save(path.join(base, 'runtime/service-state.json'), { protocol: 3, activeVersion: version }); fs.writeFileSync(unit, standardServiceUnit(base, version)); return JSON.stringify({ started: true, pid: 125 }); };
  const run = (exe, args) => {
    if (args.includes('snapshot')) return JSON.stringify(call('snapshot', args.at(-1)));
    if (args.includes('backup')) { control.backups++; return JSON.stringify(call('backup', args.at(-1))); }
    if (args.includes('binding-reconciliation-check')) return JSON.stringify(call('binding-reconciliation-check', args.at(-1)));
    if (exe === 'systemctl') { if (args.includes('FragmentPath')) return unit; if (args.includes('DropInPaths') || args.includes('show-environment')) return ''; if (args.includes('stop')) return close(); if (args.includes('MainPID')) return control.closed ? '0' : '99'; }
    if (exe === 'findmnt') return JSON.stringify({ filesystems: [{ source: '/dev/fixture', fstype: 'ext4' }] });
    if (exe === 'lsblk') return JSON.stringify({ blockdevices: [{ name: '/dev/fixture', model: 'fixture', tran: 'nvme' }] });
    if (args[0] === '__service-preflight') return JSON.stringify({ status: 'ready', version, launcherProtocol: 3 });
    if (args[0] === 'service' || args.includes('start-desktop')) return start();
    if (args.some(a => a.endsWith('windows-inspect.ps1'))) { const req = JSON.parse(fs.readFileSync(args.at(-1))); return JSON.stringify({ portOwnerVerified: !control.closed, disks: req.paths.map(p => ({ path: p, device: 'fixture', freeBytes: 1024 ** 3, blockBytes: 4096, type: 'fixed', model: 'fixture' })) }); }
    if (args.some(a => a.endsWith('windows-close.ps1'))) return close();
    if (args.some(a => a.endsWith('windows-port.ps1'))) return JSON.stringify({ listening: !control.closed });
    throw new Error('Unexpected fixture command');
  };
  const adapter = makeNative(target, m, path.join(dir, 'release.json'), { run, platform, arch: 'x64', homeDir: dir, linuxOwner: () => !control.closed });
  return { dir, base, database, adapter, target, m, control, state: {}, client };
}

const selection = { instanceId: 'account', model: 'gpt-6-astra', options: [{ id: 'reasoningEffort', value: 'high' }] };
const stalePayload = { cwd: '/workspace', model: 'gpt-6.1-sol', modelSelection: selection };
const normalizedPayload = { ...stalePayload, model: selection.model };
const payloadSQL = payload => `UPDATE provider_session_runtime SET runtime_payload_json='${JSON.stringify(payload)}';`;
const idleSQL = provider => `INSERT INTO projection_projects VALUES('p','/workspace'); INSERT INTO projection_threads VALUES('idle','p','{}','full-access','default',NULL,'/workspace',NULL,NULL,NULL,NULL); INSERT INTO projection_thread_sessions VALUES('idle','ready',NULL,NULL); INSERT INTO projection_turns VALUES(1,'idle','finished-turn','completed','done'); INSERT INTO provider_session_runtime VALUES('idle','${provider}','account','ready','full-access','{"threadId":"native","resume":"native"}','${JSON.stringify(stalePayload)}');`;

for (const provider of ['codex', 'claude', 'cursor', 'opencode', 'grok', 'antigravity']) test(`${provider}: real inactive binding permits only authoritative shadow normalization`, t => {
  const database = path.join(temporary(t), 'state.sqlite'); sql(database, schema + idleSQL(provider));
  for (const lifecycle of ['ready', 'settled_at', 'snoozed_until', 'archived_at']) {
    const reset = `UPDATE projection_threads SET settled_at=NULL,snoozed_until=NULL,archived_at=NULL; ${lifecycle === 'ready' ? '' : `UPDATE projection_threads SET ${lifecycle}='saved';`}`;
    const [before, after] = snapshots(database, [reset + payloadSQL(stalePayload), payloadSQL(normalizedPayload)]);
    assert.equal(preservation(before, after).ok, true);
    const legacy = structuredClone(before); delete legacy.bindingModels;
    assert.deepEqual(preservation(legacy, after).failures, ['bindings:idle']);
    const changes = [
      "DELETE FROM provider_session_runtime;",
      "UPDATE provider_session_runtime SET provider_instance_id='other';",
      "UPDATE provider_session_runtime SET resume_cursor_json='{}';",
      "UPDATE provider_session_runtime SET runtime_mode='changed';",
      ...[null, 'wrong', undefined].map(model => payloadSQL({ ...normalizedPayload, model })),
      payloadSQL({ ...normalizedPayload, cwd: '/wrong' }),
      payloadSQL({ ...normalizedPayload, modelSelection: { ...selection, model: 'wrong' } }),
      payloadSQL({ ...normalizedPayload, modelSelection: { ...selection, options: [{ id: 'reasoningEffort', value: 'low' }] } }),
    ];
    for (const change of changes) {
      const [bad] = snapshots(database, ["DELETE FROM provider_session_runtime; INSERT INTO provider_session_runtime VALUES('idle','" + provider + "','account','ready','full-access','{\"threadId\":\"native\",\"resume\":\"native\"}','" + JSON.stringify(normalizedPayload) + "');" + change]);
      assert.ok(preservation(before, bad).failures.includes('bindings:idle'), change);
    }
    sql(database, "DELETE FROM provider_session_runtime; INSERT INTO provider_session_runtime VALUES('idle','" + provider + "','account','ready','full-access','{\"threadId\":\"native\",\"resume\":\"native\"}','" + JSON.stringify(stalePayload) + "');");
  }
});

test('missing or invalid authoritative selection retains strict shadow checks', t => {
  const database = path.join(temporary(t), 'state.sqlite'); sql(database, schema + idleSQL('codex'));
  for (const modelSelection of [undefined, null, {}, { ...selection, instanceId: 'other' }, { ...selection, model: '' }, { ...selection, options: {} }, { ...selection, options: [{ id: 'effort', value: 5 }] }, { ...selection, options: [{ id: 'effort', value: true }, { id: 'effort', value: false }] }]) {
    const [before, after] = snapshots(database, [payloadSQL({ ...stalePayload, modelSelection }), payloadSQL({ ...normalizedPayload, modelSelection })]);
    assert.deepEqual(before.bindingModels, []); assert.deepEqual(preservation(before, after).failures, ['bindings:idle']);
  }
});

for (const kind of ['desktop-files', 'boot-service']) test(`${kind}: old receipt reconciliation is explicit, exact, durable and verification-only`, async t => {
  const f = await installation(t, kind); sql(f.database, idleSQL('codex'));
  const inspect = f.adapter.inspect;
  f.adapter.inspect = async (...args) => { const result = await inspect(...args); delete result.snapshot.bindingModels; return result; };
  f.control.onClose = () => sql(f.database, payloadSQL(normalizedPayload));
  await execute(f.m, f.target, f.adapter, f.state, 'apply');
  assert.equal(f.state.phase, 'recovery-required', JSON.stringify(f.state));
  assert.deepEqual(f.state.proof.failures, ['bindings:idle']);
  const deployment = path.join(f.base, 'runtime/t3w-deploy', f.m.id);
  const originalText = fs.readFileSync(path.join(deployment, 'receipt.json'), 'utf8');
  const originalBefore = structuredClone(f.state.before), closedBytes = fs.readFileSync(path.join(deployment, 'closed-snapshot.json'));
  const request = path.join(f.dir, 'review request [literal].json');
  const candidate = { id: 'idle', previousModel: stalePayload.model };
  save(request, { deployment, candidates: [candidate] });
  const proof = call('binding-reconciliation', request);
  assert.equal(proof.originalReceiptText, originalText); assert.equal(proof.originalReceiptSha256, digest(originalText));
  const sidecar = path.join(deployment, 'binding-reconciliation.json'); save(sidecar, proof);
  const check = () => spawnSync(python, ['-B', helper, 'binding-reconciliation-check', deployment], { encoding: 'utf8', windowsHide: true });
  assert.equal(check().status, 0);
  const backupFile = path.join(deployment, 'before-migrations.sqlite');
  const backupBytes = fs.readFileSync(backupFile);
  sql(backupFile, payloadSQL({ ...normalizedPayload, cwd: '/forged-backup' }));
  assert.notEqual(check().status, 0); fs.writeFileSync(backupFile, backupBytes);
  const closedFile = path.join(deployment, 'closed-snapshot.json');
  const changedClosed = JSON.parse(closedBytes); changedClosed.bindings[0][1] = '0'.repeat(64);
  save(closedFile, changedClosed); assert.notEqual(check().status, 0); fs.writeFileSync(closedFile, closedBytes);
  const receiptFile = path.join(deployment, 'receipt.json');
  const changedReceipt = JSON.parse(originalText); changedReceipt.before.bindings[0][1] = '0'.repeat(64);
  save(receiptFile, changedReceipt); assert.notEqual(check().status, 0); fs.writeFileSync(receiptFile, originalText);
  for (const mutate of [p => p.entries[0].previousModel = 'guessed', p => p.entries[0].toSha256 = '0'.repeat(64), p => p.backupSha256 = '0'.repeat(64), p => p.closedSnapshotSha256 = '0'.repeat(64), p => p.originalReceiptSha256 = '0'.repeat(64), p => p.manifestHash = 'changed', p => p.targetHash = 'changed', p => p.entries.push(p.entries[0])]) {
    const bad = structuredClone(proof); mutate(bad); save(sidecar, bad); assert.notEqual(check().status, 0); save(sidecar, proof);
  }
  for (const payload of [{ ...normalizedPayload, cwd: '/lost' }, { ...normalizedPayload, model: 'changed' }, { ...normalizedPayload, modelSelection: { ...selection, options: [{ id: 'reasoningEffort', value: 'low' }] } }]) {
    sql(f.database, payloadSQL(payload)); assert.notEqual(check().status, 0);
  }
  sql(f.database, payloadSQL(normalizedPayload));
  sql(f.database, "UPDATE provider_session_runtime SET provider_instance_id='other';"); assert.notEqual(check().status, 0);
  sql(f.database, "UPDATE provider_session_runtime SET provider_instance_id='account',resume_cursor_json='{}';"); assert.notEqual(check().status, 0);
  sql(f.database, "UPDATE provider_session_runtime SET resume_cursor_json='{\"threadId\":\"native\",\"resume\":\"native\"}';");
  sql(f.database, payloadSQL({ ...normalizedPayload, cwd: '/lost' }));
  await execute(f.m, f.target, f.adapter, f.state, 'resume'); assert.equal(f.state.phase, 'recovery-required');
  assert.equal(f.control.starts, 1); assert.equal(f.control.stops, 1);
  sql(f.database, payloadSQL(normalizedPayload));
  save(request, { deployment, candidates: [{ ...candidate, previousModel: 'guessed' }] });
  assert.notEqual(spawnSync(python, ['-B', helper, 'binding-reconciliation', request], { windowsHide: true }).status, 0);
  await execute(f.m, f.target, f.adapter, f.state, 'resume');
  assert.equal(f.state.phase, 'accepted', JSON.stringify(f.state));
  assert.equal(f.state.proof.bindingReconciliation.sha256, sha(sidecar));
  assert.deepEqual(f.state.before, originalBefore); assert.deepEqual(fs.readFileSync(path.join(deployment, 'closed-snapshot.json')), closedBytes);
  assert.equal(JSON.parse(fs.readFileSync(sidecar)).originalReceiptText, originalText);
  assert.equal(f.control.starts, 1); assert.equal(f.control.stops, 1);
  assert.equal(call('snapshot', f.database).sessions[0].lastTurnId, 'finished-turn');
  await execute(f.m, f.target, f.adapter, f.state, 'resume'); assert.equal(f.control.starts, 1);
});

test('terminal parked moves pass real preflight unchanged; unresolved or inconsistent transfers block', async t => {
  const f = await installation(t, 'desktop-files');
  for (const [direction, state, locked] of [['out', 'complete', 1], ['in', 'cancelled', 1], ['in', 'complete', 0], ['out', 'cancelled', 0]]) sql(f.database, move(direction + state, direction, state, locked));
  await preflight(f.m, f.target, f.adapter); const before = call('snapshot', f.database);
  for (const [direction, state, locked] of [['out', 'queued', 1], ['out', 'committing', 1], ['out', 'cancelling', 0], ['in', 'copying', 1], ['in', 'prepared', 0], ['in', 'complete', 1], ['out', 'cancelled', 1]]) {
    sql(f.database, move('unresolved', direction, state, locked)); await assert.rejects(preflight(f.m, f.target, f.adapter), /in flight/); sql(f.database, "DELETE FROM custom_session_moves WHERE id='unresolved';");
  }
  await execute(f.m, f.target, f.adapter, f.state, 'apply'); assert.equal(f.state.phase, 'accepted', JSON.stringify(f.state));
  assert.equal(preservation(before, call('snapshot', f.database)).ok, true); assert.equal(f.control.starts, 1);
});

for (const kind of ['desktop-files', 'boot-service']) {
  for (const [asset, wrong] of [['assets/main.js', false], ['assets/lazy.js', true], ['assets/lazy.css', true], ['assets/font.woff2', false]]) test(`${kind} verifies served dynamic/client inventory: ${asset} ${wrong ? 'wrong bytes' : '404'}`, async t => {
    const f = await installation(t, kind); f.control.brokenAsset = '/' + asset; f.control.wrongBytes = wrong;
    await execute(f.m, f.target, f.adapter, f.state, 'apply'); assert.equal(f.state.phase, 'recovery-required'); assert.ok(f.control.requests.includes('/' + asset)); assert.equal(f.control.starts, 1);
    f.control.brokenAsset = null; await execute(f.m, f.target, f.adapter, f.state, 'resume'); assert.equal(f.state.phase, 'accepted', JSON.stringify(f.state)); assert.equal(f.control.starts, 1);
    for (const rel of Object.keys(f.client).filter(x => x !== 'index.html')) assert.ok(f.control.requests.includes('/' + rel));
  });
  for (const duringResume of [false, true]) test(`${kind} closed source ceiling holds ${duringResume ? 'on closed-phase resume' : 'after shutdown growth'}`, async t => {
    const f = await installation(t, kind); await preflight(f.m, f.target, f.adapter);
    if (duringResume) {
      const capacity = f.adapter.capacity; f.adapter.capacity = async (...args) => { if (args[3]) throw new Error('fixture interrupt after closed journal'); return capacity(...args); };
      await execute(f.m, f.target, f.adapter, f.state, 'apply'); f.adapter.capacity = capacity;
      assert.equal(f.state.phase, 'recovery-required'); sql(f.database, 'INSERT INTO padding(value) VALUES(zeroblob(2097152));');
    } else { f.control.growAtClose = true; await execute(f.m, f.target, f.adapter, f.state, 'apply'); }
    assert.equal(f.state.phase, 'recovery-required'); assert.ok(call('database-info', f.database).logicalBytes > f.m.compatibility.database.maxSourceBytes);
    await execute(f.m, f.target, f.adapter, f.state, 'resume'); assert.equal(f.state.phase, 'recovery-required'); assert.match(f.state.error.message, /ceiling/);
    assert.equal(f.control.stops, 1); assert.equal(f.control.starts, 0); assert.equal(f.control.backups, 0); assert.equal(f.control.closed, true);
    assert.equal(fs.existsSync(path.join(f.base, 'runtime/t3w-deploy', f.m.id, 'before-migrations.sqlite')), false);
    assert.deepEqual(call('database-info', f.database).migrationIds, [1]);
    assert.equal(sha(kind === 'desktop-files' ? f.target.serverFile : path.join(f.base, 'runtime/versions', f.target.expectedVersion, 't3')), digest('old-server'));
  });
}
