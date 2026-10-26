import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {AccountWorkService} from '../src/account-work.mjs';
import {projectWorkHistoryForUpload} from '../../galaxy-core/src/upload-privacy.mjs';

async function browserAccount(f,name){
 const cookies=new Map(),accept=response=>{for(const item of response.headers.getSetCookie()){const pair=item.split(';')[0];cookies.set(pair.split('=')[0],pair);}};
 const cookie=()=>[...cookies.values()].join('; ');
 f.issuer.setAccount(name);
 const started=await fetch(f.origin+'/v1/account/login',{redirect:'manual'});accept(started);assert.equal(started.status,303);
 const returned=await f.issuer.authorize(started.headers.get('location'));
 const callback=await fetch(f.origin+returned.pathname+returned.search,{redirect:'manual',headers:{Cookie:cookie()}});accept(callback);assert.equal(callback.status,303);
 const session=await (await fetch(f.origin+'/v1/account/session',{headers:{Cookie:cookie(),Origin:f.website}})).json();
 assert.equal(session.state,'signed-in');
 const actor={kind:'official-account',accountId:session.account.id,endpoint:f.owner.access.endpoint};
 async function call(action,input,headers={}){
  const response=await fetch(f.origin+'/v1/account/work/'+action,{method:'POST',headers:{Cookie:cookie(),Origin:f.website,
   'Content-Type':'application/json','X-Galaxy-Account-ID':session.account.id,'X-Galaxy-Account-CSRF':session.csrfToken,...headers},body:JSON.stringify(input)});
  return {status:response.status,body:await response.json()};
 }
 return {actor,session,call};
}
function projection(who,{level='history-overview',workId=randomUUID(),summary='A model-reported writing result.'}={}){
 const at='2033-05-18T03:33:20.000Z',environmentId=randomUUID();
 const work={workId,galaxyId:who.actor.subjectId,host:'opencode',sessionId:'opaque-session',workType:'writing',role:'owner',
  startedAt:at,updatedAt:at,title:'A private project title',summary,outcome:'reported-success',summaryRevision:1,sourceKind:'user-model'};
 const record={work,environments:[{id:environmentId,version:1,observedAt:at,facts:{host:'opencode',hostVersion:'1.2.3',selectedModel:'local/model-v1',tools:['editor'],cwd:'C:/private/project'}}],
  observations:[{id:randomUUID(),sequence:1,sourceId:'message-source',revision:0,latestRevision:0,superseded:false,kind:'claim',occurredAt:null,observedAt:at,
   source:{kind:'model-report',messageId:'message-1'},content:{excerpt:summary,originalLength:summary.length,retained:'excerpt',availableFromHost:true},details:{statementOnly:true},
   exclusions:[],environmentId,environmentMeaning:'observed-at-collection',localOnly:true}]};
 return projectWorkHistoryForUpload({level},record).data;
}
function put(data,overrides={}){return {operationId:randomUUID(),workId:data.workId,scopeId:randomUUID(),revision:1,expectedRevision:0,data,...overrides};}
async function idCall(f,who,accountId,action,input,headers={}){
 const response=await fetch(f.origin+'/v2/account-work/'+action,{method:'POST',headers:{Authorization:'Bearer '+who.credential,'Content-Type':'application/json',
  ...(accountId?{'X-Galaxy-Account-ID':accountId}:{}),...headers},body:JSON.stringify(input)});
 return {status:response.status,body:await response.json()};
}

