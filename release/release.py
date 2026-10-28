#!/usr/bin/env python3
"""Build and release the fork on this computer. No live database rollback."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
import platform
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import zipfile
import time
import urllib.request
import uuid
from repack import repack, read_file

HERE = Path(__file__).resolve().parent
WINDOWS = os.name == 'nt'
STARTUP_SETTLE_SECONDS = 30


def run(args, *, cwd=None, env=None, timeout=300, capture=False):
    print('+ ' + subprocess.list2cmdline([str(a) for a in args]), flush=True)
    result = subprocess.run([str(a) for a in args], cwd=cwd, env=env, timeout=timeout,
                            check=True, stdout=subprocess.PIPE if capture else None,
                            text=True)
    return result.stdout.strip() if capture else None


def read(file):
    return json.loads(Path(file).read_text(encoding='utf-8-sig'))


def save(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    tmp = file.with_name(file.name + '.tmp')
    tmp.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    os.replace(tmp, file)


def clean_env():
    return {k: v for k, v in os.environ.items()
            if not k.startswith(('T3', 'VITE_', 'ELECTRON_'))}


@contextmanager
def database(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, timeout=10)
    try:
        yield db
    finally:
        db.close()


def ledger(path):
    with database(path) as db:
        return [list(r) for r in db.execute('SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id')]


def fingerprint(path):
    with database(path) as db:
        schema = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
    return {'migrations': ledger(path), 'schema': hashlib.sha256(json.dumps(schema).encode()).hexdigest()}


def pending_migrations(current, wanted):
    expected = dict(wanted)
    if any(expected.get(i) != name for i, name in current):
        raise RuntimeError('Candidate migration ledger is older than or incompatible with the live database')
    current_ids = {i for i, _ in current}
    pending = [row for row in wanted if row[0] not in current_ids]
    if current and any(i <= max(current_ids) for i, _ in pending):
        raise RuntimeError('Candidate inserts a migration behind the applied ledger')
    return pending


def vacuum(source, target):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise RuntimeError('Snapshot already exists: ' + str(target))
    with database(source) as db:
        db.execute('VACUUM INTO ?', (str(target),))


def check_claim(home):
    root = home / 'runtime/t3w-deploy'
    if (root / 'claim.json').exists():
        claim = read(root / 'claim.json')
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}', claim['id']):
            raise RuntimeError('Unrecognized deployment claim')
        receipt = read(root / claim['id'] / 'receipt.json')
        cancelled = root / claim['id'] / 'cancelled.json'
        terminal = receipt.get('phase') == 'accepted'
        if cancelled.exists():
            cancellation = read(cancelled)
            terminal = (receipt.get('phase') == 'staged' and cancellation.get('phase') == 'cancelled'
                        and cancellation.get('kind') == 'before-activation'
                        and all(cancellation.get(k) == receipt.get(k) for k in ['id', 'manifestHash', 'targetHash'])
                        and cancellation.get('originalReceiptSha256') == hashlib.sha256((root / claim['id'] / 'receipt.json').read_bytes()).hexdigest())
        if not terminal or receipt.get('id') != claim['id'] or receipt.get('manifestHash') != claim['manifestHash']:
            raise RuntimeError('Another release owns an unfinished deployment: ' + claim['id'])
    if (root / 'release-in-progress.json').exists():
        raise RuntimeError('An interrupted release needs inspection: ' + str(root / 'release-in-progress.json'))


@contextmanager
def host_lock(home):
    root = home / 'runtime/t3w-deploy'
    root.mkdir(parents=True, exist_ok=True)
    with (root / 'host.lock').open('a+b') as lock:
        try:
            if WINDOWS:
                import msvcrt
                if lock.tell() == 0:
                    lock.write(b'0'); lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise RuntimeError('Another release holds the host lock') from error
        check_claim(home)
        yield


def node26(option, job):
    candidates = [option] if option else [
        str(Path.home() / '.local/opt/node-v26.8.2-linux-x64/bin/node'),
        shutil.which('node')]
    for candidate in candidates:
        if candidate and Path(candidate).exists() and run([candidate, '--version'], capture=True) == 'v26.8.2':
            return str(Path(candidate).resolve())
    if option:
        raise RuntimeError('--node must select Node 26.8.2')
    # Same pinned Node release used by build-exe; install only inside this job.
    name = 'node-v26.8.2-' + ('win-x64.zip' if WINDOWS else 'linux-x64.tar.xz')
    base = 'https://nodejs.org/dist/v26.8.2/'
    with urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=30) as response:
        checksums = response.read().decode()
    expected = next(line.split()[0] for line in checksums.splitlines() if line.split()[-1] == name)
    archive = job / name
    with urllib.request.urlopen(base + name, timeout=60) as response, archive.open('wb') as out:
        shutil.copyfileobj(response, out)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise RuntimeError('Node download checksum mismatch')
    if WINDOWS:
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(job)
        executable = job / 'node-v26.8.2-win-x64/node.exe'
    else:
        with tarfile.open(archive) as bundle:
            bundle.extractall(job, filter='data')
        executable = job / 'node-v26.8.2-linux-x64/bin/node'
    return str(executable)


def build(args, job):
    node = node26(args.node, job)
    env = clean_env()
    env['PATH'] = str(Path(node).parent) + os.pathsep + env['PATH']
    env.update({'TMPDIR': str(job / 'tmp'), 'TMP': str(job / 'tmp'), 'TEMP': str(job / 'tmp'),
                'XDG_CACHE_HOME': str(job / 'cache'), 'npm_config_cache': str(job / 'cache/npm'),
                'ELECTRON_CACHE': str(job / 'cache/electron'), 'npm_config_engine_strict': 'false',
                # Unattended runs must not stop at Corepack's interactive pnpm download prompt.
                'COREPACK_ENABLE_DOWNLOAD_PROMPT': '0'})
    (job / 'tmp').mkdir(exist_ok=True)
    repo = Path(args.repo).resolve()
    if not repo.exists():
        repo = job / 'repository'
        run(['git', 'clone', '--no-checkout', 'https://github.com/simonli357/t3code.git', repo], timeout=600)
    remote = run(['git', '-C', repo, 'remote', 'get-url', 'origin'], capture=True)
    if not re.search(r'[:/]simonli357/t3code(?:\.git)?$', remote):
        raise RuntimeError('Source origin must be simonli357/t3code')
    run(['git', '-C', repo, 'fetch', 'origin', 'main'])
    commit = run(['git', '-C', repo, 'rev-parse', '--verify', args.ref + '^{commit}'], capture=True)
    run(['git', '-C', repo, 'merge-base', '--is-ancestor', commit, 'origin/main'])
    source = job / 'source'
    env['PATH'] = str(source / 'node_modules/.bin') + os.pathsep + env['PATH']
    run(['git', '-C', repo, 'worktree', 'add', '--detach', source, commit])
    # A release version must identify its source even when main still says custom.52.
    base_version = read(source / 'apps/server/package.json')['version']
    version = base_version + ('.git.' if '+' in base_version else '+git.') + commit[:12]
    for relative in ['apps/server/package.json', 'apps/web/package.json', 'apps/desktop/package.json']:
        file = source / relative
        data = read(file); data['version'] = version; save(file, data)
    shutil.copyfile(source / '.env.example', source / '.env')
    env['APP_VERSION'] = version
    pnpm = shutil.which('pnpm')
    if not pnpm:
        raise RuntimeError('Install the existing pnpm toolchain first')
    # cmd shims need the Windows command processor; paths/arguments are fixed here.
    install = [pnpm, 'install', '--frozen-lockfile', '--config.engine-strict=false']
    if WINDOWS:
        install = ['cmd.exe', '/d', '/c', *install]
    run(install, cwd=source, env=env, timeout=1200)
    run([node, '--run', 'build'], cwd=source / 'apps/web', env=env, timeout=900)
    run([node, 'apps/server/scripts/cli.ts', 'build', '--verbose'], cwd=source, env=env, timeout=600)
    run([node, 'apps/server/scripts/cli.ts', 'build-exe', '--verbose'], cwd=source, env=env, timeout=600)
    # Reuse the installed native sidecars, as in the existing custom-release package.py.
    # A native dependency upgrade needs the normal native packaging path first.
    helper = source / 'scripts/t3w-release-migrate.mjs'
    shutil.copyfile(HERE / 'migrate.mjs', helper)
    manifest = json.loads(run([node, helper, '--manifest'], cwd=source, env=env, capture=True))
    native = json.loads(run([node, helper, '--native'], cwd=source, env=env, capture=True))
    runtime = job / 'runtime'; runtime.mkdir()
    if WINDOWS:
        resources = Path(args.desktop).parent / 'resources'
        for name, expected in native.items():
            installed = json.loads(read_file(resources / 'server.asar', 'node_modules/' + name + '/package.json'))
            if installed['version'] != expected:
                raise RuntimeError('Native dependency changed; prepare native sidecars first: ' + name)
        # The standalone exe is built above; desktop activation uses the repacked bundle.
        shutil.copy2(source / 'apps/server/dist-exe/t3.exe', runtime / 't3.exe')
    else:
        active = read(Path(args.home) / 'runtime/service-state.json')['activeVersion']
        previous = Path(args.home) / 'runtime/versions' / active
        for name, expected in native.items():
            if read(previous / 'node_modules' / name / 'package.json')['version'] != expected:
                raise RuntimeError('Native dependency changed; prepare native sidecars first: ' + name)
        for name in ['node_modules', 'resource-monitor']:
            shutil.copytree(previous / name, runtime / name)
        shutil.copy2(source / 'apps/server/dist-exe/t3', runtime / 't3')
    shutil.copytree(source / 'apps/server/dist/client', runtime / 'client')
    save(runtime / 'package.json', {'name': 't3', 'version': version, 'sourceCommit': commit})
    cli = [node, source / 'apps/server/dist/bin.mjs'] if WINDOWS else [runtime / 't3']
    help_text = run([*cli, 'connect', '--help'], env=clean_env(), capture=True)
    if 'login' not in help_text or 'unavailable' in help_text:
        raise RuntimeError('Build is missing the public T3 Connect configuration')
    result = {'version': version, 'commit': commit, 'node': node, 'source': str(source),
              'runtime': str(runtime), 'migrations': manifest}
    save(job / 'build.json', result)
    return result


def rehearse(built, db, job, limit):
    wanted = built['migrations']
    pending = pending_migrations(ledger(db), wanted)
    if not pending:
        return {'pending': [], 'seconds': 0}
    copy = job / 'migration-rehearsal.sqlite'
    try:
        print('Taking VACUUM INTO snapshot for pending migrations ' + str([i for i, _ in pending]), flush=True)
        vacuum(db, copy)
        started = time.monotonic()
        run([built['node'], Path(built['source']) / 'scripts/t3w-release-migrate.mjs', copy],
            cwd=built['source'], env=clean_env(), timeout=limit)
        elapsed = time.monotonic() - started
        if elapsed > limit or ledger(copy) != wanted:
            raise RuntimeError('Migration rehearsal exceeded the threshold or did not apply the expected ledger')
        return {'pending': pending, 'seconds': round(elapsed, 3)}
    finally:
        for suffix in ['', '-wal', '-shm', '-journal']:
            Path(str(copy) + suffix).unlink(missing_ok=True)


def descriptor(port, timeout=5):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/.well-known/t3/environment', timeout=timeout) as response:
        return json.load(response)


def health(port, version, seconds, stall_ms, logs, alive=lambda: True, ready_seconds=900):
    def probe():
        started = time.monotonic()
        if not alive():
            raise RuntimeError('New server exited')
        observed = descriptor(port, stall_ms / 1000)
        if observed.get('serverVersion') != version:
            raise RuntimeError('Server version mismatch: ' + str(observed.get('serverVersion')))
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=stall_ms / 1000) as response:
            if response.status != 200:
                raise RuntimeError('Web client did not answer')
            response.read(1024)
        elapsed = (time.monotonic() - started) * 1000
        if elapsed >= stall_ms:
            raise TimeoutError('HTTP health probe stalled for ' + str(round(elapsed)) + ' ms')
        return elapsed

    # Command readiness releases the first background sweeps too. Require stable HTTP
    # for one event-loop sampling interval before measuring strict steady-state health.
    started = time.monotonic()
    reported = started
    stable_since = None
    last = None
    while True:
        try:
            probe()
        except (OSError, ValueError) as error:
            stable_since = None
            last = f'{type(error).__name__}: {error}'
        else:
            now = time.monotonic()
            if stable_since is None:
                stable_since = now
            if now - stable_since >= STARTUP_SETTLE_SECONDS:
                break
            last = f'HTTP responsive for {now - stable_since:g}s; settling startup'
        now = time.monotonic()
        if now - started >= ready_seconds:
            raise RuntimeError(f'Server did not become ready within {ready_seconds:g} seconds; last probe: {last}')
        if now - reported >= 30:
            reported = now
            print(f'Waiting for server readiness: {round(now - started)}s; last probe: {last}', flush=True)
        time.sleep(min(1, max(0, ready_seconds - (now - started))))
    ready = round(time.monotonic() - started, 1)
    for directory in {file.parent for file in logs}:
        for file in directory.glob('*.log'):
            logs[file] = file.stat().st_size
    deadline = time.monotonic() + seconds
    maximum = 0
    while True:
        elapsed = probe()
        maximum = max(maximum, elapsed)
        for directory in {file.parent for file in logs}:
            for file in directory.glob('*.log'):
                logs.setdefault(file, 0)
        for file, offset in logs.items():
            if not file.exists():
                continue
            with file.open('rb') as stream:
                stream.seek(offset if file.stat().st_size >= offset else 0)
                text = stream.read().decode(errors='replace')
            for delay in re.findall(r'event loop stalled for ([\d.]+) ms', text):
                if float(delay) >= stall_ms:
                    raise RuntimeError('Event loop stalled for ' + delay + ' ms')
        if time.monotonic() >= deadline:
            return {'readySeconds': ready, 'seconds': seconds, 'maxProbeMs': round(maximum, 1), 'version': version}
        time.sleep(min(1, max(0, deadline - time.monotonic())))


class Isolated:
    def __init__(self, home, job, port):
        self.home, self.job, self.port, self.process = home, job, port, None
        self.log = job / 'server.log'

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.process.kill(); self.process.wait(timeout=10)
        self.process = None

    def start(self, runtime):
        with self.log.open('ab') as out:
            self.process = subprocess.Popen([str(runtime / 't3'), 'serve', '--base-dir', str(self.home),
                '--host', '127.0.0.1', '--port', str(self.port), '--no-browser'],
                cwd=self.home, env=clean_env(), stdout=out, stderr=subprocess.STDOUT)

    def alive(self):
        return self.process is not None and self.process.poll() is None


class Linux:
    def __init__(self, home, job, port):
        self.home, self.port, self.job = home, port, job
        self.link = Path.home() / '.local/bin/t3'
        self.log = home / 'userdata/logs/boot-service.log'

    def inspect(self):
        unit = run(['systemctl', '--user', 'show', 't3code.service', '-p', 'Environment', '-p', 'ExecStart'], capture=True)
        if str(self.home) not in unit:
            raise RuntimeError('t3code.service does not select this T3 home')
        if not self.link.is_symlink():
            raise RuntimeError('Existing t3 launcher must be a symlink')
        self.unit_file = Path(run(['systemctl', '--user', 'show', 't3code.service', '-p', 'FragmentPath', '--value'], capture=True))
        if self.unit_file != Path.home() / '.config/systemd/user/t3code.service':
            raise RuntimeError('Unexpected service unit location')
        self.unit_text = self.unit_file.read_text()
        entries = re.findall(r'^ExecStart=(.+) __service-launcher$', self.unit_text, flags=re.M)
        if len(entries) != 1 or str(self.home / 'runtime/versions') not in entries[0]:
            raise RuntimeError('Unexpected service launcher entrypoint')
        (self.job / 'previous-service-unit.conf').write_text(self.unit_text)
        # Use only the known service and slice. No discovered-process or pattern kill.

    def stop(self):
        run(['systemctl', '--user', 'stop', 't3code.service'], timeout=150)
        if run(['systemctl', '--user', 'show', 't3code.service', '-p', 'MainPID', '--value'], capture=True) != '0':
            raise RuntimeError('Service did not stop')
        run(['systemctl', '--user', 'stop', 'app-t3code-agents.slice'], timeout=150)
        if run(['ss', '-H', '-ltnp', f'sport = :{self.port}'], capture=True):
            raise RuntimeError('Port is still occupied; no processes killed')

    def start(self, runtime):
        # Retain the unit's other settings and every drop-in; move its exact launcher.
        entry = json.dumps(str(runtime / 't3')) + ' __service-launcher'
        unit = re.sub(r'^ExecStart=.+ __service-launcher$', lambda _: 'ExecStart=' + entry, self.unit_text, flags=re.M)
        temporary_unit = self.unit_file.with_name(self.unit_file.name + '.release-' + uuid.uuid4().hex)
        temporary_unit.write_text(unit)
        temporary_unit.replace(self.unit_file)
        run(['systemctl', '--user', 'daemon-reload'])
        temporary = self.link.with_name('t3.release-' + uuid.uuid4().hex)
        temporary.symlink_to(runtime / 't3')
        temporary.replace(self.link)
        run(['systemctl', '--user', 'start', 't3code.service'])

    def alive(self):
        return subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 't3code.service']).returncode == 0


class Windows:
    def __init__(self, home, job, port, executable):
        self.home, self.job, self.port, self.executable = home, job, port, Path(executable)
        self.resources = self.executable.parent / 'resources'
        self.log = home / 'userdata/logs/server.log'
        self.previous = job / 'previous-desktop'
        self.previous.mkdir()
        self.child = None

    def ps(self, action):
        run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HERE / 'windows.ps1',
             '-Action', action, '-Executable', self.executable, '-Port', self.port,
             '-MainPid', self.child.pid if self.child else 0], timeout=150)

    def inspect(self):
        self.ps('interactive'); self.ps('inspect')

    def prepare(self, built):
        prepared = self.job / 'desktop'; prepared.mkdir()
        for name in ['server.asar', 'app.asar']:
            shutil.copy2(self.resources / name, self.previous / name)
            repack(self.resources / name, prepared / name, built['version'],
                   Path(built['source']) / 'apps/server/dist' if name == 'server.asar' else None)
        return prepared

    def stop(self):
        self.ps('stop')
        self.child = None

    def start(self, runtime):
        # Only two existing ASARs change; original native sidecars stay in place.
        for name in ['server.asar', 'app.asar']:
            temporary = self.resources / (name + '.t3w-release-next')
            shutil.copy2(runtime / name, temporary)
            os.replace(temporary, self.resources / name)
        self.child = subprocess.Popen([str(self.executable)], cwd=self.executable.parent, env=clean_env())

    def alive(self):
        return self.child is None or self.child.poll() is None


def activate(args, built, job, rehearsal):
    home = Path(args.home).resolve()
    db = home / 'userdata/state.sqlite'
    state = home / 'runtime/service-state.json'
    previous_state = read(state) if state.exists() else None
    if previous_state is not None and (previous_state.get('protocol') != 3 or previous_state.get('update')):
        raise RuntimeError('Launcher protocol differs or a launcher update is pending')
    previous_version = descriptor(args.port)['serverVersion'] if not args.isolated else previous_state['activeVersion']
    if previous_state is not None and previous_state['activeVersion'] != previous_version:
        raise RuntimeError('Running version differs from launcher selection; finish the existing release first')
    previous = home / 'runtime/versions' / previous_version
    controller = Isolated(home, job, args.port) if args.isolated else Windows(home, job, args.port, args.desktop) if WINDOWS else Linux(home, job, args.port)
    if not args.isolated:
        controller.inspect()
    target = home / 'runtime/versions' / built['version']
    if target.exists():
        raise RuntimeError('Version already installed; refusing to overwrite: ' + str(target))
    shutil.copytree(built['runtime'], target)
    (target / '.install-complete').write_text(built['version'] + '\n')
    if WINDOWS and not args.isolated:
        target = controller.prepare(built)
        previous = controller.previous
    marker = home / 'runtime/t3w-deploy/release-in-progress.json'
    save(marker, {'job': str(job), 'version': built['version'], 'previousVersion': previous_version})
    logs = {p: p.stat().st_size for p in (home / 'userdata/logs').glob('**/*.log')}
    logs[controller.log] = controller.log.stat().st_size if controller.log.exists() else 0
    before = None
    try:
        if args.isolated:
            controller.start(previous)
            health(args.port, previous_version, 1, args.stall_ms, {}, controller.alive, args.ready_seconds)
        controller.stop()
        # Recheck after shutdown, before any new code has touched the live database.
        closed = fingerprint(db)
        if closed['migrations'] != rehearsal['before']:
            raise RuntimeError('Live migration ledger changed during build/rehearsal')
        before = closed
        if not WINDOWS or args.isolated:
            save(state, {'protocol': 3, 'activeVersion': built['version']})
        controller.start(target)
        result = health(args.port, built['version'], args.health_seconds, args.stall_ms, logs, controller.alive, args.ready_seconds)
        if ledger(db) != built['migrations']:
            raise RuntimeError('Live migration ledger differs after startup')
        marker.unlink()
        return {'status': 'healthy', 'health': result, 'migration': rehearsal}
    except Exception as error:
        try:
            controller.stop()
            # Unknown state is forward-only too. Never restore a database snapshot.
            unchanged = before is not None and fingerprint(db) == before
            if not unchanged:
                raise RuntimeError('Live migrations/schema changed or cannot be verified. Server is stopped; schema only moves forward. Repair the new version. ' + str(error)) from error
            if previous_state is not None:
                save(state, previous_state)
            controller.start(previous)
            health(args.port, previous_version, min(args.health_seconds, 10), args.stall_ms, {}, controller.alive, args.ready_seconds)
            marker.unlink()
            raise RuntimeError('Health check failed; rolled back to ' + previous_version + ': ' + str(error)) from error
        finally:
            if args.isolated:
                controller.stop()
    finally:
        if args.isolated:
            controller.stop()


def default_repo():
    conventional = Path.home() / 't3code-custom'
    config = Path.home() / '.config/workenv/windows-jobs.json'
    if WINDOWS and config.exists():
        sources = [p['source'] for p in read(config).get('projects', {}).values()
                   if Path(p.get('source', '')).name.lower() == 't3code-custom']
        if len(sources) == 1:
            return sources[0]
    return str(conventional)


def parser():
    p = argparse.ArgumentParser(description='Build fork main, rehearse migrations, activate locally and check health.')
    p.add_argument('--ref', default='origin/main')
    p.add_argument('--repo', default=default_repo())
    p.add_argument('--home', default=str(Path.home() / '.t3'))
    p.add_argument('--job', default=os.environ.get('T3_WORKSPACE_JOB_ROOT'))
    p.add_argument('--node', help='Node 26.8.2 executable')
    p.add_argument('--port', type=int, default=3773)
    p.add_argument('--migration-seconds', type=float, default=60)
    p.add_argument('--ready-seconds', type=float, default=900, help='Startup budget including 30 seconds of responsive descriptor and web probes')
    p.add_argument('--health-seconds', type=float, default=120)
    p.add_argument('--stall-ms', type=float, default=2000)
    p.add_argument('--desktop', default=str(Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'Programs/t3code/T3 Code (Alpha).exe'))
    p.add_argument('--dry-run', action='store_true', help='Print real-host steps; no build/install/restart')
    p.add_argument('--isolated', action='store_true', help='Use only an existing copied home under --job; stop owned test process on exit')
    p.add_argument('--runner', action='store_true', help=argparse.SUPPRESS)
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    if min(args.migration_seconds, args.ready_seconds, args.health_seconds, args.stall_ms) <= 0 or not 1024 <= args.port <= 65535:
        raise RuntimeError('Thresholds must be positive; port must be 1024..65535')
    if sys.platform not in ['linux', 'win32'] or platform.machine().lower() not in ['x86_64', 'amd64']:
        raise RuntimeError('This release command supports the existing Linux x64 and Windows x64 installs')
    home = Path(args.home).resolve()
    if args.dry_run:
        print(json.dumps({'command': 't3w release', 'ref': args.ref, 'home': str(home),
            'steps': ['fetch fork main; pin commit; build web/server/build-exe with Node 26.8.2',
                      f'VACUUM INTO job copy if migrations pending; refuse failure or >{args.migration_seconds}s; delete copy',
                      'lock runtime/t3w-deploy/host.lock; refuse unfinished deployment claims',
                      'stage a new version; stop t3code.service then app-t3code-agents.slice; switch; start' if not WINDOWS else 'interactive desktop: captured PID close; swap repacked server.asar/app.asar; start',
                      f'wait up to {args.ready_seconds:g}s for readiness; then check HTTP, exact version, event-loop stalls for {args.health_seconds}s',
                      'on failure: stop; rollback only if ledger AND schema unchanged; otherwise leave stopped'],
            'windows': 'In signed-in desktop PowerShell: node "$HOME\\t3-workflows\\bin\\t3w.mjs" release --ref origin/main'}, indent=2))
        check_claim(home)
        return
    if not args.job:
        command = ['workenv.cmd' if WINDOWS else 'workenv', 'job', '--session', str(uuid.uuid4()), '--cwd', args.repo, '--format', 'json']
        if WINDOWS:
            command = ['cmd.exe', '/d', '/c', *command]
        provisioned = json.loads(run(command, capture=True, timeout=120))
        args.job = provisioned['root']
        os.environ.update(provisioned['environment'])
    root = Path(args.job).resolve()
    if not root.is_dir():
        raise RuntimeError('--job must be an existing workenv job')
    if args.isolated:
        if home == Path.home() / '.t3' or root not in home.parents:
            raise RuntimeError('--isolated requires a copied T3 home inside --job')
        if any(home not in (home / name).resolve().parents for name in ['userdata/state.sqlite', 'runtime/versions']):
            raise RuntimeError('Isolated state/runtime paths must not link outside the copied home')
        if args.port == 3773:
            raise RuntimeError('Use a separate port for --isolated')
    elif not WINDOWS and not args.runner:
        # Survives stopping the agent slice when invoked from a T3 session.
        unit = 't3w-release-' + uuid.uuid4().hex[:12]
        log = root / 'outputs' / (unit + '.log')
        log.parent.mkdir(exist_ok=True)
        print('Release log: ' + str(log), flush=True)
        run(['systemd-run', '--user', '--wait', '--collect', '--unit=' + unit,
             '--property=Type=exec', '--property=StandardOutput=append:' + str(log),
             '--property=StandardError=append:' + str(log), '--setenv=PATH=' + os.environ['PATH'],
             sys.executable, HERE / 'release.py', *sys.argv[1:], '--job', str(root), '--runner'], timeout=7200)
        return
    if WINDOWS and not args.isolated:
        run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HERE / 'windows.ps1', '-Action', 'interactive'])
    job = root / ('release-' + time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:6])
    job.mkdir(mode=0o700)
    print('Release work and result: ' + str(job), flush=True)
    with host_lock(home):
        before = ledger(home / 'userdata/state.sqlite')
        built = build(args, job)
        rehearsal = rehearse(built, home / 'userdata/state.sqlite', job, args.migration_seconds)
        rehearsal['before'] = before
        save(job / 'rehearsal.json', rehearsal)
        try:
            result = activate(args, built, job, rehearsal)
        except Exception as error:
            save(job / 'result.json', {'status': 'failed', 'error': str(error), 'build': built})
            raise
        save(job / 'result.json', {**result, 'build': built})
        print(f"Released {built['version']}; migrations {rehearsal['seconds']}s; healthy {args.health_seconds}s. Result: {job / 'result.json'}", flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Release refused/failed: ' + str(error), file=sys.stderr, flush=True)
        sys.exit(1)
