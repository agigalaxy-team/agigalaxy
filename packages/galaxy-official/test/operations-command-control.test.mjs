import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {ContentPublications,createContentPublicationWorker} from '../src/content-publications.mjs';
import {SearchIndex} from '../src/search-index.mjs';
import {dispatchOperations} from '../src/adapters/http/operations-http.mjs';
import {queueFixture} from './operations-jobs-fixture.mjs';
import {endpoint,operator,publicSnapshot,deferred} from './operations-management-fixture.mjs';

async function fixture(t){
  const db=new PGlite();let queue;
  t.after(async()=>{await queue?.jobs.stop();await db.close();});
  await migrate(db);queue=queueFixture(db);await queue.jobs.start();
  const businessAdmin=new BusinessAdminService({db,endpoint});
  const publications=new ContentPublications({db,endpoint,jobs:queue.jobs});
  const index=new SearchIndex({db,endpoint,jobs:queue.jobs});
  await index.configure({enabled:true});
  return {db,queue,businessAdmin,publications,index,actor:operator()};
}

async function dispatch(f,method,path,input={},actor=f.actor){
  const request=Object.assign(Readable.from(method==='POST'?[Buffer.from(JSON.stringify(input))]:[]),
    {method,headers:{'content-type':'application/json'}});
  const requestId=randomUUID(),headers=new Map();let result;
  const accepted=await dispatchOperations({
    operations:{portal:{authorizeOperator:async(_request,context)=>({...actor,httpRequestId:context.requestId})}},
    operationsJobs:f.queue.jobs,businessAdmin:f.businessAdmin,contentPublications:f.publications,searchIndex:f.index,
    request,response:{setHeader:(name,value)=>headers.set(name.toLowerCase(),value)},requestId,
    url:new URL(path,endpoint),send:(status,value)=>{result={status,value};},
  });
  assert.equal(accepted,true);
  assert.equal(headers.get('cache-control'),'no-store');
  return {...result,requestId};
}

test('an API-only cancellation stops a separately constructed publisher and rolls back with its operator audit', {timeout:60000},async t=>{
  const f=await fixture(t),publisherQueue=queueFixture(f.db);
  await publisherQueue.jobs.start();
  const entered=deferred(),release=deferred(),activations=[];
  const initial={publicationId:randomUUID(),siteVersion:'previous'};let pointer=initial;
  const publisher={current:async()=>pointer,async prepare({publicationId}){
    entered.resolve();await release.promise;return {publicationId,siteVersion:'candidate'};
  },async activate(artifact){activations.push(artifact.publicationId);pointer=artifact;}};
  // API and worker have different queue objects, as in separate processes.
  const worker=createContentPublicationWorker({db:f.db,endpoint,jobs:publisherQueue.jobs,publisher});
  const id=randomUUID();
  await f.publications.request(f.actor,{operationId:id,snapshot:publicSnapshot({title:'DO_NOT_COPY_CONTENT_INTO_AUDIT'})});
  // Reconstructing an API service must not register the callback twice.
  new ContentPublications({db:f.db,endpoint,jobs:f.queue.jobs});
  const [job]=await publisherQueue.boss.fetch('content-publication',{includeMetadata:true});
  assert.equal(job.data.publicationId,id);
  const running=worker.execute(job.data);
  let outcome;
  try{
    await Promise.race([entered.promise,running.then(()=>{throw Error('publisher finished before the controlled render delay');})]);
    await assert.rejects(f.queue.jobs.cancel('content-publication',job.id,{endpoint,audit:async(tx,result)=>{
      await f.businessAdmin.recordWithin(tx,f.actor,'job-cancel',{
        selection:{queue:result.queue,jobId:result.jobId},result:{state:result.state}});
      throw Error('synthetic audit transaction failure');
    }}),/audit transaction failure/);
    assert.equal((await f.queue.jobs.get('content-publication',job.id)).state,'active');
    assert.equal((await f.publications.get(f.actor,id)).publication.state,'building');
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM business_admin_audit_v1')).rows[0].n,0);
    const path='/v1/operations/jobs/content-publication/'+job.id+'/cancel';
    await assert.rejects(dispatch(f,'POST',path,{},operator('reader')),error=>error.code==='business_admin_denied');
    const cancelled=await dispatch(f,'POST',path);
    assert.equal(cancelled.value.state,'cancelled');
    const stopped=(await f.publications.get(f.actor,id)).publication;
    assert.equal(stopped.state,'failed');assert.equal(stopped.error.retryable,false);
    assert.equal(stopped.error.code,'site_publication_cancelled');
    const records=(await f.db.query('SELECT * FROM business_admin_audit_v1')).rows;
    assert.equal(records.length,1);assert.equal(records[0].action,'job-cancel');
    assert.equal(records[0].operator_id,f.actor.operatorId);assert.equal(records[0].http_request_id,cancelled.requestId);
    assert.deepEqual(records[0].selection,{queue:'content-publication',jobId:job.id});
    assert.equal(JSON.stringify(records).includes('DO_NOT_COPY_CONTENT_INTO_AUDIT'),false);
    const status=await dispatch(f,'GET','/v1/operations/jobs/content-publication/'+job.id);
    assert.equal(status.value.job.state,'cancelled');
    const missing=await dispatch(f,'GET','/v1/operations/jobs/content-publication/'+randomUUID());
    assert.deepEqual(missing.value,{job:null});
    await assert.rejects(dispatch(f,'POST','/v1/operations/jobs/content-publication/'+job.id+'/retry'),error=>error.code==='operations_job_not_failed');
  }finally{
    release.resolve();
    try{outcome=await running;}finally{await publisherQueue.jobs.stop();}
  }
  assert.deepEqual(outcome,{state:'superseded'});
  assert.deepEqual(pointer,initial);assert.deepEqual(activations,[]);
});

