import test from 'node:test';
import assert from 'node:assert/strict';
import {caseDecisionBody,caseHideDurations,caseSourceLink,casesHref,casesNextHref,casesPreviousHref,casesReadPath,filterCases,normalizeCaseFilters} from '../src/components/cases-types.ts';

const id='11111111-1111-4111-8111-111111111111',next='22222222-2222-4222-8222-222222222222',post='33333333-3333-4333-8333-333333333333';
const report=(change={})=>({id,target:{kind:'post-version',postId:post,versionId:next},version:3,state:'pending',reporterAccountId:null,reporterId:null,targetAuthorAccountId:null,targetAuthorId:null,operationsDisclosed:true,createdAt:'2026-10-22T01:00:00Z',closedAt:null,restrictedUntil:null,canModerate:true,maxHideSeconds:3600,knownPartyConflict:false,checkedAt:1000,source:{locator:{kind:'post-version',postId:post,versionId:next},availability:'available',content:{title:'公开标题',body:'来源正文不得用于本页标识检索',links:[]},publishedUntil:4600},...change});
const draft={resolution:'accepted',summary:'本次有依据的处理说明',restrictionAction:'keep',seconds:'900'};

test('report page keeps local search and selection out of the server-wide query contract',()=>{
 const filters=normalizeCaseFilters({selected:id,state:'appealed',after:next,query:'本页\u0000词',kind:'reply',view:'history'});
 const read=new URL(casesReadPath(filters),'https://example.invalid');
 assert.deepEqual([...read.searchParams.keys()],['limit','state','after']);
 assert.equal(read.searchParams.get('state'),'appealed');
 assert.equal(filters.query,'本页词');
 const invalid=normalizeCaseFilters({selected:'javascript:alert(1)',state:'reviewing',after:'arbitrary',kind:'account',view:'unknown'});
 assert.equal(casesHref(invalid),'/admin/operations/community?tab=reports');
});

test('paging and return preserve the chosen record, local filters and detail view',()=>{
 const filters=normalizeCaseFilters({selected:id,state:'pending',after:post,query:'帖子',kind:'post-version',view:'source'});
 const target=new URL(casesNextHref(filters,next),'https://example.invalid');
 const page=normalizeCaseFilters({selected:target.searchParams.get('id'),state:target.searchParams.get('state'),after:target.searchParams.get('after'),trail:target.searchParams.get('trail'),query:target.searchParams.get('q'),kind:target.searchParams.get('kind'),view:target.searchParams.get('view')});
 const previous=new URL(casesPreviousHref(page),'https://example.invalid');
 assert.equal(previous.searchParams.get('after'),post);
 assert.equal(previous.searchParams.get('id'),id);
 assert.equal(previous.searchParams.get('q'),'帖子');
 assert.equal(previous.searchParams.get('view'),'source');
 assert.equal(normalizeCaseFilters({trail:'0.not-a-cursor'}).trail,'');
});

test('page keyword filtering does not invent a full-site search or search undisplayed narratives',()=>{
 const item=report({events:[{id:next,kind:'appeal',version:2,actorKind:'official-account',summary:'申诉私人说明',createdAt:'2026-10-22T02:00:00Z'}]});
 assert.equal(filterCases([item],normalizeCaseFilters({query:'私人说明'})).length,0);
 assert.equal(filterCases([item],normalizeCaseFilters({query:'来源正文'})).length,0);
 assert.equal(filterCases([item],normalizeCaseFilters({query:post})).length,1);
 assert.equal(filterCases([item],normalizeCaseFilters({kind:'reply'})).length,0);
});

test('the old resolution command cannot silently clear an active prior case restriction',()=>{
 assert.equal(caseDecisionBody(report({state:'appealed',restrictedUntil:new Date(2000*1000).toISOString()}),draft,1000),null);
 assert.equal(caseDecisionBody(report({canModerate:false}),draft,1000),null);
 assert.equal(caseDecisionBody(report({state:'resolved'}),draft,1000),null);
 assert.deepEqual(caseDecisionBody(report(),draft,1000),{expectedVersion:3,resolution:'accepted',summary:draft.summary});
});

test('a temporary hide remains within both source permission and current policy expiry',()=>{
 const item=report({maxHideSeconds:7200,source:{...report().source,publishedUntil:2250}});
 assert.deepEqual(caseHideDurations(item,1000),[900,1200]);
 assert.equal(caseDecisionBody(item,{...draft,restrictionAction:'hide',seconds:'3600'},1000),null);
 assert.equal(caseDecisionBody(item,{...draft,restrictionAction:'hide',seconds:'1200'},1000).hideUntil,2200);
 assert.equal(caseDecisionBody({...item,source:{...item.source,availability:'unavailable',content:null}},{...draft,restrictionAction:'hide'},1000),null);
 assert.equal(caseSourceLink('javascript:alert(1)'),null);
 assert.equal(caseSourceLink('https://example.org/document'),'https://example.org/document');
});

test('explicit per-case review capabilities preserve or release only the selected case effect',()=>{
 const item=report({state:'appealed',restrictedUntil:new Date(2000*1000).toISOString(),currentEffect:{active:true,until:new Date(2000*1000).toISOString(),restrictionEventId:next,scope:'this-case-only',canKeep:true,canRelease:true,canHide:true}});
 assert.deepEqual(caseDecisionBody(item,draft,1000),{expectedVersion:3,resolution:'accepted',summary:draft.summary,restrictionAction:'keep'});
 assert.deepEqual(caseDecisionBody(item,{...draft,restrictionAction:'release'},1000),{expectedVersion:3,resolution:'accepted',summary:draft.summary,restrictionAction:'release'});
 assert.equal(caseDecisionBody({...item,currentEffect:{...item.currentEffect,canRelease:false}},{...draft,restrictionAction:'release'},1000),null);
 assert.equal(caseDecisionBody(item,{...draft,resolution:'dismissed',restrictionAction:'hide'},1000),null);
 assert.equal(caseDecisionBody({...item,currentEffect:{...item.currentEffect,scope:'unrecognized-scope'}},draft,1000),null);
});
