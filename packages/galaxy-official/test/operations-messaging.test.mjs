import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsMessagingService} from '../src/operations/messaging/service.mjs';
import {messagingRecoveryPolicy} from '../src/operations/messaging/policy.mjs';
import {OperationsNotices,createOperationsNoticeWorker} from '../src/operations-notices.mjs';
import {createAccountUid} from '../src/official-account-uid.mjs';
import {OperationsAiWorkAccountsService} from '../src/operations/accounts/ai-work-service.mjs';
import {OperationsAgentOsAuthority} from '../src/operations-agentos-authority.mjs';
import {transaction} from '../src/database.mjs';

// Real PGlite migrations, committed permissions, plan/run SQL and old account
// inbox. Only management/recipient directories, queue/clock and SMTP are
// explicit local doubles; no external SMTP, account or model is contacted.
async function fixture(t){
 const f=await accountChatFixture();t.after(f.close);
 const admin={kind:'business-operator',operatorId:'messaging-admin',role:'administrator',endpoint:f.endpoint,httpRequestId:randomUUID()},roles=new Map([[admin.operatorId,'administrator']]);
 await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operators.example.invalid',$1,'消息合成管理员',$3,$3)`,[admin.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const operatorAuthorization=async actor=>roles.get(actor.operatorId),permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization,now:f.now});
 const identities=new Map(f.people.map((person,index)=>['synthetic-'+index,{issuer:'https://login.example.org',externalSubject:'synthetic-'+index,email:'synthetic-'+index+'@example.invalid',emailVerified:true,enabled:true}]));
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,operatorAuthorization,identityDirectory:{get:async({externalSubject})=>identities.get(externalSubject)??null},now:f.now});
 const queued=[],scheduled=[],unscheduled=[];
 const jobs={onCancel(){},enqueue:async(name,data,options={})=>{const id=randomUUID();queued.push({id,name,data,options});return id;},
  previewSchedule:(_cron,{from})=>[new Date(new Date(from).getTime()+60000).toISOString()],schedule:async(...args)=>{scheduled.push(args);},unschedule:async(...args)=>{unscheduled.push(args);}};
 const submissions=[];let providerState='configured',submit=async input=>{await input.authorize();submissions.push({accountId:input.accountId,messageId:input.messageId});return {submission:'submitted',code:null,retryable:false,configVersion:'1'};};
 const mailProvider={status:async()=>({state:providerState,enabled:providerState==='configured',configVersion:providerState==='configured'?'1':null,receipts:'not-connected'}),submit:input=>submit(input)};
 const messaging=new OperationsMessagingService({db:f.db,endpoint:f.endpoint,businessAdmin,accounts:f.accounts,jobs,mailProvider,now:f.now});
 const auth={authorize:async()=>admin},config=(changes={})=>({channels:['announcement','inapp','email'],content:{purpose:'service-update',title:'本地合成消息',body:'本地行为验证材料。\n\n不作实际邮件发送。',href:'/guide/',expiresAt:new Date((f.now()+86400)*1000).toISOString()},audience:{kind:'all-accounts'},senderKey:'notice',schedule:{kind:'immediate'},...changes});
 const create=async configuration=>(await messaging.create(admin,{operationId:randomUUID(),config:configuration??config()},auth)).plan;
 const act=async(plan,kind)=>messaging.action(admin,plan.id,kind,{operationId:randomUUID(),expectedVersion:plan.version,expectedRevision:plan.revision},auth);
 const activate=async configuration=>{const plan=await create(configuration);return (await act(plan,'activate')).plan;};
 const execute=async(plan,context={jobId:randomUUID()})=>(await messaging.execute({planId:plan.id,planVersion:plan.version},context)).run;
 const addAccount=async(type='person')=>{const accountId=randomUUID(),subject='later-'+randomUUID(),at=new Date(f.now()*1000).toISOString();
  await f.db.query(`INSERT INTO community_accounts(id,uid,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,$3,'https://login.example.org',$4,'external-account',$5,$5)`,[accountId,createAccountUid(),f.endpoint,subject,at]);
  await f.db.query(`INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,updated_at) VALUES($1,$2,'本地新增账户',$3)`,[accountId,type,at]);
  identities.set(subject,{issuer:'https://login.example.org',externalSubject:subject,email:subject+'@example.invalid',emailVerified:true,enabled:true});return accountId;};
 return {...f,admin,roles,permissions,businessAdmin,identities,jobs,queued,scheduled,unscheduled,messaging,mailProvider,submissions,auth,config,create,act,activate,execute,addAccount,
  setSubmit:fn=>{submit=fn;},setProviderState:value=>{providerState=value;}};
}

