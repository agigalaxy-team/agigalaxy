import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {executeDeletion} from '../src/operations/deletion-execute.mjs';
import {approveFixtureDeletion} from './deletion-execute-workflow.mjs';

async function fixture({reportId=randomUUID(),extraReporterCount=0}={}){
  const scopes=['binding','consent','case-teaser','moderation','notifications','data-delete'];
  const f=await serviceFixture(scopes);let api;
  try{
    const reporter=await serviceFixture(scopes,f.db,{migrateDatabase:false}),moderator=await serviceFixture(scopes,f.db,{migrateDatabase:false}),
      verifier=await serviceFixture(scopes,f.db,{migrateDatabase:false}),otherModerator=await serviceFixture(scopes,f.db,{migrateDatabase:false}),
      secondVerifier=await serviceFixture(scopes,f.db,{migrateDatabase:false}),outsider=await serviceFixture(scopes,f.db,{migrateDatabase:false});
    const extraReporters=[];for(let index=0;index<extraReporterCount;index++)extraReporters.push(await serviceFixture(scopes,f.db,{migrateDatabase:false}));
    f.moderation.moderatorIds=[moderator.actor.subjectId,otherModerator.actor.subjectId];
    const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'隔离删除与验证参与测试',summary:'其他作者的参与事实应保留',
      source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(root,'case.teaser.publish',{viewers:[reporter.actor.subjectId,moderator.actor.subjectId,verifier.actor.subjectId,otherModerator.actor.subjectId,secondVerifier.actor.subjectId,...extraReporters.map(person=>person.actor.subjectId)]}));
    const report={id:reportId,caseId:root.id,caseVersion:1,targetEventId:root.id,category:'other',summary:'测试报告，不是真实举报'};
    await f.moderation.report(reporter.actor,await reporter.authorize(report,'moderation.publish',{viewers:f.moderation.moderatorIds}));
    const invite={id:randomUUID(),reportId:report.id,expectedVersion:1,kind:'invite-verifier',summary:'原准确邀请',
      verifierId:verifier.actor.subjectId,target:{caseId:root.id,caseVersion:1,targetEventId:root.id},scope:'仅隔离测试范围',expiresAt:f.now+100};
    const invitationGrant=await moderator.authorize(invite,'moderation.publish',{viewers:[f.actor.subjectId,reporter.actor.subjectId,verifier.actor.subjectId,otherModerator.actor.subjectId]});
    await f.moderation.event(moderator.actor,report.id,invitationGrant);
    const accept={id:randomUUID(),reportId:report.id,expectedVersion:2,kind:'accept-verifier',invitationId:invite.id,summary:'本人明确接受'};
    const partyViewers=[f.actor.subjectId,reporter.actor.subjectId,...f.moderation.moderatorIds];
    const acceptGrant=await verifier.authorize(accept,'moderation.publish',{viewers:partyViewers});
    await f.moderation.event(verifier.actor,report.id,acceptGrant);
    api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${api.address().port}`;
    const call=async(who,path,body={})=>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${who.credential}`},body:JSON.stringify(body)});
      return{status:response.status,body:await response.json()};};
    return{...f,reporter,moderator,verifier,otherModerator,secondVerifier,outsider,extraReporters,root,report,invite,accept,acceptGrant,invitationGrant,call,
      close:async()=>{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}};
  }catch(error){if(api?.listening){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}await f.db.close();throw error;}
}

