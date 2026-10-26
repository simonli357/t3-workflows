"""Read-only proof for the primary's exact installed50 forward decisions."""
import sys
sys.dont_write_bytecode = True
import json, hashlib, sqlite3, importlib.util
from datetime import datetime
from pathlib import Path
from contextlib import closing, ExitStack

spec = importlib.util.spec_from_file_location('deploy_host', Path(__file__).with_name('host.py'))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()

def accepted(db, event):
    row = db.execute('SELECT * FROM orchestration_command_receipts WHERE command_id=?', (event['command_id'],)).fetchone()
    return row and row['aggregate_kind'] == 'thread' and row['aggregate_id'] == event['stream_id'] and row['status'] == 'accepted' and row['error'] is None and row['result_sequence'] >= event['sequence']

def native_goal_turns(policy, old, turns, db, boundary, through):
    goal = policy.get('nativeGoal')
    if not goal or old['id'] != goal['threadId']: return {}
    if old['provider'] != 'codex' or old['instance'] != goal['instance'] or old['nativeId'] != host.hashed(goal['nativeThreadId']): raise ValueError('Native goal identity differs')
    path = Path(goal['rollout'])
    if path.resolve(strict=True) != path: raise ValueError('Native goal rollout path differs')
    anchors = dict(goal['anchors']); checked = set(); known = {goal['rootTurnId']}; native = {}
    with path.open('rb') as f:
        for number, raw in enumerate(f, 1):
            if number in anchors:
                if hashlib.sha256(raw).hexdigest() != anchors[number]: raise ValueError('Native goal authorization changed')
                checked.add(number)
            # Ignore an incomplete final write; required turns must still exist.
            if not raw.endswith(b'\n'): break
            event = json.loads(raw); payload = event.get('payload', {})
            if event.get('type') != 'event_msg' or payload.get('type') != 'task_started': continue
            a = payload.get('turn_attribution', {})
            if a.get('turn_trigger') != 'goal' or a.get('root_turn_id') != goal['rootTurnId']: continue
            turn = payload.get('turn_id')
            if number <= max(anchors) or a.get('turn_id') != turn or a.get('parent_turn_id') not in known or payload.get('root_turn_id') != goal['rootTurnId'] or turn in native: raise ValueError('Native goal ancestry differs')
            known.add(turn); native[turn] = {'line': number, 'rawLineSha256': hashlib.sha256(raw).hexdigest(), 'rootTurnId': goal['rootTurnId'], 'parentTurnId': a['parent_turn_id']}
    if checked != set(anchors): raise ValueError('Native goal authorization missing')
    result = {}
    for turn in turns:
        if turn['pending_message_id']: continue
        turn_id = turn['turn_id']
        if turn_id not in native: raise ValueError('Native goal turn missing')
        rows = list(db.execute("SELECT sequence,payload_json FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? AND sequence>? AND event_type='thread.session-set' AND json_extract(payload_json,'$.session.activeTurnId')=? ORDER BY sequence", (old['id'], boundary, turn_id)))
        rows = [r for r in rows if through is None or r['sequence'] <= through]
        if not rows: raise ValueError('Native goal provider start missing')
        for row in rows:
            session = json.loads(row['payload_json'])['session']
            if session.get('providerName') != 'codex' or session.get('providerInstanceId') != goal['instance'] or session.get('status') != 'running': raise ValueError('Native goal provider identity differs')
        result[turn_id] = {**native[turn_id], 'sequence': rows[0]['sequence']}
    return result

