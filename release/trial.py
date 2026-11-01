#!/usr/bin/env python3
"""Read/import V2 trial. Never calls the production release controller."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import uuid

from release import database, descriptor, prebuilt_runtime, read, save, vacuum, v2_count_checks

HERE = Path(__file__).resolve().parent


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inside(child, parent):
    return child == parent or parent in child.parents


def locations(job, source, root):
    job, source, root = (Path(p).resolve() for p in (job, source, root))
    if not job.is_dir() or not inside(root, job) or root == job:
        raise RuntimeError('Trial must be a separate directory inside an existing job')
    if inside(root, source) or inside(source, root):
        raise RuntimeError('Source and trial must not overlap')
    if not (source / 'userdata/state.sqlite').is_file():
        raise RuntimeError('Explicit source home must contain userdata/state.sqlite')
    return job, source, root


@contextmanager
def locked(root):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / '.lock').open('a') as file:
        fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def snapshot(source, target):
    """SQLite snapshots include committed WAL. Other inputs are retained as private copies.

    Symlinks are recorded, never followed into provider homes or other live workspaces.
    SQLite files have independent consistent snapshot times, not a cross-file transaction.
    """
    manifest = []
    target.mkdir(parents=True, mode=0o700)
    for directory, dirs, files in os.walk(source, followlinks=False):
        for name in dirs[:]:
            if (Path(directory) / name).is_symlink():
                files.append(name)
                dirs.remove(name)
        relative = Path(directory).relative_to(source)
        (target / relative).mkdir(parents=True, exist_ok=True)
        for name in files:
            src, dst = Path(directory) / name, target / relative / name
            if src.is_symlink():
                manifest.append({'path': str(relative / name), 'symlink': os.readlink(src)})
                continue
            if name.endswith(('-wal', '-shm', '-journal')) and Path(str(src).rsplit('-', 1)[0]).exists():
                continue
            if not src.is_file():
                manifest.append({'path': str(relative / name), 'specialFile': True})
                continue
            with src.open('rb') as stream:
                sqlite = stream.read(16) == b'SQLite format 3\0'
            if sqlite:
                vacuum(src, dst)
            else:
                shutil.copyfile(src, dst)
            os.chmod(dst, 0o600)
            manifest.append({'path': str(relative / name), 'bytes': dst.stat().st_size,
                             'sha256': digest(dst), 'sqliteSnapshot': sqlite})
    return manifest


def isolate_database(path):
    changes = []
    with sqlite3.connect(path) as db:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        updates = {
            'custom_worker_jobs': "state='error', reported=1, error='Isolated trial: copied delivery disabled'",
            'custom_workers': "state='error', notify=0",
            'custom_session_renewals': "state='error'",
            'custom_orchestrator_handoffs': "state='error'",
            'custom_session_moves': "state='error'",
            'provider_session_runtime': "status='stopped', resume_cursor_json=NULL, runtime_payload_json=NULL",
            'scheduled_tasks': 'enabled=0',
        }
        for table, assignment in updates.items():
            if table in tables:
                count = db.execute(f'UPDATE "{table}" SET {assignment}').rowcount
                changes.append({'table': table, 'assignment': assignment, 'rows': count})
        for table in ('auth_sessions', 'auth_pairing_links'):
            if table in tables:
                count = db.execute(f'DELETE FROM "{table}"').rowcount
                changes.append({'table': table, 'removedRows': count, 'reason': 'Trial uses fresh authentication'})
    return changes


def prepare(args, root):
    config_path = root / 'trial.json'
    previous = read(config_path) if config_path.exists() else None
    if previous and args.action == 'prepare':
        raise RuntimeError('Trial already exists; use explicit refresh to archive and replace it')
    if previous and process_alive(root):
        raise RuntimeError('Stop the trial before refresh; its data will be archived, never overwritten')
    if previous:
        source, runtime, port = Path(previous['sourceHome']), Path(args.runtime).resolve() if args.runtime else Path(previous['runtime']), previous['port']
    else:
        if not args.source_home or not args.runtime or args.port is None:
            raise RuntimeError('prepare requires --source-home, --runtime and --port')
        source, runtime, port = Path(args.source_home).resolve(), Path(args.runtime).resolve(), args.port
    job, source, root = locations(args.job, source, root)
    if not 1024 <= port <= 65535 or port == 3773:
        raise RuntimeError('Use an independent unprivileged trial port (not 3773)')
    built = prebuilt_runtime(runtime)
    if not re.fullmatch(r'[0-9a-f]{7,40}', built['commit']):
        raise RuntimeError('Runtime sourceCommit must be a pinned Git commit')
    if read(runtime / 'package.json').get('protocol') != 2:
        raise RuntimeError('Runtime must explicitly declare protocol 2')
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:8]
    generation = root / 'generations' / stamp
    generation.mkdir(parents=True, mode=0o700)
    # Stage before publishing. A failed refresh keeps both old data and partial new inputs.
    inputs = generation / 'input'
    manifest = snapshot(source / 'userdata', inputs / 'userdata')
    save(inputs / 'manifest.json', manifest)
    home = generation / 'home'
    userdata = home / 'userdata'
    userdata.mkdir(parents=True, mode=0o700)
    shutil.copyfile(inputs / 'userdata/state.sqlite', userdata / 'state.sqlite')
    changes = isolate_database(userdata / 'state.sqlite')
    settings = {'continueThreadsAfterServerUpdate': False, 'linkedEnvironmentsEnabled': False,
                'idleCompaction': 'off', 'providerInstances': []}
    save(userdata / 'settings.json', settings)
    environment = str(uuid.uuid4())
    (userdata / 'environment-id').write_text(environment + '\n')
    for folder in ('host-home', 'tmp', 'cache'):
        (home / folder).mkdir()
    # Only presentation/assets are active. Config, credentials, identities and the old V2 DB
    # remain in input, beyond the trial process's Landlock read boundary.
    for name in ('keybindings.json', 'themes', 'attachments'):
        src, dst = inputs / 'userdata' / name, userdata / name
        if src.is_dir():
            shutil.copytree(src, dst)
        elif src.is_file():
            shutil.copyfile(src, dst)
    staged_runtime = root / 'runtimes' / built['commit']
    if not staged_runtime.exists():
        staged_runtime.parent.mkdir(parents=True, exist_ok=True)
        temporary_runtime = staged_runtime.with_name('.staging-' + uuid.uuid4().hex)
        shutil.copytree(runtime, temporary_runtime, symlinks=False)
        prebuilt_runtime(temporary_runtime)
        temporary_runtime.rename(staged_runtime)
    if digest(staged_runtime / 't3') != digest(runtime / 't3') or digest(staged_runtime / 'package.json') != digest(runtime / 'package.json'):
        raise RuntimeError('Retained runtime differs from supplied build; use a distinct pinned commit')
    config = {'version': 1, 'sourceHome': str(source), 'job': str(job), 'root': str(root),
              'generation': str(generation), 'home': str(home), 'runtime': str(staged_runtime),
              'runtimeVersion': built['version'], 'sourceCommit': built['commit'], 'port': port,
              'environmentId': environment, 'runtimeSha256': digest(staged_runtime / 't3')}
    receipt = {'generation': stamp, 'sourceHome': str(source), 'inputManifest': str(inputs / 'manifest.json'),
               'isolationChanges': changes, 'activeSettings': settings,
               'inactiveInputs': 'All original settings, secrets, peer identities, provider state, computer and move state are retained only in input.',
               'sandbox': 'Landlock limits file access; seccomp denies outbound sockets and external process interference.',
               'parity': 'NOT PROVEN: baseline V2 plus deliberate isolation differences; separate feature parity gate required.',
               'previousGeneration': previous['generation'] if previous else None}
    save(generation / 'receipt.json', receipt)
    if previous:
        save(Path(previous['generation']) / 'archive.json', {
            'archivedAt': stamp, 'replacedBy': str(generation),
            'reason': 'Explicit refresh; complete old home, trial-only data, inputs and runtime retained'})
    save(config_path, config)
    return config


def proc_identity(pid):
    try:
        stat = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        if stat[0] == 'Z':
            return None
        return {'pid': pid, 'startTicks': stat[19],
                'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    except (FileNotFoundError, ProcessLookupError):
        return None


def process_alive(root):
    path = root / 'process.json'
    if not path.exists():
        return False
    saved = read(path)
    observed = proc_identity(saved['pid'])
    return observed is not None and observed == saved['identity']


def status(root):
    config = read(root / 'trial.json')
    result = {'running': process_alive(root), 'port': config['port'], 'home': config['home'],
              'generation': config['generation'], 'parity': 'not proven'}
    if result['running']:
        record = read(root / 'process.json')
        result['pid'] = record['pid']
        result['unit'] = record.get('unit')
        result['cgroup'] = Path(f"/proc/{record['pid']}/cgroup").read_text().strip()
        try:
            desc = descriptor(config['port'])
            result['healthy'] = (desc.get('environmentId') == config['environmentId'] and
                                 desc.get('orchestrationProtocolVersion') == 2 and
                                 desc.get('serverVersion') == config['runtimeVersion'])
            result['descriptor'] = desc
        except (OSError, ValueError) as error:
            result['healthy'] = False
            result['error'] = str(error)
    return result


def stop(root):
    if not process_alive(root):
        return {'stopped': True, 'alreadyStopped': True}
    record = read(root / 'process.json')
    # pidfd prevents a reused PID being signalled after the identity check.
    try:
        fd = os.pidfd_open(record['pid'])
    except ProcessLookupError:
        return {'stopped': True, 'alreadyStopped': True}
    try:
        if not process_alive(root):
            return {'stopped': True, 'alreadyStopped': True}
        signal.pidfd_send_signal(fd, signal.SIGTERM)
        import select
        ready, _, _ = select.select([fd], [], [], 30)
        if not ready:
            signal.pidfd_send_signal(fd, signal.SIGKILL)
            if not select.select([fd], [], [], 10)[0]:
                raise RuntimeError('Captured trial PID did not stop')
    finally:
        os.close(fd)
    return {'stopped': True, 'pid': record['pid']}


def start(root, seconds):
    if process_alive(root):
        return status(root)
    config = read(root / 'trial.json')
    home, runtime = Path(config['home']).resolve(), Path(config['runtime']).resolve()
    if not inside(home, root / 'generations') or not inside(runtime, root / 'runtimes'):
        raise RuntimeError('Trial home/runtime must remain inside its own generation/runtime directories')
    if config.get('runtimeSha256') and digest(runtime / 't3') != config['runtimeSha256']:
        raise RuntimeError('Trial runtime changed since prepare')
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', config['port']))
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(home / 'host-home'),
           'TMPDIR': str(home / 'tmp'), 'XDG_CACHE_HOME': str(home / 'cache'),
           'T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD': 'false', 'OTEL_SDK_DISABLED': 'true'}
    command = [sys.executable, '-B', str(HERE / 'trial_sandbox.py'), str(home), str(runtime),
               str(runtime / 't3'), 'serve', '--base-dir', str(home), '--host', '127.0.0.1',
               '--port', str(config['port']), '--no-browser']
    # A detached subprocess still inherits the calling agent's cgroup. A new
    # transient service in our own slice survives independently of production's
    # agent/service controllers, and systemd cleans up its children on exit.
    unit = 't3w-trial-' + uuid.uuid4().hex + '.service'
    manager_env = {'PATH':'/usr/bin:/bin', 'XDG_RUNTIME_DIR':f'/run/user/{os.getuid()}',
                   'DBUS_SESSION_BUS_ADDRESS':f'unix:path=/run/user/{os.getuid()}/bus'}
    launch = ['systemd-run','--user','--quiet','--collect','--unit='+unit,'--slice=t3w-trials.slice',
              '--property=Type=exec','--property=Restart=no','--property=KillMode=control-group',
              '--property=UMask=0077','--property=WorkingDirectory='+str(home),
              '--property=StandardOutput=append:'+str(Path(config['generation'])/'server.log'),
              '--property=StandardError=inherit','/usr/bin/env','-i',
              *[key+'='+value for key,value in env.items()], *command]
    subprocess.run(launch, cwd=home, env=manager_env, check=True, capture_output=True, text=True, timeout=30)
    shown = subprocess.run(['systemctl','--user','show',unit,'-p','MainPID','--value'],
                           cwd=home,env=manager_env,check=True,capture_output=True,text=True,timeout=10)
    pid = int(shown.stdout.strip())
    identity = proc_identity(pid) if pid > 0 else None
    if identity is None:
        raise RuntimeError('Trial service exited; inspect its generation/server.log')
    save(root / 'process.json', {'pid':pid,'identity':identity,'unit':unit,
                                'home':str(home),'runtime':str(runtime)})
    if '/t3w-trials.slice/' not in Path(f'/proc/{pid}/cgroup').read_text():
        stop(root)
        raise RuntimeError('Trial did not enter its dedicated slice')
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not process_alive(root):
            raise RuntimeError('Trial exited; inspect its generation/server.log')
        result = status(root)
        if result.get('healthy'):
            return result
        time.sleep(0.5)
    stop(root)
    raise RuntimeError('Trial readiness timed out; stopped only its captured PID')


def sample_rows(db, table, key, predicates=()):
    rows = {}
    for order in ('ASC', 'DESC'):
        for row in db.execute(f'SELECT * FROM "{table}" ORDER BY "{key}" {order} LIMIT 3'):
            rows[row[key]] = dict(row)
    for predicate in predicates:
        for row in db.execute(f'SELECT * FROM "{table}" WHERE {predicate} ORDER BY "{key}" LIMIT 3'):
            rows[row[key]] = dict(row)
    return list(rows.values())


def content_checks(source, destination):
    checks = []
    with database(source) as left, database(destination) as right:
        left.row_factory = right.row_factory = sqlite3.Row
        for row in sample_rows(left, 'projection_projects', 'project_id'):
            other = right.execute('SELECT * FROM projection_projects WHERE project_id=?', (row['project_id'],)).fetchone()
            fields = list(row)
            checks.append({'kind': 'project', 'id': row['project_id'], 'fields': fields,
                           'matches': other is not None and all(row[k] == other[k] for k in fields)})
        mapping = {'project_id':'projectId', 'title':'title', 'branch':'branch', 'worktree_path':'worktreePath',
                   'runtime_mode':'runtimeMode', 'interaction_mode':'interactionMode', 'created_at':'createdAt',
                   'archived_at':'archivedAt', 'deleted_at':'deletedAt', 'settled_override':'settledOverride',
                   'settled_at':'settledAt', 'unsettled_at':'unsettledAt', 'snoozed_until':'snoozedUntil',
                   'snoozed_at':'snoozedAt', 'pinned_at':'pinnedAt', 'pin_order_key':'pinOrderKey',
                   'active_order_key':'activeOrderKey', 'auto_settle_disabled_at':'autoSettleDisabledAt',
                   'model_selection_json':'modelSelection', 'linked_pull_request_json':'linkedPullRequest',
                   'branch_pull_request_json':'branchPullRequest'}
        for row in sample_rows(left, 'projection_threads', 'thread_id',
                               ('pinned_at IS NOT NULL', 'snoozed_until IS NOT NULL',
                                'branch IS NOT NULL', 'linked_pull_request_json IS NOT NULL')):
            other = right.execute('SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?',
                                  (row['thread_id'],)).fetchone()
            payload = json.loads(other[0]) if other else {}
            mismatches = []
            for column, field in mapping.items():
                if column not in row: continue
                expected = row[column]
                if column.endswith('_json') and expected is not None:
                    expected = json.loads(expected)
                if payload.get(field) != expected:
                    mismatches.append(field)
            checks.append({'kind':'thread', 'id':row['thread_id'], 'fields':list(mapping.values()),
                           'matches': other is not None and not mismatches, 'mismatches':mismatches})
        rows = sample_rows(left, 'projection_thread_messages', 'message_id',
                           ("role='user'", "role='assistant'", "attachments_json IS NOT NULL AND attachments_json != '[]'",
                            'context_json IS NOT NULL'))
        for row in rows:
            if row['role'] not in ('user','assistant'): continue
            other = right.execute('SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?',
                                  (row['message_id'],)).fetchone()
            payload = json.loads(other[0]) if other else {}
            expected = {'id':row['message_id'], 'threadId':row['thread_id'], 'role':row['role'],
                        'text':row['text'], 'createdAt':row['created_at'], 'updatedAt':row['updated_at'],
                        'attachments':json.loads(row['attachments_json']) if row['attachments_json'] else [],
                        'context':json.loads(row['context_json']) if row['context_json'] else None}
            mismatches = [k for k,v in expected.items() if payload.get(k) != v]
            checks.append({'kind':'message', 'id':row['message_id'], 'fields':list(expected),
                           'textSha256':hashlib.sha256(row['text'].encode()).hexdigest(),
                           'matches':other is not None and not mismatches, 'mismatches':mismatches})
    return checks


def verify(root):
    config = read(root / 'trial.json')
    generation = Path(config['generation'])
    source = generation / 'input/userdata/state.sqlite'
    destination = Path(config['home']) / 'userdata/statev2.sqlite'
    counts = v2_count_checks(source, destination)
    content = content_checks(source, destination)
    with database(source) as left, database(destination) as right:
        right.execute('ATTACH DATABASE ? AS trial_input', (Path(source).resolve().as_uri() + '?mode=ro',))
        right.execute('BEGIN')
        retained = []
        for (table,) in left.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
            if table == 'effect_sql_migrations': continue
            quoted = '"' + table.replace('"','""') + '"'
            before = left.execute(f'SELECT COUNT(*) FROM {quoted}').fetchone()[0]
            try:
                after = right.execute(f'SELECT COUNT(*) FROM main.{quoted}').fetchone()[0]
            except sqlite3.OperationalError:
                after = None
            isolated = table in ('auth_sessions','auth_pairing_links')
            # Migration 063 explicitly removes these obsolete V1 projections. Inventory
            # their counts without pretending their removal proves behavioral parity.
            dropped = table in ('checkpoint_diff_blobs', 'projection_thread_activities', 'projection_turns',
                                'projection_pending_approvals', 'projection_state', 'projection_thread_proposed_plans')
            legacy = after
            compacted = unexpected = 0
            if table == 'orchestration_events':
                legacy = right.execute('SELECT COUNT(*) FROM orchestration_events WHERE application_event_version=1').fetchone()[0]
            elif table == 'orchestration_command_receipts':
                legacy = right.execute("SELECT COUNT(*) FROM orchestration_command_receipts WHERE command_type='legacy'").fetchone()[0]
            if table in ('orchestration_events', 'orchestration_command_receipts'):
                key, thread_key = ('event_id','stream_id') if table == 'orchestration_events' else ('command_id','aggregate_id')
                missing = f'FROM trial_input.{quoted} s LEFT JOIN main.{quoted} d ON s.{key}=d.{key} WHERE d.{key} IS NULL'
                compacted = right.execute('SELECT COUNT(*) ' + missing).fetchone()[0]
                unexpected = right.execute('SELECT COUNT(*) ' + missing + f" AND NOT (s.aggregate_kind='thread' AND EXISTS (SELECT 1 FROM orchestration_v2_legacy_imports i WHERE i.thread_id=s.{thread_key} AND i.transcript_imported_at IS NOT NULL))").fetchone()[0]
            retained.append({'table':table,'source':before,'imported':after,'legacyRows':legacy,
                             'isolationDifference':isolated, 'compactedLegacyRows':compacted, 'unexpectedMissingRows':unexpected,
                             'migrationDifference':'063_DropUnusedV1Projections; raw source retained; behavior not verified' if dropped else None,
                             'matches':after is None if dropped else (legacy + compacted == (0 if isolated else before) and unexpected == 0)})
        pending = right.execute('SELECT COUNT(*) FROM orchestration_v2_legacy_imports WHERE transcript_imported_at IS NULL OR last_error IS NOT NULL').fetchone()[0]
    result = {'scope':'Infrastructure import proof only; feature parity NOT PROVEN',
              'counts':counts, 'retainedTableCounts':retained, 'content':content, 'pendingTranscripts':pending,
              'matches':all(c['matches'] for c in counts+retained+content) and pending == 0}
    save(generation / 'verification.json', result)
    if not result['matches']:
        raise RuntimeError('Import verification incomplete or mismatched; see generation/verification.json')
    return result


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['prepare', 'refresh', 'start', 'status', 'stop', 'restart', 'verify'])
    p.add_argument('--job', required=True, help='Existing described workenv job')
    p.add_argument('--trial', help='Defaults to JOB/trial; must be inside JOB')
    p.add_argument('--source-home', help='Explicit read-only V1 source, prepare only')
    p.add_argument('--runtime', help='Prebuilt V2 runtime for prepare, or optional replacement on explicit refresh')
    p.add_argument('--port', type=int, help='Independent loopback port, prepare only')
    p.add_argument('--ready-seconds', type=float, default=900)
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    if args.ready_seconds <= 0:
        raise RuntimeError('--ready-seconds must be positive')
    job = Path(args.job).resolve()
    root = Path(args.trial).resolve() if args.trial else job / 'trial'
    if not inside(root, job) or root == job:
        raise RuntimeError('Trial must be inside job')
    with locked(root):
        if args.action in ('prepare', 'refresh'):
            result = prepare(args, root)
        else:
            config = read(root / 'trial.json')
            locations(job, config['sourceHome'], root)
            if args.action == 'stop':
                result = stop(root)
            elif args.action == 'status':
                result = status(root)
            elif args.action == 'verify':
                result = verify(root)
            else:
                if args.action == 'restart':
                    stop(root)
                result = start(root, args.ready_seconds)
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