test('real signed-session sync is private, explicitly targeted, and visible to the independent website owner',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const one=await browserAccount(f,'work-owner-a'),two=await browserAccount(f,'work-owner-b');
  await f.login(f.owner,'work-owner-a');await f.login(f.owner,'work-owner-b');
  const data=projection(f.owner),input=put(data);
  assert.equal((await idCall(f,f.owner,null,'put',input)).body.error,'account_selection_required');
  const accepted=await idCall(f,f.owner,two.actor.accountId,'put',input);assert.equal(accepted.status,200,JSON.stringify(accepted.body));
  assert.equal(accepted.body.originSubjectId,f.owner.actor.subjectId);assert.equal(accepted.body.accountId,two.actor.accountId);
  assert.equal(accepted.body.audience,'owner-only');assert.equal(accepted.body.completeConversation,false);
  const read=await two.call('get',{workId:data.workId});assert.equal(read.status,200,JSON.stringify(read.body));assert.deepEqual(read.body.data,data);
  assert.equal(read.body.data.summary,undefined);assert.equal(read.body.data.observations,undefined);assert.equal(read.body.data.environments[0].facts.cwd,undefined);
  assert.equal((await one.call('get',{workId:data.workId})).body.state,'absent');
  const list=(await two.call('list',{})).body.items;assert.equal(list.length,1);assert.equal(list[0].workType,'writing');
  assert.equal(list[0].sourceHost,'opencode');assert.equal(list[0].title,undefined);assert.equal(list[0].preview,undefined);
  assert.equal((await one.call('list',{})).body.items.length,0);
  assert.equal((await two.call('status',{workId:data.workId},{'X-Galaxy-Account-ID':one.actor.accountId})).body.error,'official_account_changed');
  assert.equal((await two.call('get',{workId:data.workId},{Authorization:'Bearer invalid'})).status,401,'an invalid ID never falls back to Cookie authority');
  assert.equal((await two.call('put',input)).status,404,'the website cannot invent a local origin');
  const publicProfile=await fetch(f.origin+'/v1/account/public/'+two.actor.accountId);
  const publicBody=await publicProfile.json();assert.equal(JSON.stringify(publicBody).includes(data.workId),false,'sync does not turn on public account queries');
  const audit=(await f.db.query('SELECT * FROM account_work_operations_v1 WHERE operation_id=$1',[input.operationId])).rows[0];
  assert.equal(audit.origin_subject_id,f.owner.actor.subjectId);assert.equal(audit.origin_binding_id,f.owner.actor.bindingId);assert.ok(audit.http_request_id);
 }finally{await f.close();}
});

test('overview rejects prose, raw observations, unknown environment keys and false origins rather than silently dropping them',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const account=await browserAccount(f,'strict-work');await f.login(f.owner,'strict-work');
  const service=new AccountWorkService(f.owner.access,{accounts:f.owner.communityAccounts}),actor={...f.owner.actor,accountId:account.actor.accountId},data=projection(f.owner);
  for(const field of [{title:'Hidden prose'},{summary:{summary:'Hidden prose'}},{observations:[]},{conversation:'Full conversation'},{coverage:{observations:{sourceTotal:1,included:0,firstSequence:null,lastSequence:null,hasEarlier:true}}}])
   assert.throws(()=>service.put(actor,put({...data,...field})),{code:'account_work_input_invalid'});
  const environment=structuredClone(data);environment.environments[0].facts.cwd='C:/private';
  assert.throws(()=>service.put(actor,put(environment)),{code:'account_work_input_invalid'});
  const forged={...data,galaxyId:f.responder.actor.subjectId};assert.throws(()=>service.put(actor,put(forged)),{code:'account_work_source_mismatch'});
  const secret=projection(f.owner,{level:'work-content'});secret.observations[0].details={password:'synthetic-not-a-real-password'};
  assert.throws(()=>service.put(actor,put(secret)),{code:'account_work_input_invalid'});
  const level1={...data,uploadLevel:'local-only'};assert.throws(()=>service.put(actor,put(level1)),{code:'account_work_input_invalid'});
  const content=projection(f.owner,{level:'work-content'});
  for(const coverage of [
   {observations:{sourceTotal:3,included:2,firstSequence:1,lastSequence:1,hasEarlier:true}},
   {observations:{sourceTotal:3,included:1,firstSequence:0,lastSequence:1,hasEarlier:true}},
   {observations:{sourceTotal:3,included:1,firstSequence:1,lastSequence:1,hasEarlier:false}},
   {observations:{sourceTotal:1,included:1,firstSequence:1,lastSequence:1,hasEarlier:false},omittedFields:['summary']}
  ])assert.throws(()=>service.put(actor,put({...content,coverage})),{code:'account_work_input_invalid'});
  assert.equal((await service.list(actor,{})).items.length,0);
 }finally{await f.close();}
});

