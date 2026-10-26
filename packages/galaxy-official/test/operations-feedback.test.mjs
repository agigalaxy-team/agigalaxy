import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {migrate} from "../src/infrastructure/database.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {OperationsFeedbackService} from "../src/operations/feedback/service.mjs";
import {createOfficialAccountPortal} from "../src/accounts/official-account.mjs";
import {createApi} from '../src/http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';

async function fixture(t){
 const f=await accountChatFixture();t.after(f.close);
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now}),
  feedback=new OperationsFeedbackService({businessAdmin,accounts:f.accounts,now:f.now}),
  admin={kind:'business-operator',operatorId:'feedback-synthetic-admin',role:'administrator',endpoint:f.endpoint},
  reader={...admin,operatorId:'feedback-synthetic-reader',role:'reader'};
 for(const actor of [admin,reader])await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://operations.example.org',$1,'合成运营人员',$3,$3)`,[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 await attachOperationsFixtureAuthority({businessAdmin,admin,reader,permissions:['feedback.read','analytics.read']});
 return {...f,businessAdmin,feedback,admin,reader};
}

test('ordinary feedback uses real private SQL records, per-account limits, exact revisions, idempotency and separate operator roles',{timeout:60000},async t=>{
 const f=await fixture(t),[person,other,third]=f.people;
 await migrate(f.db,{roles:['api']});
 await f.db.exec('SET ROLE galaxy_api');
 const body='PRIVATE_FEEDBACK_BODY 一条真实问题说明',note='PRIVATE_INTERNAL_NOTE 只供运营处理',
  first={operationId:randomUUID(),body,category:'problem',module:'account'},saved=await f.feedback.submit(person,first);
 assert.equal(saved.replayed,false);assert.deepEqual(Object.keys(saved).sort(),['feedbackId','operationId','replayed','submittedAt']);
 assert.deepEqual(await f.feedback.submit(person,first),{...saved,replayed:true},'lost acknowledgement retry does not create or consume quota twice');
 await assert.rejects(f.feedback.submit(person,{...first,body:body+'changed'}),{code:'feedback_operation_conflict'});
 await assert.rejects(f.feedback.submit(person,{operationId:randomUUID(),body:'too soon'}),{code:'feedback_rate_limited'});
 await assert.rejects(f.feedback.submit({...person,kind:'business-operator'},{operationId:randomUUID(),body:'wrong principal'}),{code:'official_account_login_required'});
 await assert.rejects(f.feedback.submit({...person,endpoint:'https://foreign.example.org'},{operationId:randomUUID(),body:'foreign'}),{code:'official_account_login_required'});
 await assert.rejects(f.feedback.submit(person,{operationId:randomUUID(),body:'x'.repeat(6001)}),{code:'invalid_feedback_request'});
 await assert.rejects(f.feedback.submit(person,{operationId:randomUUID(),body:'a\u0000b'}),{code:'invalid_feedback_request'});
 const second=await f.feedback.submit(other,{operationId:randomUUID(),body:'另一项使用建议',category:'suggestion',module:'account'}),
  unclassified=await f.feedback.submit(third,{operationId:randomUUID(),body:'没有额外分类也能提交'});
 const page=await f.feedback.list(f.reader,{days:'all',limit:1});
 assert.equal(page.items[0].id,unclassified.feedbackId);assert.ok(page.nextAfter);assert.equal(page.permissions.canManage,false);
 assert.equal((await f.feedback.list(f.reader,{days:'all',limit:1,after:page.nextAfter})).items[0].id,second.feedbackId);
 const filtered=await f.feedback.list(f.admin,{days:'all',module:'account',category:'problem',state:'pending'});
 assert.equal(filtered.items.length,1);assert.deepEqual(filtered.summary,{total:2,unclassified:0,pending:2,closed:0,
  byCategory:[{category:null,count:0},{category:'problem',count:1},{category:'suggestion',count:1}]});
 assert.equal((await f.feedback.list(f.reader,{category:'unclassified'})).items[0].id,unclassified.feedbackId);
 const edit={operationId:randomUUID(),expectedRevision:1,state:'processing',note};
 await assert.rejects(f.feedback.event(f.reader,saved.feedbackId,edit),{code:'operations_permission_denied'});
 await assert.rejects(f.feedback.list(person),{code:'business_admin_denied'});
 const changed=await f.feedback.event(f.admin,saved.feedbackId,edit);
 assert.equal(changed.feedback.revision,2);assert.equal(changed.feedback.state,'processing');assert.equal(changed.feedback.body,body);
 assert.equal(changed.history.items[0].note,note);assert.equal(changed.history.items[0].operatorId,f.admin.operatorId);
 assert.equal(changed.history.items[1].kind,'submitted');assert.equal(changed.history.items[1].operatorId,null);
 const replay=await f.feedback.event(f.admin,saved.feedbackId,edit);assert.equal(replay.replayed,true);assert.equal(replay.feedback.revision,2);assert.equal(replay.history.items.length,2);
 await assert.rejects(f.feedback.event(f.admin,saved.feedbackId,{...edit,note:'changed'}),{code:'business_admin_operation_conflict'});
 await assert.rejects(f.feedback.event(f.admin,saved.feedbackId,{operationId:randomUUID(),expectedRevision:1,state:'closed'}),{code:'feedback_revision_conflict'});
 await assert.rejects(f.feedback.event(f.admin,saved.feedbackId,{operationId:randomUUID(),expectedRevision:2,state:'processing'}),{code:'feedback_no_change'});
 const closed=await f.feedback.event(f.admin,saved.feedbackId,{operationId:randomUUID(),expectedRevision:2,state:'closed',category:'suggestion',module:'other'});
 assert.equal(closed.feedback.revision,3);assert.equal(closed.feedback.submittedCategory,'problem');assert.equal(closed.feedback.submittedModule,'account');
 assert.equal(closed.feedback.attachmentCount,0);assert.deepEqual(closed.feedback.attachments,[]);
 assert.equal(closed.history.items[1].state,'processing','history preserves each prior state');
 await assert.rejects(f.db.query('UPDATE operations_feedback_v1 SET body=$2 WHERE id=$1',[saved.feedbackId,'rewrite']),/permission denied/);
 await assert.rejects(f.db.query('UPDATE operations_feedback_events_v1 SET note=$2 WHERE feedback_id=$1',[saved.feedbackId,'rewrite']),/permission denied/);
 await assert.rejects(f.feedback.get({...f.reader,endpoint:'https://foreign.example.org'},saved.feedbackId),{code:'business_admin_denied'});
 await assert.rejects(f.feedback.get(f.reader,randomUUID()),{code:'not_found'});
 const history=await f.feedback.get(f.reader,saved.feedbackId,{historyAfter:closed.history.items[1].sequence});
 assert.equal(history.history.items.length,1);assert.equal(history.history.items[0].kind,'submitted');
 for(let n=1;n<5;n++){f.advance(61);await f.feedback.submit(person,{operationId:randomUUID(),body:'在服务器允许的频率内提交 '+n});}
 f.advance(61);await assert.rejects(f.feedback.submit(person,{operationId:randomUUID(),body:'超过24小时条数'}),{code:'feedback_daily_limit'});
 assert.equal((await f.feedback.submit(person,first)).feedbackId,saved.feedbackId,'quota does not prevent exact acknowledgement recovery');
 assert.equal((await f.feedback.list(f.reader,{days:7,query:body})).summary.total,1);
 const audit=JSON.stringify((await f.db.query('SELECT selection,result FROM business_admin_audit_v1')).rows);
 assert.equal(audit.includes('PRIVATE_FEEDBACK_BODY'),false);assert.equal(audit.includes('PRIVATE_INTERNAL_NOTE'),false);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM operations_product_commands_v1')).rows[0].n,0);
 const profile=await f.businessAdmin.accountSummary(f.reader,person.accountId);
 assert.equal(profile.profile.state,'not-analyzed');assert.equal(JSON.stringify(profile).includes('PRIVATE_'),false);
 f.advance(86400);await f.feedback.submit(person,{operationId:randomUUID(),body:'原24小时限制已自然过去'});
 f.advance(8*86400);assert.equal((await f.feedback.list(f.reader,{days:7})).summary.total,0);assert.equal((await f.feedback.list(f.reader,{days:'all'})).summary.total,8);
 await f.db.exec('RESET ROLE');
});

