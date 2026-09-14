import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createBuilderClient } from '../src/builder-client.mjs';
import { conformanceChecks } from '../src/shared/builders-schema.mjs';
import { EvidenceService } from '../src/evidence.mjs';
import { ConsentReader } from '../src/consent-reader.mjs';
import { workerReads } from '../src/infrastructure/worker-reads.mjs';
import { inspectGithubRun } from '../src/github-evidence.mjs';

export function builderDeclaration(type,ownerId){
  const common={type,name:`Synthetic ${type}`,scope:'Fixture only',policy:'https://builder.example/policy',contact:'https://builder.example/contact',
    redactionConfirmed:true,proofIds:[],release:{version:'0.1.0',buildHash:'a'.repeat(64),sourceCommit:'b'.repeat(40),artifact:'https://builder.example/artifact',
      dependencies:[{name:'fixture',version:'1.0.0',sha256:'c'.repeat(64)}],upgrade:'Preserve existing node ID and local state',rollback:'Restore previous build with the same identity'}};
  if(type==='worker')return {...common,nodeId:ownerId,configuration:{id:'fixture-config-v1',summary:'Public model family and tools only',modelFamily:'fixture',tools:['compiler'],taskTypes:['coding'],maxConcurrentTasks:1},
    capabilities:[{id:'coding',claim:'Author-declared coding assistance',limitations:'No measured capability guarantee'}]};
  if(type==='bridge')return {...common,mapping:{sourceSystem:'Fixture tracker',sourceObjects:['result'],targetObjects:['Evidence'],rules:'Preserve raw source references and limited execution outcome',
    strengthCeiling:'source-assertion',authorization:'Owner grant',version:'1',deduplication:'Source event ID',revocation:'Invalidate linked projections',provenance:'Source authority remains the external tracker'}};
  return {...common,operator:'Fixture operator',charter:'https://hub.example/charter',region:'Fixture',endpoint:'https://hub.example',
    manifest:{url:'https://hub.example/manifest',sha256:'d'.repeat(64),specVersion:'unimplemented-fixture'},exit:'Revoke binding',export:'Owner exports selected data'};
}

