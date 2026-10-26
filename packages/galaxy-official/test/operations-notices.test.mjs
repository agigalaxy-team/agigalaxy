import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {OperationsNotices,createOperationsNoticeWorker} from "../src/operations/messaging/notices.mjs";
import {operationsProductFixture} from './operations-product-fixture.mjs';

const content=f=>({purpose:'maintenance',title:'服务维护安排',body:'这是合成的普通账户服务通知。',href:'/status/',audience:{kind:'all-accounts'},expiresAt:new Date((f.now()+3600)*1000).toISOString()});

test('operator notices freeze recipients, deliver in bounded pages and appear in real account inboxes without creating an ID',{timeout:60000},async t=>{
  const f=await operationsProductFixture(t,{accountCount:205}),notices=new OperationsNotices(f),worker=createOperationsNoticeWorker({notices});
  const created=await notices.create(f.actor,{operationId:randomUUID(),content:content(f)}),id=created.notice.id;
  const publish={operationId:randomUUID(),expectedVersion:1};await notices.publish(f.actor,id,publish);
  assert.equal((await notices.publish(f.actor,id,publish)).replayed,true);
  const late=await f.addAccount();assert.equal((await notices.accountQuery(f.people[0])).items.length,0,'a target row is not yet a delivered notice');
  assert.deepEqual(await worker.execute({noticeId:id}),{state:'delivering',deliveredCount:100});
  assert.equal((await notices.get(f.reader,id)).notice.delivery.pendingCount,105);
  await worker.execute({noticeId:id});await worker.execute({noticeId:id});
  const complete=(await notices.get(f.reader,id)).notice;
  assert.equal(complete.state,'delivered');assert.equal(complete.delivery.deliveredCount,205);assert.equal(complete.delivery.audienceCount,205);
  assert.equal((await notices.accountQuery(late)).items.length,0,'an account registered after publication is outside the frozen audience');
  const inbox=await notices.accountQuery(f.people[0]);assert.equal(inbox.items[0].noticeId,id);assert.equal(inbox.items[0].source.kind,'business-operator');
  assert.equal(JSON.stringify(inbox).includes(f.actor.operatorId),false,'ordinary recipients do not receive a private management principal');
  await notices.accountMarkRead(f.people[0],{noticeId:id});assert.equal((await notices.accountQuery(f.people[0],{unreadOnly:true})).items.length,0);
  assert.equal((await notices.get(f.reader,id)).notice.delivery.readCount,1);
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM subjects')).rows[0].n,0);
  await notices.withdraw(f.actor,id,{operationId:randomUUID(),expectedVersion:2});
  assert.equal((await notices.accountQuery(f.people[0])).items.length,0);
  assert.equal((await worker.execute({noticeId:id})).state,'withdrawn');
  const audit=await f.businessAdmin.audit(f.reader);assert.equal(audit.items.some(item=>item.action==='notice-delivery'&&item.selection.execution==='worker'),true);
  assert.equal(JSON.stringify(audit).includes('普通账户服务通知'),false,'audits contain metadata, not notice bodies');
});

test('revoked management authority or a cancelled domain cannot deliver; retry uses the same immutable audience',{timeout:60000},async t=>{
  const f=await operationsProductFixture(t),notices=new OperationsNotices(f),worker=createOperationsNoticeWorker({notices});
  const scoped=content(f);scoped.audience={kind:'accounts',accountIds:[f.people[0].accountId]};
  const {notice}=await notices.create(f.actor,{operationId:randomUUID(),content:scoped});
  await notices.publish(f.actor,notice.id,{operationId:randomUUID(),expectedVersion:1});
  f.setRole('reader');await assert.rejects(worker.execute({noticeId:notice.id}),{code:'operations_permission_denied'});
  assert.equal((await notices.get(f.reader,notice.id)).notice.delivery.deliveredCount,0);
  f.setRole(null);await assert.rejects(worker.execute({noticeId:notice.id}),{code:'business_admin_denied'});
  f.setRole('administrator');f.directoryAvailable(false);
  await assert.rejects(worker.execute({noticeId:notice.id}),{code:'identity_directory_unavailable'});
  f.directoryAvailable(true);await worker.execute({noticeId:notice.id});
  assert.equal((await notices.accountQuery(f.people[0])).items.length,1);assert.equal((await notices.accountQuery(f.people[1])).items.length,0);
  await assert.rejects(notices.accountMarkRead(f.people[1],{noticeId:notice.id}),{code:'operations_notice_not_found'});
  assert.ok(f.authorizationChecks()>=4,'each delivery step checks the current management directory');
  const second=(await notices.create(f.actor,{operationId:randomUUID(),content:content(f)})).notice;
  const published=(await notices.publish(f.actor,second.id,{operationId:randomUUID(),expectedVersion:1})).notice;
  await f.jobs.cancel('account-notice',published.jobId,{endpoint:f.endpoint});
  assert.equal((await worker.execute({noticeId:second.id})).state,'withdrawn');
  f.advance(3601);assert.equal((await notices.accountQuery(f.people[0])).items.length,0);
  const failed=(await f.businessAdmin.audit(f.reader)).items.filter(item=>item.action==='notice-delivery'&&item.result.state==='failed');
  assert.ok(failed.some(item=>item.selection.noticeId===notice.id&&item.result.deliveredCount===0));
  // The public audit projection intentionally omits the worker's internal
  // reason. Check original immutable attribution and authority failures in PG.
  const recorded=(await f.db.query(`SELECT operator_id,operator_role,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND action='notice-delivery' AND selection->>'noticeId'=$2 AND result->>'state'='failed'`,[f.endpoint,notice.id])).rows;
  for(const code of ['operations_permission_denied','business_admin_denied'])assert.ok(recorded.some(item=>item.operator_id===f.actor.operatorId&&item.operator_role==='administrator'&&item.selection.reason==='authority_changed'&&item.result.code===code&&item.result.deliveredCount===0));
});
