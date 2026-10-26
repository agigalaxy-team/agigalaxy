import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getSummaryRuntime,closeSummaryRuntime} from "../../galaxy-web/src/features/conversation-notes/native/runtime.mjs";
import {sharedSummaryRequestHash} from "../src/clients/chat-shared-summary.mjs";

// Browser coordination doubles only. Authenticated HTTP, database, room exit,
// and external archive cleanup have separate service/HTTP evidence.
async function fixture(){
 const subjectId='GUID'+'A'.repeat(28),roomId=randomUUID(),records=new Map(),data=new Map(),calls=[];
 const request={shareId:randomUUID(),roomId,expectedMemberRevision:2,audience:'room-authorized-members',content:{generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'0',complete:false},fragments:[{id:randomUUID(),kind:'personal-note',text:'Selected synthetic private note',sourceRefs:[{messageId:randomUUID(),revision:1}]}],keyMessageRefs:[]}};
 const requestHash=await sharedSummaryRequestHash(request);let active=subjectId,state='absent',access=true,source=true,cleanup=false,retractUnknown=false,published=0;
 const reply=()=>({roomId,shareId:request.shareId,requestHash,state,checkedAt:'2026-10-02T00:00:00.000Z',currentAccessGranted:false,contentReturned:false,acceptedByRoom:state==='published',othersReadStatus:'not-asserted',...(['absent','conflict'].includes(state)?{}:{messageId:request.shareId,messageState:state==='published'?'accepted':state,historicalAcceptanceRecorded:state==='published',summaryContentHidden:['retracted','expired'].includes(state),noticeRetractionRecorded:state==='retracted',noticeCleanupState:state==='retracted'?(cleanup?'pending':'recorded-complete'):'not-requested',archiveScope:'shared-summary-notice-only'})});
 const runtime={api:{endpoint:'https://summary-ui.example.org',snapshot:()=>({subjectId:active,bindingId:'fixture',generation:1,expiresAt:9000000000}),call:async(path,input)=>{
  calls.push({path,input:structuredClone(input)});
  if(path.endsWith('/shared-summaries/receipt'))return reply();
  if(path===`/v2/chat/rooms/${roomId}/read`){if(!access)throw Error('chat_access_denied');return{roomId,memberRevision:2};}
  if(path.endsWith('/sources')){if(!access)throw Error('chat_access_denied');return{items:[{available:source,temporarilyUnavailable:false}]};}
  if(path.endsWith('/publish')){assert.equal(await sharedSummaryRequestHash(input),requestHash);published++;state='published';return{roomId,shareId:request.shareId,state};}
  if(path.endsWith('/retract')){if(retractUnknown)throw Error('network_unknown');state='retracted';return{shareId:request.shareId,retracted:true,noticeCleanupPending:cleanup};}
  throw Error('Unexpected body/get or unrelated call: '+path);
 }},status:async()=>({identity:{subjectId:active}}),getLocal:async key=>structuredClone(records.get(active+key)),putLocal:async(key,value)=>records.set(active+key,structuredClone(value))};
 const store={read:async key=>structuredClone(data.get(key)),update:async(key,fn)=>{const result=fn(structuredClone(data.get(key)));data.set(key,structuredClone(result));return structuredClone(result);},close(){}};
 const bridge=await getSummaryRuntime(runtime,subjectId,{openStore:async()=>store});
 return{runtime,bridge,subjectId,roomId,request,requestHash,calls,reply,seed:async({hash=true,payload=true,phase='awaiting-receipt'}={})=>runtime.putLocal('summary-share:'+roomId,{roomId,shareId:request.shareId,...(hash?{requestHash}:{}),...(payload?{request}:{}),phase}),stored:()=>runtime.getLocal('summary-share:'+roomId),setState:x=>{state=x;},setAccess:x=>{access=x;},setSource:x=>{source=x;},setCleanup:x=>{cleanup=x;},setRetractUnknown:x=>{retractUnknown=x;},setIdentity:x=>{active=x;},published:()=>published,close:()=>closeSummaryRuntime(runtime)};
}