test('messaging freezes current real account attributes per execution and independently publishes public, account-inbox and SMTP facts without replacing legacy notices',async t=>{
 const f=await fixture(t);
 await f.db.query("UPDATE official_account_profiles_v1 SET subject_type='agent' WHERE account_id=$1",[f.people[1].accountId]);
 await f.db.query("UPDATE official_account_profiles_v1 SET subject_type='organization' WHERE account_id=$1",[f.people[2].accountId]);
 const old=new OperationsNotices({db:f.db,endpoint:f.endpoint,businessAdmin:f.businessAdmin,accounts:f.accounts,jobs:f.jobs,now:f.now});
 const legacy=(await old.create(f.admin,{operationId:randomUUID(),content:{...f.config().content,title:'原有已发布站内信',audience:{kind:'all-accounts'}}})).notice;
 await old.publish(f.admin,legacy.id,{operationId:randomUUID(),expectedVersion:1});await createOperationsNoticeWorker({notices:old}).execute({noticeId:legacy.id});
 let plan=await f.create(f.config({audience:{kind:'attributes',subjectTypes:['person','agent']}}));
 const beforeExecution=await f.addAccount('person');plan=(await f.act(plan,'activate')).plan;const run=await f.execute(plan);
 assert.equal(run.audience.accountCount,3);assert.equal(run.delivery.email.total,3);assert.equal(run.delivery.inapp.total,3);
 assert.equal(run.announcement.state,'published');assert.equal(run.announcement.audience,'public');assert.equal(run.scheduledAt,null);
 const afterFreeze=await f.addAccount('person');await f.db.query("UPDATE official_account_profiles_v1 SET subject_type='organization' WHERE account_id=$1",[f.people[1].accountId]);
 const done=await f.messaging.deliver({runId:run.id});assert.equal(done.run.delivery.inapp.delivered,2);assert.equal(done.run.delivery.inapp.skipped,1);
 assert.equal(done.run.delivery.email.submitted,2);assert.equal(done.run.delivery.email.skipped,1);assert.equal(done.run.delivery.email.delivered,null);assert.equal(done.run.delivery.email.bounced,null);
 assert.deepEqual(new Set(f.submissions.map(row=>row.accountId)),new Set([f.people[0].accountId,beforeExecution]));
 assert.equal(Number((await f.db.query('SELECT count(*) AS count FROM operations_messaging_recipients_v1 WHERE run_id=$1 AND account_id=$2',[run.id,afterFreeze])).rows[0].count),0);
 const inbox=await old.accountQuery(f.people[0]);assert(inbox.items.some(item=>item.noticeId===legacy.id));assert(inbox.items.some(item=>item.noticeId===run.id));
 await old.accountMarkRead(f.people[0],{noticeId:run.id});assert.equal((await old.accountQuery(f.people[0])).items.find(item=>item.noticeId===run.id).read,true);
 assert.equal((await f.messaging.announcements()).items.length,1);
 await f.create();const directory=await f.messaging.list(f.admin,{limit:1});assert.equal(directory.items.length,1);assert.equal(directory.summary.plans.total,2);assert.equal(directory.legacy.count,1);
 assert.equal(directory.summary.delivery.email.submitted,2);assert.equal(directory.summary.delivery.email.delivered,null);
 const detail=await f.messaging.run(f.admin,run.id);assert.equal(detail.capabilities.canRetry,false);const recipients=await f.messaging.recipients(f.admin,run.id,{limit:1});assert.equal(recipients.items.length,1);assert(recipients.nextAfter);
 assert(!JSON.stringify(recipients).includes('@example.invalid'));assert(!JSON.stringify((await f.businessAdmin.audit(f.admin,{kind:'business'}))).includes(f.config().content.body));
 const current=(await f.messaging.get(f.admin,plan.id)).plan;await f.act(current,'withdraw');assert.equal((await f.messaging.announcements()).items.length,0);await assert.rejects(f.messaging.announcement(run.id),{code:'operations_announcement_not_found'});
 const remaining=await old.accountQuery(f.people[0]);assert(remaining.items.some(item=>item.noticeId===legacy.id));assert(!remaining.items.some(item=>item.noticeId===run.id));
});