test('actual inviter subject deletion preserves another author’s accepted participation and bounded process rights',async()=>{
  const f=await fixture();try{
    const before=await f.call(f.verifier,`/v1/moderation/reports/${f.report.id}/read`);assert.equal(before.status,200);
    assert.equal(before.body.verifierParticipation.own.status,'accepted');assert.equal(before.body.canAppeal,true);
    const command=await approveFixtureDeletion(f.moderator,f.db,{auditUntil:f.now+60});
    const deletion=await executeDeletion(f.db,command,{now:()=>f.now});assert.equal(deletion.deletedCounts.moderation_events,1);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM moderation_events WHERE id=$1',[f.invite.id])).rows[0].count),0);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM moderation_events WHERE id=$1',[f.accept.id])).rows[0].count),1);
    const after=await f.call(f.verifier,`/v1/moderation/reports/${f.report.id}/read`);
    assert.equal(after.status,200,'erasing the inviter cannot erase another author’s accepted process role');
    assert.equal(after.body.verifierParticipation.own.participated,true);
    assert.equal(after.body.canAppeal,true);assert.equal(after.body.canSupplement,true);
    assert.ok(after.body.canCorrectEventIds.includes(f.accept.id));
    assert.equal(after.body.verifierParticipation.own.scope,null);assert.equal(after.body.canSubmitVerification,false);
    const listed=await f.call(f.verifier,'/v1/moderation/reports/query',{caseId:f.root.id});assert.equal(listed.status,200);
    assert.ok(listed.body.items.some(item=>item.reportId===f.report.id));
    const context=await f.access.runAuthorized(f.verifier.actor,'moderation',db=>f.moderation.caseContextWithin(db,f.verifier.actor,f.root.id));
    assert.ok(context.items.some(item=>item.reportId===f.report.id));
    assert.equal((await f.call(f.outsider,`/v1/moderation/reports/${f.report.id}/read`)).status,404);
    assert.deepEqual((await f.call(f.outsider,'/v1/moderation/reports/query',{caseId:f.root.id})).body.items,[]);
    f.moderation.moderatorIds=[f.otherModerator.actor.subjectId];
    const response={id:randomUUID(),reportId:f.report.id,expectedVersion:3,kind:'verification-response',invitationId:f.invite.id,
      summary:'历史参与不是新的材料读取权',conclusion:'inconclusive',references:[]};
    const responseGrant=await f.verifier.authorize(response,'moderation.publish',{viewers:[f.actor.subjectId,f.reporter.actor.subjectId,f.otherModerator.actor.subjectId]});
    const refused=await f.call(f.verifier,`/v1/moderation/reports/${f.report.id}/events`,responseGrant);
    assert.equal(refused.status,403);assert.equal(refused.body.error,'verifier_invitation_required');
    const resolution={id:randomUUID(),reportId:f.report.id,expectedVersion:3,kind:'resolve',summary:'另一独立处理者完成原流程',verdict:'dismissed'};
    const resolutionGrant=await f.otherModerator.authorize(resolution,'moderation.publish',{viewers:[f.actor.subjectId,f.reporter.actor.subjectId,f.verifier.actor.subjectId]});
    assert.equal((await f.call(f.otherModerator,`/v1/moderation/reports/${f.report.id}/events`,resolutionGrant)).status,200);
    const appeal={id:randomUUID(),reportId:f.report.id,expectedVersion:4,kind:'appeal',summary:'本人保留有限流程申诉权'};
    const grant=await f.verifier.authorize(appeal,'moderation.publish',{viewers:[f.otherModerator.actor.subjectId]});
    const accepted=await f.call(f.verifier,`/v1/moderation/reports/${f.report.id}/events`,grant);assert.equal(accepted.status,200);
    const withdraw={id:randomUUID(),reportId:f.report.id,expectedVersion:5,kind:'withdraw-verifier',invitationId:f.invite.id,summary:'本人退出原参与'};
    const withdrawGrant=await f.verifier.authorize(withdraw,'moderation.publish',{viewers:[f.actor.subjectId,f.reporter.actor.subjectId,f.otherModerator.actor.subjectId]});
    assert.equal((await f.call(f.verifier,`/v1/moderation/reports/${f.report.id}/events`,withdrawGrant)).status,200);
    const withdrawn=await f.call(f.verifier,`/v1/moderation/reports/${f.report.id}/read`);
    assert.equal(withdrawn.body.verifierParticipation.own.status,'withdrawn');assert.equal(withdrawn.body.verifierParticipation.own.participated,true);
    assert.equal(withdrawn.body.canAppeal,true);assert.equal(withdrawn.body.canWithdrawVerifier,false);
    const supplement={id:randomUUID(),reportId:f.report.id,expectedVersion:6,kind:'supplement',summary:'退出后补充本人有限声明',references:[]};
    const supplementGrant=await f.verifier.authorize(supplement,'moderation.publish',{viewers:[f.otherModerator.actor.subjectId]});
    assert.equal((await f.call(f.verifier,`/v1/moderation/reports/${f.report.id}/events`,supplementGrant)).status,200);
  }finally{await f.close();}
});

