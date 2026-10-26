import fs from 'node:fs';
import path from 'node:path';
import { check, read, sha, digest } from './core.mjs';
import { readSuperseded } from './recovery.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function canonical(file, directory = false) {
  const stat = fs.lstatSync(file);
  check(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()) && fs.realpathSync(file) === path.resolve(file), 'cancel', 'Cancellation evidence must use canonical regular paths');
}
export function assertCancelState(state) {
  check(state.phase === 'staged' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(state.id) && hash(state.manifestHash) && hash(state.targetHash) && Object.keys(state).every(key => ['phase', 'id', 'manifestHash', 'targetHash', 'updatedAt'].includes(key)), 'cancel', 'Only an intact staged receipt without any activation evidence can be cancelled');
}
export function readDeployment(locations) {
  const cancelledFile = path.join(locations.deployment, 'cancelled.json');
  if (!fs.existsSync(locations.receipt)) {
    check(!fs.existsSync(cancelledFile), 'cancel', 'Original staged receipt is missing');
    return { phase: 'not-started' };
  }
  canonical(locations.deployment, true); canonical(locations.receipt);
  const state = read(locations.receipt);
  check(state.id === path.basename(locations.deployment), 'cancel', 'Receipt deployment id differs from its location');
  const superseded = readSuperseded(locations, state);
  check(!superseded || !fs.existsSync(cancelledFile), 'recovery', 'Conflicting terminal recovery evidence');
  if (superseded) return superseded;
  if (!fs.existsSync(cancelledFile)) return state;
  canonical(cancelledFile);
  const cancelled = read(cancelledFile);
  assertCancelState(state);
  check(cancelled.schema === 1 && cancelled.phase === 'cancelled' && cancelled.kind === 'before-activation' && cancelled.originalReceiptSha256 === sha(locations.receipt) && ['id', 'manifestHash', 'targetHash'].every(key => cancelled[key] === state[key]) && hash(cancelled.observed?.snapshotSha256) && hash(cancelled.observed?.installSha256) && typeof cancelled.observed?.environmentId === 'string' && typeof cancelled.observed?.version === 'string', 'cancel', 'Terminal cancellation does not match its original staged receipt');
  return { ...state, phase: 'cancelled', cancellation: { ...cancelled, sha256: sha(cancelledFile) } };
}

// Called twice under the host OS lock, around live inspection. Activation
// requests are uncertainty even when the launcher has not written its journal.
// Unknown evidence is retained and blocks cancellation rather than being erased.
export function assertUnactivated(locations, state, ownRequest) {
  assertCancelState(state);
  check(state.id === path.basename(locations.deployment), 'cancel', 'Receipt deployment id differs from its location');
  canonical(locations.deployment, true); canonical(locations.receipt); canonical(locations.claim);
  check(digest(JSON.stringify(read(locations.receipt))) === digest(JSON.stringify(state)), 'cancel', 'Staged receipt changed during cancellation');
  const claim = read(locations.claim);
  check(claim.id === state.id && claim.manifestHash === state.manifestHash, 'conflict', 'Cancellation requires this exact staged claim');
  for (const name of fs.readdirSync(locations.deployment)) {
    const file = path.join(locations.deployment, name);
    if (['payload', 'previous-desktop'].includes(name)) { canonical(file, true); continue; }
    canonical(file);
    if (name === 'receipt.json' || /^cancelled\.json\.[0-9a-f-]{36}\.tmp$/.test(name)) continue;
    const requestMatch = /^request-[0-9a-f-]{36}\.json(?:\.runner\.json)?$/.test(name);
    check(requestMatch, 'cancel', 'Activation or unknown deployment evidence blocks cancellation: ' + name);
    const requestFile = name.endsWith('.runner.json') ? file.slice(0, -'.runner.json'.length) : file;
    canonical(requestFile);
    const request = read(requestFile);
    check(['stage', 'cancel'].includes(request.command) && digest(JSON.stringify(request.manifest)) === state.manifestHash && digest(JSON.stringify(request.target)) === state.targetHash, 'cancel', 'An activation request or conflicting request blocks cancellation');
    if (name.endsWith('.runner.json')) {
      const runner = read(file);
      const current = ownRequest && path.resolve(ownRequest) === requestFile && request.command === 'cancel';
      check(current || ['finished', 'failed', 'busy'].includes(runner.phase), 'cancel', 'An unfinished runner requires inspection before cancellation');
    }
  }
}
