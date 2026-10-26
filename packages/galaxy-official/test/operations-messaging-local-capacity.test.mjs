import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {OperationsPermissionsService} from "../src/operations/permissions/index.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {OperationsMessagingService} from '../src/operations/messaging/service.mjs';
import {OperationsSmtpService} from "../src/operations/messaging/smtp.mjs";
import {createSmtpCredentialResolver} from '../src/infrastructure/operations-smtp-credentials.mjs';
import {queueFixture} from './operations-jobs-fixture.mjs';

test('local rate and concurrency deferrals persist retryAt without spending SMTP attempts or extending the approved expiry',{timeout:30000},async t=>{
 const f=await accountChatFixture(),queue=queueFixture(f.db);t.after(async()=>{await queue.jobs.stop();await f.close();});await queue.jobs.start();
 const actor={kind:'business-operator',operatorId:'capacity-admin',role:'administrator',endpoint:f.endpoint};
 await f.db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operators.example.invalid',$1,'本地限流用例',$3,$3)",[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const operatorAuthorization=async()=>'administrator',permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization,now:f.now});
 const directory={get:async({issuer,externalSubject})=>({issuer,externalSubject,email:'synthetic@example.invalid',emailVerified:true,enabled:true})};
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,operatorAuthorization,identityDirectory:directory,now:f.now});
 const credentialResolver=createSmtpCredentialResolver([{ref:'local-test',label:'本地测试',host:'smtp.example.invalid',port:2525,tls:'starttls',purposes:['notice'],user:'synthetic',password:'synthetic'}]);
 let networkCalls=0;const ids=[];
 const smtp=new OperationsSmtpService({db:f.db,endpoint:f.endpoint,businessAdmin,directory,credentialResolver,now:f.now,transport:{submit:async(_config,input)=>{await input.authorize();networkCalls++;ids.push(input.messageId);return {submission:'submitted',code:null,retryable:false};}}});
 const config={enabled:true,host:'smtp.example.invalid',port:2525,tls:'starttls',credentialRef:'local-test',connectionTimeoutMs:1000,greetingTimeoutMs:1000,socketTimeoutMs:1000,maxConnections:1,rateLimit:1,rateWindowSeconds:86400,dkimSelector:null};
 let version=0;const save=async changes=>{const value=await smtp.save(actor,{operationId:randomUUID(),expectedVersion:version,configuration:{...config,...changes}},{authorize:async()=>actor});version=value.version;return smtp.current();};
 const messaging=new OperationsMessagingService({db:f.db,endpoint:f.endpoint,businessAdmin,accounts:f.accounts,jobs:queue.jobs,mailProvider:smtp,now:f.now});
 const make=async seconds=>{
  let plan=(await messaging.create(actor,{operationId:randomUUID(),config:{channels:['email'],content:{purpose:'service-update',title:'本地限流合成通知',body:'仅本地SMTP替身。',href:null,expiresAt:new Date((f.now()+seconds)*1000).toISOString()},audience:{kind:'accounts',accountIds:[f.people[0].accountId]},senderKey:'notice',schedule:{kind:'immediate'}}},{authorize:async()=>actor})).plan;
  plan=(await messaging.action(actor,plan.id,'activate',{operationId:randomUUID(),expectedVersion:plan.version,expectedRevision:plan.revision},{authorize:async()=>actor})).plan;
  return {plan,run:(await messaging.execute({planId:plan.id,planVersion:1},{jobId:randomUUID()})).run};
 };
 const current=await save({}),first=await make(10*86400);let stableId;
 for(let index=0;index<5;index++){
  // Other isolated work occupies this process's configured allowance. No
  // external SMTP is contacted; the provider's actual local limiter runs.
  await smtp.withPermit(current,async()=>({submission:'submitted',code:null,retryable:false}));
  const before=f.now(),done=await messaging.deliver({runId:first.run.id});assert.equal(done.run.state,'running');assert.equal(done.run.delivery.email.pending,1);assert.equal(done.run.delivery.email.failed,0);
  const page=await messaging.recipients(actor,first.run.id),recipient=page.items[0];stableId??=recipient.messageId;
  assert.equal(recipient.state,'pending');assert.equal(recipient.deferred,true);assert.equal(recipient.attemptCount,0);assert.equal(recipient.messageId,stableId);assert.equal(recipient.retryAt,new Date((before+86400)*1000).toISOString());
  assert.equal(recipient.attempts.length,index+1);assert(recipient.attempts.every(value=>value.networkAttempt===false));assert.equal(networkCalls,0);
  assert.equal((await queue.jobs.get('messaging-delivery',done.run.jobId)).availableAt,recipient.retryAt);
  await messaging.deliver({runId:first.run.id});assert.equal((await messaging.recipients(actor,first.run.id)).items[0].attempts.length,index+1,'an early worker call cannot bypass the persisted retryAt');
  f.advance(86400);
 }
 const sent=await messaging.deliver({runId:first.run.id});assert.equal(sent.run.delivery.email.submitted,1);assert.equal(networkCalls,1);assert.equal(ids[0],stableId);
 const recipient=(await messaging.recipients(actor,first.run.id)).items[0];assert.equal(recipient.attemptCount,1);assert.equal(recipient.attempts.length,6);assert.deepEqual(recipient.attempts.map(value=>value.number),[1,2,3,4,5,6]);assert.equal(recipient.attempts.at(-1).networkAttempt,true);
 const concurrent=await save({rateLimit:100}),second=await make(86400);let release;
 const held=smtp.withPermit(concurrent,()=>new Promise(resolve=>{release=resolve;}));
 const blocked=await messaging.deliver({runId:second.run.id}),waiting=(await messaging.recipients(actor,second.run.id)).items[0];assert.equal(waiting.errorCode,'smtp_concurrency_limited');assert.equal(waiting.attemptCount,0);assert.equal(waiting.retryAt,new Date((f.now()+30)*1000).toISOString());assert.equal(blocked.run.state,'running');
 release({submission:'submitted',code:null,retryable:false});await held;f.advance(30);assert.equal((await messaging.deliver({runId:second.run.id})).run.delivery.email.submitted,1);assert.equal(networkCalls,2);
 const limited=await save({});await smtp.withPermit(limited,async()=>({submission:'submitted',code:null,retryable:false}));const expiring=await make(100),deadline=expiring.plan.config.content.expiresAt;
 const deferred=await messaging.deliver({runId:expiring.run.id});assert.equal((await queue.jobs.get('messaging-delivery',deferred.run.jobId)).availableAt,deadline,'only the wake-up is brought forward to the existing expiry');assert.equal((await messaging.get(actor,expiring.plan.id)).plan.config.content.expiresAt,deadline);
 f.advance(100);assert.equal((await messaging.deliver({runId:expiring.run.id})).run.state,'expired');assert.equal((await messaging.recipients(actor,expiring.run.id)).items[0].state,'skipped');assert.equal(networkCalls,2);
});
