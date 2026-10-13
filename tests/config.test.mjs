import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {resolveProject} from '../skills/t3-fork-session/scripts/config.mjs';

test('global project resolution uses current checkout/worktree and explicit profiles, never package directory',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'t3w-project-'));
 try{
  const repo=path.join(dir,'repo'),worktree=path.join(dir,'worktree');mkdirSync(repo);
  execFileSync('git',['init','-b','main'],{cwd:repo,stdio:'ignore'});
  execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.test','commit','--allow-empty','-m','test'],{cwd:repo,stdio:'ignore'});
  execFileSync('git',['worktree','add','-b','test',worktree],{cwd:repo,stdio:'ignore'});
  const config={projects:{group:{repositories:[repo],baseProject:path.join(dir,'bases')}}};
  assert.equal(resolveProject(undefined,worktree,config),path.join(dir,'bases'));
  assert.equal(resolveProject('group',dir,config),path.join(dir,'bases'));
  assert.equal(resolveProject(undefined,worktree,{}),repo);
  assert.throws(()=>resolveProject(undefined,dir,{}),/No project resolved/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('ambiguous configured project roots require an explicit selection',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'t3w-ambiguous-'));
 try{assert.throws(()=>resolveProject(undefined,dir,{projects:{a:{baseProject:dir},b:{baseProject:dir}}}),/Multiple/);}
 finally{rmSync(dir,{recursive:true,force:true});}
});
