import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {verifyContactsV2} from "./contacts-v2-workflow.mjs";
import {getProjectContactClient,acknowledgedOperationLimit} from "../../galaxy-web/src/features/projects/clients/operations.mjs";
import {createProjectViewClient,hasIndependentProject,projectQueryMemory} from "../../galaxy-web/src/features/projects/clients/views.mjs";
import {createNativeNavigation} from "../../galaxy-edge-mcp/src/native-v2/interaction/navigation.mjs";

test('exact project → real discovery/recruitment → original Contact retry → ordinary room uses actual HTTP and Consent',async()=>{
 await verifyContactsV2(null,{afterWorkflow:async({f,p,alias,request})=>{
  const runtimes=new Map();let loseContact=true,contactWrites=0,authorizations=0;const calls=[];
  function runtime(who){if(runtimes.has(who))return runtimes.get(who);const local=new Map();
   const value={api:{endpoint:who.access.endpoint,snapshot:()=>({subjectId:who.actor.subjectId,bindingId:'current-fixture-binding'}),
    authorizePayload:(text,{action,objectId,visibility,viewers})=>{authorizations++;return who.authorize(JSON.parse(text),action,{objectId,visibility,viewers,purpose:visibility==='Public'?'public-profile':'operational'});},
    call:async(path,input,options={})=>{calls.push({path,method:options.method??'POST'});const result=await request(who,path,options.method==='GET'?null:input);
     if(path==='/v2/contacts'){contactWrites++;if(loseContact){loseContact=false;throw new Error('synthetic lost ACK after actual commit');}}
     return result;}},getLocal:async key=>structuredClone(local.get(key)),putLocal:async(key,value)=>local.set(key,structuredClone(value))};
   runtimes.set(who,value);return value;
  }
  const fr=runtime(f),pr=runtime(p),fc=getProjectContactClient(fr,f.actor.subjectId);
  const view=who=>createProjectViewClient(runtime(who),{connected:true,subjectId:who.actor.subjectId});
  const fv=view(f),pv=view(p),projectId=randomUUID();
  const created=await fc.submit('project',{kind:'create',projectId,expectedRevision:0,document:{kind:'project',title:'Synthetic exact project source',summary:'Help with table extraction',functions:['table-extraction'],technologies:['typescript'],discoverable:true}},{visibility:'Public',confirmed:true});
  const project=await pv.project(projectId);assert.equal(project.projectId,projectId);assert.equal(project.capabilityVerified,false);assert.equal(project.permissions.edit,false);
  const prefs=await f.discovery.preferences(f.actor);await f.discovery.save(f.actor,{expectedRevision:prefs.revision,preferences:{enabled:true}});
  const recruitmentId=randomUUID();await fc.submit('recruitment',{kind:'create',projectId,recruitmentId,expectedRevision:0,expiresAt:Math.floor(Date.now()/1000)+3600,
   document:{title:'Parser collaborator',role:'Discuss and review parser design',summary:'Independent conversation first',functions:['table-extraction'],contactSubjectId:f.actor.subjectId}},{visibility:'Public',confirmed:true});
  const recruitment=await pv.recruitment(recruitmentId);assert.equal(recruitment.project.projectId,projectId);assert.deepEqual(recruitment.taskLinks,[]);
  const count=await f.db.query('SELECT (SELECT count(*)::int FROM projects_v2) projects,(SELECT count(*)::int FROM task_requests) tasks,(SELECT count(*)::int FROM cases) cases');
  const related=await pv.related(projectId,['conversation','collaboration','recruitment']);assert.equal(related.query.context.kind,'ephemeral');
  assert.equal(related.project.projectId,projectId);assert.equal(related.query.context.title,project.document.title);
  const opportunity=related.result.items.find(x=>x.recruitmentId===recruitmentId);assert.ok(opportunity);assert.equal(hasIndependentProject(opportunity),true);
  const detail=await pv.detail(related.query,opportunity.opportunityRef);assert.deepEqual(detail.opportunity.opportunityRef,opportunity.opportunityRef);
  assert.deepEqual((await f.db.query('SELECT (SELECT count(*)::int FROM projects_v2) projects,(SELECT count(*)::int FROM task_requests) tasks,(SELECT count(*)::int FROM cases) cases')).rows,count.rows,'reading uses temporary query, no Project/Case/Task created');
  const operationId=randomUUID(),input={purpose:'recruitment',note:'I choose this specific person and source',roomTitle:'Independent conversation',operationId};let unknown;
  await assert.rejects(pv.send(related.query,opportunity,{...input,operationId:'invalid-local-reference'}),error=>error.name==='ZodError');
  assert.equal(contactWrites,0,'invalid draft locator cannot dispatch a contact');
  try{await pv.send(related.query,opportunity,input);assert.fail('the actual commit ACK must be lost');}catch(e){unknown=e;assert.equal(e.resultUnknown,true);}
  const reopened=view(p),pending=await reopened.pendingContact(opportunity);assert.equal(pending.operationId,unknown.operationId);assert.equal(pending.contactId,unknown.objectId);
  assert.equal(pending.operationId,operationId,'the exact body-free draft locator reaches the real original Contact journal');
  const journal=(await getProjectContactClient(pr,p.actor.subjectId).reviewPending(operationId));
  assert.equal(journal.payload.operationId,operationId);assert.equal(journal.payload.note,input.note);
  assert.equal(JSON.stringify(pending).includes(input.note),false,'the pending target index does not copy private message text');
  assert.equal((await reopened.reconcile(pending.operationId)).state,'exact-receipt-unconfirmed');
  await assert.rejects(reopened.send(related.query,opportunity,input),e=>e.resultUnknown&&e.operationId===pending.operationId);assert.equal(contactWrites,1,'reopening does not replace the original unknown operation');
  const sent=await reopened.reconcile(pending.operationId,true);assert.equal(sent.replayed,true);assert.equal(sent.contactId,pending.contactId);assert.equal(sent.roomId,null);
  assert.equal(await reopened.pendingContact(opportunity),null);
  const acknowledged=await getProjectContactClient(pr,p.actor.subjectId).acknowledgedContacts();
  assert.deepEqual(acknowledged,[{contactId:sent.contactId,operationId}]);
  const readStart=calls.length,authorizationCount=authorizations,contactWriteCount=contactWrites;
  const afterRefresh=await view(p).recentContact(opportunity);
  assert.equal(afterRefresh.contactId,sent.contactId);assert.equal(afterRefresh.state,'sent');
  assert.equal(afterRefresh.events.find(event=>event.kind==='send').note,input.note);
  assert.equal(await view(p).recentContact({...opportunity,projectId:randomUUID()}),null);
  assert.equal(await view(p).recentContact({...opportunity,opportunityRef:{...opportunity.opportunityRef,recruitmentId:randomUUID()}}),null);
  assert.equal(authorizations,authorizationCount);assert.equal(contactWrites,contactWriteCount);
  assert.equal(calls.slice(readStart).every(call=>call.method==='GET'),true,'restoring the current invitation only reads, never sends or signs again');
  const incoming=await fv.contact(sent.contactId);const accepted=await fv.respond(incoming,'accept','I agree to ordinary conversation');
  assert.equal(accepted.state,'accepted');assert.equal(accepted.roomId,sent.contactId);
  const seen=await reopened.contact(sent.contactId);assert.equal(seen.roomId,accepted.roomId);
  const acceptedAfterRefresh=await view(p).recentContact(opportunity);
  assert.equal(acceptedAfterRefresh.state,'accepted');assert.equal(acceptedAfterRefresh.roomId,sent.contactId);
  const room=await request(p,`/v2/chat/rooms/${seen.roomId}/read`);assert.equal(room.kind,'ordinary');assert.deepEqual(room.taskRefs,[]);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,count.rows[0].tasks);
  await request(alias,'/v2/contacts/'+sent.contactId,null,404);
  await fc.submit('project',{kind:'archive',projectId,expectedRevision:created.revision},{confirmed:true});
  await request(p,'/v2/projects/'+projectId,null,404);assert.equal((await fv.project(projectId)).state,'archived');
  await assert.rejects(fv.related(projectId,['conversation']),/不可用于/);
 }});
});

