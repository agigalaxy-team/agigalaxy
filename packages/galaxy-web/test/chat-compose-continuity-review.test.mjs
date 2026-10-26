import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatComposeDraft} from "../src/features/chat/chat-compose-draft.ts";
import {createChatClient} from "../src/features/chat/chat-client.mjs";
import {createChatComposePageId} from "../src/features/chat/chat-compose-page.ts";

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
function fixture(){
 const rows=new Map(),roomId=crypto.randomUUID(),subjectId='GUID'+'A'.repeat(28),endpoint='https://chat-review.example.org';
 let owner={subjectId,endpoint,bindingId:crypto.randomUUID(),generation:1},failWrite=false;
 const key=(name,subject=subjectId)=>JSON.stringify([endpoint,subject,name]);
 const localReads=[];
 const getLocal=async(name,subject)=>{localReads.push({name,subject});return structuredClone(rows.get(key(name,subject)));};
 const putLocal=async(name,value,subject)=>{rows.set(key(name,subject),structuredClone(value));};
 const updateLocal=async(name,update,subject)=>{
  if(failWrite){failWrite=false;throw Error('temporary_local_write_failure');}
  const value=update(structuredClone(rows.get(key(name,subject))));await putLocal(name,value,subject);return structuredClone(value);
 };
 const captureLease=()=>{const selected={...owner};return{...selected,assertCurrent(){assert.deepEqual(owner,selected,'The original identity/session is required');}};};
 const calls=[],api={endpoint,snapshot:()=>({...owner}),call:async(path,input)=>{calls.push({path,input});return handler(path,input);}};
 let handler=async()=>{throw Error('No network action was expected');};
 const runtime={getLocal,updateLocal,receiptStatus:{captureLease}};
 return{roomId,subjectId,calls,rows,localReads,draft:page=>createChatComposeDraft(runtime,subjectId,roomId,page),
  client:()=>createChatClient({api,subjectId,captureLease,getLocal,putLocal,updateLocal}),
  network:next=>{handler=next;},failNextWrite:()=>{failWrite=true;},
  read:name=>getLocal(name),changeOwner:()=>{owner={...owner,subjectId:'GUID'+'B'.repeat(28),generation:owner.generation+1};}};
}
const absent=(roomId,input)=>({roomId,...input,state:'absent',checkedAt:new Date().toISOString(),currentAccessGranted:false,
 contentReturned:false,othersReadStatus:'not-asserted',acceptedByRoom:false});

// Two document-owned lock managers share the origin service. Discarding a
// document releases its locks; SPA component cleanup alone does not.
function pageDocuments(){
 /** @type {Map<string,{owner:string}>} */
 const held=new Map();
 /** @param {string} owner @param {string|null} [initialId] */
 function document(owner,initialId=null){
  const rows=new Map(initialId?[['galaxy-chat-page',initialId]]:[]);
  /** @type {string[]} */
  const requests=[];
  const storage={getItem:name=>rows.get(name)??null,setItem:(name,value)=>{rows.set(name,value);}};
  const locks={
   /** @template T @param {string} name @param {LockOptions|LockGrantedCallback<T>} optionsOrCallback
    * @param {LockGrantedCallback<T>} [callback] @returns {Promise<T>} */
   async request(name,optionsOrCallback,callback){
    const action=typeof optionsOrCallback==='function'?optionsOrCallback:callback;
    if(!action||typeof optionsOrCallback==='function'||optionsOrCallback.ifAvailable!==true)throw Error('The reviewed caller must make an ifAvailable document claim');
    requests.push(name);
    if(held.has(name))return action(null);
    const ownership={owner};held.set(name,ownership);
    /** @type {Lock} */
    const lock={name,mode:'exclusive'};
    try{return await action(lock);}finally{if(held.get(name)===ownership)held.delete(name);}
   }
  };
  return{claim:createChatComposePageId({locks,storage}),storage,locks,requests,
   discard:()=>{for(const [key,value]of held)if(value.owner===owner)held.delete(key);}};
 }
 return{document};
}

