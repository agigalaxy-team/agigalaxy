import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeLocalGalaxyId,setLocalUploadPrivacy,getLocalUploadPrivacy} from '../packages/galaxy-core/src/local-store.mjs';
import {createLocalWorkHistory} from '../packages/galaxy-core/src/work-history/index.mjs';
import {createLocalConversationArchive} from '../packages/galaxy-core/src/conversation-archive/index.mjs';
import {createNativeWorkSync} from '../packages/galaxy-edge-mcp/src/native-v2/work/sync.mjs';
import {createNativeArchiveSync} from '../packages/galaxy-edge-mcp/src/native-v2/work/archive-sync.mjs';
import {createNativeStore} from '../packages/galaxy-edge-mcp/src/native-v2/store.mjs';
import {createNativeLocalWorkServices} from '../packages/galaxy-edge-mcp/src/native-v2/work/local-tools.mjs';
import {createLocalChoiceResume} from '../integrations/native-v2/compact-app/local-work-view.mjs';
import {accountWorkPutSchema} from '../packages/galaxy-official/src/shared/account-work-schema.mjs';

const endpoint='https://service.example.test',accountId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function fixture(run){const dataDirectory=await mkdtemp(join(tmpdir(),'galaxy-local-continuity-'));try{const {identity}=await initializeLocalGalaxyId(dataDirectory);await run({dataDirectory,getIdentity:()=>identity,identity});}finally{await rm(dataDirectory,{recursive:true,force:true});}}

test('editing a different work source preserves its neighbours scope and owner deletion',()=>fixture(async context=>{
  const history=createLocalWorkHistory(context),one=await history.recordNote({host:'opencode',sessionId:'one',sourceId:'one',text:'First work'}),two=await history.recordNote({host:'opencode',sessionId:'two',sourceId:'two',text:'Second work'});
  const cloud=new Map(),puts=[];
  const call=async(path,input)=>{if(path.endsWith('/accounts'))return {subjectId:context.identity.id,accounts:[{accountId,endpoint}]};if(path.endsWith('/status'))return cloud.get(input.workId)??{state:'absent',revision:0};
    if(path.endsWith('/put')){accountWorkPutSchema.parse(input);puts.push(input);const receipt={workId:input.workId,state:'stored',scopeId:input.scopeId,lastOperationId:input.operationId,revision:input.revision};cloud.set(input.workId,receipt);return receipt;}throw Error('unexpected_operation');};
  const sync=createNativeWorkSync({...context,endpoint,call}),choose=(ids,extra={})=>sync.choose({choiceId:randomUUID(),enabled:true,targetAccountId:accountId,workIds:ids,includeExisting:true,...extra});
  await choose([one.workId]);await sync.flush();const firstScope=puts[0].scopeId;
  await choose([one.workId,two.workId]);await history.recordNote({host:'opencode',sessionId:'one',sourceId:'more',text:'More work'});await sync.flush();
  assert.ok(puts.filter(item=>item.workId===one.workId).every(item=>item.scopeId===firstScope));
  cloud.set(one.workId,{state:'deleted',scopeId:firstScope,revision:3,deletedReason:'owner-deleted'});await history.recordNote({host:'opencode',sessionId:'one',sourceId:'later',text:'Later work'});await sync.flush();
  const before=puts.filter(item=>item.workId===one.workId).length;
  await choose([one.workId]);await history.recordNote({host:'opencode',sessionId:'one',sourceId:'last',text:'New local fact'});await sync.flush();
  assert.equal(puts.filter(item=>item.workId===one.workId).length,before);
  await choose([one.workId],{restoreWorkIds:[one.workId]});await sync.flush();assert.notEqual(puts.at(-1).scopeId,firstScope);await sync.close();
}));

test('adding an archive leaves the existing source scope intact and repeat save is a no-op',()=>fixture(async context=>{
  const archive=createLocalConversationArchive(context);await archive.configure({enabled:true,sessions:[{host:'opencode',sessionId:'one'},{host:'opencode',sessionId:'two'}],autoCleanAfterDays:null});
  const ids=(await archive.list()).items.map(item=>item.archiveSessionId);await setLocalUploadPrivacy(context.dataDirectory,{level:'conversation-archive',includeFullConversations:true,sessionIds:ids});
  const sync=createNativeArchiveSync({...context,endpoint,call:async()=>({subjectId:context.identity.id,accounts:[{accountId,endpoint}]})});
  await sync.choose({choiceId:randomUUID(),enabled:true,targetAccountId:accountId,archiveSessionIds:[ids[0]]});const first=await sync.settings();
  await sync.choose({choiceId:randomUUID(),enabled:true,targetAccountId:accountId,archiveSessionIds:ids});const added=await sync.settings();assert.equal(added.choice.scopeIds[ids[0]],first.choice.scopeIds[ids[0]]);
  await sync.choose({choiceId:randomUUID(),enabled:true,targetAccountId:accountId,archiveSessionIds:ids});assert.deepEqual((await sync.settings()).choice,added.choice);await sync.close();
}));