test('recent Contact uses body-free original locators, current readable source and binding; it never writes',async()=>{
 const subjectId='GUID'+'A'.repeat(28),recipientId='GUID'+'B'.repeat(28),projectId=randomUUID(),recruitmentId=randomUUID();
 const one=randomUUID(),two=randomUUID(),other=randomUUID(),oldOperation=randomUUID(),latestOperation=randomUUID(),secondOperation=randomUUID();
 const opportunity={subjectId:recipientId,projectId,opportunityRef:{sourceKind:'recruitment',subjectId:recipientId,projectId,recruitmentId,eventId:randomUUID()}};
 const terminal=(contactId,operationId)=>({type:'contact',objectId:contactId,operationId,state:'acknowledged'});
 const records=[terminal(one,oldOperation),{type:'project',objectId:projectId,operationId:randomUUID(),state:'acknowledged'},
  terminal(two,secondOperation),{type:'contact',objectId:randomUUID(),operationId:randomUUID(),state:'stopped-local'},terminal(one,latestOperation),terminal(other,randomUUID())];
 const projection=(contactId,state,recordedAt)=>({contactId,state,initiatorId:subjectId,recipientId,
  events:[{kind:'send',subjectId,recordedAt,opportunityRef:opportunity.opportunityRef,note:'Currently readable source'}]});
 const values=new Map([[one,projection(one,'accepted','2026-10-09T12:02:00Z')],[two,projection(two,'sent','2026-10-09T12:01:00Z')],
  [other,{...projection(other,'sent','2026-10-09T12:03:00Z'),recipientId:'GUID'+'C'.repeat(28)}]]);
 let bindingId='original',lateResolve,late=false,unavailable=false,requests=0;
 const runtime={api:{endpoint:'https://synthetic.example',snapshot:()=>({subjectId,bindingId}),
  authorizePayload:async()=>assert.fail('a read cannot authorize'),
  call:async(path,input,options)=>{requests++;assert.equal(options.method,'GET');assert.equal(input,undefined);
   if(unavailable)throw Object.assign(new Error('service temporarily unavailable'),{status:503});
   if(late)return new Promise(resolve=>{lateResolve=resolve;});
   return structuredClone(values.get(path.split('/').at(-1)));}},
  getLocal:async()=>structuredClone(records),putLocal:async()=>assert.fail('a read cannot overwrite local history')};
 const writes=getProjectContactClient(runtime,subjectId),view=()=>createProjectViewClient(runtime,{connected:true,subjectId});
 assert.equal(acknowledgedOperationLimit,64);
 assert.deepEqual((await writes.acknowledgedContacts()).slice(1),[{contactId:one,operationId:latestOperation},{contactId:two,operationId:secondOperation}]);
 assert.equal(requests,0,'locators come from this owner\'s local terminal window only');
 assert.equal((await view().recentContact(opportunity)).contactId,two,'an awaiting invitation takes precedence over a later accepted one');
 values.set(two,{...values.get(two),events:[{kind:'send',subjectId,recordedAt:'2026-10-09T12:01:00Z',contentUnavailable:true}]});
 assert.equal((await view().recentContact(opportunity)).contactId,one,'unreadable source is not reconstructed from the local locator');
 values.set(one,{...values.get(one),events:[]});assert.equal(await view().recentContact(opportunity),null);
 unavailable=true;await assert.rejects(view().recentContact(opportunity),error=>error.status===503);unavailable=false;
 records.splice(0,records.length,terminal(one,latestOperation));late=true;
 const reading=view().recentContact(opportunity);
 while(!lateResolve)await new Promise(resolve=>setImmediate(resolve));
 bindingId='replacement';lateResolve(projection(one,'accepted','2026-10-09T12:02:00Z'));
 await assert.rejects(reading,error=>error.code==='project_view_identity_changed');
});

