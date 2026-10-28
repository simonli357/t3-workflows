"""Read-only proof for the primary's exact installed50 forward decisions."""
import sys
sys.dont_write_bytecode = True
import json, hashlib, sqlite3, importlib.util
from pathlib import Path
from contextlib import closing

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

def prove_rows(db, policy, before, current_sessions, closed=None):
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
    activity, preclosed = [], []
    old_by_id = {s['id']: s for s in before['sessions']}
    for current in current_sessions:
        tid = current['id']
        if tid not in policy['activitySessionIds']: continue
        old = old_by_id[tid]
        if current['lastTurnId'] == old['lastTurnId']: continue
        # Original active sessions remain subject to the unchanged native
        # continuation branch of preservation(), not idle-activity exceptions.
        if old['status'] == 'running' and old.get('activeTurnId') and not any(old.get(k) for k in ('archivedAt','deletedAt','settledAt','snoozedUntil')): continue
        if any(current.get(k) != old.get(k) for k in ('nativeId', 'instance', 'provider', 'profile')): raise ValueError('Activity changed native identity')
        sealed = next((s for s in (closed or {}).get('sessions', []) if s['id'] == tid), None)
        before_close = bool(sealed and sealed['status'] == 'running' and sealed.get('activeTurnId') and not any(sealed.get(k) for k in ('archivedAt','deletedAt','settledAt','snoozedUntil')))
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
    return events, jobs, job_evidence, activity, preclosed

def prove(request):
    root = Path(request['deployment']).absolute()
    if root.resolve(strict=True) != root or root.name != request['policy']['deploymentId'] or root.parent.name != 't3w-deploy': raise ValueError('Forward deployment path')
    raw = (root/'receipt.json').read_bytes(); closed_raw = (root/'closed-snapshot.json').read_bytes()
    review = request['review']; policy = request['policy']
    if hashlib.sha256(raw).hexdigest() != review['originalReceiptSha256'] or hashlib.sha256(closed_raw).hexdigest() != review['closedSnapshotSha256'] or digest(policy) != review['policySha256']: raise ValueError('Forward boundary pin differs')
    receipt, closed = json.loads(raw), json.loads(closed_raw)
    if receipt['id'] != policy['deploymentId'] or receipt['phase'] != 'recovery-required': raise ValueError('Original failure differs')
    settings = root.parents[2]/'userdata/settings.json'
    if settings.resolve(strict=True) != settings or hashlib.sha256(settings.read_bytes()).hexdigest() != policy['settingsCurrent']: raise ValueError('Current settings differs')
    dbfile = root.parents[2]/'userdata/state.sqlite'
    with closing(sqlite3.connect(dbfile.as_uri()+'?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row; db.execute('PRAGMA query_only=ON'); db.execute('BEGIN')
        events, jobs, job_evidence, activity, preclosed = prove_rows(db, policy, receipt['before'], request['currentSessions'], closed)
    return {'policySha256': review['policySha256'], 'originalReceiptSha256': review['originalReceiptSha256'], 'closedSnapshotSha256': review['closedSnapshotSha256'], 'beforeSnapshotSha256': digest(receipt['before']), 'currentSnapshotSha256': request['currentSnapshotSha256'], 'settingsSha256': policy['settingsCurrent'], 'events': events, 'jobs': jobs, 'jobEvidence': job_evidence, 'activity': activity, 'preClosedActivity': preclosed}

if __name__ == '__main__':
    print(json.dumps(prove(json.loads(sys.argv[1])), ensure_ascii=False))
