import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { digest } from '../src/shared/digest.mjs';
import { subjectResourceUsage } from '../src/infrastructure/resource-budgets.mjs';
const id = () => randomUUID();

export async function verifyContextV2({database=null,repositories,migrateDatabase=true,afterWorkflow,extraScopes=[],now=2000000000}={}) {
  const scopes=['binding','consent','assistance','context',...extraScopes];
  const options={repositories,migrateDatabase,now};
  const f=await serviceFixture(scopes,database,options), p=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false}),
    q=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false});
  const clock={now:f.now};
  for(const who of [f,p,q]){who.access.now=()=>clock.now;who.consents.now=()=>clock.now;}
  const api=createApi({...f,rateLimit:1000});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${api.address().port}`;
  async function http(path,who,body,status=200){
    const response=await fetch(endpoint+path,{method:body===undefined?'GET':'POST',headers:{...(who?{Authorization:`Bearer ${who.credential}`}:{ }),
      ...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;
  }
  try {
    const task={operationId:id(),taskId:id(),caseId:null,intent:'proactive-review',workContext:{goal:'Review parser',currentSituation:'Useful without a failure history',attemptRefs:[]},
      title:'Two different people',summary:'Selected diagnosis and independent review',visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+5};
    await f.assistance.createTask(f.actor,await f.authorize(task,'assistance.publish',{objectId:task.operationId,viewers:[p.actor.subjectId,q.actor.subjectId]}));
    async function propose(who,role){
      const current=await f.assistance.getTask(f.actor,task.taskId), participationId=id();
      const event={eventId:id(),expectedTaskVersion:current.version,kind:'propose',participationId,subjectId:who.actor.subjectId,role,scopeVersion:1,agreedScope:`Only ${role}`};
      await f.assistance.proposeParticipation(f.actor,task.taskId,await f.authorize(event,'assistance.publish',{objectId:event.eventId,viewers:[who.actor.subjectId]}));
      const confirm={eventId:id(),expectedParticipationVersion:1,kind:'confirm',scopeVersion:1};
      await f.assistance.submitParticipationEvent(who.actor,participationId,await who.authorize(confirm,'assistance.publish',{objectId:confirm.eventId,viewers:[f.actor.subjectId]}));
      return {participationId,participantId:who.actor.subjectId,scopeVersion:1,scopeEventId:event.eventId};
    }
    const a=await propose(p,'diagnosis'), b=await propose(q,'verification');
    const grant=(participation,text,expiresAt=f.now+1000)=>({schemaVersion:2,id:id(),taskId:task.taskId,...participation,expiresAt,
      materials:[{id:id(),label:'Selected excerpt',mediaType:'text/plain',content:text}]});
    const signGrant=payload=>f.authorize(payload,'context.grant',{viewers:[payload.participantId]});
    async function event(who,grantId,kind,overrides={}){
      const {metadata}=await http(`/v2/context/${grantId}/metadata`,who);
      const payload={schemaVersion:2,id:id(),grantId,taskId:metadata.taskId,participationId:metadata.participationId,
        scopeVersion:metadata.scopeVersion,materialsHash:metadata.materialsHash,kind,...overrides};
      return {payload,authorization:await who.authorize(payload,'context.grant',{viewers:[kind==='revoke'?metadata.participantId:metadata.ownerId]})};
    }
    const ga=grant(a,'诊断材料：只有 A 可以读取。'), gb=grant(b,'复核材料：只有 B 可以读取。');
    const authA=await signGrant(ga),authB=await signGrant(gb);
    const created=await http('/v2/context/grants',f,authA);assert.equal(created.contextAccessGranted,false);
    const parallel=await Promise.all([http('/v2/context/grants',f,authB),http('/v2/context/grants',f,authB)]);
    assert.equal(parallel.filter(r=>r.state==='recorded-awaiting-recipient-acceptance').length,1);
    const pending=await http(`/v2/context/${ga.id}`,p);assert.equal(pending.state,'pending');assert.equal(pending.contextAccessGranted,false);
    assert.equal(pending.materials[0].content,undefined);assert.equal(pending.metadata.materialsHash,digest(JSON.stringify(ga.materials)));
    assert.equal((await http('/v2/context/query',p,{taskId:task.taskId})).items.length,1);
    await http(`/v2/context/${gb.id}`,p,undefined,404);
    await http(`/v2/context/${ga.id}`,null,undefined,401);
    await http(`/v2/context/${ga.id}`,{credential:'invalid-credential'},undefined,401);
    const bad=await event(p,ga.id,'accept',{materialsHash:'0'.repeat(64)});
    await http(`/v2/context/${ga.id}/events`,p,bad.authorization,403);
    const accepted=await event(p,ga.id,'accept');
    await http(`/v2/context/${ga.id}/events`,p,accepted.authorization);
    const replay=await http(`/v2/context/${ga.id}/events`,p,accepted.authorization);assert.equal(replay.state,'acknowledged');
    assert.equal((await http(`/v2/context/${ga.id}`,p)).materials[0].content,ga.materials[0].content);
    assert.equal((await http(`/v2/context/${ga.id}/metadata`,p)).materials[0].content,undefined);
    const receiptInput={grantId:ga.id,eventId:accepted.payload.id,payloadHash:digest(accepted.authorization.payloadJson)};
    assert.equal((await http('/v2/context/receipt',p,receiptInput)).state,'acknowledged');
    assert.equal((await http('/v2/context/receipt',q,receiptInput)).state,'absent');
    assert.equal((await http('/v2/context/receipt',p,{...receiptInput,payloadHash:'0'.repeat(64)})).state,'conflict');
    const declined=await event(q,gb.id,'decline');await http(`/v2/context/${gb.id}/events`,q,declined.authorization);
    const declinedView=await http(`/v2/context/${gb.id}`,q);assert.equal(declinedView.state,'declined');assert.equal(declinedView.contextAccessGranted,false);
    assert.equal(declinedView.materials.length,0);
    // Recruitment expiry is unrelated to the already confirmed work/materials.
    clock.now=f.now+6;assert.equal((await http(`/v2/context/${ga.id}`,p)).contextAccessGranted,true);
    const pa=(await f.assistance.getTask(f.actor,task.taskId)).participations.find(x=>x.participationId===a.participationId);
    const change={eventId:id(),expectedParticipationVersion:pa.version,kind:'propose-scope',scopeVersion:2,agreedScope:'Different logs',reason:'Different diagnosis'};
    await f.assistance.submitParticipationEvent(f.actor,a.participationId,await f.authorize(change,'assistance.publish',{objectId:change.eventId,viewers:[p.actor.subjectId]}));
    assert.equal((await http(`/v2/context/${ga.id}`,p)).contextAccessGranted,true,'pending scope proposal does not grant new or cancel old scope');
    const acceptScope={eventId:id(),expectedParticipationVersion:pa.version+1,kind:'confirm-scope',proposalId:change.eventId};
    await f.assistance.submitParticipationEvent(p.actor,a.participationId,await p.authorize(acceptScope,'assistance.publish',{objectId:acceptScope.eventId,viewers:[f.actor.subjectId]}));
    const changed=await http(`/v2/context/${ga.id}`,p);assert.equal(changed.state,'scope-changed');assert.equal(changed.materials.length,0);
    const revocation=await event(f,ga.id,'revoke');await http(`/v2/context/${ga.id}/events`,f,revocation.authorization);
    assert.equal((await http(`/v2/context/${ga.id}`,p)).state,'revoked');
    const currentA={...a,scopeVersion:2,scopeEventId:change.eventId};
    const fresh=grant(currentA,'New explicitly chosen material',f.now+20), freshAuth=await signGrant(fresh);
    await http('/v2/context/grants',f,freshAuth);
    const freshAccept=await event(p,fresh.id,'accept');await http(`/v2/context/${fresh.id}/events`,p,freshAccept.authorization);
    const gq=grant(b,'B new material'),gqAuth=await signGrant(gq);await http('/v2/context/grants',f,gqAuth);
    const qAccept=await event(q,gq.id,'accept');await http(`/v2/context/${gq.id}/events`,q,qAccept.authorization);
    await f.consents.revoke(f.actor,gqAuth.consentId);
    assert.equal((await http(`/v2/context/${gq.id}`,q)).state,'source-permission-unavailable');
    assert.equal((await http(`/v2/context/${fresh.id}`,p)).contextAccessGranted,true);
    clock.now=f.now+21;assert.equal((await http(`/v2/context/${fresh.id}`,p)).state,'expired');
    const blocked=grant(currentA,'Not accepted after storage budget exhausted'),blockedAuth=await signGrant(blocked);
    const oldPolicy=f.access.resourceBudgetPolicy;
    f.access.resourceBudgetPolicy={...oldPolicy,maxPayloadBytesPerSubject:0};
    const before=await subjectResourceUsage(f.db,f.actor.subjectId,clock.now);
    await http('/v2/context/grants',f,blockedAuth,409);
    assert.equal((await f.db.query('SELECT id FROM context_grants_v2 WHERE id=$1',[blocked.id])).rows.length,0);
    assert.equal((await subjectResourceUsage(f.db,f.actor.subjectId,clock.now)).payloadBytes,before.payloadBytes);
    f.access.resourceBudgetPolicy=oldPolicy;
    assert.equal((await f.db.query("SELECT count(*)::int n FROM audit_events WHERE action='context.decline' AND object_id=$1",[declined.payload.id])).rows[0].n,1);
    const audit=JSON.stringify((await f.db.query("SELECT * FROM audit_events WHERE scope='context'")).rows);
    assert.ok(!audit.includes('诊断材料'));assert.ok(!audit.includes('复核材料'));
    if(afterWorkflow)await afterWorkflow({f,p,q,clock,http,task,ga,gb,fresh,accepted,freshAccept,localEndpoint:endpoint});
    return {twoRecipientsIsolated:true,exactHashAcceptance:true,declineAndRevocation:true,scopeChange:true,
      enrollmentExpirySeparate:true,materialsExpiry:true,preciseReceipts:true,resourceRollback:true,realHttp:true};
  } finally {api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!database)await f.db.close();}
}
