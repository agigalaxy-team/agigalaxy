import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {nativeWork,ag,cg} from './qualification-v2-workflow.mjs';
import {HonorService} from "../src/records/honor.mjs";
import {HonorV2Service} from "../src/records/honor-v2.mjs";
import {createApi} from '../src/http.mjs';
import {honorToolDefinitions} from '../src/adapters/mcp/personal/tools/honor-v2.mjs';
import {redactParticipationSnapshot} from '../src/operations/lifecycle-product-v2.mjs';
const scopes=['binding','consent','case-teaser','assistance','evidence','proof','capsules','history','data-export','data-delete'];
const ref=(kind,row,fields=['eventType','actorId'])=>({kind,id:row.id,eventVersion:1,payloadHash:row.payload_hash,fields});
const signPublication=(who,data)=>who.authorize(data,'contribution.publish',{objectId:data.id,...(data.kind==='publish'?{visibility:'Public',purpose:'public-profile'}:{})});
export async function verifyHonorV2Workflow(database=null,{testHttp=false,...options}={}){
  const f=await serviceFixture(scopes,database,{...options,syntheticCommunityQuota:false});
  try{
    const p=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false,syntheticCommunityQuota:false}),q=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false,syntheticCommunityQuota:false});
    const work=await nativeWork(f,p,{viewers:[q.actor.subjectId]}),taskId=work.open.taskId;
    const proposal={eventId:randomUUID(),kind:'propose',expectedTaskVersion:5,participationId:randomUUID(),subjectId:q.actor.subjectId,role:'verification',scopeVersion:1,agreedScope:'检查失败范围'};
    await f.assistance.proposeParticipation(f.actor,taskId,await ag(f,proposal,[q.actor.subjectId]));
    await f.assistance.submitParticipationEvent(q.actor,proposal.participationId,await ag(q,{eventId:randomUUID(),kind:'confirm',expectedParticipationVersion:1,scopeVersion:1},[f.actor.subjectId]));
    const intervention={...work.intervention,eventId:randomUUID(),actorId:q.actor.subjectId,participationId:proposal.participationId,expectedVersion:4,types:['verification'],description:'真实运行合成失败检查'};
    await f.cases.submitV2(q.actor,await cg(q,intervention,[f.actor.subjectId]));
    const result={...work.result,eventId:randomUUID(),actorId:q.actor.subjectId,participationId:proposal.participationId,expectedVersion:5,
      origin:{kind:'intervention',id:intervention.eventId,version:1},reportedOutcome:'failed',summary:'发现剩余失败，不宣称解决'};
    await f.cases.submitV2(q.actor,await cg(q,result,[f.actor.subjectId]));
    const delivery={eventId:randomUUID(),kind:'deliver',expectedParticipationVersion:2,resultRef:{id:result.eventId,version:1},interventionRefs:[{id:intervention.eventId,version:1}],evidenceRefs:[],summary:'核对失败范围'};
    await f.assistance.submitParticipationEvent(q.actor,proposal.participationId,await ag(q,delivery,[f.actor.subjectId]));
    await f.assistance.submitParticipationEvent(f.actor,proposal.participationId,await ag(f,{eventId:randomUUID(),kind:'accept',expectedParticipationVersion:3,deliveryId:delivery.eventId,summary:'接受检查，问题仍未解决'},[q.actor.subjectId]));
    const policy={id:'synthetic-contribution',version:'1',sourceProfile:'facts-v2',title:'合成规则',capabilityId:'software-debugging',communityId:'synthetic',
      kind:'open-contributor',members:[f.actor.subjectId,p.actor.subjectId,q.actor.subjectId],relatedPartyGroups:[[f.actor.subjectId,p.actor.subjectId]],notBefore:f.now-1,notAfter:f.now+1000,
      windowFrom:f.now-86400*90,windowUntil:f.now+1,minAcceptedCases:1,minProofs:0,repositories:[],rankingEnabled:false,privacyReview:'pending',minimumCohort:5,minimumCasesPerMember:3};
    const ciPolicy={...policy,id:'synthetic-ci-contribution',kind:'ci-backed-contributor',minProofs:1,repositories:[{owner:'synthetic',repository:'synthetic'}]};
    f.honor=new HonorService(f.access,f.assistance,f.proofs,[policy,ciPolicy]);
    f.honor.v2=new HonorV2Service(f.honor,{qualification:f.qualification.v2,sharing:f.contributionSharing});
    const query={ruleId:policy.id,ruleVersion:'1',subjectId:p.actor.subjectId,includeSimulation:true};
    let read=await f.honor.v2.query(p.actor,query);assert.equal(read.card.status,'insufficient-evidence');assert.equal(read.simulation.distinctCases,1);
    assert.equal(read.items.length,1);assert.equal(read.card.capabilityVerified,false);assert.equal(read.card.acceptedCases,0);
    assert.equal((await f.honor.v2.query(q.actor,{...query,subjectId:q.actor.subjectId})).simulation.distinctCases,1);
    assert.equal((await f.honor.v2.query(null,query)).items.length,0);
    const{includeSimulation:_includeSimulation,...oldQuery}=query;await assert.rejects(f.honor.query(p.actor,oldQuery),/unsupported_semantics/);
    const published=[];
    const caseRows=(await f.db.query('SELECT * FROM case_events WHERE case_id=$1',[work.cid])).rows;
    const taskRows=(await f.db.query('SELECT * FROM task_events WHERE task_id=$1',[taskId])).rows;
    const owned=await f.contributionSharing.ownedSources(p.actor,{kind:'case-event',parentId:work.cid});
    assert.ok(owned.items.length>0);assert.ok(owned.items.every(i=>caseRows.some(r=>r.id===i.source.id&&r.subject_id===p.actor.subjectId&&r.payload_hash===i.source.payloadHash)));
    assert.equal(JSON.stringify(owned).includes(work.result.summary),false);
    for(const who of [f,p,q]){
      const sourceRefs=[...caseRows.filter(r=>r.subject_id===who.actor.subjectId&&[work.r.eventId,work.intervention.eventId,work.result.eventId,intervention.eventId,result.eventId].includes(r.id))
        .map(r=>ref('case-event',r,r.kind==='result-recorded'?['eventType','actorId','reportedOutcome']:r.kind==='intervention'?['eventType','actorId','interventionTypes']:['eventType','actorId'])),
        ...taskRows.filter(r=>r.subject_id===who.actor.subjectId).map(r=>ref('task-event',r))];
      const data={id:randomUUID(),kind:'publish',purpose:'public-contribution-projections-only',purposes:['honor','requester-history'],sourceRefs,
        expiresAt:new Date((f.now+500)*1000).toISOString(),redactionConfirmed:true,publicationScope:'selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged'};
      const preview=await f.contributionSharing.preview(who.actor,{sourceRefs,purposes:data.purposes});
      assert.equal(JSON.stringify(preview.items.map(i=>i.projection)).includes(work.open.title),false);assert.equal(JSON.stringify(preview.items.map(i=>i.projection)).includes(work.cid),false);
      const signed=await signPublication(who,data);await f.contributionSharing.submit(who.actor,signed);await f.contributionSharing.submit(who.actor,signed);published.push({who,data,signed});
    }
    read=await f.honor.v2.query(null,query);assert.equal(read.items.length,1);assert.equal(read.simulation.distinctCases,1);assert.equal(read.card.status,'insufficient-evidence');
    for(const secret of [work.open.title,work.result.summary,work.cid,taskId,work.proposal.participationId])assert.equal(JSON.stringify(read).includes(secret),false);
    const verifier=await f.honor.v2.query(null,{...query,subjectId:q.actor.subjectId});assert.equal(verifier.simulation.distinctCases,1);
    assert.ok(verifier.items[0].projections.some(p=>p.projection.reportedOutcome==='failed'));
    assert.ok(verifier.items[0].projections.some(p=>p.projection.interventionTypes?.includes('verification')));
    await assert.rejects(f.assistance.getPublicTask(taskId),/not_found/);
    const plainSource=published[1].data.sourceRefs[0];const{fields:_fields,...source}=plainSource;
    const view=await f.contributionSharing.readProjection(null,{source,purpose:'honor'});assert.equal(view.payload,undefined);assert.equal(view.originalTextAccessGranted,false);
    assert.deepEqual((await f.contributionSharing.readProjection(null,{...view.ref,purpose:'honor'})).projection,view.projection);
    await assert.rejects(f.contributionSharing.preview(q.actor,{sourceRefs:[plainSource],purposes:['honor']}),/contribution_source_author_required/);
    await assert.rejects(f.contributionSharing.preview(p.actor,{sourceRefs:[{...plainSource,payloadHash:'0'.repeat(64)}],purposes:['honor']}),/contribution_source_unavailable/);
    assert.throws(()=>f.contributionSharing.preview(p.actor,{sourceRefs:[{...plainSource,fields:['eventType','actorId','workContext']}],purposes:['honor']}),/invalid_contribution_preview/);
    const normalNow=f.access.now;f.access.now=()=>f.now+501;
    try{await assert.rejects(f.contributionSharing.readProjection(null,{...view.ref,purpose:'honor'}),/contribution_source_unavailable/);}finally{f.access.now=normalNow;}
    const toolset=honorToolDefinitions(f,p.actor);assert.equal((await toolset.galaxy_honor_v2_query.run(query)).simulation.distinctCases,1);
    const takeout=await p.dataExport.create(p.actor,{id:randomUUID(),datasets:['contribution-publications']});
    assert.equal((await p.dataExport.page(p.actor,{id:takeout.id,dataset:'contribution-publications'})).items[0].payload_text,published[1].signed.payloadJson);
    assert.equal((await f.honor.v2.ranking({ruleId:policy.id,ruleVersion:policy.version})).status,'suppressed');
    const ciRead=await f.honor.v2.query(p.actor,{...query,ruleId:ciPolicy.id});
    assert.equal(ciRead.card.status,'insufficient-evidence');assert.equal(ciRead.ciEvidenceSupport.state,'awaiting-v2-verified-proof-link-adapter');
    const feedback={eventId:randomUUID(),kind:'requester-feedback',expectedParticipationVersion:4,descriptionClarity:'partly-clear',scopeMatched:true,note:'不应自动公开的反馈原文'};
    await assert.rejects(f.assistance.submitParticipationEvent(f.actor,work.proposal.participationId,await ag(f,feedback,[p.actor.subjectId])),/requester_feedback_not_available/);
    await f.assistance.submitParticipationEvent(p.actor,work.proposal.participationId,await ag(p,feedback,[f.actor.subjectId]));
    let history=await f.requesterHistoryV2.query(f.actor,{subjectId:f.actor.subjectId});assert.equal(history.items[0].counts.currentFeedback,1);assert.equal(history.globalScore,null);
    const publicHistory=await f.requesterHistoryV2.query(null,{subjectId:f.actor.subjectId});assert.equal(publicHistory.items[0].counts.currentFeedback,0);
    assert.equal(JSON.stringify(publicHistory).includes(feedback.note),false);assert.equal(JSON.stringify(publicHistory).includes(work.open.title),false);
    const correction={...feedback,eventId:randomUUID(),expectedParticipationVersion:5,supersedes:feedback.eventId,reason:'纠正描述清晰度',descriptionClarity:'clear'};
    await f.assistance.submitParticipationEvent(p.actor,work.proposal.participationId,await ag(p,correction,[f.actor.subjectId]));
    history=await f.requesterHistoryV2.facts(f.actor,{rootEventId:work.open.operationId,limit:20});assert.equal(history.counts.currentFeedback,1);
    assert.equal(history.facts.filter(f=>f.feedbackState==='superseded').length,1);
    const participation=(await f.db.query('SELECT snapshot FROM task_participations WHERE id=$1',[work.proposal.participationId])).rows[0].snapshot;
    const erased=redactParticipationSnapshot(participation,new Set([feedback.eventId,correction.eventId]),p.actor.subjectId);
    assert.equal(JSON.stringify(erased).includes(feedback.note),false);assert.equal(erased.feedback,null);
    const intent={version:1,id:randomUUID(),endpoint:f.access.endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,
      issuedAt:f.now,expiresAt:f.now+300,action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'};
    const pending=await f.deletion.submit(f.actor,await f.signForTest(JSON.stringify(intent),'galaxy-deletion-intent+jws'));
    assert.equal((await f.honor.v2.query(null,query)).items.length,0);
    const {scope:_,reason:__,takeout:___,...cancelBase}=intent;
    const cancel={...cancelBase,id:randomUUID(),action:'cancel',requestId:pending.id,expectedRevision:1};
    await f.deletion.submit(f.actor,await f.signForTest(JSON.stringify(cancel),'galaxy-deletion-intent+jws'));
    assert.equal((await f.honor.v2.query(null,query)).simulation.distinctCases,1);
    if(testHttp){const api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));try{
      const request=async(path,who,input,{method='POST',status=200}={})=>{
        const response=await fetch(`http://127.0.0.1:${api.address().port}${path}`,{method,headers:{'Content-Type':'application/json',...(who?{Authorization:`Bearer ${who.credential}`}:{})},
          ...(method==='POST'?{body:JSON.stringify(input)}:{})});const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;};
      assert.equal((await request('/v2/contributions/preview',p,{sourceRefs:[plainSource],purposes:['honor']})).items.length,1);
      assert.ok((await request('/v2/contributions/sources',p,{kind:'case-event',parentId:work.cid})).items.length>0);
      assert.equal((await request('/v2/contributions/publish',p,published[1].signed)).state,'published');
      assert.equal((await request('/v2/contributions/status',p,{publicationId:published[1].data.id})).state,'published');
      assert.equal((await request('/v2/contributions/read',null,{...view.ref,purpose:'honor'})).payload,undefined);
      assert.equal((await request('/v2/honor/query',null,query)).simulation.distinctCases,1);
      assert.equal((await request(`/v2/honor/${p.actor.subjectId}/${policy.id}/1`,null,null,{method:'GET'})).card.status,'insufficient-evidence');
      assert.equal((await request('/v2/honor/ranking',null,{ruleId:policy.id,ruleVersion:'1'})).status,'suppressed');
      assert.equal((await request('/v2/requester-history/query',f,{subjectId:f.actor.subjectId})).items[0].counts.currentFeedback,1);
      assert.equal((await request('/v2/requester-history/facts',f,{rootEventId:work.open.operationId})).globalScore,null);
      await request('/v2/honor/query',{credential:'intentionally-invalid-test-credential'},query,{status:401});
    }finally{await new Promise((resolve,reject)=>api.close(e=>e?reject(e):resolve()));}}
    const revoke={id:randomUUID(),kind:'revoke',publicationId:published[0].data.id,reason:'撤销原请求者的贡献投影许可'};
    await f.contributionSharing.submit(f.actor,await signPublication(f,revoke));
    assert.equal((await f.contributionSharing.status(f.actor,{publicationId:published[0].data.id})).state,'revoked');
    assert.equal((await f.contributionSharing.submit(f.actor,published[0].signed)).state,'revoked');
    assert.equal((await f.honor.v2.query(null,query)).items.length,0);
    assert.equal((await f.requesterHistoryV2.query(null,{subjectId:f.actor.subjectId})).items.length,0);
    assert.equal((await f.honor.v2.query(p.actor,query)).simulation.distinctCases,1);
    const base={id:randomUUID(),operationId:randomUUID(),expectedVersion:0,kind:'evidence',caseId:work.cid,reportedBy:q.actor.subjectId,
      taskId,participationId:proposal.participationId,participationScopeVersion:1,synthetic:true,evidenceType:'test-result',observedAt:new Date(f.now*1000).toISOString(),
      source:{originSystem:'synthetic-local-check',externalStableId:randomUUID(),contentVersion:'1',issuer:q.actor.subjectId,originalAt:new Date(f.now*1000).toISOString()},
      reportedSourceState:'available',summary:'仅用于本次交付关联'};
    await f.verificationRecords.submit(q.actor,await q.authorize(base,'evidence.submit',{objectId:base.operationId,viewers:[f.actor.subjectId]}));
    const more={...delivery,eventId:randomUUID(),expectedParticipationVersion:4,evidenceRefs:[base.id]};
    await f.assistance.submitParticipationEvent(q.actor,proposal.participationId,await ag(q,more,[f.actor.subjectId]));
    await f.assistance.submitParticipationEvent(f.actor,proposal.participationId,await ag(f,{eventId:randomUUID(),kind:'accept',expectedParticipationVersion:5,deliveryId:more.eventId,summary:'接受有限证据'},[q.actor.subjectId]));
    assert.equal((await f.honor.v2.query(q.actor,{...query,subjectId:q.actor.subjectId})).simulation.distinctCases,1);
    const evidenceCorrection={...base,operationId:randomUUID(),expectedVersion:1,reason:'补充第二版证据',summary:'精确的第二版'};
    await f.verificationRecords.submit(q.actor,await q.authorize(evidenceCorrection,'evidence.submit',{objectId:evidenceCorrection.operationId,viewers:[f.actor.subjectId]}));
    assert.equal((await f.honor.v2.query(q.actor,{...query,subjectId:q.actor.subjectId})).simulation.distinctCases,0);
    const exact={...more,eventId:randomUUID(),expectedParticipationVersion:6,evidenceRefs:[{id:base.id,version:2}]};
    await f.assistance.submitParticipationEvent(q.actor,proposal.participationId,await ag(q,exact,[f.actor.subjectId]));
    await f.assistance.submitParticipationEvent(f.actor,proposal.participationId,await ag(f,{eventId:randomUUID(),kind:'accept',expectedParticipationVersion:7,deliveryId:exact.eventId,summary:'接受第二版证据'},[q.actor.subjectId]));
    assert.equal((await f.honor.v2.query(q.actor,{...query,subjectId:q.actor.subjectId})).simulation.distinctCases,1);
    const evRevoke={id:base.id,operationId:randomUUID(),expectedVersion:2,kind:'revoke',objectType:'evidence',caseId:work.cid,reportedBy:q.actor.subjectId,synthetic:true,reason:'撤回本次证据'};
    await f.verificationRecords.submit(q.actor,await q.authorize(evRevoke,'evidence.submit',{objectId:evRevoke.operationId}));
    assert.equal((await f.honor.v2.query(q.actor,{...query,subjectId:q.actor.subjectId})).simulation.distinctCases,0);
    const corrected={...work.result,eventId:randomUUID(),expectedVersion:6,supersedes:{id:work.result.eventId,version:1},summary:'诊断结论已纠正，等待新交付确认'};
    await f.cases.submitV2(p.actor,await cg(p,corrected,[f.actor.subjectId]));
    assert.equal((await f.honor.v2.query(p.actor,query)).simulation.distinctCases,0);
    const sourceRow=caseRows.find(r=>r.id===source.id);await f.consents.revoke(p.actor,sourceRow.consent_id);
    await assert.rejects(f.contributionSharing.readProjection(null,{...view.ref,purpose:'honor'}),/consent_required/);
    if(!database){await f.db.query("UPDATE case_events SET payload_text='' WHERE id=$1",[source.id]);
      await assert.rejects(f.contributionSharing.readProjection(null,{...view.ref,purpose:'honor'}),/contribution_source_unavailable/);}
    return{multiRoleAcceptedWork:true,syntheticExcluded:true,selectedFieldPrivacy:true,feedbackCorrection:true,currentRevocation:true,sourceCorrection:true,pendingDeletion:true,m06Revocation:true};
  }finally{if(!database)await f.db.close();}
}
