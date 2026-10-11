import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createNativeStore} from '../../../packages/galaxy-edge-mcp/src/native-v2/store.mjs';
import {createHostViewState,hostViewOwnerScope} from './host-view-state.mjs';

test('real NativeStore persists host preferences, atomically fences revisions and isolates subject / endpoint / host',{timeout:20000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-host-view-'));
 const store=createNativeStore(directory);let state={subjectId:'subject-a',deviceId:'device-a',endpoint:'https://a.example',bindingId:'binding-a',generation:1};
 const runtime={store,receiptStatus:{captureLease:()=>{const original=state;return{...state,assertCurrent:()=>{if(state!==original)throw Error('receipt_status_authority_changed');}};}}};
 let preferences=createHostViewState(runtime);
 const input=(action,extra={})=>({action,hostName:'synthetic-sdk-host',ownerScope:hostViewOwnerScope(state),...extra});
 try{
  assert.equal((await preferences.run(input('read'))).mode,null);
  const saved=await preferences.run(input('save',{expectedRevision:0,mode:'fullscreen'}));assert.equal(saved.revision,1);
  preferences.close();runtime.store=createNativeStore(directory);preferences=createHostViewState(runtime);state={...state,bindingId:'reopened',generation:2};
  assert.equal((await preferences.run(input('read'))).mode,'fullscreen');
  assert.equal((await preferences.run({...input('read'),hostName:'another-host'})).mode,null);
  const original=state;state={...state,subjectId:'subject-b'};assert.equal((await preferences.run(input('read'))).mode,null);
  state={...original,endpoint:'https://b.example'};assert.equal((await preferences.run(input('read'))).mode,null);state=original;
  const concurrent=await Promise.allSettled(['inline','pip'].map(mode=>preferences.run(input('save',{expectedRevision:1,mode}))));
  assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);assert.match(concurrent.find(x=>x.status==='rejected').reason.message,/revision_conflict/);
  assert.equal((await preferences.run(input('reset',{expectedRevision:2}))).mode,null);
 }finally{preferences.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-host-view-'));await rm(target,{recursive:true,force:true});}
});

test('actual FS read and locked update completion cannot return old-owner preferences after rebind',{timeout:20000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-host-view-'));const store=createNativeStore(directory);
 let state={subjectId:'subject-a',deviceId:'device-a',endpoint:'https://a.example',bindingId:'first',generation:1},hook=null;
 const runtime={store:{...store,get:async key=>{const result=await store.get(key);hook?.();return result;},update:async(key,change)=>store.update(key,old=>{hook?.();return change(old);})},
  receiptStatus:{captureLease:()=>{const original=state;return{...state,assertCurrent:()=>{if(state!==original)throw Error('receipt_status_authority_changed');}};}}};
 const preferences=createHostViewState(runtime),input=(action,extra={})=>({action,hostName:'synthetic-host',ownerScope:hostViewOwnerScope(state),...extra});
 try{
  const old=input('read');hook=()=>{state={...state,bindingId:'second',generation:2};};await assert.rejects(preferences.run(old),/authority_changed/);
  await assert.rejects(preferences.run(old),/owner_changed/);
  hook=()=>{state={...state,bindingId:'third',generation:3};};await assert.rejects(preferences.run(input('save',{expectedRevision:0,mode:'fullscreen'})),/authority_changed/);
  hook=null;assert.equal((await preferences.run(input('read'))).revision,0);
 }finally{preferences.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-host-view-'));await rm(target,{recursive:true,force:true});}
});
