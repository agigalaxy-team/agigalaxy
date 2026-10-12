import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';

const directory='/v2/projects/directory/query';
const document={kind:'project',title:'Synthetic alpha tool',summary:'A public declaration only',functions:['Alpha'],technologies:['Rust'],participantKind:'tool',discoverable:true};
const scopes=['binding','consent','history','notifications','data-delete'];
async function harness(run){
  const f=await serviceFixture(scopes),b=await serviceFixture(scopes,f.db,{migrateDatabase:false});
  // These tests isolate Project read policy. They do not establish real Account/OIDC verification.
  for(const fixture of [f,b])fixture.projects.requireAccountWithin=async()=>({syntheticFixture:true,accountVerificationNotTested:true});
  let now=f.now;f.access.now=f.consents.now=()=>now;
  const api=createApi({...f,rateLimit:1000,searchPageLimit:500});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`;
  const request=async(actor,path,input={},status=200)=>{
    const response=await fetch(origin+path,{method:input===null?'GET':'POST',headers:{'Content-Type':'application/json',...(actor?{Authorization:'Bearer '+(actor.credential??actor)}:{})},...(input===null?{}:{body:JSON.stringify(input)})});
    const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;
  };
  const write=async(actor,projectId,kind,fields={},extra={})=>{
    const revision=(await f.db.query('SELECT revision FROM projects_v2 WHERE id=$1',[projectId])).rows[0]?.revision??0;
    const event={operationId:randomUUID(),projectId,expectedRevision:revision,kind,...fields};
    const envelope=await actor.authorize(event,'project.write',{objectId:event.operationId,visibility:'Public',purpose:'public-profile',...extra});
    const receipt=await request(actor,'/v2/projects',envelope);return {event,envelope,receipt};
  };
  const create=(actor=f,doc=document,id=randomUUID(),extra={})=>write(actor,id,'create',{document:doc},extra);
  const wish=async(actor,preferences)=>{const current=await actor.discovery.preferences(actor.actor);return actor.discovery.save(actor.actor,{expectedRevision:current.revision,preferences});};
  const localWish=async(actor,id,preferences)=>{const current=await request(actor,`/v2/projects/${id}/preferences/read`);return request(actor,`/v2/projects/${id}/preferences/save`,{expectedRevision:current.revision,preferences});};
  const page=(input={},actor=null,status=200)=>request(actor,directory,input,status);
  const detail=(id,actor=null,status=200)=>request(actor,`/v2/projects/${id}`,null,status);
  const snapshot=async()=>{
    const tables=['projects_v2','project_events_v2','project_roles_v2','project_transfers_v2','project_preferences_v2','contacts_v2','chat_rooms','case_events','assistance_events','consents'];
    const result={};for(const table of tables)result[table]=(await f.db.query(`SELECT * FROM ${table}`)).rows;
    return JSON.stringify(result);
  };
  try{await run({f,b,api,request,write,create,wish,localWish,page,detail,snapshot,setNow:value=>{now=value;}});}
  finally{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}
}

test('public directory browses without a matching context and never elevates owner visibility or emits extensions',{timeout:60000},()=>harness(async h=>{
  await h.wish(h.f,{enabled:true});
  const first=await h.create(h.f,{...document,extensions:{secret:'UNINTERPRETED-EXTENSION'}}),second=await h.create(h.f,{...document,kind:'module',title:'Beta module',functions:['Beta']});
  const privateProject=await h.create(h.f,{...document,title:'PRIVATE-PROJECT'},randomUUID(),{visibility:'Private'});
  const before=await h.snapshot(),anonymous=await h.page(),owner=await h.page({},h.f);
  assert.deepEqual(owner.items,anonymous.items);assert.equal(anonymous.items.length,2);
  assert.ok(anonymous.items.some(item=>item.projectId===second.event.projectId));
  const item=anonymous.items.find(item=>item.projectId===first.event.projectId);
  assert.deepEqual(item.document,{kind:'project',title:document.title,summary:document.summary,functions:['Alpha'],technologies:['Rust'],participantKind:'tool'});
  assert.equal(item.classification,'self-declared');assert.equal(item.capabilityVerified,false);assert.equal(item.legalOwnershipVerified,false);
  assert.equal(item.discovery.contactRequiresCurrentCheck,true);assert.equal(anonymous.readingGrantsContact,false);assert.equal(anonymous.readingGrantsMembership,false);
  assert.ok(!JSON.stringify(anonymous).includes('UNINTERPRETED-EXTENSION'));assert.ok(!JSON.stringify(owner).includes(privateProject.event.projectId));
  assert.ok(!item.source.fieldSources.some(source=>source.field==='extensions'||source.field==='discoverable'));
  assert.deepEqual((await h.page({query:' beta ',kind:'module'})).items.map(item=>item.projectId),[second.event.projectId]);
  assert.equal((await h.page({query:'UNINTERPRETED-EXTENSION'})).items.length,0);
  assert.equal(anonymous.coverage.globalCountProvided,false);assert.equal(anonymous.coverage.globalRanking,false);
  for(const input of [{limit:0},{limit:21},{query:'x'.repeat(201)},{kind:'person'},{purpose:'any'},{context:{}},{after:''}])assert.equal((await h.page(input,null,400)).error,'invalid_project_directory_query');
  await h.page({},'invalid-credential',401);
  assert.equal(await h.snapshot(),before,'directory reads do not write business or Consent rows');
}));

test('current sources, field grants, hiding and archive suppress directory without resurrecting old public bytes',{timeout:60000},()=>harness(async h=>{
  await h.wish(h.f,{enabled:true});
  const created=await h.create(),id=created.event.projectId;
  assert.equal((await h.page()).items.length,1);
  await h.write(h.f,id,'revise',{patch:{discoverable:false}});assert.equal((await h.page()).items.length,0);assert.equal((await h.detail(id)).document.discoverable,false);
  await h.write(h.f,id,'revise',{patch:{discoverable:true}});assert.equal((await h.page()).items.length,1);
  await h.write(h.f,id,'archive');assert.equal((await h.page()).items.length,0);await h.detail(id,null,404);
  await h.write(h.f,id,'restore');assert.equal((await h.page()).items.length,1);
  await h.write(h.f,id,'grant-role',{subjectId:h.b.actor.subjectId,role:'editor'});
  const privatePatch=await h.write(h.b,id,'revise',{patch:{privateExtension:'EDITOR-PRIVATE-LATEST'}},{visibility:'Private'});
  assert.equal((await h.detail(id)).document.title,document.title,'public ID detail still uses separately readable required fields');
  assert.equal((await h.page()).items.length,0);assert.equal((await h.page({},h.b)).items.length,0,'editor access cannot elevate a public directory');
  assert.ok(!JSON.stringify(await h.page()).includes(privatePatch.event.operationId));
  const publicPatch=await h.write(h.b,id,'revise',{patch:{technologies:['Go']}});
  assert.equal((await h.page()).items.length,1);
  await h.b.consents.revoke(h.b.actor,publicPatch.envelope.consentId);
  assert.equal((await h.page()).items.length,0);assert.equal((await h.detail(id)).document.technologies.length,0);
  const repaired=await h.write(h.f,id,'revise',{patch:{technologies:['Zig']}});assert.equal((await h.page()).items.length,1);
  await h.f.db.query("UPDATE project_events_v2 SET payload_text='' WHERE operation_id=$1",[repaired.event.operationId]);
  assert.equal((await h.page()).items.length,0);assert.ok(!JSON.stringify(await h.page()).includes(repaired.event.operationId));
  const current=await h.write(h.f,id,'revise',{patch:{technologies:['C']}});assert.equal((await h.page()).items.length,1);
  await h.f.db.query('UPDATE consents SET expires_at=$2 WHERE id=$1',[current.envelope.consentId,new Date((h.f.now-1)*1000).toISOString()]);
  assert.equal((await h.page()).items.length,0);
  const final=await h.write(h.f,id,'revise',{patch:{kind:'project',title:'NEW-PUBLIC',summary:'replacement',functions:['Alpha']}});
  assert.equal((await h.page()).items.length,1);
  await h.f.db.query("UPDATE project_events_v2 SET payload_text='' WHERE operation_id=$1",[created.event.operationId]);
  // An erased older required source that has been explicitly replaced does not poison the new fields.
  assert.equal((await h.page()).items[0].document.title,'NEW-PUBLIC');
  const stored=(await h.f.db.query('SELECT payload_text,payload_hash FROM project_events_v2 WHERE operation_id=$1',[final.event.operationId])).rows[0];
  await h.page();assert.deepEqual((await h.f.db.query('SELECT payload_text,payload_hash FROM project_events_v2 WHERE operation_id=$1',[final.event.operationId])).rows[0],stored);
}));

test('an author portfolio lists existing public work while contact is off, with owner-scoped paging and unchanged public permissions',{timeout:60000},()=>harness(async h=>{
  const first=await h.create(h.f,{...document,title:'Unfinished poem',technologies:[]},'10000000-0000-4000-8000-000000000001');
  const second=await h.create(h.f,{...document,title:'Paper pattern',technologies:[]},'10000000-0000-4000-8000-000000000002');
  const privateWork=await h.create(h.f,{...document,title:'PRIVATE-WORK'},randomUUID(),{visibility:'Private'});
  const unlisted=await h.create(h.f,{...document,title:'UNLISTED-WORK',discoverable:false});
  const other=await h.create(h.b,{...document,title:'OTHER-AUTHOR'});
  const portfolio=(input={},actor=null,status=200)=>h.request(actor,'/v2/projects/portfolio/query',{ownerId:h.f.actor.subjectId,...input},status);
  const before=await h.snapshot(),one=await portfolio({limit:1});
  assert.deepEqual(one.items.map(item=>item.projectId),[first.event.projectId]);assert.ok(one.nextAfter);
  assert.equal((await h.page()).items.length,0,'not accepting contact remains authoritative for matching');
  const two=await portfolio({limit:1,after:one.nextAfter});assert.deepEqual(two.items.map(item=>item.projectId),[second.event.projectId]);assert.equal(two.nextAfter,null);
  assert.deepEqual((await portfolio({},h.f)).items,(await portfolio()).items,'an owner cannot expand the public portfolio');
  for(const forbidden of [privateWork.event.projectId,unlisted.event.projectId,other.event.projectId])assert.ok(!JSON.stringify(await portfolio()).includes(forbidden));
  assert.equal(one.readingGrantsContact,false);assert.equal(one.readingGrantsMembership,false);assert.equal(one.items[0].discovery,undefined);
  assert.equal(await h.snapshot(),before,'reading does not duplicate work or create contact preferences');
  await portfolio({ownerId:h.b.actor.subjectId,limit:1,after:one.nextAfter},null,409);
  await h.page({limit:1,after:one.nextAfter},null,409);
  await portfolio({ownerId:'not-an-identity'},null,400);await portfolio({purpose:'conversation'},null,400);
  await h.write(h.f,second.event.projectId,'archive');assert.equal((await portfolio()).items.length,1);
  await h.f.consents.revoke(h.f.actor,first.envelope.consentId);assert.equal((await portfolio()).items.length,0);
}));

test('a limited contact direction never becomes an offer of every related skill, and disjoint wishes do not match',{timeout:60000},()=>harness(async h=>{
  const source=await h.create(h.f,{...document,functions:['Alpha','Beta']});
  const target=await h.create(h.b,{...document,functions:['Alpha','Beta']});
  await h.wish(h.f,{enabled:true,functions:['Beta']});await h.wish(h.b,{enabled:true});
  await h.localWish(h.b,target.event.projectId,{enabled:true,purposes:['conversation'],functions:['Alpha']});
  const input={context:{kind:'ephemeral',title:'Discuss one selected direction',functions:['Alpha','Beta'],technologies:[]},purposes:['conversation']};
  const anonymous=await h.request(null,'/v2/discovery/query',input),item=anonymous.items.find(item=>item.projectId===target.event.projectId);
  assert.deepEqual(item.match.sharedFunctions,['alpha','beta'],'similarity remains an explanation of the work');
  assert.deepEqual(item.help.functions,['alpha'],'the invitation reflects only the currently allowed direction');
  const own=await h.request(h.f,'/v2/discovery/query',{...input,context:{kind:'project',projectId:source.event.projectId}});
  assert.equal(own.items.some(item=>item.projectId===target.event.projectId),false,'each side matching a different direction is not mutual willingness');
  await h.localWish(h.f,source.event.projectId,{enabled:true,purposes:['conversation'],functions:['Alpha','Beta']});
  const joined=await h.request(h.f,'/v2/discovery/query',{...input,context:{kind:'project',projectId:source.event.projectId}});
  assert.deepEqual(joined.items.find(item=>item.projectId===target.event.projectId).help.functions,['alpha']);
  const ref=item.opportunityRef;await h.localWish(h.b,target.event.projectId,{enabled:false});
  await h.request(null,'/v2/discovery/detail',{...input,opportunityRef:ref},404);
}));

test('current owner global, project and temporary willingness restricts directory purposes and public functions only',{timeout:60000},()=>harness(async h=>{
  const created=await h.create(h.f,{...document,functions:['Alpha','Beta']}),id=created.event.projectId;
  assert.equal((await h.page()).items.length,0);await h.detail(id);
  await h.wish(h.f,{enabled:true,purposes:['reuse'],functions:[' Alpha ','PRIVATE-WISH']});
  let item=(await h.page()).items[0];assert.deepEqual(item.discovery.functions,['alpha']);assert.equal(item.discovery.functionsRestricted,true);
  assert.ok(!JSON.stringify(item).includes('private-wish'));assert.equal((await h.page({purpose:'conversation'})).items.length,0);
  await h.localWish(h.f,id,{enabled:true,purposes:['conversation'],functions:['Beta']});
  item=(await h.page({purpose:'conversation'})).items[0];assert.deepEqual(item.discovery.functions,['beta']);
  await h.wish(h.f,{enabled:false});assert.equal((await h.page()).items.length,0);await h.detail(id);
  await h.wish(h.f,{enabled:true,temporary:{until:h.f.now+10,contact:'paused'}});assert.equal((await h.page()).items.length,0);
  h.setNow(h.f.now+11);assert.equal((await h.page()).items.length,1,'expired pause restores the existing long/project wishes');
  await h.localWish(h.f,id,{enabled:true,functions:['PRIVATE-NONMATCH']});assert.equal((await h.page()).items.length,0);
  await h.localWish(h.f,id,null);assert.equal((await h.page()).items.length,1);
  const settings=await h.f.notifications.preferences(h.f.actor);await h.f.notifications.save(h.f.actor,{expectedRevision:settings.revision,settings:{...settings.settings,enabled:false}});
  assert.equal((await h.page()).items.length,1,'Notification delivery switch is not Discovery willingness');
  await h.localWish(h.f,id,{enabled:false});
  const transferId=randomUUID();await h.write(h.f,id,'offer-transfer',{transferId,toSubjectId:h.b.actor.subjectId});await h.write(h.b,id,'accept-transfer',{transferId});
  assert.equal((await h.page()).items.length,0,'new owner defaults off');
  await h.wish(h.b,{enabled:true});assert.equal((await h.page()).items[0].ownerId,h.b.actor.subjectId,'old owner project override is not inherited');
  await h.wish(h.b,{enabled:false});assert.equal((await h.page()).items.length,0);await h.detail(id);
}));

test('encrypted cursors bind query and viewer and recheck current visible sources, without private-source fingerprints',{timeout:60000},()=>harness(async h=>{
  await h.wish(h.f,{enabled:true});
  const ids=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003'];
  for(const id of ids)await h.create(h.f,{...document,title:'Cursor '+id.slice(-1)},id);
  const hidden=await h.create(h.f,{...document,title:'HIDDEN-CURSOR'},'10000000-0000-4000-8000-000000000004',{visibility:'Private'});
  const first=await h.page({limit:1});assert.deepEqual(first.items.map(item=>item.projectId),ids.slice(0,1));assert.ok(first.nextAfter);assert.ok(!first.nextAfter.includes(hidden.event.projectId));
  for(const input of [{limit:2},{limit:1,query:'cursor'},{limit:1,kind:'module'},{limit:1,purpose:'reuse'}])assert.equal((await h.page({...input,after:first.nextAfter},null,409)).error,'project_directory_cursor_unavailable_restart');
  assert.equal((await h.page({limit:1,after:first.nextAfter},h.f,409)).error,'project_directory_cursor_unavailable_restart');
  const tampered=first.nextAfter.slice(0,-1)+(first.nextAfter.endsWith('A')?'B':'A');await h.page({limit:1,after:tampered},null,409);
  await h.write(h.f,hidden.event.projectId,'revise',{patch:{summary:'PRIVATE-EDIT'}},{visibility:'Private'});
  const second=await h.page({limit:1,after:first.nextAfter});assert.deepEqual(second.items.map(item=>item.projectId),ids.slice(1,2));
  await h.write(h.f,ids[2],'revise',{patch:{title:'Current changed'}});
  assert.equal((await h.page({limit:1,after:second.nextAfter},null,409)).error,'project_directory_sources_changed_retry');
  const fresh=await h.page({limit:1});await h.localWish(h.f,ids[2],{enabled:false});
  assert.equal((await h.page({limit:1,after:fresh.nextAfter},null,409)).error,'project_directory_sources_changed_retry');
  const owned=await h.page({limit:1},h.f);await h.page({limit:1,after:owned.nextAfter},h.b,409);
  const expiring=await h.page({limit:1});h.setNow(h.f.now+901);assert.equal((await h.page({limit:1,after:expiring.nextAfter},null,409)).error,'project_directory_cursor_unavailable_restart');
  h.setNow(h.f.now);const restarting=await h.page({limit:1});h.f.projects.directoryCursorKey=Buffer.alloc(32,17);await h.page({limit:1,after:restarting.nextAfter},null,409);
}));

test('a finite 200-candidate empty scan window continues opaquely and cannot reveal hidden Project positions',{timeout:60000},()=>harness(async h=>{
  await h.wish(h.f,{enabled:true});
  const hidden=await h.create(h.f,document,'00000000-0000-4000-8000-000000000001',{visibility:'Private'});
  // Real signed private Project creates exercise the fixed production window;
  // no test-only scan limit or forged public source is injected.
  for(let index=2;index<=200;index++)await h.create(h.f,document,`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,{visibility:'Private'});
  const visible=await h.create(h.f,document,'f0000000-0000-4000-8000-000000000001');
  const before=await h.snapshot(),first=await h.page({limit:3});assert.deepEqual(first.items,[]);assert.ok(first.nextAfter);assert.equal(first.coverage.scanWindowLimit,200);assert.equal(first.coverage.windowLimited,true);
  assert.ok(!JSON.stringify(first).includes(hidden.event.projectId));
  const last=await h.page({limit:3,after:first.nextAfter});assert.deepEqual(last.items.map(item=>item.projectId),[visible.event.projectId]);assert.equal(last.nextAfter,null);
  assert.equal(await h.snapshot(),before);assert.equal((await h.page({limit:3},h.f)).items.length,0,'owner cannot surface private candidates within the first window');
}));

