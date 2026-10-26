import copy
from contextlib import closing
import importlib.util
import json
import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('host', Path(__file__).resolve().parents[1] / 'deploy/host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class SealedCursorRecovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.native = '00000000-0000-4000-8000-000000000001'
        self.path = Path(self.temp.name) / (self.native + '.jsonl')
        self.old = {'provider_name': 'claudeAgent', 'provider_instance_id': 'account', 'runtime_mode': 'full-access',
                    'resumeCursor': {'threadId': 'thread', 'resume': self.native, 'resumeSessionAt': 'anchor-old', 'turnCount': 1, 'turnStartMessageIds': ['turn-old']},
                    'runtimePayload': {'cwd': self.temp.name, 'model': 'model', 'modelSelection': {'instanceId': 'account', 'model': 'model'}}}
        self.current = copy.deepcopy(self.old)
        self.current['resumeCursor'].update(resumeSessionAt='anchor-new', turnCount=2, turnStartMessageIds=['turn-old', 'turn-new'])
        self.activity = {'id': 'thread', 'turnIds': ['turn-new'], 'requestSequences': [9]}
        self.nodes = [self.node('anchor-old', None, 'assistant'), self.node('turn-new', 'anchor-old', 'user'), self.node('anchor-new', 'turn-new', 'assistant')]
        self.write()

    def node(self, uid, parent, kind):
        return {'uuid': uid, 'parentUuid': parent, 'type': kind, 'sessionId': self.native, 'cwd': self.temp.name, 'isSidechain': False}

    def write(self):
        self.path.write_text(''.join(json.dumps(n) + '\n' for n in self.nodes))

    def recover(self, seal=None):
        baseline = host.reconstruct_claude_binding(self.current, self.activity, self.path, seal or host.hashed(self.old))
        return baseline, host.prove_claude_cursor(baseline, self.current, self.activity, self.path)

    def test_recovers_exact_binding_and_proves_native_ancestry_without_backup(self):
        baseline, proof = self.recover()
        self.assertEqual(baseline, self.old)
        self.assertEqual(proof['fromSha256'], host.hashed(self.old))
        self.assertEqual(proof['toSha256'], host.hashed(self.current))
        self.assertTrue(proof['anchorDescendsFromPrevious'])

    def test_unchanged_anchor_still_requires_new_turn_ancestry(self):
        self.current['resumeCursor']['resumeSessionAt'] = 'anchor-old'
        self.assertFalse(self.recover()[1]['anchorChanged'])

    def test_changed_account_model_native_mode_or_workspace_cannot_match_seal(self):
        for key, value in [('provider_instance_id', 'different'), ('runtime_mode', 'different')]:
            with self.subTest(key=key):
                original = self.current[key]
                self.current[key] = value
                with self.assertRaises(ValueError): self.recover()
                self.current[key] = original
        for key in ('cwd', 'model', 'modelSelection'):
            with self.subTest(key=key):
                original = self.current['runtimePayload'][key]
                self.current['runtimePayload'][key] = 'different'
                with self.assertRaises(ValueError): self.recover()
                self.current['runtimePayload'][key] = original
        self.current['resumeCursor']['resume'] = '00000000-0000-4000-8000-000000000002'
        with self.assertRaises(ValueError): self.recover()

    def test_wrong_original_seal_refuses(self):
        with self.assertRaises(ValueError): self.recover('0' * 64)

    def test_missing_old_native_record_refuses(self):
        self.nodes.pop(0); self.write()
        with self.assertRaises(ValueError): self.recover()

    def test_extra_or_reordered_turn_refuses(self):
        self.current['resumeCursor']['turnStartMessageIds'].append('unrequested')
        self.current['resumeCursor']['turnCount'] += 1
        with self.assertRaises(ValueError): self.recover()

    def test_changed_old_turn_prefix_refuses(self):
        self.current['resumeCursor']['turnStartMessageIds'][0] = 'different'
        with self.assertRaises(ValueError): self.recover()

    def test_matching_hash_does_not_bypass_ancestry(self):
        self.nodes[1]['parentUuid'] = 'unrelated'; self.write()
        with self.assertRaisesRegex(ValueError, 'cursor-native-record'): self.recover()

    def test_replaced_native_record_refuses(self):
        self.nodes.append(self.node('anchor-old', 'different', 'assistant')); self.write()
        with self.assertRaisesRegex(ValueError, 'cursor-replaced-node'): self.recover()

    def test_partial_record_and_sidechain_cannot_supply_baseline(self):
        self.path.write_text(json.dumps(self.nodes[0]))
        with self.assertRaises(ValueError): self.recover()
        self.nodes[0]['isSidechain'] = True; self.write()
        with self.assertRaises(ValueError): self.recover()

    def fixture(self):
        base = Path(self.temp.name) / 't3'
        root = base / 'runtime/t3w-deploy/release'
        root.mkdir(parents=True)
        (base / 'userdata').mkdir()
        native_home = Path(self.temp.name) / 'native'
        project = native_home / 'projects/project'
        project.mkdir(parents=True)
        (project / self.path.name).write_bytes(self.path.read_bytes())
        (base / 'userdata/settings.json').write_text(json.dumps({'providerInstances': {'account': {'driver': 'claudeAgent', 'config': {'homePath': str(native_home)}}}}))
        database = base / 'userdata/state.sqlite'
        with closing(sqlite3.connect(database)) as db, db:
            db.executescript('''
              CREATE TABLE projection_turns(row_id INTEGER,thread_id TEXT,turn_id TEXT,pending_message_id TEXT);
              CREATE TABLE orchestration_events(sequence INTEGER,aggregate_kind TEXT,stream_id TEXT,event_type TEXT,command_id TEXT,actor_kind TEXT,payload_json TEXT);
              CREATE TABLE orchestration_command_receipts(command_id TEXT,aggregate_kind TEXT,aggregate_id TEXT,result_sequence INTEGER,status TEXT,error TEXT);
              CREATE TABLE projection_thread_messages(message_id TEXT,thread_id TEXT,role TEXT,text TEXT);
              CREATE TABLE provider_session_runtime(thread_id TEXT,provider_name TEXT,provider_instance_id TEXT,runtime_mode TEXT,resume_cursor_json TEXT,runtime_payload_json TEXT);
              INSERT INTO projection_turns VALUES(1,'thread','turn-old','old-message'),(2,'thread','turn-new','new-message');
              INSERT INTO projection_thread_messages VALUES('new-message','thread','user','continue');
            ''')
            events = [(1, 'thread.message-sent', 'client', {'threadId': 'thread', 'messageId': 'new-message', 'role': 'user', 'text': 'continue'}),
                      (2, 'thread.turn-start-requested', 'client', {'threadId': 'thread', 'messageId': 'new-message'}),
                      (3, 'thread.session-set', 'provider', {'threadId': 'thread', 'session': {'status': 'running', 'activeTurnId': 'turn-new'}})]
            for seq, kind, actor, payload in events:
                command = 'command-' + str(seq)
                db.execute('INSERT INTO orchestration_events VALUES(?,?,?,?,?,?,?)', (seq, 'thread', 'thread', kind, command, actor, json.dumps(payload)))
                db.execute('INSERT INTO orchestration_command_receipts VALUES(?,?,?,?,?,?)', (command, 'thread', 'thread', seq, 'accepted', None))
            db.execute('INSERT INTO provider_session_runtime VALUES(?,?,?,?,?,?)', ('thread', 'claudeAgent', 'account', 'full-access', json.dumps(self.current['resumeCursor']), json.dumps(self.current['runtimePayload'])))
        snapshot = {'sessions': [{'id': 'thread', 'status': 'ready', 'activeTurnId': None, 'lastTurnId': 'turn-old'}], 'bindings': [['thread', host.hashed(self.old)]],
                    'activityBoundary': {'schema': 1, 'eventSequence': 0, 'eventSha256': None, 'turns': [['thread', 1, 'turn-old']]}}
        closed = json.dumps(snapshot).encode()
        (root / 'closed-snapshot.json').write_bytes(closed)
        (root / 'service-activation.json').write_text(json.dumps({'phase': 'started', 'closedSnapshotSha256': hashlib.sha256(closed).hexdigest()}))
        (root / 'receipt.json').write_text(json.dumps({'id': 'release', 'phase': 'recovery-required', 'manifestHash': 'manifest', 'targetHash': 'target', 'before': snapshot}))
        return root, database

    def test_real_sqlite_code_only_reconciliation_uses_sealed_native_binding(self):
        root, _ = self.fixture()
        self.assertFalse((root / 'before-migrations.sqlite').exists())
        proof = host.activity_reconciliation(str(root))
        self.assertEqual(proof['blocked'], [])
        self.assertEqual(proof['bindingEntries'][0]['fromSha256'], host.hashed(self.old))

    def test_unrequested_native_turn_remains_blocked(self):
        root, database = self.fixture()
        with closing(sqlite3.connect(database)) as db, db:
            db.execute("UPDATE projection_turns SET pending_message_id=NULL WHERE turn_id='turn-new'")
        proof = host.activity_reconciliation(str(root))
        self.assertEqual(proof['bindingEntries'], [])
        self.assertEqual(proof['blocked'], [{'id': 'thread', 'reason': 'unrequested-turn'}])


if __name__ == '__main__': unittest.main()
