import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {p14Fixture} from './p14-rules-fixture.mjs';
import {p14EmptyControls,p14ControlsSchema,p14Parse} from '../src/shared/p14-rules-schema.mjs';
import {p14Evaluate} from '../src/operations/rules/evaluator.mjs';
import {createOperationsPolicyRuntime} from "../src/operations/rules/product-rules.mjs";
import {apiOperationsPolicyConsumers} from "../src/operations/rules/policy-consumers.mjs";

test('P14 drafts, explicit publication, adoption and restoration preserve actual policy and current grants before original-command replay',async t=>{
 const f=await p14Fixture(t),key='community-quota',start=await f.rules.get(f.admin,key),policy=structuredClone(start.active.policy);
 const process=createOperationsPolicyRuntime({rules:f.legacyRules,component:'api',consumers:{'community-quota':apiOperationsPolicyConsumers({publicWrites:f.publicWrites})['community-quota']}});await process.refresh();
 policy.new.task=policy.new.task+1;
 const input={operationId:randomUUID(),expectedRevision:0,policy,reason:'只保存草稿不改当前额度'},saved=await f.rules.saveDraft(f.admin,key,input,{authorize:f.authorize});
 assert.equal(saved.detail.active.publishedVersion,1);assert.equal(saved.detail.draft.publishedVersion,null);assert.equal(f.publicWrites.policy.new.task,start.active.policy.new.task);
 assert.equal((await f.legacyRules.currentWithin(f.db,key)).version,1);
 assert.equal((await f.rules.operation(f.admin,input.operationId)).state,'recorded');
 assert.equal((await f.rules.saveDraft(f.admin,key,input,{authorize:f.authorize})).replayed,true);
 await assert.rejects(f.rules.saveDraft(f.admin,key,{...input,reason:'不能换原操作内容'},{authorize:f.authorize}),{code:'operations_command_changed'});
 await assert.rejects(f.rules.saveDraft(f.admin,key,{...input,operationId:randomUUID()},{authorize:f.authorize}),{code:'operations_rule_revision_changed'});
 const pub=await f.rules.publish(f.admin,key,{operationId:randomUUID(),expectedRevision:1,versionId:saved.versionId,reason:'明确发布草稿'},{authorize:f.authorize});
 assert.equal(pub.detail.active.publishedVersion,2);assert.equal(pub.detail.draft,null);assert.equal(f.publicWrites.policy.new.task,start.active.policy.new.task);
 assert.equal(pub.detail.processes[0].current,false);await process.refresh();assert.equal(f.publicWrites.policy.new.task,policy.new.task);assert.equal((await f.rules.get(f.admin,key)).processes[0].current,true);
 await assert.rejects(f.rules.restore(f.admin,key,{operationId:randomUUID(),expectedRevision:2,versionId:saved.versionId,reason:'未发布草稿不能恢复'},{authorize:f.authorize}),{code:'operations_rule_version_not_published'});
 const restored=await f.rules.restore(f.admin,key,{operationId:randomUUID(),expectedRevision:2,versionId:start.active.id,reason:'恢复原真实额度'},{authorize:f.authorize});
 assert.equal(restored.detail.active.publishedVersion,3);assert.equal(restored.detail.active.restoredFrom,start.active.id);await process.refresh();assert.equal(f.publicWrites.policy.new.task,start.active.policy.new.task);
 const history=await f.rules.versions(f.admin,key,{limit:1});assert.equal(history.items[0].kind,'restore');assert(history.nextAfter);assert.equal((await f.rules.versions(f.admin,key,{after:history.nextAfter,limit:1})).items[0].kind,'publish');
 f.roles.set(f.admin.operatorId,'reader');await assert.rejects(f.rules.saveDraft({...f.admin,role:'administrator'},key,input,{authorize:f.authorize}),{code:'operations_permission_denied'});
 f.roles.set(f.admin.operatorId,'administrator');
 const failed={operationId:randomUUID(),expectedRevision:3,policy,reason:'事务必须共同回滚'},record=f.businessAdmin.recordWithin.bind(f.businessAdmin);f.businessAdmin.recordWithin=async()=>{throw Error('synthetic rule audit failure');};
 await assert.rejects(f.rules.saveDraft(f.admin,key,failed,{authorize:f.authorize}),/synthetic rule audit failure/);f.businessAdmin.recordWithin=record;
 assert.equal((await f.rules.get(f.admin,key)).revision,3);assert.equal((await f.rules.operation(f.admin,failed.operationId)).state,'not-recorded');
 const audit=(await f.db.query("SELECT selection,result FROM business_admin_audit_v1 WHERE action='rule-save'")).rows;
 assert.equal(JSON.stringify(audit).includes('只保存草稿'),false);assert.equal(JSON.stringify(audit).includes('policy'),false);
});

