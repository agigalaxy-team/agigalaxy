import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {OperationsProductRules,createOperationsPolicyRuntime} from '../src/operations-product-rules.mjs';
import {defaultResourceBudgetPolicy} from '../src/infrastructure/resource-budgets.mjs';
import {defaultCommunityPolicy,PublicWriteService} from '../src/public-writes.mjs';
import {defaultForumPolicy} from '../src/community-forum-policy-v1.mjs';
import {operationsProductFixture} from './operations-product-fixture.mjs';
import {apiOperationsPolicyConsumers} from '../src/operations-policy-consumers.mjs';

test('rule revisions persist across processes, reject stale writers and become applied only in the real consumer',{timeout:60000},async t=>{
  const f=await operationsProductFixture(t),rules=new OperationsProductRules(f);
  await rules.bootstrap({'resource-budget':defaultResourceBudgetPolicy,'community-quota':defaultCommunityPolicy,'forum-quota':defaultForumPolicy});
  const publicWrites=new PublicWriteService({db:f.db,endpoint:f.endpoint,now:f.now},f.accounts),runtime=createOperationsPolicyRuntime({rules,component:'api',consumers:{
    'community-quota':apiOperationsPolicyConsumers({publicWrites})['community-quota'],
  }});
  await runtime.refresh();assert.equal((await publicWrites.status(f.people[0])).quotas[0].limit,2);
  const policy=structuredClone(defaultCommunityPolicy);policy.new.task=9;
  const command={operationId:randomUUID(),expectedVersion:1,policy};
  const saved=await rules.save(f.actor,'community-quota',command);
  assert.equal(saved.rule.version,2);assert.equal(saved.applicationState,'awaiting-process-adoption');
  assert.equal((await rules.get(f.reader,'community-quota')).processes[0].current,false);
  assert.equal((await publicWrites.status(f.people[0])).quotas[0].limit,2,'a saved revision does not pretend that the running consumer adopted it');
  const another=new OperationsProductRules(f);
  await another.bootstrap({'community-quota':defaultCommunityPolicy});
  assert.equal((await another.get(f.reader,'community-quota')).rule.version,2,'restart files never overwrite an operator revision');
  assert.equal((await another.save(f.actor,'community-quota',command)).replayed,true);
  await assert.rejects(rules.save(f.actor,'community-quota',{...command,operationId:randomUUID()}),{code:'operations_policy_version_changed'});
  await assert.rejects(rules.save(f.reader,'community-quota',{...command,operationId:randomUUID()}),{code:'business_admin_denied'});
  await assert.rejects(rules.save(f.actor,'community-quota',{operationId:randomUUID(),expectedVersion:2,policy:{...policy,serverPassword:'forbidden'}}),{code:'invalid_operations_product_request'});
  await runtime.refresh();assert.equal((await publicWrites.status(f.people[0])).quotas[0].limit,9);
  assert.equal((await rules.get(f.reader,'community-quota')).processes[0].current,true);
  const worker=createOperationsPolicyRuntime({rules:another,component:'worker',consumers:{'community-quota':async()=>{throw Error('synthetic consumer cannot adopt');}}});
  await worker.refresh();const process=(await rules.get(f.reader,'community-quota')).processes.find(item=>item.component==='worker');
  assert.equal(process.adoptedVersion,null);assert.equal(process.current,false);assert.equal(process.errorCode,'operations_policy_apply_failed');
  const history=await rules.history(f.reader,'community-quota',{limit:1});assert.equal(history.items[0].version,2);
  assert.equal((await rules.history(f.reader,'community-quota',{after:history.nextAfter,limit:1})).items[0].version,1);
  const audit=await f.businessAdmin.audit(f.reader);assert.equal(audit.items.filter(item=>item.action==='rule-save').length,1);
  assert.equal(JSON.stringify(audit).includes('serverPassword'),false);
});

test('a failed audit cannot leave a saved rule or a replay receipt behind',{timeout:60000},async t=>{
  const f=await operationsProductFixture(t),rules=new OperationsProductRules(f);await rules.bootstrap({'resource-budget':defaultResourceBudgetPolicy});
  const record=f.businessAdmin.recordWithin;f.businessAdmin.recordWithin=async()=>{throw Error('synthetic audit storage unavailable');};
  const operationId=randomUUID();
  await assert.rejects(rules.save(f.actor,'resource-budget',{operationId,expectedVersion:1,policy:{...defaultResourceBudgetPolicy,maxQueuedJobsPerSubject:40}}),/audit storage/);
  f.businessAdmin.recordWithin=record;
  assert.equal((await rules.get(f.reader,'resource-budget')).rule.version,1);
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM operations_product_commands_v1 WHERE operation_id=$1',[operationId])).rows[0].n,0);
});
