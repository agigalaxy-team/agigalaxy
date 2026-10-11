import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createHelpRuntimeV2 } from '../src/help-runtime-v2.mjs';
import { createLocalHelpStoreV2 } from '../src/local-help-store-v2.mjs';

const id = () => randomUUID();

test('help actions use exact signed HTTP writes, independent participants and materials; lost ACK, withdrawal, delivery and original-work return remain separate', { timeout: 90000 }, async () => {
  const scopes = ['binding','consent','assistance','context','case-teaser','history'], now = Math.floor(Date.now()/1000);
  const f = await serviceFixture(scopes, null, { now }), p = await serviceFixture(scopes, f.db, { migrateDatabase:false, now }),
    q = await serviceFixture(scopes, f.db, { migrateDatabase:false, now });
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-help-actions-'));
  const api = createApi({ ...f, rateLimit:1000 }); await new Promise(resolve => api.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${api.address().port}`, endpoint = f.access.endpoint, runtimes = new Map(), memories = [], authorizations = new Map();
  let losePath = null, calls = 0, switchIdentityAfterConsent = false, changeAuthorizedPayload = false;
  for (const [index, who] of [f,p,q].entries()) {
    const folder = join(directory, String(index));
    const { mkdir } = await import('node:fs/promises'); await mkdir(folder); await writeFile(join(folder,'galaxy-id.json'),JSON.stringify(who.genesis));
    const sessions = createSessionMemory({now:()=>now,isCurrent:async()=>true}); memories.push(sessions);
    sessions.adopt({endpoint,subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,scopes,expiresAt:now+500,bindingExpiresAt:now+900,takeCredential:()=>who.credential});
    const send = async (url, options, method='POST') => {
      const path = new URL(url).pathname; calls++;
      const response = await fetch(origin+path,{method,headers:{'content-type':'application/json',authorization:`Bearer ${options.credential}`},
        ...(method==='POST'?{body:options.bodyJson}:{}),signal:options.signal});
      const result=await response.json(); if(!response.ok) throw Object.assign(new Error(result.error),{code:result.error});
      if(path===losePath){losePath=null;throw new Error('Synthetic lost response after actual server commit');} return result;
    };
    const authorize = async input => {
      const key = who.actor.subjectId+':'+input.requestId;
      if(!authorizations.has(key)) authorizations.set(key,await who.authorize(JSON.parse(input.payloadJson),input.action,{objectId:input.objectId,
        visibility:input.visibility,viewers:input.viewers,expiresAt:input.expiresAt,purpose:input.visibility==='Public'?'public-profile':'operational'}));
      if(who===f&&switchIdentityAfterConsent){switchIdentityAfterConsent=false;await writeFile(join(folder,'galaxy-id.json'),JSON.stringify(p.genesis));}
      return changeAuthorizedPayload ? {...authorizations.get(key),payloadJson:'{}'} : authorizations.get(key);
    };
    runtimes.set(who,{folder,runtime:()=>createHelpRuntimeV2({dataDirectory:folder,endpoint,subjectId:who.actor.subjectId,sessions,send,
      read:(url,options)=>send(url,options,'GET'),now:()=>now,authorize})});
  }
  const flow = who => runtimes.get(who).runtime();
  const prepare = (who, session, kind, payload, extra={}) => flow(who).prepareAction(session.id,{kind,payloadJson:JSON.stringify(payload),...extra});
  const execute = (who, session, preview) => flow(who).executeAction(session.id,{operationId:preview.operationId,payloadHash:preview.payloadHash});
  try {
    const sf = await flow(f).start({localTaskRef:'original-chat:proactive-review'});
    const task = {operationId:id(),taskId:id(),caseId:null,intent:'proactive-review',title:'Synthetic selected review',summary:'Only reviewed summary public',
      workContext:{goal:'Review current parser',currentSituation:'No past failure',attemptRefs:[]},visibility:'Public',collaboration:'open-assistance',enrollmentExpiresAt:now+3600};
    const privateSession=await flow(f).start({localTaskRef:'original-chat:private-review'}),privateTask={...task,operationId:id(),taskId:id(),visibility:'Private'};
    const privatePreview=await prepare(f,privateSession,'publish-task',privateTask,{recipientIds:[p.actor.subjectId,f.actor.subjectId,p.actor.subjectId]});
    assert.deepEqual(privatePreview.recipientIds,[p.actor.subjectId]);
    await assert.rejects(prepare(f,privateSession,'publish-task',privateTask,{recipientIds:[q.actor.subjectId]}),/operation_conflict/);
    await execute(f,privateSession,privatePreview);
    assert.equal((await flow(p).refresh((await flow(p).start({localTaskRef:'private-invited',taskId:privateTask.taskId})).id)).state,'refreshed');
    await assert.rejects(f.assistance.getTask(q.actor,privateTask.taskId),/not_found/);
    const privateInvite={taskId:privateTask.taskId,event:{kind:'invite',eventId:id(),expectedTaskVersion:1,recipientId:p.actor.subjectId,note:'Only the selected private recipient',expiresAt:now+1800}};
    await assert.rejects(prepare(f,privateSession,'task-event',privateInvite,{recipientIds:[q.actor.subjectId]}),/scope_changed/);
    await execute(f,privateSession,await prepare(f,privateSession,'task-event',privateInvite));
    assert.equal((await f.assistance.getTask(p.actor,privateTask.taskId)).contacts.responses.invitations.length,1);
    const contactOperation=()=>({taskId:privateTask.taskId,event:{kind:'suggest-contacts',eventId:id(),expectedTaskVersion:2,state:'empty',items:[]}});
    const contactA=await prepare(f,privateSession,'task-event',contactOperation()),contactB=await prepare(f,privateSession,'task-event',contactOperation());
    const beforeConcurrent=authorizations.size,contacts=await Promise.allSettled([execute(f,privateSession,contactA),execute(f,privateSession,contactB)]);
    assert.equal(contacts.filter(row=>row.status==='fulfilled').length,1);
    assert.equal(authorizations.size,beforeConcurrent+1,'different operations cannot pass stale session preflight and both sign');
    const excluded=contacts[0].status==='rejected'?contactA:contactB;
    assert.equal((await flow(f).reconcileAction(privateSession.id,{operationId:excluded.operationId})).receipt.state,'absent');
    await assert.rejects(prepare(f,sf,'publish-task',task,{recipientIds:[p.actor.subjectId]}),/scope_changed/);
    await assert.rejects(prepare(f,sf,'publish-task',task,{recipientIds:[f.actor.subjectId]}),/scope_changed/);
    const published = await prepare(f,sf,'publish-task',task); assert.equal(published.visibility,'Public');
    assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests WHERE id=$1',[task.taskId])).rows[0].n,0);
    losePath='/v2/tasks'; assert.equal((await execute(f,sf,published)).state,'unknown');
    const duplicate={...task,operationId:id(),taskId:id()};
    const signedDuplicate=await f.authorize(duplicate,'assistance.publish',{objectId:duplicate.operationId,visibility:'Public',purpose:'public-profile'});
    await assert.rejects(flow(f).publish(sf.id,signedDuplicate),/reconcile_original_operation/);
    await assert.rejects(prepare(f,sf,'publish-task',duplicate),/reconcile_original_operation/);
    await assert.rejects(execute(f,sf,published),/reconcile_original_operation/);
    assert.equal((await flow(f).reconcileAction(sf.id,{operationId:task.operationId})).receipt.state,'acknowledged');
    assert.equal((await flow(f).get(sf.id)).taskId,task.taskId);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM cases')).rows[0].n,0);
    const sp=await flow(p).start({localTaskRef:'provider-original',taskId:task.taskId}),sq=await flow(q).start({localTaskRef:'reviewer-original',taskId:task.taskId});
    const invite={taskId:task.taskId,event:{kind:'invite',eventId:id(),expectedTaskVersion:1,recipientId:p.actor.subjectId,note:'Synthetic diagnosis invitation',expiresAt:now+1800}};
    const invitation=await prepare(f,sf,'task-event',invite); assert.deepEqual(invitation.recipientIds,[p.actor.subjectId]);
    losePath=`/v2/tasks/${task.taskId}/events`; assert.equal((await execute(f,sf,invitation)).state,'unknown');
    const nextInvite={taskId:task.taskId,event:{...invite.event,eventId:id(),expectedTaskVersion:2,recipientId:q.actor.subjectId}};
    const nextPreview=await prepare(f,sf,'task-event',nextInvite);
    await assert.rejects(execute(f,sf,nextPreview),/reconcile_original_operation/);
    assert.equal((await flow(f).reconcileAction(sf.id,{operationId:invite.event.eventId})).receipt.state,'acknowledged');
    await execute(f,sf,nextPreview);
    assert.equal((await f.assistance.getTask(f.actor,task.taskId)).contacts.responses.invitations.length,2);
    const participation=async(who,session,role)=>{
      const current=await f.assistance.getTask(f.actor,task.taskId),pid=id();
      const proposal={kind:'propose',eventId:id(),expectedTaskVersion:current.version,participationId:pid,subjectId:who.actor.subjectId,role,scopeVersion:1,agreedScope:`Only selected ${role}`};
      await execute(f,sf,await prepare(f,sf,'participation-propose',proposal,{taskId:task.taskId}));
      const confirm={kind:'confirm',eventId:id(),expectedParticipationVersion:1,scopeVersion:1};
      await execute(who,session,await prepare(who,session,'participation-event',confirm,{taskId:task.taskId,participationId:pid}));
      return (await f.assistance.getTask(who.actor,task.taskId)).participations.find(row=>row.participationId===pid);
    };
    const pp=await participation(p,sp,'diagnosis'),qp=await participation(q,sq,'review');
    // A first actual intervention establishes the Case; no failed attempt is
    // invented to satisfy delivery fields or to authorize the proactive Task.
    const caseId=id(),currentTask=await f.assistance.getTask(f.actor,task.taskId);
    const root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:f.actor.subjectId,taskId:task.taskId,
      localRef:id(),title:'Actual selected synthetic review facts',summary:'Fixture facts, no real-user acceptance',source:{kind:'active-task',reference:task.taskId},synthetic:true};
    const initial={schemaVersion:2,kind:'intervention',eventId:id(),caseId,expectedVersion:1,actorId:f.actor.subjectId,taskId:task.taskId,
      types:['scope-clarification'],affectsAttemptIds:[],description:'Clarified the reviewed parser scope',sourceRefs:[],observedEffect:'Only review scope, no fix claimed'};
    const signedFact=async(who,payload)=>who.authorize(payload,'case.teaser.publish',{objectId:payload.eventId,viewers:[f,p,q].filter(other=>other!==who).map(other=>other.actor.subjectId)});
    await f.cases.createAndLinkTask(f.actor,{operationId:id(),taskId:task.taskId,expectedTaskVersion:currentTask.version,
      case:await signedFact(f,root),initialFact:await signedFact(f,initial)});
    const diagnostic={...initial,eventId:id(),expectedVersion:2,actorId:p.actor.subjectId,participationId:pp.participationId,participationScopeVersion:1,
      types:['diagnosis'],description:'Diagnostic contributor excluded a selected boundary mismatch'};
    await f.cases.submitV2(p.actor,await signedFact(p,diagnostic));
    const reviewed={...initial,eventId:id(),expectedVersion:3,actorId:q.actor.subjectId,participationId:qp.participationId,participationScopeVersion:1,
      types:['review'],description:'Independent participant reviewed a different selected condition'};
    await f.cases.submitV2(q.actor,await signedFact(q,reviewed));
    const result={schemaVersion:2,kind:'result-recorded',eventId:id(),caseId,expectedVersion:4,actorId:q.actor.subjectId,taskId:task.taskId,
      participationId:qp.participationId,participationScopeVersion:1,origin:{kind:'intervention',id:reviewed.eventId,version:1},scopeVersion:1,
      deliverableRefs:[],reportedOutcome:'partial',summary:'Selected review completed, original issue still unresolved',limitations:'Synthetic bounded review only'};
    await f.cases.submitV2(q.actor,await signedFact(q,result));
    const delivered={kind:'deliver',eventId:id(),expectedParticipationVersion:2,resultRef:{id:result.eventId,version:1},
      interventionRefs:[{id:reviewed.eventId,version:1},{id:diagnostic.eventId,version:1}],evidenceRefs:[],summary:'Review and diagnostic contributors remain separate'};
    await execute(q,sq,await prepare(q,sq,'participation-event',delivered,{taskId:task.taskId,participationId:qp.participationId}));
    const accepted={kind:'accept',eventId:id(),expectedParticipationVersion:3,deliveryId:delivered.eventId,summary:'Accepted selected review, still no fix or CI proof'};
    await execute(f,sf,await prepare(f,sf,'participation-event',accepted,{taskId:task.taskId,participationId:qp.participationId}));
    const facts=await f.cases.getV2(f.actor,caseId,{taskId:task.taskId});
    assert.equal(facts.attempts.length,0);assert.equal(facts.interventions.length,3);assert.equal(facts.resolution.status,'unrecorded');
    const grant=part=>({schemaVersion:2,id:id(),taskId:task.taskId,participationId:part.participationId,participantId:part.subjectId,
      scopeVersion:part.scopeVersion,scopeEventId:part.scopeEventId,expiresAt:now+600,materials:[{id:id(),label:'Selected private excerpt',mediaType:'text/plain',content:'Private chosen material for '+part.role}]});
    const gp=grant(pp),gq=grant(qp),preview=await prepare(f,sf,'context-grant',gp);
    assert.equal(preview.materials[0].content,gp.materials[0].content);
    assert.ok(!JSON.stringify(await flow(f).get(sf.id)).includes(gp.materials[0].content));
    assert.deepEqual(preview.recipientIds,[p.actor.subjectId]);
    losePath='/v2/context/grants'; assert.equal((await execute(f,sf,preview)).state,'unknown');
    assert.equal((await flow(f).actionPreview(sf.id,gp.id)).materials[0].content,gp.materials[0].content);
    assert.equal((await flow(f).reconcileAction(sf.id,{operationId:gp.id})).receipt.state,'acknowledged');
    assert.equal(Object.hasOwn(await flow(f).actionPreview(sf.id,gp.id),'payload'),false);
    await execute(f,sf,await prepare(f,sf,'context-grant',gq));
    const accept=async(who,session,gr)=>{
      const {metadata}=await f.contextV2.get(who.actor,gr.id,{metadataOnly:true});
      const event={schemaVersion:2,id:id(),kind:'accept',grantId:gr.id,taskId:task.taskId,participationId:gr.participationId,scopeVersion:gr.scopeVersion,materialsHash:metadata.materialsHash};
      await execute(who,session,await prepare(who,session,'context-event',event));
    };
    await accept(p,sp,gp); await accept(q,sq,gq);
    assert.equal((await f.contextV2.get(p.actor,gp.id)).materials[0].content,gp.materials[0].content);
    await assert.rejects(f.contextV2.get(q.actor,gp.id),/not_found/);
    const once=grant(qp),oncePreview=await prepare(f,sf,'context-grant',once);
    const raced=await Promise.allSettled([execute(f,sf,oncePreview),execute(f,sf,oncePreview)]);
    assert.equal(raced.filter(row=>row.status==='fulfilled').length,1);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM context_grants_v2 WHERE id=$1',[once.id])).rows[0].n,1);
    await assert.rejects(flow(f).executeAction(sf.id,{operationId:once.id,payloadHash:'0'.repeat(64)}),/preview_changed/);
    const changed=grant(qp),changedPreview=await prepare(f,sf,'context-grant',changed);
    changeAuthorizedPayload=true;assert.equal((await execute(f,sf,changedPreview)).state,'unknown');changeAuthorizedPayload=false;
    assert.equal((await flow(f).reconcileAction(sf.id,{operationId:changed.id})).receipt.state,'absent');
    await execute(f,sf,changedPreview);
    const switching=grant(qp),switchingPreview=await prepare(f,sf,'context-grant',switching);
    switchIdentityAfterConsent=true;await assert.rejects(execute(f,sf,switchingPreview),/identity_changed/);
    assert.equal((await f.db.query('SELECT id FROM context_grants_v2 WHERE id=$1',[switching.id])).rows.length,0);
    await writeFile(join(runtimes.get(f).folder,'galaxy-id.json'),JSON.stringify(f.genesis));
    assert.equal((await flow(f).reconcileAction(sf.id,{operationId:switching.id})).receipt.state,'absent');
    await execute(f,sf,switchingPreview);
    const wrong=grant(pp); wrong.participantId=q.actor.subjectId;
    await assert.rejects(prepare(f,sf,'context-grant',wrong),/context_scope_changed/);
    const {metadata}=await f.contextV2.get(f.actor,gp.id,{metadataOnly:true});
    const revoke={schemaVersion:2,id:id(),kind:'revoke',grantId:gp.id,taskId:task.taskId,participationId:pp.participationId,scopeVersion:1,materialsHash:metadata.materialsHash};
    await execute(f,sf,await prepare(f,sf,'context-event',revoke));
    assert.equal((await f.contextV2.get(p.actor,gp.id)).materials.length,0);
    assert.equal((await f.contextV2.get(q.actor,gq.id)).contextAccessGranted,true);
    const stale=grant(pp),stalePreview=await prepare(f,sf,'context-grant',stale);
    const withdraw={kind:'withdraw',eventId:id(),expectedParticipationVersion:2,reason:'Finished diagnostic scope'};
    await execute(p,sp,await prepare(p,sp,'participation-event',withdraw,{taskId:task.taskId,participationId:pp.participationId}));
    const countBefore=authorizations.size; await assert.rejects(execute(f,sf,stalePreview),/context_scope_changed/);
    assert.equal(authorizations.size,countBefore,'stale scope rejected before any new Consent');
    const returned=await flow(f).returnToTask(sf.id,{expectedRevision:(await flow(f).get(sf.id)).revision});
    assert.equal(returned.handoff.localTaskRef,'original-chat:proactive-review'); assert.equal(returned.successFactsCreated,false);
    const acceptedParticipation=returned.remote.participations.find(row=>row.participationId===qp.participationId);
    assert.equal(acceptedParticipation.state,'accepted');assert.equal(acceptedParticipation.deliveries[0].verification,'not-provided');
    assert.equal(acceptedParticipation.deliveries[0].resolution,'unresolved');assert.equal(returned.handoff.caseId,caseId);
    const second=await flow(f).start({localTaskRef:'same-task-other-session',taskId:task.taskId});
    const retained=grant(qp),pendingOther=await prepare(f,second,'context-grant',retained);
    const beforeForget=await readdir(join(runtimes.get(f).folder,'help-v2'),{recursive:true});
    assert.ok(beforeForget.some(name=>name.includes(stale.id)));
    await flow(f).forget(sf.id);
    const afterForget=await readdir(join(runtimes.get(f).folder,'help-v2'),{recursive:true});
    assert.ok(!afterForget.some(name=>name.includes(sf.id)));
    assert.equal((await flow(f).actionPreview(second.id,pendingOther.operationId)).materials[0].content,retained.materials[0].content);
    const serialized=await Promise.all(afterForget.filter(name=>name.endsWith('.json')).map(name=>readFile(join(runtimes.get(f).folder,'help-v2',name),'utf8')));
    assert.ok(!serialized.join('').includes(gp.materials[0].content)); assert.ok(!serialized.join('').includes(f.credential));
    assert.ok(calls>20);
  } finally {
    memories.forEach(memory=>memory.close()); api.closeAllConnections(); await new Promise(resolve=>api.close(resolve)); await f.db.close(); await rm(directory,{recursive:true,force:true});
  }
});

test('forget removes a pending action saved before its session reference and never another session', async()=>{
  const f=await serviceFixture(),directory=await mkdtemp(join(tmpdir(),'galaxy-help-forget-'));
  try{
    await writeFile(join(directory,'galaxy-id.json'),JSON.stringify(f.genesis));
    const store=createLocalHelpStoreV2({dataDirectory:directory,endpoint:f.access.endpoint,subjectId:f.actor.subjectId,now:()=>f.now});
    const first=await store.create({localTaskRef:'first'}),second=await store.create({localTaskRef:'second'}),operationId=id();
    const record=session=>({sessionId:session.id,subjectId:f.actor.subjectId,endpoint:f.access.endpoint,operationId,payloadJson:'Private pending crash material'});
    await store.writeOperation(first.id,operationId,()=>record(first)); await store.writeOperation(second.id,operationId,()=>record(second));
    await store.forget(first.id); await assert.rejects(store.get(first.id),/not_found/);
    assert.equal((await store.readOperation(second.id,operationId)).payloadJson,'Private pending crash material');
  }finally{await f.db.close();await rm(directory,{recursive:true,force:true});}
});
