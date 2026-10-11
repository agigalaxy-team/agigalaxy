import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {privacyConsumerFixture} from '../../galaxy-official/test/privacy-consumer-continuity-workflow.mjs';
import {getSummaryRuntime,closeSummaryRuntime} from '../src/summary-runtime.mjs';

async function fixture(t){
 const f=await privacyConsumerFixture();t.after(()=>f.close());const bodies=new Map();
 // Signed HTTP, DB and current room permissions are real. Verified-account
 // registration and an external XMPP archive remain explicit contract doubles.
 f.services.chat.requireAccountWithin=async()=>{};f.services.chat.consumeInviteWithin=async()=>{};f.services.chat.markInviteRespondedWithin=async()=>{};
 f.services.chat.transport={available:true,project:async()=>{},send:async value=>{bodies.set(value.messageId,{archiveId:value.messageId,text:value.text,revision:1});return{archiveId:value.messageId};},
  read:async({ids})=>ids.map(id=>bodies.get(id)).filter(Boolean),erase:async({messageId})=>{bodies.delete(messageId);return{archiveDeleted:true};}};
 const {runtime:peer}=await f.makeOther(),peerId=(await peer.status()).identity.subjectId,created=await f.runtime.chat.create({title:'[合成] 个人笔记续接'},{confirmed:true}),roomId=created.roomId;
 const room=await f.runtime.api.call(`/v2/chat/rooms/${roomId}/read`,{}),decisionId=randomUUID();
 await f.runtime.chat.propose(roomId,{decisionId,expectedRevision:room.revision,action:'invite',targetSubjectId:peerId},{confirmed:true});await peer.api.call(`/v2/chat/rooms/${roomId}/accept`,{decisionId});
 const values=new Map(),store={read:async key=>structuredClone(values.get(key)),update:async(key,fn)=>{const next=fn(structuredClone(values.get(key)));values.set(key,structuredClone(next));return structuredClone(next);},close(){}},
  bridge=await getSummaryRuntime(f.runtime,f.original.subjectId,{openStore:async()=>store,now:f.now});t.after(()=>closeSummaryRuntime(f.runtime));
 const summaryId=randomUUID(),fragmentId=randomUUID(),content={generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'0',complete:false},
  fragments:[{id:fragmentId,kind:'personal-note',text:'仅这次合成明确选择的笔记',sourceRefs:[]}],keyMessageRefs:[]};
 await bridge.local.save({summaryId,roomId,endpoint:f.runtime.api.endpoint,expectedLocalRevision:0,content});
 const selection=async()=>({summaryId,expectedLocalRevision:1,fragmentIds:[fragmentId],keyMessageRefs:[],room:await f.runtime.api.call(`/v2/chat/rooms/${roomId}/read`,{})});
 return{...f,bridge,roomId,selection,summaryStore:store};
}
const writes=f=>f.requests.filter(row=>row.path==='/v2/chat/shared-summaries/publish').length;

