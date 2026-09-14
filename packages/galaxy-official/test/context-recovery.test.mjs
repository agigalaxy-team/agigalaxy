import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createConnectionClient } from '../src/connection-client.mjs';
import { createContextFlow } from '../src/context-flow.mjs';
import { createLocalContextStore } from '../src/local-context-store.mjs';

test('Context drafts and acknowledgements survive restart and binding renewal without restoring expired or revoked access',async t=>{
  const scopes=['binding','consent','case-teaser','assistance','context'],f=await serviceFixture(scopes),p=await serviceFixture(scopes,f.db);
  const directory=await mkdtemp(join(tmpdir(),'galaxy-context-recovery-')),endpoint=f.access.endpoint;
  const api=createApi({...f,rateLimit:300});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`,hosts=new Map();let failure=null;
  t.after(async()=>{for(const h of hosts.values())h.sessions.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();await rm(directory,{recursive:true,force:true});});
  const send=async(url,input,method='POST')=>{
    const path=new URL(url).pathname,materialWrite=method==='POST'&&(path==='/v1/context-grants'||path.endsWith('/accept'));
    if(materialWrite&&failure==='before'){failure=null;throw new Error('Dropped before material write');}
    const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...(input.credential?{Authorization:`Bearer ${input.credential}`}:{})},
      ...(method==='POST'?{body:input.bodyJson}:{}),signal:input.signal});
    const result=await response.json();if(!response.ok)throw new Error(result.error??'Request rejected');
    if(materialWrite&&failure==='after'){failure=null;throw new Error('Lost material acknowledgement');}return result;
  };
  for(const [name,who] of [['owner',f],['provider',p]]){
    const dataDirectory=join(directory,name);await mkdir(dataDirectory);await writeFile(join(dataDirectory,'galaxy-id.json'),JSON.stringify(who.genesis));
    await writeFile(join(dataDirectory,'galaxy-local-state.json'),JSON.stringify({integration:{},cases:[{id:'preserved'}]}));
    const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});
    sessions.adopt({endpoint,subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,scopes:who.actor.scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>who.credential});
    const store=()=>createLocalContextStore({dataDirectory,endpoint});
    hosts.set(who,{dataDirectory,sessions,store,flow:(now=()=>f.now)=>createContextFlow({endpoint,sessions,journal:store(),now,signIntent:who.signForTest,
      consentSend:send,contextSend:send,contextRead:(url,input)=>send(url,input,'GET'),assistanceSend:send,assistanceRead:(url,input)=>send(url,input,'GET')})});
  }
  const owner=hosts.get(f),provider=hosts.get(p);
  const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'Material recovery',summary:'Selected Case teaser',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
  await f.cases.submit(f.actor,await f.authorize(root));
  const request={id:randomUUID(),caseId:root.id,title:'Compiler help',problem:'Compiler fails',attemptedApproaches:[],scope:'Read selected diagnostics',
    visibility:'Public',collaboration:'open-assistance',enrollmentExpiresAt:f.now+1000};
  await f.assistance.create(f.actor,await f.authorize(request,'assistance.publish',{visibility:'Public',purpose:'public-profile'}));
  let version=1;
  const event=async(who,kind,fields={})=>{
    const input={id:randomUUID(),kind,expectedVersion:version,...fields};
    version=(await f.assistance.submit(who.actor,request.id,await who.authorize({assistanceId:request.id,event:input},'assistance.publish',
      {objectId:input.id,viewers:[who===f?p.actor.subjectId:f.actor.subjectId]}))).version;return input;
  };
  const offer=await event(p,'offer',{proposal:'Inspect diagnostics',scope:request.scope});
  await event(f,'select',{offerId:offer.id});await event(p,'confirm');
  let draft=await owner.store().createDraft(await f.assistance.get(f.actor,request.id));
  draft=await owner.store().saveDraft({id:draft.id,expectedRevision:draft.revision,content:{...draft.content,step:'overview',
    materials:[{...draft.content.materials[0],label:'Selected diagnostic',content:'Synthetic compiler failure excerpt.'},{id:randomUUID(),label:'Selected version',content:'Compiler version 1'}]}});
  assert.equal((await owner.store().getDraft(draft.id)).content.materials.length,2);
  await assert.rejects(owner.store().saveDraft({id:draft.id,expectedRevision:1,content:draft.content}),/draft changed/);
  let flow=owner.flow();const preview=await flow.prepare({kind:'grant',assistanceId:request.id,draftId:draft.id,draftRevision:draft.revision});
  failure='after';await assert.rejects(flow.execute(preview,preview.confirmation),/Lost material/);
  flow=owner.flow();assert.equal((await flow.list()).items[0].status,'unknown');
  const acknowledged=await flow.reconcile(preview.eventId);assert.equal(acknowledged.state,'acknowledged');
  await assert.rejects(flow.prepareRetry(preview.eventId),/acknowledged/);
  assert.equal((await f.context.get(p.actor,preview.grantId)).contextAccessGranted,false);
  let acceptFlow=provider.flow();const accept=await acceptFlow.prepare({kind:'accept',grantId:preview.grantId});
  failure='before';await assert.rejects(acceptFlow.execute(accept,accept.confirmation),/Dropped/);
  const connection=createConnectionClient({endpoint,trustedKeys:f.bindings.trustedKeys,now:()=>f.now,send,sign:p.signForTest,assertCurrent:async()=>true});
  const connect=connection.prepare({subjectId:p.genesis.id,genesisProof:p.genesis.genesisProof,installationId:randomUUID(),scopes:p.actor.scopes});
  provider.sessions.adopt(await connection.execute(connect,connect.confirmation));acceptFlow=provider.flow();
  const retry=await acceptFlow.prepareRetry(accept.eventId);assert.equal(retry.payloadJson,accept.payloadJson);assert.notEqual(retry.intentJson,accept.intentJson);
  await acceptFlow.execute(retry,retry.confirmation);
  assert.equal((await acceptFlow.reconcile(retry.eventId)).state,'acknowledged');
  assert.equal((await f.context.get(p.actor,preview.grantId)).materials.length,2);
  const revoke=await flow.prepare({kind:'revoke',grantId:preview.grantId});await flow.execute(revoke,revoke.confirmation);
  await assert.rejects(f.context.get(p.actor,preview.grantId),/context_unavailable/);
  assert.equal((await flow.reconcile(preview.eventId)).state,'acknowledged');
  await assert.rejects(p.context.receipt(p.actor,{kind:'grant',grantId:preview.grantId,eventId:preview.eventId,payloadHash:acknowledged.payloadHash}),/not_found/);

  const pending=await flow.prepare({kind:'grant',assistanceId:request.id,materials:[{label:'Scope-bound excerpt',content:'Selected content'}],expiresAt:f.now+300});
  failure='before';await assert.rejects(flow.execute(pending,pending.confirmation));
  await event(f,'change-scope',{scope:request.scope,reason:'New scope confirmation event'});await event(p,'confirm-scope');
  await assert.rejects(owner.flow().prepareRetry(pending.eventId),/collaboration changed/);
  const expiring=await owner.flow().prepare({kind:'grant',assistanceId:request.id,materials:[{label:'Expiring excerpt',content:'Selected text'}],expiresAt:f.now+1});
  await assert.rejects(owner.flow(()=>f.now+2).prepareRetry(expiring.eventId),/expired/);
  const saved=await readFile(join(owner.dataDirectory,'galaxy-local-state.json'),'utf8');
  assert.equal(saved.includes(f.credential),false);assert.equal(saved.includes('PRIVATE KEY'),false);assert.deepEqual(JSON.parse(saved).cases,[{id:'preserved'}]);
  await owner.flow().forget(preview.eventId);assert.equal((await owner.store().listDrafts()).items.length,0);
});