test('pending deletion, cancelled deletion and source binding revocation apply to anonymous and owner directory reads',{timeout:60000},()=>harness(async h=>{
  await h.wish(h.f,{enabled:true});const created=await h.create();assert.equal((await h.page()).items.length,1);
  const deletion={version:1,id:randomUUID(),endpoint:h.f.access.endpoint,subjectId:h.f.actor.subjectId,bindingId:h.f.actor.bindingId,
    issuedAt:h.f.now,expiresAt:h.f.now+300,action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'};
  const receipt=await h.request(h.f,'/v1/deletion-requests/submit',{signed:await h.f.signForTest(JSON.stringify(deletion),'galaxy-deletion-intent+jws')});
  assert.equal((await h.page()).items.length,0);assert.equal((await h.page({},h.f)).items.length,0);
  assert.equal((await h.detail(created.event.projectId,h.f)).document.title,document.title,'owner recovery detail rights do not elevate the directory');
  const cancel={version:1,id:randomUUID(),endpoint:h.f.access.endpoint,subjectId:h.f.actor.subjectId,bindingId:h.f.actor.bindingId,
    issuedAt:h.f.now,expiresAt:h.f.now+300,action:'cancel',requestId:receipt.id,expectedRevision:1};
  await h.request(h.f,'/v1/deletion-requests/submit',{signed:await h.f.signForTest(JSON.stringify(cancel),'galaxy-deletion-intent+jws')});
  assert.equal((await h.page()).items.length,1);
  await h.request(h.f,`/v1/bindings/${h.f.actor.bindingId}/revoke`,{});
  assert.equal((await h.page()).items.length,0);await h.page({},h.f,401);await h.detail(created.event.projectId,null,403);
}));