test('lost shared ACK reconciles canonical original hash after room access loss, without body read or publish',async()=>{
 const f=await fixture();try{await f.seed({hash:false});f.setState('published');f.setAccess(false);
  const result=await f.bridge.reconcile(f.roomId,{retry:true});assert.equal(result.state,'published');assert.equal(result.currentAccessGranted,false);assert.equal(await f.stored(),null);assert.equal(f.published(),0);
  assert.deepEqual(f.calls.map(c=>c.path),['/v2/chat/shared-summaries/receipt']);assert.deepEqual(f.calls[0].input,{roomId:f.roomId,shareId:f.request.shareId,requestHash:f.requestHash});
 }finally{f.close();}
});

test('stopped local retry retains original hash for late publication and never crosses identities',async()=>{
 const f=await fixture();try{await f.seed();f.setRetractUnknown(true);const stopped=await f.bridge.cancelPending(f.roomId);
  assert.equal(stopped.localRetryStopped,true);assert.equal(stopped.serverRetractionConfirmed,false);const p=await f.bridge.pending(f.roomId);assert.equal(p.requestHash,f.requestHash);assert.equal(p.canRetry,false);assert.equal(Object.hasOwn(await f.stored(),'request'),false);
  f.setState('published');f.setAccess(false);assert.equal((await f.bridge.reconcile(f.roomId)).state,'published');assert.equal(f.published(),0);assert.equal(await f.stored(),null);
  const before=f.calls.length;f.setIdentity('GUID'+'B'.repeat(28));await assert.rejects(f.bridge.cancelPending(f.roomId),/身份已改变/);assert.equal(f.calls.length,before);
 }finally{f.close();}
});

test('exact pending retry rechecks current room and source before reusing the same request once',async()=>{
 const f=await fixture();try{await f.seed();f.setSource(false);await assert.rejects(f.bridge.reconcile(f.roomId,{retry:true}),/shared_summary_sources_unavailable/);assert.equal(f.published(),0);assert.equal((await f.stored()).requestHash,f.requestHash);
  f.setSource(true);const r=await f.bridge.reconcile(f.roomId,{retry:true});assert.equal(r.state,'published');assert.equal(f.published(),1);assert.equal(await f.stored(),null);
  const publish=f.calls.find(c=>c.path.endsWith('/publish'));assert.deepEqual(publish.input,f.request);assert.equal(f.calls[0].path,'/v2/chat/shared-summaries/receipt');
 }finally{f.close();}
});

test('conflicts and legacy journals with no original hash remain unretryable; retraction cleanup retains locator',async()=>{
 const f=await fixture();try{await f.seed();f.setState('conflict');await assert.rejects(f.bridge.reconcile(f.roomId,{retry:true}),/shared_summary_request_conflict/);assert.equal(f.published(),0);assert.ok(await f.stored());
  await f.seed({hash:false,payload:false,phase:'stopped-local'});assert.equal((await f.bridge.reconcile(f.roomId,{retry:true})).state,'unknown');assert.equal(f.published(),0);
  await f.seed();f.setState('pending');f.setCleanup(true);const first=await f.bridge.cancelPending(f.roomId);assert.equal(first.serverRetractionConfirmed,true);assert.equal(first.noticeCleanupPending,true);assert.equal((await f.stored()).phase,'retraction-pending');
  f.setAccess(false);assert.equal((await f.bridge.reconcile(f.roomId,{retry:true})).state,'retracted');assert.ok(await f.stored(),'incomplete archive cleanup is not erased from local continuity');assert.equal(f.published(),0);
  f.setCleanup(false);const final=await f.bridge.cancelPending(f.roomId);assert.equal(final.serverRetractionConfirmed,true);assert.equal(await f.stored(),null);
 }finally{f.close();}
});


