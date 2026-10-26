import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { defaultResourceBudgetPolicy,subjectResourceUsage } from '../src/infrastructure/resource-budgets.mjs';
import { EvidenceService } from "../src/evidence/evidence.mjs";
import { ConsentReader } from "../src/consents/consent-reader.mjs";
import { inspectGithubRun } from "../src/evidence/github-evidence.mjs";
const rootFor=subjectId=>({id:randomUUID(),kind:'case',localRef:randomUUID(),title:'资源测试',summary:'Synthetic resource budget',source:{kind:'local',reference:randomUUID()},participants:[{subjectId,role:'requester'}]});
export async function verifyResourceBudgets(database=null,options={}){
  const policy={...defaultResourceBudgetPolicy,maxActiveExportsPerSubject:1,maxQueuedJobsPerSubject:1,maxActiveJobsGlobal:1,maxActiveJobsPerSubject:1};
  const f=await serviceFixture(['binding','consent','case-teaser','data-export','evidence'],database,{...options,resourceBudgetPolicy:policy});
  let pending,release;
  try{
    const roots=[rootFor(f.actor.subjectId),rootFor(f.actor.subjectId)],inputs=await Promise.all(roots.map(value=>f.authorize(value)));
    f.access.resourceBudgetPolicy.maxPayloadBytesPerSubject=Math.max(...inputs.map(value=>Buffer.byteLength(value.payloadJson)));
    const results=await Promise.allSettled(inputs.map(value=>f.cases.submit(f.actor,value)));
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.find(result=>result.status==='rejected').reason.code,'storage_quota_exceeded');
    const winner=results.findIndex(result=>result.status==='fulfilled'),root=roots[winner];
    assert.equal(Number((await f.db.query('SELECT count(*) FROM cases WHERE subject_id=$1',[f.actor.subjectId])).rows[0].count),1);
    assert.equal(Number((await f.db.query("SELECT count(*) FROM audit_events WHERE actor=$1 AND action='case.case'",[f.actor.subjectId])).rows[0].count),1);
    f.access.resourceBudgetPolicy.maxPayloadBytesPerSubject=0;
    await f.cases.submit(f.actor,inputs[winner]);
    const withdrawn={id:randomUUID(),kind:'withdrawal',caseId:root.id,expectedVersion:1,reason:'Exit remains available'};
    await f.cases.submit(f.actor,await f.authorize(withdrawn));
    assert.equal((await f.db.query('SELECT state FROM cases WHERE id=$1',[root.id])).rows[0].state,'withdrawn');
    const first={id:randomUUID(),datasets:['identity']};await f.dataExport.create(f.actor,first);
    const denied={id:randomUUID(),datasets:['identity']};await assert.rejects(f.dataExport.create(f.actor,denied),error=>error.code==='export_ticket_quota_exceeded');
    assert.equal((await f.db.query('SELECT id FROM data_exports WHERE id=$1',[denied.id])).rows.length,0);
    await f.dataExport.revoke(f.actor,{id:first.id});await f.dataExport.create(f.actor,denied);
    const g=await serviceFixture(['binding','consent','case-teaser','evidence'],f.db,{...options,migrateDatabase:false,resourceBudgetPolicy:policy});
    const parent=rootFor(g.actor.subjectId);await g.cases.submit(g.actor,await g.authorize(parent));
    const attempt={id:randomUUID(),kind:'attempt',caseId:parent.id,expectedVersion:1,sequence:1,approach:'Synthetic',configuration:{environment:'integration',version:'1',tools:[]}};
    await g.cases.submit(g.actor,await g.authorize(attempt));
    const result={id:randomUUID(),kind:'result',caseId:parent.id,expectedVersion:2,attemptId:attempt.id,outcome:'succeeded',summary:'Synthetic',failureReason:'',limitations:['Synthetic']};
    await g.cases.submit(g.actor,await g.authorize(result));
    const evidence=runId=>({id:randomUUID(),caseId:parent.id,resultId:result.id,source:{provider:'github-actions',owner:'fixture',repository:'example',runId,attempt:1,commit:'a'.repeat(40)}});
    const e1=evidence(1),e2=evidence(2),p1=await g.authorize(e1,'evidence.submit'),p2=await g.authorize(e2,'evidence.submit');
    await g.evidence.submit(g.actor,p1);await assert.rejects(g.evidence.submit(g.actor,p2),error=>error.code==='job_queue_quota_exceeded');
    assert.equal((await g.db.query('SELECT id FROM evidence_submissions WHERE id=$1',[e2.id])).rows.length,0);
    g.access.resourceBudgetPolicy.maxQueuedJobsPerSubject=2;await g.evidence.submit(g.actor,p2);
    const workerDb=options.workerDatabase??f.db;
    const worker=()=>new EvidenceService(null,new ConsentReader({now:()=>g.now,readGrant:options.workerReads?.readGrant}),{db:workerDb,endpoint:g.access.endpoint,now:()=>g.now,readCase:options.workerReads?.readCase,resourceBudgetPolicy:policy});
    const inspect=(source,now)=>inspectGithubRun(source,{id:source.runId,run_attempt:1,head_sha:source.commit,repository:{full_name:'fixture/example',id:1,private:false},updated_at:new Date(now*1000).toISOString(),status:'completed',conclusion:'success'},now);
    let entered;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    pending=worker().processNext(async(source,now)=>{entered();await gate;return inspect(source,now);});
    let timer;try{await Promise.race([started,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Worker did not start')),5000);})]);}finally{clearTimeout(timer);}
    assert.deepEqual(await worker().processNext(inspect),{processed:false,budgetLimited:true});
    const sameSubjectWorker=worker();sameSubjectWorker.resourceBudgetPolicy.maxActiveJobsGlobal=2;
    assert.deepEqual(await sameSubjectWorker.processNext(inspect),{processed:false});
    release();assert.equal((await pending).processed,true);pending=null;
    assert.equal((await worker().processNext(inspect)).processed,true);
    assert.equal((await subjectResourceUsage(g.db,g.actor.subjectId,g.now)).queuedJobs,0);
    return {concurrentPayloadCap:true,wholeTransactionRollback:true,utf8Bytes:true,idempotentAboveReducedLimit:true,withdrawalPreserved:true,exportCapAndRevoke:true,queuedJobCap:true,workerLeaseCap:true,workerSubjectLeaseCap:true,slotReleased:true};
  }finally{release?.();if(pending)await pending;if(!database)await f.db.close();}
}
