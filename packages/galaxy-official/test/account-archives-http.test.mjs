import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';

// Actual isolated OIDC entry and signed-ID association are exercised through
// production HTTP routes. These synthetic accounts are not a browser/host run.
async function browserAccount(f,name){
 const cookies=new Map();
 const accept=response=>{for(const item of response.headers.getSetCookie()){const pair=item.split(';')[0];cookies.set(pair.split('=')[0],pair);}};
 const cookie=()=>[...cookies.values()].join('; ');
 f.issuer.setAccount(name);
 const started=await fetch(f.origin+'/v1/account/login',{redirect:'manual'});accept(started);assert.equal(started.status,303);
 const returned=await f.issuer.authorize(started.headers.get('location'));
 const callback=await fetch(f.origin+returned.pathname+returned.search,{redirect:'manual',headers:{Cookie:cookie()}});accept(callback);assert.equal(callback.status,303);
 const session=await (await fetch(f.origin+'/v1/account/session',{headers:{Cookie:cookie(),Origin:f.website}})).json();
 assert.equal(session.state,'signed-in');assert.ok(session.account.id);
 async function request(path,{input,method=input===undefined?'GET':'POST',headers={}}={}){
  const response=await fetch(f.origin+path,{method,headers:{Cookie:cookie(),Origin:f.website,
   'X-Galaxy-Account-ID':session.account.id,'X-Galaxy-Account-CSRF':session.csrfToken,
   ...(input===undefined?{}:{'Content-Type':'application/json'}),...headers},...(input===undefined?{}:{body:JSON.stringify(input)})});
  return {status:response.status,body:await response.json()};
 }
 return {session,request,post:(action,input,headers={})=>request('/v1/account/archives/'+action,{input,headers}),
  list:(input={},headers={})=>request('/v1/account/archives'+(Object.keys(input).length?'?'+new URLSearchParams(input):''),{headers})};
}
async function native(f,who,accountId,action,input,headers={}){
 const response=await fetch(f.origin+'/v2/account-archives/'+action,{method:'POST',headers:{Authorization:'Bearer '+who.credential,
  'Content-Type':'application/json',...(accountId?{'X-Galaxy-Account-ID':accountId}:{}),...headers},body:JSON.stringify(input)});
 return {status:response.status,body:await response.json()};
}
const archiveInput=(overrides={})=>({id:randomUUID(),title:'An explicitly selected private conversation',
 selection:{workspaceId:null,sessionIds:['selected-session'],scopeId:randomUUID()},uploadLevel:'conversation-archive',includeFullConversation:true,...overrides});
async function readyArchive(f,who,accountId,input=archiveInput(),content='{"messages":[{"role":"user","text":"Synthetic selected material"}]}'){
 const created=await native(f,who,accountId,'create',input);assert.equal(created.status,200,JSON.stringify(created.body));
 const chunk=await native(f,who,accountId,'chunk',{id:input.id,sequence:0,content});assert.equal(chunk.status,200,JSON.stringify(chunk.body));
 const complete=await native(f,who,accountId,'complete',{id:input.id,chunkCount:1});assert.equal(complete.status,200,JSON.stringify(complete.body));
 return {input,content,archive:complete.body};
}
function assertOk(response){assert.equal(response.status,200,JSON.stringify(response.body));return response.body;}