def coalesced_startup(db, policy, tid):
    pins = policy.get('coalescedStartup', [])
    if not pins or tid != policy['nativeGoal']['threadId']: return ()
    for pin in pins:
        row = db.execute('SELECT * FROM orchestration_events WHERE sequence=?', (pin['sequence'],)).fetchone()
        if not row or any(row[k] != pin[k] for k in ('event_id','event_type','command_id','actor_kind','occurred_at')) or row['stream_id'] != tid or row['aggregate_kind'] != 'thread' or not accepted(db,row): raise ValueError('Coalesced startup receipt differs')
        payload = json.loads(row['payload_json'])
        if {k:v for k,v in payload.items() if k not in ('text','content','delta','diff')} != pin['payload']: raise ValueError('Coalesced startup payload differs')
        if pin['event_type'] == 'thread.message-sent':
            message = db.execute('SELECT thread_id,role,text FROM projection_thread_messages WHERE message_id=?',(payload['messageId'],)).fetchone()
            if not message or message['thread_id'] != tid or message['role'] != 'user' or message['text'] != payload.get('text'): raise ValueError('Coalesced startup message differs')
    # Exactly this accepted message was immediately superseded by the accepted
    # user request before a provider turn existed. The following actual turn
    # still has to pass the normal complete request/provider checks.
    mid = pins[0]['payload']['messageId'];jid=mid.removeprefix('worker-job:')
    job = db.execute('SELECT target_id,kind,state,prompt,attempt FROM custom_worker_jobs WHERE id=?',(jid,)).fetchone()
    message = db.execute('SELECT text FROM projection_thread_messages WHERE message_id=?',(mid,)).fetchone()
    if not job or job['target_id'] != tid or job['kind'] != 'message' or job['state'] not in ('submitted','completed') or job['prompt'] != message['text'] or pins[1]['command_id'] != 'worker-job:'+jid+':'+str(job['attempt']): raise ValueError('Coalesced startup job differs')
    return (pins[2]['sequence'],)

IDENTITY = ('nativeId', 'instance', 'provider', 'profile')
MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024

def event_shape(kind, payload):
    if kind == 'thread.session-set':
        s = payload.get('session') or {}
        return [s.get('status'), s.get('providerName'), s.get('providerInstanceId'), s.get('activeTurnId'), s.get('runtimeMode')]
    if kind == 'thread.turn-start-requested': return [payload.get('messageId'), payload.get('modelSelection'), payload.get('runtimeMode'), payload.get('interactionMode'), sorted(payload)]
    if kind == 'thread.message-sent': return [payload.get('messageId'), payload.get('role'), payload.get('turnId'), payload.get('streaming'), sorted(payload)]
    return sorted(payload)

def thread_selection(db, tid):
    row = db.execute('SELECT model_selection_json,runtime_mode,interaction_mode,branch,worktree_path,deleted_at FROM projection_threads WHERE thread_id=?', (tid,)).fetchone()
    if not row or row['deleted_at']: return None
    return {'modelSelection': json.loads(row['model_selection_json']), 'runtimeMode': row['runtime_mode'], 'interactionMode': row['interaction_mode'], 'branch': row['branch'], 'worktreePath': row['worktree_path']}

def runtime_binding(db, tid):
    row = db.execute('SELECT * FROM provider_session_runtime WHERE thread_id=?', (tid,)).fetchone()
    return host.stable_binding(dict(row)) if row else None

def binding_matches(stable, side, workspace, runtime_mode):
    native = (stable['resumeCursor'] or {}).get('threadId'); payload = stable['runtimePayload']
    return bool(native) and bool(payload['modelSelection']) and stable['provider_name'] == side['provider'] and stable['provider_instance_id'] == side['instance'] and stable['runtime_mode'] == runtime_mode and host.hashed(stable) == side['binding'] and host.hashed(native) == side['nativeId'] and host.hashed(payload['modelSelection']) == side['profile'] and payload['cwd'] == workspace

def instance_home(settings, instance):
    home = ((settings.get('providerInstances') or {}).get(instance) or {}).get('config', {}).get('homePath')
    if not isinstance(home, str) or not home.startswith('/'): raise ValueError('Identity instance home differs')
    return Path(home)

def parse_time(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))

def canonical_file(path):
    try: return path.resolve(strict=True) == path and path.is_file()
    except OSError: return False

