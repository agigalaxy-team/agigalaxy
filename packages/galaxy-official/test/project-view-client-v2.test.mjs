import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {verifyContactsV2} from './contacts-v2-workflow.mjs';
import {getProjectContactClient} from '../../galaxy-web/src/project-contact-client.mjs';
import {createProjectViewClient,hasIndependentProject,projectQueryMemory} from '../../galaxy-web/src/project-view-client.mjs';
import {createNativeNavigation} from '../../galaxy-edge-mcp/src/native-v2/navigation.mjs';

test('exact project → real discovery/recruitment → original Contact retry → ordinary room uses actual HTTP and Consent',async()=>{
 await verifyContactsV2(null,{afterWorkflow:async({f,p,alias,request})=>{
  const runtimes=new Map();let loseContact=true,contactWrites=0;
  function runtime(who){if(runtimes.has(who))return runtimes.get(who);const local=new Map();
   const value={api:{endpoint:who.access.endpoint,snapshot:()=>({subjectId:who.actor.subjectId,bindingId:'current-fixture-binding'}),
    authorizePayload:(text,{action,objectId,visibility,viewers})=>who.authorize(JSON.parse(text),action,{objectId,visibility,viewers,purpose:visibility==='Public'?'public-profile':'operational'}),
    call:async(path,input,options={})=>{const result=await request(who,path,options.method==='GET'?null:input);
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
  const input={purpose:'recruitment',note:'I choose this specific person and source',roomTitle:'Independent conversation'};let unknown;
  try{await pv.send(related.query,opportunity,input);assert.fail('the actual commit ACK must be lost');}catch(e){unknown=e;assert.equal(e.resultUnknown,true);}
  const reopened=view(p),pending=await reopened.pendingContact(opportunity);assert.equal(pending.operationId,unknown.operationId);assert.equal(pending.contactId,unknown.objectId);
  assert.equal(JSON.stringify(pending).includes(input.note),false,'the pending target index does not copy private message text');
  assert.equal((await reopened.reconcile(pending.operationId)).state,'exact-receipt-unconfirmed');
  await assert.rejects(reopened.send(related.query,opportunity,input),e=>e.resultUnknown&&e.operationId===pending.operationId);assert.equal(contactWrites,1,'reopening does not replace the original unknown operation');
  const sent=await reopened.reconcile(pending.operationId,true);assert.equal(sent.replayed,true);assert.equal(sent.contactId,pending.contactId);assert.equal(sent.roomId,null);
  assert.equal(await reopened.pendingContact(opportunity),null);
  const incoming=await fv.contact(sent.contactId);const accepted=await fv.respond(incoming,'accept','I agree to ordinary conversation');
  assert.equal(accepted.state,'accepted');assert.equal(accepted.roomId,sent.contactId);
  const seen=await reopened.contact(sent.contactId);assert.equal(seen.roomId,accepted.roomId);
  const room=await request(p,`/v2/chat/rooms/${seen.roomId}/read`);assert.equal(room.kind,'ordinary');assert.deepEqual(room.taskRefs,[]);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,count.rows[0].tasks);
  await request(alias,'/v2/contacts/'+sent.contactId,null,404);
  await fc.submit('project',{kind:'archive',projectId,expectedRevision:created.revision},{confirmed:true});
  await request(p,'/v2/projects/'+projectId,null,404);assert.equal((await fv.project(projectId)).state,'archived');
  await assert.rejects(fv.related(projectId,['conversation']),/不可用于/);
 }});
});

test('binding change rejects late project data; legacy statements remain distinct; exact native Project navigation retains ID',async()=>{
 const subject='GUID'+'A'.repeat(28),projectId=randomUUID();let bindingId='original',resolve;
 const runtime={api:{endpoint:'https://synthetic.example',snapshot:()=>({subjectId:subject,bindingId}),call:()=>new Promise(done=>{resolve=done;})},getLocal:async()=>[],putLocal:async()=>{}};
 projectQueryMemory(runtime,true,'discovery',{title:'private local query'});
 const view=createProjectViewClient(runtime,{connected:true,subjectId:subject}),read=view.project(projectId);
 bindingId='replacement';resolve({projectId,document:{summary:'late private old connection'}});
 await assert.rejects(read,e=>e.code==='project_view_identity_changed');assert.equal(projectQueryMemory(runtime,true,'discovery'),null);
 assert.equal(hasIndependentProject({opportunityRef:{subjectId:subject,projectId,statementId:randomUUID()}}),false);
 assert.equal(hasIndependentProject({opportunityRef:{sourceKind:'project',projectId}}),true);
 const store=new Map(),opened=[],returned=[];
 const navigation=createNativeNavigation({website:'https://galaxy.example',store:{put:async(k,v)=>store.set(k,v),get:async k=>store.get(k)},
  openBrowser:async url=>{opened.push(url);return{launched:true};},refresh:async object=>{returned.push(object);return{projectId:object.id};}});
 const result=await navigation.open({object:{kind:'project',id:projectId},origin:{host:'synthetic',workRef:'original-local-task'}});
 assert.equal(opened[0],`https://galaxy.example/app/projects/${projectId}`);assert.equal(result.opened,'unverified');
 const resume=await navigation.resume(result.navigationId);assert.equal(resume.data.projectId,projectId);assert.equal(resume.origin.workRef,'original-local-task');assert.equal(returned[0].id,projectId);
});
