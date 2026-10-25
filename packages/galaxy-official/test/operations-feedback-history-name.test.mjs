import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {migrate} from '../src/database.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsFeedbackService} from '../src/operations-feedback.mjs';
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';

test('feedback history resolves current same-endpoint management labels without relabelling executors or changing stored events',{timeout:60000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const known='a'.repeat(64),readerId='b'.repeat(64),blank='c'.repeat(64),foreign='d'.repeat(64),missing='e'.repeat(64),executor='executor:'+randomUUID(),
  at=new Date(f.now()*1000).toISOString(),other='https://foreign-feedback.example.invalid',
  admin={kind:'business-operator',operatorId:known,role:'administrator',endpoint:f.endpoint},reader={...admin,operatorId:readerId,role:'reader'},
  businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now}),feedback=new OperationsFeedbackService({businessAdmin,accounts:f.accounts,now:f.now});
 for(const [id,endpoint,name] of [[known,f.endpoint,' 当前反馈处理人员 '],[readerId,f.endpoint,'只读运营人员'],[blank,f.endpoint,' '],[foreign,other,'外端点姓名不能借用'],[executor,f.endpoint,'不能将这个执行器猜成人工']])
  await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
   VALUES($1,$2,'https://operations.example.invalid',$1,$3,$4,$4)`,[id,endpoint,name,at]);
 // The upstream management directory is the existing explicit local fixture;
 // actual PG roles, read grants and the feedback service remain in use.
 await attachOperationsFixtureAuthority({businessAdmin,admin,reader,permissions:['feedback.read']});
 const saved=await feedback.submit(f.people[0],{operationId:randomUUID(),body:'反馈本文仍只在原受权详情内读取',category:'problem',module:'account'}),
  updated=await feedback.event(admin,saved.feedbackId,{operationId:randomUUID(),expectedRevision:1,state:'processing',note:'原处理说明继续保留'});
 assert.equal(updated.history.items[0].operatorId,known);assert.equal(updated.history.items[0].operatorDisplayName,'当前反馈处理人员');
 let revision=2;
 for(const operatorId of [blank,foreign,missing,executor,...Array(46).fill(known)]){
  // Historical actors need not still be in today's personnel directory.
  // Insert only this read-model fixture; it is not executor-authority evidence.
  await f.db.query(`INSERT INTO operations_feedback_events_v1(id,feedback_id,endpoint,kind,operator_id,operation_id,revision,category,module,state,note,created_at)
   VALUES($1,$2,$3,'updated',$4,$5,$6,'problem','account','processing','原历史说明',$7)`,[randomUUID(),saved.feedbackId,f.endpoint,operatorId,randomUUID(),++revision,at]);
 }
 await f.db.query('UPDATE operations_feedback_v1 SET revision=$2 WHERE id=$1',[saved.feedbackId,revision]);
 const original=(await f.db.query('SELECT id,operator_id,note,revision,created_at FROM operations_feedback_events_v1 WHERE feedback_id=$1 ORDER BY sequence',[saved.feedbackId])).rows;
 await migrate(f.db,{roles:['api']});await f.db.exec('SET ROLE galaxy_api');
 const page=await feedback.get(reader,saved.feedbackId);assert.equal(page.history.items.length,50);assert.ok(page.history.nextAfter);assert.equal(page.permissions.canManage,false);
 for(const operatorId of [blank,foreign,missing,executor]){
  const event=page.history.items.find(item=>item.operatorId===operatorId);assert.ok(event);assert.equal(event.operatorDisplayName,null);assert.equal(event.operatorId,operatorId);
 }
 assert(page.history.items.filter(item=>item.operatorId===known).every(item=>item.operatorDisplayName==='当前反馈处理人员'));
 assert(page.history.items.every(item=>Object.hasOwn(item,'operatorDisplayName')&&!Object.hasOwn(item,'operatorName')));
 const earlier=await feedback.get(reader,saved.feedbackId,{historyAfter:page.history.nextAfter});assert.equal(earlier.history.items.length,2);assert.equal(earlier.history.nextAfter,null);
 assert.equal(earlier.history.items[0].operatorId,known);assert.equal(earlier.history.items[0].operatorDisplayName,'当前反馈处理人员');
 const submitted=earlier.history.items[1];assert.equal(submitted.kind,'submitted');assert.equal(submitted.operatorId,null);assert.equal(submitted.operatorDisplayName,null);
 await assert.rejects(feedback.get({...reader,endpoint:other},saved.feedbackId),{code:'business_admin_denied'});
 await assert.rejects(feedback.get(f.people[0],saved.feedbackId),{code:'business_admin_denied'});
 await f.db.exec('RESET ROLE');await f.db.query('UPDATE operations_operator_principals_v1 SET display_name=$2 WHERE operator_id=$1 AND endpoint=$3',[known,'更新后的管理名称',f.endpoint]);await f.db.exec('SET ROLE galaxy_api');
 const fresh=await feedback.get(reader,saved.feedbackId,{historyAfter:page.history.nextAfter});assert.equal(fresh.history.items[0].operatorDisplayName,'更新后的管理名称','labels are read from the current same-endpoint directory, never copied into old events');
 assert.equal(fresh.history.items[0].operatorId,known);
 assert.deepEqual((await f.db.query('SELECT id,operator_id,note,revision,created_at FROM operations_feedback_events_v1 WHERE feedback_id=$1 ORDER BY sequence',[saved.feedbackId])).rows,original);
 await f.db.exec('RESET ROLE');
});
