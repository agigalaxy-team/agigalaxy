import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { operationalSnapshot } from '../src/infrastructure/operational-snapshot.mjs';
import { EvidenceService } from '../src/evidence.mjs';
import { ConsentReader } from '../src/consent-reader.mjs';
import { inspectGithubRun } from '../src/github-evidence.mjs';

export async function verifyOperationalMetrics(db,{repositories,workerDatabase,workerReads}){
  // Synthetic clock is ahead of DB insertion timestamps so jobs are due without sleeps.
  const now=Math.floor(Date.now()/1000)+60,baseline=await operationalSnapshot(db,now*1000);
  assert.equal(baseline.pending+baseline.running,0,'This workflow requires its isolated empty queue');
  const f=await serviceFixture(['binding','consent','case-teaser','evidence'],db,{migrateDatabase:false,repositories,now});
  assert.equal((await operationalSnapshot(db,now*1000)).connected,baseline.connected+1);
  const parent={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Metrics fixture',summary:'Synthetic only',
    source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
  await f.cases.submit(f.actor,await f.authorize(parent));
  const attempt={id:randomUUID(),kind:'attempt',caseId:parent.id,expectedVersion:1,sequence:1,approach:'Synthetic',configuration:{environment:'integration',version:'1',tools:[]}};
  await f.cases.submit(f.actor,await f.authorize(attempt));
  const result={id:randomUUID(),kind:'result',caseId:parent.id,expectedVersion:2,attemptId:attempt.id,outcome:'succeeded',summary:'Synthetic',failureReason:'',limitations:['Synthetic']};
  await f.cases.submit(f.actor,await f.authorize(result));
  for(const runId of [1,2]){
    const value={id:randomUUID(),caseId:parent.id,resultId:result.id,source:{provider:'github-actions',owner:'fixture',repository:'metrics',runId,attempt:1,commit:'b'.repeat(40)}};
    await f.evidence.submit(f.actor,await f.authorize(value,'evidence.submit'));
  }
  const queued=await operationalSnapshot(db,now*1000);assert.equal(queued.pending,2);assert.equal(queued.evidence_bearing,baseline.evidence_bearing);
  const worker=new EvidenceService(null,new ConsentReader({now:()=>now,readGrant:workerReads.readGrant}),
    {db:workerDatabase,endpoint:f.access.endpoint,now:()=>now,readCase:workerReads.readCase});
  const inspect=(source,time)=>inspectGithubRun(source,{id:source.runId,run_attempt:1,head_sha:source.commit,repository:{full_name:'fixture/metrics',id:1,private:false},
    updated_at:new Date(time*1000).toISOString(),status:'completed',conclusion:'success'},time);
  assert.equal((await worker.processNext(inspect)).state,'observed');
  assert.equal((await operationalSnapshot(db,now*1000)).evidence_bearing,baseline.evidence_bearing+1);
  const pending=(await db.query("SELECT consent_id FROM evidence_submissions WHERE subject_id=$1 AND state='pending'",[f.actor.subjectId])).rows[0];
  await f.consents.revoke(f.actor,pending.consent_id);
  const revoked=await operationalSnapshot(db,now*1000);assert.equal(revoked.revoked_jobs,1);assert.equal(revoked.oldest_revocation,0);
  assert.equal((await worker.processNext(inspect)).state,'revoked');
  assert.equal((await operationalSnapshot(db,now*1000)).revoked_jobs,0);
  const observed=(await db.query("SELECT consent_id FROM evidence_submissions WHERE subject_id=$1 AND state='observed'",[f.actor.subjectId])).rows[0];
  await f.consents.revoke(f.actor,observed.consent_id);
  const final=await operationalSnapshot(db,now*1000);
  assert.equal(final.evidence_bearing,baseline.evidence_bearing);assert.equal(final.connected,baseline.connected+1);
  assert.ok(final.database_bytes>0);
  return {restrictedRole:true,physicalDatabaseBytes:true,queueTransitions:true,directRevocationBacklog:true,connectedSeparateFromEvidence:true,capabilityCountNotInferred:true};
}