test('a second tab cannot replace the first confirmed send association on the same input revision',async()=>{
 const f=fixture(),a=f.draft('a');await a.start();a.change({text:'One intended outgoing message'});
 const selected=await a.snapshot(),b=f.draft('b');await b.start();
 const originalId=crypto.randomUUID(),competingId=crypto.randomUUID(),entered=deferred(),release=deferred();
 f.network(async(path,input)=>{assert.ok(path.endsWith('/send'));entered.resolve();await release.promise;return{state:'accepted',messageId:input.clientMessageId};});
 await a.attach({kind:'send',id:originalId},selected.revision);
 const sending=f.client().send(f.roomId,selected.value.text,{confirmed:true,clientMessageId:originalId,
  onJournal:locator=>a.attach({kind:'send',id:originalId,requestHash:locator.requestHash},selected.revision)});
 await entered.promise;
 try{
  const competing=await b.snapshot();assert.equal(competing.revision,selected.revision);
  await assert.rejects(b.attach({kind:'send',id:competingId},competing.revision),
   'A different outgoing intent must not replace the first operation locator');
  const durable=await f.read('chat-draft:'+f.roomId);assert.equal(durable.attempt.id,originalId);
 }finally{release.resolve();await sending;await a.settle(originalId);a.close();b.close();}
 assert.equal(f.calls.length,1,'Only the already confirmed send reached the network');
 assert.equal((await f.read('chat-draft:'+f.roomId)).value.text,'');
});

test('failed local persistence cannot report a safe navigation flush while current words exist only in memory',async()=>{
 const f=fixture(),a=f.draft('a');await a.start();a.change({text:'Previously saved draft'});await a.flush();
 f.failNextWrite();a.change({text:'New words entered just before opening an author'});
 await assert.rejects(a.flush(),'Opening the author must stay blocked until these words are safely retained');
 assert.equal(a.read().value.text,'New words entered just before opening an author');
 assert.equal((await f.read('chat-draft:'+f.roomId)).value.text,'Previously saved draft');
 a.close();
});

test('checking an older stopped message preserves another tab’s newly stopped exact locator',async()=>{
 const f=fixture(),a=f.client(),b=f.client(),olderId=crypto.randomUUID(),newerId=crypto.randomUUID();
 const entered=deferred(),release=deferred();
 f.network(async(path,input)=>{if(path.endsWith('/receipt')){entered.resolve();await release.promise;return absent(f.roomId,input);}throw Error('offline_before_send');});
 await assert.rejects(a.send(f.roomId,'Earlier selected message',{confirmed:true,clientMessageId:olderId}),/offline_before_send/);
 await a.stopRetry(f.roomId,{confirmed:true});
 await assert.rejects(b.send(f.roomId,'Later separately selected message',{confirmed:true,clientMessageId:newerId}),/offline_before_send/);
 const checking=a.reconcileStopped(f.roomId,olderId);await entered.promise;
 await b.stopRetry(f.roomId,{confirmed:true});
 assert.equal((await b.stopped(f.roomId)).length,2);
 release.resolve();await checking;
 const records=await b.stopped(f.roomId);
 assert.deepEqual(new Set(records.map(row=>row.input.clientMessageId)),new Set([olderId,newerId]),
  'Updating the earlier receipt must not erase the newer body-free retry locator');
 assert.ok(records.every(row=>!Object.hasOwn(row.input,'text')));
 assert.equal(f.calls.filter(row=>row.path.endsWith('/send')).length,2,'Receipt checking adds no outgoing message');
});

test('old draft completion cannot write another identity’s local input',async()=>{
 const f=fixture(),a=f.draft('a');await a.start();a.change({text:'Saved only for the original author'});await a.flush();
 f.changeOwner();a.change({text:'A late callback must remain outside the new identity'});await assert.rejects(a.snapshot());
 assert.equal((await f.read('chat-draft:'+f.roomId)).value.text,'Saved only for the original author');
 assert.equal(a.read().value.text,'A late callback must remain outside the new identity');a.close();
});

