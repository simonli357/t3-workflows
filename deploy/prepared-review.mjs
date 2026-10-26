// Narrow, distinct supersession for a Windows desktop release whose activation FAILED BEFORE THE DESKTOP WAS CLOSED
// ("failed-before-closure"). The attempt prepared its resource siblings and wrote the journal `prepared`, then the
// graceful close failed, so the original app was never closed and nothing was replaced. Because the close never
// completed there is no closed snapshot and none is ever fabricated: the boundary is the original `before` snapshot.
//
// What it proves (all of it, or it refuses):
//   - the retained failure is exactly the known set of files (receipt, journal, desktop request, requests and their
//     terminal runner receipts, plus the two staging trees), each pinned by hash, with no closed snapshot, backup,
//     measurement or other file; the journal is exactly {phase:'prepared', release:<id>};
//   - the receipt is an unresolved recovery-required failure of an activation attempt (uncertain handoff, failed proof);
//   - the old installation is unchanged: every pinned old resource hash, the served version/client/server hashes, and
//     the very same listener process (pid and OS start time pinned by the decision, both earlier than the first request);
//   - native identity and immutable state still match the original `before` snapshot (new activity may only append);
//   - the exact pinned successor (id, manifest hash, target hash) is the only release that may supersede it.
// It never rewrites the original receipt, journal, requests or claim: it only adds the `superseded.json` sidecar, which
// the existing claim logic already honours for the pinned successor. The successor then stages, closes, installs and is
// accepted by the unchanged activation and verification path against its own fresh baseline.
import fs from 'node:fs';
import path from 'node:path';
import { check, read, sha, digest, inventory, checkDatabase } from './core.mjs';

export const PREPARED_KIND = 'failed-before-closure';
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const JOURNAL = 'desktop-activation.json', DESKTOP_REQUEST = 'desktop-request.json';
const BASE_FILES = ['receipt.json', JOURNAL, DESKTOP_REQUEST];
const TREES = ['payload', 'previous-desktop'];
const REQUEST = /^request-[0-9a-f-]{36}\.json$/, RUNNER = /^request-[0-9a-f-]{36}\.json\.runner\.json$/;
const TERMINAL = ['finished', 'failed', 'busy'];
const COMMANDS = ['stage', 'apply', 'resume'];
const DECISION_KEYS = ['schema', 'kind', 'id', 'successor', 'evidence', 'trees', 'listener', 'reviewedCurrentFiles', 'reviewedCurrentBindings'];
const CURRENT_FILES = ['file:settings.json', 'file:connection-catalog.json', 'file:saved-environments.json'];
const IMMUTABLE = ['projects', 'profiles', 'bindings', 'history', 'historyContent', 'ownership', 'jobs', 'routes'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function canonical(file, directory = false) {
  const stat = fs.lstatSync(file);
  check(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()) && fs.realpathSync(file) === path.resolve(file), 'recovery', 'Recovery evidence must be a canonical regular path');
}

// Stable digest of a retained staging tree: every file's relative path, size and SHA-256, sorted.
export function treeDigest(dir) {
  canonical(dir, true);
  let bytes = 0;
  const rows = inventory(dir).map(rel => {
    const file = path.join(dir, ...rel.split('/')); canonical(file);
    const size = fs.statSync(file).size; bytes += size;
    return `${rel}\0${size}\0${sha(file)}\n`;
  });
  return { files: rows.length, bytes, sha256: digest(rows.join('')) };
}

// The retained failure is a closed list: anything else (a closed snapshot, a database backup, measurement or adoption
// files, a binding sidecar, a prior supersession) means this is not a failure before closure.
export function retainedFailure(deployment) {
  canonical(deployment, true);
  check(!fs.existsSync(path.join(deployment, 'closed-snapshot.json')), 'recovery', 'A closed snapshot exists, so this is not a failure before closure');
  const files = [], trees = [];
  for (const entry of fs.readdirSync(deployment, { withFileTypes: true })) {
    const file = path.join(deployment, entry.name);
    check(!entry.isSymbolicLink(), 'recovery', 'Retained failure evidence must not contain links');
    if (entry.isDirectory()) { check(TREES.includes(entry.name), 'recovery', 'Unexpected retained directory: ' + entry.name); canonical(file, true); trees.push(entry.name); continue; }
    check(entry.isFile() && (BASE_FILES.includes(entry.name) || REQUEST.test(entry.name) || RUNNER.test(entry.name)), 'recovery', 'Unexpected retained file: ' + entry.name);
    canonical(file); files.push(entry.name);
  }
  check(BASE_FILES.every(name => files.includes(name)), 'recovery', 'The original receipt, journal and desktop request must all be retained');
  return { files: files.sort(), trees: trees.sort() };
}