def retained_transcript(pin, home, workspace):
    path = Path(pin['path'])
    if not canonical_file(path) or home / 'sessions' not in path.parents or path.stat().st_size != pin['bytes']: raise ValueError('Original native transcript is not retained')
    checksum, total = hashlib.sha256(), 0
    with path.open('rb') as f:
        header = f.readline(); checksum.update(header); total += len(header)
        while chunk := f.read(1 << 20): checksum.update(chunk); total += len(chunk)
    meta = json.loads(header); payload = meta.get('payload') or {}
    if total != pin['bytes'] or checksum.hexdigest() != pin['sha256'] or meta.get('type') != 'session_meta' or payload.get('id') != pin['nativeThreadId'] or payload.get('cwd') != workspace: raise ValueError('Original native transcript differs')

def current_transcript(pin, home, workspace, selection, started, running):
    path = Path(pin['path'])
    if not canonical_file(path) or home / 'sessions' not in path.parents or path.stat().st_size > MAX_TRANSCRIPT_BYTES: raise ValueError('New native transcript differs')
    model = selection['modelSelection']['model']
    effort = {o['id']: o['value'] for o in selection['modelSelection'].get('options', [])}.get('reasoningEffort')
    contexts, header = 0, None
    with path.open('rb') as f:
        for number, raw in enumerate(f, 1):
            # An incomplete final line is still being written; every complete line must match.
            if not raw.endswith(b'\n'): break
            if number > 1 and b'"turn_context"' not in raw: continue
            event = json.loads(raw); payload = event.get('payload') or {}
            if number == 1: header = (event.get('type'), payload.get('id'), payload.get('cwd'), payload.get('timestamp')); continue
            if event.get('type') != 'turn_context': continue
            contexts += 1
            if payload.get('model') != model or (payload.get('effort') or payload.get('reasoning_effort')) != effort or payload.get('cwd') != workspace: raise ValueError('New native transcript does not match the selected profile/workspace')
    # The native thread must have been created by THIS provider start, between its accepted request and its running event.
    if not header or header[:3] != ('session_meta', pin['nativeThreadId'], workspace) or not isinstance(header[3], str) or not contexts or not parse_time(started) <= parse_time(header[3]) <= parse_time(running): raise ValueError('New native transcript does not match the selected profile/workspace')