test('one selected conversation resolves capture, allowed upload and private destination without asking for archive IDs',()=>fixture(async context=>{
  const archiveSync=createNativeArchiveSync({...context,endpoint,call:async()=>({subjectId:context.identity.id,accounts:[{accountId,endpoint}]})});let resumed=0;
  const local=createNativeLocalWorkServices({store:createNativeStore(context.dataDirectory),api:{endpoint},localIdentityWithin:context.getIdentity,archiveSync,resumePrivateSync:()=>resumed++});
  const input={choiceId:randomUUID(),level:'conversation-archive',conversationMode:'cloud',targetAccountId:accountId,sessions:[{host:'opencode',sessionId:'selected'}],autoCleanAfterDays:null};
  await local.saveSettings(input);const captured=(await local.archive.list()).items;assert.equal(captured.length,1);
  assert.deepEqual((await getLocalUploadPrivacy(context.dataDirectory)).settings.sessionIds,[captured[0].archiveSessionId]);assert.deepEqual((await archiveSync.settings()).choice.archiveSessionIds,[captured[0].archiveSessionId]);
  const scope=(await archiveSync.settings()).choice.scopeIds[captured[0].archiveSessionId];await local.saveSettings(input);assert.equal((await archiveSync.settings()).choice.scopeIds[captured[0].archiveSessionId],scope);assert.equal(resumed,1);await archiveSync.close();
}));

test('large selected work is automatically stored as a truthful latest-observation window',()=>fixture(async context=>{
  await setLocalUploadPrivacy(context.dataDirectory,{level:'work-content'});
  const history=createLocalWorkHistory(context);let note;
  for(let index=0;index<70;index++)note=await history.recordNote({host:'opencode',sessionId:'large',sourceId:'part-'+index,text:'过程'.repeat(1600)});
  let receipt={state:'absent',revision:0},saved;
  const call=async(path,input)=>{if(path.endsWith('/accounts'))return {subjectId:context.identity.id,accounts:[{accountId,endpoint}]};if(path.endsWith('/status'))return receipt;
    if(path.endsWith('/put')){accountWorkPutSchema.parse(input);saved=input;receipt={state:'stored',revision:input.revision,scopeId:input.scopeId,lastOperationId:input.operationId};return receipt;}throw Error('unexpected_operation');};
  const sync=createNativeWorkSync({...context,endpoint,call});await sync.choose({choiceId:randomUUID(),enabled:true,targetAccountId:accountId,workIds:[note.workId],includeExisting:true});
  const result=await sync.flush();assert.equal(result.items.at(-1).state,'stored');assert.ok(Buffer.byteLength(JSON.stringify(saved.data))<=524288);
  const coverage=saved.data.coverage.observations;assert.equal(coverage.sourceTotal,70);assert.equal(coverage.hasEarlier,true);assert.ok(coverage.included>0&&coverage.included<70);assert.equal(coverage.lastSequence,saved.data.observations.at(-1).sequence);
  assert.ok(saved.data.observations.every(item=>item.content.excerpt==='过程'.repeat(1600)));await sync.close();
}));

test('browser approval resumes the exact operation automatically across an unknown reply and stops after cancellation',async()=>{
  const scheduled=new Map();let nextId=0,calls=0,results=0;const args={choiceId:randomUUID()},pending={_meta:{galaxyLocalWork:{choice:{state:'pending'}}}},done={_meta:{galaxyLocalWork:{saved:true}}};
  const resume=createLocalChoiceResume({schedule:callback=>{scheduled.set(++nextId,callback);return nextId;},cancel:id=>scheduled.delete(id),call:async(name,input)=>{assert.equal(name,'save');assert.equal(input,args);calls++;if(calls===1)throw Error('reply_unavailable');return calls===2?pending:done;},onResult:()=>results++});
  const tick=async()=>{const [id,callback]=scheduled.entries().next().value;scheduled.delete(id);await callback();};
  resume.start('save',args,{state:'pending'});await tick();await tick();await tick();assert.equal(calls,3);assert.equal(results,1);assert.equal(scheduled.size,0);resume.close();
  let cancelled=0;const decline=createLocalChoiceResume({schedule:callback=>{scheduled.set(++nextId,callback);return nextId;},cancel:id=>scheduled.delete(id),call:async()=>({_meta:{galaxyLocalWork:{choice:{state:'declined'}}}}),onResult:()=>cancelled++});
  decline.start('save',args,{state:'pending'});await tick();assert.equal(cancelled,1);assert.equal(scheduled.size,0);decline.close();
});
