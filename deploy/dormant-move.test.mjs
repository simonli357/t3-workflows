import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertDormantProof, assertClosedMoveDestination, DORMANT_MOVE, readPeerProof } from './dormant-move.mjs';
import { digest } from './core.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = String.raw`
import importlib.util,json,sqlite3,sys,hashlib
from pathlib import Path
spec=importlib.util.spec_from_file_location('guard',sys.argv[1]);g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
base=Path(sys.argv[2]);(base/'userdata').mkdir();d=sqlite3.connect(base/'userdata/state.sqlite')
d.executescript('''CREATE TABLE custom_session_moves(id,thread_id,target_thread_id,direction,peer_environment_id,state,locked,input_json,manifest_json,error,created_at,updated_at);
CREATE TABLE session_workspaces(reservation_id,thread_id,binding_json,active);
CREATE TABLE projection_thread_sessions(thread_id,status,active_turn_id);
CREATE TABLE projection_turns(thread_id,turn_id,state);
CREATE TABLE custom_ownership_reservation(id);
CREATE TABLE custom_ownership_transactions(id,state,participants_json);
CREATE TABLE custom_orchestrator_handoffs(thread_id,state);''')
i={'requestId':g.MOVE,'threadId':g.THREAD};tmp=base/'tmp';stage=tmp/'session-moves'/g.MOVE/'history';stage.mkdir(parents=True);(stage/'events.json').write_text('[]')
f={'name':'events.json','kind':'history','bytes':2,'sha256':hashlib.sha256(b'[]').hexdigest()}
m={'input':i,'sourceEnvironmentId':g.SOURCE,'targetEnvironmentId':g.TARGET,'driver':'claudeAgent','nativeId':g.NATIVE,'resumeCursor':{'resume':g.NATIVE},'files':[f]}
d.execute('INSERT INTO custom_session_moves VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(g.MOVE,g.THREAD,g.THREAD,'out',g.TARGET,'copying',1,json.dumps(i),json.dumps(m),g.ERROR,'created','updated'))
d.execute('INSERT INTO session_workspaces VALUES(?,?,?,?)',('new:'+g.THREAD,g.THREAD,json.dumps({'tmpDirectory':str(tmp)}),1))
d.execute('INSERT INTO projection_thread_sessions VALUES(?,?,?)',(g.THREAD,'stopped',None))
case=sys.argv[3]
if case in ('prepared','committing'): d.execute('UPDATE custom_session_moves SET state=?',(case,))
if case=='active-copy': d.execute('UPDATE custom_session_moves SET error=NULL')
if case=='wrong-error': d.execute("UPDATE custom_session_moves SET error='timeout'")
if case=='other-move': d.execute("INSERT INTO custom_session_moves SELECT 'other',thread_id,target_thread_id,direction,peer_environment_id,state,locked,input_json,manifest_json,error,created_at,updated_at FROM custom_session_moves")
if case=='active-native': d.execute("UPDATE projection_thread_sessions SET status='running',active_turn_id='turn'")
if case=='pending-turn': d.execute("INSERT INTO projection_turns VALUES(?,'turn','pending')",(g.THREAD,))
if case=='changed-file': (stage/'events.json').write_text('[1]')
if case=='ownership': d.execute("INSERT INTO custom_ownership_reservation VALUES('other')")
role='source'
if case.startswith('destination'):
 role='destination';d.execute('DELETE FROM custom_session_moves');d.execute('DELETE FROM session_workspaces')
 if case=='destination-reservation': d.execute('INSERT INTO session_workspaces VALUES(?,?,?,?)',('move:'+g.MOVE,g.THREAD,'{}',0))
 if case=='destination-receipt': d.execute('INSERT INTO custom_session_moves VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(g.MOVE,g.THREAD,g.THREAD,'in',g.SOURCE,'complete',0,'{}','{}',None,'created','updated'))
d.commit();d.close();print(json.dumps(g.proof(str(base),role)))
`;
function probe(which) {
 const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'move-guard-'));
 try { return JSON.parse(execFileSync('python3', ['-B','-c',fixture,path.join(here,'dormant-move.py'),tmp,which], {encoding:'utf8',stdio:['ignore','pipe','pipe']})); }
 finally { fs.rmSync(tmp,{recursive:true,force:true}); }
}
test('dormant pre-reservation source retains exact failure, capture and native identity', () => {
 const source=probe('source'), destination=probe('destination');
 const decision={kind:'reviewed-dormant-pre-reservation',moveId:DORMANT_MOVE,sourceEnvironmentId:'b263cba7-18b9-49fe-9650-cf7b073d2c95',targetEnvironmentId:'255c14ea-4fcc-4a51-b8bc-aa0821239b0a',source};
 assert.doesNotThrow(()=>assertDormantProof(decision,source,destination));
 for(const key of ['receiptSha256','inputSha256','manifestSha256']) assert.throws(()=>assertDormantProof(decision,{...source,[key]:'0'.repeat(64)},destination));
 assert.throws(()=>assertDormantProof({...decision,moveId:'other'},source,destination));
 assert.throws(()=>assertDormantProof(decision,source,{...destination,reservations:['new']}));
});
for(const which of ['prepared','committing','active-copy','wrong-error','other-move','active-native','pending-turn','changed-file','ownership','destination-reservation','destination-receipt']) test('refuses '+which,()=>assert.throws(()=>probe(which)));

test('Windows peer proof uses fresh regular files and requires successful completion', () => {
 const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'peer-proof-'));
 try {
  const command = exit => (_exe, _args, options) => execFileSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify({proof:true}));process.exit(${exit})`], options);
  assert.deepEqual(readPeerProof(command(0), [], tmp, 'win32'), {proof:true});
  assert.throws(()=>readPeerProof(command(1), [], tmp, 'win32'));
  assert.deepEqual(fs.readdirSync(tmp), []);
 } finally {fs.rmSync(tmp,{recursive:true});}
});

