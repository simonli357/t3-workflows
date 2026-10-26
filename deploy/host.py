"""OS-owned deployment lock, detached launcher, and read-only SQLite evidence.

No SQL mutation, shell=True, credentials in argv, or process-name termination.
"""
import hashlib
import json
import os
import re
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
from contextlib import closing
import uuid


def hashed(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def stable_binding(row):
    payload = json.loads(row.get('runtime_payload_json') or 'null') or {}
    return {**{key: row.get(key) for key in ('provider_name', 'provider_instance_id', 'runtime_mode')},
            'resumeCursor': json.loads(row.get('resume_cursor_json') or 'null'),
            'runtimePayload': {key: payload.get(key) for key in ('cwd', 'model', 'modelSelection')}}


def binding_model(stable):
    # Conservative subset of readPersistedModelSelection's canonical contract.
    # Unknown/legacy/invalid shapes retain the strict legacy fingerprint.
    selection = stable['runtimePayload']['modelSelection']
    def string(value): return isinstance(value, str) and bool(value) and value.strip() == value
    if not isinstance(selection, dict): return None
    instance = selection.get('instanceId')
    if not isinstance(instance, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', instance) or instance != stable['provider_instance_id'] or not string(selection.get('model')): return None
    options = selection.get('options', [])
    if not isinstance(options, list): return None
    ids = set()
    for option in options:
        if not isinstance(option, dict) or not string(option.get('id')) or option['id'] in ids or not (type(option.get('value')) is bool or string(option.get('value'))): return None
        ids.add(option['id'])
    canonical = {**stable, 'runtimePayload': {**stable['runtimePayload'], 'model': selection['model']}}
    return {'sha256': hashed(canonical), 'normalized': stable['runtimePayload']['model'] == selection['model']}


def binding_reconciliation(deployment, candidates, original_text=None):
    """Read-only, exact reconstruction of an old shadow-model fingerprint.

    Output retains the original failed receipt, never replaces its baseline.
    No guessed previous model and no raw binding/cursor are exported.
    """
    root = Path(deployment).absolute()
    if root.resolve(strict=True) != root or root.parent.name != 't3w-deploy' or root.parent.parent.name != 'runtime': raise ValueError('Deployment path')
    def file(name):
        p = root / name
        if p.resolve(strict=True) != p or not p.is_file(): raise ValueError('Evidence path')
        return p
    current_text = file('receipt.json').read_bytes().decode('utf-8')
    original_text = current_text if original_text is None else original_text
    original, current = json.loads(original_text), json.loads(current_text)
    if original['phase'] != 'recovery-required' or current['phase'] not in ('recovery-required', 'verifying', 'accepted'): raise ValueError('Receipt phase')
    if any(original[key] != current[key] for key in ('id', 'manifestHash', 'targetHash', 'before')): raise ValueError('Receipt changed')
    if root.name != original['id'] or not isinstance(candidates, list) or not candidates: raise ValueError('Reconciliation request')
    closed_bytes = file('closed-snapshot.json').read_bytes()
    closed = json.loads(closed_bytes)
    backup_file = file('before-migrations.sqlite')
    backup_proof = json.loads(file('before-migrations.sqlite.json').read_bytes())
    if backup_proof['integrity'] != 'ok' or backup_proof['bytes'] != backup_file.stat().st_size or backup_proof['database'] != closed['database']: raise ValueError('Backup proof')
    # The adapter also imposes its normal 30s child-process deadline. This bound
    # prevents a large retained backup from consuming the detached runner lease.
    deadline = time.monotonic() + 20
    checksum = hashlib.sha256()
    with backup_file.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            checksum.update(chunk)
            if time.monotonic() > deadline: raise TimeoutError('Evidence hash deadline')
    if checksum.hexdigest() != backup_proof['sha256']: raise ValueError('Backup checksum')
    live_file = root.parents[2] / 'userdata' / 'state.sqlite'
    if live_file.resolve(strict=True) != live_file: raise ValueError('Database path')
    def bindings(database):
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as db:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA query_only=ON'); db.execute('BEGIN')
            result = {}
            for candidate in candidates:
                row = db.execute('SELECT * FROM provider_session_runtime WHERE thread_id=?', (candidate['id'],)).fetchone()
                if row is None: raise ValueError('Binding missing')
                result[candidate['id']] = stable_binding(dict(row))
            return result
    backup_rows, live_rows = bindings(backup_file), bindings(live_file)
    entries, seen = [], set()
    for candidate in candidates:
        tid, previous = candidate['id'], candidate['previousModel']
        if tid in seen or not isinstance(previous, str) or not previous or previous.strip() != previous: raise ValueError('Candidate')
        seen.add(tid)
        stable = backup_rows[tid]; model = binding_model(stable)
        if not model or not model['normalized'] or previous == stable['runtimePayload']['model']: raise ValueError('Authority')
        closed_hash = hashed(stable)
        old_hash = hashed({**stable, 'runtimePayload': {**stable['runtimePayload'], 'model': previous}})
        if ('bindings:' + tid not in original['proof']['failures'] or dict(original['before']['bindings']).get(tid) != old_hash or dict(closed['bindings']).get(tid) != closed_hash or hashed(live_rows[tid]) != closed_hash): raise ValueError('Exact binding evidence differs')
        entries.append({'id': tid, 'previousModel': previous, 'fromSha256': old_hash, 'toSha256': closed_hash})
    return {'schema': 1, 'kind': 'binding-model-normalization', 'originalReceiptText': original_text,
            'originalReceiptSha256': hashlib.sha256(original_text.encode()).hexdigest(),
            'closedSnapshotSha256': hashlib.sha256(closed_bytes).hexdigest(), 'backupSha256': checksum.hexdigest(),
            'manifestHash': original['manifestHash'], 'targetHash': original['targetHash'], 'entries': entries}


def check_binding_reconciliation(deployment):
    proof_file = Path(deployment) / 'binding-reconciliation.json'
    if proof_file.resolve(strict=True) != proof_file.absolute(): raise ValueError('Proof path')
    raw = proof_file.read_bytes(); proof = json.loads(raw)
    expected = binding_reconciliation(deployment, proof['entries'], proof['originalReceiptText'])
    if proof != expected: raise ValueError('Reconciliation proof differs')
    return {'sha256': hashlib.sha256(raw).hexdigest(), 'originalReceiptSha256': proof['originalReceiptSha256'], 'entries': proof['entries']}


def prove_claude_cursor(previous, current, activity, transcript):
    """Only append requested turns; a changed assistant anchor needs native ancestry.

    The caller binds previous to the sealed snapshot and locates the transcript
    in the unchanged account configuration. No transcript text is returned.
    """
    allowed = {'turnCount', 'turnStartMessageIds', 'resumeSessionAt'}
    a, b = previous.get('resumeCursor'), current.get('resumeCursor')
    if previous.get('provider_name') != 'claudeAgent' or not isinstance(a, dict) or not isinstance(b, dict): raise ValueError('cursor-provider')
    if {k:v for k,v in previous.items() if k != 'resumeCursor'} != {k:v for k,v in current.items() if k != 'resumeCursor'} or {k:v for k,v in a.items() if k not in allowed} != {k:v for k,v in b.items() if k not in allowed}: raise ValueError('cursor-identity-or-profile')
    native = a.get('resume')
    if not isinstance(native, str) or str(uuid.UUID(native)) != native or a.get('threadId') != activity['id']: raise ValueError('cursor-native-identity')
    old, new = a.get('turnStartMessageIds'), b.get('turnStartMessageIds')
    turns = activity['turnIds']
    if not isinstance(old, list) or not isinstance(new, list) or not turns or new != old + turns or len(set(new)) != len(new) or any(not isinstance(t, str) or not t for t in new): raise ValueError('cursor-turn-prefix')
    if type(a.get('turnCount')) is not int or type(b.get('turnCount')) is not int or a['turnCount'] != len(old) or b['turnCount'] != len(new): raise ValueError('cursor-turn-count')
    path = Path(transcript).absolute()
    if path.resolve(strict=True) != path or not path.is_file() or path.name != native + '.jsonl' or path.stat().st_size > 256 * 1024 * 1024: raise ValueError('cursor-transcript-path')
    nodes = {}
    cwd = current['runtimePayload']['cwd']
    def same_path(value):
        return isinstance(value, str) and os.path.normcase(os.path.normpath(value)) == os.path.normcase(os.path.normpath(cwd))
    with path.open('rb') as stream:
        # A trailing partial write cannot supply proof. Complete records remain
        # valid while the native session appends further tool activity.
        for line, raw in enumerate(stream, 1):
            if not raw.endswith(b'\n'): break
            try: row = json.loads(raw)
            except (ValueError, UnicodeError): raise ValueError('cursor-transcript-json')
            uid = row.get('uuid')
            if not uid: continue
            node = {k:row.get(k) for k in ('uuid', 'parentUuid', 'type', 'sessionId', 'cwd', 'isSidechain', 'subtype', 'logicalParentUuid', 'compactMetadata')}
            if uid in nodes and any(nodes[uid][k] != node[k] for k in node): raise ValueError('cursor-replaced-node')
            nodes[uid] = {**node, 'line': line, 'rawLineSha256': hashlib.sha256(raw).hexdigest()}
    def node(uid, kind=None):
        n = nodes.get(uid)
        if not n or n['sessionId'] != native or not same_path(n['cwd']) or n['isSidechain'] is not False or (kind and n['type'] != kind): raise ValueError('cursor-native-record')
        return n
    old_anchor, anchor = a.get('resumeSessionAt'), b.get('resumeSessionAt')
    node(old_anchor, 'assistant'); node(anchor, 'assistant')
    evidence = {}
    compactions = set()
    def parent(n):
        if n['parentUuid'] is not None: return n['parentUuid']
        if n['type'] != 'system' or n['subtype'] != 'compact_boundary': return None
        # Claude records an explicit logical edge across automatic compaction.
        # Require the retained segment itself, not a timestamp or a claimed
        # logical parent alone, to prove continuity with the original history.
        meta = n.get('compactMetadata') or {}
        segment, preserved = meta.get('preservedSegment', {}), meta.get('preservedMessages', {})
        ids = preserved.get('allUuids')
        if meta.get('trigger') != 'auto' or not isinstance(ids, list) or not ids or len(set(ids)) != len(ids) or preserved.get('uuids') != ids or segment.get('headUuid') != ids[0] or segment.get('tailUuid') != ids[-1] or segment.get('anchorUuid') != preserved.get('anchorUuid') or n.get('logicalParentUuid') != ids[-1]: raise ValueError('cursor-compaction-proof')
        for index, uid in enumerate(ids):
            retained = node(uid)
            if retained['line'] >= n['line'] or (index and retained['parentUuid'] != ids[index - 1]): raise ValueError('cursor-compaction-segment')
            evidence[uid] = retained
        compactions.add(n['uuid'])
        return n['logicalParentUuid']
    def ancestry(start, end):
        chain, seen = [], set()
        while start != end:
            if not start or start in seen: raise ValueError('cursor-anchor-not-descendant')
            seen.add(start); n = node(start); chain.append(start); evidence[start] = n; start = parent(n)
        evidence[end] = node(end)
        return chain
    # Each new native user UUID must itself follow the old anchor and earlier
    # requested turns. This also proves progress when the saved anchor is old.
    previous_turn = old_anchor
    for turn in turns:
        node(turn, 'user'); ancestry(turn, previous_turn); previous_turn = turn
    changed = anchor != old_anchor
    if changed:
        chain = ancestry(anchor, old_anchor)
        if any(t not in chain for t in turns): raise ValueError('cursor-anchor-missing-requested-turn')
    return {'id': activity['id'], 'fromSha256': hashed(previous), 'toSha256': hashed(current),
            'kind': 'requested-claude-cursor-progress', 'turnIds': turns,
            'requestSequences': activity['requestSequences'], 'anchorChanged': changed,
            'anchorDescendsFromPrevious': True if changed else None, 'compactionBoundaryIds': sorted(compactions),
            'transcript': str(path), 'nativeRecords': list(evidence.values())}


def claude_transcript(settings_file, stable):
    settings = json.loads(Path(settings_file).read_text(encoding='utf-8-sig'))
    config = settings.get('providerInstances', {}).get(stable['provider_instance_id'])
    if not isinstance(config, dict) or config.get('driver') != 'claudeAgent': raise ValueError('cursor-account-config')
    home = config.get('config', {}).get('homePath')
    if not isinstance(home, str): raise ValueError('cursor-account-home')
    # Inherited overrides cannot silently redirect the default account.
    if not home and os.environ.get('CLAUDE_CONFIG_DIR'): raise ValueError('cursor-inherited-home')
    base = Path(home).expanduser() if home else Path.home() / '.claude'
    if not base.is_absolute() or base.resolve(strict=True) != base: raise ValueError('cursor-account-path')
    native = stable['resumeCursor'].get('resume')
    if not isinstance(native, str) or str(uuid.UUID(native)) != native: raise ValueError('cursor-native-id')
    matches = list((base / 'projects').glob('*/' + native + '.jsonl'))
    if len(matches) != 1: raise ValueError('cursor-transcript-ambiguous')
    return matches[0]


def activity_reconciliation(deployment, checksum_seconds=30):
    """Prove new work against the sealed pre-activation database, never time alone.

    The backup supplies the event/turn boundary for legacy receipts too. Nothing
    is written, and no prompt, transcript or native resume cursor is exported.
    """
    if type(checksum_seconds) is not int or not 30 <= checksum_seconds <= 120: raise ValueError('Activity checksum budget must be 30..120 seconds')
    root = Path(deployment).absolute()
    if root.resolve(strict=True) != root or root.parent.name != 't3w-deploy' or root.parent.parent.name != 'runtime': raise ValueError('Deployment path')
    def file(name):
        p = root / name
        if p.resolve(strict=True) != p or not p.is_file(): raise ValueError('Evidence path')
        return p
    receipt = json.loads(file('receipt.json').read_bytes())
    if receipt['id'] != root.name or receipt['phase'] not in ('verifying', 'recovery-required', 'accepted'): raise ValueError('Receipt phase')
    journals = [root / name for name in ('desktop-activation.json', 'service-activation.json') if (root / name).exists()]
    if len(journals) != 1 or json.loads(file(journals[0].name).read_bytes()).get('phase') != 'started': raise ValueError('Activation not started')
    closed_bytes = file('closed-snapshot.json').read_bytes()
    closed = json.loads(closed_bytes)
    live_file = root.parents[2] / 'userdata' / 'state.sqlite'
    if live_file.resolve(strict=True) != live_file: raise ValueError('Database path')
    activation = json.loads(file(journals[0].name).read_bytes())
    backup_sha = None
    with closing(sqlite3.connect(live_file.as_uri() + '?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only=ON'); db.execute('BEGIN')
        if 'activityBoundary' in closed or 'closedSnapshotSha256' in activation:
            if activation.get('closedSnapshotSha256') != hashlib.sha256(closed_bytes).hexdigest(): raise ValueError('Closed snapshot seal')
            boundary, previous_turns = check_activity_boundary(db, closed)
            prior = receipt['before'].get('activityBoundary')
            if prior is not None and (not isinstance(prior, dict) or type(prior.get('eventSequence')) is not int or not 0 <= prior['eventSequence'] <= boundary): raise ValueError('Activity boundary predates original snapshot')
        else:
            # Legacy receipts have no sealed watermark. Reconstruct only from
            # their original complete, checksum-verified pre-migration backup.
            backup_file = file('before-migrations.sqlite')
            proof = json.loads(file('before-migrations.sqlite.json').read_bytes())
            if proof['integrity'] != 'ok' or proof['bytes'] != backup_file.stat().st_size or proof['database'] != closed['database']: raise ValueError('Backup proof')
            deadline, checksum = time.monotonic() + checksum_seconds, hashlib.sha256()
            with backup_file.open('rb') as stream:
                while chunk := stream.read(1024 * 1024):
                    checksum.update(chunk)
                    if time.monotonic() > deadline: raise TimeoutError('Activity evidence hash deadline')
            backup_sha = checksum.hexdigest()
            if backup_sha != proof['sha256']: raise ValueError('Backup checksum')
            with closing(sqlite3.connect(backup_file.as_uri() + '?mode=ro', uri=True)) as backup_db:
                backup_db.row_factory = sqlite3.Row
                backup_db.execute('PRAGMA query_only=ON'); backup_db.execute('BEGIN')
                boundary = backup_db.execute('SELECT COALESCE(MAX(sequence),0) FROM orchestration_events').fetchone()[0]
                previous_turns = {r['thread_id']: dict(r) for r in backup_db.execute('SELECT thread_id,row_id,turn_id FROM projection_turns ORDER BY row_id')}
        entries, blocked, binding_entries = [], [], []
        for old in receipt['before']['sessions']:
            if old.get('activeTurnId') or old.get('status') in ('running', 'starting'): continue
            tid = old['id']
            previous = previous_turns.get(tid)
            turns = list(db.execute('SELECT row_id,turn_id,pending_message_id FROM projection_turns WHERE thread_id=? AND row_id>? ORDER BY row_id', (tid, previous['row_id'] if previous else 0)))
            if not turns:
                try:
                    entry = prove_idle_settlement(db, tid, old, next((s for s in closed.get('sessions', []) if s['id'] == tid), None), boundary)
                    if entry: entries.append(entry)
                except ValueError as error:
                    blocked.append({'id': tid, 'reason': str(error)})
                continue
            try:
                if (previous['turn_id'] if previous else None) != old['lastTurnId']: raise ValueError('closed-turn-differs')
                entry = {'id': tid, 'fromLastTurnId': old['lastTurnId'], **prove_activity(db, tid, turns, boundary, allow_delivered_jobs=True)}
                entries.append(entry)
                row = db.execute('SELECT * FROM provider_session_runtime WHERE thread_id=?', (tid,)).fetchone()
                current = stable_binding(dict(row)) if row else None
                sealed_hash = dict(closed['bindings']).get(tid)
                if current and hashed(current) != sealed_hash:
                    # Read only the required baseline row; its exact hash must
                    # match both sealed baselines, independently of file names.
                    with closing(sqlite3.connect(file('before-migrations.sqlite').as_uri() + '?mode=ro', uri=True)) as backup_db:
                        backup_db.row_factory = sqlite3.Row
                        baseline = backup_db.execute('SELECT * FROM provider_session_runtime WHERE thread_id=?', (tid,)).fetchone()
                    if not baseline: raise ValueError('cursor-baseline-missing')
                    previous_binding = stable_binding(dict(baseline))
                    if hashed(previous_binding) != sealed_hash or dict(receipt['before']['bindings']).get(tid) != sealed_hash: raise ValueError('cursor-baseline-seal')
                    binding_entries.append(prove_claude_cursor(previous_binding, current, entry, claude_transcript(live_file.parent / 'settings.json', current)))
            except ValueError as error:
                blocked.append({'id': tid, 'reason': str(error)})
    return {'kind': 'post-activation-work', 'manifestHash': receipt['manifestHash'], 'targetHash': receipt['targetHash'],
            'closedSnapshotSha256': hashlib.sha256(closed_bytes).hexdigest(), 'backupSha256': backup_sha,
            'boundarySource': 'backup' if backup_sha else 'closed-snapshot', 'checksumSeconds': checksum_seconds, 'boundarySequence': boundary, 'entries': entries, 'bindingEntries': binding_entries, 'blocked': blocked}


def check_activity_boundary(db, closed):
    """Validate the journal-sealed transaction watermark against durable rows."""
    boundary = closed.get('activityBoundary')
    if not isinstance(boundary, dict) or set(boundary) != {'schema', 'eventSequence', 'eventSha256', 'turns'} or type(boundary['schema']) is not int or boundary['schema'] != 1: raise ValueError('Activity boundary schema')
    sequence = boundary['eventSequence']
    if type(sequence) is not int or not 0 <= sequence <= 9007199254740991: raise ValueError('Activity event sequence')
    anchor = db.execute('SELECT sequence,aggregate_kind,stream_id,event_type,command_id,actor_kind,payload_json FROM orchestration_events WHERE sequence=?', (sequence,)).fetchone()
    if (sequence == 0 and boundary['eventSha256'] is not None) or (sequence > 0 and (not anchor or hashed(dict(anchor)) != boundary['eventSha256'])): raise ValueError('Activity event anchor')
    sessions = {s['id']: s for s in closed['sessions']}
    if len(sessions) != len(closed['sessions']) or not isinstance(boundary['turns'], list) or len(boundary['turns']) != len(sessions): raise ValueError('Activity thread coverage')
    previous, row_ids = {}, set()
    for item in boundary['turns']:
        if not isinstance(item, list) or len(item) != 3: raise ValueError('Activity turn shape')
        tid, row_id, turn_id = item
        if not isinstance(tid, str) or tid not in sessions or tid in previous or type(row_id) is not int or not 0 <= row_id <= 9007199254740991 or turn_id != sessions[tid]['lastTurnId']: raise ValueError('Activity turn boundary')
        if row_id:
            row = db.execute('SELECT thread_id,turn_id FROM projection_turns WHERE row_id=?', (row_id,)).fetchone()
            if row_id in row_ids or not row or row['thread_id'] != tid or row['turn_id'] != turn_id: raise ValueError('Activity turn anchor')
            row_ids.add(row_id)
        elif turn_id is not None: raise ValueError('Activity missing turn row')
        previous[tid] = {'row_id': row_id, 'turn_id': turn_id}
    return sequence, previous


def prove_idle_settlement(db, tid, old, closed, boundary):
    """An already completed idle turn can be explicitly settled without new work."""
    events = [dict(r) for r in db.execute("SELECT sequence,event_type,command_id,actor_kind,payload_json FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? AND sequence>? AND event_type IN ('thread.settled','thread.unsettled','thread.turn-start-requested','thread.session-set') ORDER BY sequence", (tid, boundary))]
    settlements = [e for e in events if e['event_type'] == 'thread.settled']
    if not settlements: return None
    if not closed or any(s.get('activeTurnId') or s.get('status') not in ('ready', 'stopped') or s.get('settledAt') or s.get('lastTurnState') != 'completed' or not s.get('lastTurnCompletedAt') for s in (old, closed)) or closed['lastTurnId'] != old['lastTurnId'] or closed['lastTurnCompletedAt'] != old['lastTurnCompletedAt']: raise ValueError('settlement-not-originally-completed')
    if len(settlements) != 1 or any(e['event_type'] in ('thread.unsettled', 'thread.turn-start-requested') for e in events): raise ValueError('settlement-lifecycle-ambiguous')
    def accepted(e):
        r = db.execute('SELECT aggregate_kind,aggregate_id,result_sequence,status,error FROM orchestration_command_receipts WHERE command_id=?', (e['command_id'],)).fetchone()
        return r and r['aggregate_kind'] == 'thread' and r['aggregate_id'] == tid and r['status'] == 'accepted' and not r['error'] and r['result_sequence'] >= e['sequence']
    settled = settlements[0]; payload = json.loads(settled['payload_json'])
    if settled['actor_kind'] != 'client' or payload.get('threadId') != tid or not isinstance(payload.get('settledAt'), str) or not payload['settledAt'] or not accepted(settled): raise ValueError('settlement-not-accepted')
    stopped = None
    for e in events:
        if e['event_type'] != 'thread.session-set': continue
        p = json.loads(e['payload_json']); s = p.get('session', {})
        if p.get('threadId') != tid or e['actor_kind'] not in ('server', 'provider') or not accepted(e) or s.get('status') not in ('ready', 'stopped') or s.get('activeTurnId') or s.get('lastError'): raise ValueError('settlement-session-evidence')
        if e['sequence'] > settled['sequence']:
            if s.get('status') != 'stopped': raise ValueError('settlement-not-stopped')
            stopped = e
    if not stopped: raise ValueError('settlement-stop-missing')
    return {'id': tid, 'kind': 'idle-settlement', 'fromLastTurnId': old['lastTurnId'], 'toLastTurnId': old['lastTurnId'], 'turnIds': [], 'settlement': {'settledAt': payload['settledAt'], 'sequence': settled['sequence'], 'stoppedSequence': stopped['sequence']}}


def prove_activity(db, tid, turns, boundary, reviewed_delivery_jobs=(), through_sequence=None, reviewed_native_turns=None, reviewed_startups=(), allow_delivered_jobs=False):
    """Require an accepted client command, its user message and every new turn.

    Provider recovery has no such new request. Worker report job.turn_id belongs
    to the reporting worker, so attribution uses its target and message instead.
    """
    events = [dict(r) for r in db.execute("SELECT sequence,event_type,command_id,actor_kind,payload_json FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? AND sequence>? AND (event_type IN ('thread.turn-start-requested','thread.session-set','thread.unsettled','thread.settled','thread.turn-diff-completed') OR (event_type='thread.message-sent' AND json_extract(payload_json,'$.role')='user')) ORDER BY sequence", (tid, boundary))]
    events = [{**e, 'payload': json.loads(e['payload_json'])} for e in events if (through_sequence is None or e['sequence'] <= through_sequence) and e['event_type'] in ('thread.turn-start-requested', 'thread.message-sent', 'thread.session-set', 'thread.unsettled', 'thread.settled', 'thread.turn-diff-completed')]
    def accepted(event):
        r = db.execute("SELECT aggregate_kind,aggregate_id,result_sequence,status,error FROM orchestration_command_receipts WHERE command_id=?", (event['command_id'],)).fetchone()
        return r and r['aggregate_kind'] == 'thread' and r['aggregate_id'] == tid and r['status'] == 'accepted' and not r['error'] and r['result_sequence'] >= event['sequence']
    requests, turn_ids, unsettled, deliveries = [], [], False, []
    for turn in turns:
        mid, turn_id = turn['pending_message_id'], turn['turn_id']
        if not turn_id or turn_id in turn_ids: raise ValueError('unrequested-turn')
        native = (reviewed_native_turns or {}).get(turn_id) if not mid else None
        if native:
            matches = [e for e in events if e['sequence'] == native['sequence'] and e['event_type'] == 'thread.session-set' and e['payload'].get('session', {}).get('activeTurnId') == turn_id]
            if len(matches) != 1 or not accepted(matches[0]) or matches[0]['actor_kind'] != 'provider' or matches[0]['payload'].get('threadId') != tid: raise ValueError('native-goal-provider-evidence')
            if requests and native['sequence'] <= requests[-1]['sequence']: raise ValueError('turn-order')
            requests.append({**matches[0], 'nativeGoal': True}); turn_ids.append(turn_id)
            continue
        if not mid: raise ValueError('unrequested-turn')
        matches = [e for e in events if e['event_type'] == 'thread.turn-start-requested' and e['payload'].get('messageId') == mid]
        if len(matches) != 1: raise ValueError('request-missing-or-ambiguous')
        request = matches[0]
        if request['actor_kind'] != 'client' or request['payload'].get('threadId') != tid or not accepted(request): raise ValueError('request-not-accepted')
        messages = [e for e in events if e['event_type'] == 'thread.message-sent' and e['payload'].get('messageId') == mid and e['payload'].get('role') == 'user' and e['sequence'] < request['sequence']]
        if len(messages) != 1: raise ValueError('new-user-message-missing')
        message = messages[0]
        projected = db.execute('SELECT thread_id,role,text FROM projection_thread_messages WHERE message_id=?', (mid,)).fetchone()
        if message['actor_kind'] != 'client' or not accepted(message) or message['payload'].get('threadId') != tid or not projected or projected['thread_id'] != tid or projected['role'] != 'user' or projected['text'] != message['payload'].get('text'): raise ValueError('user-message-evidence')
        if mid.startswith('worker-job:'):
            job = db.execute('SELECT id,target_id,kind,prompt,state,attempt FROM custom_worker_jobs WHERE id=?', (mid[len('worker-job:'):],)).fetchone()
            if not job or job['target_id'] != tid or (job['kind'] not in ('work', 'done', 'blocked') and not (job['kind'] in ('message', 'notice') and (allow_delivered_jobs or (job['id'], job['kind']) in reviewed_delivery_jobs))) or job['state'] not in ('submitted', 'completed') or job['prompt'] != projected['text'] or request['command_id'] != 'worker-job:' + job['id'] + ':' + str(job['attempt']): raise ValueError('managed-job-evidence')
            deliveries.append({'id': job['id'], 'kind': job['kind'], 'targetId': tid, 'attempt': job['attempt'], 'state': job['state'], 'turnId': turn_id, 'messageSequence': message['sequence'], 'requestSequence': request['sequence'], 'commandId': request['command_id'], 'promptSha256': hashlib.sha256(projected['text'].encode()).hexdigest()})
        elif request['command_id'].startswith(('worker-job:', 'server:', 'provider:')): raise ValueError('unknown-request-source')
        if requests and request['sequence'] <= requests[-1]['sequence']: raise ValueError('turn-order')
        requests.append(request); turn_ids.append(turn_id)
        if len(requests) == 1:
            unsettled = any(e['event_type'] == 'thread.unsettled' and e['payload'].get('threadId') == tid and e['command_id'] == request['command_id'] and e['actor_kind'] == 'client' and e['sequence'] < request['sequence'] and accepted(e) for e in events)
    # A later genuine request cannot hide an earlier spontaneous start. Likewise
    # a request cannot justify a different provider turn or an extra restart.
    seen_running = set()
    for e in events:
        if e['event_type'] != 'thread.session-set': continue
        s = e['payload'].get('session', {})
        if s.get('status') not in ('starting', 'running') and not s.get('activeTurnId'): continue
        if e['payload'].get('threadId') != tid or e['actor_kind'] not in ('server', 'provider') or not accepted(e): raise ValueError('provider-session-evidence')
        if e['sequence'] in reviewed_startups and s.get('status') == 'starting' and not s.get('activeTurnId'): continue
        preceding = [i for i, r in enumerate(requests) if (r['sequence'] <= e['sequence'] if r.get('nativeGoal') else r['sequence'] < e['sequence'])]
        if not preceding: raise ValueError('unrequested-session-start')
        index = preceding[-1]
        if s.get('activeTurnId'):
            if s['activeTurnId'] != turn_ids[index]: raise ValueError('unrequested-provider-turn')
            seen_running.add(index)
        elif index in seen_running: raise ValueError('unrequested-session-restart')
    if seen_running != set(range(len(turns))): raise ValueError('provider-turn-not-observed')
    entry = {'toLastTurnId': turn_ids[-1], 'turnIds': turn_ids, 'requestSequences': [r['sequence'] for r in requests if not r.get('nativeGoal')], 'nativeGoalSequences': [r['sequence'] for r in requests if r.get('nativeGoal')], 'unsettled': unsettled, 'deliveredJobs': deliveries}
    # A completed assignment may be explicitly settled again. Require its last
    # lifecycle event and accepted completion/idle receipts in sequence order;
    # neither a timestamp alone nor an old settlement authorizes this change.
    lifecycle = [e for e in events if e['event_type'] in ('thread.settled', 'thread.unsettled')]
    settled = lifecycle[-1] if lifecycle else None
    if settled and settled['event_type'] == 'thread.settled' and settled['actor_kind'] == 'client' and settled['payload'].get('threadId') == tid and isinstance(settled['payload'].get('settledAt'), str) and settled['payload']['settledAt'] and accepted(settled):
        preceding = [e for e in events if requests[-1]['sequence'] < e['sequence'] < settled['sequence']]
        completed = any(e['event_type'] == 'thread.turn-diff-completed' and e['payload'].get('threadId') == tid and e['payload'].get('turnId') == turn_ids[-1] and e['actor_kind'] in ('server', 'provider') and accepted(e) for e in preceding)
        sessions = [e for e in preceding if e['event_type'] == 'thread.session-set']
        idle = sessions[-1] if sessions else None
        if completed and idle and idle['payload'].get('threadId') == tid and idle['actor_kind'] in ('server', 'provider') and accepted(idle) and idle['payload']['session'].get('status') in ('ready', 'stopped') and not idle['payload']['session'].get('activeTurnId'):
            entry['settlement'] = {'settledAt': settled['payload']['settledAt'], 'sequence': settled['sequence']}
    return entry


def atomic_json(file, value):
    temporary = file.with_name(file.name + '.' + str(uuid.uuid4()) + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
        json.dump(value, output); output.flush(); os.fsync(output.fileno())
    for attempt in range(21):
        try:
            os.replace(temporary, file)
            break
        except PermissionError as error:
            # Windows readers/antivirus can briefly deny rename. Retain the old
            # complete receipt and retry only this owned metadata replacement.
            if os.name != 'nt' or error.winerror not in (5, 32, 33) or attempt == 20: raise
            time.sleep(0.025)


def database_info(database):
    with closing(sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True)) as db:
        db.execute('PRAGMA query_only=ON'); db.execute('BEGIN')
        return database_metadata(db)


def database_metadata(db):
    schema = [list(r) for r in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
    return {'migrationIds': [r[0] for r in db.execute('SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id')],
            'schemaSha256': hashed(schema),
            'logicalBytes': db.execute('PRAGMA page_count').fetchone()[0] * db.execute('PRAGMA page_size').fetchone()[0]}


def backup(request_file):
    req = json.loads(Path(request_file).read_text(encoding='utf-8'))
    source = Path(req['source']).resolve(strict=True)
    destination = Path(req['destination']).absolute()
    if destination.parent.resolve() != destination.parent or destination.is_symlink(): raise RuntimeError('Unsafe backup path')
    pending = destination.with_name(destination.name + '.partial')
    if pending.is_symlink(): raise RuntimeError('Unsafe partial backup path')
    receipt = destination.with_name(destination.name + '.json')
    if receipt.is_symlink(): raise RuntimeError('Unsafe backup receipt path')
    started = time.monotonic()
    phases = {}
    phase_started = started
    previous_phase = None
    status_file = destination.with_name(destination.name + '.progress.json')
    if status_file.is_symlink(): raise RuntimeError('Unsafe backup progress path')
    def phase(name):
        nonlocal previous_phase, phase_started
        now = time.monotonic()
        if previous_phase: phases[previous_phase] = now - phase_started
        previous_phase, phase_started = name, now
        atomic_json(status_file, {'phase': name, 'elapsedSeconds': now - started, 'secondsByPhase': phases})
    phase('source-metadata')
    def check_source_size(metadata):
        if ('maxSourceBytes' in req and metadata['logicalBytes'] > req['maxSourceBytes']) or ('expectedLogicalBytes' in req and metadata['logicalBytes'] != req['expectedLogicalBytes']):
            raise RuntimeError('Closed source changed or exceeds the migration rehearsal ceiling')
    check_source_size(database_info(source))
    if receipt.exists():
        phase('retained-hash')
        proof = json.loads(receipt.read_text(encoding='utf-8'))
        candidate = destination if destination.exists() else pending
        with candidate.open('rb') as f: checksum = hashlib.file_digest(f, 'sha256').hexdigest()
        if checksum != proof['sha256'] or proof['database']['migrationIds'] != req['migrationIds'] or proof['database']['schemaSha256'] != req['schemaSha256']:
            raise RuntimeError('Retained backup differs')
        if not destination.exists(): pending.rename(destination)
        phase('complete')
        return proof
    if destination.exists(): raise RuntimeError('A retained backup without its proof must be inspected')
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src:
        src.execute('PRAGMA query_only=ON'); src.execute('BEGIN')
        before = database_metadata(src)
        check_source_size(before)
        if before['migrationIds'] != req['migrationIds'] or before['schemaSha256'] != req['schemaSha256']:
            raise RuntimeError('Source schema differs before backup')
        # This exact partial path belongs to this deployment only. Recreate a
        # failed copy, never an accepted backup or anything in the live database.
        if pending.exists(): pending.unlink()
        fd = os.open(pending, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600); os.close(fd)
        deadline = time.monotonic() + 240
        def progress(status, remaining, total):
            if time.monotonic() > deadline: raise TimeoutError('Backup deadline')
        with closing(sqlite3.connect(pending)) as dst:
            phase('copy')
            src.backup(dst, pages=4096, progress=progress)
            phase('integrity')
            if dst.execute('PRAGMA quick_check').fetchone()[0] != 'ok': raise RuntimeError('Backup integrity failure')
            phase('destination-metadata')
            if database_metadata(dst) != before: raise RuntimeError('Backup schema or page count differs')
    phase('fsync')
    with pending.open('r+b') as f: os.fsync(f.fileno())
    phase('hash')
    with pending.open('rb') as f: checksum = hashlib.file_digest(f, 'sha256').hexdigest()
    phase('receipt')
    proof = {'path': str(destination), 'sha256': checksum, 'bytes': pending.stat().st_size, 'database': before, 'integrity': 'ok', 'automaticRestore': False}
    atomic_json(receipt, proof)
    pending.rename(destination)
    if os.name != 'nt':
        directory = os.open(destination.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    phase('complete')
    return proof


def backup_seconds(req):
    seconds = req.get('budgetSeconds', 270)
    if type(seconds) is not int or not 270 <= seconds <= 900:
        raise ValueError('Backup budget must be 270..900 seconds')
    return seconds


def supervised_backup(request_file):
    req = json.loads(Path(request_file).read_text(encoding='utf-8'))
    seconds = backup_seconds(req)
    destination = Path(req['destination']).absolute()
    timing = destination.with_name(destination.name + '.timing.json')
    if destination.parent.resolve() != destination.parent or timing.is_symlink(): raise RuntimeError('Unsafe backup timing path')
    retained = destination.with_name(destination.name + '.json').exists()
    started = time.monotonic()
    # The child owns no service or provider process. Bound ALL phases, including
    # SQLite integrity work, fsync, hashing and retained-proof verification. The
    # adapter leaves ten seconds to reap it and persist the failure receipt.
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    try:
        result = subprocess.run([sys.executable, '-B', str(Path(__file__).resolve()), 'backup-work', str(request_file)],
                                capture_output=True, text=True, timeout=seconds - 10, creationflags=flags)
        if result.returncode: raise RuntimeError('Backup child failed')
        proof = json.loads(result.stdout)
        atomic_json(timing, {'phase': 'complete', 'budgetSeconds': seconds, 'elapsedSeconds': time.monotonic() - started,
                            'freshBackup': not retained, 'backup': proof})
        return proof
    except Exception as error:
        atomic_json(timing, {'phase': 'failed', 'budgetSeconds': seconds, 'elapsedSeconds': time.monotonic() - started,
                            'reason': 'deadline' if isinstance(error, subprocess.TimeoutExpired) else 'backup-failed'})
        raise
    finally:
        if os.name != 'nt':
            directory = os.open(destination.parent, os.O_RDONLY)
            try: os.fsync(directory)
            finally: os.close(directory)


def runner_seconds(req):
    manifest = req.get('manifest', {})
    profile = manifest.get('compatibility', {}).get('database', {}).get('backup', {}) or (manifest.get('measurementBudget', {}) if manifest.get('measurementOnly') is True else {})
    seconds = backup_seconds({'budgetSeconds': profile.get('seconds', 270)})
    checksum = profile.get('checksumSeconds', 30)
    if type(checksum) is not int or not 30 <= checksum <= 120:
        raise ValueError('Checksum budget must be 30..120 seconds')
    verify = req.get('target', {}).get('verifySeconds', 120)
    if type(verify) is not int or not 1 <= verify <= 180:
        raise ValueError('Verification budget must be 1..180 seconds')
    # The original 840s envelope includes 120s acceptance. Preserve its fixed
    # preflight/stop/install margins when a target explicitly requests 180s.
    return 840 if req.get('command') not in ('apply', 'resume', 'measure-backup') else 840 + seconds - 270 + checksum - 30 + max(0, verify - 120)


def snapshot(database):
    db = sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    db.execute('BEGIN')
    # Persist only hashes/metadata, never prompts, transcripts, tokens or resume ids.
    def rows(query):
        return [dict(r) for r in db.execute(query)]

    def pairs(query, key):
        return [[r[key], hashed(dict(r))] for r in db.execute(query)]

    settings_file = Path(database).parent / 'settings.json'
    settings = json.loads(settings_file.read_text(encoding='utf-8-sig')) if settings_file.exists() else {}
    threads = rows('SELECT * FROM projection_threads')
    sessions = {r['thread_id']: r for r in rows('SELECT * FROM projection_thread_sessions')}
    bindings = {r['thread_id']: r for r in rows('SELECT * FROM provider_session_runtime')}
    turns = {r['thread_id']: r for r in rows('SELECT thread_id, row_id, turn_id, state, completed_at FROM projection_turns ORDER BY row_id')}
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    anchor = db.execute('SELECT sequence,aggregate_kind,stream_id,event_type,command_id,actor_kind,payload_json FROM orchestration_events ORDER BY sequence DESC LIMIT 1').fetchone() if 'orchestration_events' in tables else None
    result = {
        'database': database_metadata(db),
        'projects': pairs('SELECT project_id, workspace_root FROM projection_projects', 'project_id'),
        'profiles': pairs('SELECT thread_id, project_id, model_selection_json, runtime_mode, interaction_mode, branch, worktree_path FROM projection_threads', 'thread_id'),
        'history': pairs('SELECT message_id, thread_id, turn_id, created_at FROM projection_thread_messages', 'message_id'),
        # Streaming messages may legitimately grow before shutdown. Completed
        # content must survive byte-for-byte; hash one row at a time in memory.
        'historyContent': pairs('SELECT message_id, role, text, attachments_json, context_json FROM projection_thread_messages WHERE is_streaming=0', 'message_id'),
        # Local progress changes are expected, but WorkerControls' remote/local
        # distinction selects forwarding and must survive alongside owner/plan.
        'ownership': [[r['thread_id'], hashed({**{key: r.get(key) for key in ('thread_id', 'owner_id', 'source_id', 'plan_json')}, 'remote': r.get('state') == 'remote'})] for r in rows('SELECT * FROM custom_workers')],
        'jobs': pairs('SELECT id, worker_id, target_id, kind, prompt, created_at FROM custom_worker_jobs', 'id'),
        'jobStates': [[r['id'], r['state']] for r in rows('SELECT id,state FROM custom_worker_jobs')],
        'bindings': [],
        'bindingModels': [],
        'blockingOperations': [],
        'routes': [],
        'sessions': [],
    }
    if 'orchestration_events' in tables:
        result['activityBoundary'] = {'schema': 1, 'eventSequence': anchor['sequence'] if anchor else 0, 'eventSha256': hashed(dict(anchor)) if anchor else None,
                                      'turns': [[t['thread_id'], turns.get(t['thread_id'], {}).get('row_id', 0), turns.get(t['thread_id'], {}).get('turn_id')] for t in threads]}
    if 'custom_session_moves' in tables:
        for r in rows('SELECT * FROM custom_session_moves'):
            # SessionMoves leaves outgoing complete and incoming cancelled copies
            # locked/parked deliberately. Every other nonterminal state still
            # requires reconciliation, even if its lock is unexpectedly absent.
            terminal = r['state'] in ('complete', 'cancelled') and r['direction'] in ('in', 'out')
            parked = (r['direction'], r['state']) in (('out', 'complete'), ('in', 'cancelled'))
            if not terminal or r['locked'] not in (0, 1) or (r['locked'] == 1 and not parked):
                result['blockingOperations'].append('move:' + r['id'])
    if 'custom_ownership_reservation' in tables:
        result['blockingOperations'] += ['ownership:' + r['id'] for r in rows('SELECT id FROM custom_ownership_reservation')]
    if 'custom_ownership_transactions' in tables:
        result['blockingOperations'] += ['ownership-transaction:' + r['id'] for r in rows("SELECT id FROM custom_ownership_transactions WHERE state NOT IN ('complete','aborted') OR (state='aborted' AND participants_json != '[]')")]
    if 'custom_orchestrator_handoffs' in tables:
        result['blockingOperations'] += ['handoff:' + r['thread_id'] for r in rows("SELECT thread_id FROM custom_orchestrator_handoffs WHERE state NOT IN ('completed','cancelled')")]
    # WorkerControls routes through these actual durable records. Only exclude
    # diagnostic timestamps/errors and the ownership-change announcement outbox
    # bit; authority revisions, terminal locks and transferred ownership remain.
    route_tables = {
        'custom_session_moves': ('id', {'error', 'updated_at'}),
        'custom_session_move_job_aliases': ('incoming_id', set()),
        'custom_orchestrator_authority': ('thread_id', set()),
        'custom_orchestrator_handoffs': ('thread_id', {'error'}),
        'custom_session_ownership_changes': ('id', {'announced'}),
        'custom_ownership_transactions': ('id', {'error'}),
        'custom_worker_reclaims': ('id', set()),
    }
    for table, (key_name, mutable) in sorted(route_tables.items()):
        if table in tables:
            for r in rows('SELECT * FROM "' + table + '"'):
                # Migration 062 adds this durable marker with default zero.
                if table == 'custom_orchestrator_handoffs': r.setdefault('ownership_started', 0)
                key = r.get(key_name)
                if key is None:
                    raise ValueError('Unsupported route schema')
                result['routes'].append([table + ':' + str(key), hashed({k: v for k, v in r.items() if k not in mutable})])
    for tid, b in bindings.items():
        # ProviderService recovery consumes the persisted cursor, cwd, selection
        # and runtime mode. Preserve these for idle providers too, without a turn.
        stable = stable_binding(b)
        result['bindings'].append([tid, hashed(stable)])
        model = binding_model(stable)
        if model: result['bindingModels'].append([tid, model])
    for t in threads:
        tid = t['thread_id']; s = sessions.get(tid, {}); b = bindings.get(tid, {})
        cursor = json.loads(b.get('resume_cursor_json') or 'null') or {}
        payload = json.loads(b.get('runtime_payload_json') or 'null') or {}
        native = cursor.get('threadId') if b.get('provider_name') == 'codex' else cursor.get('resume')
        selection = payload.get('modelSelection')
        result['sessions'].append({
            'id': tid, 'archivedAt': t.get('archived_at'), 'deletedAt': t.get('deleted_at'),
            'snoozedUntil': t.get('snoozed_until'), 'settledAt': t.get('settled_at'),
            'status': s.get('status'), 'activeTurnId': s.get('active_turn_id'),
            'lastTurnId': turns.get(tid, {}).get('turn_id'),
            'lastTurnState': turns.get(tid, {}).get('state'), 'lastTurnCompletedAt': turns.get(tid, {}).get('completed_at'),
            'lastError': bool(s.get('last_error')), 'bindingStatus': b.get('status'),
            'provider': b.get('provider_name'), 'instance': b.get('provider_instance_id'),
            'nativeId': hashed(native) if native else None,
            'profile': hashed(selection) if selection else None,
            'marker': bool(payload.get('continueAfterServerUpdate')),
            'continueOnShutdown': settings.get('projectSettingsOverrides', {}).get(t['project_id'], {}).get('continueThreadsAfterServerUpdate', settings.get('continueThreadsAfterServerUpdate', False)) is True,
        })
    for name in ['settings.json', 'connection-catalog.json', 'saved-environments.json']:
        f = Path(database).parent / name
        if f.exists(): result['routes'].append(['file:' + name, hashlib.sha256(f.read_bytes()).hexdigest()])
    db.close()
    return result


def guard(request_file):
    req = json.loads(Path(request_file).read_text(encoding='utf-8'))
    lifetime = runner_seconds(req)
    base = Path(req['target']['baseDir']).resolve(strict=True)
    lockdir = base / 'runtime' / 't3w-deploy'
    lockdir.mkdir(parents=True, exist_ok=True, mode=0o700)
    runner_receipt = Path(str(request_file) + '.runner.json')
    def report(phase, **details):
        atomic_json(runner_receipt, {'phase': phase, 'pid': os.getpid(), 'updatedAt': time.time(), **details})
    with (lockdir / 'host.lock').open('a+b') as lock:
        try:
            if os.name == 'nt':
                import msvcrt
                if lock.tell() == 0:
                    lock.write(b'0'); lock.flush()
                lock.seek(0); msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            report('busy', code='host-lock')
            print(json.dumps({'phase': 'busy', 'code': 'host-lock'})); return 3
        # Keep the lock until the owned runner exits, including crash recovery.
        try:
            report('running')
            command = [req['node'], req['entry'], '--host-run', str(Path(request_file).resolve())]
            if os.name != 'nt':
                # flock follows the open file description into the engine. An
                # externally killed guard cannot release an active engine's lock.
                result = subprocess.run(command, timeout=lifetime, check=False, pass_fds=(lock.fileno(),), env={**os.environ, 'T3W_GUARD_FD': str(lock.fileno()), 'T3W_RUNNER_DEADLINE_MS': str(int(time.time() * 1000) + lifetime * 1000)}).returncode
                report('finished' if result == 0 else 'failed', exitCode=result)
                return result
            # A Windows lock is process owned. Put only our child into a kill-on-
            # close job before allowing it to run, so it cannot outlive its lock.
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            class BasicLimit(ctypes.Structure):
                _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong), ('PerJobUserTimeLimit', ctypes.c_longlong), ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t), ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD), ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD)]
            class IO(ctypes.Structure):
                _fields_ = [(x, ctypes.c_ulonglong) for x in ['ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount', 'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount']]
            class Limits(ctypes.Structure):
                _fields_ = [('BasicLimitInformation', BasicLimit), ('IoInfo', IO), ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t), ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]
            kernel.CreateJobObjectW.restype = wintypes.HANDLE
            kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
            kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
            kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            job = kernel.CreateJobObjectW(None, None)
            limits = Limits(); limits.BasicLimitInformation.LimitFlags = 0x2800
            if not job or not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                raise RuntimeError('Cannot own runner job')
            # Child blocks on a private pipe until assigned. No updater operation
            # is possible during the create/assign interval.
            child = subprocess.Popen(command, stdin=subprocess.PIPE, env={**os.environ, 'T3W_GUARD_GATE': '1', 'T3W_RUNNER_DEADLINE_MS': str(int(time.time() * 1000) + lifetime * 1000)})
            try:
                if not kernel.AssignProcessToJobObject(job, wintypes.HANDLE(int(child._handle))):
                    child.kill(); child.wait(); raise RuntimeError('Cannot isolate runner job')
                child.stdin.write(b'go\n'); child.stdin.close()
                result = child.wait(timeout=lifetime)
                report('finished' if result == 0 else 'failed', exitCode=result)
                return result
            finally:
                kernel.CloseHandle(job)
        except subprocess.TimeoutExpired:
            # subprocess only terminates the exact child it spawned. Durable handoff
            # receipt remains uncertain; the updater is owned by the service/desktop.
            report('deadline', code='runner-deadline')
            print(json.dumps({'phase': 'recovery-required', 'code': 'runner-deadline'})); return 4
        except Exception as error:
            report('failed', code='runner-failed', errorClass=type(error).__name__, errorNumber=getattr(error, 'winerror', getattr(error, 'errno', None)))
            raise