test('unknown-ACK replay is idempotent, stale revisions cannot overwrite, and source revisions remain reports',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const account=await browserAccount(f,'work-retry');await f.login(f.owner,'work-retry');
  const service=new AccountWorkService(f.owner.access,{accounts:f.owner.communityAccounts}),actor={...f.owner.actor,accountId:account.actor.accountId};
  const data=projection(f.owner,{level:'work-content'});data.coverage={observations:{sourceTotal:3,included:1,firstSequence:1,lastSequence:1,hasEarlier:true}};
  const first=put(data),accepted=await service.put(actor,first);
  const listed=(await service.list(actor)).items[0];assert.equal(listed.title,data.summary.title);assert.equal(listed.preview,data.summary.summary.slice(0,240));
  assert.equal(accepted.title,undefined,'content previews do not enter retained operation receipts');assert.equal(accepted.preview,undefined);
  const retried=await service.put(actor,structuredClone(first));assert.equal(retried.duplicate,true);assert.equal(retried.revision,accepted.revision);
  await assert.rejects(service.put(actor,{...first,data:{...data,resultStatus:'partial'}}),{code:'account_work_operation_conflict'});
  const next={...first,operationId:randomUUID(),revision:2,expectedRevision:1,data:{...data,resultStatus:'partial'}};await service.put(actor,next);
  const oldReceipt=await service.put(actor,first);assert.equal(oldReceipt.revision,1);assert.equal(oldReceipt.lastOperationId,first.operationId);
  const current=await service.get(actor,{workId:first.workId});assert.equal(current.revision,2);assert.equal(current.lastOperationId,next.operationId);
  assert.equal(current.data.resultSource,'user-model');assert.equal(current.data.observations[0].source.kind,'model-report');
  assert.equal(current.data.observations[0].revision,0);assert.equal(current.completeConversation,false);
  assert.deepEqual(current.data.coverage,data.coverage,'the selected source and actual stored window remain distinct');
  await assert.rejects(service.put(actor,{...first,operationId:randomUUID()}),{code:'account_work_revision_conflict'});
  assert.equal(Number((await f.db.query('SELECT count(*) n FROM account_work_operations_v1 WHERE work_id=$1',[first.workId])).rows[0].n),2);
 }finally{await f.close();}
});

test('website owner deletion removes material and blocks every old scope without affecting other work or local source',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const account=await browserAccount(f,'work-delete');await f.login(f.owner,'work-delete');
  const service=new AccountWorkService(f.owner.access,{accounts:f.owner.communityAccounts}),actor={...f.owner.actor,accountId:account.actor.accountId};
  const original=projection(f.owner,{level:'work-content'}),input=put(original),other=put(projection(f.owner));
  await service.put(actor,input);await service.put(actor,other);
  const secondScope={...input,operationId:randomUUID(),scopeId:randomUUID(),revision:2,expectedRevision:1};await service.put(actor,secondScope);
  assert.equal((await account.call('delete',{workId:input.workId},{'X-Galaxy-Account-CSRF':'invalid'})).status,403);
  const removed=await account.call('delete',{workId:input.workId});assert.equal(removed.status,200,JSON.stringify(removed.body));
  assert.equal(removed.body.state,'deleted');assert.equal(removed.body.revision,3);assert.equal(removed.body.localOriginalsAffected,false);
  assert.equal((await service.status(actor,{workId:input.workId})).deletedReason,'owner-deleted');
  assert.equal((await account.call('get',{workId:input.workId})).body.data,null);
  await assert.rejects(service.put(actor,input),{code:'account_work_owner_deleted'});
  await assert.rejects(service.put(actor,{...secondScope,operationId:randomUUID(),revision:4,expectedRevision:3}),{code:'account_work_owner_deleted'});
  assert.equal((await service.get(actor,{workId:other.workId})).state,'stored');
  assert.equal((await account.call('delete',{workId:input.workId})).body.revision,3,'delete retries do not manufacture new source revisions');
  const stored=(await f.db.query('SELECT data FROM account_work_v1 WHERE account_id=$1 AND work_id=$2',[actor.accountId,input.workId])).rows[0];assert.equal(stored.data,null);
  assert.equal(JSON.stringify((await f.db.query('SELECT receipt FROM account_work_operations_v1 WHERE work_id=$1',[input.workId])).rows).includes(original.summary.summary),false);
  const selectedAgain={...input,operationId:randomUUID(),scopeId:randomUUID(),revision:4,expectedRevision:3};
  assert.equal((await service.put(actor,selectedAgain)).state,'stored','a newly selected scope is distinct from automatic old-scope retries');
  await assert.rejects(service.put(actor,input),{code:'account_work_owner_deleted'});
  assert.equal(original.summary.summary,'A model-reported writing result.','server deletion did not mutate the caller local source');
 }finally{await f.close();}
});

