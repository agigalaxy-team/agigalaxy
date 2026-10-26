import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {summaryFixture} from './personal-summary-workflow.mjs';
import {createPersonalSummaryLocal} from "../src/summaries/local/browser.mjs";
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
  const client={preferences:()=>summaries.preferences(b),savePreference:x=>summaries.savePreference(b,x),get:x=>summaries.get(b,x),receipt:x=>summaries.receipt(b,x),delete:x=>summaries.delete(b,x),
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
  loseResult=true;f.advance(10);assert.equal((await local.synchronize()).state,'error');const previousPuts=puts;f.advance(5);await local.synchronize();assert.equal(puts,previousPuts,'Unknown reply checks the original read-only receipt without another upload');
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

test('binding changes during source validation withhold managed fragments without erasing the local record',async()=>{
 const subjectId='GUID'+'A'.repeat(28),store=storeFixture(),endpoint='https://galaxy.example.org',summaryId=randomUUID(),roomId=randomUUID();
 const connection={subjectId,endpoint,bindingId:'binding-a',generation:1,client:{}};let release;
 const content={generator:{kind:'manual'},coverage:{fromSequence:'1',throughSequence:'1',complete:true},fragments:[{id:randomUUID(),kind:'derived',text:'isolated managed detail',sourceRefs:[{messageId:randomUUID(),revision:1}]}],keyMessageRefs:[]};
 const local=createPersonalSummaryLocal({subjectId,store,getConnection:()=>connection,sourceCheck:()=>new Promise(resolve=>{release=resolve;})});
 await local.save({summaryId,roomId,endpoint,content});const reading=local.get({summaryId});await new Promise(resolve=>setImmediate(resolve));
 connection.bindingId='binding-b';connection.generation++;release({available:true});const result=await reading;
 assert.equal(result.sourceState,'unverified-offline');assert.equal(result.content.fragments.length,0);
 assert.equal((await store.read('personal-summary:'+subjectId)).summaries[summaryId].content.fragments.length,1);
});

test('opting out while source validation runs starts no upload and preserves an already sending ID',async()=>{
 const subjectId='GUID'+'A'.repeat(28),store=storeFixture(),endpoint='https://galaxy.example.org',summaryId=randomUUID(),roomId=randomUUID();let puts=0,hold=false,release;
 const content={generator:{kind:'manual'},coverage:{fromSequence:'1',throughSequence:'1',complete:true},fragments:[{id:randomUUID(),kind:'derived',text:'isolated managed detail',sourceRefs:[{messageId:randomUUID(),revision:1}]}],keyMessageRefs:[]};
 const client={preferences:async()=>({revision:1,enabled:true}),put:async()=>{puts++;return{revision:2,conflicts:[]};}};
 const connection={subjectId,endpoint,bindingId:'binding',generation:1,client};
 const local=createPersonalSummaryLocal({subjectId,store,getConnection:()=>connection,now:()=>1000,sourceCheck:()=>hold?new Promise(resolve=>{release=resolve;}):Promise.resolve({available:true})});
 await local.choose({enabled:true,endpoint},{confirmed:true});await local.save({summaryId,roomId,endpoint,content});
 await store.update('personal-summary:'+subjectId,s=>{s.preference.state='enabled';s.preference.cloudRevision=1;s.preference.needsPreferenceSync=false;return s;});
 hold=true;const uploading=local.synchronize({force:true});await new Promise(resolve=>setImmediate(resolve));await local.choose({enabled:false},{confirmed:true});release({available:true});await uploading;assert.equal(puts,0);
 await local.choose({enabled:true,endpoint},{confirmed:true});const original=await store.update('personal-summary:'+subjectId,s=>{s.queue[0].state='sending';return s;});
 const versionId=original.queue[0].versionId;await local.choose({enabled:false},{confirmed:true});
 assert.equal((await store.read('personal-summary:'+subjectId)).queue[0].versionId,versionId);
});

test('binding changes while the sending transaction completes prevent transport dispatch',async()=>{
 const subjectId='GUID'+'A'.repeat(28),base=storeFixture(),endpoint='https://galaxy.example.org',roomId=randomUUID();let puts=0,hold=false,release,entered;
 const gate=new Promise(resolve=>{entered=resolve;}),store={read:base.read,update:async(k,fn)=>{const result=await base.update(k,fn);if(hold&&result.queue?.some(q=>q.state==='sending')){hold=false;entered();await new Promise(resolve=>{release=resolve;});}return result;}};
 const connection={subjectId,endpoint,bindingId:'original-binding',generation:1,client:{preferences:async()=>({revision:1,enabled:true}),put:async()=>{puts++;return{revision:2,conflicts:[]};}}};
 const local=createPersonalSummaryLocal({subjectId,store,getConnection:()=>connection,now:()=>1000});
 const content={generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'0',complete:true},fragments:[{id:randomUUID(),kind:'personal-note',text:'private local note',sourceRefs:[]}],keyMessageRefs:[]};
 await local.choose({enabled:true,endpoint},{confirmed:true});await local.save({roomId,endpoint,content});
 await base.update('personal-summary:'+subjectId,s=>{s.preference.state='enabled';s.preference.cloudRevision=1;s.preference.needsPreferenceSync=false;return s;});
 hold=true;const sync=local.synchronize({force:true});await gate;connection.bindingId='replacement-binding';connection.generation++;release();
 assert.equal((await sync).state,'error');assert.equal(puts,0);const retained=(await base.read('personal-summary:'+subjectId)).queue[0];
 assert.equal(retained.state,'unknown');assert.equal(retained.error,'summary_binding_changed');
});

