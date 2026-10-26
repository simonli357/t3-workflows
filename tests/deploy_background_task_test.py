import copy
from contextlib import closing
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cursor_tests', Path(__file__).with_name('deploy_cursor_recovery_test.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
host = base.host


class BackgroundTaskProof(base.SealedCursorRecovery):
    def setUp(self):
        super().setUp()
        self.root, self.database = self.fixture()
        self.path = Path(self.temp.name) / 'native/projects/project' / self.path.name
        self.nodes = [self.node('anchor-old', None, 'assistant'), self.node('turn-new', 'anchor-old', 'user'),
                      self.node('launch', 'turn-new', 'assistant'), self.node('result', 'launch', 'user'),
                      self.node('normal-end', 'result', 'assistant'), self.node('notice', 'normal-end', 'user'),
                      self.node('background-first', 'notice', 'assistant'), self.node('background-last', 'background-first', 'assistant')]
        for row in self.nodes: row['message'] = {'content': []}
        self.nodes[2]['message']['content'] = [{'type': 'tool_use', 'id': 'timer-tool', 'name': 'Bash', 'input': {'command': 'sleep 1', 'run_in_background': True}}]
        self.nodes[3]['message']['content'] = [{'type': 'tool_result', 'tool_use_id': 'timer-tool', 'content': 'Command running in background with ID: timer-task'}]
        self.nodes[5]['message']['content'] = '<task-notification><task-id>timer-task</task-id><tool-use-id>timer-tool</tool-use-id><status>completed</status></task-notification>'
        self.nodes[6]['message']['content'] = [{'type': 'tool_use', 'id': 'follow-up-tool', 'name': 'read', 'input': {}}]
        self.write()
        self.current['resumeCursor'].update(resumeSessionAt='background-last', turnCount=3, turnStartMessageIds=['turn-old', 'turn-new', 'background-first'])
        def session(status, turn): return {'threadId': 'thread', 'session': {'status': status, 'activeTurnId': turn, 'lastError': None, 'providerName': 'claudeAgent', 'providerInstanceId': 'account'}}
        def task(kind): return {'threadId': 'thread', 'activity': {'kind': kind, 'payload': {'taskId': 'timer-task', 'toolUseId': 'timer-tool', 'status': 'completed'}}}
        events = [(4, 'thread.session-set', session('ready', None)), (5, 'thread.turn-diff-completed', {'threadId': 'thread', 'turnId': 'turn-new'}),
                  (6, 'thread.activity-appended', task('task.updated')), (7, 'thread.activity-appended', task('task.completed')),
                  (8, 'thread.session-set', session('running', None)), (9, 'thread.session-set', session('running', 'background')),
                  (10, 'thread.activity-appended', {'threadId': 'thread', 'activity': {'turnId': 'background', 'payload': {'toolCallId': 'follow-up-tool'}}}),
                  (11, 'thread.session-set', session('ready', None)), (12, 'thread.turn-diff-completed', {'threadId': 'thread', 'turnId': 'background', 'status': 'ready', 'files': []})]
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("INSERT INTO projection_turns VALUES(3,'thread','background',NULL)")
            db.execute('UPDATE provider_session_runtime SET resume_cursor_json=?', (json.dumps(self.current['resumeCursor']),))
            for sequence, kind, payload in events:
                command = 'provider-' + str(sequence)
                db.execute('INSERT INTO orchestration_events VALUES(?,?,?,?,?,?,?)', (sequence, 'thread', 'thread', kind, command, 'server' if sequence == 12 else 'provider', json.dumps(payload)))
                db.execute('INSERT INTO orchestration_command_receipts VALUES(?,?,?,?,?,?)', (command, 'thread', 'thread', sequence, 'accepted', None))
        self.policy = {'deploymentId': 'release', 'threadId': 'thread', 'nativeId': self.native, 'instance': 'account', 'rootTurnId': 'turn-new', 'turnId': 'background', 'nativeStartId': 'background-first', 'notificationId': 'notice', 'launchId': 'launch', 'resultId': 'result', 'toolUseId': 'timer-tool', 'taskId': 'timer-task', 'startupSequence': 8, 'runningSequence': 9, 'mappingSequence': 10, 'readySequence': 11, 'checkpointSequence': 12, 'sealedBindingSha256': host.hashed(self.old), 'originalFailureSha256': 'a' * 64}
        self.refresh_pins()
        self.review = patch.object(host, 'BACKGROUND_REVIEW', self.policy)
        self.review.start(); self.addCleanup(self.review.stop)

    def refresh_pins(self):
        self.policy['nativeRecords'] = {json.loads(raw)['uuid']: hashlib.sha256(raw).hexdigest() for raw in self.path.read_bytes().splitlines(keepends=True)}
        with closing(sqlite3.connect(self.database)) as db:
            db.row_factory = sqlite3.Row
            self.policy['events'] = {str(r['sequence']): host.hashed(dict(r)) for r in db.execute('SELECT * FROM orchestration_events WHERE sequence>=6')}

    def proof(self): return host.activity_reconciliation(str(self.root))

    def test_background_passes_with_exact_root_task_ancestry_and_durable_receipts(self):
        result = self.proof()
        self.assertEqual(result['blocked'], [])
        self.assertEqual(len(result['bindingEntries']), 1)
        entry = result['entries'][0]
        self.assertEqual(entry['nativeGoalSequences'], [])
        self.assertEqual(entry['nativeBackgroundSequences'], [9])
        self.assertEqual(entry['backgroundTask']['kind'], 'provider-native-background-task')
        self.assertEqual(entry['nativeTurnIds'], ['turn-new', 'background-first'])
        self.assertEqual(result['bindingEntries'][0]['fromSha256'], host.hashed(self.old))

    def test_original_unreviewed_activity_gate_still_rejects_same_fixture(self):
        with closing(sqlite3.connect(self.database)) as db:
            db.row_factory = sqlite3.Row
            turns = list(db.execute('SELECT * FROM projection_turns WHERE row_id>1 ORDER BY row_id'))
            with self.assertRaisesRegex(ValueError, 'unrequested-turn'): host.prove_activity(db, 'thread', turns, 0)

    def test_background_wrong_thread_or_release_stays_blocked(self):
        for key in ('threadId', 'deploymentId'):
            with self.subTest(key=key):
                value = self.policy[key]; self.policy[key] = 'different'
                self.assertTrue(self.proof()['blocked']); self.policy[key] = value

    def test_background_extra_null_turn_stays_blocked(self):
        with closing(sqlite3.connect(self.database)) as db, db: db.execute("INSERT INTO projection_turns VALUES(4,'thread','extra',NULL)")
        self.assertTrue(self.proof()['blocked'])

    def test_background_native_identity_change_stays_blocked(self):
        self.policy['nativeId'] = '00000000-0000-4000-8000-000000000002'
        self.assertTrue(self.proof()['blocked'])

    def test_background_notification_task_mismatch_even_with_reviewed_bytes(self):
        self.nodes[5]['message']['content'] = self.nodes[5]['message']['content'].replace('timer-task', 'other-task')
        self.write(); self.refresh_pins()
        self.assertTrue(self.proof()['blocked'])

    def test_background_foreground_launch_stays_blocked(self):
        self.nodes[2]['message']['content'][0]['input']['run_in_background'] = False
        self.write(); self.refresh_pins()
        self.assertTrue(self.proof()['blocked'])

    def test_background_notification_without_root_ancestry_stays_blocked(self):
        self.nodes[5]['parentUuid'] = 'anchor-old'
        self.write(); self.refresh_pins()
        self.assertTrue(self.proof()['blocked'])

    def test_background_changed_durable_event_stays_blocked(self):
        with closing(sqlite3.connect(self.database)) as db, db: db.execute("UPDATE orchestration_events SET actor_kind='client' WHERE sequence=9")
        self.assertTrue(self.proof()['blocked'])

    def test_background_unaccepted_provider_receipt_stays_blocked(self):
        with closing(sqlite3.connect(self.database)) as db, db: db.execute("UPDATE orchestration_command_receipts SET status='rejected' WHERE command_id='provider-9'")
        self.assertTrue(self.proof()['blocked'])

    def test_background_unaccepted_root_request_stays_blocked(self):
        with closing(sqlite3.connect(self.database)) as db, db: db.execute("UPDATE orchestration_command_receipts SET status='rejected' WHERE command_id='command-2'")
        self.assertTrue(self.proof()['blocked'])

    def test_background_wrong_projection_mapping_stays_blocked(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            p=json.loads(db.execute('SELECT payload_json FROM orchestration_events WHERE sequence=10').fetchone()[0]);p['activity']['payload']['toolCallId']='unrelated';db.execute('UPDATE orchestration_events SET payload_json=? WHERE sequence=10',(json.dumps(p),))
        self.refresh_pins();self.assertTrue(self.proof()['blocked'])

    def test_background_changed_checkpoint_stays_blocked(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            p=json.loads(db.execute('SELECT payload_json FROM orchestration_events WHERE sequence=12').fetchone()[0]);p['files']=['unreviewed'];db.execute('UPDATE orchestration_events SET payload_json=? WHERE sequence=12',(json.dumps(p),))
        self.refresh_pins();self.assertTrue(self.proof()['blocked'])

    def test_background_durable_task_mismatch_stays_blocked(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            p=json.loads(db.execute('SELECT payload_json FROM orchestration_events WHERE sequence=7').fetchone()[0]);p['activity']['payload']['taskId']='different';db.execute('UPDATE orchestration_events SET payload_json=? WHERE sequence=7',(json.dumps(p),))
        self.refresh_pins();self.assertTrue(self.proof()['blocked'])

    def test_background_changed_profile_cannot_match_original_binding(self):
        self.current['runtimePayload']['model'] = 'different'
        with closing(sqlite3.connect(self.database)) as db, db: db.execute('UPDATE provider_session_runtime SET runtime_payload_json=?',(json.dumps(self.current['runtimePayload']),))
        self.assertTrue(self.proof()['blocked'])


# Reuse fixture utilities without rerunning the base class's unrelated cases.
for name in dir(base.SealedCursorRecovery):
    if name.startswith('test_') and name not in BackgroundTaskProof.__dict__:
        setattr(BackgroundTaskProof, name, None)

if __name__ == '__main__': unittest.main()
