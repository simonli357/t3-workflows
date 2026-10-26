"""Read-only reconstruction of the one primary-approved client effort change."""
import sys
sys.dont_write_bytecode = True
import copy, hashlib, importlib.util, json, sqlite3
from pathlib import Path
from contextlib import closing
spec = importlib.util.spec_from_file_location('deploy_host', Path(__file__).with_name('host.py'))
host = importlib.util.module_from_spec(spec); spec.loader.exec_module(host)

def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()

def prove_rows(db, p):
    pin = p['event']; tid = p['threadId']
    event = db.execute('SELECT * FROM orchestration_events WHERE sequence=?', (pin['sequence'],)).fetchone()
    if not event or event['aggregate_kind'] != 'thread' or event['stream_id'] != tid or any(event[k] != pin[k] for k in ('sequence','event_id','event_type','command_id','actor_kind','metadata_json','occurred_at')) or json.loads(event['payload_json']) != pin['payload']:
        raise ValueError('Approved effort event missing or altered')
    receipt = db.execute('SELECT * FROM orchestration_command_receipts WHERE command_id=?', (pin['command_id'],)).fetchone()
    if not receipt or dict(receipt) != pin['receipt']: raise ValueError('Approved effort receipt missing or altered')
    current = db.execute('SELECT thread_id,project_id,model_selection_json,runtime_mode,interaction_mode,branch,worktree_path FROM projection_threads WHERE thread_id=?', (tid,)).fetchone()
    row = db.execute('SELECT * FROM provider_session_runtime WHERE thread_id=?', (tid,)).fetchone()
    if not current or not row: raise ValueError('Approved effort current row missing')
    current = dict(current); stable = host.stable_binding(dict(row))
    if host.hashed(current) != p['currentProfileHash'] or host.hashed(stable) != p['currentBindingHash'] or host.hashed(stable['resumeCursor']['threadId']) != p['nativeIdHash']: raise ValueError('Approved effort current identity differs')
    selection = json.loads(current['model_selection_json'])
    if selection != p['selection'] or stable['runtimePayload']['modelSelection'] != selection: raise ValueError('Approved effort current selection differs')
    old = copy.deepcopy(current); old_stable = copy.deepcopy(stable); previous = copy.deepcopy(selection)
    options = [x for x in previous['options'] if x['id'] == 'reasoningEffort']
    if len(options) != 1 or options[0]['value'] != 'high': raise ValueError('Approved effort option differs')
    options[0]['value'] = 'xhigh'; old['model_selection_json'] = json.dumps(previous, separators=(',', ':'))
    old_stable['runtimePayload']['modelSelection'] = previous
    if host.hashed(old) != p['oldProfileHash'] or host.hashed(old_stable) != p['oldBindingHash'] or host.hashed(previous) != p['oldSelectionSha256'] or host.hashed(selection) != p['selectionSha256']: raise ValueError('Effort-only reconstruction differs')
    return pin

def prove(request):
    p = request['policy']; root = Path(request['deployment']).absolute()
    if root.resolve(strict=True) != root or root.name != p['deploymentId'] or root.parent.name != 't3w-deploy': raise ValueError('Windows profile deployment differs')
    if request['review']['policySha256'] != digest(p): raise ValueError('Windows profile policy differs')
    boundaries = []
    for name, key in [('receipt.json','originalReceiptSha256'),('closed-snapshot.json','closedSnapshotSha256')]:
        file = root/name
        if file.resolve(strict=True) != file: raise ValueError('Windows profile boundary path differs')
        raw = file.read_bytes()
        if hashlib.sha256(raw).hexdigest() != p[key]: raise ValueError('Windows profile boundary hash differs')
        boundaries.append(json.loads(raw))
    receipt, closed = boundaries
    if receipt['id'] != p['deploymentId'] or receipt['phase'] != 'recovery-required': raise ValueError('Windows original failure differs')
    for boundary in [receipt['before'],closed]:
        if boundary['activityBoundary']['eventSequence'] >= p['event']['sequence']: raise ValueError('Windows effort event is not later than old boundary')
    dbfile = root.parents[2]/'userdata/state.sqlite'
    if dbfile.resolve(strict=True) != dbfile: raise ValueError('Windows current database path differs')
    with closing(sqlite3.connect(dbfile.as_uri()+'?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row; db.execute('PRAGMA query_only=ON'); db.execute('BEGIN')
        event = prove_rows(db,p)
    return {'verified':True,'policySha256':digest(p),'originalReceiptSha256':p['originalReceiptSha256'],'closedSnapshotSha256':p['closedSnapshotSha256'],'currentSnapshotSha256':request['currentSnapshotSha256'],'event':event}

if __name__ == '__main__': print(json.dumps(prove(json.loads(sys.argv[1])), separators=(',', ':')))
