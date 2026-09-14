import test from 'node:test';
import assert from 'node:assert/strict';
import { createHonorMenu } from '../../../integrations/host-adapters/opencode-stable/honor-menu.mjs';
import { paginateHonor } from '../src/domain/honor-pagination.mjs';
const wait=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('UI did not settle');};
test('native Honor pages contributions, CI, risk signals and full references with the current fingerprint',async()=>{
  let page;const calls=[],id=i=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
  const rule={id:'open',version:'1',title:'Paged contributions',communityId:'fixture',capabilityId:'compiler'};
  const view={card:{subjectId:'subject',issuer:'https://fixture.example',rule,status:'active',checkedAt:2000000000,sourceFingerprint:'a'.repeat(64),evidence:[],proofs:Array.from({length:9},(_,i)=>({proofId:id(300+i)}))},
    facets:{contribution:{acceptedCases:17,relatedPartyCases:0},capabilityEvidence:{proofCount:9},collaborationReliability:{}},
    contributions:Array.from({length:17},(_,i)=>({assistanceId:id(i+1),caseId:id(100+i),sourceEvents:Array.from({length:i===0?27:1},(_,j)=>({eventId:id(1000+j),kind:'accept'})),proofs:[],observations:[],revisionIds:[]})),
    riskAssessment:{status:'review-suggested',policy:{id:'risk',version:3},flags:Array.from({length:9},(_,i)=>({code:`risk-${i}`,assistanceIds:[],caseIds:Array.from({length:i===0?27:1},(_,j)=>id(500+j)),eventIds:[],evidenceIds:[]}))}};
  const menu=createHonorMenu({language:'zh-CN',isCurrent:()=>true,onBack(){},select:v=>{page={kind:'select',...v};},prompt(){},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};},
    controller:{cancel(){},async honorRules(){return {rules:[rule]};},async getHonor(input){calls.push(input);return paginateHonor(view,input);}}});
  const choose=title=>{let option=page.options.find(o=>o.title===title);if(!option&&page.options.some(o=>o.title==='下一页')){const n=page.options.find(o=>o.title==='下一页');page.routes[n.number]();option=page.options.find(o=>o.title===title);}assert.ok(option,title);page.routes[option.number]();};
  menu.open();await wait(()=>page.options?.some(o=>o.title===rule.title));choose(rule.title);choose('查看我的贡献卡片');await wait(()=>page.options?.some(o=>o.title==='查看来源贡献'));
  choose('查看来源贡献');choose(id(1));choose('查看全部引用');await wait(()=>calls.at(-1)?.sourceId===id(1)&&page.kind==='select');choose('下一批引用');
  await wait(()=>calls.at(-1)?.sourceAfter===8&&page.kind==='select');assert.equal(calls.at(-1).expectedFingerprint,'a'.repeat(64));
  page.onBack();await wait(()=>calls.at(-1)?.sourceAfter===0&&page.kind==='select');page.onBack();choose('下一批贡献');await wait(()=>calls.at(-1)?.after===id(8)&&page.kind==='select');
  assert.equal(page.options[0].title,id(9));assert.equal(calls.at(-1).expectedFingerprint,'a'.repeat(64));
  page.onBack();await wait(()=>page.options?.some(o=>o.title==='查看CI依据'));choose('查看CI依据');choose('下一批CI依据');await wait(()=>calls.at(-1)?.proofAfter===id(307)&&page.kind==='select');assert.equal(page.options[0].title,id(308));
  page.onBack();await wait(()=>page.options?.some(o=>o.title==='查看风险提示'));choose('查看风险提示');choose('risk-0');choose('查看全部引用');await wait(()=>calls.at(-1)?.riskIndex===0&&page.kind==='select');choose('下一批引用');await wait(()=>calls.at(-1)?.riskReferenceAfter===8&&page.kind==='select');
  page.onBack();await wait(()=>calls.at(-1)?.riskReferenceAfter===0&&page.kind==='select');page.onBack();choose('下一批风险提示');await wait(()=>calls.at(-1)?.riskAfter===8&&page.kind==='select');assert.equal(page.options[0].title,'risk-8');
});
test('native Honor history remains reachable with no active rule and pages retained definitions',async()=>{
  let page;const calls=[];
  const rule={id:'old-rule',version:'1',title:'Old rule',communityId:'fixture',capabilityId:'compiler'};
  const menu=createHonorMenu({language:'zh-CN',isCurrent:()=>true,onBack(){},select:v=>{page={kind:'select',...v};},prompt(){},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};},
    controller:{cancel(){},async honorRules(){return {rules:[],ruleHistorySupported:true};},async honorRuleHistory(input){calls.push(input);return {items:[{rule:{...rule,version:input.after?'2':'1'},registry:{configured:false,revoked:true}}],nextAfter:input.after?null:5};}}});
  const choose=title=>{const option=page.options.find(o=>o.title===title);assert.ok(option,title);page.routes[option.number]();};
  menu.open();await wait(()=>page.options?.some(o=>o.title==='查看全部历史规则'));choose('查看全部历史规则');
  await wait(()=>page.options?.some(o=>o.title==='Old rule · 1'));assert.ok(page.title.includes('不代表曾经取得荣誉'));
  choose('Old rule · 1');choose('查看规则定义与当前启用状态');assert.ok(page.message.includes('"configured": false'));assert.ok(page.message.includes('"revoked": true'));
  page.onBack();await wait(()=>page.options?.some(o=>o.title==='下一批历史版本'));choose('下一批历史版本');
  await wait(()=>page.options?.some(o=>o.title==='Old rule · 2'));assert.deepEqual(calls.at(-1),{after:5,limit:8});assert.ok(!page.options.some(o=>o.title==='下一批历史版本'));
});
test('native Honor views separate current evidence, related parties and suppressed ranking',async()=>{
  let page;const calls=[];
  const rule={id:'open',version:'1',title:'Open contributor',communityId:'fixture',capabilityId:'compiler'};
  const view={card:{id:'card',subjectId:'subject',issuer:'https://fixture.example',rule,status:'active',checkedAt:2000000000,statusUrl:'https://fixture.example/v1/honor/subject/open/1',ruleHash:'hash'},
    facets:{contribution:{acceptedCases:1,relatedPartyCases:1},capabilityEvidence:{proofCount:0},collaborationReliability:{accepted:1,canceled:0}},
    riskAssessment:{policy:{id:'contribution-risk',version:2},status:'review-suggested',flags:[{code:'repeated-source-case',caseIds:['case'],assistanceIds:['assistance'],eventIds:['acceptance'],evidenceIds:[]},
      {code:'reciprocal-acceptance-cycle',caseIds:['case'],assistanceIds:['assistance'],eventIds:['acceptance'],evidenceIds:[],edges:[{requesterId:'a',providerId:'b',assistanceId:'assistance'}]}]},
    contributions:[{assistanceId:'assistance',caseId:'case',capabilityId:'compiler',state:'accepted',independence:'issuer-declared-related-party',paused:false,corrected:false,disputed:false,sourceEvents:[{kind:'accept',eventId:'acceptance'}],proofs:[]}]};
  const menu=createHonorMenu({language:'zh-CN',isCurrent:()=>true,onBack:()=>{},select:v=>{page={kind:'select',...v};},prompt:v=>{page={kind:'prompt',...v};},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};},
    controller:{cancel(){},async honorRules(){return {rules:[rule]};},async getHonor(input){calls.push(input);return view;},async getPublicHonor(input){calls.push(input);return {...view,card:{...view.card,status:'insufficient-evidence'},contributions:[]};},
      async honorRanking(){return {status:'suppressed',reason:'insufficient-public-cohort',items:[]};}}});
  const choose=title=>{const option=page.options.find(o=>o.title===title);assert.ok(option,title);page.routes[option.number]();};
  menu.open();await wait(()=>page.options?.some(o=>o.title===rule.title));choose(rule.title);choose('查看我的贡献卡片');await wait(()=>page.options?.some(o=>o.title==='贡献与可靠性分项'));
  assert.equal(page.title.includes('active'),true);choose('贡献与可靠性分项');assert.ok(page.message.includes('没有全局总分'));assert.ok(page.message.includes('关联方Case数'));page.onBack();await wait(()=>page.options?.some(o=>o.title==='查看来源贡献'));
  choose('查看风险提示');assert.ok(page.title.includes('不判定欺诈'));choose('同一Case对应多条协作记录');assert.ok(page.message.includes('acceptance'));assert.ok(page.message.includes('没有提示不代表不存在问题'));page.onBack();await wait(()=>page.options?.some(o=>o.title==='查看来源贡献'));
  choose('查看风险提示');choose('可见协作存在循环验收');assert.ok(page.message.includes('a → b'));assert.ok(page.message.includes('循环验收不等于串通'));page.onBack();await wait(()=>page.options?.some(o=>o.title==='查看来源贡献'));
  choose('查看来源贡献');choose('assistance');assert.ok(page.message.includes('acceptance'));assert.ok(page.message.includes('issuer-declared-related-party'));
  page.onBack();await wait(()=>page.options?.some(o=>o.title==='检查公开可见结果'));choose('检查公开可见结果');await wait(()=>page.kind==='select'&&page.title.includes('insufficient-evidence'));assert.equal(calls.at(-1).subjectId,'subject');
  menu.open();await wait(()=>page.options?.some(o=>o.title===rule.title));choose(rule.title);choose('查看范围内排名');await wait(()=>page.kind==='info'&&page.message.includes('insufficient-public-cohort'));
});