def launch(request_file):
    req = json.loads(Path(request_file).read_text(encoding='utf-8'))
    args = [sys.executable, str(Path(__file__).resolve()), 'guard', str(Path(request_file).resolve())]
    if os.name == 'nt':
        # Break away from Electron/provider job objects. If policy refuses this,
        # launch fails before any updater RPC. No fallback to an attached child.
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_BREAKAWAY_FROM_JOB
        proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, creationflags=flags)
        return {'phase': 'launched', 'pid': proc.pid, 'mechanism': 'windows-breakaway'}
    unit = 't3w-deploy-' + hashed(str(Path(request_file).resolve()))[:20]
    completed = subprocess.run(['systemd-run', '--user', '--quiet', '--collect', '--unit=' + unit,
                                '--property=RuntimeMaxSec=' + str(runner_seconds(req) + 60), '--property=UMask=0077',
                                '--property=StandardOutput=null', '--property=StandardError=null',
                                '--', *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    if completed.returncode:
        raise RuntimeError('Independent systemd user runner unavailable')
    return {'phase': 'launched', 'unit': unit, 'mechanism': 'systemd-user'}


def start_desktop(request_file):
    if os.name != 'nt': raise RuntimeError('Windows desktop only')
    req = json.loads(Path(request_file).read_text(encoding='utf-8'))
    executable = Path(req['executable']).resolve(strict=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(('T3', 'VITE_')) and k != 'ELECTRON_RUN_AS_NODE'}
    startup = subprocess.STARTUPINFO(); startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW; startup.wShowWindow = 0
    child = subprocess.Popen([str(executable)], cwd=executable.parent, env=env, startupinfo=startup,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_BREAKAWAY_FROM_JOB, close_fds=True)
    return {'started': True, 'pid': child.pid}


if __name__ == '__main__':
    try:
        operation, arg = sys.argv[1:]
        if operation == 'snapshot': print(json.dumps(snapshot(arg)))
        elif operation == 'database-info': print(json.dumps(database_info(arg)))
        elif operation == 'backup': print(json.dumps(supervised_backup(arg)))
        elif operation == 'backup-work': print(json.dumps(backup(arg)))
        elif operation == 'binding-reconciliation':
            request = json.loads(Path(arg).read_text(encoding='utf-8'))
            print(json.dumps(binding_reconciliation(request['deployment'], request['candidates'])))
        elif operation == 'binding-reconciliation-check': print(json.dumps(check_binding_reconciliation(arg)))
        elif operation == 'activity-reconciliation':
            request = json.loads(arg)
            print(json.dumps(activity_reconciliation(request['deployment'], request['checksumSeconds'])))
        elif operation == 'guard': sys.exit(guard(arg))
        elif operation == 'launch': print(json.dumps(launch(arg)))
        elif operation == 'start-desktop': print(json.dumps(start_desktop(arg)))
        else: raise ValueError('Unknown operation')
    except Exception:
        # Native subprocess errors may contain full argv or credentials. Keep those
        # out of receipts and coordinator output.
        print(json.dumps({'phase': 'failed', 'code': 'host-helper', 'message': 'Host helper failed; inspect schema, paths, Python and detached-runner support'}))
        sys.exit(1)
