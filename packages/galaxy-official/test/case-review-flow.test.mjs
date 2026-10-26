import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { createCaseReviewFlow } from "../src/clients/flows/case-review.mjs";

test('Case review flow verifies ownership, exact source version and transitions before signing and cancels during Consent',async()=>{
  const scopes=['binding','consent','case-teaser','history'],f=await serviceFixture(scopes),other=await serviceFixture(scopes,f.db,{migrateDatabase:false});
  const api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`,endpoint=f.access.endpoint,memories=[];
  let onConsent=()=>{},signatures=0;
  const exchange=async(url,input,method)=>{
    const response=await fetch(origin+new URL(url).pathname,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.credential}`},...(method==='POST'?{body:input.bodyJson}:{}),signal:input.signal});
    const data=await response.json();if(response.status!==200)throw new Error(data.error);
    if(url.endsWith('/consents'))onConsent();return data;
  };
  const send=(url,input)=>exchange(url,input,'POST'),read=(url,input)=>exchange(url,input,'GET');
  function create(who){const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});memories.push(sessions);
    sessions.adopt({endpoint,subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>who.credential});
    const flow=createCaseReviewFlow({endpoint,sessions,now:()=>f.now,consentSend:send,caseSend:send,caseRead:read,signIntent:(payload,typ)=>{
      assert.equal(flow.isSigningIntent(payload),true);signatures++;return who.signForTest(payload,typ);
    }});return flow;}
  try{
    const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'Review flow',summary:'Original',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(root));
    const flow=create(f),foreign=create(other),input={caseId:root.id,expectedVersion:1,targetEventId:root.id,reason:'Reason',summary:'Clarification'};
    await assert.rejects(foreign.prepare(input));
    await assert.rejects(flow.prepare({...input,targetEventId:randomUUID()}),/target missing/);
    await assert.rejects(flow.prepare({...input,review:{type:'dispute',state:'resolved'}}),/review_open_required/);
    const preview=await flow.prepare(input);assert.equal(signatures,0);
    await assert.rejects(flow.execute(preview,'wrong'),/Exact Case review/);assert.equal(signatures,0);
    onConsent=()=>flow.cancel(preview);await assert.rejects(flow.execute(preview,preview.confirmation));
    assert.equal((await f.cases.get(f.actor,root.id)).version,1);assert.equal(flow.isSigningIntent(preview.intentJson),false);
    onConsent=()=>{};const next=await flow.prepare(input);const receipt=await flow.execute(next,next.confirmation);assert.equal(receipt.version,2);
    assert.equal((await f.cases.get(f.actor,root.id)).events[0].summary,'Original');
  }finally{memories.forEach(memory=>memory.close());api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}
});
