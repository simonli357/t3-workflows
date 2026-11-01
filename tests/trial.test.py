from contextlib import closing
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'release'))
import trial


class TrialTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.job = Path(self.tmp.name)
        self.source = self.job / 'live'
        (self.source / 'userdata').mkdir(parents=True)
        self.db = self.source / 'userdata/state.sqlite'
        with closing(sqlite3.connect(self.db)) as db, db:
            db.executescript('''CREATE TABLE custom_worker_jobs(id TEXT, state TEXT, reported INT, error TEXT);
              INSERT INTO custom_worker_jobs VALUES('j', 'queued', 0, NULL);
              CREATE TABLE custom_workers(thread_id TEXT, owner_id TEXT, state TEXT, notify INT);
              INSERT INTO custom_workers VALUES('w', 'o', 'remote', 1);
              CREATE TABLE scheduled_tasks(task_id TEXT, enabled INT);
              INSERT INTO scheduled_tasks VALUES('s', 1);
              CREATE TABLE auth_sessions(session_id TEXT); INSERT INTO auth_sessions VALUES('login');
              CREATE TABLE history(message TEXT); INSERT INTO history VALUES('keep me');''')
        (self.source / 'userdata/settings.json').write_text('{"privateSetting":"preserve"}')
        self.runtime = self.job / 'prebuilt'
        (self.runtime / 'client').mkdir(parents=True)
        (self.runtime / 'client/index.html').write_text('client')
        trial.save(self.runtime / 'package.json', {'version': 'test', 'sourceCommit': 'abcdef1234567', 'protocol': 2})
        (self.runtime / 't3').write_text('''#!/usr/bin/python3 -S
import http.server,json,pathlib,sys,os
home=pathlib.Path(sys.argv[sys.argv.index('--base-dir')+1])
port=int(sys.argv[sys.argv.index('--port')+1])
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  body=json.dumps({'orchestrationProtocolVersion':2,'environmentId':(home/'userdata/environment-id').read_text().strip(),'serverVersion':'test'}).encode()
  os.write(self.connection.fileno(),b'HTTP/1.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n'+body)
 def log_message(self,*args): pass
http.server.HTTPServer(('127.0.0.1',port),Handler).serve_forever()
''')
        (self.runtime / 't3').chmod(0o700)
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0)); self.port = s.getsockname()[1]
        self.root = self.job / 'trial'
        self.args = trial.parser().parse_args(['prepare', '--job', str(self.job), '--source-home', str(self.source),
                                              '--runtime', str(self.runtime), '--port', str(self.port)])

    def tearDown(self):
        if self.root.exists(): trial.stop(self.root)
        self.tmp.cleanup()

    def prepare(self):
        self.root.mkdir(exist_ok=True)
        return trial.prepare(self.args, self.root)

    def test_snapshot_includes_committed_wal_and_preserves_source_config(self):
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute("INSERT INTO history VALUES('wal')"); db.commit()
            before = trial.digest(self.db)
            config = self.prepare()
            self.assertEqual(before, trial.digest(self.db))
            with trial.database(Path(config['generation']) / 'input/userdata/state.sqlite') as copied:
                self.assertEqual(copied.execute('select * from history').fetchall(), [('keep me',), ('wal',)])
                self.assertEqual(copied.execute('select state from custom_worker_jobs').fetchone()[0], 'queued')
            self.assertEqual((Path(config['generation']) / 'input/userdata/settings.json').read_text(),
                             (self.source / 'userdata/settings.json').read_text())
            with trial.database(Path(config['home']) / 'userdata/state.sqlite') as active:
                self.assertEqual(active.execute('select state,reported from custom_worker_jobs').fetchone(), ('error',1))
                self.assertEqual(active.execute('select enabled from scheduled_tasks').fetchone()[0], 0)
                self.assertEqual(active.execute('select count(*) from auth_sessions').fetchone()[0], 0)
            self.assertEqual(db.execute('select count(*) from auth_sessions').fetchone()[0],1)

    def test_refresh_keeps_trial_only_data_and_failed_refresh_keeps_pointer(self):
        first = self.prepare()
        marker = Path(first['home']) / 'unique-trial-data'
        marker.write_text('retain')
        self.args.action = 'refresh'
        second = trial.prepare(self.args, self.root)
        self.assertNotEqual(first['home'], second['home'])
        self.assertEqual(marker.read_text(), 'retain')
        self.assertTrue((Path(first['generation']) / 'archive.json').exists())
        self.db.unlink()
        with self.assertRaises(RuntimeError): trial.prepare(self.args, self.root)
        self.assertEqual(trial.read(self.root / 'trial.json'), second)

    def test_trial_disables_automatic_settlement_without_changing_original_settings(self):
        original = {'sidebarAutoSettleAfterDays': 7, 'sidebarAutoSettleOnMerge': True,
                    'projectSettings': {'p': {'sidebarAutoSettleAfterDays': 1}}}
        trial.save(self.source / 'userdata/settings.json', original)
        config = self.prepare()
        active = trial.read(Path(config['home']) / 'userdata/settings.json')
        self.assertIn('sidebarAutoSettleAfterDays', active)
        self.assertIsNone(active['sidebarAutoSettleAfterDays'])
        self.assertIs(active['sidebarAutoSettleOnMerge'], False)
        self.assertIsInstance(active['providerInstances'], dict)
        self.assertFalse(active['providerInstances'])
        self.assertNotIn('projectSettings', active)
        self.assertEqual(trial.read(self.source / 'userdata/settings.json'), original)
        self.assertEqual(trial.read(Path(config['generation']) / 'input/userdata/settings.json'), original)

    def test_overlap_and_repeat_prepare_refused(self):
        for root in (self.source, self.source / 'trial', self.job):
            with self.assertRaises(RuntimeError): trial.locations(self.job, self.source, root)
        self.prepare()
        with self.assertRaisesRegex(RuntimeError, 'already exists'): self.prepare()

    def test_lifecycle_is_independent_idempotent_and_refresh_requires_stop(self):
        self.prepare()
        first = trial.start(self.root, 10)
        self.assertTrue(first['healthy'])
        self.assertIn('/t3w-trials.slice/', Path(f"/proc/{first['pid']}/cgroup").read_text())
        self.assertEqual(first['pid'], trial.start(self.root, 10)['pid'])
        self.args.action = 'refresh'
        with self.assertRaisesRegex(RuntimeError, 'Stop'): trial.prepare(self.args, self.root)
        trial.stop(self.root)
        self.assertFalse(trial.process_alive(self.root))
        self.assertTrue(trial.stop(self.root)['alreadyStopped'])
        second = trial.start(self.root, 10)
        self.assertTrue(second['healthy'])
        self.assertNotEqual(first['pid'], second['pid'])

    def test_stale_identity_cannot_signal_a_live_process(self):
        self.root.mkdir()
        trial.save(self.root / 'process.json', {'pid': os.getpid(), 'identity': {'pid':os.getpid(),'startTicks':'wrong'}})
        self.assertFalse(trial.process_alive(self.root))
        self.assertTrue(trial.stop(self.root)['alreadyStopped'])

    def test_exited_launcher_with_no_identity_is_not_a_running_trial(self):
        self.root.mkdir()
        trial.save(self.root/'process.json',{'pid':12345678,'identity':None})
        with patch.object(trial,'proc_identity',return_value=None):
            self.assertFalse(trial.process_alive(self.root))
            self.assertTrue(trial.stop(self.root)['alreadyStopped'])

    def test_content_checks_detect_changed_metadata_and_message_despite_equal_counts(self):
        destination = self.job / 'v2.sqlite'
        with closing(sqlite3.connect(self.db)) as db, db:
            db.executescript("""CREATE TABLE projection_projects(project_id TEXT, title TEXT, base_prompt TEXT);
              INSERT INTO projection_projects VALUES('p','Project','custom prompt');
              CREATE TABLE projection_threads(thread_id TEXT, project_id TEXT, title TEXT, branch TEXT,
                pinned_at TEXT, snoozed_until TEXT, linked_pull_request_json TEXT, model_selection_json TEXT,
                updated_at TEXT, is_base TEXT);
              INSERT INTO projection_threads VALUES('t','p','Thread','topic',NULL,NULL,NULL,
                '{"instanceId":"SL","model":"astra"}', '2026-10-31T17:56:58.787Z', 'true');
              CREATE TABLE projection_thread_messages(message_id TEXT, thread_id TEXT, role TEXT, text TEXT,
                created_at TEXT, updated_at TEXT, attachments_json TEXT, context_json TEXT);
              INSERT INTO projection_thread_messages VALUES('m','t','assistant','original text','date','date','[]',NULL);""")
        with closing(sqlite3.connect(destination)) as db, db:
            db.executescript("""CREATE TABLE projection_projects(project_id TEXT, title TEXT, base_prompt TEXT);
              INSERT INTO projection_projects VALUES('p','Project','custom prompt');
              CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,payload_json TEXT);
              CREATE TABLE orchestration_v2_projection_messages(message_id TEXT,payload_json TEXT);""")
            thread = {'projectId':'p','title':'Thread','branch':'topic','modelSelection':{'instanceId':'SL','model':'astra'},
                      'updatedAt':'2026-10-31T17:56:58.787Z', 'isBase':True}
            message = {'id':'m','threadId':'t','role':'assistant','text':'original text','createdAt':'date','updatedAt':'date','attachments':[]}
            db.execute('INSERT INTO orchestration_v2_projection_threads VALUES(?,?)',('t',json.dumps(thread)))
            db.execute('INSERT INTO orchestration_v2_projection_messages VALUES(?,?)',('m',json.dumps(message)))
        self.assertTrue(all(c['matches'] for c in trial.content_checks(self.db,destination)))
        # The changed row sits beyond either three-row edge and the former feature samples.
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("UPDATE projection_threads SET branch=NULL")
            for n in range(1, 9):
                db.execute("INSERT INTO projection_threads SELECT ?,project_id,title,branch,pinned_at,snoozed_until,"
                           "linked_pull_request_json,model_selection_json,updated_at,is_base FROM projection_threads WHERE thread_id='t'",
                           (f't{n}',))
        with closing(sqlite3.connect(destination)) as db, db:
            thread['branch'] = None
            db.execute('UPDATE orchestration_v2_projection_threads SET payload_json=?',(json.dumps(thread),))
            for n in range(1, 9):
                db.execute('INSERT INTO orchestration_v2_projection_threads VALUES(?,?)',(f't{n}',json.dumps(thread)))
        self.assertTrue(all(c['matches'] for c in trial.content_checks(self.db,destination)))
        with closing(sqlite3.connect(destination)) as db, db:
            thread['modelSelection']['instanceId']='wrong'
            thread['updatedAt']='2026-10-23T21:09:52.575Z'
            thread['isBase']=False
            message['text']='lost content'
            db.execute("UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id='t4'",(json.dumps(thread),))
            db.execute('UPDATE orchestration_v2_projection_messages SET payload_json=?',(json.dumps(message),))
        failed = [c for c in trial.content_checks(self.db,destination) if not c['matches']]
        self.assertEqual({c['kind'] for c in failed},{'thread','message'})
        self.assertIn('modelSelection',next(c for c in failed if c['kind']=='thread')['mismatches'])
        self.assertEqual(next(c for c in failed if c['kind']=='thread')['id'], 't4')
        self.assertEqual(set(next(c for c in failed if c['kind']=='thread')['mismatches']),
                         {'modelSelection','updatedAt','isBase'})

    def test_inventory_accounts_for_compaction_but_rejects_unexpected_loss(self):
        generation = self.root / 'generations/g1'
        source = generation / 'input/userdata/state.sqlite'
        destination = generation / 'home/userdata/statev2.sqlite'
        source.parent.mkdir(parents=True); destination.parent.mkdir(parents=True)
        with closing(sqlite3.connect(self.db)) as db, db:
            db.executescript("""CREATE TABLE orchestration_events(event_id TEXT PRIMARY KEY,aggregate_kind TEXT,stream_id TEXT);
                INSERT INTO orchestration_events VALUES('project','project','p'),('thread','thread','t');
                CREATE TABLE orchestration_command_receipts(command_id TEXT PRIMARY KEY,aggregate_kind TEXT,aggregate_id TEXT);
                INSERT INTO orchestration_command_receipts VALUES('receipt','thread','t');
                CREATE TABLE auth_pairing_links(id TEXT,credential TEXT);
                INSERT INTO auth_pairing_links VALUES('original-link','original-credential');
                CREATE TABLE projection_thread_activities(id TEXT); INSERT INTO projection_thread_activities VALUES('a');""")
        trial.vacuum(self.db,source);trial.vacuum(self.db,destination)
        with closing(sqlite3.connect(destination)) as db, db:
            db.executescript("""ALTER TABLE orchestration_events ADD COLUMN application_event_version INT DEFAULT 1;
                ALTER TABLE orchestration_command_receipts ADD COLUMN command_type TEXT DEFAULT 'legacy';
                CREATE TABLE orchestration_v2_legacy_imports(thread_id TEXT,transcript_imported_at TEXT,last_error TEXT);
                INSERT INTO orchestration_v2_legacy_imports VALUES('t','done',NULL);
                DELETE FROM orchestration_events WHERE event_id='thread';
                DELETE FROM orchestration_command_receipts;
                DELETE FROM auth_sessions;
                DELETE FROM auth_pairing_links;""")
        trial.save(self.root / 'trial.json',{'generation':str(generation),'home':str(generation/'home')})
        with patch.object(trial,'v2_count_checks',return_value=[]), patch.object(trial,'content_checks',return_value=[]):
            result=trial.verify(self.root)
            retained=next(r for r in result['retainedTableCounts'] if r['table']=='projection_thread_activities')
            self.assertEqual(retained['imported'],1)
            self.assertTrue(result['matches'])
            with closing(sqlite3.connect(destination)) as db, db:
                db.execute("INSERT INTO auth_sessions VALUES('trial-client')")
                db.execute("INSERT INTO auth_pairing_links VALUES('trial-link','trial-credential')")
            self.assertTrue(trial.verify(self.root)['matches'])
            with closing(sqlite3.connect(destination)) as db, db:
                db.execute("INSERT INTO auth_sessions VALUES('login')")
            with self.assertRaisesRegex(RuntimeError,'mismatched'):trial.verify(self.root)
            with closing(sqlite3.connect(destination)) as db, db:
                db.execute("DELETE FROM auth_sessions WHERE session_id='login'")
                db.execute("INSERT INTO auth_pairing_links VALUES('changed-id','original-credential')")
            with self.assertRaisesRegex(RuntimeError,'mismatched'):trial.verify(self.root)
            with closing(sqlite3.connect(destination)) as db, db:
                db.execute("DELETE FROM auth_pairing_links WHERE id='changed-id'")
            with closing(sqlite3.connect(destination)) as db, db:
                db.execute('DROP TABLE projection_thread_activities')
            with self.assertRaisesRegex(RuntimeError,'mismatched'):trial.verify(self.root)
            result=trial.read(generation/'verification.json')
            dropped=next(r for r in result['retainedTableCounts'] if r['table']=='projection_thread_activities')
            self.assertIsNone(dropped['imported'])  # Never fall back to the attached input table.
            self.assertFalse(dropped['matches'])
            with closing(sqlite3.connect(destination)) as db, db:
                db.execute('CREATE TABLE projection_thread_activities(id TEXT)')
                db.execute("INSERT INTO projection_thread_activities VALUES('a')")
                db.execute("DELETE FROM orchestration_events WHERE event_id='project'")
            with self.assertRaisesRegex(RuntimeError,'mismatched'):trial.verify(self.root)
            result=trial.read(generation/'verification.json')
            events=next(r for r in result['retainedTableCounts'] if r['table']=='orchestration_events')
            self.assertEqual(events['unexpectedMissingRows'],1)

    def test_sandbox_denies_source_reads_writes_network_and_external_signals(self):
        home = self.job / 'sandbox'; home.mkdir()
        script = '''import os,socket,sys
from pathlib import Path
Path(sys.argv[1], 'own').write_text('allowed')
checks=[lambda:Path(sys.argv[2]).read_bytes(),lambda:Path(sys.argv[2]).write_text('bad'),
 lambda:socket.socket().connect(('127.0.0.1',3773)),lambda:os.kill(int(sys.argv[3]),0)]
for call in checks:
 try: call()
 except PermissionError: continue
 raise AssertionError('sandbox allowed forbidden operation')
print('blocked all')'''
        result = subprocess.run([sys.executable, '-B', str(trial.HERE / 'trial_sandbox.py'), str(home), str(self.runtime),
                                 '/usr/bin/python3', '-S', '-c', script, str(home), str(self.db), str(os.getpid())],
                                capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('blocked all',result.stdout)


if __name__ == '__main__': unittest.main()