test('private archive HTTP requires an explicit current target and a selected highest upload type',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const first=await browserAccount(f,'archive-target-a'),second=await browserAccount(f,'archive-target-b');
  assert.deepEqual(first.session.linkedIds,[]);assert.deepEqual(second.session.linkedIds,[]);
  await f.login(f.owner,'archive-target-a');await f.login(f.owner,'archive-target-b');
  const input=archiveInput();
  assert.equal((await native(f,f.owner,null,'create',input)).body.error,'account_selection_required');
  const targets=assertOk(await native(f,f.owner,null,'accounts',{}));assert.equal(targets.subjectId,f.owner.actor.subjectId);
  assert.deepEqual(new Set(targets.accounts.map(row=>row.accountId)),new Set([first.session.account.id,second.session.account.id]));
  for(const altered of [{...input,uploadLevel:'history-overview'},{...input,includeFullConversation:false},{...input,originSubjectId:f.responder.actor.subjectId}])
   assert.equal((await native(f,f.owner,second.session.account.id,'create',altered)).body.error,'invalid_account_data');
  const created=assertOk(await native(f,f.owner,second.session.account.id,'create',input));
  assert.equal(created.originSubjectId,f.owner.actor.subjectId);assert.equal(created.visibility,'Private');assert.equal(created.selection.workspaceId,null,'unknown workspace is not replaced by a fabricated identifier');assert.equal(created.expiresAt,null,'long-term private archives inherit no personal-summary or ordinary-chat default TTL');
  assert.equal(assertOk(await first.list()).archives.length,0);assert.equal(assertOk(await second.list()).archives[0].id,input.id);
  const switched=await second.list({}, {'X-Galaxy-Account-ID':first.session.account.id});assert.equal(switched.body.error,'official_account_changed');
  assert.equal((await second.post('delete',{id:input.id},{'X-Galaxy-Account-CSRF':'invalid'})).status,403);
  assert.equal((await second.post('status',{id:input.id},{Authorization:'Bearer invalid'})).status,401,'a rejected ID credential never falls back to a valid account Cookie');
  assert.equal((await second.post('status',{id:input.id},{Cookie:''})).status,401);
  assert.equal((await native(f,f.owner,first.session.account.id,'status',{id:input.id})).body.state,'absent');
 }finally{await f.close();}
});

test('two linked IDs cannot inspect, append, finish, delete or reuse each other private archives',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const owner=await browserAccount(f,'archive-origin-isolation');await f.login(f.owner,'archive-origin-isolation');await f.login(f.responder,'archive-origin-isolation');
  const accountId=owner.session.account.id,one=await readyArchive(f,f.owner,accountId),two=await readyArchive(f,f.responder,accountId);
  const cookieInput=archiveInput({title:'Owner-selected file without a local origin ID'});
  assert.equal(assertOk(await owner.post('create',cookieInput)).originSubjectId,null);
  assertOk(await owner.post('chunk',{id:cookieInput.id,sequence:0,content:'{"messages":[]}'}));
  assertOk(await owner.post('complete',{id:cookieInput.id,chunkCount:1}));
  const a=assertOk(await native(f,f.owner,accountId,'list',{})),b=assertOk(await native(f,f.responder,accountId,'list',{}));
  assert.deepEqual(a.archives.map(row=>row.id),[one.input.id]);assert.deepEqual(b.archives.map(row=>row.id),[two.input.id]);
  assert.equal(assertOk(await native(f,f.responder,accountId,'status',{id:one.input.id})).state,'absent');
  for(const [action,input] of [['chunk',{id:one.input.id,sequence:1,content:'not permitted'}],['complete',{id:one.input.id,chunkCount:1}],['export',{id:one.input.id,sequence:0}]])
   assert.equal((await native(f,f.responder,accountId,action,input)).status,404);
  assert.equal(assertOk(await native(f,f.responder,accountId,'delete',{id:one.input.id})).deleted,false);
  assert.equal((await native(f,f.responder,accountId,'create',one.input)).body.error,'archive_conflict');
  assert.equal(assertOk(await native(f,f.owner,accountId,'status',{id:cookieInput.id})).state,'absent','a linked ID does not acquire account-uploaded material with no ID origin');
  assert.equal((await native(f,f.owner,accountId,'export',{id:cookieInput.id,sequence:0})).status,404);
  assert.equal((await native(f,f.responder,accountId,'list',{after:one.input.id,limit:1})).body.error,'invalid_archive_cursor');
  const all=assertOk(await owner.list());assert.equal(all.archives.length,3);assert.deepEqual(new Set(all.archives.map(row=>row.originSubjectId)),new Set([f.owner.actor.subjectId,f.responder.actor.subjectId,null]));
  assert.equal(assertOk(await owner.post('export',{id:one.input.id,sequence:0})).content,one.content);
  assert.equal(assertOk(await owner.post('export',{id:two.input.id,sequence:0})).content,two.content);
  assert.equal(assertOk(await owner.post('export',{id:cookieInput.id,sequence:0})).content,'{"messages":[]}');
  assert.equal(assertOk(await owner.post('delete',{id:one.input.id})).deleted,true,'the website owner can delete all account-owned origins without local ID control');
  assert.equal(assertOk(await native(f,f.responder,accountId,'status',{id:one.input.id})).state,'absent','another origin cannot inspect a private deletion marker');
  assert.equal(assertOk(await native(f,f.owner,accountId,'status',{id:one.input.id})).reason,'owner-deleted');
  assert.equal(assertOk(await native(f,f.responder,accountId,'status',{id:two.input.id})).state,'ready');
 }finally{await f.close();}
});