test('moderation query and Case context collect visible reports beyond hidden candidates without leaking their boundary',async()=>{
  const f=await fixture({reportId:'ffffffff-ffff-4fff-bfff-fffffffffffe',extraReporterCount:7});try{
    const hiddenIds=[];
    for(const [index,reporter]of f.extraReporters.entries())for(let item=0;item<3;item++){
      const id=`00000000-0000-4000-8000-${String(index*3+item+1).padStart(12,'0')}`;hiddenIds.push(id);
      const report={...f.report,id,summary:'仅独立处理者可读的报告'};
      await f.moderation.report(reporter.actor,await reporter.authorize(report,'moderation.publish',{viewers:f.moderation.moderatorIds}));
    }
    const ownReport={...f.report,id:'ffffffff-ffff-4fff-bfff-ffffffffffff',summary:'本人另一次明确报告'};
    await f.moderation.report(f.verifier.actor,await f.verifier.authorize(ownReport,'moderation.publish',{viewers:f.moderation.moderatorIds}));
    const first=await f.call(f.verifier,'/v1/moderation/reports/query',{caseId:f.root.id,limit:1});assert.equal(first.status,200);
    assert.deepEqual(first.body.items.map(row=>row.reportId),[f.report.id]);assert.equal(first.body.nextAfter,f.report.id);
    const second=await f.call(f.verifier,'/v1/moderation/reports/query',{caseId:f.root.id,limit:1,after:first.body.nextAfter});
    assert.deepEqual(second.body.items.map(row=>row.reportId),[ownReport.id]);assert.equal(second.body.nextAfter,null);
    const context=await f.access.runAuthorized(f.verifier.actor,'moderation',db=>f.moderation.caseContextWithin(db,f.verifier.actor,f.root.id));
    assert.deepEqual(context.items.map(row=>row.reportId),[f.report.id,ownReport.id]);
    const inaccessible=await f.call(f.outsider,'/v1/moderation/reports/query',{caseId:f.root.id,limit:1});
    assert.deepEqual(inaccessible.body,{items:[],nextAfter:null});
    for(const id of hiddenIds){assert.equal(JSON.stringify(first.body).includes(id),false);assert.equal(JSON.stringify(context).includes(id),false);}
    // A completely unrelated private record is not this viewer's candidate.
    // Its live-source corruption must not disrupt their authorized reports.
    await f.db.query('UPDATE moderation_reports SET payload_text=$2 WHERE id=$1',[hiddenIds[0],'unrelated active damaged bytes']);
    const isolated=await f.call(f.verifier,'/v1/moderation/reports/query',{caseId:f.root.id,limit:1});
    assert.equal(isolated.status,200);assert.deepEqual(isolated.body,first.body);
    const isolatedContext=await f.access.runAuthorized(f.verifier.actor,'moderation',db=>f.moderation.caseContextWithin(db,f.verifier.actor,f.root.id));
    assert.deepEqual(isolatedContext.items.map(row=>row.reportId),[f.report.id,ownReport.id]);
    const relevant=await f.call(f.extraReporters[0],'/v1/moderation/reports/query',{caseId:f.root.id});
    assert.equal(relevant.status,500);assert.equal(relevant.body.error,'stored_integrity_mismatch');
  }finally{await f.close();}
});