test('messaging schedules through fixed native queue contracts, pins each run version, skips paused occurrences and never expands a frozen resumed run',async t=>{
 const f=await fixture(t),once=f.config({channels:['inapp'],schedule:{kind:'once',at:new Date((f.now()+60)*1000).toISOString()}});
 let plan=await f.activate(once);assert.equal(f.queued.at(-1).options.startAfter,once.schedule.at);
 assert.deepEqual(await f.messaging.execute({planId:plan.id,planVersion:1},{jobId:randomUUID()}),{state:'not-executed',reason:'not-due'});
 f.advance(60);const run=await f.execute(plan),frozen=run.audience.accountCount;await f.addAccount();
 const replay=await f.messaging.execute({planId:plan.id,planVersion:1},{jobId:randomUUID()});assert.equal(replay.replayed,true);assert.equal(replay.run.id,run.id);assert.equal(replay.run.audience.accountCount,frozen);
 plan=(await f.act(plan,'pause')).plan;assert.equal((await f.messaging.deliver({runId:run.id})).run.state,'paused');assert.equal((await f.messaging.execute({planId:plan.id,planVersion:1},{jobId:randomUUID()})).reason,'paused');
 plan=(await f.act(plan,'resume')).plan;assert.equal((await f.messaging.deliver({runId:run.id})).run.delivery.inapp.delivered,frozen);
 plan=(await f.act(plan,'pause')).plan;const saved=await f.messaging.save(f.admin,plan.id,{operationId:randomUUID(),expectedVersion:1,expectedRevision:plan.revision,config:f.config({channels:['inapp'],content:{...f.config().content,title:'显式新版本'}})},f.auth);
 assert.equal(saved.plan.version,2);assert.equal(saved.plan.state,'draft');assert.equal((await f.messaging.execute({planId:plan.id,planVersion:1},{jobId:randomUUID()})).reason,'version-changed');
 assert.equal((await f.messaging.run(f.admin,run.id)).config.content.title,'本地合成消息');
 const recurring=await f.activate(f.config({channels:['inapp'],schedule:{kind:'recurring',cron:'*/5 * * * *',timezone:'Asia/Shanghai'}}));
 assert.equal(f.scheduled.at(-1)[0],'messaging-run');assert.equal(f.scheduled.at(-1)[3].missed,'skip');const occurrence=randomUUID(),first=await f.execute(recurring,{jobId:occurrence});
 assert.equal((await f.messaging.execute({planId:recurring.id,planVersion:1},{jobId:occurrence})).run.id,first.id);await f.addAccount();const second=await f.execute(recurring,{jobId:randomUUID()});assert.equal(second.audience.accountCount,first.audience.accountCount+1);
 const paused=(await f.act(recurring,'pause')).plan;assert.equal(f.unscheduled.at(-1)[0],'messaging-run');assert.equal((await f.messaging.execute({planId:paused.id,planVersion:1},{jobId:randomUUID()})).state,'not-executed');
 const history=await f.messaging.history(f.admin,plan.id,{limit:2});assert.equal(history.items.length,2);assert(history.nextAfter);assert(!JSON.stringify(history).includes('显式新版本'));
 const payload={operationId:randomUUID(),config:f.config()};await assert.rejects(f.messaging.create(f.admin,payload),{code:'operations_authorization_unavailable'});await assert.rejects(f.messaging.create(f.admin,payload,{authorize:async()=>({...f.admin,operatorId:'another-principal'})}),{code:'business_admin_denied'});
 const made=await f.messaging.create(f.admin,payload,f.auth);assert.equal((await f.messaging.create(f.admin,payload,f.auth)).replayed,true);await assert.rejects(f.messaging.create(f.admin,{...payload,config:{...payload.config,senderKey:'team'}},f.auth),{code:'operations_messaging_operation_changed'});
 await assert.rejects(f.messaging.action(f.admin,made.plan.id,'activate',{operationId:randomUUID(),expectedVersion:1,expectedRevision:99},f.auth),{code:'operations_messaging_version_changed'});
});