test('selected archive chunks retry idempotently, enforce completeness, and export the original JSON byte for byte',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const owner=await browserAccount(f,'archive-chunks');await f.login(f.owner,'archive-chunks');const accountId=owner.session.account.id,input=archiveInput();
  const original='{\r\n  "session": { "id": "selected-session", "unknown": null },\r\n  "messages": [\r\n    {"role":"user","text":"整理读书笔记 📚\\n保留换行"},\r\n    {"role":"assistant","text":"A source statement, without a credibility rating."}\r\n  ]\r\n}\r\n';
  const split=original.indexOf('"messages"'),chunks=[original.slice(0,split),original.slice(split)];
  assertOk(await native(f,f.owner,accountId,'create',input));assertOk(await native(f,f.owner,accountId,'create',input));
  assertOk(await native(f,f.owner,accountId,'chunk',{id:input.id,sequence:1,content:chunks[1]}));
  assert.deepEqual(assertOk(await native(f,f.owner,accountId,'status',{id:input.id})).storedSequences,[1]);
  assert.equal((await native(f,f.owner,accountId,'complete',{id:input.id,chunkCount:2})).body.error,'archive_incomplete');
  assert.equal((await owner.post('export',{id:input.id,sequence:0})).body.error,'archive_incomplete');
  assertOk(await native(f,f.owner,accountId,'chunk',{id:input.id,sequence:0,content:chunks[0]}));
  assertOk(await native(f,f.owner,accountId,'chunk',{id:input.id,sequence:1,content:chunks[1]}));
  const completed=assertOk(await native(f,f.owner,accountId,'complete',{id:input.id,chunkCount:2}));assert.equal(completed.byteLength,Buffer.byteLength(original,'utf8'));assert.equal(completed.chunkCount,2);
  assertOk(await native(f,f.owner,accountId,'complete',{id:input.id,chunkCount:2}));
  assertOk(await native(f,f.owner,accountId,'chunk',{id:input.id,sequence:0,content:chunks[0]}));
  assert.equal((await native(f,f.owner,accountId,'chunk',{id:input.id,sequence:0,content:chunks[0]+'changed'})).body.error,'archive_chunk_conflict');
  assert.equal((await native(f,f.owner,accountId,'chunk',{id:input.id,sequence:2,content:'not part of completed archive'})).body.error,'archive_already_complete');
  const exported=[];let sequence=0;
  do{const result=assertOk(await owner.post('export',{id:input.id,sequence}));exported.push(result.content);sequence=result.nextSequence;}while(sequence!==null);
  assert.equal(exported.join(''),original);assert.deepEqual(JSON.parse(exported.join('')),JSON.parse(original));
  assert.equal(assertOk(await owner.post('status',{id:input.id})).archive.originSubjectId,f.owner.actor.subjectId);
  assert.equal(assertOk(await native(f,f.owner,accountId,'status',{id:input.id})).archive.byteLength,Buffer.byteLength(original,'utf8'),'retries do not count the same content twice');
 }finally{await f.close();}
});