test('unavailable old invitation bytes do not prevent a current notification and formal view; live corruption is rejected',async()=>{
  const f=await fixture();try{
    const invite={...f.invite,id:randomUUID(),expectedVersion:3,verifierId:f.secondVerifier.actor.subjectId};
    const grant=await f.otherModerator.authorize(invite,'moderation.publish',{viewers:[f.actor.subjectId,f.reporter.actor.subjectId,f.verifier.actor.subjectId,
      f.moderator.actor.subjectId,f.secondVerifier.actor.subjectId]});
    await f.moderation.event(f.otherModerator.actor,f.report.id,grant);
    await f.db.query('UPDATE moderation_reports SET created_at=$1',[new Date(f.now*1000).toISOString()]);
    await f.db.query('UPDATE moderation_events SET created_at=$1',[new Date(f.now*1000).toISOString()]);
    const noticeId='moderation-event:'+invite.id;
    assert.ok((await f.call(f.secondVerifier,'/v2/notifications/query')).body.items.some(item=>item.id===noticeId));
    await f.consents.revoke(f.moderator.actor,f.invitationGrant.consentId);
    // Explicit robustness simulation, not a claim that moderation TTL erases
    // these bytes. Only this old withdrawn grant is unavailable.
    await f.db.query('UPDATE moderation_events SET payload_text=$2 WHERE id=$1',[f.invite.id,'unavailable old private bytes']);
    const notices=await f.call(f.secondVerifier,'/v2/notifications/query');assert.equal(notices.status,200);
    const notice=notices.body.items.find(item=>item.id===noticeId);assert.ok(notice);assert.equal(notice.object.eventId,invite.id);
    const displayed={id:noticeId,deliveryClientId:randomUUID(),claimId:randomUUID()};
    assert.equal((await f.call(f.secondVerifier,'/v2/notifications/presentation/claim',displayed)).body.claimed,true);
    assert.equal((await f.call(f.secondVerifier,'/v2/notifications/presentation/ack',displayed)).body.presented,true);
    const opened=await f.call(f.secondVerifier,`/v1/moderation/reports/${f.report.id}/read`);assert.equal(opened.status,200);
    assert.equal(opened.body.verifierParticipation.own.invitationId,invite.id);assert.equal(opened.body.canAcceptVerifier,true);
    assert.equal(JSON.stringify(opened.body).includes('unavailable old private bytes'),false);
    assert.ok((await f.call(f.secondVerifier,'/v1/moderation/reports/query',{caseId:f.root.id})).body.items.some(item=>item.reportId===f.report.id));
    const context=await f.access.runAuthorized(f.secondVerifier.actor,'moderation',db=>f.moderation.caseContextWithin(db,f.secondVerifier.actor,f.root.id));
    assert.ok(context.items.some(item=>item.reportId===f.report.id));
    const accept={id:randomUUID(),reportId:f.report.id,expectedVersion:4,kind:'accept-verifier',invitationId:invite.id,summary:'当前准确邀请仍可接受'};
    const acceptGrant=await f.secondVerifier.authorize(accept,'moderation.publish',{viewers:[f.actor.subjectId,f.reporter.actor.subjectId,f.verifier.actor.subjectId,
      ...f.moderation.moderatorIds]});
    assert.equal((await f.call(f.secondVerifier,`/v1/moderation/reports/${f.report.id}/events`,acceptGrant)).status,200);
    await f.db.query('UPDATE moderation_events SET payload_text=$2 WHERE id=$1',[invite.id,'damaged current private bytes']);
    const corrupt=await f.call(f.secondVerifier,`/v1/moderation/reports/${f.report.id}/read`);
    assert.equal(corrupt.status,500);assert.equal(corrupt.body.error,'stored_integrity_mismatch');
  }finally{await f.close();}
});