test('closing a compose view during page ownership claim prevents late local reads or activation',async()=>{
 const f=fixture(),claim=deferred(),a=f.draft(claim.promise);
 const started=a.start();a.close();claim.resolve(crypto.randomUUID());await started;
 assert.equal(f.localReads.length,0,'A closed view must not read the former identity after a late claim');
 assert.equal(a.read().ready,false);assert.equal(f.rows.size,0);
});

test('a page ownership claim cannot activate a compose view after its identity changed',async()=>{
 const f=fixture(),claim=deferred(),a=f.draft(claim.promise);
 const started=a.start();f.changeOwner();claim.resolve(crypto.randomUUID());await started;
 assert.equal(f.localReads.length,0,'The original identity lease must be checked again after the claim');
 assert.equal(a.read().ready,false);assert.equal(f.rows.size,0);a.close();
});

test('one active document claims its saved page once across chat and profile remounts',async()=>{
 const origin=pageDocuments(),saved=crypto.randomUUID(),page=origin.document('original-document',saved);
 const first=page.claim();assert.equal(page.claim(),first);assert.equal(await first,saved);
 const f=fixture(),chat=f.draft(page.claim());await chat.start();chat.change({text:'Unsent words before opening the author'});await chat.flush();chat.close();
 const returning=f.draft(page.claim());await returning.start();
 assert.equal(returning.read().value.text,'Unsent words before opening the author');
 assert.equal(page.requests.length,1,'A SPA remount must reuse this document claim without unlocking it');
 returning.close();page.discard();
});

test('a copied opener page claims a separate backup and both original drafts survive refresh',async()=>{
 const origin=pageDocuments(),saved=crypto.randomUUID(),original=origin.document('original-document',saved);
 const originalId=await original.claim(),copy=origin.document('copied-document',saved),copyId=await copy.claim();
 assert.equal(originalId,saved);assert.notEqual(copyId,originalId);
 assert.equal(copy.storage.getItem('galaxy-chat-page'),copyId,'The copied document saves its own refresh locator');
 const f=fixture(),a=f.draft(originalId),b=f.draft(copyId);await a.start();await b.start();
 a.change({text:'Original page words'});await a.flush();b.change({text:'Copied page different words'});await b.flush();
 assert.equal(b.read().conflict,true);await a.flush();a.close();b.close();
 original.discard();copy.discard();
 const refreshedA=origin.document('refreshed-original',original.storage.getItem('galaxy-chat-page'));
 const refreshedB=origin.document('refreshed-copy',copy.storage.getItem('galaxy-chat-page'));
 const [idA,idB]=await Promise.all([refreshedA.claim(),refreshedB.claim()]);
 assert.equal(idA,originalId);assert.equal(idB,copyId);
 const readA=f.draft(idA),readB=f.draft(idB);await readA.start();await readB.start();
 assert.equal(readA.read().value.text,'Original page words');assert.equal(readB.read().value.text,'Copied page different words');
 assert.equal(readB.read().conflict,true);assert.equal(f.calls.length,0);
 readA.close();readB.close();refreshedA.discard();refreshedB.discard();
});

test('unavailable lock or storage never enables a compose view with an unclaimed backup ID',async()=>{
 const origin=pageDocuments(),page=origin.document('restricted-document'),f=fixture();
 const unavailable=createChatComposePageId({locks:null,storage:page.storage}),claim=unavailable();
 assert.equal(unavailable(),claim);await assert.rejects(claim,/保护多页草稿/);
 const blocked=f.draft(claim);await blocked.start();
 assert.equal(blocked.read().ready,false);assert.equal(f.localReads.length,0);assert.equal(f.rows.size,0);blocked.close();
 const unreadable=createChatComposePageId({locks:page.locks,storage:{getItem:()=>{throw Error('storage unavailable');},setItem:()=>assert.fail('An unreadable page locator must not be replaced')}});
 await assert.rejects(unreadable(),/读取草稿位置/);assert.equal(page.requests.length,0);page.discard();
});