test('website deletion clears chunks and tombstones the selected scope against old uploads while leaving other work and local bytes',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const owner=await browserAccount(f,'archive-delete-scope');await f.login(f.owner,'archive-delete-scope');const accountId=owner.session.account.id;
  const selected=await readyArchive(f,f.owner,accountId),other=await readyArchive(f,f.owner,accountId);
  const removed=assertOk(await owner.post('delete',{id:selected.input.id}));assert.equal(removed.deleted,true);
  assert.equal(assertOk(await owner.post('delete',{id:selected.input.id})).deleted,true);
  const state=assertOk(await native(f,f.owner,accountId,'status',{id:selected.input.id}));assert.equal(state.state,'deleted');assert.equal(state.reason,'owner-deleted');assert.equal(state.scopeId,selected.input.selection.scopeId);
  assert.equal((await native(f,f.owner,accountId,'create',selected.input)).body.error,'archive_deleted');
  assert.equal((await native(f,f.owner,accountId,'create',{...selected.input,id:randomUUID()})).body.error,'archive_deleted','new archive IDs cannot silently bypass the same deleted scope');
  assert.equal((await native(f,f.owner,accountId,'chunk',{id:selected.input.id,sequence:0,content:selected.content})).status,404);
  assert.equal((await owner.post('export',{id:selected.input.id,sequence:0})).status,404);
  assert.equal(Number((await f.db.query('SELECT count(*) n FROM private_conversation_chunks_v1 WHERE archive_id=$1',[selected.input.id])).rows[0].n),0);
  assert.equal(assertOk(await owner.post('export',{id:other.input.id,sequence:0})).content,other.content);
  const newSelection={...selected.input,id:randomUUID(),selection:{...selected.input.selection,scopeId:randomUUID()}};
  assertOk(await native(f,f.owner,accountId,'create',newSelection));
  assert.equal(selected.content,'{"messages":[{"role":"user","text":"Synthetic selected material"}]}','remote deletion has not mutated the caller local bytes');
 }finally{await f.close();}
});

test('unlink immediately rejects the original ID archive actions while the independent account retains its private copy',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const owner=await browserAccount(f,'archive-unlink'),other=await browserAccount(f,'archive-other-account');await f.login(f.owner,'archive-unlink');
  const accountId=owner.session.account.id,selected=await readyArchive(f,f.owner,accountId);
  const links=assertOk(await f.request('/v1/identity/query',{who:f.owner,input:{}}));
  const current=links.items.find(row=>row.subjectId===f.owner.actor.subjectId&&row.state==='linked');assert.ok(current);
  assert.equal(assertOk(await f.request('/v1/identity/revoke',{who:f.owner,input:{id:current.id}})).state,'revoked');
  for(const [action,input] of [['status',{id:selected.input.id}],['list',{}],['export',{id:selected.input.id,sequence:0}],['delete',{id:selected.input.id}],['create',archiveInput()]]){
   const response=await native(f,f.owner,accountId,action,input);assert.equal(response.status,403,action);assert.equal(response.body.error,'account_target_unavailable');
  }
  assert.equal(assertOk(await native(f,f.owner,null,'accounts',{})).accounts.length,0);
  assert.equal(assertOk(await owner.post('export',{id:selected.input.id,sequence:0})).content,selected.content);
  assert.equal(assertOk(await other.post('status',{id:selected.input.id})).state,'absent');
  assert.equal(assertOk(await other.post('delete',{id:selected.input.id})).deleted,false);
  assert.equal(assertOk(await owner.post('delete',{id:selected.input.id})).deleted,true);
 }finally{await f.close();}
});

