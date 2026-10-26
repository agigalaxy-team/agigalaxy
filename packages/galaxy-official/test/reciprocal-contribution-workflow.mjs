import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { HonorService } from "../src/records/honor.mjs";
import { createApi } from '../src/http.mjs';

export async function verifyReciprocalContributionWorkflow(database=null,options={}){
  const scopes=['binding','consent','case-teaser','assistance','history'];
  const a=await serviceFixture(scopes,database,options),b=await serviceFixture(scopes,a.db,options),c=await serviceFixture(scopes,a.db,options);
  const rule={id:'reciprocity',version:'1',title:'Visible collaboration',kind:'open-contributor',capabilityId:'compiler',communityId:'fixture',
    members:[a.actor.subjectId,b.actor.subjectId,c.actor.subjectId],notBefore:a.now-1,notAfter:a.now+1000,
    windowFrom:a.now-100,windowUntil:a.now+100,minAcceptedCases:1,minProofs:0,repositories:[]};
  a.honor=new HonorService(a.access,a.assistance,a.proofs,[rule]);
  const api=createApi(a);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${api.address().port}/v1/honor/query`;
  async function query(viewer,subject=a){const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',
    ...(viewer?{Authorization:`Bearer ${viewer.credential}`}:{})},body:JSON.stringify({ruleId:rule.id,ruleVersion:'1',subjectId:subject.actor.subjectId})});
    assert.equal(response.status,200);return response.json();}
  async function collaboration(requester,provider){
    const viewers=[...new Set([requester.actor.subjectId,provider.actor.subjectId,a.actor.subjectId])];
    const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'Cycle fixture',summary:'Synthetic',source:{kind:'local',reference:randomUUID()},
      participants:[{subjectId:requester.actor.subjectId,role:'requester'}]};
    await a.cases.submit(requester.actor,await requester.authorize(root));
    const attempt={kind:'attempt',id:randomUUID(),caseId:root.id,expectedVersion:1,sequence:1,approach:'Inspect',configuration:{environment:'test',version:'1',tools:[]}};
    await a.cases.submit(requester.actor,await requester.authorize(attempt));
    const request={id:randomUUID(),caseId:root.id,title:'Help',problem:'Fixture',attemptedApproaches:[],scope:'Inspect',visibility:'Public',
      collaboration:'open-assistance',capabilityId:'compiler',enrollmentExpiresAt:a.now+800};
    await a.assistance.create(requester.actor,await requester.authorize(request,'assistance.publish',{visibility:'Public',purpose:'public-profile'}));
    let version=1;
    async function event(who,kind,fields={}){
      const value={id:randomUUID(),expectedVersion:version,kind,...fields};
      const grant=await who.authorize({assistanceId:request.id,event:value},'assistance.publish',{objectId:value.id,viewers});
      const receipt=await a.assistance.submit(who.actor,request.id,grant);version=receipt.version;return {value,grant};
    }
    const offer=await event(provider,'offer',{proposal:'Inspect',scope:'Inspect'});
    await event(requester,'select',{offerId:offer.value.id});await event(provider,'confirm');
    const delivered=await event(provider,'deliver',{attemptId:attempt.id,evidenceIds:[],summary:'Reported result'});
    const accepted=await event(requester,'accept',{deliveryId:delivered.value.id,summary:'Participant acceptance'});
    return {request,root,event,accepted};
  }
  try{
    const ab=await collaboration(a,b),bc=await collaboration(b,c),ca=await collaboration(c,a);
    const view=await query(a),flag=view.riskAssessment.flags.find(x=>x.code==='reciprocal-acceptance-cycle');
    assert.ok(flag);assert.equal(flag.edges.length,3);assert.equal(flag.fraudDetermined,false);assert.equal(flag.relationshipInferred,false);
    assert.equal(view.card.acceptedCases,1);assert.equal(view.card.status,'active');assert.equal(view.globalScore,null);
    assert.deepEqual(new Set(flag.assistanceIds),new Set([ab.request.id,bc.request.id,ca.request.id]));
    assert.ok(flag.eventIds.includes(bc.accepted.value.id));
    // b cannot see c -> a private events; no cycle or hidden event IDs leak.
    const restricted=await query(b,b);assert.ok(!restricted.riskAssessment.flags.some(x=>x.code==='reciprocal-acceptance-cycle'));
    assert.ok(!JSON.stringify(restricted.riskAssessment).includes(ca.accepted.value.id));
    assert.deepEqual((await query(null)).riskAssessment.flags,[]);
    await b.consents.revoke(b.actor,bc.accepted.grant.consentId);
    const revoked=await query(a);assert.ok(!revoked.riskAssessment.flags.some(x=>x.code==='reciprocal-acceptance-cycle'));
    assert.equal(revoked.card.acceptedCases,1);
    await ca.event(a,'dispute',{reason:'Review participant claim'});
    const disputed=await query(a);assert.equal(disputed.card.acceptedCases,0);
    assert.ok(disputed.riskAssessment.flags.some(x=>x.code==='accepted-work-under-review'));
    const stored=await a.db.query('SELECT id FROM assistance_events WHERE id=ANY($1::uuid[])',[[ab.accepted.value.id,bc.accepted.value.id,ca.accepted.value.id]]);
    assert.equal(stored.rows.length,3);
    return {cycleEdges:3,privateEdgeHidden:true,revocationRemovesCycle:true,sourceEventsPreserved:true};
  }finally{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!database)await a.db.close();}
}