test('Windows retries an automatic move race but never accepts failed output', () => {
 const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'peer-race-'));
 try {
  let calls = 0;
  const race = (_exe, _args, options) => {
   calls++;
   fs.writeSync(options.stdio[1], JSON.stringify({attempt:calls}));
   if (calls < 3) {
    fs.writeSync(options.stdio[2], 'AssertionError: Move is not the dormant reviewed failure\n');
    throw new Error('peer refused');
   }
  };
  assert.deepEqual(readPeerProof(race, [], tmp, 'win32'), {attempt:3});
  assert.equal(calls, 3);
  calls = 0;
  const blocked = (_exe, _args, options) => {
   calls++;
   fs.writeSync(options.stdio[1], '{"proof":true}');
   fs.writeSync(options.stdio[2], 'AssertionError: Source changed during proof\n');
   throw new Error('still copying');
  };
  assert.throws(()=>readPeerProof(blocked, [], tmp, 'win32'), /still copying/);
  assert.equal(calls, 3);
  calls = 0;
  const other = (_exe, _args, options) => {
   calls++;
   fs.writeSync(options.stdio[2], 'AssertionError: Destination receipt or reservation appeared\n');
   throw new Error('new reservation');
  };
  assert.throws(()=>readPeerProof(other, [], tmp, 'win32'), /new reservation/);
  assert.equal(calls, 1);
  assert.deepEqual(fs.readdirSync(tmp), []);
 } finally {fs.rmSync(tmp,{recursive:true});}
});

test('closed destination requires the exact pre-close proof and no new reservation', () => {
 const m={id:'release',compatibility:{migrations:'none'},dormantMoveRecovery:{sha256:'a'.repeat(64)}};
 const t={kind:'desktop-files',environmentId:'255c14ea-4fcc-4a51-b8bc-aa0821239b0a'};
 const decision={source:{receiptSha256:'b'.repeat(64)}};
 const seal={manifestHash:digest(JSON.stringify(m)),targetHash:digest(JSON.stringify(t)),proof:{decisionSha256:m.dormantMoveRecovery.sha256,sourceReceiptSha256:decision.source.receiptSha256}};
 const journal={phase:'closed',release:'release',processes:{closed:true},dormantMoveProofSha256:digest(JSON.stringify(seal))};
 const destination={role:'destination',moveId:DORMANT_MOVE,receipts:[],reservations:[],pending:[]};
 const verify=(j=journal,s=seal,d=destination,c={blockingOperations:[]},target=t)=>assertClosedMoveDestination(m,target,decision,s,j,c,d);
 assert.doesNotThrow(()=>verify());
 assert.throws(()=>verify({...journal,phase:'prepared'}));
 assert.throws(()=>verify({...journal,processes:{closed:false}}));
 assert.throws(()=>verify({...journal,release:'other'}));
 assert.throws(()=>verify(journal,{...seal,targetHash:'c'.repeat(64)}));
 assert.throws(()=>verify(journal,seal,{...destination,reservations:['new']}));
 assert.throws(()=>verify(journal,seal,destination,{blockingOperations:['move:new']}));
 assert.throws(()=>verify(journal,seal,destination,{}, {...t,environmentId:'source'}));
});
