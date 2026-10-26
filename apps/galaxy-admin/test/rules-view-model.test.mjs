import test from 'node:test';
import assert from 'node:assert/strict';
import {rulesClone,rulesHref,rulesIsControls,rulesLocation,rulesMerge,rulesNewDraft,rulesNewRule,rulesPath,rulesQuery,rulesSampleFacts,rulesSetNumeric,rulesTraceLabel,rulesValidation} from "../src/lib/rules/rules-view-model.ts";
import {p14RulesCatalog} from '../../../packages/galaxy-official/src/operations/rules/catalog.mjs';

const ruleId='84309cc7-b49a-4233-83b6-079edfd6c804',listId='899fd0f4-c1f1-412b-b64a-39a56050d292',otherId='da7d64fa-ac81-4e49-9dc8-032b71106aa0';
const policy=()=>({schema:'business-controls/1',features:{forumPost:true,forumReply:true,chatSend:true,attachmentUpload:true},lists:[{id:listId,name:'推广词',kind:'keyword',enabled:true,entries:['推广']}],rules:[{...rulesNewRule(ruleId),name:'新账户外链限制',targets:['forum-post'],conditions:{combinator:'and',rules:[{field:'accountTier',operator:'eq',value:'new'},{field:'keywordList',operator:'matches',value:listId}]}}]});

test('rules location keeps object, tab and cursor context without forwarding UI parameters to API',()=>{
 const location=rulesLocation({key:'business-controls',tab:'lists',rule:ruleId,list:listId,version:otherId,after:'9223372036854775807',trail:'first,20',scope:'all',operationId:'untrusted'});
 assert.equal(location.after,'9223372036854775807');assert.deepEqual(location.trail,['first','20']);
 assert.equal(rulesPath('detail',location),'/v1/operations/rules/business-controls/detail');
 assert.equal(rulesPath('versions',location),'/v1/operations/rules/business-controls/versions?limit=20&after=9223372036854775807');
 const href=new URL(rulesHref(location,{tab:'conditions'}),'https://admin.invalid');assert.equal(href.searchParams.get('rule'),ruleId);assert.equal(href.searchParams.get('version'),otherId);assert.equal(href.searchParams.has('scope'),false);
 const switched=new URL(rulesHref(location,{key:'forum-quota'}),'https://admin.invalid');assert.equal(switched.searchParams.has('after'),false);assert.equal(switched.searchParams.has('version'),false);
 assert.equal(rulesLocation({after:'9223372036854775808',key:['forum-quota'],tab:'unknown'}).after,'');
});

test('controlled query projection removes library identities and never becomes a browser evaluator',()=>{
 const query=rulesQuery({id:'editor-only',combinator:'or',rules:[{id:'r1',field:'accountTier',operator:'neq',value:'normal',valueSource:'value'},{id:'g2',combinator:'and',rules:[{id:'r2',field:'linkCount',operator:'gte',value:2}]}]});
 assert.deepEqual(query,{combinator:'or',rules:[{field:'accountTier',operator:'neq',value:'normal'},{combinator:'and',rules:[{field:'linkCount',operator:'gte',value:2}]}]});
 const config=policy();config.rules[0].conditions=query;assert.deepEqual(rulesValidation('business-controls',config,p14RulesCatalog),[]);
 config.rules[0].conditions.rules=[];assert.match(rulesValidation('business-controls',config,p14RulesCatalog).join(' '),/每组需要/);
});

test('rule authoring checks actual target facts and live list references before submission',()=>{
 const config=policy();assert.deepEqual(rulesValidation('business-controls',config,p14RulesCatalog),[]);assert.equal(config.rules[0].enabled,false);
 config.rules[0].targets=['chat-upload'];assert.match(rulesValidation('business-controls',config,p14RulesCatalog).join(' '),/不适用于/);
 config.rules[0].targets=['forum-post'];config.lists=[];assert.match(rulesValidation('business-controls',config,p14RulesCatalog).join(' '),/名单/);
 config.lists=[{id:listId,name:'推广词',kind:'keyword',enabled:true,entries:['ＡＢＣ','abc']}];assert.match(rulesValidation('business-controls',config,p14RulesCatalog).join(' '),/重复/);
});

