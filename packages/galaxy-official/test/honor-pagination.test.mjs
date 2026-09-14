import test from 'node:test';
import assert from 'node:assert/strict';
import { paginateHonor } from '../src/domain/honor-pagination.mjs';
import { createHonorClient } from '../src/honor-client.mjs';
const id=i=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const subjectId=`GUID${'A'.repeat(28)}`,query={ruleId:'rule',ruleVersion:'1',subjectId};
function fixture(){
  const contributions=Array.from({length:45},(_,i)=>({assistanceId:id(i+1),sourceEvents:Array.from({length:27},(_,j)=>({eventId:id(100+j)})),proofs:[],observations:[],revisionIds:[]}));
  return {card:{subjectId,rule:{id:'rule',version:'1'},sourceFingerprint:'a'.repeat(64),capabilityVerified:false,
    evidence:contributions.map(item=>({assistanceId:item.assistanceId,sourceEventIds:item.sourceEvents.map(e=>e.eventId)})),proofs:Array.from({length:23},(_,i)=>({proofId:id(200+i)}))},
    contributions,riskAssessment:{flags:[{code:'cycle',caseIds:Array.from({length:450},(_,i)=>id(1000+i)),edges:[{assistanceId:id(1),acceptanceEventIds:Array.from({length:25},(_,i)=>id(2000+i))}]}]}};
}
test('Honor pagination preserves all summaries and exposes every nested reference within bounded pages',()=>{
  const view=fixture(),page=paginateHonor(view,query);
  assert.equal(page.contributions.length,8);assert.equal(page.card.evidenceCount,45);assert.equal(page.card.proofCount,23);
  assert.equal(page.card.evidenceComplete,false);assert.equal(page.riskAssessment.flags[0].referencesComplete,false);
  const seen=[];let after;
  do{const result=paginateHonor(view,{...query,limit:20,...(after?{after}:{})});seen.push(...result.contributions.map(x=>x.assistanceId));after=result.pagination.contributions.nextAfter;}while(after);
  assert.deepEqual(seen,view.contributions.map(x=>x.assistanceId));
  const references=[];let riskReferenceAfter=0;
  do{const result=paginateHonor(view,{...query,limit:20,riskIndex:0,riskReferenceAfter});references.push(...result.riskDetail.items);riskReferenceAfter=result.riskDetail.nextAfter;}while(riskReferenceAfter!==null);
  assert.equal(references.filter(x=>x.kind==='caseIds').length,450);assert.equal(references.filter(x=>x.kind==='edgeAcceptanceEvents').length,25);
  assert.equal(paginateHonor(view,{...query,sourceId:id(1),sourceAfter:20}).sourceDetail.items.length,7);
  assert.throws(()=>paginateHonor(view,{...query,expectedFingerprint:'b'.repeat(64)}),/projection_changed/);
  assert.throws(()=>paginateHonor(view,{...query,sourceId:id(999)}),/source_unavailable/);
});
test('Honor client validates page identity and cursor progress without clearing a session for changed sources',async()=>{
  const view=fixture();let transform=x=>x;
  const client=createHonorClient({endpoint:'https://honor.example.org',send:async(_url,input)=>transform(paginateHonor(view,JSON.parse(input.bodyJson)))});
  const first=await client.publicQuery(query);const next={...query,after:first.pagination.contributions.nextAfter,expectedFingerprint:first.card.sourceFingerprint};
  assert.equal((await client.publicQuery(next)).contributions[0].assistanceId,id(9));
  transform=result=>({...result,pagination:{...result.pagination,contributions:{...result.pagination.contributions,nextAfter:id(1)}}});
  await assert.rejects(client.publicQuery(next),/Invalid Honor response/);
  transform=result=>({...result,sourceDetail:{...result.sourceDetail,assistanceId:id(99)}});
  await assert.rejects(client.publicQuery({...query,sourceId:id(1)}),/Invalid Honor response/);
  let invalidated=false;const sessions={readAuthorization:async()=>({scopes:['history'],subjectId}),isAuthorizationCurrent:async()=>true,matchesAuthorization:()=>true,invalidateAuthorization(){invalidated=true;}};
  const authenticated=createHonorClient({endpoint:'https://honor.example.org',sessions,send:async()=>{throw Object.assign(new Error('Changed'),{status:409});}});
  await assert.rejects(authenticated.query(query),/Changed/);assert.equal(invalidated,false);
});