def prove_identity_transition(db, retained, transition, before, old, current, closed, settings):
    tid, old_side, new_side, selection, command, pins = transition['id'], transition['from'], transition['to'], transition['selection'], transition['command'], transition['transcripts']
    workspace = selection['worktreePath']
    if old['id'] != tid or current['id'] != tid or not closed or retained is None or not settings: raise ValueError('Identity transition thread differs')
    if any(old.get(k) != old_side[k] for k in IDENTITY) or any(current.get(k) != new_side[k] for k in IDENTITY) or old_side['instance'] == selection['modelSelection']['instanceId'] or new_side['instance'] != selection['modelSelection']['instanceId']: raise ValueError('Identity transition endpoints differ')
    for snapshot, key in ((before, 'before'), (closed, 'closed')):
        pin = transition['boundaries'][key]
        if host.check_activity_boundary(db, snapshot)[0] != pin['eventSequence'] or snapshot['activityBoundary']['eventSequence'] != pin['eventSequence'] or snapshot['activityBoundary']['eventSha256'] != pin['eventSha256']: raise ValueError('Identity transition boundary differs')
    sequence, previous = host.check_activity_boundary(db, closed)
    if previous[tid]['turn_id'] != old['lastTurnId']: raise ValueError('Identity transition boundary differs')
    rows = list(db.execute("SELECT * FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? AND sequence>? AND sequence<=? ORDER BY sequence", (tid, sequence, transition['chain'][-1][0])))
    if [[r['sequence'], r['event_id'], r['event_type'], r['command_id'], r['actor_kind'], r['occurred_at'], event_shape(r['event_type'], json.loads(r['payload_json']))] for r in rows] != transition['chain'] or not all(accepted(db, r) for r in rows): raise ValueError('Identity transition event chain differs')
    # The exact chain ends with the provider reporting the first turn running, after exactly one accepted turn request.
    requests, last = [r for r in rows if r['event_type'] == 'thread.turn-start-requested'], json.loads(rows[-1]['payload_json']).get('session') or {}
    if len(requests) != 1 or requests[0]['command_id'] != command['id'] or requests[0]['sequence'] != command['resultSequence'] or rows[-1]['event_type'] != 'thread.session-set' or last.get('status') != 'running' or last.get('activeTurnId') != command['firstTurnId']: raise ValueError('Identity transition event chain differs')
    receipt = db.execute('SELECT aggregate_kind,aggregate_id,status,error,result_sequence FROM orchestration_command_receipts WHERE command_id=?', (command['id'],)).fetchone()
    if not receipt or tuple(receipt) != ('thread', tid, 'accepted', None, command['resultSequence']): raise ValueError('Identity transition command receipt differs')
    job = db.execute('SELECT id,target_id,kind,state,attempt,prompt FROM custom_worker_jobs WHERE id=?', (command['jobId'],)).fetchone()
    message = db.execute('SELECT thread_id,role,text FROM projection_thread_messages WHERE message_id=?', (command['messageId'],)).fetchone()
    sent = [json.loads(r['payload_json']) for r in rows if r['event_type'] == 'thread.message-sent' and r['command_id'] == command['id']]
    if not job or not message or len(sent) != 1 or job['id'] != command['jobId'] or job['target_id'] != tid or job['kind'] != command['jobKind'] or job['attempt'] != command['attempt'] or job['state'] not in ('submitted', 'completed') or command['id'] != 'worker-job:' + job['id'] + ':' + str(job['attempt']) or command['messageId'] != 'worker-job:' + job['id'] or hashlib.sha256((job['prompt'] or '').encode()).hexdigest() != command['promptSha256'] or message['thread_id'] != tid or message['role'] != 'user' or message['text'] != job['prompt'] or sent[0].get('text') != job['prompt'] or sent[0].get('threadId') != tid: raise ValueError('Identity transition worker job differs')
    first = db.execute('SELECT turn_id,pending_message_id FROM projection_turns WHERE thread_id=? AND row_id>? ORDER BY row_id LIMIT 1', (tid, previous[tid]['row_id'])).fetchone()
    if not first or first['turn_id'] != command['firstTurnId'] or first['pending_message_id'] != command['messageId']: raise ValueError('Identity transition first turn differs')
    if thread_selection(db, tid) != selection or thread_selection(retained, tid) != selection or host.hashed(selection['modelSelection']) != new_side['profile']: raise ValueError('Identity transition selection differs')
    live_binding, original_binding = runtime_binding(db, tid), runtime_binding(retained, tid)
    if not live_binding or not original_binding or not binding_matches(live_binding, new_side, workspace, selection['runtimeMode']) or not binding_matches(original_binding, old_side, workspace, selection['runtimeMode']): raise ValueError('Identity transition binding differs')
    if pins['old']['nativeThreadId'] != original_binding['resumeCursor']['threadId'] or pins['new']['nativeThreadId'] != live_binding['resumeCursor']['threadId'] or pins['old']['instance'] != old_side['instance'] or pins['new']['instance'] != new_side['instance'] or pins['old']['cwd'] != workspace or pins['new']['cwd'] != workspace: raise ValueError('Identity transition transcript pins differ')
    retained_transcript(pins['old'], instance_home(settings, old_side['instance']), workspace)
    current_transcript(pins['new'], instance_home(settings, new_side['instance']), workspace, selection, requests[0]['occurred_at'], rows[-1]['occurred_at'])
    return {'id': tid, 'kind': transition['kind'], 'transitionSha256': digest(transition), 'boundaries': transition['boundaries'], 'from': old_side, 'to': new_side, 'commandResultSequence': command['resultSequence'], 'originalTranscriptRetained': True, 'newTranscriptMatchesSelection': True, 'nativeIdentityEquality': False, 'continuity': 'unproven'}

