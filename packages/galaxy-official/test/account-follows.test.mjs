import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {accountFollowBrowser} from './account-follows-fixture.mjs';
import {AccountFollowsV1} from "../src/accounts/follows-v1.mjs";
import {migrations} from '../src/infrastructure/migrations.mjs';
import {digest} from '../src/shared/digest.mjs';
import {failureRoute} from '../src/adapters/http/failure-audit.mjs';
import {requestQuotaCategory} from '../src/adapters/http/request-quotas.mjs';

test('ordinary-account follows: real cookie/CSRF, API role, private paging and original receipts without Native/contact grants',async()=>{
 assert.equal(migrations.some(row=>row.version===125),true);assert.equal(migrations.some(row=>row.version===120),false);
 const f=await communityForumFixture({officialAccountPortal:true});
 try{
  const a=await accountFollowBrowser(f,'follow-owner'),b=await accountFollowBrowser(f,'follow-author'),c=await accountFollowBrowser(f,'follow-other-owner'),d=await accountFollowBrowser(f,'follow-other-author');
  const target=b.session.account.id,otherTarget=d.session.account.id,ownerId=a.session.account.id;
  await f.db.query(`UPDATE official_account_profiles_v1 SET query_enabled=true,display_name=CASE WHEN account_id=$1 THEN '山间记录' ELSE '河岸小集' END WHERE account_id=ANY($2::uuid[])`,[target,[target,otherTarget]]);
  const role=await readFile(new URL('../src/infrastructure/api-role.sql',import.meta.url),'utf8');await f.db.exec(role);
  await f.db.exec(await readFile(new URL('../src/infrastructure/worker-role.sql',import.meta.url),'utf8'));
  assert.equal((await f.db.query("SELECT has_table_privilege('galaxy_api','account_follows_v1','DELETE') value")).rows[0].value,false);
  assert.equal((await f.db.query("SELECT has_column_privilege('galaxy_api','account_follows_v1','target_account_id','UPDATE') value")).rows[0].value,false);
  assert.equal((await f.db.query("SELECT has_table_privilege('galaxy_api','account_follow_operations_v1','UPDATE') value")).rows[0].value,false);
  assert.equal((await f.db.query("SELECT has_table_privilege('galaxy_evidence_worker','account_follows_v1','SELECT') value")).rows[0].value,false);
  await f.db.query('SET ROLE galaxy_api');
  assert.equal((await a.ok('status',{targetAccountId:target})).relationship.following,false);
  const command={operationId:randomUUID(),targetAccountId:target,following:true,expectedRevision:0},hash=digest(JSON.stringify(command));
  assert.equal((await a.request('command',command,{'X-Galaxy-Account-CSRF':'invalid'})).status,403);
  assert.equal((await a.request('command',command,{'X-Galaxy-Account-ID':c.session.account.id})).body.error,'official_account_changed');
  assert.equal((await a.request('command',command,{Authorization:'Bearer not-valid'})).status,401);
  const ack=await a.ok('command',command);assert.equal(ack.relationship.following,true);assert.equal(ack.relationship.revision,1);assert.equal(ack.payloadHash,hash);
  const original=await a.ok('receipt',{operationId:command.operationId,payloadHash:hash});assert.deepEqual(original,ack);
  assert.deepEqual(await a.ok('command',command),ack,'same original command is a receipt, not another update');
  assert.equal((await a.request('command',{...command,following:false})).body.error,'account_follow_operation_conflict');
  assert.equal((await c.ok('receipt',{operationId:command.operationId,payloadHash:hash})).state,'absent');
  assert.deepEqual((await c.ok('query',{})).items,[]);
  assert.equal((await a.request('command',{operationId:randomUUID(),targetAccountId:ownerId,following:true,expectedRevision:0})).body.error,'account_follow_self');
  const second=await a.ok('command',{operationId:randomUUID(),targetAccountId:otherTarget,following:true,expectedRevision:0});
  assert.equal(second.relationship.following,true);
  const firstPage=await a.ok('query',{limit:1});assert.equal(firstPage.items.length,1);assert.ok(firstPage.nextAfter);assert.equal(firstPage.items[0].source.state,'available');
  assert.equal((await c.request('query',{after:firstPage.nextAfter})).body.error,'account_follow_cursor_unavailable');
  const next=await a.ok('query',{limit:1,after:firstPage.nextAfter});assert.equal(next.items.length,1);assert.notEqual(next.items[0].relationship.targetAccountId,firstPage.items[0].relationship.targetAccountId);
  await f.db.query('RESET ROLE');await f.db.query('UPDATE official_account_profiles_v1 SET query_enabled=false WHERE account_id=$1',[target]);await f.db.query('SET ROLE galaxy_api');
  const hidden=(await a.ok('query',{})).items.find(item=>item.relationship.targetAccountId===target);assert.equal(hidden.source.state,'unavailable');assert.equal(hidden.source.profile,null);
  assert.ok(!JSON.stringify(hidden).includes('山间记录'));assert.ok(!JSON.stringify(hidden).includes(b.session.account.email));
  const off=await a.ok('command',{operationId:randomUUID(),targetAccountId:target,following:false,expectedRevision:1});assert.equal(off.relationship.following,false);assert.equal(off.relationship.revision,2);
  assert.equal((await a.ok('command',command)).relationship.following,true,'old receipt does not claim current state');
  assert.equal((await a.ok('status',{targetAccountId:target})).relationship.following,false,'old receipt did not revive canceled relationship');
  assert.equal((await a.request('command',{operationId:randomUUID(),targetAccountId:target,following:true,expectedRevision:2})).body.error,'account_follow_target_unavailable');
  assert.equal((await a.request('command',{operationId:randomUUID(),targetAccountId:otherTarget,following:false,expectedRevision:0})).body.error,'account_follow_changed');
  const stored=(await f.db.query('SELECT result FROM account_follow_operations_v1 WHERE account_id=$1',[ownerId])).rows;
  assert.ok(stored.length>=3);assert.ok(!JSON.stringify(stored).includes('山间记录'));assert.ok(!JSON.stringify(stored).includes('河岸小集'));assert.ok(!JSON.stringify(stored).includes(b.session.account.email));
  const service=new AccountFollowsV1({accounts:f.owner.communityAccounts,endpoint:f.owner.access.endpoint,now:()=>f.clock.now});
  assert.throws(()=>service.status({kind:'linked-id',endpoint:f.owner.access.endpoint,accountId:ownerId},{targetAccountId:target}),error=>error.code==='official_account_login_required');
  assert.throws(()=>service.status({kind:'official-account',endpoint:'https://elsewhere.invalid',accountId:ownerId},{targetAccountId:target}),error=>error.code==='official_account_login_required');
  for(const method of ['status','query','receipt','command']){
   const path='/v1/account/follows/'+method;
   assert.equal(failureRoute('POST',path),'POST '+path);
   assert.equal(requestQuotaCategory('POST',path,true),method==='command'?'submission':'query');
   const preflight=await fetch(f.origin+path,{method:'OPTIONS',headers:{Origin:f.website,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Content-Type, X-Galaxy-Account-ID, X-Galaxy-Account-CSRF'}});
   assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-credentials'),'true');
  }
  const extra=await fetch(f.origin+'/v1/account/follows/not-real',{method:'OPTIONS',headers:{Origin:f.website,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'X-Galaxy-Account-CSRF'}});
  assert.equal(extra.status,403,'no follows prefix wildcard');
 }finally{await f.db.query('RESET ROLE');await f.close();}
});