test('job and exact-generation search retries persist who changed them, with rollback and safe status recovery', {timeout:60000},async t=>{
  const f=await fixture(t),sourceJob=randomUUID();
  const jobId=await f.queue.jobs.enqueue('search-recovery',{jobId:sourceJob,generation:4,recoveryAttempt:1,
    privateText:'DO_NOT_COPY_PAYLOAD'}, {key:'audit-retry:'+sourceJob});
  // An exhausted durable job left by another worker process.
  await f.db.query("UPDATE galaxy_jobs.job SET state='failed' WHERE name='search-recovery' AND id=$1",[jobId]);
  const retry='/v1/operations/jobs/search-recovery/'+jobId+'/retry';
  const record=f.businessAdmin.recordWithin;
  f.businessAdmin.recordWithin=async(...args)=>{await record.apply(f.businessAdmin,args);throw Error('synthetic audit failure');};
  try{await assert.rejects(dispatch(f,'POST',retry),/audit failure/);}
  finally{f.businessAdmin.recordWithin=record;}
  assert.equal((await f.queue.jobs.get('search-recovery',jobId)).state,'failed');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM business_admin_audit_v1')).rows[0].n,0);
  const resumed=await dispatch(f,'POST',retry);
  assert.notEqual(resumed.value.state,'failed');
  const checked=await dispatch(f,'GET','/v1/operations/jobs/search-recovery/'+jobId);
  assert.equal(checked.value.job.state,resumed.value.state);
  const payload={sourceType:'case',sourceId:randomUUID(),subjectId:'GUID'+'A'.repeat(28),generation:4,privateText:'DO_NOT_COPY_PAYLOAD'};
  await f.db.query("INSERT INTO jobs(id,kind,deduplication_key,payload,state,attempts) VALUES($1::uuid,'search-index','fixture:'||($1::uuid)::text,$2,'failed',5)",[sourceJob,JSON.stringify(payload)]);
  const sourceStatus='/v1/operations/search/failures/'+sourceJob;
  const failed=await dispatch(f,'GET',sourceStatus);
  assert.equal(failed.value.job.state,'failed');assert.equal(failed.value.job.generation,4);
  assert.equal(JSON.stringify(failed.value).includes('DO_NOT_COPY_PAYLOAD'),false);
  f.businessAdmin.recordWithin=async(...args)=>{await record.apply(f.businessAdmin,args);throw Error('synthetic audit failure');};
  try{await assert.rejects(dispatch(f,'POST',sourceStatus+'/retry',{expectedGeneration:4}),/audit failure/);}
  finally{f.businessAdmin.recordWithin=record;}
  assert.equal((await f.index.failureStatus(sourceJob)).state,'failed');
  const recovered=await dispatch(f,'POST',sourceStatus+'/retry',{expectedGeneration:4});
  assert.deepEqual(recovered.value,{jobId:sourceJob,generation:4,state:'pending'});
  const after=await dispatch(f,'GET',sourceStatus);
  assert.equal(after.value.job.state,'pending');assert.equal(after.value.job.generation,4);
  assert.deepEqual((await dispatch(f,'GET','/v1/operations/search/failures/'+randomUUID())).value,{job:null});
  await assert.rejects(dispatch(f,'POST',sourceStatus+'/retry',{expectedGeneration:5}),error=>error.code==='search_recovery_conflict');
  const records=(await f.db.query('SELECT * FROM business_admin_audit_v1 ORDER BY sequence')).rows;
  assert.deepEqual(records.map(row=>row.action),['job-retry','search-retry']);
  assert.deepEqual(records.map(row=>row.http_request_id),[resumed.requestId,recovered.requestId]);
  assert.ok(records.every(row=>row.operator_id===f.actor.operatorId&&row.operator_role==='administrator'));
  assert.deepEqual(records[1].selection,{jobId:sourceJob,generation:4});
  assert.equal(JSON.stringify(records).includes('DO_NOT_COPY_PAYLOAD'),false);
});
