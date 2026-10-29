import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createModerationReviewClient} from "../src/features/governance/moderation-review-client.mjs";
function fixture(){const subjectId='GUID'+'A'.repeat(28),moderator='GUID'+'B'.repeat(28),reportId=randomUUID(),endpoint='https://official.example.org',store=new Map(),calls=[],state={generation:1,bindingId:randomUUID(),version:2,now:2000000000,loseAck:true,receipt:'acknowledged',consent:'acknowledged',denyRead:false,changeOnSave:false,failConsent:false,failSign:false};let accepted;
 const api={endpoint,snapshot:()=>({subjectId,bindingId:state.bindingId,generation:state.generation}),prepareAuthorization:async(payloadJson,options)=>{calls.push('sign');if(state.failSign)throw Error('pre-signing interruption');return{version:1,endpoint,payloadJson,signedIntent:'synthetic-signed-envelope',intent:{id:randomUUID(),subjectId,bindingId:state.bindingId,endpoint,issuedAt:state.now,payloadHash:createHash('sha256').update(payloadJson).digest('hex'),purpose:'operational',recipient:endpoint,fields:Object.keys(JSON.parse(payloadJson)),...options}};},submitAuthorization:async a=>{calls.push('authorize');if(state.failConsent)throw Error('pre-consent interruption');state.consent='acknowledged';return{consentId:a.intent.id,payloadJson:a.payloadJson};},reconcileAuthorization:async a=>{calls.push('consent-receipt');return state.consent==='absent'?{state:'absent',consentId:a.intent.id}:{state:'acknowledged',consentId:a.intent.id,payloadJson:a.payloadJson};},call:async(path,input)=>{calls.push(path);
  if(path.endsWith('/config'))return{moderatorIds:[moderator]};if(path.endsWith('/read')){if(state.denyRead)throw Error('not_found');return{reportId,version:state.version,events:[],canSupplement:true,canAppeal:true,reporterId:subjectId,participantIds:[]};}
  if(path.endsWith('/events')){const p=JSON.parse(input.payloadJson);accepted={reportId,eventId:p.id,version:p.expectedVersion+1};if(state.loseAck)throw Error('network_unknown');return accepted;}
  if(path.endsWith('/receipt')){if(state.receipt==='unknown')throw Error('offline');return{reportId,...input,state:state.receipt,authority:'accepted-operation-only',currentAccessGranted:false,contentReturned:false,independenceVerified:false,capabilityVerified:false,...(state.receipt==='acknowledged'?{receipt:accepted}:{})};}throw Error('unexpected '+path);
 }};
 const runtime={api,status:async()=>({identity:{subjectId}}),getLocal:async key=>structuredClone(store.get(key)),putLocal:async(key,value)=>{store.set(key,structuredClone(value));if(state.changeOnSave){state.changeOnSave=false;state.generation++;}}};
 return{client:createModerationReviewClient({runtime,subjectId,now:()=>state.now}),runtime,state,calls,store,reportId,subjectId,input:{reportId,kind:'supplement',summary:'Only the exact original statement.'}};
}
test('moderation browser preview writes nothing and lost ACK uses original byte hash without current body reads',async()=>{const f=fixture(),p=await f.client.prepare(f.input);assert.equal(f.store.size,0);assert.equal(f.calls.includes('sign'),false);assert.equal(p.payloadHash,createHash('sha256').update(p.payloadJson).digest('hex'));await assert.rejects(f.client.execute(p,{confirmed:true}),/network_unknown/);const saved=await f.client.pending(f.reportId);assert.equal(saved.payloadHash,p.payloadHash);f.state.denyRead=true;f.calls.length=0;const r=await f.client.resumePending(f.reportId);assert.equal(r.state,'acknowledged');assert.deepEqual(f.calls,['/v1/moderation/reports/'+f.reportId+'/receipt']);assert.equal(await f.client.pending(f.reportId),null);assert.equal((await f.client.receipt({reportId:f.reportId,eventId:p.eventId,payloadHash:p.payloadHash})).state,'acknowledged');});
test('same identity new binding or generation cannot execute old preview, nor continue after an IDB generation switch',async()=>{for(const change of ['bindingId','generation']){const f=fixture(),p=await f.client.prepare(f.input);f.state[change]=change==='bindingId'?randomUUID():2;await assert.rejects(f.client.execute(p,{confirmed:true}),/当前连接/);assert.equal(f.store.size,0);assert.equal(f.calls.includes('sign'),false);}const f=fixture(),p=await f.client.prepare(f.input);f.state.changeOnSave=true;await assert.rejects(f.client.execute(p,{confirmed:true}),/身份或连接已变化/);assert.equal(f.calls.includes('sign'),false);assert.equal((await f.client.pending(f.reportId)).eventId,p.eventId);});
test('unknown receipt and stale absent retry retain original operation and never publish again',async()=>{const f=fixture(),p=await f.client.prepare(f.input);await assert.rejects(f.client.execute(p,{confirmed:true}));f.calls.length=0;f.state.receipt='unknown';await assert.rejects(f.client.retry(f.reportId,{confirmed:true}),/offline/);assert.equal(f.calls.some(p=>p.endsWith('/events')||p.endsWith('/read')),false);f.state.receipt='absent';f.state.version++;await assert.rejects(f.client.retry(f.reportId,{confirmed:true}),/当前记录已变化/);assert.equal(f.calls.filter(p=>p.endsWith('/events')).length,0);assert.equal((await f.client.pending(f.reportId)).eventId,p.eventId);});
test('confirmed exact retry reuses original IDs and authorization; nested preview edits are rejected',async()=>{const tampered=fixture(),preview=await tampered.client.prepare(tampered.input);preview.viewers.push('GUID'+'C'.repeat(28));await assert.rejects(tampered.client.execute(preview,{confirmed:true}),/预览/);assert.equal(tampered.store.size,0);const f=fixture(),p=await f.client.prepare(f.input);await assert.rejects(f.client.execute(p,{confirmed:true}));f.state.receipt='absent';f.state.loseAck=false;const r=await f.client.retry(f.reportId,{confirmed:true});assert.equal(r.receipt.eventId,p.eventId);assert.equal(f.calls.filter(v=>v==='sign').length,1);assert.equal(f.calls.filter(v=>v.endsWith('/events')).length,2);});