test('messaging bounds only confirmed pre-DATA retries, preserves stable Message-ID and refuses unknown or interrupted submissions rather than blindly resending',async t=>{
 const f=await fixture(t),config=f.config({channels:['email'],audience:{kind:'accounts',accountIds:[f.people[0].accountId]}});let calls=0,ids=[];
 f.setSubmit(async input=>{await input.authorize();ids.push(input.messageId);calls++;return calls===1?{submission:'failed',code:'smtp_connection_failed',retryable:true}:{submission:'submitted',code:null,retryable:false};});
 const plan=await f.activate(config),run=await f.execute(plan);let result=await f.messaging.deliver({runId:run.id});assert.equal(result.run.delivery.email.failed,1);assert.equal(result.run.state,'running');assert.equal(calls,1);
 await f.messaging.deliver({runId:run.id});assert.equal(calls,1);f.advance(30);result=await f.messaging.deliver({runId:run.id});assert.equal(result.run.delivery.email.submitted,1);assert.equal(calls,2);assert.equal(ids[0],ids[1]);assert.equal(result.run.delivery.email.delivered,null);
 const attempts=await f.messaging.recipients(f.admin,run.id);assert.equal(attempts.items[0].attemptCount,2);assert.deepEqual(attempts.items[0].attempts.map(item=>item.state),['failed','submitted']);
 f.setSubmit(async input=>{await input.authorize();calls++;return {submission:'unknown',code:'smtp_submission_unknown',retryable:true};});
 const unknown=await f.execute(await f.activate(config));result=await f.messaging.deliver({runId:unknown.id});assert.equal(result.run.delivery.email.unknown,1);assert.equal((await f.messaging.run(f.admin,unknown.id)).capabilities.canRetry,false);
 await assert.rejects(f.messaging.retry(f.admin,unknown.id,{operationId:randomUUID(),expectedRevision:result.run.revision},f.auth),{code:'operations_messaging_retry_not_allowed'});const before=calls;await f.messaging.deliver({runId:unknown.id});assert.equal(calls,before);
 const interrupted=await f.execute(await f.activate(config));const claim=await f.messaging.claim(interrupted.id);assert(claim.attemptId);f.advance(messagingRecoveryPolicy.submissionLeaseSeconds+1);
 result=await f.messaging.deliver({runId:interrupted.id});assert.equal(result.run.delivery.email.unknown,1);assert.equal(calls,before);assert.equal((await f.messaging.recipients(f.admin,interrupted.id)).items[0].attempts[0].state,'unknown');
 f.setProviderState('not-configured');const unavailable=await f.execute(await f.activate(config));result=await f.messaging.deliver({runId:unavailable.id});assert.equal(result.run.delivery.email.blocked,1);assert.equal((await f.messaging.recipients(f.admin,unavailable.id)).items[0].attemptCount,0);
 f.setProviderState('configured');f.setSubmit(async input=>{await input.authorize();calls++;return {submission:'submitted',code:null,retryable:false};});
 const retry=await f.messaging.retry(f.admin,unavailable.id,{operationId:randomUUID(),expectedRevision:result.run.revision},f.auth);assert.equal(retry.retriedRecipients,1);assert.equal((await f.messaging.deliver({runId:unavailable.id})).run.delivery.email.submitted,1);
 // A permanently temporary transport still reaches the explicit bound.
 f.setSubmit(async input=>{await input.authorize();return {submission:'failed',code:'smtp_temporary_rejection',retryable:true};});const bounded=await f.execute(await f.activate(config));
 for(let index=0;index<messagingRecoveryPolicy.maxSubmitAttempts;index++){await f.messaging.deliver({runId:bounded.id});f.advance(901);}
 const boundedItem=(await f.messaging.recipients(f.admin,bounded.id)).items[0];assert.equal(boundedItem.attemptCount,4);assert.equal(boundedItem.retryable,false);assert.equal((await f.messaging.run(f.admin,bounded.id)).capabilities.canRetry,false);
});

