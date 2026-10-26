"""Read-only, bounded proof for the explicitly reviewed pre-reservation recovery.

No lifecycle mutation, native launch, workspace adoption or recursive scan.
"""
import base64
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

MOVE = '678bac1d-7caf-45cc-a6fb-a69039215c46'
THREAD = '70fc38bd-1401-402e-acb0-2ac5085d0d83'
NATIVE = 'e2c9ee83-178b-4103-8511-bd225c50a053'
SOURCE = 'b263cba7-18b9-49fe-9650-cf7b073d2c95'
TARGET = '255c14ea-4fcc-4a51-b8bc-aa0821239b0a'
ERROR = ('myalien: Session workspace ' + THREAD + ': The destination job path already exists without an active binding. '
         'Retry its original reservation or recover it through the lifecycle owner.')


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def proof(base, role):
    assert role in ('source', 'destination'), 'Unknown recovery role'
    database = Path(base) / 'userdata/state.sqlite'
    db = sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    db.execute('BEGIN')
    def rows(query, args=()):
        return [dict(r) for r in db.execute(query, args)]
    moves = rows("SELECT * FROM custom_session_moves WHERE state NOT IN ('complete','cancelled') OR locked NOT IN (0,1) OR (locked=1 AND NOT ((direction='out' AND state='complete') OR (direction='in' AND state='cancelled')))")
    assert [r['id'] for r in moves] == ([MOVE] if role == 'source' else []), 'Another move is pending'
    assert not rows('SELECT id FROM custom_ownership_reservation LIMIT 1'), 'Ownership reservation active'
    assert not rows("SELECT id FROM custom_ownership_transactions WHERE state NOT IN ('complete','aborted') OR (state='aborted' AND participants_json != '[]') LIMIT 1"), 'Ownership transaction active'
    assert not rows("SELECT thread_id FROM custom_orchestrator_handoffs WHERE state NOT IN ('completed','cancelled') LIMIT 1"), 'Handoff active'
    records = rows('SELECT * FROM custom_session_moves WHERE id=? OR thread_id=? OR target_thread_id=?', (MOVE, THREAD, THREAD))
    reservations = rows('SELECT * FROM session_workspaces WHERE thread_id=? OR reservation_id=?', (THREAD, 'move:' + MOVE))
    if role == 'destination':
        assert records == [] and reservations == [], 'Destination receipt or reservation appeared'
        db.close()
        return {'role': role, 'moveId': MOVE, 'receipts': [], 'reservations': [], 'pending': []}
    assert len(records) == 1, 'Source receipt is ambiguous'
    row = records[0]
    assert row['id'] == MOVE and row['thread_id'] == THREAD and row['target_thread_id'] == THREAD, 'Move identity differs'
    assert row['direction'] == 'out' and row['peer_environment_id'] == TARGET, 'Move route differs'
    assert row['state'] == 'copying' and row['locked'] == 1 and row['error'] == ERROR, 'Move is not the dormant reviewed failure'
    manifest = json.loads(row['manifest_json'])
    assert manifest['input'] == json.loads(row['input_json']), 'Input differs from capture'
    assert manifest['input']['requestId'] == MOVE and manifest['input']['threadId'] == THREAD, 'Capture identity differs'
    assert manifest['sourceEnvironmentId'] == SOURCE and manifest['targetEnvironmentId'] == TARGET, 'Capture route differs'
    assert manifest['nativeId'] == NATIVE and manifest['driver'] == 'claudeAgent', 'Native identity differs'
    assert manifest['resumeCursor']['resume'] == NATIVE, 'Native cursor differs'
    session = rows('SELECT * FROM projection_thread_sessions WHERE thread_id=?', (THREAD,))
    assert len(session) == 1 and session[0]['status'] == 'stopped' and session[0]['active_turn_id'] is None, 'Source native session is active'
    assert not rows("SELECT turn_id FROM projection_turns WHERE thread_id=? AND state IN ('running','pending') LIMIT 1", (THREAD,)), 'Source turn is active'
    assert len(reservations) == 1 and reservations[0]['active'] == 1, 'Source workspace differs'
    binding = json.loads(reservations[0]['binding_json'])
    staging = Path(binding['tmpDirectory']) / 'session-moves' / MOVE
    assert staging.resolve() == staging and staging.is_dir(), 'Noncanonical staging directory'
    assert len(manifest['files']) <= 64 and sum(f['bytes'] for f in manifest['files']) <= 2 * 1024**3, 'Capture exceeds bounded verification'
    files = []
    for f in manifest['files']:
        relative = Path(f['kind']) / f['name']
        assert not relative.is_absolute() and '..' not in relative.parts, 'Unsafe capture path'
        path = staging / relative
        assert path.resolve() == path and path.is_file(), 'Noncanonical capture file'
        with path.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        assert path.stat().st_size == f['bytes'] and actual == f['sha256'], 'Capture file changed'
        files.append({'path': str(path), 'bytes': f['bytes'], 'sha256': actual})
    # Error is cleared BEFORE any automatic retry starts. Re-read outside the
    # snapshot after hashing so an active retry cannot borrow its old error.
    db.rollback()
    current = rows('SELECT * FROM custom_session_moves WHERE id=?', (MOVE,))
    stable = lambda r: {k: v for k, v in r.items() if k != 'updated_at'}
    assert len(current) == 1 and stable(current[0]) == stable(row), 'Source changed during proof'
    row = current[0]
    db.close()
    stable = {k: v for k, v in row.items() if k != 'updated_at'}
    return {'role': role, 'moveId': MOVE, 'receipt': row, 'receiptSha256': digest(json.dumps(stable, sort_keys=True, separators=(',', ':'))),
            'inputSha256': digest(row['input_json']), 'manifestSha256': digest(row['manifest_json']),
            'nativeId': NATIVE, 'files': files, 'pending': [MOVE]}


if __name__ == '__main__':
    request = json.loads(base64.b64decode(sys.argv[1]))
    print(json.dumps(proof(request['baseDir'], request['role']), separators=(',', ':')))