// Read-only snapshot of what a decision has to pin, for the person who authors and reviews it.
export function describePrepared({ root, id, successor, target, listener, reviewedCurrentFiles }) {
  const deployment = path.join(root, id), { files, trees } = retainedFailure(deployment);
  return {
    schema: 1, kind: PREPARED_KIND, id,
    successor: { id: successor.id, manifestHash: digest(JSON.stringify(successor)), targetHash: digest(JSON.stringify(target)) },
    evidence: Object.fromEntries(files.map(name => [name, sha(path.join(deployment, name))])),
    trees: Object.fromEntries(trees.map(name => [name, treeDigest(path.join(deployment, name))])),
    listener, ...(reviewedCurrentFiles?.length ? { reviewedCurrentFiles } : {}),
  };
}

// Structural half, run before and after the live review: every retained byte is exactly what the decision pins.
export function inspectPrepared(deployment, decision, receipt, successor, target) {
  check(Object.keys(decision).every(key => DECISION_KEYS.includes(key)), 'recovery', 'Unsupported field in a failed-before-closure decision');
  const { files, trees } = retainedFailure(deployment);
  check(decision.evidence && typeof decision.evidence === 'object' && same(Object.keys(decision.evidence).sort(), files), 'recovery', 'The decision must pin every retained failure file and nothing else');
  for (const [name, expected] of Object.entries(decision.evidence)) check(hash(expected) && sha(path.join(deployment, name)) === expected, 'recovery', 'Original evidence changed: ' + name);
  check(decision.trees && typeof decision.trees === 'object' && same(Object.keys(decision.trees).sort(), trees), 'recovery', 'The decision must pin every retained staging tree');
  for (const [name, pin] of Object.entries(decision.trees)) { const actual = treeDigest(path.join(deployment, name)); check(Number.isSafeInteger(pin.files) && Number.isSafeInteger(pin.bytes) && hash(pin.sha256) && same(actual, { files: pin.files, bytes: pin.bytes, sha256: pin.sha256 }), 'recovery', 'Retained staging tree changed: ' + name); }
  const journal = read(path.join(deployment, JOURNAL));
  check(same(journal, { phase: 'prepared', release: receipt.id }), 'recovery', 'The journal must be exactly prepared: the desktop was never closed');
  const requests = [], runners = [];
  for (const name of files.filter(n => REQUEST.test(n))) {
    const file = path.join(deployment, name), request = read(file);
    check(digest(JSON.stringify(request.manifest)) === receipt.manifestHash && digest(JSON.stringify(request.target)) === receipt.targetHash, 'recovery', 'Original immutable request differs');
    check(COMMANDS.includes(request.command), 'recovery', 'Only stage, apply and resume requests belong to a failure before closure');
    if (request.command !== 'stage') { check(files.includes(name + '.runner.json'), 'recovery', 'An activation request has no terminal runner receipt'); }
    requests.push({ name, command: request.command, mtimeMs: fs.statSync(file).mtimeMs, request });
  }
  for (const name of files.filter(n => RUNNER.test(n))) {
    check(files.includes(name.slice(0, -'.runner.json'.length)), 'recovery', 'A runner receipt has no request');
    const runner = read(path.join(deployment, name)); check(TERMINAL.includes(runner.phase), 'recovery', 'An existing runner has not finished'); runners.push(runner);
  }
  check(requests.some(r => r.command === 'apply') && runners.length > 0, 'recovery', 'The failed activation attempt and its runner evidence are required');
  const request = requests.find(r => r.command === 'apply').request;
  check(same(read(path.join(deployment, DESKTOP_REQUEST)), { port: Number(new URL(target.origin).port || 80), executable: target.desktopExecutable }), 'recovery', 'The retained desktop request differs from the pinned target');
  check(['baseDir', 'environmentId', 'kind', 'platform', 'origin', 'service', 'desktopExecutable', 'serverFile', 'expectedVersion', 'expectedServerSha256', 'expectedClientSha256'].every(k => request.target[k] === target[k]) && same(request.target.expectedFiles, target.expectedFiles), 'recovery', 'Recovery target does not pin the same unchanged old installation');
  return { deployment, request, receipt, journal, closed: null, runners, decision, firstRequestMs: Math.min(...requests.map(r => r.mtimeMs)) };
}