test('quota editing preserves current facts and rejects an empty number rather than submitting zero',()=>{
 const numeric={maxPayloadBytesPerSubject:1000,maxQueuedJobsPerSubject:4,maxActiveExportsPerSubject:2,maxActiveJobsGlobal:5,maxActiveJobsPerSubject:2};
 const empty=rulesSetNumeric(numeric,'maxPayloadBytesPerSubject','');assert.match(rulesValidation('resource-budget',empty,p14RulesCatalog).join(' '),/数据存储/);assert.equal(numeric.maxPayloadBytesPerSubject,1000);
 assert.deepEqual(rulesValidation('resource-budget',rulesSetNumeric(numeric,'maxPayloadBytesPerSubject','0'),p14RulesCatalog),[]);
 const sample=rulesSampleFacts({accountTier:'new',quotaCategory:'post',used:'0'},'forum-quota');assert.deepEqual(sample,{accountTier:'new',quotaCategory:'post',used:0});assert.equal('target' in sample,false);
});

test('three way rule merge preserves independent edits and makes deletion or condition conflicts explicit',()=>{
 const base=policy(),mine=rulesClone(base),current=rulesClone(base);mine.rules[0].name='人工调整名称';current.features.chatSend=false;current.lists[0].entries.push('新词');
 let result=rulesMerge(base,mine,current);assert.equal(result.conflicts.length,0);assert.equal(result.policy.features.chatSend,false);assert.deepEqual(result.policy.lists[0].entries,['推广','新词']);assert.equal(result.policy.rules[0].name,'人工调整名称');
 mine.rules=[];current.rules[0].enabled=true;result=rulesMerge(base,mine,current);assert.equal(result.conflicts.length,1);assert.match(result.conflicts[0].label,/新账户外链限制/);
 assert.equal(rulesMerge(base,mine,current,{[result.conflicts[0].path]:'mine'}).policy.rules.length,0);
 const edited=policy();edited.rules[0].conditions.rules.push({field:'linkCount',operator:'gt',value:0});const remote=policy();remote.rules[0].conditions.rules.push({field:'textLength',operator:'gt',value:500});assert.equal(rulesMerge(base,edited,remote).conflicts.length,1);
});

test('sample omission is distinct from a supplied empty fact and quota resource checks use both snapshots',()=>{
 assert.deepEqual(rulesSampleFacts({target:'forum-post',text:'not selected',links:'https://example.org'},'business-controls'),{target:'forum-post'});
 assert.deepEqual(rulesSampleFacts({target:'forum-post',textProvided:'yes',text:'',linksProvided:'yes',links:'',attachmentCount:'0'},'business-controls'),{target:'forum-post',attachmentCount:0,text:'',links:[]});
 const resource=rulesSampleFacts({'before.payloadBytes':'0','before.queuedJobs':'2','before.activeExports':'0','after.payloadBytes':'10','after.queuedJobs':'3','after.activeExports':'0'},'resource-budget');assert.deepEqual(resource,{before:{payloadBytes:0,queuedJobs:2,activeExports:0},after:{payloadBytes:10,queuedJobs:3,activeExports:0}});
 assert.deepEqual(rulesSampleFacts({'before.payloadBytes':'0'},'resource-budget'),{});
});

test('sample explanation uses real catalog labels and current list names without interpreting a missing result',()=>{
 const config=policy();assert.equal(rulesTraceLabel({path:'1.2',kind:'condition',field:'keywordList',operator:'matches',value:listId,state:'hit'},p14RulesCatalog,config),'命中词条名单 命中 推广词');
 const active={id:otherId,key:'business-controls',version:3,policy:config,publishedVersion:2,createdAt:'2026-10-23T00:00:00Z',createdBy:null,source:'configured-baseline',restoredFrom:null};const draft=rulesNewDraft({revision:4,active,draft:null});draft.policy.features.forumReply=false;assert.equal(active.policy.features.forumReply,true);assert.equal(draft.revision,4);assert.equal(rulesIsControls(draft.policy),true);
});