def prove_rows(db, policy, before, current_sessions, closed=None, retained=None, settings=None):
    events = []
    for expected in policy['events']:
        sequence, command, tid, kind, field, timestamp, event_id = expected
        e = db.execute('SELECT * FROM orchestration_events WHERE sequence=?', (sequence,)).fetchone()
        if not e or e['event_id'] != event_id or (e['command_id'], e['stream_id'], e['event_type'], e['aggregate_kind'], e['actor_kind'], e['occurred_at']) != (command, tid, kind, 'thread', 'client', timestamp): raise ValueError('Reviewed lifecycle event differs')
        payload, metadata = json.loads(e['payload_json']), json.loads(e['metadata_json'])
        if payload.get('threadId') != tid or payload.get(field) != timestamp or metadata.get('origin') != {'surface': 'web', 'appVersion': '0.0.45+custom.50'} or not accepted(db, e): raise ValueError('Reviewed lifecycle provenance differs')
        events.append(expected)
    jobs, job_evidence = [], []
    for job_id, kind, state in policy['jobs']:
        j = db.execute('SELECT * FROM custom_worker_jobs WHERE id=?', (job_id,)).fetchone()
        target = policy['events'][0][2]
        if not j or j['target_id'] != target or j['kind'] != kind or j['state'] != state: raise ValueError('Reviewed deletion job differs')
        error = j['error']
        if state == 'error' and error != policy['deletedTargetError']: raise ValueError('Reviewed deletion job error differs')
        if state == 'cancelled' and error != policy['cancelledNoticeError']: raise ValueError('Reviewed notice error differs')
        jobs.append([job_id, kind, state]); job_evidence.append({'id': job_id, 'target': target, 'kind': kind, 'state': state, 'error': error})
    activity, preclosed, identity = [], [], []
    old_by_id = {s['id']: s for s in before['sessions']}
    for current in current_sessions:
        tid = current['id']
        if tid not in policy['activitySessionIds']: continue
        old = old_by_id[tid]
        if current['lastTurnId'] == old['lastTurnId']: continue
        # Original active sessions remain subject to the unchanged native
        # continuation branch of preservation(), not idle-activity exceptions.
        if old['status'] == 'running' and old.get('activeTurnId') and not any(old.get(k) for k in ('archivedAt','deletedAt','settledAt','snoozedUntil')): continue
        sealed = next((s for s in (closed or {}).get('sessions', []) if s['id'] == tid), None)
        before_close = bool(sealed and sealed['status'] == 'running' and sealed.get('activeTurnId') and not any(sealed.get(k) for k in ('archivedAt','deletedAt','settledAt','snoozedUntil')))
        if any(current.get(k) != old.get(k) for k in IDENTITY):
            # Only an exactly pinned, fully proven transition of THIS thread may change its native identity.
            transition = next((t for t in policy.get('identityTransitions', []) if t['id'] == tid), None)
            if not transition or before_close: raise ValueError('Activity changed native identity')
            identity.append(prove_identity_transition(db, retained, transition, before, old, current, closed, settings))
        target = sealed if before_close else current
        through = host.check_activity_boundary(db, closed)[0] if before_close else None
        anchor = db.execute('SELECT row_id,turn_id FROM projection_turns WHERE thread_id=? AND turn_id=?', (tid, old['lastTurnId'])).fetchone()
        tip = db.execute('SELECT row_id,turn_id FROM projection_turns WHERE thread_id=? AND turn_id=?', (tid, target['lastTurnId'])).fetchone()
        if not anchor or not tip or tip['row_id'] <= anchor['row_id']: raise ValueError('Activity turn anchors differ')
        # This exact original50 receipt has a sealed event/turn watermark.
        # Reuse the reviewed validator, with the ORIGINAL before boundary.
        boundary, _ = host.check_activity_boundary(db, before)
        turns = list(db.execute('SELECT row_id,turn_id,pending_message_id FROM projection_turns WHERE thread_id=? AND row_id>? AND row_id<=? ORDER BY row_id', (tid, anchor['row_id'], tip['row_id'])))
        deliveries = []
        for turn in turns:
            mid = turn['pending_message_id'] or ''
            if not mid.startswith('worker-job:'): continue
            job_id = mid[len('worker-job:'):]
            job = db.execute('SELECT kind,target_id FROM custom_worker_jobs WHERE id=?', (job_id,)).fetchone()
            if job and job['target_id'] == tid and ((job['kind'] == 'message' and job_id.startswith(('message:', 'peer:'))) or (job['kind'] == 'notice' and job_id.startswith('notice:'))): deliveries.append((job_id, job['kind']))
        native = native_goal_turns(policy, old, turns, db, boundary, through)
        entry = host.prove_activity(db, tid, turns, boundary, tuple(deliveries), through, native, coalesced_startup(db, policy, tid))
        entry['nativeGoalEvidence'] = native
        entry['reviewedDeliveryJobs'] = deliveries
        if entry['toLastTurnId'] != target['lastTurnId']: raise ValueError('Activity tip differs')
        (preclosed if before_close else activity).append({'id': tid, 'fromLastTurnId': old['lastTurnId'], **entry})
    return events, jobs, job_evidence, activity, preclosed, identity