test('messaging rechecks current publication authority, pause and recipient eligibility immediately before DATA and preserves truthful outcomes after submission',async t=>{
 const f=await fixture(t),config=f.config({channels:['email'],audience:{kind:'accounts',accountIds:[f.people[0].accountId]}});let bytes=0;
 f.setSubmit(async input=>{f.roles.set(f.admin.operatorId,'reader');await assert.rejects(input.authorize(),{code:'operations_permission_denied'});return {submission:'failed',code:'smtp_authorization_changed',retryable:true};});
 const revoked=await f.execute(await f.activate(config));let result=await f.messaging.deliver({runId:revoked.id});assert.equal(bytes,0);assert.equal(result.run.delivery.email.failed,1);assert.equal(result.run.state,'blocked');f.roles.set(f.admin.operatorId,'administrator');
 let pausePlan=await f.activate(config);const paused=await f.execute(pausePlan);
 f.setSubmit(async input=>{pausePlan=(await f.act(pausePlan,'pause')).plan;await assert.rejects(input.authorize(),{code:'operations_messaging_paused'});return {submission:'failed',code:'smtp_authorization_changed',retryable:true};});
 result=await f.messaging.deliver({runId:paused.id});assert.equal(result.run.state,'paused');assert.equal(bytes,0);
 pausePlan=(await f.act(pausePlan,'resume')).plan;f.advance(30);f.setSubmit(async input=>{await input.authorize();bytes++;return {submission:'submitted',code:null,retryable:false};});assert.equal((await f.messaging.deliver({runId:paused.id})).run.delivery.email.submitted,1);assert.equal(bytes,1);
 const disabled=await f.execute(await f.activate(config));f.identities.get('synthetic-0').enabled=false;await f.messaging.deliver({runId:disabled.id});assert.equal((await f.messaging.recipients(f.admin,disabled.id)).items[0].state,'skipped');assert.equal(bytes,1);f.identities.get('synthetic-0').enabled=true;
 let acceptedPlan=await f.activate(config);const accepted=await f.execute(acceptedPlan);
 f.setSubmit(async input=>{await input.authorize();bytes++;acceptedPlan=(await f.act(acceptedPlan,'stop')).plan;return {submission:'submitted',code:null,retryable:false};});
 result=await f.messaging.deliver({runId:accepted.id});assert.equal(result.run.state,'cancelled');assert.equal(result.run.delivery.email.submitted,1);assert.equal(result.run.delivery.email.delivered,null);assert.equal(bytes,2);
 const stopped=await f.messaging.get(f.admin,acceptedPlan.id);assert.equal(stopped.plan.state,'stopped');assert(!JSON.stringify(stopped).includes('@example.invalid'));
});