test('binding changes while rereading the selected preference prevent a new preference write',async()=>{
 const subjectId='GUID'+'A'.repeat(28),base=storeFixture(),endpoint='https://galaxy.example.org';let reads=0,writes=0,release,entered;
 const began=new Promise(resolve=>{entered=resolve;}),store={update:base.update.bind(base),read:async k=>{const s=await base.read(k);if(++reads===2){entered();await new Promise(resolve=>{release=resolve;});}return s;}};
 const connection={subjectId,endpoint,bindingId:'original-binding',generation:1,client:{preferences:async()=>({revision:0}),savePreference:async()=>{writes++;return{revision:1,enabled:true};}}};
 const local=createPersonalSummaryLocal({subjectId,store,getConnection:()=>connection});await local.choose({enabled:true,endpoint},{confirmed:true});
 const sync=local.synchronize();await began;connection.bindingId='replacement-binding';connection.generation++;release();
 await assert.rejects(sync,{code:'summary_binding_changed'});assert.equal(writes,0);
 assert.equal((await base.read('personal-summary:'+subjectId)).preference.needsPreferenceSync,true);
});

test('withdrawn sources erase queued bodies but retain and reconcile the committed original after opt-out',async()=>{
 const f=await summaryFixture();try{const {summaries,people:[a,b],roomId,content}=f,store=storeFixture(),endpoint=summaries.endpoint;let puts=0;
  const client={preferences:()=>summaries.preferences(b),savePreference:x=>summaries.savePreference(b,x),receipt:x=>summaries.receipt(b,x),
   put:async x=>{puts++;await summaries.put(b,x);throw Object.assign(new Error('lost response'),{code:'result_unknown'});}};
  const connection={subjectId:b.subjectId,endpoint,bindingId:b.bindingId,generation:1,client};
  const local=createPersonalSummaryLocal({subjectId:b.subjectId,store,getConnection:()=>connection,now:f.now,
   sourceCheck:async ref=>(await summaries.sources(b,{roomId:ref.roomId,refs:[{messageId:ref.messageId,revision:ref.revision}]})).items[0]});
  await local.choose({enabled:true,endpoint},{confirmed:true});const saved=await local.save({roomId,endpoint,content:content()});await local.synchronize();f.advance(10);await local.synchronize();
  const versionId=(await store.read('personal-summary:'+b.subjectId)).queue[0].versionId;
  await f.chat.retract(a,roomId,f.message.messageId);assert.equal((await local.get({summaryId:saved.summaryId})).content.fragments.length,0);
  const entry=(await store.read('personal-summary:'+b.subjectId)).queue[0];assert.equal(entry.versionId,versionId);assert.equal(entry.receiptOnly,true);assert.equal(Object.hasOwn(entry,'content'),false);
  await local.choose({enabled:false},{confirmed:true});await local.synchronize();
  const receipt=await local.reconcile({summaryId:saved.summaryId,versionId});assert.equal(receipt.state,'committed');assert.equal(receipt.summary.current.content.fragments.length,0);assert.equal(receipt.newUploads,0);assert.equal(puts,1);
  assert.equal((await store.read('personal-summary:'+b.subjectId)).queue.length,0);
  assert.equal((await local.get({summaryId:saved.summaryId})).syncState,'sources-changed');
  assert.equal((await summaries.receipt(a,{summaryId:saved.summaryId,versionId})).state,'absent','Another identity cannot discover the owned operation');
  assert.equal((await summaries.receipt(b,{summaryId:saved.summaryId,versionId:randomUUID()})).state,'absent');
  await assert.rejects(summaries.receipt(b,{summaryId:randomUUID(),versionId}),{code:'summary_operation_conflict'});
 }finally{await f.close();}
});

