import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { check, read, sha, digest, fileAt } from './core.mjs';

export const DORMANT_MOVE = '678bac1d-7caf-45cc-a6fb-a69039215c46';
const SOURCE = 'b263cba7-18b9-49fe-9650-cf7b073d2c95', TARGET = '255c14ea-4fcc-4a51-b8bc-aa0821239b0a';
const here = path.dirname(fileURLToPath(import.meta.url));
// Win32 OpenSSH can hang on Node's pipe handles even after delivering output.
// Regular files avoid that handle mode; require exit success before reading any
// bytes. The bounded files live beside the owned release and are never reused.
export function readPeerProof(run, args, sourceRoot, platform = process.platform) {
  if (platform !== 'win32') return JSON.parse(run('ssh', args, { timeout: 75000 }));
  for (let attempt = 0; attempt < 3; attempt++) {
  const directory = fs.mkdtempSync(path.join(sourceRoot, '.dormant-peer-'));
  const output = path.join(directory, 'stdout'), error = path.join(directory, 'stderr');
  const out = fs.openSync(output, 'wx', 0o600), err = fs.openSync(error, 'wx', 0o600);
  try {
    run('ssh', args, { timeout: 75000, stdio: ['ignore', out, err] });
    check(fs.statSync(output).size <= 1024 * 1024, 'move-recovery', 'Peer proof exceeds its bounded size');
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  } catch (failure) {
    // Automatic source retries clear the error briefly. Retry observation only;
    // every successful attempt must still pass the complete unchanged proof.
    const reason = fs.statSync(error).size <= 16384 ? fs.readFileSync(error, 'utf8').trim().split('\n').at(-1) : '';
    const retrying = reason === 'AssertionError: Move is not the dormant reviewed failure' || reason === 'AssertionError: Source changed during proof';
    if (!retrying || attempt === 2) throw failure;
  } finally {
    fs.closeSync(out); fs.closeSync(err);
    fs.rmSync(directory, { recursive: true });
  }
  }
}

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";

export function assertDormantProof(decision, source, destination) {
  check(decision.kind === 'reviewed-dormant-pre-reservation' && decision.moveId === DORMANT_MOVE && decision.sourceEnvironmentId === SOURCE && decision.targetEnvironmentId === TARGET, 'move-recovery', 'Only the named reviewed dormant move is authorized');
  const old = decision.source;
  check(old && source.role === 'source' && source.moveId === DORMANT_MOVE && source.nativeId === 'e2c9ee83-178b-4103-8511-bd225c50a053', 'move-recovery', 'Source native identity differs');
  for (const key of ['receiptSha256', 'inputSha256', 'manifestSha256']) check(/^[a-f0-9]{64}$/.test(old[key]) && old[key] === source[key], 'move-recovery', 'Source receipt, input or manifest changed');
  check(JSON.stringify(source.files) === JSON.stringify(old.files) && JSON.stringify(source.pending) === JSON.stringify([DORMANT_MOVE]), 'move-recovery', 'Source capture or pending census changed');
  check(destination.role === 'destination' && destination.moveId === DORMANT_MOVE && ['receipts', 'reservations', 'pending'].every(key => Array.isArray(destination[key]) && destination[key].length === 0), 'move-recovery', 'Destination reservation or another pending move appeared');
}

// Explicit opt-in is part of both pinned manifest and target. Every read is
// authenticated by the existing SSH alias; no owner impersonation or DB writes.
export function verifyDormantMove(m, t, sourceRoot, run, snapshot) {
  const option = m.dormantMoveRecovery;
  check(option && /^[a-f0-9]{64}$/.test(option.sha256), 'move-recovery', 'Missing pinned dormant move decision');
  const file = fileAt(sourceRoot, option.source);
  check(sha(file) === option.sha256, 'move-recovery', 'Dormant move decision changed');
  const decision = read(file), isSource = t.environmentId === SOURCE;
  check(isSource || t.environmentId === TARGET, 'move-recovery', 'Recovery belongs to another environment');
  check(m.compatibility.migrations === 'none', 'move-recovery', 'Dormant recovery is code-only');
  check(m.commit === '8cd7e903964ac68421d3ab96405ec4d047a7920b' && m.version === '0.0.45+custom.53.1', 'move-recovery', 'Recovery must use the accepted custom53 line plus the reviewed fix');
  check(JSON.stringify(snapshot.blockingOperations ?? []) === JSON.stringify(isSource ? ['move:' + DORMANT_MOVE] : []), 'move-recovery', 'Another local ownership operation or move is pending');
  const peer = t.dormantMovePeer;
  check(peer && peer.environmentId === (isSource ? TARGET : SOURCE) && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(peer.ssh) && ['posix', 'powershell'].includes(peer.shell), 'move-recovery', 'Explicit opposite-host SSH proof required');
  const script = path.join(here, 'dormant-move.py'), scriptSha = sha(script);
  const request = (baseDir, role) => Buffer.from(JSON.stringify({ baseDir, role })).toString('base64');
  const local = JSON.parse(run(t.python, ['-B', script, request(t.baseDir, isSource ? 'source' : 'destination')], { timeout: 60000 }));
  const bootstrap = 'import hashlib,pathlib,runpy,sys; p=sys.argv.pop(1); h=sys.argv.pop(1); assert hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()==h; runpy.run_path(p,run_name=__name__)';
  const args = [peer.python, '-B', '-c', bootstrap, peer.script, scriptSha, request(peer.baseDir, isSource ? 'destination' : 'source')];
  check(args.every(a => typeof a === 'string' && a && !/[\x00-\x1f]/.test(a)), 'move-recovery', 'Invalid peer proof command');
  const command = peer.shell === 'posix' ? args.map(quote).join(' ') : 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from('& ' + args.map(psQuote).join(' ') + '; exit $LASTEXITCODE', 'utf16le').toString('base64');
  const remote = readPeerProof(run, ['-n', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '--', peer.ssh, command], sourceRoot);
  // A peer observation can span a retry. Recheck the destination locally after
  // it returns so a newly created reservation cannot borrow the earlier read.
  const destinationNow = isSource ? remote : JSON.parse(run(t.python, ['-B', script, request(t.baseDir, 'destination')], { timeout: 60000 }));
  const source = isSource ? local : remote, destination = destinationNow;
  assertDormantProof(decision, source, destination);
  // Retain the exact original copying/error receipt in the decision; updated_at
  // may advance only for an identical failed automatic retry. Rehash all bytes.
  return { decisionSha256: sha(file), sourceReceiptSha256: source.receiptSha256, observedUpdatedAt: source.receipt.updated_at, proofSha256: digest(JSON.stringify({ source, destination })) };
}
