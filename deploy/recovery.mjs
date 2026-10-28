// Explicit, forward-only supersession of a failed deployment. Original receipt,
// journal, backup and requests remain byte-for-byte retained. Never restores.
import fs from 'node:fs';
import path from 'node:path';
import { check, read, sha, digest, preservation, checkDatabase } from './core.mjs';
import { reviewReopened, REOPENED_PHASES } from './reopened-review.mjs';
import { reviewedForwardBoundaries } from './forward-review.mjs';
import { reviewedWindowsBoundaries } from './windows-profile-review.mjs';
import { validateWindowsCatalogReview } from './windows-catalog-review.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
// Which retained receipt phases a terminal of each kind may supersede.
export const reconcilablePhases = kind => kind === 'reopened-before-replacement' ? REOPENED_PHASES : ['recovery-required'];
const SUPERSEDABLE = { 'reopened-before-replacement': REOPENED_PHASES, 'installed-forward-repair': ['recovery-required'], 'measured-adoption': ['measured'] };
function regular(file) {
  check(fs.realpathSync(file) === path.resolve(file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), 'recovery', 'Recovery evidence must be a canonical regular file');
}
export function readSuperseded(locations, state) {
  const file = path.join(locations.deployment, 'superseded.json');
  if (!fs.existsSync(file)) return null;
  regular(file); const terminal = read(file);
  check(SUPERSEDABLE[terminal.kind]?.includes(state.phase) && terminal.schema === 1 && terminal.phase === 'superseded' && terminal.originalReceiptSha256 === sha(locations.receipt) && ['id', 'manifestHash', 'targetHash'].every(k => terminal[k] === state[k]) && hash(terminal.successor?.manifestHash) && hash(terminal.successor?.targetHash) && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(terminal.successor.id) && terminal.successor.id !== state.id && hash(terminal.currentSnapshotSha256), 'recovery', 'Supersession does not match the original failure');
  for (const [name, expected] of Object.entries(terminal.evidence ?? {})) {
    check(/^[a-zA-Z0-9_.-]+$/.test(name) && hash(expected), 'recovery', 'Invalid retained evidence pin');
    const pinned = path.join(locations.deployment, name); regular(pinned);
    check(sha(pinned) === expected, 'recovery', 'Original recovery evidence changed: ' + name);
  }
  check(Object.keys(terminal.evidence ?? {}).includes('receipt.json') && Object.keys(terminal.evidence).includes('closed-snapshot.json'), 'recovery', 'Missing original boundary evidence');
  return { ...state, phase: 'superseded', supersession: terminal };
}
export function inspectRecovery(root, decision, successor, target, ownRequest) {
  check(decision.schema === 1 && ['reopened-before-replacement', 'installed-forward-repair'].includes(decision.kind) && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(decision.id) && decision.id !== successor.id, 'recovery', 'Explicit distinct predecessor required');
  check(decision.successor?.id === successor.id && decision.successor.manifestHash === digest(JSON.stringify(successor)) && decision.successor.targetHash === digest(JSON.stringify(target)), 'recovery', 'Recovery decision pins a different successor');
  const deployment = path.join(root, decision.id), receiptFile = path.join(deployment, 'receipt.json');
  regular(receiptFile); const receipt = read(receiptFile);
  check(reconcilablePhases(decision.kind).includes(receipt.phase) && receipt.id === decision.id, 'recovery', 'Only an unresolved retained failure can be superseded');
  const claim = read(path.join(root, 'claim.json'));
  check(claim.id === receipt.id && claim.manifestHash === receipt.manifestHash, 'recovery', 'Predecessor no longer owns the deployment claim');
  check(!fs.existsSync(path.join(deployment, 'superseded.json')), 'recovery', 'Supersession already exists; reread durable status');
  const journalName = target.kind === 'boot-service' ? 'service-activation.json' : 'desktop-activation.json';
  for (const name of ['receipt.json', journalName, 'closed-snapshot.json']) check(hash(decision.evidence?.[name]), 'recovery', 'Exact original failure and boundary pins are required');
  for (const [name, expected] of Object.entries(decision.evidence)) {
    check(/^[a-zA-Z0-9_.-]+$/.test(name) && hash(expected), 'recovery', 'Unsafe evidence pin');
    const file = path.join(deployment, name); regular(file); check(sha(file) === expected, 'recovery', 'Original evidence changed: ' + name);
  }
  const requests = [], runners = [];
  for (const name of fs.readdirSync(deployment).filter(n => /^request-.*\.json$/.test(n))) {
    const file = path.join(deployment, name); regular(file);
    if (name.endsWith('.runner.json')) { const runner = read(file); check(['finished', 'failed', 'busy'].includes(runner.phase), 'recovery', 'An existing runner has not finished'); runners.push(runner); }
    else { const req = read(file); check(digest(JSON.stringify(req.manifest)) === receipt.manifestHash && digest(JSON.stringify(req.target)) === receipt.targetHash, 'recovery', 'Original immutable request differs'); check(['stage', 'apply', 'resume', 'cancel', 'reconcile', 'measure-backup', 'adopt-backup'].includes(req.command), 'recovery', 'Unknown original command'); if (['apply', 'resume', 'measure-backup', 'adopt-backup'].includes(req.command)) { const runnerFile = file + '.runner.json'; regular(runnerFile); check(['finished', 'failed', 'busy'].includes(read(runnerFile).phase), 'recovery', 'An activation request has no terminal runner receipt'); } requests.push(req); }
  }
  check(requests.length > 0 && runners.length > 0, 'recovery', 'Missing original requests or completed runner evidence');
  const request = requests[0], journal = read(path.join(deployment, journalName)), closed = read(path.join(deployment, 'closed-snapshot.json'));
  check(journal.closedSnapshotSha256 === decision.evidence['closed-snapshot.json'], 'recovery', 'Original closed boundary seal differs');
  check(['baseDir', 'environmentId', 'kind', 'platform', 'origin', 'service', 'desktopExecutable', 'serverFile'].every(k => request.target[k] === target[k]), 'recovery', 'Recovery target is not the same native installation');
  return { deployment, request, receipt, journal, closed, runners, decision };
}
export function reviewRecovery(context, live, installed, reconciliations = {}) {
  const { decision, receipt, request, journal, closed } = context;
  let forward, windows;
  check(!decision.windowsCatalogReview || (decision.kind === 'reopened-before-replacement' && decision.windowsProfileReview), 'recovery', 'Catalog reconciliation requires the exact Windows profile-bound decision');
  check(live.environmentId === request.target.environmentId && live.portOwnerVerified === true && !live.conflictingUpdate && !(live.snapshot.blockingOperations?.length), 'recovery', 'Live owner or native transition is uncertain');
  if (decision.kind === 'reopened-before-replacement') {
    check(journal.phase === 'closed', 'recovery', 'Reopened review is only before replacement');
    if (decision.windowsProfileReview) windows = reviewedWindowsBoundaries(context, live, reconciliations.windowsProfile);
    if (decision.windowsCatalogReview || (decision.windowsProfileReview && decision.reviewedCurrentFiles?.some(e => e.id === 'file:connection-catalog.json'))) validateWindowsCatalogReview(context, live, reconciliations.windowsCatalog);
    reviewReopened({ ...context, receipt: windows ? { ...receipt, before: windows.before } : receipt, installed, live, reviewedCurrentFiles: decision.reviewedCurrentFiles ?? [] });
  } else {
    check(!(decision.reviewedCurrentFiles?.length), 'recovery', 'Current-file reconciliation is scoped to the reviewed reopened Windows boundary');
    check(request.target.kind === 'boot-service' && journal.phase === 'started' && live.version === request.manifest.version, 'recovery', 'Forward repair requires the exact installed failed release');
    if (live.snapshot.database.schemaSha256 === request.manifest.compatibility.database.toSchemaSha256) checkDatabase(request.manifest, live.snapshot.database, true);
    else {
      const rows = reconciliations.schema, retained = decision.retainedAdditionalIndexes;
      check(Array.isArray(rows) && Array.isArray(retained) && retained.length > 0 && new Set(retained.map(r => r[1])).size === retained.length && retained.every(r => r.length === 4 && r[0] === 'index' && typeof r[3] === 'string' && rows.some(actual => JSON.stringify(actual) === JSON.stringify(r))), 'recovery', 'Unexpected schema requires exact retained additive-index evidence');
      check(digest(JSON.stringify(rows)) === live.snapshot.database.schemaSha256 && digest(JSON.stringify(rows.filter(r => !retained.some(extra => extra[1] === r[1])))) === request.manifest.compatibility.database.toSchemaSha256 && JSON.stringify(live.snapshot.database.migrationIds) === JSON.stringify(request.manifest.compatibility.database.toMigrations), 'recovery', 'Schema drift is not exclusively the pinned retained indexes');
    }
    const payload = request.manifest.payloads.find(p => p.platform === request.target.platform);
    check(live.installSha256 === payload.files.find(f => f.path === 't3')?.sha256 && live.clientSha256 === payload.files.find(f => f.path === 'client/index.html')?.sha256, 'recovery', 'Installed failed-release resources differ');
    if (decision.forwardReview) forward = reviewedForwardBoundaries(context, live, reconciliations.forward);
    const proof = preservation(forward?.before ?? receipt.before, live.snapshot, reconciliations.bindings ?? [], [...(reconciliations.activity ?? []), ...(forward?.activity ?? [])], reconciliations.routes ?? []);
    check(proof.ok, 'recovery', 'Original native/history preservation must pass before forward repair: ' + JSON.stringify(proof));
  }
  const sessions = new Map(live.snapshot.sessions.map(s => [s.id, s]));
  for (const old of (windows?.before ?? receipt.before).sessions) check(sessions.has(old.id) && ['nativeId', 'instance', 'provider', 'profile'].every(k => sessions.get(old.id)[k] === old[k]), 'recovery', 'Original native identity changed');
  // Exact authorized current-setting decisions apply to both retained old
  // boundaries. This is explicit reconciliation, not historical equality.
  const closedRoutes = (closed.routes ?? []).map(([id, value]) => { const reviewed = (decision.reviewedCurrentFiles ?? []).find(x => x.id === id && x.fromSha256 === value); return [id, reviewed ? reviewed.toSha256 : value]; });
  // Nothing was replaced in a reopened-before-replacement attempt, so a worker job that failed or was cancelled in the
  // reopened old app is ordinary activity (reviewReopened already ignores job states). The successor captures its own
  // fresh baseline and still detects update-caused job failures against that. Immutable job rows stay protected.
  const closedBoundary = decision.kind === 'reopened-before-replacement' ? { ...(windows?.closed ?? closed), jobStates: [] } : (forward?.closed ?? closed);
  const boundary = preservation({ ...closedBoundary, routes: closedRoutes, sessions: [] }, live.snapshot);
  check(boundary.ok, 'recovery', 'Closed native/history boundary differs: ' + JSON.stringify(boundary));
  return { schema: 1, phase: 'superseded', kind: decision.kind, id: receipt.id, manifestHash: receipt.manifestHash, targetHash: receipt.targetHash, originalReceiptSha256: decision.evidence['receipt.json'], evidence: decision.evidence, successor: decision.successor, currentSnapshotSha256: digest(JSON.stringify(live.snapshot)), reviewedCurrentFiles: decision.reviewedCurrentFiles ?? [], ...(forward ? { forwardReview: { decision: decision.forwardReview, proof: reconciliations.forward, historicalSettingsEquality: false } } : {}), ...(windows ? { windowsProfileReview: { decision: decision.windowsProfileReview, proof: reconciliations.windowsProfile, historicalProfileEquality: false } } : {}), ...(decision.windowsCatalogReview ? { windowsCatalogReview: { decision: decision.windowsCatalogReview, proof: reconciliations.windowsCatalog } } : {}), originalFailureAccepted: false, supersededAt: new Date().toISOString() };
}

