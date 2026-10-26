import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import { createExistingWebRuntime } from './existing-web-identity-fixture.mjs';
import {getContributionClient} from "../../galaxy-web/src/features/work-records/contribution-client.mjs";
import {nativeWork} from './qualification-v2-workflow.mjs';
import {HonorService} from "../src/records/honor.mjs";

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function fixture(){
  const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),api=createApi({...f,rateLimit:1000}),data=new Map();
  let runtime,onPut,onGet,loseWrite=false,offlineStatus=false;
  const writes=[];
  const store={get:async key=>{const value=structuredClone(data.get(key));await onGet?.(key,value);return value;},
    put:async(key,value)=>{data.set(key,structuredClone(value));await onPut?.(key,value);},update:memoryAtomicUpdate(data,async(key,value)=>{await onPut?.(key,value);})};
  try{
    await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`;
    runtime=await createExistingWebRuntime({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{store,now:()=>f.now,
      fetch:async(url,options)=>{const path=new URL(url).pathname;
        if(offlineStatus&&path==='/v2/contributions/status')throw new Error('synthetic offline status');
        if(path==='/v1/consents'||path==='/v2/contributions/publish')writes.push(path);
        const response=await fetch(origin+path,options);
        if(loseWrite&&path==='/v2/contributions/publish'){loseWrite=false;assert.equal(response.status,200);throw new Error('synthetic lost contribution reply');}return response;}});
    await runtime.connect({confirmed:true});
    const subjectId=runtime.api.snapshot().subjectId,id=randomUUID(),root={kind:'case-created',schemaVersion:2,eventId:id,caseId:id,expectedVersion:0,
      actorId:subjectId,localRef:randomUUID(),title:'PRIVATE SYNTHETIC CASE',summary:'Do not expose the original body',source:{kind:'local',reference:randomUUID()},synthetic:true};
    await runtime.api.call('/v2/cases/events',await runtime.api.authorizePayload(root,{action:'case.teaser.publish',objectId:id,confirmed:true}));
    const owned=await runtime.api.call('/v2/contributions/sources',{kind:'case-event',parentId:id});
    const input={id:randomUUID(),kind:'publish',sourceRefs:[{...owned.items[0].source,fields:['eventType','actorId']}],purposes:['honor'],
      purpose:'public-contribution-projections-only',expiresAt:new Date((f.now+86400)*1000).toISOString(),redactionConfirmed:true,
      publicationScope:'selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged'};
    writes.length=0;
    return{...f,runtime,subjectId,input,writes,
      setPut:fn=>{onPut=fn;},setGet:fn=>{onGet=fn;},
      loseWrite:()=>{loseWrite=true;},offlineStatus:value=>{offlineStatus=value;},
      http:async(path,input,credential)=>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(input)});
        const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;},
      count:async()=>Number((await f.db.query('SELECT count(*) FROM contribution_publications WHERE subject_id=$1',[subjectId])).rows[0].count),
      close:async()=>{runtime.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}};
  }catch(error){runtime?.close();if(api.listening){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}await f.db.close();throw error;}
}

test('a real reconnect after Consent returns cannot dispatch the previously confirmed publication',async()=>{
  const f=await fixture();try{
    const original=f.runtime.api.snapshot();let changed=false;
    const runtime={...f.runtime,api:{...f.runtime.api,submitAuthorization:async(...args)=>{
      const result=await f.runtime.api.submitAuthorization(...args);
      if(!changed){changed=true;await f.runtime.connect({confirmed:true});}return result;
    }}};
    const client=getContributionClient(runtime,f.subjectId);
    const outcome=await client.submit(f.input,{confirmed:true}).then(value=>({value}),error=>({error}));
    assert.equal(f.runtime.api.snapshot().subjectId,original.subjectId);assert.notEqual(f.runtime.api.snapshot().bindingId,original.bindingId);
    assert.ok(f.runtime.api.snapshot().generation>original.generation);
    assert.equal(await f.count(),0);assert.equal(f.writes.filter(p=>p==='/v2/contributions/publish').length,0);
    assert.match(outcome.error?.message??'publication succeeded',/身份或连接已变化/);
    const pending=(await client.local()).pending;assert.equal(pending.payload.id,f.input.id);assert.ok(pending.payloadHash);assert.equal(pending.attempted,false);
  }finally{await f.close();}
});

test('a real reconnect at the original journal commit withholds new Consent and business writes',async()=>{
  const f=await fixture();try{
    let changed=false;f.setPut(async(key,value)=>{if(!changed&&key.includes('contribution-operations:')&&value.pending){changed=true;await f.runtime.connect({confirmed:true});}});
    const client=getContributionClient(f.runtime,f.subjectId);
    const outcome=await client.submit(f.input,{confirmed:true}).then(value=>({value}),error=>({error}));
    assert.equal(await f.count(),0);assert.deepEqual(f.writes,[]);
    assert.match(outcome.error?.message??'publication succeeded',/身份或连接已变化/);
    const pending=(await client.local()).pending;assert.equal(pending.payload.id,f.input.id);assert.equal(pending.attempted,false);
    assert.equal((await client.reconcile()).state,'unconfirmed');
    assert.equal(await f.count(),0,'querying the original absent operation does not repeat the user action');
    assert.equal((await client.reconcile({retry:true,confirmed:true})).state,'published','a new explicit confirmation may continue the same business operation');
    assert.equal(await f.count(),1);assert.equal((await client.local()).publications[0].publicationId,f.input.id);
  }finally{await f.close();}
});

test('a queued confirmation belongs to its enqueue connection and private journal reads are withheld after reconnect',async()=>{
  const f=await fixture(),entered=deferred(),release=deferred();try{
    let blocked=false;f.setGet(async key=>{if(!blocked&&key.includes('contribution-operations:')){blocked=true;entered.resolve();await release.promise;}});
    const client=getContributionClient(f.runtime,f.subjectId),first=client.reconcile();
    await entered.promise;const second=client.submit(f.input,{confirmed:true});
    const settled=Promise.allSettled([first,second]);await f.runtime.connect({confirmed:true});release.resolve();
    const results=await settled;assert.equal(await f.count(),0);assert.deepEqual(results.map(r=>r.status),['rejected','rejected']);
    for(const result of results)assert.match(result.reason.message,/身份或连接已变化/);
    assert.equal(await f.count(),0);assert.deepEqual(f.writes,[]);
    assert.equal((await client.reconcile()).state,'none');
  }finally{release.resolve();await f.close();}
});

test('hashing and preparation waits cannot renew an old confirmation on a real new binding',async()=>{
  for(const stage of ['hash','prepare']){
    const f=await fixture(),digestMethod=Reflect.get(crypto.subtle,'digest');try{
      let changed=false,runtime=f.runtime;
      if(stage==='hash')crypto.subtle.digest=async function(...args){
        const value=await digestMethod.apply(this,args);
        if(!changed&&new TextDecoder().decode(args[1]).includes(f.input.id)){changed=true;await f.runtime.connect({confirmed:true});}return value;
      };
      else runtime={...f.runtime,api:{...f.runtime.api,prepareAuthorization:async(...args)=>{
        const value=await f.runtime.api.prepareAuthorization(...args);if(!changed){changed=true;await f.runtime.connect({confirmed:true});}return value;
      }}};
      const client=getContributionClient(runtime,f.subjectId);
      await assert.rejects(client.submit(f.input,{confirmed:true}),/身份或连接已变化/);
      assert.equal(changed,true);assert.deepEqual(f.writes,[]);assert.equal(await f.count(),0);
      const local=await client.local();assert.equal(local.pending?.payload.id??null,stage==='hash'?null:f.input.id);
    }finally{crypto.subtle.digest=digestMethod;await f.close();}
  }
});

test('private local records are withheld after a different identity becomes current during storage reading',async()=>{
  const f=await fixture();try{
    f.loseWrite();const client=getContributionClient(f.runtime,f.subjectId);
    await assert.rejects(client.submit(f.input,{confirmed:true}),/lost contribution/);
    const saved=(await client.local()).pending;
    // The storage-completion hook selects a real independently bound fixture
    // subject. It does not substitute a business or authorization response.
    const second=await serviceFixture(browserScopes,f.db,{now:f.now,migrateDatabase:false});let current=f.runtime.api.snapshot();
    const runtime={...f.runtime,api:{...f.runtime.api,snapshot:()=>current},getLocal:async key=>{const value=await f.runtime.getLocal(key);current={subjectId:second.actor.subjectId,bindingId:second.actor.bindingId,generation:1};return value;}};
    await assert.rejects(getContributionClient(runtime,f.subjectId).local(),/身份或连接已变化/);
    assert.equal((await client.local()).pending.payloadJson,saved.payloadJson);assert.equal(await f.count(),1);
  }finally{await f.close();}
});

test('a reconnect after the original status reply withholds it and retains the exact pending locator without resending',async()=>{
  const f=await fixture();try{
    f.loseWrite();const client=getContributionClient(f.runtime,f.subjectId);
    await assert.rejects(client.submit(f.input,{confirmed:true}),/lost contribution/);
    const original=(await client.local()).pending,writes=f.writes.length;let changed=false;
    const runtime={...f.runtime,api:{...f.runtime.api,call:async(path,...args)=>{
      const result=await f.runtime.api.call(path,...args);
      if(!changed&&path==='/v2/contributions/status'){changed=true;await f.runtime.connect({confirmed:true});}return result;
    }}},recover=getContributionClient(runtime,f.subjectId);
    await assert.rejects(recover.reconcile({retry:true,reauthorize:true,confirmed:true}),/身份或连接已变化/);
    assert.equal(f.writes.length,writes);assert.equal(await f.count(),1);
    const retained=(await recover.local()).pending;assert.equal(retained.payloadJson,original.payloadJson);assert.equal(retained.payloadHash,original.payloadHash);
    assert.equal((await recover.reconcile()).state,'published');assert.equal(f.writes.length,writes);assert.equal((await recover.local()).pending,null);
  }finally{await f.close();}
});

test('real signed publication and lost ACK project Honor and requester facts, then exact withdrawal removes only public permission',async()=>{
  const f=await fixture();try{
    const p=await serviceFixture(browserScopes,f.db,{now:f.now,migrateDatabase:false}),owner={subjectId:f.subjectId};
    const send=(actor,path,input)=>actor.subjectId===f.subjectId?f.runtime.api.call(path,input):f.http(path,input,p.credential);
    const browser={now:f.now,actor:owner,authorize:(payload,action,options)=>f.runtime.api.authorizePayload(payload,{...options,action,confirmed:true}),
      assistance:{createTask:(actor,input)=>send(actor,'/v2/tasks',input),
        proposeParticipation:(actor,id,input)=>send(actor,`/v2/tasks/${id}/participations`,input),
        submitParticipationEvent:(actor,id,input)=>send(actor,`/v2/participations/${id}/events`,input)},
      cases:{createAndLinkTask:(actor,input)=>send(actor,`/v2/tasks/${input.taskId}/case`,input),submitV2:(actor,input)=>send(actor,'/v2/cases/events',input)}};
    const work=await nativeWork(browser,p);
    const policy={id:'synthetic-browser-contribution',version:'1',sourceProfile:'facts-v2',title:'合成有限贡献规则',capabilityId:'software-debugging',communityId:'synthetic',
      kind:'open-contributor',members:[f.subjectId,p.actor.subjectId],relatedPartyGroups:[],notBefore:f.now-1,notAfter:f.now+1000,
      windowFrom:f.now-1000,windowUntil:f.now+1,minAcceptedCases:1,minProofs:0,repositories:[],rankingEnabled:false,privacyReview:'pending',minimumCohort:5,minimumCasesPerMember:3};
    Object.assign(f.honor,new HonorService(f.access,f.assistance,f.proofs,[policy]));
    const rows=[...(await f.db.query('SELECT * FROM task_events WHERE task_id=$1',[work.open.taskId])).rows.map(r=>({...r,sourceKind:'task-event'})),
      ...(await f.db.query('SELECT * FROM case_events WHERE case_id=$1',[work.cid])).rows.map(r=>({...r,sourceKind:'case-event'}))];
    const refs=subject=>rows.filter(r=>r.subject_id===subject).map(r=>({kind:r.sourceKind,id:r.id,eventVersion:1,payloadHash:r.payload_hash,fields:['eventType','actorId']}));
    const provider={...f.input,id:randomUUID(),sourceRefs:refs(p.actor.subjectId),purposes:['honor','requester-history']};
    await f.http('/v2/contributions/publish',await p.authorize(provider,'contribution.publish',{objectId:provider.id,visibility:'Public',purpose:'public-profile'}),p.credential);
    const query={ruleId:policy.id,ruleVersion:'1',subjectId:p.actor.subjectId,includeSimulation:true};
    assert.equal((await f.http('/v2/honor/query',query)).items.length,0);
    assert.equal((await f.http('/v2/requester-history/query',{subjectId:f.subjectId})).items.length,0);
    const client=getContributionClient(f.runtime,f.subjectId),publish={...f.input,id:randomUUID(),sourceRefs:refs(f.subjectId),purposes:['honor','requester-history']};
    f.loseWrite();await assert.rejects(client.submit(publish,{confirmed:true}),/lost contribution/);
    const original=(await client.local()).pending,writeCount=f.writes.length;
    f.offlineStatus(true);await assert.rejects(client.reconcile({retry:true,reauthorize:true,confirmed:true}),/offline status/);
    assert.equal(f.writes.length,writeCount);assert.equal((await client.local()).pending.payloadJson,original.payloadJson);
    f.offlineStatus(false);await f.runtime.connect({confirmed:true});
    assert.equal((await client.reconcile({retry:true,reauthorize:true,confirmed:true})).state,'published');
    assert.equal(f.writes.length,writeCount,'an accepted original operation is read, without a new Consent or publication');
    const honor=await f.http('/v2/honor/query',query),history=await f.http('/v2/requester-history/query',{subjectId:f.subjectId});
    assert.equal(honor.items.length,1);assert.equal(honor.simulation.distinctCases,1);assert.equal(honor.card.capabilityVerified,false);
    assert.equal(honor.card.status,'insufficient-evidence');assert.equal(history.items.length,1);assert.equal(history.globalScore,null);
    for(const privateValue of [work.open.title,work.cid,work.result.summary])assert.equal(JSON.stringify({honor,history}).includes(privateValue),false);
    f.loseWrite();const revoke={id:randomUUID(),kind:'revoke',publicationId:publish.id,reason:'撤销本次公开投影'};
    await assert.rejects(client.submit(revoke,{confirmed:true}),/lost contribution/);
    const revokePending=(await client.local()).pending;assert.equal(revokePending.payload.id,revoke.id);
    assert.equal((await client.reconcile({retry:true,reauthorize:true,confirmed:true})).state,'revoked');
    assert.equal((await f.http('/v2/honor/query',query)).items.length,0);assert.equal((await f.http('/v2/requester-history/query',{subjectId:f.subjectId})).items.length,0);
    const stillPrivate=await f.runtime.api.call(`/v2/cases/${work.cid}/read`,{});assert.equal(stillPrivate.caseId,work.cid);
    assert.equal((await client.local()).pending,null);assert.equal((await client.refresh()).find(x=>x.publicationId===publish.id).state,'revoked');
    // A separate explicitly selected publication tests withdrawal of the
    // underlying authors' permissions while its accepted ACK is still unknown.
    const later={...publish,id:randomUUID()};f.loseWrite();await assert.rejects(client.submit(later,{confirmed:true}),/lost contribution/);
    const laterPending=(await client.local()).pending;
    for(const id of [work.r.eventId,work.open.operationId]){
      const row=rows.find(r=>r.id===id);await f.runtime.api.call(`/v1/consents/${row.consent_id}/revoke`,{});
    }
    const beforeReceipt=f.writes.length,status=await client.reconcile({retry:true,reauthorize:true,confirmed:true});
    assert.equal(status.state,'source-unavailable');assert.equal(status.payloadHash,laterPending.payloadHash);assert.equal(f.writes.length,beforeReceipt);
    assert.equal((await f.db.query('SELECT payload_text FROM contribution_publications WHERE id=$1',[later.id])).rows[0].payload_text,laterPending.payloadJson);
    assert.equal((await f.http('/v2/honor/query',query)).items.length,0);assert.equal((await f.http('/v2/requester-history/query',{subjectId:f.subjectId})).items.length,0);
    const {fields:_,...source}=later.sourceRefs.find(r=>r.id===work.open.operationId);
    await assert.rejects(f.runtime.api.call('/v2/contributions/read',{source,purpose:'requester-history'},{authenticated:false}),error=>error.code==='consent_required');
  }finally{await f.close();}
});
import {memoryAtomicUpdate} from './memory-atomic-update.mjs';