test('messaging expiry removes the native recurring schedule without rewriting approval history and empty frozen inbox audiences finish without a queued phantom',async t=>{
 const f=await fixture(t),empty=await f.execute(await f.activate(f.config({channels:['inapp'],audience:{kind:'attributes',subjectTypes:['organization']}})));
 assert.equal(empty.audience.accountCount,0);assert.equal(empty.state,'completed');assert.equal((await f.db.query('SELECT state,audience_count FROM operations_notices_v1 WHERE id=$1',[empty.id])).rows[0].state,'delivered');
 const config=f.config({channels:['announcement','inapp'],content:{...f.config().content,expiresAt:new Date((f.now()+90)*1000).toISOString()},schedule:{kind:'recurring',cron:'* * * * *',timezone:'Asia/Shanghai'}});
 const plan=await f.activate(config),run=await f.execute(plan);assert.equal((await f.messaging.get(f.admin,plan.id)).plan.effectiveState,'active');assert.equal((await f.messaging.announcements()).items.length,1);
 const events=Number((await f.db.query('SELECT count(*) AS count FROM operations_messaging_events_v1 WHERE plan_id=$1',[plan.id])).rows[0].count);f.advance(91);
 const expired=await f.messaging.execute({planId:plan.id,planVersion:1},{jobId:randomUUID()});assert.deepEqual(expired,{state:'not-executed',reason:'expired'});
 assert.equal(f.unscheduled.at(-1)[0],'messaging-run');assert.equal(f.unscheduled.at(-1)[1],'messaging:'+plan.id);assert(f.unscheduled.at(-1)[2].db);
 const visible=(await f.messaging.get(f.admin,plan.id)).plan;assert.equal(visible.state,'active');assert.equal(visible.effectiveState,'expired');assert.equal(visible.capabilities.canPause,false);assert.equal(visible.capabilities.canResume,false);
 assert.equal(Number((await f.db.query('SELECT count(*) AS count FROM operations_messaging_events_v1 WHERE plan_id=$1',[plan.id])).rows[0].count),events,'expiration does not invent a human stop command');
 assert.equal((await f.messaging.announcements()).items.length,0);const result=await f.messaging.deliver({runId:run.id});assert.equal(result.run.state,'expired');assert.equal(result.run.delivery.inapp.skipped,3);assert.equal(result.run.delivery.inapp.delivered,0);
});

test('messaging respects an existing notice withdrawal on a run-owned inbox source without inventing delivery or withdrawing the other channels',async t=>{
 const f=await fixture(t),plan=await f.activate(f.config({audience:{kind:'accounts',accountIds:[f.people[0].accountId]}})),run=await f.execute(plan);
 const old=new OperationsNotices({db:f.db,endpoint:f.endpoint,businessAdmin:f.businessAdmin,accounts:f.accounts,jobs:f.jobs,now:f.now});
 const withdrawn=await old.withdraw(f.admin,run.id,{operationId:randomUUID(),expectedVersion:1});assert.equal(withdrawn.notice.state,'withdrawn');
 const result=await f.messaging.deliver({runId:run.id});assert.equal(result.run.delivery.inapp.skipped,1);assert.equal(result.run.delivery.inapp.delivered,0);assert.equal(result.run.delivery.email.submitted,1);assert.equal(result.run.announcement.state,'published');
 const recipient=(await f.messaging.recipients(f.admin,run.id,{channel:'inapp'})).items[0];assert.equal(recipient.errorCode,'operations_messaging_inapp_source_unavailable');
 const source=(await f.db.query('SELECT n.state,r.delivered_at FROM operations_notices_v1 n JOIN account_operations_notices_v1 r ON r.notice_id=n.id WHERE n.id=$1',[run.id])).rows[0];assert.equal(source.state,'withdrawn');assert.equal(source.delivered_at,null);
 assert.equal((await old.accountQuery(f.people[0])).items.length,0);assert.equal((await f.messaging.get(f.admin,plan.id)).plan.state,'active');assert.equal(f.submissions.length,1);
});


