import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';

export async function verifyHistoryPresentation(database=null,options={}){
  const scopes=['binding','consent','case-teaser','history'];
  const f=await serviceFixture(scopes,database,options),other=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false});
  try{
    const empty=await f.history.query(other.actor,{subjectId:other.actor.subjectId});
    assert.deepEqual(empty.items,[]);assert.deepEqual(empty.selfDeclared,{});assert.equal(empty.capabilityVerified,false);
    assert.deepEqual(empty.refresh,{mode:'on-demand',state:'rebuilt',backgroundQueue:false,checkedAt:f.now});
    const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'Outcome sequence',summary:'Reported transitions',
      source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    let version=0;
    const publish=async event=>{const grant=await f.authorize(event,'case.teaser.publish',{visibility:'Public',purpose:'public-profile'});
      version=(await f.cases.submit(f.actor,grant)).version;return grant;};
    await publish(root);
    const attempt={kind:'attempt',id:randomUUID(),caseId:root.id,expectedVersion:version,sequence:1,approach:'Initial attempt',configuration:{environment:'Private configuration',version:'24',tools:['private-tool']}};
    await publish(attempt);
    const success={kind:'result',id:randomUUID(),caseId:root.id,expectedVersion:version,attemptId:attempt.id,outcome:'succeeded',summary:'Originally reported success',failureReason:'',limitations:['Reported only']};
    await publish(success);
    await publish({...success,id:randomUUID(),expectedVersion:version,outcome:'partial',summary:'Partially resolved'});
    const later={...attempt,id:randomUUID(),expectedVersion:version,sequence:2,configuration:{environment:'Different configuration',version:'26',tools:[]}};
    await publish(later);
    let lastGrant;
    for(const outcome of ['failed','inconclusive','conflicting'])lastGrant=await publish({...success,id:randomUUID(),expectedVersion:version,attemptId:later.id,outcome,summary:'Later '+outcome,failureReason:outcome==='failed'?'Regression observed by author':''});
    await publish({kind:'revision',id:randomUUID(),caseId:root.id,expectedVersion:version,correctsEventId:success.id,reason:'Initial scope too broad',summary:'The original success was limited'});
    const read=async actor=>(await f.history.query(actor,{subjectId:f.actor.subjectId})).items.find(item=>item.caseId===root.id);
    const owner=await read(f.actor),authorized=await read(other.actor),publicItem=await read(null);
    assert.equal(owner.fieldPolicy.view,'owner');assert.equal(authorized.fieldPolicy.view,'authorized');assert.equal(publicItem.fieldPolicy.view,'public');
    assert.ok(owner.attempts[0].configuration);assert.equal(authorized.attempts[0].configuration,undefined);assert.equal(publicItem.participants,undefined);
    assert.ok(!JSON.stringify(publicItem).includes('private-tool'));assert.ok(!JSON.stringify(authorized).includes('Private configuration'));
    const progress=publicItem.reportedProgress;
    assert.deepEqual(progress.timeline.map(report=>report.outcome),['succeeded','partial','failed','inconclusive','conflicting']);
    assert.deepEqual(progress.timeline.map(report=>report.sourceEventVersion),[3,4,6,7,8]);
    assert.equal(progress.timeline[0].corrected,true);assert.equal(progress.subsequentReports[0].attemptRelation,'same-attempt');
    assert.ok(progress.subsequentReports.slice(1).every(report=>report.attemptRelation==='different-attempt'&&!report.regressionVerified));
    assert.equal(publicItem.results[0].summary,success.summary);assert.equal(progress.attemptCountIsCapability,false);
    assert.equal(publicItem.rebuild.rule.version,4);assert.deepEqual((await read(null)).rebuild,publicItem.rebuild);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM case_events WHERE case_id=$1',[root.id])).rows[0].count),version);
    await f.consents.revoke(f.actor,lastGrant.consentId);assert.equal(await read(null),undefined);
    const second={...root,id:randomUUID(),localRef:randomUUID(),source:{kind:'local',reference:randomUUID()}};await publish(second);
    assert.equal((await f.history.query(null,{subjectId:f.actor.subjectId})).items.length,1);
    await f.bindings.revoke(f.actor.bindingId,f.actor.subjectId,randomUUID(),null,f.actor);
    assert.equal((await f.history.query(null,{subjectId:f.actor.subjectId})).items.length,0);
    assert.equal((await f.history.query(other.actor,{subjectId:f.actor.subjectId})).items.length,0);
  }finally{if(!database)await f.db.close();}
}