// Live half: the old installation, listener, database and native identity are still exactly the original.
export function reviewPrepared(context, live, installed, listener) {
  const { decision, receipt, request, firstRequestMs } = context, { manifest, target } = request;
  check(target.kind === 'desktop-files' && target.platform === 'win32-x64', 'recovery', 'Only the reviewed Windows desktop path is supported');
  check(receipt.phase === 'recovery-required' && receipt.handoff?.uncertain === true && receipt.proof?.ok === false && receipt.before && Array.isArray(receipt.before.sessions), 'recovery', 'Only an unresolved failed activation with its original before snapshot can be superseded');
  const names = Object.keys(target.expectedFiles);
  check(names.length > 0 && names.every(name => installed[name] === target.expectedFiles[name]), 'recovery', 'An old installed resource differs: the old application changed');
  check(live.version === target.expectedVersion && live.installSha256 === target.expectedServerSha256 && live.clientSha256 === target.expectedClientSha256, 'recovery', 'The served old version or its server/client differs');
  const pinned = decision.listener, identity = who => who && Number.isSafeInteger(who.pid) && typeof who.startedAt === 'string' && Number.isFinite(Date.parse(who.startedAt));
  check(pinned && identity(pinned.backend) && identity(pinned.parent) && listener && identity(listener.backend) && identity(listener.parent), 'recovery', 'Listener identity must be pinned and readable');
  for (const who of ['backend', 'parent']) check(pinned[who].pid === listener[who].pid && pinned[who].startedAt === listener[who].startedAt, 'recovery', `The ${who} process is not the pinned one (restarted or replaced)`);
  for (const who of ['backend', 'parent']) check(Date.parse(listener[who].startedAt) < firstRequestMs, 'recovery', `The ${who} process started after the failed attempt began`);
  checkDatabase(manifest, live.snapshot.database);
  check(!(live.snapshot.blockingOperations?.length), 'recovery', 'Ownership or native move reconciliation is still running');
  // Immutable state against the ORIGINAL before snapshot. New work may append history and jobs; an existing immutable
  // record may not disappear or change. The three user-setting files may differ only by an exact reviewed entry.
  const reviewed = decision.reviewedCurrentFiles ?? [];
  check(Array.isArray(reviewed) && reviewed.every(e => CURRENT_FILES.includes(e.id) && hash(e.fromSha256) && hash(e.toSha256) && typeof e.reason === 'string' && e.reason.trim().length > 0) && new Set(reviewed.map(e => e.id)).size === reviewed.length, 'recovery', 'Current-file review must name exact settings hashes and its reason');
  const bindingReviews = decision.reviewedCurrentBindings ?? [];
  check(Array.isArray(bindingReviews) && bindingReviews.every(e => typeof e.id === 'string' && hash(e.fromSha256) && hash(e.toSha256) && e.fromSha256 !== e.toSha256 && typeof e.reason === 'string' && e.reason.trim().length > 0) && new Set(bindingReviews.map(e => e.id)).size === bindingReviews.length, 'recovery', 'Binding review must pin exact before/current hashes and its reason');
  // The exact unrestarted listener proves these changes occurred in the old app.
  // A primary may accept ordinary cursor progress explicitly; identity/profile
  // equality is still checked below, and the next install takes a fresh baseline.
  const before = receipt.before, after = live.snapshot, changes = [], bindingChanges = [];
  for (const key of IMMUTABLE) {
    const next = new Map(after[key] ?? []);
    for (const [id, value] of before[key] ?? []) {
      if (next.get(id) === value) continue;
      const accepted = key === 'routes' ? reviewed.find(e => e.id === id && e.fromSha256 === value && e.toSha256 === next.get(id)) : key === 'bindings' ? bindingReviews.find(e => e.id === id && e.fromSha256 === value && e.toSha256 === next.get(id)) : null;
      check(accepted, 'recovery', `Existing preservation evidence changed: ${key}:${id}`);
      (key === 'bindings' ? bindingChanges : changes).push({ ...accepted, historicalEquality: 'unproven' });
    }
  }
  check(bindingChanges.length === bindingReviews.length, 'recovery', 'Binding review is stale or does not match the actual change');
  check(changes.length === reviewed.length, 'recovery', 'Current-file review is stale or does not match the actual change');
  const sessions = new Map(after.sessions.map(s => [s.id, s]));
  for (const old of before.sessions) { const now = sessions.get(old.id); check(now && ['nativeId', 'instance', 'provider', 'profile'].every(k => now[k] === old[k]), 'recovery', 'A native binding or provider selection changed'); }
  return {
    schema: 1, phase: 'superseded', kind: PREPARED_KIND, id: receipt.id, manifestHash: receipt.manifestHash, targetHash: receipt.targetHash,
    originalReceiptSha256: decision.evidence['receipt.json'], evidence: decision.evidence, trees: decision.trees,
    listener: pinned, successor: decision.successor, currentSnapshotSha256: digest(JSON.stringify(live.snapshot)),
    reviewedCurrentFiles: changes, reviewedCurrentBindings: bindingChanges, originalFailureAccepted: false, supersededAt: new Date().toISOString(),
  };
}

// Applied whenever a retained supersession of this kind is read (every claim check and status): the retained failure
// files must still be exactly the pinned set, still without a closed snapshot. The sidecar itself is the only addition.
export function assertPreparedTerminal(deployment, terminal) {
  check(BASE_FILES.every(name => hash(terminal.evidence?.[name])), 'recovery', 'Missing original boundary evidence');
  check(!fs.existsSync(path.join(deployment, 'closed-snapshot.json')), 'recovery', 'A closed snapshot appeared next to a failure before closure');
  const files = fs.readdirSync(deployment, { withFileTypes: true }).filter(e => e.isFile() && e.name !== 'superseded.json').map(e => e.name).sort();
  check(same(Object.keys(terminal.evidence).sort(), files), 'recovery', 'Retained failure files differ from the supersession pins');
}
