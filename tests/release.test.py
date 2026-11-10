from contextlib import closing, contextmanager
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'release'))
import release


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.db = self.root / 'state.sqlite'
        with closing(sqlite3.connect(self.db)) as db, db:
            db.executescript('CREATE TABLE effect_sql_migrations(migration_id INTEGER, name TEXT);'
                             "INSERT INTO effect_sql_migrations VALUES(1,'First'); CREATE TABLE history(message TEXT);"
                             "INSERT INTO history VALUES('keep me');"
                             'CREATE TABLE projection_threads(id TEXT); INSERT INTO projection_threads VALUES("t1");'
                             'CREATE TABLE projection_thread_messages(role TEXT);'
                             "INSERT INTO projection_thread_messages VALUES('user'),('assistant'),('system');"
                             'CREATE TABLE projection_projects(id TEXT); INSERT INTO projection_projects VALUES("p1");'
                             'CREATE TABLE custom_workers(id TEXT, owner_id TEXT);'
                             'INSERT INTO custom_workers VALUES("w1","o1"),("w2","o1");')

    def tearDown(self):
        self.temporary.cleanup()

    @contextmanager
    def clock(self):
        now = [0.0]
        with patch.object(release.time, 'monotonic', side_effect=lambda: now[0]), patch.object(
            release.time, 'sleep', side_effect=lambda seconds: now.__setitem__(0, now[0] + seconds)
        ):
            yield now

    def test_vacuum_copies_committed_wal_and_preserves_source(self):
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute("INSERT INTO history VALUES('latest')"); db.commit()
            target = self.root / 'copy.sqlite'
            release.vacuum(self.db, target)
            with closing(sqlite3.connect(target)) as copy, copy:
                self.assertEqual(copy.execute('SELECT message FROM history').fetchall(), [('keep me',), ('latest',)])
                copy.execute("DELETE FROM history"); copy.commit()
            self.assertEqual(db.execute('SELECT COUNT(*) FROM history').fetchone()[0], 2)

    def test_ledger_rejects_old_conflicting_and_inserted_migrations(self):
        current = [[1, 'First'], [3, 'Third']]
        for wanted in [[[1, 'First']], [[1, 'Wrong'], [3, 'Third']], [[1, 'First'], [2, 'Second'], [3, 'Third']]]:
            with self.assertRaises(RuntimeError):
                release.pending_migrations(current, wanted)
        self.assertEqual(release.pending_migrations(current, current + [[4, 'Fourth']]), [[4, 'Fourth']])

    def test_schema_change_disables_rollback_even_without_ledger_change(self):
        before = release.fingerprint(self.db)
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute('CREATE TABLE new_schema(value TEXT)')
        self.assertNotEqual(before, release.fingerprint(self.db))

    def test_rehearsal_failure_and_timeout_remove_all_copy_files(self):
        import subprocess
        built = {'migrations': [[1, 'First'], [2, 'Second']], 'node': 'unused', 'source': str(self.root)}
        for error in [RuntimeError('migration failed'), subprocess.TimeoutExpired('migrate', 0.01)]:
            with patch.object(release, 'run', side_effect=error):
                with self.assertRaises(type(error)):
                    release.rehearse(built, self.db, self.root, 0.01)
            self.assertFalse(list(self.root.glob('migration-rehearsal.sqlite*')))
            self.assertEqual(release.ledger(self.db), [[1, 'First']])

    def test_exe_build_uses_node_26_when_source_pins_older_node(self):
        with tempfile.TemporaryDirectory() as d:
            for engine, expected in [('^24.13.1', '26.8.2'), ('26.9.0', '26.9.0'), ('', '26.8.2')]:
                Path(d, 'package.json').write_text(json.dumps({'engines': {'node': engine}}))
                self.assertEqual(release.required_node(d), expected)
            self.assertEqual(release.required_node(d, '25.8.0'), '25.8.0')

    def test_no_pending_does_not_make_copy(self):
        with patch.object(release, 'vacuum', side_effect=AssertionError('unneeded copy')):
            self.assertEqual(release.rehearse({'migrations': [[1, 'First']]}, self.db, self.root, 60)['pending'], [])

    def test_unfinished_release_refused_under_shared_lock(self):
        root = self.root / 'runtime/t3w-deploy'
        release.save(root / 'claim.json', {'id': 'primary', 'manifestHash': 'hash'})
        release.save(root / 'primary/receipt.json', {'phase': 'staged', 'manifestHash': 'hash'})
        with self.assertRaisesRegex(RuntimeError, 'unfinished'):
            with release.host_lock(self.root):
                self.fail('entered lock')

    def switchover_home(self):
        home = self.root / 'home'
        (home / 'userdata').mkdir(parents=True)
        import shutil
        shutil.copy2(self.db, home / 'userdata/state.sqlite')
        release.save(home / 'runtime/service-state.json', {'protocol': 3, 'activeVersion': 'custom'})
        (home / 'runtime/versions/custom').mkdir(parents=True)
        (home / 'runtime/versions/custom/t3').write_text('custom')
        payload = home / 'payload'
        payload.mkdir()
        (payload / 't3').write_text('v2')
        (payload / 'client').mkdir()
        (payload / 'client/index.html').write_text('v2 client')
        release.save(payload / 'package.json', {'version': '0.1.5+git.payload', 'sourceCommit': 'payload',
                                                'line': 'v2', 'protocol': 2})
        return home, payload

    def test_switchover_plan_covers_v1_wal_copy_and_growth(self):
        (self.root / 'state.sqlite-wal').write_bytes(b'x' * 11)
        plan = release.switchover_disk_plan(self.db, 2 * release.GIB, 3 * release.GIB)
        size = self.db.stat().st_size
        self.assertEqual(plan['v1Bytes'], size)
        self.assertEqual(plan['walBytes'], 11)
        # The V2 copy is compacted, so the plan reserves a fraction of the V1 file for it.
        self.assertEqual(plan['v2TotalBytes'], int(size * 0.75))
        self.assertEqual(plan['homeRequiredBytes'], size + int(size * 0.75) + 11 + 2 * release.GIB)
        self.assertEqual(release.switchover_disk_plan(self.db, 0, 0, 1.0)['v2TotalBytes'], size)

    def test_v2_count_checks_use_import_semantics(self):
        destination = self.root / 'statev2.sqlite'
        with closing(sqlite3.connect(destination)) as db, db:
            db.executescript('CREATE TABLE orchestration_v2_projection_threads(id TEXT);'
                             'INSERT INTO orchestration_v2_projection_threads VALUES("t1");'
                             'CREATE TABLE orchestration_v2_projection_messages(id TEXT);'
                             'INSERT INTO orchestration_v2_projection_messages VALUES("m1"),("m2");'
                             'CREATE TABLE projection_projects(id TEXT); INSERT INTO projection_projects VALUES("p1");'
                             'CREATE TABLE custom_workers(id TEXT, owner_id TEXT);'
                             'INSERT INTO custom_workers VALUES("w1","o1"),("w2","o1");')
        checks = {check['name']: check for check in release.v2_count_checks(self.db, destination)}
        self.assertTrue(all(check['matches'] for check in checks.values()), checks)
        self.assertEqual((checks['messages']['source'], checks['messages']['imported']), (2, 2))
        self.assertEqual((checks['workers']['source'], checks['owners']['source']), (2, 1))

    def test_prebuilt_runtime_needs_launcher_client_and_pinned_source(self):
        runtime = self.root / 'built'
        (runtime / 'client').mkdir(parents=True)
        (runtime / 't3').write_text('launcher')
        release.save(runtime / 'package.json', {'version': '0.1.5+git.abc', 'sourceCommit': 'abc'})
        with self.assertRaisesRegex(RuntimeError, 'web client'):
            release.prebuilt_runtime(runtime)
        (runtime / 'client/index.html').write_text('client')
        built = release.prebuilt_runtime(runtime)
        self.assertEqual((built['version'], built['commit']), ('0.1.5+git.abc', 'abc'))

    def test_switchover_refuses_to_import_over_existing_v2_state(self):
        home, payload = self.switchover_home()
        (home / 'userdata/statev2.sqlite').write_bytes(b'newer V2 writes')
        args = release.parser().parse_args(['switchover', '--isolated', '--home', str(home), '--port', '49000'])
        with self.assertRaisesRegex(RuntimeError, 'may hold newer data'):
            release.switchover_activate(args, release.prebuilt_runtime(payload), home, {})
        self.assertEqual((home / 'userdata/statev2.sqlite').read_bytes(), b'newer V2 writes')

    def test_failed_switchover_restarts_custom_and_keeps_statev2(self):
        home, payload = self.switchover_home()
        job = self.root / 'job'; job.mkdir()
        args = release.parser().parse_args(['switchover', '--isolated', '--home', str(home), '--port', '49000'])
        built = release.prebuilt_runtime(payload)
        built['version'] = '0.1.5+git.abc'
        db = home / 'userdata/state.sqlite'
        starts = []

        class Server:
            def __init__(self, *arguments):
                self.log = home / 'userdata/logs/boot.log'

            def stop(self): pass

            def alive(self): return True

            def start(self, runtime):
                starts.append(Path(runtime).name)
                if Path(runtime).name != 'custom':
                    import shutil
                    statev2 = home / 'userdata/statev2.sqlite'
                    shutil.copy2(db, statev2)
                    with closing(sqlite3.connect(statev2)) as copy, copy:
                        copy.executescript(
                            'CREATE TABLE orchestration_v2_projection_threads(id TEXT);'
                            'INSERT INTO orchestration_v2_projection_threads VALUES("t1");'
                            'CREATE TABLE orchestration_v2_projection_messages(id TEXT);'
                            'INSERT INTO orchestration_v2_projection_messages VALUES("m1"),("m2");')
                    release.save(home / 'userdata/v2-import-receipts/v1-import-once.json',
                                 {'snapshot': {'ledger': ['1:First']}, 'source': {'path': str(db)}})

        with patch.object(release, 'Isolated', Server), patch.object(
                release, 'health', side_effect=[RuntimeError('v2 web client did not answer'), {}]) as health:
            with self.assertRaisesRegex(RuntimeError, 'rolled back to custom.*statev2.sqlite is retained'):
                release.switchover_activate(args, built, job, {})
        self.assertEqual(starts, ['0.1.5+git.abc', 'custom'])
        self.assertEqual(release.read(home / 'runtime/service-state.json')['activeVersion'], 'custom')
        self.assertTrue((home / 'userdata/statev2.sqlite').exists())
        self.assertFalse((home / 'runtime/t3w-deploy/switchover-in-progress.json').exists())
        self.assertEqual(release.ledger(db), [[1, 'First']])
        self.assertEqual(health.call_args_list[-1].args[1], 'custom')

    def test_switchover_reports_counts_and_keeps_retained_custom_runtime(self):
        home, payload = self.switchover_home()
        job = self.root / 'job'; job.mkdir()
        args = release.parser().parse_args(['switchover', '--isolated', '--home', str(home), '--port', '49000'])
        built = release.prebuilt_runtime(payload)
        built['version'] = '0.1.5+git.abc'
        db = home / 'userdata/state.sqlite'

        class Server:
            def __init__(self, *arguments):
                self.log = home / 'userdata/logs/boot.log'

            def stop(self): pass

            def alive(self): return True

            def start(self, runtime):
                # The service launcher runs whatever service-state.json selects.
                selected = release.read(home / 'runtime/service-state.json')['activeVersion']
                assert selected == Path(runtime).name, (selected, runtime)
                if Path(runtime).name != 'custom':
                    import shutil
                    statev2 = home / 'userdata/statev2.sqlite'
                    shutil.copy2(db, statev2)
                    with closing(sqlite3.connect(statev2)) as copy, copy:
                        copy.executescript(
                            'CREATE TABLE orchestration_v2_projection_threads(id TEXT);'
                            'INSERT INTO orchestration_v2_projection_threads VALUES("t1");'
                            'CREATE TABLE orchestration_v2_projection_messages(id TEXT);'
                            'INSERT INTO orchestration_v2_projection_messages VALUES("m1"),("m2");')
                    release.save(home / 'userdata/v2-import-receipts/v1-import-once.json',
                                 {'snapshot': {'ledger': ['1:First']}, 'source': {'path': str(db)}})

        with patch.object(release, 'Isolated', Server), patch.object(release, 'health', return_value={}):
            result = release.switchover_activate(args, built, job, {})
        self.assertEqual(result['status'], 'healthy')
        self.assertTrue(all(check['matches'] for check in result['counts']))
        self.assertEqual(release.read(home / 'runtime/service-state.json')['activeVersion'], '0.1.5+git.abc')
        self.assertTrue((home / 'runtime/versions/custom/t3').is_file())
        self.assertIn('statev2.sqlite', result['rollback']['note'])

    def test_rollback_restarts_custom_keeps_statev2_and_refuses_moved_v1(self):
        home, payload = self.switchover_home()
        job = self.root / 'job'; job.mkdir()
        args = release.parser().parse_args(['switchover', '--isolated', '--home', str(home), '--port', '49000'])
        built = release.prebuilt_runtime(payload)
        built['version'] = '0.1.5+git.abc'
        db = home / 'userdata/state.sqlite'
        starts = []

        class Server:
            def __init__(self, *arguments):
                self.log = home / 'userdata/logs/boot.log'

            def stop(self): pass

            def alive(self): return True

            def start(self, runtime):
                starts.append(Path(runtime).name)
                if Path(runtime).name != 'custom':
                    import shutil
                    statev2 = home / 'userdata/statev2.sqlite'
                    shutil.copy2(db, statev2)
                    with closing(sqlite3.connect(statev2)) as copy, copy:
                        copy.executescript(
                            'CREATE TABLE orchestration_v2_projection_threads(id TEXT);'
                            'INSERT INTO orchestration_v2_projection_threads VALUES("t1");'
                            'CREATE TABLE orchestration_v2_projection_messages(id TEXT);'
                            'INSERT INTO orchestration_v2_projection_messages VALUES("m1"),("m2");')
                    release.save(home / 'userdata/v2-import-receipts/v1-import-once.json',
                                 {'snapshot': {'ledger': ['1:First']}, 'source': {'path': str(db)}})

        with patch.object(release, 'Isolated', Server), patch.object(release, 'health', return_value={}) as health:
            release.switchover_activate(args, built, job, {})
            rollback = release.parser().parse_args(
                ['switchover', '--rollback', '--isolated', '--home', str(home), '--port', '49000'])
            result = release.switchover_rollback(rollback, job)
        self.assertEqual(result['status'], 'rolled-back')
        self.assertEqual(release.read(home / 'runtime/service-state.json')['activeVersion'], 'custom')
        self.assertEqual(starts, ['0.1.5+git.abc', 'custom'])
        self.assertTrue(result['statev2Present'])
        self.assertIn('not written back to V1', result['v2WritesRetained'])
        self.assertEqual(health.call_args_list[-1].args[7], 1)

        # Pretend the host is on V2 again; only the V1 fingerprint check may stop the rollback.
        release.save(home / 'runtime/service-state.json', {'protocol': 3, 'activeVersion': '0.1.5+git.abc'})
        with self.assertRaisesRegex(RuntimeError, 'V1 database changed since the switchover'):
            with closing(sqlite3.connect(db)) as raw, raw:
                raw.execute('CREATE TABLE newer_v1(value TEXT)')
            release.switchover_rollback(rollback, job)

    def test_crashed_service_uses_launcher_version_only_when_stopped(self):
        args = type('Args', (), {'isolated': False, 'port': 9000})()
        state = {'protocol': 3, 'activeVersion': 'selected'}
        refused = release.urllib.error.URLError(ConnectionRefusedError(111, 'Connection refused'))
        with patch.object(release, 'WINDOWS', False), patch.object(release, 'descriptor', side_effect=refused):
            with patch.object(release, 'run', return_value='failed'):
                self.assertEqual(release.running_version(args, state), 'selected')
            with patch.object(release, 'run', return_value='activating'):
                with self.assertRaises(release.urllib.error.URLError):
                    release.running_version(args, state)

    def test_wrong_version_fails_by_name_and_event_loop_stalls_are_only_reported(self):
        with patch.object(release, 'descriptor', return_value={'serverVersion': 'wrong'}):
            with self.assertRaisesRegex(release.Unhealthy, 'wrong version: server reports wrong, expected wanted') as raised:
                release.health(9000, 'wanted', 1, 2000, {})
            self.assertEqual(raised.exception.cause, 'wrong version')
        log = self.root / 'server.log'; log.write_text('')
        with self.clock() as now, patch.object(release.urllib.request, 'urlopen') as request:
            def descriptor(*args):
                if now[0] >= 31:
                    log.write_text('event loop stalled for 2014 ms\n')
                return {'serverVersion': 'wanted'}
            request.return_value.__enter__.return_value.status = 200
            with patch.object(release, 'descriptor', side_effect=descriptor):
                result = release.health(9000, 'wanted', 1, 2000, {log: 0})
            self.assertEqual((result['eventLoopStalls'], result['maxEventLoopStallMs']), (1, 2014))
            self.assertEqual(now[0], 31)

    def test_readiness_outlasts_slow_startup_and_reports_last_probe(self):
        with self.clock(), patch.object(release, 'descriptor', side_effect=TimeoutError('timed out')):
            with self.assertRaisesRegex(RuntimeError, 'within 0.01 seconds; last probe: TimeoutError: timed out'):
                release.health(9000, 'wanted', 1, 2000, {}, ready_seconds=0.01)

    def test_first_response_does_not_end_startup_and_startup_stall_is_not_steady_state(self):
        log = self.root / 'server.log'; log.write_text('')
        with self.clock() as now, patch.object(release.urllib.request, 'urlopen') as request:
            def descriptor(port, timeout):
                self.assertEqual(timeout, 2)
                if now[0] < 3 or now[0] == 4:
                    raise TimeoutError('HTTP response headers timed out')
                if now[0] == 10:
                    log.write_text('event loop stalled for 2014 ms\n')
                return {'serverVersion': 'wanted'}
            request.return_value.__enter__.return_value.status = 200
            with patch.object(release, 'descriptor', side_effect=descriptor):
                result = release.health(9000, 'wanted', 120, 2000, {log: 0})
            self.assertEqual(result['readySeconds'], 35)
            self.assertEqual(result['seconds'], 120)
            self.assertEqual(now[0], 155)
            self.assertTrue(all(call.kwargs['timeout'] == 2 for call in request.call_args_list))

    def test_settling_retries_share_the_original_readiness_deadline(self):
        with self.clock() as now, patch.object(release.urllib.request, 'urlopen') as request:
            def descriptor(*args):
                if now[0] % 4 == 2:
                    raise TimeoutError('startup burst')
                return {'serverVersion': 'wanted'}
            request.return_value.__enter__.return_value.status = 200
            with patch.object(release, 'descriptor', side_effect=descriptor), self.assertRaisesRegex(RuntimeError, 'within 40 seconds'):
                release.health(9000, 'wanted', 120, 2000, {}, ready_seconds=40)
            self.assertEqual(now[0], 40)

    def test_one_timed_out_probe_is_tolerated_and_only_sustained_silence_fails(self):
        for failing_endpoint in ['descriptor', 'web']:
            for silent_until in [41, float('inf')]:
                with self.subTest(endpoint=failing_endpoint, until=silent_until), self.clock() as now, patch.object(
                        release.urllib.request, 'urlopen') as request:
                    def silent():
                        return 40 <= now[0] < silent_until
                    def descriptor(*args):
                        if failing_endpoint == 'descriptor' and silent():
                            raise TimeoutError('timed out')
                        return {'serverVersion': 'wanted'}
                    def web(*args, **kwargs):
                        if failing_endpoint == 'web' and silent():
                            raise TimeoutError('timed out')
                        return response
                    response = request.return_value
                    response.__enter__.return_value.status = 200
                    request.side_effect = web
                    with patch.object(release, 'descriptor', side_effect=descriptor):
                        if silent_until == 41:
                            result = release.health(9000, 'wanted', 120, 2000, {}, unresponsive_seconds=60)
                            self.assertEqual((result['failedProbes'], result['seconds'], now[0]), (1, 120, 150))
                            continue
                        with self.assertRaisesRegex(release.Unhealthy, 'unresponsive: no successful probe for 60 seconds; '
                                                    'last probe: TimeoutError: timed out') as raised:
                            release.health(9000, 'wanted', 120, 2000, {}, unresponsive_seconds=60)
                    self.assertEqual(raised.exception.cause, 'unresponsive')
                    # Last answer at 39 s; the stated 60 s window ends the check, not the first miss at 40 s.
                    self.assertEqual(now[0], 99)

    def activation(self, folder, wanted, extra=()):
        home = Path(folder) / 'home'
        job = Path(folder) / 'job'; job.mkdir()
        (home / 'userdata').mkdir(parents=True)
        shutil.copy2(self.db, home / 'userdata/state.sqlite')
        (home / 'runtime/versions/old').mkdir(parents=True)
        payload = job / 'payload'; payload.mkdir(); (payload / 't3').write_text('fixture')
        args = release.parser().parse_args(['--home', str(home), '--port', '49000', *extra])
        return home, job, args, {'version': 'new', 'runtime': str(payload), 'migrations': wanted, 'source': str(job / 'source')}

    def migrate(self, home):
        with closing(sqlite3.connect(home / 'userdata/state.sqlite')) as db, db:
            db.executescript("CREATE TABLE forward_only(value TEXT); INSERT INTO effect_sql_migrations VALUES(2,'Second');")

    def server(self, home, job, on_start=lambda name: None, on_stop=lambda name: None, launchable=True):
        """A stand-in for the isolated server: `up` is the version answering HTTP, or None."""
        test = self
        class Server:
            hint, up, events = 'START-COMMAND', None, []
            def __init__(self, *args): self.log = job / 'server.log'
            def stop(self):
                Server.events.append('stop')
                on_stop(Server.up)
                Server.up = None
            def start(self, runtime):
                Server.events.append('start ' + runtime.name)
                Server.up = runtime.name
                on_start(runtime.name)
            def launch(self):
                Server.events.append('launch')
                if not launchable:
                    raise RuntimeError('exec failed')
                Server.up = release.read(home / 'runtime/service-state.json')['activeVersion']
            def alive(self): return Server.up is not None
            running = alive
        def descriptor(port, timeout=5):
            if Server.up is None:
                raise ConnectionRefusedError('refused')
            return {'serverVersion': Server.up}
        return Server, patch.object(release, 'descriptor', side_effect=descriptor)

    def test_failed_health_after_migration_leaves_new_version_running(self):
        failure = release.Unhealthy('unresponsive', 'no successful probe for 60 seconds')
        # [what the fake does, events after the new version started, final message]
        cases = {
            'still running': ['stop'],
            'stopped by the script': ['stop', 'launch', 'stop'],
            'died': ['launch', 'stop'],
            'cannot start': ['launch', 'stop'],
        }
        for case, after in cases.items():
            with self.subTest(case=case), tempfile.TemporaryDirectory() as folder, self.clock():
                home, job, args, built = self.activation(folder, [[1, 'First'], [2, 'Second']], ['--isolated'])
                state = home / 'runtime/service-state.json'
                release.save(state, {'protocol': 3, 'activeVersion': 'old'})
                # The migration commits at startup, or only while the script is stopping the server.
                late = case == 'stopped by the script'
                Server, answers = self.server(
                    home, job, launchable=case != 'cannot start',
                    on_start=lambda name: name == 'new' and not late and self.migrate(home),
                    on_stop=lambda name: name == 'new' and late and release.ledger(home / 'userdata/state.sqlite') == [[1, 'First']] and self.migrate(home))
                def health(port, version, *rest, **options):
                    if version != 'new':
                        return {}
                    if case in ('died', 'cannot start'):
                        Server.up = None
                    raise failure
                with patch.object(release, 'Isolated', Server), answers, patch.object(release, 'health', side_effect=health):
                    with self.assertRaises(RuntimeError) as raised:
                        release.activate(args, built, job, {'before': [[1, 'First']]})
                message = str(raised.exception)
                if case == 'cannot start':
                    self.assertRegex(message, 'new is installed, but the server is NOT running and could not be started. '
                                              'Start it with: START-COMMAND. unresponsive: no successful probe')
                else:
                    self.assertEqual(message, 'new is running but failed the health check: unresponsive: no successful probe for 60 seconds')
                # The last stop is the isolated teardown; a real host has none.
                self.assertEqual(Server.events, ['start old', 'stop', 'start new', *after])
                self.assertEqual(release.read(state)['activeVersion'], 'new')
                self.assertTrue((home / 'runtime/t3w-deploy/release-in-progress.json').exists())

    def test_failed_health_without_migration_rolls_back_and_abort_before_switch_restarts_old(self):
        for case in ['rollback', 'stop failed', 'ledger moved']:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as folder, self.clock():
                home, job, args, built = self.activation(folder, [[1, 'First']], ['--isolated'])
                state = home / 'runtime/service-state.json'
                release.save(state, {'protocol': 3, 'activeVersion': 'old'})
                def on_stop(name, failures=[case == 'stop failed']):
                    if failures.pop():
                        failures.append(False)
                        raise RuntimeError('Port is still occupied; no processes killed')
                    failures.append(False)
                Server, answers = self.server(home, job, on_stop=on_stop)
                rehearsal = {'before': [[0, 'Other']] if case == 'ledger moved' else [[1, 'First']]}
                with patch.object(release, 'Isolated', Server), answers, patch.object(
                        release, 'health', side_effect=[{}, RuntimeError('unhealthy'), {}]):
                    with self.assertRaises(RuntimeError) as raised:
                        release.activate(args, built, job, rehearsal)
                message = str(raised.exception)
                if case == 'rollback':
                    self.assertEqual(message, 'Health check failed; rolled back to old: unhealthy')
                    self.assertEqual(Server.events, ['start old', 'stop', 'start new', 'stop', 'start old', 'stop'])
                else:
                    self.assertRegex(message, 'Release aborted before the switch; old is running: ')
                    # A stopped old server is started again; one that never stopped is left alone.
                    self.assertEqual(Server.events[:3], ['start old', 'stop', 'stop' if case == 'stop failed' else 'launch'])
                    self.assertFalse((home / 'runtime/versions/new').exists())
                self.assertEqual(release.read(state)['activeVersion'], 'old')
                self.assertFalse((home / 'runtime/t3w-deploy/release-in-progress.json').exists())

    def windows_desktop(self, folder, wanted):
        """The real Windows controller with PowerShell and the desktop process replaced by `desktop`."""
        home, job, args, built = self.activation(folder, wanted, ['--desktop', str(Path(folder) / 'app/T3.exe'), '--close-seconds', '5'])
        resources = Path(folder) / 'app/resources'; resources.mkdir(parents=True)
        for name in ['server.asar', 'app.asar']:
            (resources / name).write_text('old')
        # state: open, closing (asked to close, still answering) or closed; `late` looks later, a closing one is closed.
        desktop = {'state': 'open', 'stop': 'closes', 'late': None, 'launched': []}
        def ps(controller, action, check=True):
            if action == 'running':
                if desktop['late'] == 0:
                    desktop.update(state='closed', late=None)
                elif desktop['late']:
                    desktop['late'] -= 1
                return 3 if desktop['state'] == 'closed' else 0
            if action == 'stop':
                self.assertEqual(controller.close_seconds, 5)
                if desktop['state'] != 'closed' and desktop['stop'] != 'closes':
                    desktop['state'] = 'closing'
                    raise subprocess.CalledProcessError(1, 'windows.ps1 -Action stop')
                desktop['state'] = 'closed'
        def popen(*args, **kwargs):
            # A second instance exits at once while the first still holds the single-instance lock.
            if desktop['state'] == 'closed':
                desktop['state'] = 'open'
                desktop['launched'].append((resources / 'server.asar').read_text() + '/' + (resources / 'app.asar').read_text())
        def descriptor(port, timeout=5):
            if desktop['state'] == 'closed':
                raise ConnectionRefusedError('refused')
            return {'serverVersion': (resources / 'server.asar').read_text()}
        patches = [patch.object(release, 'WINDOWS', True), patch.object(release.Windows, 'ps', autospec=True, side_effect=ps),
                   patch.object(release.subprocess, 'Popen', side_effect=popen), patch.object(release, 'descriptor', side_effect=descriptor),
                   patch.object(release, 'repack', side_effect=lambda old, target, version, dist=None: Path(target).write_text(version))]
        return home, job, args, built, desktop, patches

    def test_windows_desktop_is_never_left_closed(self):
        from contextlib import ExitStack
        marker = 'runtime/t3w-deploy/release-in-progress.json'
        # Closed late, during the wait that follows the failed stop: that is closed, and the release goes on.
        with tempfile.TemporaryDirectory() as folder, ExitStack() as stack, self.clock():
            home, job, args, built, desktop, patches = self.windows_desktop(folder, [[1, 'First']])
            [stack.enter_context(p) for p in patches]
            desktop.update(stop='hangs', late=0)
            with patch.object(release, 'health', return_value={}):
                self.assertEqual(release.activate(args, built, job, {'before': [[1, 'First']]})['status'], 'healthy')
            self.assertEqual(desktop['launched'], ['new/new'])
            self.assertFalse((home / marker).exists())
        # Still closing when the wait ends: abort before the swap, then start the old app once it has closed.
        with tempfile.TemporaryDirectory() as folder, ExitStack() as stack, self.clock():
            home, job, args, built, desktop, patches = self.windows_desktop(folder, [[1, 'First']])
            [stack.enter_context(p) for p in patches]
            desktop.update(stop='hangs', late=3)
            with patch.object(release, 'health', side_effect=AssertionError('nothing new was started')):
                with self.assertRaisesRegex(RuntimeError, 'Release aborted before the switch; old is running: '):
                    release.activate(args, built, job, {'before': [[1, 'First']]})
            self.assertEqual((desktop['state'], desktop['launched']), ('open', ['old/old']))
            self.assertFalse((home / marker).exists())
            self.assertFalse((home / 'runtime/versions/new').exists())
        # Never closes: nothing is swapped or forced, and the old app that still answers is reported as running.
        with tempfile.TemporaryDirectory() as folder, ExitStack() as stack, self.clock() as now:
            home, job, args, built, desktop, patches = self.windows_desktop(folder, [[1, 'First']])
            [stack.enter_context(p) for p in patches]
            desktop.update(stop='hangs')
            with self.assertRaisesRegex(RuntimeError, 'Release aborted before the switch; old is running: '):
                release.activate(args, built, job, {'before': [[1, 'First']]})
            self.assertEqual((desktop['state'], desktop['launched'], now[0]), ('closing', [], 120))
            self.assertEqual((Path(folder) / 'app/resources/server.asar').read_text(), 'old')
        # After the swap with the schema moved: the new app is started again when it is found closed.
        with tempfile.TemporaryDirectory() as folder, ExitStack() as stack, self.clock():
            home, job, args, built, desktop, patches = self.windows_desktop(folder, [[1, 'First'], [2, 'Second']])
            [stack.enter_context(p) for p in patches]
            def health(*rest, **options):
                self.migrate(home)
                desktop['state'] = 'closed'
                raise release.Unhealthy('exited', 'the server process is not running')
            with patch.object(release, 'health', side_effect=health):
                with self.assertRaisesRegex(RuntimeError, 'new is running but failed the health check: exited: '):
                    release.activate(args, built, job, {'before': [[1, 'First']]})
            self.assertEqual((desktop['state'], desktop['launched']), ('open', ['new/new', 'new/new']))
            self.assertTrue((home / marker).exists())
        # After the swap with the schema unchanged: the old ASARs are put back and started.
        with tempfile.TemporaryDirectory() as folder, ExitStack() as stack, self.clock():
            home, job, args, built, desktop, patches = self.windows_desktop(folder, [[1, 'First']])
            [stack.enter_context(p) for p in patches]
            with patch.object(release, 'health', side_effect=[RuntimeError('unhealthy'), {}]):
                with self.assertRaisesRegex(RuntimeError, 'rolled back to old: unhealthy'):
                    release.activate(args, built, job, {'before': [[1, 'First']]})
            self.assertEqual((desktop['state'], desktop['launched']), ('open', ['new/new', 'old/old']))

    def test_leftover_marker_of_an_installed_release_is_cleared_by_a_health_check_without_rebuilding(self):
        root = self.root / 'jobroot'; root.mkdir()
        home, job, args, built = self.activation(root, [[1, 'First']])
        state = home / 'runtime/service-state.json'
        release.save(state, {'protocol': 3, 'activeVersion': 'new'})
        release.save(home / 'runtime/versions/new/package.json', {'version': 'new', 'sourceCommit': 'abc', 'migrations': [[1, 'First']]})
        marker = home / 'runtime/t3w-deploy/release-in-progress.json'
        argv = ['--isolated', '--home', str(home), '--job', str(root), '--port', '49000']
        for commit, healthy in [('other', True), ('abc', False), ('abc', True)]:
            with self.subTest(commit=commit, healthy=healthy):
                release.save(marker, {'job': 'gone', 'version': 'new', 'previousVersion': 'old'})
                Server, answers = self.server(home, job)
                outcome = {} if healthy else release.Unhealthy('unresponsive', 'no successful probe for 60 seconds')
                with patch.object(release, 'Isolated', Server), answers, patch.object(release, 'pinned_commit', return_value=commit), \
                        patch.object(release, 'build', side_effect=AssertionError('rebuilt')), \
                        patch.object(release, 'health', side_effect=[outcome]) as health:
                    if commit == 'abc' and healthy:
                        release.main(argv)
                        self.assertFalse(marker.exists())
                        self.assertEqual(Server.events, ['launch', 'stop'])
                        self.assertEqual(health.call_args.args[1], 'new')
                        continue
                    with self.assertRaisesRegex(RuntimeError, 'needs inspection' if commit == 'other' else
                                                'new is running but failed the health check: unresponsive'):
                        release.main(argv)
                    self.assertTrue(marker.exists())

    def test_asar_repack_preserves_native_entries_and_other_bytes(self):
        import struct
        from repack import repack
        old = self.root / 'old.asar'
        package = json.dumps({'version': 'old', 'dependencies': {'native': '1.0'}}).encode()
        header = {'files': {'package.json': {'offset': '0', 'size': len(package)},
                           'keep.txt': {'offset': str(len(package)), 'size': 4},
                           'native.node': {'unpacked': True, 'size': 123},
                           'linked': {'link': 'keep.txt'},
                           'apps': {'files': {'server': {'files': {'dist': {'files': {}}}}}}}}
        raw = json.dumps(header).encode(); payload = struct.pack('<I', len(raw)) + raw
        payload += bytes((-len(payload)) % 4); pickle = struct.pack('<I', len(payload)) + payload
        old.write_bytes(struct.pack('<II', 4, len(pickle)) + pickle + package + b'keep')
        dist = self.root / 'dist'; dist.mkdir(); (dist / 'bin.mjs').write_text('new server')
        output = self.root / 'new.asar'; repack(old, output, 'new', dist)
        data = output.read_bytes(); words = struct.unpack('<4I', data[:16]); start = 8 + words[1]
        result = json.loads(data[16:16+words[3]])
        entry = result['files']['keep.txt']
        self.assertEqual(data[start+int(entry['offset']):start+int(entry['offset'])+entry['size']], b'keep')
        self.assertEqual(result['files']['native.node'], header['files']['native.node'])
        self.assertEqual(result['files']['linked'], header['files']['linked'])
        entry = result['files']['package.json']
        manifest = json.loads(data[start+int(entry['offset']):start+int(entry['offset'])+entry['size']])
        self.assertEqual(manifest, {'version': 'new', 'dependencies': {'native': '1.0'}})
        self.assertEqual(old.read_bytes()[-4:], b'keep')

    def test_linux_switch_preserves_unit_settings_and_selects_new_runtime(self):
        if release.WINDOWS:
            self.skipTest('Linux symlink and systemd unit fixture')
        home = self.root / 'home'; job = self.root / 'job'; job.mkdir()
        controller = release.Linux(home, job, 49000)
        controller.link = self.root / 't3'
        controller.link.symlink_to(self.root / 'old/t3')
        controller.unit_file = self.root / 't3code.service'
        controller.unit_text = '[Service]\nExecStart=/old/t3 __service-launcher\nCPUWeight=1000\nKillMode=mixed\n'
        controller.unit_file.write_text(controller.unit_text)
        target = self.root / 'new version'
        with patch.object(release, 'run'):
            controller.start(target)
        self.assertEqual(controller.link.resolve(), target / 't3')
        unit = controller.unit_file.read_text()
        self.assertIn('CPUWeight=1000\nKillMode=mixed', unit)
        self.assertIn('ExecStart="' + str(target / 't3') + '" __service-launcher', unit)


if __name__ == '__main__':
    unittest.main()