test('moderation auto continuation renews only same-binding transport and fixed original choice; binding change needs the original preview',async()=>{
 for(const stage of ['same-binding-aged','first-signature','accepted-consent-new-binding','absent-consent-new-binding','expired']){
  const f=fixture(),preview=await f.client.prepare(f.input);f.state.receipt='absent';f.state.consent='absent';f.state.failConsent=true;
  if(stage==='first-signature')f.state.failSign=true;
  await assert.rejects(f.client.execute(preview,{confirmed:true}),/interruption/);const original=await f.client.pending(f.reportId);
  f.state.failSign=false;f.state.failConsent=false;f.state.loseAck=false;
  if(stage==='same-binding-aged')f.state.now+=301;
  if(stage==='expired')f.state.now=original.expiresAt;
  if(stage.endsWith('new-binding'))f.state.bindingId=randomUUID();
  if(stage==='accepted-consent-new-binding')f.state.consent='acknowledged';
  f.calls.length=0;const result=await f.client.resumePending(f.reportId);
  if(stage==='absent-consent-new-binding'||stage==='expired'){
   assert.equal(result.reason,stage==='expired'?'authorization-expired':'original-binding-changed');
   assert.equal(f.calls.some(value=>value==='sign'||value==='authorize'||value.endsWith('/events')),false);
   const renewed=await f.client.reviewAuthorization(f.reportId);assert.equal(renewed.payloadHash,original.payloadHash);assert.deepEqual(renewed.payload,original.payload);
   if(stage!=='expired')assert.equal(renewed.expiresAt,original.expiresAt);
   f.calls.length=0;assert.equal((await f.client.reauthorize(renewed,{confirmed:true})).state,'acknowledged');
   assert.equal(f.calls.filter(value=>value==='sign').length,1);
  }else{
   assert.equal(result.state,'acknowledged');assert.equal(result.receipt.eventId,original.eventId);
   assert.equal(f.calls.filter(value=>value==='sign').length,stage==='accepted-consent-new-binding'?0:1);
  }
  assert.equal(f.calls.filter(value=>value.endsWith('/events')).length,1);
 }
});

