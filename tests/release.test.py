from contextlib import closing
import json
from pathlib import Path
import sqlite3
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
                             "INSERT INTO history VALUES('keep me');")

    def tearDown(self):
        self.temporary.cleanup()

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

    def test_wrong_version_and_stall_are_unhealthy(self):
        with patch.object(release, 'descriptor', return_value={'serverVersion': 'wrong'}):
            with self.assertRaisesRegex(RuntimeError, 'version mismatch'):
                release.health(9000, 'wanted', 1, 2000, {})
        log = self.root / 'server.log'; log.write_text('event loop stalled for 3500 ms\n')
        with patch.object(release, 'descriptor', return_value={'serverVersion': 'wanted'}), patch.object(release.urllib.request, 'urlopen') as request:
            request.return_value.__enter__.return_value.status = 200
            with self.assertRaisesRegex(RuntimeError, 'stalled'):
                release.health(9000, 'wanted', 1, 2000, {log: 0})

    def test_failed_start_rolls_back_only_without_live_migration(self):
        for migrates in [False, True]:
            with self.subTest(migrates=migrates), tempfile.TemporaryDirectory() as folder:
                home = Path(folder) / 'home'
                job = Path(folder) / 'job'; job.mkdir()
                (home / 'userdata').mkdir(parents=True)
                import shutil
                shutil.copy2(self.db, home / 'userdata/state.sqlite')
                state = home / 'runtime/service-state.json'
                release.save(state, {'protocol': 3, 'activeVersion': 'old'})
                (home / 'runtime/versions/old').mkdir(parents=True)
                payload = job / 'payload'; payload.mkdir(); (payload / 't3').write_text('fixture')
                args = release.parser().parse_args(['--isolated', '--home', str(home), '--port', '49000'])
                built = {'version': 'new', 'runtime': str(payload), 'migrations': [[1, 'First'], [2, 'Second']] if migrates else [[1, 'First']]}
                starts = []
                class Server:
                    def __init__(self, *args): self.log = job / 'server.log'
                    def stop(self): pass
                    def alive(self): return True
                    def start(self, runtime):
                        starts.append(runtime.name)
                        if migrates and runtime.name == 'new':
                            with closing(sqlite3.connect(home / 'userdata/state.sqlite')) as db, db:
                                db.executescript("CREATE TABLE forward_only(value TEXT); INSERT INTO effect_sql_migrations VALUES(2,'Second');")
                with patch.object(release, 'Isolated', Server), patch.object(release, 'health', side_effect=[{}, RuntimeError('unhealthy'), {}]):
                    with self.assertRaisesRegex(RuntimeError, 'schema only moves forward' if migrates else 'rolled back to old'):
                        release.activate(args, built, job, {'before': [[1, 'First']]})
                self.assertEqual(starts, ['old', 'new'] if migrates else ['old', 'new', 'old'])
                self.assertEqual(release.read(state)['activeVersion'], 'new' if migrates else 'old')
                self.assertEqual((home / 'runtime/t3w-deploy/release-in-progress.json').exists(), migrates)

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