test('AI-approved ordinary messaging continues from the exact committed identity and stops on withdrawal without replaying SMTP',async t=>{
 const f=await fixture(t),at=new Date(f.now()*1000),aiId=randomUUID(),taskId=randomUUID(),configId=randomUUID();
 const accounts=new OperationsAiWorkAccountsService({db:f.db,endpoint:f.endpoint,businessAdmin:f.businessAdmin,now:f.now});f.permissions.aiWorkAccounts=accounts;
 await f.db.query("INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,'messaging','银河消息','',true,1,1,$3,$3)",[aiId,f.endpoint,at]);
 const role=(await f.permissions.saveRole(f.admin,{operationId:randomUUID(),expectedVersion:0,name:'获准普通消息',description:'本地验证普通消息权限',enabled:true,permissions:['notices.read','notices.publish','notices.withdraw']},f.auth)).role;
 await accounts.assignment(f.admin,'messaging',{operationId:randomUUID(),roleId:role.id,expectedVersion:0,enabled:true},f.auth);
 let live=true;
 const authority=new OperationsAgentOsAuthority({db:f.db,endpoint:f.endpoint,permissions:f.permissions,aiWorkAccounts:accounts,now:f.now,dutyAuthorizationWithin:async()=>({allowed:live})});
 f.businessAdmin.executorAuthority=authority;
 f.messaging.autonomy={validatePersistedOperationWithin:async(_db,_context,options)=>({allowed:live&&options?.sourceMatched===true})};
 authority.durableOperationAuthorizationWithin=(db,context)=>f.messaging.validatePersistedApprovalWithin(db,context);
 const context={domain:'messaging',aiAccountId:aiId,taskId,planId:configId,planVersion:1,purpose:'operations-messaging',accessPurpose:'execution',resourceIds:[]};
 const actor=await transaction(f.db,db=>authority.dutyActorWithin(db,context));
 const plan=await f.create(f.config({channels:['inapp','email'],automation:{kind:'ordinary',factsConfirmed:true}})),operationId=randomUUID();
 const grant=(await f.permissions.saveAutomation(f.admin,{operationId:randomUUID(),expectedVersion:0,name:'仅此普通消息',enabled:true,executorKind:'ai',mode:'automatic',aiAccountId:aiId,permissions:['notices.read','notices.publish','notices.withdraw'],resourceIds:[plan.id],resourceScope:{kind:'selected',resourceIds:[plan.id]}},f.auth)).automation;
 const bound=await transaction(f.db,db=>authority.bindDutyOperation(actor,{permission:'notices.publish',operationId,targetId:plan.id},{db,authorizeOperation:async()=>({allowed:true,grantId:grant.id,grantVersion:grant.version,strategyId:randomUUID(),strategyVersionId:randomUUID()})}));
 const input={operationId,expectedVersion:plan.version,expectedRevision:plan.revision};
 const published=await f.messaging.action(bound,plan.id,'activate',input,{authorize:async()=>bound});
 assert.equal(published.plan.approval.kind,'operations-ai-service');assert.equal(published.plan.approval.role,null);
 assert.equal((await f.messaging.action(bound,plan.id,'activate',input,{authorize:async()=>bound})).replayed,true);
 await assert.rejects(f.messaging.action({...bound},plan.id,'activate',input,{authorize:async()=>({...bound})}),{code:'business_admin_denied'});
 const persisted=(await f.db.query('SELECT * FROM operations_messaging_plans_v1 WHERE id=$1',[plan.id])).rows[0];
 assert.equal(persisted.approved_ai.aiAccountId,aiId);assert.equal(persisted.approved_ai.endpoint,f.endpoint);
 assert.equal((await f.messaging.history(f.admin,plan.id)).items[0].operatorDisplayName,'银河消息');
 const run=await f.execute(published.plan);assert.equal(run.approval.aiAccountId,aiId);assert.equal(run.approval.taskId,taskId);
 const done=await f.messaging.deliver({runId:run.id});assert.equal(done.run.delivery.email.submitted,f.people.length);
 const count=f.submissions.length;await f.messaging.deliver({runId:run.id});assert.equal(f.submissions.length,count);
 live=false;
 await assert.rejects(transaction(f.db,db=>f.messaging.approvalActorWithin(db,persisted)),{code:'operations_ai_duty_operation_denied'});
 live=true;
 const altered=structuredClone(persisted.approved_ai);altered.operation.operationId=randomUUID();delete altered.messagePlanId;delete altered.messageVersion;
 await assert.rejects(transaction(f.db,db=>authority.continuationActorWithin(db,altered)),{code:'operations_ai_duty_operation_denied'});
 const important=await f.create(),importantOp=randomUUID(),importantActor=await transaction(f.db,db=>authority.bindDutyOperation(actor,{permission:'notices.publish',operationId:importantOp,targetId:important.id},{db,authorizeOperation:async()=>({allowed:true})}));
 await assert.rejects(f.messaging.action(importantActor,important.id,'activate',{operationId:importantOp,expectedVersion:1,expectedRevision:1},{authorize:async()=>importantActor}),{code:'operations_agentos_human_review_required'});
});