export async function verifyBuildersWorkflow(db=null,options={}) {
  const scopes=['data-export','binding','consent','case-teaser','evidence','proof','history','assistance','context','notifications','moderation','capsules','builders'];
  const f=await serviceFixture(scopes,db,options),a=await serviceFixture(scopes,f.db,options),other=await serviceFixture(scopes,f.db,options);
  f.builders.assessorIds.add(a.actor.subjectId);
  const api=createApi({...f,rateLimit:200});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`,endpoint=f.bindings.endpoint;
  const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});
  sessions.adopt({endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>f.credential});
  const send=async(url,input)=>{const response=await fetch(origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',...(input.credential?{Authorization:`Bearer ${input.credential}`}:{})},body:input.bodyJson,signal:input.signal});
    const result=await response.json();if(response.status!==200)throw new Error(JSON.stringify(result));return result;};
  const client=createBuilderClient({endpoint,sessions,send}),publicGrant={visibility:'Public',purpose:'public-profile'};
  async function publish(who,payload,overrides=publicGrant){const authorization=await who.authorize(payload,'builder.publish',overrides);
    return {authorization,receipt:await f.builders.publish(who.actor,authorization)};}
  async function event(builderId,kind,fields,who=f){const current=await f.builders.get(who.actor,{builderId});
    return publish(who,{id:randomUUID(),builderId,expectedRevision:current.revision,kind,declarationId:current.declarationId,...fields});}
  try{
    const builderId=randomUUID(),declaration=builderDeclaration('worker',f.actor.subjectId),root={id:randomUUID(),builderId,kind:'declare',expectedRevision:0,declaration};
    const authorization=await f.authorize(root,'builder.publish',publicGrant);
    const canceled=client.prepare(authorization);client.cancel(canceled);await assert.rejects(client.execute(canceled,canceled.confirmation));
    const preview=client.prepare(authorization);await assert.rejects(client.execute(preview,'wrong'));
    const receipt=await client.execute(preview,preview.confirmation);assert.equal(receipt.revision,1);
    await assert.rejects(client.execute(preview,preview.confirmation));
    assert.deepEqual(await f.builders.publish(f.actor,authorization),receipt);
    const initial=await client.get({builderId});
    const viewTicket=await f.dataExport.create(other.actor,{id:randomUUID(),datasets:['authorized-views'],views:[{kind:'builder',id:builderId}]});
    const exportedBuilder=()=>f.dataExport.page(other.actor,{id:viewTicket.id,dataset:'authorized-views'});
    assert.deepEqual((await exportedBuilder()).items[0].view,await f.builders.get(other.actor,{builderId}));

    assert.equal(initial.registration.state,'registered');assert.equal(initial.compatibility.state,'unverified');
    assert.equal(initial.reachability.endpointReachable,null);assert.equal(initial.evidence.state,'none-current');
    assert.equal((await client.specification()).automaticEndpointProbes,false);
    assert.ok((await client.query({type:'worker',ownerId:f.actor.subjectId})).items.some(item=>item.builderId===builderId));
    assert.equal((await send(endpoint+'/v1/builders/read',{bodyJson:JSON.stringify({builderId})})).declaration.name,declaration.name);
    await assert.rejects(publish(other,{...root,id:randomUUID(),expectedRevision:1}),/owner_required/);
    await event(builderId,'heartbeat',{});
    assert.equal((await client.get({builderId})).reachability.state,'recent-owner-heartbeat');
    assert.equal((await client.get({builderId})).compatibility.state,'unverified');
    const report={profile:'galaxy-conformance/2',declarationHash:initial.declarationHash,suite:{name:'Synthetic conformance',version:'1.0',sha256:'e'.repeat(64),source:'https://assessor.example/suite'},
      observedAt:f.now,expiresAt:f.now+1000,checks:conformanceChecks.map(id=>({id,status:'pass',detail:'Fixture result; not a real external product test'})),limitations:'Assessor-reported test results; no task capability validation'};
    await assert.rejects(event(builderId,'compatibility',report,other),/assessor_required/);
    await assert.rejects(event(builderId,'compatibility',report),/assessor_required/);
    const passing=await event(builderId,'compatibility',report,a);
    assert.equal((await client.get({builderId})).compatibility.state,'reported-pass');
    const failed=await event(builderId,'compatibility',{...report,checks:report.checks.map(c=>c.id==='revocation'?{...c,status:'fail'}:c)},a);
    assert.equal((await client.get({builderId})).compatibility.state,'reported-fail');
    await f.consents.revoke(a.actor,failed.authorization.consentId);
    assert.equal((await client.get({builderId})).compatibility.state,'unverified'); // no fallback to older pass
    const newReport=await event(builderId,'compatibility',report,a);
    assert.equal((await exportedBuilder()).items[0].view.compatibility.state,'reported-pass');
    f.builders.assessorIds.delete(a.actor.subjectId);assert.equal((await client.get({builderId})).compatibility.state,'unverified');f.builders.assessorIds.add(a.actor.subjectId);
    const updated=await publish(f,{...root,id:randomUUID(),expectedRevision:(await client.get({builderId})).revision,declaration:{...declaration,name:'Revised worker'}});
    const revised=await client.get({builderId});assert.equal(revised.compatibility.state,'unverified');assert.equal(revised.reachability.state,'unknown');
    assert.ok(revised.reports.some(r=>r.id===newReport.receipt.eventId&&r.validity==='stale-declaration'));
    await assert.rejects(event(builderId,'compatibility',report,a),/report_mismatch/);
    const warning=await event(builderId,'maintenance',{action:'security-issue',summary:'Synthetic known issue'});
    await f.consents.revoke(f.actor,warning.authorization.consentId);
    assert.equal((await client.get({builderId})).securityIssue,true);assert.ok(!(await client.get({builderId})).notices.some(n=>n.id===warning.receipt.eventId));
    await event(builderId,'maintenance',{action:'resolve-security',summary:'Synthetic resolution'});
    await event(builderId,'maintenance',{action:'correction',summary:'Correct owner-declared scope'});
    await event(builderId,'maintenance',{action:'delist',summary:'Withdraw this listing'});
    assert.equal((await f.builders.query(null,{ownerId:f.actor.subjectId})).items.length,0);
    assert.equal((await f.builders.get(null,{builderId})).registration.state,'delisted');
    await event(builderId,'maintenance',{action:'relist',summary:'Restore corrected listing'});
    for(const type of ['bridge','hub']){
      const entry={id:randomUUID(),builderId:randomUUID(),kind:'declare',expectedRevision:0,declaration:builderDeclaration(type,f.actor.subjectId)};
      await publish(f,entry);assert.equal((await f.builders.get(null,{builderId:entry.builderId})).type,type);
    }
    const restricted={...root,id:randomUUID(),builderId:randomUUID()};await publish(f,restricted,{viewers:[a.actor.subjectId]});
    await assert.rejects(f.builders.get(null,{builderId:restricted.builderId}),/unavailable/);
    const privateView=await f.builders.get(a.actor,{builderId:restricted.builderId});
    await publish(a,{id:randomUUID(),builderId:restricted.builderId,kind:'compatibility',expectedRevision:privateView.revision,declarationId:privateView.declarationId,
      ...report,declarationHash:privateView.declarationHash},{viewers:[f.actor.subjectId,a.actor.subjectId]});
    assert.equal((await f.builders.get(f.actor,{builderId:restricted.builderId})).compatibility.state,'reported-pass');
    await f.consents.revoke(f.actor,updated.authorization.consentId);await assert.rejects(client.get({builderId}),/consent_required/); // no old public declaration fallback
    assert.ok(passing.receipt.eventId);

    // Evidence stays an owner-associated CI fact, even when linked to a Worker listing.
    const source={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Builder CI fixture',summary:'Synthetic',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(source));
    const attempt={id:randomUUID(),kind:'attempt',caseId:source.id,expectedVersion:1,sequence:1,approach:'Fixture',configuration:{environment:'Node',version:'24',tools:[]}};
    await f.cases.submit(f.actor,await f.authorize(attempt));
    const result={id:randomUUID(),kind:'result',caseId:source.id,expectedVersion:2,attemptId:attempt.id,outcome:'succeeded',summary:'Fixture',failureReason:'',limitations:['Synthetic']};
    await f.cases.submit(f.actor,await f.authorize(result));
    const submission={id:randomUUID(),caseId:source.id,resultId:result.id,source:{provider:'github-actions',owner:'fixture',repository:'builder-'+builderId.slice(0,8),runId:1,attempt:1,commit:'a'.repeat(40)}};
    await f.evidence.submit(f.actor,await f.authorize(submission,'evidence.submit'));
    const worker=new EvidenceService(null,new ConsentReader({now:()=>f.now,readGrant:options.workerDatabase?workerReads.readGrant:undefined}),{db:options.workerDatabase??f.db,endpoint,now:()=>f.now,readCase:options.workerDatabase?workerReads.readCase:undefined});
    await worker.processNext((input,now)=>inspectGithubRun(input,{id:1,run_attempt:1,head_sha:input.commit,repository:{full_name:`${input.owner}/${input.repository}`,private:false,id:123},updated_at:new Date(now*1000).toISOString(),status:'completed',conclusion:'success'},now));
    const proofPreview=await f.proofs.preview(f.actor,{id:randomUUID(),evidenceId:submission.id});
    const proof=await f.proofs.publish(f.actor,await f.authorize(JSON.parse(proofPreview.payloadJson),'proof.publish',publicGrant));
    const evidenceRoot={...root,id:randomUUID(),builderId:randomUUID(),declaration:{...declaration,proofIds:[proof.proofId]}};
    await publish(f,evidenceRoot);const evidenceView=await f.builders.get(null,{builderId:evidenceRoot.builderId});
    assert.equal(evidenceView.evidence.state,'owner-ci-evidence');assert.equal(evidenceView.evidence.builderAttributionVerified,false);
    await assert.rejects(publish(other,{...evidenceRoot,id:randomUUID(),builderId:randomUUID()}),/proof_owner_mismatch/);
    await f.proofs.revoke(f.actor,proof.proofId);assert.equal((await f.builders.get(null,{builderId:evidenceRoot.builderId})).evidence.state,'none-current');
    const audit=(await f.db.query("SELECT * FROM audit_events WHERE action='builder.event' AND actor IN ($1,$2)",[f.actor.subjectId,a.actor.subjectId])).rows;
    assert.ok(audit.length>=15);assert.ok(audit.every(row=>row.context_version===1&&row.scope==='builders'));assert.ok(!JSON.stringify(audit).includes('Synthetic'));
    sessions.close();await assert.rejects(client.get({builderId:evidenceRoot.builderId}),/authorization required/);
  }finally{sessions.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!db)await f.db.close();}
}