test('moderation stopped journal frees editing, retains only public locators and requires one explicit original continuation',async()=>{
 const f=fixture(),preview=await f.client.prepare(f.input);f.state.receipt='absent';f.state.consent='absent';f.state.failConsent=true;
 await assert.rejects(f.client.execute(preview,{confirmed:true}));const old=await f.client.pending(f.reportId);
 const stopped=await f.client.stop(f.reportId,{confirmed:true});assert.equal(stopped.serverCancellationConfirmed,false);assert.equal(await f.client.pending(f.reportId),null);
 const locators=await f.client.stopped(f.reportId);assert.equal(locators.length,1);assert.equal(locators[0].canContinue,true);assert.equal(JSON.stringify(locators).includes(f.input.summary),false);
 await f.client.prepare({...f.input,summary:'A new unsubmitted choice can be edited.'});
 f.calls.length=0;assert.equal((await f.client.resumePending(f.reportId)).state,'none');assert.equal(f.calls.length,0);
 await assert.rejects(f.client.continueStopped({reportId:f.reportId,eventId:old.eventId,payloadHash:old.payloadHash}),/明确/);
 f.state.failConsent=false;f.state.loseAck=false;f.calls.length=0;
 const continued=await f.client.continueStopped({reportId:f.reportId,eventId:old.eventId,payloadHash:old.payloadHash},{confirmed:true});
 assert.equal(continued.receipt.eventId,old.eventId);assert.equal(f.calls.filter(value=>value==='sign').length,0);
 assert.equal(f.calls.filter(value=>value.endsWith('/events')).length,1);assert.deepEqual(await f.client.stopped(f.reportId),[]);
});

test('moderation late private read and a queued old confirmation are fenced before signing',async()=>{
 const f=fixture(),baseCall=f.runtime.api.call;let resolve,blocked=false;
 f.runtime.api.call=async(path,input)=>{const result=await baseCall(path,input);if(path.endsWith('/read')&&!blocked){blocked=true;await new Promise(done=>{resolve=done;});}return result;};
 const reading=f.client.get(f.reportId);while(!resolve)await new Promise(done=>setImmediate(done));f.state.bindingId=randomUUID();resolve();
 await assert.rejects(reading,/身份或连接/);
 const current=createModerationReviewClient({runtime:f.runtime,subjectId:f.subjectId,now:()=>f.state.now}),preview=await current.prepare(f.input);
 let release,entered;const ready=new Promise(done=>{entered=done;}),locked=createModerationReviewClient({runtime:f.runtime,subjectId:f.subjectId,now:()=>f.state.now,
  locks:{request:async(_key,_options,action)=>{entered();await new Promise(done=>{release=done;});return action();}}});
 const waiting=locked.resumePending(f.reportId);await ready;f.state.generation++;release();await assert.rejects(waiting,/身份或连接/);
 assert.equal(f.calls.includes('sign'),false);assert.equal(preview.payload.summary,f.input.summary);
});

test('legacy stopped bytes remain independently queryable and do not block a new unsent choice',async()=>{
 const f=fixture(),preview=await f.client.prepare(f.input);f.state.receipt='absent';f.state.consent='absent';f.state.failConsent=true;
 await assert.rejects(f.client.execute(preview,{confirmed:true}));const old=await f.client.pending(f.reportId);
 f.store.set('moderation-review:'+f.reportId,{...old,phase:'stopped-local'});
 const locators=await f.client.stopped(f.reportId);assert.equal(locators[0].eventId,old.eventId);assert.equal(locators[0].canContinue,true);
 assert.equal(JSON.stringify(locators).includes(f.input.summary),false);f.calls.length=0;
 await f.client.prepare({...f.input,summary:'A separate unsent edited explanation.'});
 assert.equal(await f.client.pending(f.reportId),null);assert.equal((await f.client.stopped(f.reportId))[0].eventId,old.eventId);
 assert.equal(f.calls.some(value=>value==='sign'||value==='authorize'||value.endsWith('/events')),false);
 f.state.failConsent=false;f.state.loseAck=false;
 const result=await f.client.continueStopped({reportId:f.reportId,eventId:old.eventId,payloadHash:old.payloadHash},{confirmed:true});
 assert.equal(result.receipt.eventId,old.eventId);assert.deepEqual(await f.client.stopped(f.reportId),[]);
});