export function assertMeasurementPlan(m) {
  check(m.measurementOnly === true && m.compatibility.migrations === 'forward-only' && m.compatibility.database.backup === undefined && m.measurementBudget?.seconds === 900 && m.measurementBudget?.checksumSeconds === 120 && m.measurementBudget?.review?.length > 20, 'recovery', 'Measurement requires an explicitly reviewed bounded plan, never an activation manifest');
}
export function assertAdoption(prepared, manifest, target, timing, checksum) {
  assertMeasurementPlan(prepared.manifest);
  check(!manifest.measurementOnly && manifest.id !== prepared.manifest.id && digest(JSON.stringify(target)) === prepared.targetHash, 'recovery', 'Adoption must use a distinct release id and the same native target');
  const stable = value => { const copy = structuredClone(value); delete copy.id; delete copy.measurementOnly; delete copy.measurementBudget; delete copy.compatibility.database.backup; return digest(JSON.stringify(copy)); };
  check(stable(prepared.manifest) === stable(manifest), 'recovery', 'Payload, source or migration controls changed after preparation');
  const b = manifest.compatibility.database.backup;
  check(b?.seconds === 900 && b.checksumSeconds === 120 && timing.phase === 'complete' && timing.freshBackup === true && timing.budgetSeconds === 900 && timing.elapsedSeconds > 0 && timing.elapsedSeconds <= 675 && timing.backup.integrity === 'ok' && timing.backup.automaticRestore === false && timing.backup.bytes === prepared.closed.database.logicalBytes && b.maxSourceBytes === timing.backup.bytes, 'recovery', 'Adoption requires actual complete closed-source timing with headroom');
  check(checksum.phase === 'complete' && checksum.sourceUnchanged === true && checksum.budgetSeconds === 120 && checksum.elapsedSeconds > 0 && checksum.elapsedSeconds <= 90 && checksum.bytes === timing.backup.bytes && checksum.sha256 === timing.backup.sha256, 'recovery', 'Independent checksum proof does not match preparation');
  checkDatabase(manifest, prepared.closed.database);
}
