import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {summaryFixture} from './personal-summary-workflow.mjs';
import {createPersonalSummaryLocal} from '../src/personal-summary-local.mjs';
// Explicit deterministic local storage double, independent from real IDB QA.
function storeFixture(){const records=new Map();let tail=Promise.resolve();return{read:async k=>structuredClone(records.get(k)),update(k,fn){const run=tail.then(()=>{const value=fn(structuredClone(records.get(k)));records.set(k,structuredClone(value));return structuredClone(value);});tail=run.catch(()=>{});return run;}};}
test('local conflict replicas lose revoked sources and binding changes prevent follow-up deletion',async()=>{
 const subjectId='GUID'+'A'.repeat(28),store=storeFixture(),roomId=randomUUID(),summaryId=randomUUID(),endpoint='https://galaxy.example.org';let available=true,temporary=false,connected=true,deletes=0;
 const content={generator:{kind:'manual'},coverage:{fromSequence:'1',throughSequence:'1',complete:true},fragments:[{id:randomUUID(),kind:'derived',text:'revocable detail',sourceRefs:[{messageId:randomUUID(),revision:1}]}],keyMessageRefs:[]};
 const client={get:async()=>{connected=false;return{revision:1,current:{content}};},delete:async()=>{deletes++;}};
 const connection={subjectId,endpoint,bindingId:randomUUID(),generation:1,client};
 const local=createPersonalSummaryLocal({subjectId,store,getConnection:()=>connected?connection:null,sourceCheck:async()=>({available,temporarilyUnavailable:temporary})});
 await local.choose({enabled:true,endpoint},{confirmed:true});await local.save({summaryId,roomId,endpoint,content});
 await store.update('personal-summary:'+subjectId,s=>{s.summaries[summaryId].remoteCurrent={content:structuredClone(content)};s.summaries[summaryId].conflicts=[{versionId:randomUUID(),content:structuredClone(content)}];return s;});
 available=false;temporary=true;assert.equal((await local.get({summaryId})).content.fragments.length,0);assert.equal((await store.read('personal-summary:'+subjectId)).summaries[summaryId].content.fragments.length,1);
 available=true;temporary=false;assert.equal((await local.get({summaryId})).content.fragments.length,1,'Cancelled temporary restriction restores permitted local projection');
 connection.endpoint='https://different.example.org';assert.equal((await local.get({summaryId})).content.fragments.length,0);assert.equal((await store.read('personal-summary:'+subjectId)).summaries[summaryId].content.fragments.length,1,'A different service is not authority to erase this origin’s local sources');connection.endpoint=endpoint;
 available=false;const filtered=await local.get({summaryId});assert.equal(filtered.content.fragments.length,0);assert.equal(filtered.remoteCurrent.content.fragments.length,0);assert.equal(filtered.conflicts[0].content.fragments.length,0);
 const stored=await store.read('personal-summary:'+subjectId);assert.equal(stored.summaries[summaryId].conflicts[0].content.fragments.length,0);assert.equal(stored.queue.length,0);
 await assert.rejects(local.deleteCloud({summaryId},{confirmed:true}),{code:'summary_binding_changed'});assert.equal(deletes,0);
 connected=true;await assert.rejects(local.pull({summaryId}),{code:'summary_binding_changed'});
});
test('local default, pending binding, stable unknown retries, conflicts and disable keep exact scope',async()=>{
 const f=await summaryFixture();try{const {summaries,people:[a,b],content,roomId}=f,endpoint=summaries.endpoint;let bound=false,puts=0,loseResult=false;
  const client={preferences:()=>summaries.preferences(b),savePreference:x=>summaries.savePreference(b,x),get:x=>summaries.get(b,x),delete:x=>summaries.delete(b,x),
   put:async x=>{puts++;const result=await summaries.put(b,x);if(loseResult){loseResult=false;throw Object.assign(new Error('unknown response'),{code:'result_unknown'});}return result;}};
  const connection={subjectId:b.subjectId,bindingId:b.bindingId,endpoint,client,generation:1};
  const make=()=>createPersonalSummaryLocal({subjectId:b.subjectId,store:storeFixture(),getConnection:()=>bound?connection:null,now:f.now,
   sourceCheck:async ref=>{if(!bound)throw new Error('offline');return(await summaries.sources(b,{roomId:ref.roomId,refs:[{messageId:ref.messageId,revision:ref.revision}]})).items[0];}});
  const local=make(),saved=await local.save({roomId,endpoint,content:content()});assert.equal((await local.status()).preference.state,'unset');assert.equal(puts,0);
  await local.choose({enabled:false},{confirmed:true});assert.equal((await local.status()).promptNeeded,false);bound=true;await local.onBinding();
  assert.equal((await summaries.preferences(b)).enabled,false);assert.equal(puts,0);
  const other=make();await other.onBinding();assert.equal((await other.status()).promptNeeded,false,'Decline remains an identity choice on new device');
  bound=false;await local.choose({enabled:true,endpoint},{confirmed:true});assert.equal((await local.status()).preference.state,'enabled-pending-binding');
  assert.equal((await local.synchronize()).state,'local');bound=true;await local.onBinding();assert.equal(puts,0,'Ten-second debounce does not upload immediately');
  f.advance(10);await local.synchronize();assert.equal(puts,1);assert.equal((await local.get({summaryId:saved.summaryId})).syncState,'synced');
  await other.onBinding();await other.choose({enabled:true,endpoint},{confirmed:true});await other.synchronize();await other.pull({summaryId:saved.summaryId});
  const own=await local.get({summaryId:saved.summaryId});await local.save({summaryId:saved.summaryId,roomId,endpoint,expectedLocalRevision:own.localRevision,content:content('changed on one device')});
  loseResult=true;f.advance(10);assert.equal((await local.synchronize()).state,'error');const previousPuts=puts;f.advance(5);await local.synchronize();assert.equal(puts,previousPuts+1);
  const remote=(await summaries.get(b,{summaryId:saved.summaryId}));assert.equal(remote.revision,2,'Unknown reply replay does not create another revision');
  const stale=await other.get({summaryId:saved.summaryId});await other.save({summaryId:saved.summaryId,roomId,endpoint,expectedLocalRevision:stale.localRevision,content:content('independent second-device edit')});
  f.advance(10);await other.synchronize();assert.equal((await other.get({summaryId:saved.summaryId})).syncState,'conflict');
  const two=await other.get({summaryId:saved.summaryId});await other.resolve({summaryId:saved.summaryId,expectedLocalRevision:two.localRevision,content:content('user selected a merged explanation')},{confirmed:true});f.advance(10);await other.synchronize();
  assert.equal((await summaries.get(b,{summaryId:saved.summaryId})).conflicts.length,0);
  await local.choose({enabled:false},{confirmed:true});await local.synchronize();const beforeDisabled=puts;await other.synchronize();assert.equal((await other.status()).preference.state,'disabled');assert.equal(puts,beforeDisabled);
  await local.deleteCloud({summaryId:saved.summaryId},{confirmed:true});assert((await local.get({summaryId:saved.summaryId})).content.fragments.length>0,'Deleting cloud never silently deletes local');
  await f.chat.retract(a,roomId,f.message.messageId);assert.equal((await local.get({summaryId:saved.summaryId})).content.fragments.length,0);
  await local.choose({enabled:true,endpoint:'https://another.example.org'},{confirmed:true});assert.equal((await local.synchronize()).state,'local');assert.equal(puts,beforeDisabled);
 }finally{await f.close();}
});
