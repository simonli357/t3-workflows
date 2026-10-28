// Read-only prerequisite review for an explicitly reconciled deployment.
// This does not release a claim, close a process, rewrite an old receipt or
// authorize installation. A successor still needs measured immutable controls,
// OS-locked reconciliation, fresh preflight and the unchanged native verifier.
import { check, digest, checkDatabase } from './core.mjs';

// Retained attempts that closed the desktop but never replaced a resource. The
// measurement lane (measuring/measured) and a post-adoption handoff are the same
// "reopened before replacement" hazard as a recorded recovery-required failure.
export const REOPENED_PHASES = ['recovery-required', 'measuring', 'measured', 'handoff', 'verifying'];

export function reviewReopened({ request, receipt, journal, runners, installed, live, reviewedCurrentFiles = [] }) {
  const { manifest, target } = request;
  check(target.kind === 'desktop-files' && target.platform === 'win32-x64', 'recovery', 'Only the reviewed Windows desktop path is supported');
  check(receipt.id === manifest.id && receipt.manifestHash === digest(JSON.stringify(manifest)) && receipt.targetHash === digest(JSON.stringify(target)), 'recovery', 'Original request and receipt differ');
  check(REOPENED_PHASES.includes(receipt.phase) && journal.phase === 'closed' && journal.release === receipt.id, 'recovery', 'Original attempt must have failed before resource replacement');
  check(runners.length > 0 && runners.every(r => ['finished', 'failed', 'busy'].includes(r.phase)), 'recovery', 'An unfinished runner must be resolved first');
  check(live.environmentId === target.environmentId && live.version === target.expectedVersion && live.portOwnerVerified === true && live.installSha256 === target.expectedServerSha256 && live.clientSha256 === target.expectedClientSha256, 'recovery', 'Reopened listener or old installation identity differs');
  const names = Object.keys(target.expectedFiles);
  check(names.length > 0 && names.every(name => installed[name] === target.expectedFiles[name]), 'recovery', 'At least one live resource differs from the old installation');
  checkDatabase(manifest, live.snapshot.database);
  check(!(live.snapshot.blockingOperations?.length), 'recovery', 'Ownership or native move reconciliation is still running');
  // New work may append history and jobs. Existing immutable evidence may not
  // disappear or change. The later activation uses a fresh current baseline.
  const before = receipt.before, after = live.snapshot, changes = [];
  const permitted = new Set(['file:settings.json', 'file:connection-catalog.json', 'file:saved-environments.json']);
  check(reviewedCurrentFiles.every(e => permitted.has(e.id) && /^[a-f0-9]{64}$/.test(e.fromSha256) && /^[a-f0-9]{64}$/.test(e.toSha256) && typeof e.reason === 'string' && e.reason.trim().length > 0), 'recovery', 'Current-file review must name exact settings hashes and its reason');
  check(new Set(reviewedCurrentFiles.map(e => e.id)).size === reviewedCurrentFiles.length, 'recovery', 'Duplicate current-file review');
  for (const key of ['projects', 'profiles', 'bindings', 'history', 'historyContent', 'ownership', 'jobs', 'routes']) {
    const next = new Map(after[key] ?? []);
    for (const [id, hash] of before[key] ?? []) {
      if (next.get(id) === hash) continue;
      const accepted = key === 'routes' && reviewedCurrentFiles.find(e => e.id === id && e.fromSha256 === hash && e.toSha256 === next.get(id));
      check(accepted, 'recovery', `Existing preservation evidence changed: ${key}:${id}`);
      changes.push({ ...accepted, historicalEquality: 'unproven' });
    }
  }
  check(changes.length === reviewedCurrentFiles.length, 'recovery', 'Current-file review is stale or does not match the actual change');
  // Native identity survives even when ordinary user work changes turn state.
  const sessions = new Map(after.sessions.map(s => [s.id, s]));
  for (const old of before.sessions) {
    const now = sessions.get(old.id);
    check(now && ['nativeId', 'instance', 'provider', 'profile'].every(k => now[k] === old[k]), 'recovery', 'A native binding or provider selection changed');
  }
  return { phase: 'reviewed-before-replacement', activationAuthorized: false, oldDeploymentId: receipt.id,
    oldManifestHash: receipt.manifestHash, oldTargetHash: receipt.targetHash,
    currentSnapshotSha256: digest(JSON.stringify(after)), currentFiles: changes,
    requirements: ['Retain original receipt, journal, failed partial and request bytes', 'Measure fresh full backup and independent checksum with supported bounded helper', 'Pin a distinct corrected release and truthful timing/size controls', 'Reconcile the old claim explicitly under the existing OS lock', 'Capture fresh current baseline; use unchanged installed activation and acceptance'] };
}