test('reconciliation preserves cloud deletion and definite absent operations never resend invalidated bodies',async()=>{
 const subjectId='GUID'+'A'.repeat(28),store=storeFixture(),endpoint='https://galaxy.example.org',roomId=randomUUID();let receiptState='absent',versionState='current',puts=0;
 const client={receipt:async x=>({state:receiptState,operationVersionId:x.versionId,...(receiptState==='committed'?{operation:{versionId:x.versionId,summaryId:x.summaryId,revision:1,state:versionState},summary:{revision:2,conflicts:[],current:{state:versionState}}}:{})}),put:async()=>{puts++;}};
 const connection={subjectId,endpoint,bindingId:'binding',generation:1,client},local=createPersonalSummaryLocal({subjectId,store,getConnection:()=>connection});
 const content={generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'0',complete:true},fragments:[{id:randomUUID(),kind:'personal-note',text:'retained local note',sourceRefs:[]}],keyMessageRefs:[]};
 await local.choose({enabled:true,endpoint},{confirmed:true});const saved=await local.save({roomId,endpoint,content});
 let state=await store.update('personal-summary:'+subjectId,s=>{s.queue[0].state='unknown';s.queue[0].receiptOnly=true;delete s.queue[0].content;return s;});
 await local.choose({enabled:false},{confirmed:true});assert.equal((await local.reconcile({summaryId:saved.summaryId,versionId:state.queue[0].versionId})).state,'absent');assert.equal((await store.read('personal-summary:'+subjectId)).queue.length,0);assert.equal(puts,0);
 await local.choose({enabled:true,endpoint},{confirmed:true});state=await store.update('personal-summary:'+subjectId,s=>{s.queue[0].state='unknown';return s;});
 receiptState='committed';versionState='deleted';await local.reconcile({summaryId:saved.summaryId,versionId:state.queue[0].versionId});
 assert.equal((await local.get({summaryId:saved.summaryId})).syncState,'cloud-deleted');assert.equal((await local.get({summaryId:saved.summaryId})).content.fragments[0].text,content.fragments[0].text);assert.equal(puts,0);
});

for(const method of ['pull','reconcile'])test(`${method} withholds a cloud body when binding changes during local transaction completion`,async()=>{
 const subjectId='GUID'+'A'.repeat(28),base=storeFixture(),endpoint='https://galaxy.example.org',roomId=randomUUID(),summaryId=randomUUID();let hold=false,release,entered;
 const gate=new Promise(resolve=>{entered=resolve;}),store={read:base.read,update:async(k,fn)=>{const result=await base.update(k,fn);if(hold){hold=false;entered();await new Promise(resolve=>{release=resolve;});}return result;}};
 const content={generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'0',complete:true},fragments:[{id:randomUUID(),kind:'personal-note',text:'cloud body under original binding',sourceRefs:[]}],keyMessageRefs:[]};
 const remote={summaryId,roomId,revision:1,audience:'owner-only',sharedToRoom:false,conflicts:[],
  current:{summaryId,roomId,versionId:randomUUID(),revision:1,state:'current',content,updatedAt:new Date().toISOString()}},connection={subjectId,endpoint,bindingId:'original-binding',generation:1,
  client:{get:async()=>remote,receipt:async input=>({state:'committed',operationVersionId:input.versionId,operation:{summaryId,versionId:input.versionId,revision:1,state:'current'},summary:remote})}};
 const local=createPersonalSummaryLocal({subjectId,store,getConnection:()=>connection});await local.choose({enabled:true,endpoint},{confirmed:true});await local.save({summaryId,roomId,endpoint,content});
 const original=await base.update('personal-summary:'+subjectId,s=>{s.queue[0].state='unknown';return s;});hold=true;
 const reading=local[method]({summaryId,versionId:original.queue[0].versionId});await gate;connection.bindingId='replacement-binding';connection.generation++;release();
 await assert.rejects(reading,{code:'summary_binding_changed'});
 const saved=await base.read('personal-summary:'+subjectId);assert.equal(saved.summaries[summaryId].cloudRevision,1,'An observed cloud receipt remains recorded without returning its old-binding body');
 if(method==='reconcile'){assert.equal(saved.queue.length,0);assert.equal(saved.summaries[summaryId].lastReceipt.versionId,original.queue[0].versionId);}
});

test('pending operation references remain reachable after opt-out only for the current origin and owner',async()=>{
 const subjectId='GUID'+'A'.repeat(28),store=storeFixture(),endpoint='https://galaxy.example.org',roomId=randomUUID();
 const connection={subjectId,endpoint,bindingId:'binding',generation:1,client:{}};
 const local=createPersonalSummaryLocal({subjectId,store,getConnection:()=>connection}),content={generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'0',complete:true},fragments:[{id:randomUUID(),kind:'personal-note',text:'private content must not enter operation references',sourceRefs:[]}],keyMessageRefs:[]};
 await local.choose({enabled:true,endpoint},{confirmed:true});const saved=await local.save({roomId,endpoint,content});
 const state=await store.update('personal-summary:'+subjectId,s=>{s.queue[0].state='unknown';return s;});await local.choose({enabled:false},{confirmed:true});
 const status=await local.status();assert.equal(status.preference.state,'disabled');assert.deepEqual(status.pendingOperations,[{summaryId:saved.summaryId,versionId:state.queue[0].versionId,endpoint,state:'unknown',receiptOnly:false}]);
 assert.equal(JSON.stringify(status.pendingOperations).includes(content.fragments[0].text),false);
 connection.endpoint='https://another.example.org';assert.deepEqual((await local.status()).pendingOperations,[]);
 connection.endpoint=endpoint;connection.subjectId='GUID'+'B'.repeat(28);assert.deepEqual((await local.status()).pendingOperations,[]);
 assert.equal((await store.read('personal-summary:'+subjectId)).queue[0].versionId,state.queue[0].versionId,'Visibility changes retain the recoverable original operation');
});
