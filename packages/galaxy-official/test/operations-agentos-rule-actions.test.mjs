import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {p14Fixture} from './p14-rules-fixture.mjs';
import {OperationsAgentOsAuthority} from '../src/operations-agentos-authority.mjs';
import {OperationsAgentOsActionTools} from '../src/operations-agentos-action-tools.mjs';
import {workbenchActionCatalog,workbenchPrepareSchemas} from '../src/operations-agentos-action-catalog.mjs';
import {workbenchActionCards} from '../../../apps/galaxy-admin/src/lib/workbench-action-cards.ts';

// Real PGlite rule revisions, current business grants, account directory,
// publication and receipt recovery. Native model and deployment are not used.
test('workbench rule cards show actual complete changes and publish or restore only the human-confirmed current version',{timeout:90000},async t=>{
 const f=await p14Fixture(t),authority=new OperationsAgentOsAuthority({...f,permissions:f.permissions}),tools=new OperationsAgentOsActionTools({authority,services:{rules:f.rules,accounts:f.businessAdmin}}),
  kind='business-controls',request={kind:'rule-publish',key:kind,reason:'发布已经审阅的实际草稿'},prepare=(x=request,actor=f.admin,domain='overview')=>tools.prepareFor(actor,domain,x),
  save=async(key,policy)=>{const current=await f.rules.get(f.admin,key);return f.rules.saveDraft(f.admin,key,{operationId:randomUUID(),expectedRevision:current.revision,policy,reason:'服务端保存说明不复制到卡片'},{authorize:f.authorize});};
 assert.deepEqual(workbenchActionCatalog.filter(x=>x.kind.startsWith('rule-')).map(({kind,domain,read})=>({kind,domain,read})),[{kind:'rule-publish',domain:'overview',read:'rules.read'},{kind:'rule-restore',domain:'overview',read:'rules.read'}]);
 const active=await f.rules.get(f.admin,kind),policy=structuredClone(active.active.policy),listId=randomUUID(),ruleId=randomUUID();
 policy.lists=[{id:listId,name:'审核词条',kind:'keyword',enabled:true,entries:['需要审阅']}];policy.rules=[{id:ruleId,name:'新增内容检查',enabled:true,targets:['forum-post'],conditions:{combinator:'and',rules:[{field:'accountTier',operator:'eq',value:'new'},{field:'keywordList',operator:'matches',value:listId}]},action:'reject',exceptions:[{id:randomUUID(),name:'明确例外',enabled:true,accountIds:[f.people[0].accountId]}]}];
 await save(kind,policy);const stale=await prepare();
 assert(stale.impact.some(x=>x.includes('审核词条')&&x.includes('需要审阅')));assert(stale.impact.some(x=>x.includes('新账户')&&x.includes('帖子发布与修订')&&x.includes('甲')));assert(!stale.impact.join('\n').includes(f.people[0].accountId));
 assert(!stale.impact.join('\n').includes('服务端保存说明'));assert.equal(stale.requiredAction,'rules.write');assert.equal(stale.decisionSource,'human-required');
 assert.equal((await f.db.query("SELECT count(*)::int AS n FROM operations_product_rules_v1 WHERE policy_key=$1",[kind])).rows[0].n,1,'prepare has no publication effect');
 await save(kind,policy);await assert.rejects(tools.executePrepared(f.admin,stale,{authorize:f.authorize,operationId:randomUUID()}),{code:'operations_rule_revision_changed'});
 const current=await prepare(),publishId=randomUUID(),published=await tools.executePrepared(f.admin,current,{authorize:f.authorize,operationId:publishId});assert.equal(published.state,'completed');assert.equal(published.receipt.publishedVersion,2);
 const publishedA=(await f.rules.get(f.admin,kind)).active;
 assert.equal((await tools.recoverPrepared(f.admin,current,publishId)).state,'completed');assert.equal((await tools.executePrepared(f.admin,current,{authorize:f.authorize,operationId:publishId})).receipt.replayed,true);
 assert.equal((await tools.recoverPrepared(f.admin,current,randomUUID())).state,'not-recorded');
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM operations_product_rules_v1 WHERE endpoint=$1 AND policy_key=$2',[f.endpoint,kind])).rows[0].n,2,'lost ACK recovery and original replay do not publish again');
 const policyB=structuredClone(policy);policyB.rules[0].enabled=false;await save(kind,policyB);const proposalB=await prepare();await tools.executePrepared(f.admin,proposalB,{authorize:f.authorize,operationId:randomUUID()});
 const realVersions=f.rules.versions.bind(f.rules);let historyReads=0;
 // A narrower transport page cap uses the actual version query and cursor,
 // forcing continuation without manufacturing versions or a target policy.
 f.rules.versions=async(actor,key,options)=>{historyReads++;return realVersions(actor,key,{...options,limit:1});};
 const restoration={kind:'rule-restore',key:kind,versionId:publishedA.id,reason:'恢复实际已发布的历史内容'},restore=await prepare(restoration);assert(historyReads>1);assert(restore.impact.some(x=>x.includes('停用'))&&restore.impact.some(x=>x.includes('启用')));
 const restoreId=randomUUID(),restored=await tools.executePrepared(f.admin,restore,{authorize:f.authorize,operationId:restoreId});assert.equal(restored.state,'completed');assert.equal(restored.receipt.publishedVersion,4);assert.deepEqual((await f.rules.get(f.admin,kind)).active.policy,policy);
 assert.equal((await tools.recoverPrepared(f.admin,restore,restoreId)).state,'completed');assert.equal((await tools.recoverPrepared(f.admin,restore,restoreId)).receipt.publishedVersion,4);
 await assert.rejects(tools.recoverPrepared(f.admin,{...restore,request:{...restoration,key:'forum-quota'}},restoreId),{code:'operations_agentos_operation_conflict'});
 const baseQuota=(await f.rules.get(f.admin,'forum-quota')).active.policy,quota=structuredClone(baseQuota);for(const tier of ['new','normal'])for(const key of Object.keys(quota[tier]))quota[tier][key]++;
 for(const key of ['maxTitleCodePoints','maxBodyCodePoints','maxReplyCodePoints','maxReportCodePoints','maxLinks'])quota[key]--;
 await save('forum-quota',quota);const long=await prepare({kind:'rule-publish',key:'forum-quota',reason:'审阅完整额度变更'});assert(long.impact.length>12);assert(long.impact.some(x=>x.includes('新账户每日发帖额度')));assert(long.impact.some(x=>x.includes('标题上限')));
 const card=(proposal,kind=proposal.kind,impact=proposal.impact)=>({cardId:randomUUID(),operationId:randomUUID(),kind,domain:'overview',target:proposal.target,title:proposal.title,impact,basis:proposal.basis,requiredAction:proposal.requiredAction,capability:{canConfirm:true},state:'prepared',checkedAt:f.now(),readExpiresAt:f.now()+30});
 for(const proposal of [current,restore,long]){const parsed=workbenchActionCards([card(proposal)],'overview');assert.equal(parsed.length,1);assert.deepEqual(parsed[0].impact,proposal.impact);}
 assert.equal(workbenchActionCards([card(current,'content-visibility',long.impact)],'overview')[0].impact.length,12,'old thirteen card layouts keep their original bound');
 assert.deepEqual(workbenchActionCards([card(long,'rule-publish',['x'.repeat(5001)])],'overview'),[]);assert.deepEqual(workbenchActionCards([card(long,'rule-publish',Array(5).fill('x'.repeat(4500)))],'overview'),[]);
 const huge=structuredClone(policy);huge.lists[0].entries=Array.from({length:40},(_,n)=>n+'x'.repeat(150));await save(kind,huge);await assert.rejects(prepare(),{code:'operations_agentos_rule_review_required'});
 for(let i=0;i<6;i++)await save(kind,policy);const before=historyReads;await assert.rejects(prepare(restoration),{code:'operations_agentos_rule_review_required'});assert.equal(historyReads-before,5,'history lookup is bounded');f.rules.versions=realVersions;
 await assert.rejects(prepare({...restoration,versionId:(await f.rules.get(f.admin,kind)).draft.id}),{code:'operations_rule_version_not_published'});
 assert.equal(workbenchPrepareSchemas['rule-publish'].safeParse({...request,expectedRevision:999}).success,false);assert.equal(workbenchPrepareSchemas['rule-publish'].safeParse({...request,versionId:publishedA.id}).success,false);
 await assert.rejects(prepare(request,f.admin,'governance'),{code:'operations_agentos_domain_mismatch'});
 const role=(await f.permissions.saveRole(f.admin,{operationId:randomUUID(),expectedVersion:0,name:'规则读取',description:'',enabled:true,permissions:['workbench.read','rules.read']},{authorize:f.authorize})).role;
 await f.permissions.saveAssignment(f.admin,{operationId:randomUUID(),expectedVersion:0,operatorId:f.reader.operatorId,roleId:role.id,enabled:true},{authorize:f.authorize});await assert.rejects(prepare(request,f.reader),{code:'operations_agentos_operation_unavailable'});
 f.roles.delete(f.admin.operatorId);await assert.rejects(tools.recoverPrepared(f.admin,restore,restoreId),{code:'business_admin_denied',status:403});
});