test('private archive pagination covers all owner and origin records without leaking another origin cursor',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const owner=await browserAccount(f,'archive-page');await f.login(f.owner,'archive-page');await f.login(f.responder,'archive-page');const accountId=owner.session.account.id;
  const ids=[];
  for(let index=0;index<4;index++){
   const who=index%2?f.responder:f.owner,created=assertOk(await native(f,who,accountId,'create',archiveInput({title:'Selected archive '+index})));
   ids.push({id:created.id,origin:created.originSubjectId});
  }
  const website=[];let after;
  do{const page=assertOk(await owner.list({limit:1,...(after?{after}:{})}));website.push(...page.archives.map(row=>row.id));after=page.nextAfter;}while(after);
  assert.equal(new Set(website).size,4);assert.deepEqual(new Set(website),new Set(ids.map(row=>row.id)));
  const subject=[];after=undefined;
  do{const page=assertOk(await native(f,f.owner,accountId,'list',{limit:1,...(after?{after}:{})}));subject.push(...page.archives.map(row=>row.id));after=page.nextAfter;}while(after);
  assert.deepEqual(new Set(subject),new Set(ids.filter(row=>row.origin===f.owner.actor.subjectId).map(row=>row.id)));
  const foreign=ids.find(row=>row.origin===f.responder.actor.subjectId).id;
  assert.equal((await native(f,f.owner,accountId,'list',{limit:1,after:foreign})).body.error,'invalid_archive_cursor');
  assert.equal((await owner.request('/v1/account/archives?limit=1&limit=2')).body.error,'invalid_archive_cursor');
  assert.equal((await owner.list({limit:0})).body.error,'invalid_account_data');
  assert.equal((await native(f,f.owner,accountId,'list',{limit:101})).body.error,'invalid_account_data');
 }finally{await f.close();}
});

test('private archive cursors survive anchor deletion and cleanup without acquiring another account or origin',{timeout:60000},async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const owner=await browserAccount(f,'archive-stable-page'),other=await browserAccount(f,'archive-stable-other');await f.login(f.owner,'archive-stable-page');await f.login(f.responder,'archive-stable-page');
  const accountId=owner.session.account.id,ids=[];
  for(let index=0;index<4;index++){f.clock.now++;ids.push((await readyArchive(f,f.owner,accountId)).input.id);}
  const first=assertOk(await owner.list({limit:1})),nativeFirst=assertOk(await native(f,f.owner,accountId,'list',{limit:1}));
  assert.equal(first.archives[0].id,ids[3]);assert.ok(first.nextAfter.startsWith('ac1.'));assert.ok(first.nextAfter.length<=512);
  assert.equal((await other.list({after:first.nextAfter,limit:1})).body.error,'invalid_archive_cursor');
  assert.equal((await native(f,f.owner,accountId,'list',{after:first.nextAfter,limit:1})).body.error,'invalid_archive_cursor','a website-wide position is not an original-ID position');
  assert.equal((await native(f,f.responder,accountId,'list',{after:nativeFirst.nextAfter,limit:1})).body.error,'invalid_archive_cursor');
  assertOk(await owner.post('delete',{id:ids[3]}));
  const second=assertOk(await owner.list({after:first.nextAfter,limit:1}));assert.equal(second.archives[0].id,ids[2]);
  assert.equal(assertOk(await native(f,f.owner,accountId,'list',{after:nativeFirst.nextAfter,limit:1})).archives[0].id,ids[2]);
  await f.db.query('UPDATE private_conversation_archives_v1 SET expires_at=$2 WHERE id=$1',[ids[2],new Date((f.clock.now+1)*1000).toISOString()]);f.clock.now+=2;
  const third=assertOk(await owner.list({after:second.nextAfter,limit:1}));assert.equal(third.archives[0].id,ids[1]);
  const last=assertOk(await owner.list({after:third.nextAfter,limit:1}));assert.deepEqual(last.archives.map(row=>row.id),[ids[0]]);assert.equal(last.nextAfter,null);
  assert.deepEqual(assertOk(await owner.list({after:ids[1],limit:1})).archives.map(row=>row.id),[ids[0]],'existing UUID positions remain supported');
  const link=assertOk(await f.request('/v1/identity/query',{input:{}})).items.find(item=>item.state==='linked');assert.ok(link);
  assertOk(await f.request('/v1/identity/revoke',{input:{id:link.id}}));
  assert.equal((await native(f,f.owner,accountId,'list',{after:nativeFirst.nextAfter,limit:1})).body.error,'account_target_unavailable');
  assert.equal(assertOk(await owner.list({after:second.nextAfter,limit:1})).archives[0].id,ids[1]);
 }finally{await f.close();}
});
