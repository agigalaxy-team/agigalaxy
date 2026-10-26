import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationalSnapshot } from '../src/infrastructure/operational-snapshot.mjs';
import { serviceFixture } from './service-fixture.mjs';
import { builderDeclaration } from './builders-workflow.mjs';
import { sdkPeer } from '../../galaxy-a2a/test/sdk-peer.mjs';
import { BuilderProbeWorker } from "../src/builders/builder-probes.mjs";
import { observeBuilderEndpoint } from "../src/builders/builder-probe-observer.mjs";
import { ConsentReader } from "../src/consents/consent-reader.mjs";
import { workerReads } from '../src/infrastructure/worker-reads.mjs';
import { defaultResourceBudgetPolicy } from '../src/infrastructure/resource-budgets.mjs';
import { approveFixtureDeletion } from './deletion-execute-workflow.mjs';
import { executeDeletion } from '../src/operations/deletion-execute.mjs';

export async function verifyBuilderProbes(db=null,options={}){
  const scopes=['binding','consent','builders','data-export','data-delete'],f=await serviceFixture(scopes,db,options),node=await serviceFixture(scopes,f.db,options);
  const peer=await sdkPeer(),target={protocol:'a2a/1.0',transport:'JSONRPC',endpoint:peer.endpoint,cardUrl:'https://peer.example.org/.well-known/agent-card.json',tenant:'fixture'};
  const publicGrant={visibility:'Public',purpose:'public-profile'};let time=f.now;
  f.access.now=()=>time;
  const workerOptions={db:options.workerDatabase??f.db,consents:new ConsentReader({now:()=>time,readGrant:options.workerDatabase?workerReads.readGrant:undefined}),
    readBuilder:options.workerDatabase?workerReads.readBuilder:undefined,endpoint:f.bindings.endpoint,now:()=>time,resourceBudgetPolicy:defaultResourceBudgetPolicy};
  const observe=(input,args)=>observeBuilderEndpoint(input,{...args,get:url=>peer.get(url),post:(url,options)=>peer.post(url,options)});
  const worker=new BuilderProbeWorker({...workerOptions,observe});
  async function publish(who,event,disclosure=publicGrant){const authorization=await who.authorize(event,'builder.publish',disclosure);return {event,authorization,receipt:await f.builders.publish(who.actor,authorization)};}
  async function event(builderId,kind,who=node,fields={},disclosure=publicGrant){
    const current=await f.builders.get(who.actor,{builderId});
    return publish(who,{id:randomUUID(),builderId,expectedRevision:current.revision,kind,declarationId:current.declarationId,
      ...(kind==='probe-request'?{declarationHash:current.declarationHash,nodeId:node.actor.subjectId,controlId:current.nodeControl.controlId,target:current.declaration.a2a}:{}),...fields},disclosure);
  }
  async function entry(disclosure=publicGrant,a2a=target){
    const created=await publish(f,{id:randomUUID(),builderId:randomUUID(),kind:'declare',expectedRevision:0,declaration:{...builderDeclaration('worker',node.actor.subjectId),a2a}},disclosure);
    const builderId=created.event.builderId,current=await f.builders.get(node.actor,{builderId});
    const nodeDisclosure=disclosure===publicGrant?publicGrant:{viewers:[f.actor.subjectId]};
    await event(builderId,'node-control',node,{declarationHash:current.declarationHash,ownerId:f.actor.subjectId,nodeId:node.actor.subjectId,expiresAt:f.now+3000},nodeDisclosure);
    return builderId;
  }
  const read=builderId=>f.builders.get(null,{builderId});
  try{
    const id=await entry(),request=await event(id,'probe-request');
    assert.equal((await read(id)).reachability.state,'pending');assert.equal(peer.requests.length,0);
    assert.deepEqual(await f.builders.publish(node.actor,request.authorization),request.receipt);
    await assert.rejects(event(id,'probe-request'),/cooldown/);
    await assert.rejects(event(id,'probe-request',f),/node_holder_required/);
    assert.deepEqual(await worker.processNext(),{processed:true,state:'reachable'});
    const current=await read(id);assert.equal(current.reachability.state,'reachable');assert.equal(current.reachability.endpointReachable,true);
    assert.equal(current.reachability.observation.authority,'registry-worker-public-observation');assert.equal(current.compatibility.state,'unverified');assert.equal(current.evidence.state,'none-current');
    assert.equal((await f.builders.query(null,{ownerId:f.actor.subjectId})).items[0].reachability.state,'reachable');
    assert.equal(peer.requests.length,1);assert.equal(peer.requests[0].body.method,'GetTask');
    const exportTicket=await f.dataExport.create(node.actor,{id:randomUUID(),datasets:['builder-probes']});
    assert.equal((await f.dataExport.page(node.actor,{id:exportTicket.id,dataset:'builder-probes'})).items[0].observation.status,'reachable');
    const ownerTicket=await f.dataExport.create(f.actor,{id:randomUUID(),datasets:['builder-probes']});
    assert.equal((await f.dataExport.page(f.actor,{id:ownerTicket.id,dataset:'builder-probes'})).items.length,0);
    time=f.now+301;assert.equal((await read(id)).reachability.state,'expired');assert.equal((await read(id)).reachability.endpointReachable,null);time=f.now;
    await f.consents.revoke(node.actor,request.authorization.consentId);
    assert.equal((await read(id)).reachability.endpointReachable,null);assert.equal((await read(id)).reachability.observation,undefined);
    if(options.workerDatabase)await assert.rejects(f.db.query('INSERT INTO builder_probes(id,request_id,job_id,attempt,observation) VALUES($1,$2,$3,2,$4)',
      [randomUUID(),request.event.id,randomUUID(),'{}']),/permission denied/);

    const privateId=randomUUID(),privateGrant={viewers:[node.actor.subjectId]};
    await publish(f,{id:randomUUID(),builderId:privateId,expectedRevision:0,kind:'declare',declaration:{...builderDeclaration('worker',f.actor.subjectId),a2a:target}},privateGrant);
    const privateView=await f.builders.get(f.actor,{builderId:privateId});
    await event(privateId,'node-control',f,{nodeId:f.actor.subjectId,ownerId:f.actor.subjectId,declarationHash:privateView.declarationHash,expiresAt:f.now+3000},privateGrant);
    await event(privateId,'probe-request',f,{nodeId:f.actor.subjectId},privateGrant);
    assert.equal((await worker.processNext()).processed,false);time+=61;await worker.processNext(); // Same origin cooldown spans distinct Nodes and registrations.
    await assert.rejects(read(privateId),/unavailable/);assert.equal((await f.builders.get(f.actor,{builderId:privateId})).reachability.endpointReachable,true);

    time+=61;const revokedId=await entry(),revoked=await event(revokedId,'probe-request');
    await f.consents.revoke(node.actor,revoked.authorization.consentId);const calls=peer.requests.length;
    assert.equal((await worker.processNext()).state,'revoked');assert.equal(peer.requests.length,calls);

    time+=61;const changedId=await entry();await event(changedId,'probe-request');
    const changing=new BuilderProbeWorker({...workerOptions,observe:async(input,args)=>{
      const result=await observe(input,args),current=await f.builders.get(f.actor,{builderId:changedId});
      await publish(f,{id:randomUUID(),builderId:changedId,expectedRevision:current.revision,kind:'declare',declaration:{...current.declaration,name:'Changed during probe'}});
      return result;
    }});
    assert.equal((await changing.processNext()).state,'revoked');assert.equal((await read(changedId)).reachability.endpointReachable,null);

    time+=61;const offlineId=await entry();await event(offlineId,'probe-request');
    const offline=new BuilderProbeWorker({...workerOptions,observe:(input,args)=>observeBuilderEndpoint(input,{...args,get:url=>peer.get(url),post:()=>{throw new Error('Fixture offline');}})});
    for(let attempt=1;attempt<=3;attempt++){
      assert.equal((await offline.processNext()).state,'unavailable');
      const view=await read(offlineId);assert.equal(view.reachability.job.attempts,attempt);
      assert.equal(view.reachability.job.state,attempt===3?'failed':'pending');if(attempt<3)time+=60;
    }
    assert.equal((await worker.processNext()).processed,false);

    time+=61;const leasedId=await entry();await event(leasedId,'probe-request');
    let release,started;const ready=new Promise(resolve=>{started=resolve;});
    const slow=new BuilderProbeWorker({...workerOptions,observe:async(input,args)=>{started();await new Promise(resolve=>{release=resolve;});return observe(input,args);}});
    const first=slow.processNext();await ready;
    assert.equal((await worker.processNext()).processed,false); // Live per-subject/global lease is respected.
    time+=61;assert.equal((await worker.processNext()).state,'reachable');release();assert.equal((await first).leaseLost,true);
    assert.equal((await read(leasedId)).reachability.job.attempts,2);

    const unsafeId=await entry(publicGrant,{...target,endpoint:'https://127.0.0.1/a2a'});await assert.rejects(event(unsafeId,'probe-request'),/target_required/);
    time+=61;const limitedId=await entry(),otherId=await entry();
    f.access.resourceBudgetPolicy={...defaultResourceBudgetPolicy,maxQueuedJobsPerSubject:1};
    const limited=await event(limitedId,'probe-request');await assert.rejects(event(otherId,'probe-request'),/job_queue_quota_exceeded/);
    await f.consents.revoke(node.actor,limited.authorization.consentId);await worker.processNext();
    assert.equal((await worker.processNext()).processed,false);
    assert.ok((await f.db.query("SELECT * FROM audit_events WHERE action='builder.probe.observe' AND consent_id=$1",[request.authorization.consentId])).rows.length===1);
    if(options.onRevocationCheck)for(const kind of ['declare','node-control']){
      time+=61;
      // Earlier cooldown/lease scenarios have advanced beyond the original600s session.
      // Use fresh signed fixture sessions for this independent dependency scenario.
      const owner=await serviceFixture(scopes,f.db,{...options,now:time}),holder=await serviceFixture(scopes,f.db,{...options,now:time}),dependentId=randomUUID();
      const declare={id:randomUUID(),builderId:dependentId,kind:'declare',expectedRevision:0,declaration:{...builderDeclaration('worker',holder.actor.subjectId),a2a:target}};
      await owner.builders.publish(owner.actor,await owner.authorize(declare,'builder.publish',publicGrant));
      let current=await owner.builders.get(holder.actor,{builderId:dependentId});
      const control={id:randomUUID(),builderId:dependentId,kind:'node-control',expectedRevision:current.revision,declarationId:current.declarationId,
        declarationHash:current.declarationHash,ownerId:owner.actor.subjectId,nodeId:holder.actor.subjectId,expiresAt:time+1000};
      await owner.builders.publish(holder.actor,await holder.authorize(control,'builder.publish',publicGrant));
      current=await owner.builders.get(holder.actor,{builderId:dependentId});
      const probe={id:randomUUID(),builderId:dependentId,kind:'probe-request',expectedRevision:current.revision,declarationId:current.declarationId,
        declarationHash:current.declarationHash,nodeId:holder.actor.subjectId,controlId:control.id,target:current.declaration.a2a};
      await owner.builders.publish(holder.actor,await holder.authorize(probe,'builder.publish',publicGrant));
      const ancestor=(await f.db.query('SELECT consent_id FROM builder_events WHERE builder_id=$1 AND kind=$2',[dependentId,kind])).rows[0];
      await owner.consents.revoke(kind==='declare'?owner.actor:holder.actor,ancestor.consent_id);const revokedAt=performance.now();
      const snapshot=await operationalSnapshot(f.db,time*1000);assert.equal(snapshot.revoked_jobs,0);assert.equal(snapshot.dependent_revoked_jobs,1);
      const calls=peer.requests.length;assert.equal((await worker.processNext()).state,'revoked');assert.equal(peer.requests.length,calls);
      options.onRevocationCheck({surface:'builder-'+kind+'-worker',afterCommitObservedMs:performance.now()-revokedAt,passed:true});
      assert.equal((await operationalSnapshot(f.db,time*1000)).dependent_revoked_jobs,0);
    }
    const admin=options.adminDatabase??f.db,command=await approveFixtureDeletion(node,admin);
    const deleted=await executeDeletion(admin,command,{now:()=>time});
    assert.ok(deleted.deletedCounts.builder_probes>=7);
    assert.equal((await f.db.query("SELECT * FROM jobs WHERE kind='builder-probe' AND payload->>'subjectId'=$1",[node.actor.subjectId])).rows.length,0);
  }finally{f.access.now=()=>f.now;await peer.close();if(!db)await f.db.close();}
}