test('automatic summary continuation retains the selected request, reads an accepted unknown result, and never resumes stopped or expired sharing',async t=>{
 const f=await fixture(t);let drop=true;
 f.wireHooks.before=path=>{if(drop&&path==='/v2/chat/shared-summaries/publish'){drop=false;throw Error('synthetic summary before delivery');}};
 await assert.rejects(f.bridge.share(await f.selection()),/synthetic summary before delivery/);
 const original=await f.runtime.getLocal('summary-share:'+f.roomId);assert.equal(original.retentionDays,90);
 const accepted=await f.bridge.resumePending(f.roomId);assert.equal(accepted.state,'published');assert.equal(accepted.shareId,original.shareId);
 const persisted=(await f.f.db.query('SELECT request_hash FROM room_shared_summaries WHERE share_id=$1',[original.shareId])).rows[0];assert.equal(persisted.request_hash,original.requestHash);
 let lose=true;f.wireHooks.after=(path,response)=>{if(lose&&path==='/v2/chat/shared-summaries/publish'){lose=false;assert.equal(response.status,200);throw Error('synthetic summary ACK lost');}};
 await assert.rejects(f.bridge.share(await f.selection()),/synthetic summary ACK lost/);let before=writes(f);assert.equal((await f.bridge.resumePending(f.roomId)).state,'published');assert.equal(writes(f),before);
 drop=true;await assert.rejects(f.bridge.share(await f.selection()));await f.bridge.cancelPending(f.roomId);before=writes(f);assert.equal((await f.bridge.resumePending(f.roomId)).reason,'stopped-local');assert.equal(writes(f),before);
 assert.equal((await f.runtime.getLocal('summary-share:'+f.roomId)).request,undefined);
 const stopped=await f.bridge.pending(f.roomId);assert.equal(stopped.canStartNewSelection,true);
 // The fresh explicit selection retires the old local slot but preserves its
 // exact body-free receipt. Nothing has to erase an unknown original manually.
 drop=true;await assert.rejects(f.bridge.share(await f.selection()));
 assert.notEqual((await f.bridge.pending(f.roomId)).shareId,stopped.shareId);
 const retained=(await f.bridge.previousShares(f.roomId)).find(row=>row.shareId===stopped.shareId);
 assert.equal(retained.requestHash,stopped.requestHash);assert.equal(retained.request,undefined);
 before=writes(f);assert.equal((await f.bridge.reconcilePrevious(f.roomId,stopped.shareId)).state,'absent');assert.equal(writes(f),before);
 const saved=await f.runtime.getLocal('summary-share:'+f.roomId);for(const pin of f.services.bindings.trustedKeys.values())pin.notAfter+=20000000;
 f.setTime(f.now()+91*86400);await f.runtime.connect({confirmed:true});before=writes(f);assert.equal((await f.bridge.resumePending(f.roomId)).reason,'authorization-expired');assert.equal(writes(f),before);
 assert.deepEqual((await f.runtime.getLocal('summary-share:'+f.roomId)).request,saved.request);
 assert.equal((await f.bridge.pending(f.roomId)).canStartNewSelection,true);
 const fresh=await f.bridge.share(await f.selection());assert.equal(fresh.state,'published');assert.notEqual(fresh.shareId,saved.shareId);
 assert.equal((await f.bridge.previousShares(f.roomId)).find(row=>row.shareId===saved.shareId).reason,'authorization-expired');
 before=writes(f);assert.equal((await f.bridge.reconcilePrevious(f.roomId,saved.shareId)).state,'absent');assert.equal(writes(f),before);
});

test('late accepted summary response preserves a new confirmed selection and the original independent receipt',async t=>{
 const f=await fixture(t),otherRuntime={...f.runtime},other=await getSummaryRuntime(otherRuntime,f.original.subjectId,{openStore:async()=>f.summaryStore,now:f.now});
 t.after(()=>closeSummaryRuntime(otherRuntime));let entered,release;const reached=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});let held=true;
 f.wireHooks.after=async(path,response)=>{if(held&&path==='/v2/chat/shared-summaries/publish'){held=false;assert.equal(response.status,200);entered();await barrier;}};
 const first=f.bridge.share(await f.selection());await reached;const original=await f.runtime.getLocal('summary-share:'+f.roomId);
 await other.cancelPending(f.roomId);
 let drop=true;f.wireHooks.before=path=>{if(drop&&path==='/v2/chat/shared-summaries/publish'){drop=false;throw Error('synthetic new selection before delivery');}};
 await assert.rejects(other.share(await f.selection()),/synthetic new selection before delivery/);const fresh=await f.runtime.getLocal('summary-share:'+f.roomId);
 assert.notEqual(fresh.shareId,original.shareId);release();assert.equal((await first).shareId,original.shareId);
 assert.equal((await f.runtime.getLocal('summary-share:'+f.roomId)).shareId,fresh.shareId);
 assert.equal((await other.reconcilePrevious(f.roomId,original.shareId)).state,'retracted');
 assert.equal((await other.resumePending(f.roomId)).shareId,fresh.shareId);
});

test('summary recovery cannot dispatch after same-subject connection changes during current room validation',async t=>{
 const f=await fixture(t);let drop=true;
 f.wireHooks.before=path=>{if(drop&&path==='/v2/chat/shared-summaries/publish'){drop=false;throw Error('synthetic summary before delivery');}};
 await assert.rejects(f.bridge.share(await f.selection()));const original=await f.runtime.getLocal('summary-share:'+f.roomId);let renew=true;
 f.wireHooks.after=async(path,response)=>{if(renew&&path===`/v2/chat/rooms/${f.roomId}/read`){renew=false;assert.equal(response.status,200);await f.runtime.connect({confirmed:true});}};
 const before=writes(f);await assert.rejects(f.bridge.resumePending(f.roomId),/summary_binding_changed|authority_changed|Authorization changed during request/);assert.equal(writes(f),before);
 assert.deepEqual((await f.runtime.getLocal('summary-share:'+f.roomId)).request,original.request);
});