test('P14 samples use strict three-valued Chinese/domain conditions and specific exceptions without writes or quota consumption',async t=>{
 const f=await p14Fixture(t),keyword=randomUUID(),domain=randomUUID(),ruleId=randomUUID(),exceptionId=randomUUID(),policy=structuredClone(p14EmptyControls);
 policy.lists=[{id:keyword,name:'本地字面词',kind:'keyword',enabled:true,entries:['推广','ＡＢＣ']},{id:domain,name:'本地域名',kind:'domain',enabled:true,entries:['例子.测试','example.invalid']}];
 policy.rules=[{id:ruleId,name:'新账户名单条件',enabled:true,targets:['forum-post'],action:'reject',conditions:{combinator:'and',rules:[{field:'accountTier',operator:'eq',value:'new'},{combinator:'or',rules:[{field:'keywordList',operator:'matches',value:keyword},{field:'domainList',operator:'matches',value:domain}]}]},exceptions:[{id:exceptionId,name:'本规则具体账户例外',enabled:true,accountIds:[f.people[0].accountId]}]}];
 const before=await f.db.query('SELECT count(*) AS count FROM community_daily_usage'),versions=(await f.db.query('SELECT count(*) AS count FROM operations_p14_rule_versions_v1')).rows[0].count;
 const sample={target:'forum-post',accountTier:'new',text:'中文推广与ABC',links:[],accountId:f.people[1].accountId};
 const result=await f.rules.sample(f.admin,'business-controls',{policy,sample});assert.equal(result.evaluation.outcome,'reject');assert.equal(result.evaluation.sideEffects,false);assert.equal(JSON.stringify(result).includes('中文推广与ABC'),false);
 assert.equal(p14Evaluate(policy,{...sample,accountId:f.people[0].accountId}).rules[0].state,'excepted');
 assert.equal(p14Evaluate(policy,{...sample,text:'https://sub.example.invalid/path'}).outcome,'reject');
 assert.equal(p14Evaluate(policy,{...sample,text:'https://notexample.invalid/path'}).outcome,'allow');
 assert.equal(p14Evaluate(policy,{target:'forum-post',accountId:f.people[1].accountId}).outcome,'unknown');
 assert.equal(p14Evaluate(policy,{...sample,accountTier:'normal',text:undefined,links:undefined}).outcome,'allow','known false AND missing does not become a hit');
 policy.features.forumPost=false;assert.equal(p14Evaluate(policy,{...sample,accountId:f.people[0].accountId}).outcome,'reject','a rule exception cannot enable a stopped feature');policy.features.forumPost=true;
 for(const mutate of [p=>p.rules[0].conditions.rules=[],p=>p.rules[0].conditions.rules[0].field='secret',p=>p.rules[0].conditions.rules[0].operator='execute',p=>p.rules[0].conditions.rules[1].rules[0].value=randomUUID(),p=>p.rules[0].targets=['chat-upload']]){const invalid=structuredClone(policy);mutate(invalid);assert.throws(()=>p14Parse(p14ControlsSchema,invalid),{code:'invalid_operations_rule_request'});}
 let tree={combinator:'and',rules:[{field:'textLength',operator:'gt',value:1}]};for(let i=0;i<8;i++)tree={combinator:'and',rules:[tree]};const deep=structuredClone(policy);deep.rules[0].conditions=tree;assert.throws(()=>p14Parse(p14ControlsSchema,deep),{code:'invalid_operations_rule_request'});
 const daily=await f.rules.get(f.admin,'forum-quota'),limit=daily.active.policy.new.post;
 assert.equal((await f.rules.sample(f.admin,'forum-quota',{versionId:daily.active.id,sample:{accountTier:'new',quotaCategory:'post',used:limit}})).evaluation.outcome,'reject');
 assert.equal((await f.rules.sample(f.admin,'forum-quota',{versionId:daily.active.id,sample:{accountTier:'new'}})).evaluation.outcome,'unknown');
 const resource=await f.rules.get(f.admin,'resource-budget');assert.equal((await f.rules.sample(f.admin,'resource-budget',{versionId:resource.active.id,sample:{before:{payloadBytes:0,queuedJobs:0,activeExports:0},after:{payloadBytes:resource.active.policy.maxPayloadBytesPerSubject+1,queuedJobs:0,activeExports:0}}})).evaluation.code,'storage_quota_exceeded');
 assert.deepEqual((await f.db.query('SELECT count(*) AS count FROM community_daily_usage')).rows,before.rows);assert.equal((await f.db.query('SELECT count(*) AS count FROM operations_p14_rule_versions_v1')).rows[0].count,versions);assert.equal(Number((await f.db.query('SELECT count(*) AS count FROM operations_p14_rule_decisions_v1')).rows[0].count),0);
});
