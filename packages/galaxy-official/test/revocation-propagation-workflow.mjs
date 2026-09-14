import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createOperationalMetrics } from '../src/operations/metrics.mjs';
import { operationalSnapshot } from '../src/infrastructure/operational-snapshot.mjs';
import { SearchIndex } from '../src/search-index.mjs';
import { EvidenceService } from '../src/evidence.mjs';
import { ConsentReader } from '../src/consent-reader.mjs';
import { workerReads } from '../src/infrastructure/worker-reads.mjs';
import { inspectGithubRun } from '../src/github-evidence.mjs';

export async function verifyRevocationPropagation(db,options){
  const now=Math.floor(Date.now()/1000)+60;
  const f=await serviceFixture(['binding','consent','case-teaser','evidence','proof','history','data-export'],db,{...options,now});
  const metrics=createOperationalMetrics({component:'api',db,now:()=>now*1000,cacheMs:0,defaultMetrics:false});
  const api=createApi({...f,metrics}),observations=[];
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+api.address().port;
  const request=async(path,body,authenticated=false)=>{
    const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{
      ...(body===undefined?{}:{'content-type':'application/json'}),...(authenticated?{authorization:'Bearer '+f.credential}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal(response.headers.get('cache-control'),'no-store');
    return {status:response.status,body:await response.json()};
  };
  const worker=new EvidenceService(null,new ConsentReader({now:()=>now,readGrant:workerReads.readGrant}),
    {db:options.workerDatabase,endpoint:f.access.endpoint,now:()=>now,readCase:workerReads.readCase});
  const index=new SearchIndex({db:options.workerDatabase,endpoint:f.access.endpoint,now:()=>now,readGrant:workerReads.readGrant});
  const drain=async()=>{for(let i=0;i<100;i++)if(!(await index.processNext()).processed)return;throw new Error('Index did not drain');};
  try{
    const root={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Revocation measurement',summary:'Public synthetic source',
      source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    const publicGrant={visibility:'Public',purpose:'public-profile'},rootGrant=await f.authorize(root,'case.teaser.publish',publicGrant);
    await f.cases.submit(f.actor,rootGrant);
    const attempt={id:randomUUID(),kind:'attempt',caseId:root.id,expectedVersion:1,sequence:1,approach:'Synthetic',configuration:{environment:'test',version:'1',tools:[]}};
    const attemptGrant=await f.authorize(attempt,'case.teaser.publish',publicGrant);await f.cases.submit(f.actor,attemptGrant);
    const result={id:randomUUID(),kind:'result',caseId:root.id,expectedVersion:2,attemptId:attempt.id,outcome:'succeeded',summary:'Synthetic',failureReason:'',limitations:['Fixture']};
    await f.cases.submit(f.actor,await f.authorize(result,'case.teaser.publish',publicGrant));
    const evidence={id:randomUUID(),caseId:root.id,resultId:result.id,source:{provider:'github-actions',owner:'fixture',repository:'revocation',runId:1,attempt:1,commit:'a'.repeat(40)}};
    await f.evidence.submit(f.actor,await f.authorize(evidence,'evidence.submit'));
    const inspect=(source,at)=>inspectGithubRun(source,{id:source.runId,run_attempt:1,head_sha:source.commit,repository:{full_name:'fixture/revocation',id:1,private:false},
      updated_at:new Date(at*1000).toISOString(),status:'completed',conclusion:'success'},at);
    assert.equal((await worker.processNext(inspect)).state,'observed');
    const preview=await f.proofs.preview(f.actor,{id:randomUUID(),evidenceId:evidence.id});
    const proof=await f.proofs.publish(f.actor,await f.authorize(JSON.parse(preview.payloadJson),'proof.publish',publicGrant));
    const pending={...evidence,id:randomUUID(),source:{...evidence.source,runId:2}};
    await f.evidence.submit(f.actor,await f.authorize(pending,'evidence.submit'));
    await index.configure({enabled:true,rebuild:true});while(!(await index.seedBatch()).complete){}await drain();
    const candidate=(await db.query("SELECT * FROM search_documents WHERE source_type='case' AND source_id=$1",[root.id])).rows[0];assert.ok(candidate);
    const reads=[
      {surface:'case-owner',path:'/v1/cases/'+root.id,authenticated:true,denied:403},
      {surface:'evidence-owner',path:'/v1/verifications/'+evidence.id,authenticated:true,denied:403},
      {surface:'proof-public',path:'/v1/proofs/'+proof.proofId,denied:404},
      {surface:'proof-status-public',path:'/v1/proofs/'+proof.proofId+'/status',denied:404},
      {surface:'history-public',path:'/v1/history/query',input:{subjectId:f.actor.subjectId}},
      {surface:'profile-public',path:'/v1/profiles/'+f.actor.subjectId},
      {surface:'search-case-public',path:'/v1/search/query',input:{type:'case',query:{subjectId:f.actor.subjectId}}},
      {surface:'search-proof-public',path:'/v1/search/query',input:{type:'proof',query:{subjectId:f.actor.subjectId}}},
    ];
    for(const check of reads){const response=await request(check.path,check.input,check.authenticated);assert.equal(response.status,200,check.surface);if(!check.denied)assert.equal(response.body.items.length,1,check.surface);}
    const ticket=await f.dataExport.create(f.actor,{id:randomUUID(),datasets:['authorized-views'],views:[{kind:'proof',id:proof.proofId}]});
    const exportPage={id:ticket.id,dataset:'authorized-views'};
    assert.equal((await request('/v1/data-exports/page',exportPage,true)).status,200);
    const started=performance.now();assert.equal((await request('/v1/consents/'+rootGrant.consentId+'/revoke',{},true)).status,200);
    const acknowledged=performance.now();
    const measure=async(surface,check)=>{await check();const ended=performance.now();observations.push({surface,fromRequestStartMs:ended-started,afterAcknowledgmentMs:ended-acknowledged,passed:true});};
    await Promise.all(reads.map(check=>measure(check.surface,async()=>{
      const response=await request(check.path,check.input,check.authenticated);assert.equal(response.status,check.denied??200,check.surface);
      if(!check.denied)assert.equal(response.body.items.length,0,check.surface);
    })));
    await measure('proof-authorized-export',async()=>assert.equal((await request('/v1/data-exports/page',exportPage,true)).status,403));
    await measure('search-candidate-invalidation',async()=>assert.equal(Number((await db.query('SELECT count(*) FROM search_documents WHERE source_id IN ($1,$2)',[root.id,proof.proofId])).rows[0].count),0));
    const backlog=await operationalSnapshot(db,now*1000);
    assert.equal(backlog.revoked_jobs,0,'Direct grant remains live; ancestor metric must find this job');
    assert.equal(backlog.dependent_revoked_jobs,1);assert.equal(backlog.invalidated_search_documents,0);
    const later=await operationalSnapshot(db,(now+10)*1000);assert.equal(later.oldest_dependent_revocation,10);
    await f.consents.revoke(f.actor,attemptGrant.consentId);
    assert.equal((await operationalSnapshot(db,now*1000)).dependent_revoked_jobs,1,'Multiple revoked ancestors count the job once');
    let sourceReads=0;
    await measure('evidence-worker-cleanup',async()=>{
      assert.equal((await worker.processNext((source,at)=>{sourceReads++;return inspect(source,at);})).state,'revoked');
      assert.equal(sourceReads,0,'Revoked job must not read an external source');
    });
    assert.equal((await operationalSnapshot(db,now*1000)).dependent_revoked_jobs,0);
    await drain();assert.equal((await index.candidates('case',{subjectId:f.actor.subjectId})).items.length,0);
    // A corrupted/stale candidate is diagnostic residue; current serving checks must still deny it.
    const columns='source_type,source_id,subject_id,endpoint,title,summary,search_text,source_version,metadata,dependencies,generation,built_at,valid_until';
    await options.adminDatabase.query(`INSERT INTO search_documents(${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::search_documents,$1::jsonb)`,[JSON.stringify(candidate)]);
    assert.equal((await operationalSnapshot(db,now*1000)).invalidated_search_documents,1);
    assert.equal((await request('/v1/search/query',reads[6].input)).body.items.length,0);
    await metrics.render();
    assert.equal((await metrics.registry.getSingleMetric('galaxy_revocation_search_documents').get()).values[0].value,1);
    await options.adminDatabase.query('DELETE FROM search_documents WHERE source_type=$1 AND source_id=$2',['case',root.id]);
    await metrics.render();assert.equal((await metrics.registry.getSingleMetric('galaxy_revocation_search_documents').get()).values[0].value,0);
    return {acknowledgmentMs:acknowledged-started,observations,ancestorBacklog:true,multipleDependenciesDeduplicated:true,staleCandidateDetected:true,
      staleCandidateCannotRestoreServing:true,cacheControl:'no-store',clock:'elapsed wall time; authorization clock fixed for fixture',authority:'controlled local HTTP/PostgreSQL sample; not production propagation SLA'};
  }finally{await index.configure({enabled:false});api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}
}