def prove(request):
    root = Path(request['deployment']).absolute()
    if root.resolve(strict=True) != root or root.name != request['policy']['deploymentId'] or root.parent.name != 't3w-deploy': raise ValueError('Forward deployment path')
    raw = (root/'receipt.json').read_bytes(); closed_raw = (root/'closed-snapshot.json').read_bytes()
    review = request['review']; policy = request['policy']
    if hashlib.sha256(raw).hexdigest() != review['originalReceiptSha256'] or hashlib.sha256(closed_raw).hexdigest() != review['closedSnapshotSha256'] or digest(policy) != review['policySha256']: raise ValueError('Forward boundary pin differs')
    receipt, closed = json.loads(raw), json.loads(closed_raw)
    if receipt['id'] != policy['deploymentId'] or receipt['phase'] != 'recovery-required': raise ValueError('Original failure differs')
    settings = root.parents[2]/'userdata/settings.json'
    if settings.resolve(strict=True) != settings: raise ValueError('Current settings differs')
    settings_raw = settings.read_bytes()
    if hashlib.sha256(settings_raw).hexdigest() != policy['settingsCurrent']: raise ValueError('Current settings differs')
    dbfile = root.parents[2]/'userdata/state.sqlite'
    # The retained pre-migration backup (already hash-verified by the runner) is the evidence of the ORIGINAL binding and selection rows.
    backup = root/'before-migrations.sqlite'
    with closing(sqlite3.connect(dbfile.as_uri()+'?mode=ro', uri=True)) as db, ExitStack() as stack:
        db.row_factory = sqlite3.Row; db.execute('PRAGMA query_only=ON'); db.execute('BEGIN')
        retained = None
        if backup.resolve(strict=True) == backup and backup.is_file():
            retained = stack.enter_context(closing(sqlite3.connect(backup.as_uri()+'?mode=ro', uri=True)))
            retained.row_factory = sqlite3.Row; retained.execute('PRAGMA query_only=ON'); retained.execute('BEGIN')
        events, jobs, job_evidence, activity, preclosed, identity = prove_rows(db, policy, receipt['before'], request['currentSessions'], closed, retained, json.loads(settings_raw.decode('utf-8-sig')))
    return {'policySha256': review['policySha256'], 'originalReceiptSha256': review['originalReceiptSha256'], 'closedSnapshotSha256': review['closedSnapshotSha256'], 'beforeSnapshotSha256': digest(receipt['before']), 'currentSnapshotSha256': request['currentSnapshotSha256'], 'settingsSha256': policy['settingsCurrent'], 'events': events, 'jobs': jobs, 'jobEvidence': job_evidence, 'activity': activity, 'preClosedActivity': preclosed, 'identityTransitions': identity}

if __name__ == '__main__':
    print(json.dumps(prove(json.loads(sys.argv[1])), ensure_ascii=False))
