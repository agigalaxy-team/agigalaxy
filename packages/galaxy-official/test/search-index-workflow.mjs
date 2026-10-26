import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { SearchIndex } from "../src/discovery/search-index.mjs";
import { workerReads } from '../src/infrastructure/worker-reads.mjs';
import { EvidenceService } from "../src/evidence/evidence.mjs";
import { ConsentReader } from "../src/consents/consent-reader.mjs";
import { inspectGithubRun } from "../src/evidence/github-evidence.mjs";

export async function verifySearchIndex(database=null,options={}){
  const f=await serviceFixture(['binding','consent','case-teaser','history','evidence','proof','capsules'],database,options);
  let now=f.now;const workerDb=options.workerDb??f.db;
  const make=()=>new SearchIndex({db:workerDb,endpoint:f.access.endpoint,now:()=>now,readGrant:options.workerDb?workerReads.readGrant:undefined});
  let index=make();
  const create=async(title,audience)=>{
    const root={id:randomUUID(),kind:'case',localRef:randomUUID(),title,summary:'Compiler search fixture',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    const grant=await f.authorize(root,'case.teaser.publish',audience);await f.cases.submit(f.actor,grant);return {...root,grant};
  };
  const drain=async()=>{let processed=0;for(let i=0;i<100;i++){const result=await index.processNext();if(!result.processed)return processed;processed++;}throw new Error('Index queue did not drain');};
  try{
    const before=await create('Public compiler guide',{visibility:'Public',purpose:'public-profile'});
    const privateCase=await create('PRIVATE-NO-INDEX',{});
    assert.equal((await f.db.query("SELECT id FROM jobs WHERE kind='search-index'")).rows.length,0);
    await index.configure({enabled:true,rebuild:true});
    assert.equal((await index.seedBatch(1)).queued,1);
    const saved=(await f.db.query('SELECT scan_type,scan_after FROM search_index_control')).rows[0];assert.ok(saved.scan_after);
    index=make(); // Recreate the worker: the seed cursor survives process memory.
    for(let i=0;i<100;i++)if((await index.seedBatch(2)).complete)break;
    assert.equal((await f.db.query('SELECT scan_complete FROM search_index_control')).rows[0].scan_complete,true);
    await drain();
    const own=type=>index.candidates(type,{subjectId:f.actor.subjectId,query:'compiler'});
    assert.deepEqual((await own('case')).items.map(item=>item.id),[before.id]);
    assert.deepEqual((await own('history')).items.map(item=>item.id),[before.id]);
    const served=await f.search.query(null,{type:'case',query:{subjectId:f.actor.subjectId,query:'compiler'}});
    assert.equal(served.index.mode,'public-candidate-index');assert.deepEqual(served.items.map(item=>item.id),[before.id]);
    assert.equal((await f.search.query(f.actor,{type:'case',query:{subjectId:f.actor.subjectId}})).index,undefined);
    // A stale or corrupted candidate never authorizes a private source.
    await workerDb.query(`INSERT INTO search_documents(source_type,source_id,subject_id,endpoint,title,summary,search_text,source_version,metadata,dependencies,generation,built_at,valid_until)
      SELECT 'case',$1,subject_id,endpoint,'Stale candidate','No authority',search_text,source_version,metadata,dependencies,generation,built_at,valid_until FROM search_documents WHERE source_type='case' AND source_id=$2`,[privateCase.id,before.id]);
    assert.deepEqual((await f.search.query(null,{type:'case',query:{subjectId:f.actor.subjectId}})).items.map(item=>item.id),[before.id]);
    await workerDb.query("DELETE FROM search_documents WHERE source_type='case' AND source_id=$1",[privateCase.id]);
    const rows=(await f.db.query('SELECT * FROM search_documents WHERE subject_id=$1',[f.actor.subjectId])).rows;
    assert.equal(rows.length,2);assert.ok(!JSON.stringify(rows).includes('PRIVATE-NO-INDEX'));assert.ok(!rows.some(row=>row.source_id===privateCase.id));
    assert.ok((await f.db.query("SELECT source_id FROM search_documents WHERE search_words @@ plainto_tsquery('simple','compiler')")).rows.length);
    await f.consents.revoke(f.actor,before.grant.consentId);
    assert.equal((await own('case')).items.length,0);assert.equal((await f.db.query('SELECT * FROM search_documents WHERE source_id=$1',[before.id])).rows.length,0);
    await drain();assert.equal((await own('history')).items.length,0);
    assert.equal((await f.search.query(null,{type:'case',query:{subjectId:f.actor.subjectId}})).items.length,0);
    const interrupted=await create('Interrupted compiler rebuild',{visibility:'Public',purpose:'public-profile'});
    await assert.rejects(index.processNext({afterClaim:()=>{throw new Error('Simulated stopped process');}}),/stopped process/);
    const leased=(await f.db.query("SELECT * FROM jobs WHERE kind='search-index' AND state='running'")).rows[0];assert.equal(leased.attempts,1);
    now+=31;index=make();await drain();
    assert.equal((await f.db.query('SELECT state,attempts FROM jobs WHERE id=$1',[leased.id])).rows[0].attempts,2);
    assert.ok((await own('case')).items.some(item=>item.id===interrupted.id));
    now+=61;assert.equal((await own('case')).items.length,0); // An old index is hidden before maintenance catches up.
    assert.ok((await index.refreshExpired()).queued>=2);await drain();assert.ok((await own('case')).items.some(item=>item.id===interrupted.id));
    const failing=await create('Retry compiler job',{visibility:'Public',purpose:'public-profile'});
    const failed=await index.processNext({beforeCommit:()=>{throw new Error('Synthetic storage failure');}});assert.equal(failed.state,'pending');
    now+=21;await drain();assert.ok((await own('case')).items.some(item=>item.id===failing.id));
    // A change after claim invalidates the lease. The previous worker cannot
    // resurrect the old projection, even when its source had been public.
    const racing=await create('Revoked before commit',{visibility:'Public',purpose:'public-profile'});
    const claimed=await index.processNext({afterClaim:async()=>{await f.consents.revoke(f.actor,racing.grant.consentId);}});
    assert.ok(claimed.processed||claimed.leaseLost);await drain();
    assert.equal((await f.db.query('SELECT * FROM search_documents WHERE source_id=$1',[racing.id])).rows.length,0);
    const attempt={id:randomUUID(),kind:'attempt',caseId:privateCase.id,expectedVersion:1,sequence:1,approach:'Synthetic',configuration:{environment:'Node',version:'24',tools:[]}};
    await f.cases.submit(f.actor,await f.authorize(attempt));
    const result={id:randomUUID(),kind:'result',caseId:privateCase.id,expectedVersion:2,attemptId:attempt.id,outcome:'succeeded',summary:'Synthetic result',failureReason:'',limitations:['Fixture']};
    await f.cases.submit(f.actor,await f.authorize(result));
    const evidence={id:randomUUID(),caseId:privateCase.id,resultId:result.id,source:{provider:'github-actions',owner:'fixture',repository:'index-'+privateCase.id.slice(0,8),runId:621,attempt:1,commit:'c'.repeat(40)}};
    await f.evidence.submit(f.actor,await f.authorize(evidence,'evidence.submit'));
    const verifier=new EvidenceService(null,new ConsentReader({now:()=>f.now,readGrant:options.workerDb?workerReads.readGrant:undefined}),{db:workerDb,endpoint:f.access.endpoint,now:()=>f.now,readCase:options.workerDb?workerReads.readCase:undefined});
    await verifier.processNext((source,time)=>inspectGithubRun(source,{id:source.runId,run_attempt:1,head_sha:source.commit,repository:{full_name:`${source.owner}/${source.repository}`,private:false,id:123},updated_at:iso(time),status:'completed',conclusion:'success'},time));
    const publicIntent={visibility:'Public',purpose:'public-profile'};
    const preview=await f.proofs.preview(f.actor,{id:randomUUID(),evidenceId:evidence.id});
    const published=await f.proofs.publish(f.actor,await f.authorize(JSON.parse(preview.payloadJson),'proof.publish',publicIntent));
    const capsule={id:randomUUID(),capsuleId:randomUUID(),kind:'version',expectedRevision:0,version:1,title:'Indexed Capsule',problemPattern:'Compiler fixture',environment:{name:'Node',version:'24'},solutionStrategy:'Inspect dependencies',tools:[],skills:[],mcpRefs:[],verificationMethod:'Owner report',limitations:['Fixture'],capabilityId:'compiler',applicableScope:'Node',license:'MIT',contributors:[],sourceResolution:{caseId:privateCase.id,resultId:result.id,proofIds:[]},redactionConfirmed:true};
    await f.capsules.publish(f.actor,await f.authorize(capsule,'capsule.publish',publicIntent));
    await drain();
    assert.deepEqual((await index.candidates('proof',{subjectId:f.actor.subjectId})).items.map(i=>i.id),[published.proofId]);
    assert.deepEqual((await index.candidates('capsule',{subjectId:f.actor.subjectId})).items.map(i=>i.id),[capsule.capsuleId]);
    const proofPage=await f.search.query(null,{type:'proof',query:{subjectId:f.actor.subjectId}});
    assert.equal(proofPage.items[0].id,published.proofId);assert.ok(!JSON.stringify(proofPage).includes(privateCase.id));
    assert.equal((await f.search.query(null,{type:'capsule',query:{authorId:f.actor.subjectId}})).items[0].source.versionId,capsule.id);
    await f.consents.revoke(f.actor,privateCase.grant.consentId);
    assert.equal((await index.candidates('proof',{subjectId:f.actor.subjectId})).items.length,0);
    assert.equal((await index.candidates('capsule',{subjectId:f.actor.subjectId})).items.length,0);
    await drain();assert.equal((await f.search.query(null,{type:'proof',query:{subjectId:f.actor.subjectId}})).items.length,0);
    await index.configure({enabled:false});assert.equal((await own('case')).enabled,false);
    assert.equal((await f.db.query('SELECT * FROM search_documents')).rows.length,0);
  }finally{if(!database)await f.db.close();}
}
const iso=seconds=>new Date(seconds*1000).toISOString();