test('feedback HTTP registration uses real account sessions and CSRF and never exposes owner progress or prose in runtime logs',{timeout:60000},async t=>{
 const f=await fixture(t),website='https://galaxy.example.org',description={issuer:'https://login.example.org',clientId:'synthetic-feedback',redirectUri:f.endpoint+'/v1/account/callback'},
  provider={describe:()=>description},portal=createOfficialAccountPortal({provider,db:f.db,endpoint:f.endpoint,websiteOrigin:website,associationProviders:[provider],now:f.now}),
  token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url'),account=f.people[0],logs=[];
 // Only the session is synthetic. The portal's persistent session lookup,
 // current-account binding, Origin and CSRF checks are the real implementation.
 await f.db.query(`INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email,email_verified,csrf_token,created_at,expires_at)
  VALUES($1,$2,$3,$4,$5,'synthetic-0','synthetic@example.invalid',true,$6,$7,$8)`,
 [portal.configurationHash,f.digest(token),f.digest('synthetic-login'),account.accountId,description.issuer,csrf,f.now(),f.now()+3600]);
 const authorizeOperator=async(request,{write})=>{
  if(request.headers.origin!=='https://admin.example.org')throw new ServiceError('business_admin_denied',403);
  if(write&&request.headers['x-synthetic-csrf']!=='fixture-csrf')throw new ServiceError('business_admin_denied',403);
  return request.headers['x-synthetic-reader']==='true'?f.reader:f.admin;
 };
 const server=createApi({bindings:{endpoint:f.endpoint},officialAccounts:portal,operations:{portal:{authorizeOperator}},businessAdmin:f.businessAdmin,
  operationsFeedback:f.feedback,browserOrigins:[website,'https://admin.example.org'],logger:entry=>logs.push(entry),rateLimit:250});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port,
  headers={Origin:website,Cookie:'__Host-galaxy-account='+token,'Content-Type':'application/json','X-Galaxy-Account-ID':account.accountId,'X-Galaxy-Account-CSRF':csrf},
  input={operationId:randomUUID(),body:'HTTP_PRIVATE_FEEDBACK_BODY',category:'problem',module:'other'},post=(path,options={})=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(input),...options});
 const preflight=await fetch(base+'/v1/account/feedback',{method:'OPTIONS',headers:{Origin:website,'Access-Control-Request-Method':'POST',
  'Access-Control-Request-Headers':'content-type,x-galaxy-account-id,x-galaxy-account-csrf'}});
 assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-credentials'),'true');
 assert.match(preflight.headers.get('access-control-allow-headers'),/X-Galaxy-Account-CSRF/);
 const accepted=await post('/v1/account/feedback');assert.equal(accepted.status,201);assert.equal(accepted.headers.get('access-control-allow-credentials'),'true');
 const receipt=await accepted.json();assert.equal(receipt.replayed,false);
 const replay=await post('/v1/account/feedback');assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);
 for(const extra of [{Cookie:''},{'X-Galaxy-Account-CSRF':'bad'},{'X-Galaxy-Account-ID':f.people[1].accountId},{Authorization:'Bearer forbidden'}]){
  const denied=await post('/v1/account/feedback',{headers:{...headers,...extra}});assert.ok([401,403,409].includes(denied.status));await denied.arrayBuffer();
 }
 assert.equal((await fetch(base+'/v1/account/feedback',{headers})).status,404);
 assert.equal((await fetch(base+'/v1/account/feedback/'+receipt.feedbackId,{headers})).status,404);
 const operatorHeaders={Origin:'https://admin.example.org','Content-Type':'application/json','X-Synthetic-CSRF':'fixture-csrf'},
  query=await fetch(base+'/v1/operations/feedback?days=7',{headers:operatorHeaders});assert.equal(query.status,200);assert.equal((await query.json()).items[0].id,receipt.feedbackId);
 const directory=await fetch(base+'/v1/operations/users/summary?days=7',{headers:operatorHeaders});assert.equal(directory.status,200);assert.equal((await directory.json()).totals.accounts,3);
 const accountSummary=await fetch(base+'/v1/operations/users/'+account.accountId+'/summary?days=28',{headers:operatorHeaders});assert.equal(accountSummary.status,200);assert.equal((await accountSummary.json()).accountId,account.accountId);
 const directoryFilter=await fetch(base+'/v1/operations/users?subjectType=person&restriction=normal',{headers:operatorHeaders});assert.equal(directoryFilter.status,200);assert.equal((await directoryFilter.json()).items.length,3);
 const duplicate=await fetch(base+'/v1/operations/feedback?days=7&days=28',{headers:operatorHeaders});assert.equal(duplicate.status,400);await duplicate.arrayBuffer();
 const event={operationId:randomUUID(),expectedRevision:1,state:'closed',note:'HTTP_PRIVATE_NOTE'},path='/v1/operations/feedback/'+receipt.feedbackId+'/events';
 const reader=await post(path,{headers:{...operatorHeaders,'X-Synthetic-Reader':'true'},body:JSON.stringify(event)});assert.equal(reader.status,403);await reader.arrayBuffer();
 const noCsrf=await post(path,{headers:{...operatorHeaders,'X-Synthetic-CSRF':''},body:JSON.stringify(event)});assert.equal(noCsrf.status,403);await noCsrf.arrayBuffer();
 const changed=await post(path,{headers:operatorHeaders,body:JSON.stringify(event)});assert.equal(changed.status,200);const detail=await changed.json();assert.equal(detail.feedback.state,'closed');
 const earlier=await fetch(base+'/v1/operations/feedback/'+receipt.feedbackId+'?historyAfter='+detail.history.items[0].sequence,{headers:operatorHeaders});
 assert.equal(earlier.status,200);assert.equal((await earlier.json()).history.items[0].kind,'submitted');
 assert.equal(JSON.stringify(logs).includes('HTTP_PRIVATE_FEEDBACK_BODY'),false);assert.equal(JSON.stringify(logs).includes('HTTP_PRIVATE_NOTE'),false);
 await portal.revokeSessions({accountId:account.accountId});const revoked=await post('/v1/account/feedback');assert.equal(revoked.status,401);await revoked.arrayBuffer();
});