test('binding change rejects late source data but preserves same-owner authored query; another identity cannot inherit it; native Project navigation retains ID',async()=>{
 const originalSubject='GUID'+'A'.repeat(28),projectId=randomUUID();let subject=originalSubject,bindingId='original',connected=true,resolve;
 const runtime={receiptStatus:{captureLease:()=>({subjectId:subject})},api:{endpoint:'https://synthetic.example',snapshot:()=>connected?({subjectId:subject,bindingId}):null,call:()=>new Promise(done=>{resolve=done;})},getLocal:async()=>[],putLocal:async()=>{}};
 projectQueryMemory(runtime,true,'discovery',{title:'private local query'});
 const view=createProjectViewClient(runtime,{connected:true,subjectId:subject}),read=view.project(projectId);
 bindingId='replacement';resolve({projectId,document:{summary:'late private old connection'}});
 await assert.rejects(read,e=>e.code==='project_view_identity_changed');assert.deepEqual(projectQueryMemory(runtime,true,'discovery'),{title:'private local query'});
 connected=false;assert.deepEqual(projectQueryMemory(runtime,false,'discovery'),{title:'private local query'});
 subject='GUID'+'B'.repeat(28);assert.equal(projectQueryMemory(runtime,false,'discovery'),null);
 projectQueryMemory(runtime,false,'discovery',{title:'other identity draft'});
 subject=originalSubject;connected=true;assert.deepEqual(projectQueryMemory(runtime,true,'discovery'),{title:'private local query'});
 assert.equal(JSON.stringify(projectQueryMemory(runtime,true,'discovery')).includes('late private old connection'),false);
 assert.equal(hasIndependentProject({opportunityRef:{subjectId:subject,projectId,statementId:randomUUID()}}),false);
 assert.equal(hasIndependentProject({opportunityRef:{sourceKind:'project',projectId}}),true);
 const store=new Map(),opened=[],returned=[];
 const navigation=createNativeNavigation({website:'https://galaxy.example',store:{put:async(k,v)=>store.set(k,v),get:async k=>store.get(k)},
  openBrowser:async url=>{opened.push(url);return{launched:true};},refresh:async object=>{returned.push(object);return{projectId:object.id};}});
 const result=await navigation.open({object:{kind:'project',id:projectId},origin:{host:'synthetic',workRef:'original-local-task'}});
 assert.equal(opened[0],`https://galaxy.example/app/projects/${projectId}`);assert.equal(result.opened,'unverified');
 const resume=await navigation.resume(result.navigationId);assert.equal(resume.data.projectId,projectId);assert.equal(resume.origin.workRef,'original-local-task');assert.equal(returned[0].id,projectId);
});