test('two IDs linked to one account keep scope and source isolation; website owner retains uploaded data after unlink',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const account=await browserAccount(f,'shared-work-account');await f.login(f.owner,'shared-work-account');await f.login(f.responder,'shared-work-account');
  const service=new AccountWorkService(f.owner.access,{accounts:f.owner.communityAccounts});
  const one={...f.owner.actor,accountId:account.actor.accountId},two={...f.responder.actor,accountId:account.actor.accountId};
  const input=put(projection(f.owner)),other=put(projection(f.responder));await service.put(one,input);await service.put(two,other);
  assert.equal((await service.get(two,{workId:input.workId})).state,'absent');
  assert.equal((await service.delete(two,{workId:input.workId})).state,'absent');
  assert.equal((await service.list(two,{})).items[0].workId,other.workId);assert.equal((await service.list(account.actor,{})).items.length,2);
  await assert.rejects(service.put(two,{...put(projection(f.responder)),scopeId:input.scopeId}),{code:'account_work_scope_mismatch'});
  await assert.rejects(service.put(two,put(projection(f.responder,{workId:input.workId}))),{code:'account_work_source_mismatch'});
  await f.db.query('UPDATE external_identity_links SET revoked_at=$2 WHERE subject_id=$1',[one.subjectId,new Date(f.clock.now*1000).toISOString()]);
  await assert.rejects(service.get(one,{workId:input.workId}),{code:'account_target_unavailable'});
  const retained=await account.call('get',{workId:input.workId});assert.equal(retained.body.data.galaxyId,one.subjectId);
  assert.equal((await account.call('delete',{workId:input.workId})).body.state,'deleted','website owner does not need a local ID to retract uploaded data');
 }finally{await f.close();}
});

test('concurrent accepted revision and stable pagination preserve distinct work without duplicate writes',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const account=await browserAccount(f,'work-concurrency');await f.login(f.owner,'work-concurrency');
  const service=new AccountWorkService(f.owner.access,{accounts:f.owner.communityAccounts}),actor={...f.owner.actor,accountId:account.actor.accountId};
  const input=put(projection(f.owner)),competing={...input,operationId:randomUUID()};
  const outcomes=await Promise.allSettled([service.put(actor,input),service.put(actor,competing)]);
  assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);assert.equal(outcomes.find(item=>item.status==='rejected').reason.code,'account_work_revision_conflict');
  await service.put(actor,put(projection(f.owner)));await service.put(actor,put(projection(f.owner)));
  const all=[];let after;
  do{const page=await service.list(account.actor,{limit:1,...(after?{after}:{})});all.push(...page.items.map(item=>item.workId));after=page.nextAfter;}while(after);
  assert.equal(all.length,3);assert.equal(new Set(all).size,3);assert.deepEqual(all,[...all].sort((a,b)=>a<b?-1:a>b?1:0));
 }finally{await f.close();}
});
