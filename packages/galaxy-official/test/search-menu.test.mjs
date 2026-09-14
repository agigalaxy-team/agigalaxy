import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSearchMenu } from '../../../integrations/host-adapters/opencode-stable/search-menu.mjs';
import { createSearchFeedbackMenu } from '../../../integrations/host-adapters/opencode-stable/search-feedback-menu.mjs';
const wait=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('UI did not settle');};
function setup(controller,availableScopes=['history','proof','capsules']){
  let page,current=true;
  const menu=createSearchMenu({controller,availableScopes,language:'zh-CN',isCurrent:()=>current,onBack:()=>{},select:value=>{page={kind:'select',...value};},prompt:value=>{page={kind:'prompt',...value};},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};}});
  return {menu,get page(){return page;},expire:()=>{current=false;},choose(title){const option=page.options.find(o=>o.title===title);assert.ok(option,title);return page.routes[option.number]();}};
}
test('native search selects source filters, shows provenance and continues only the current query',async()=>{
  const id=randomUUID(),next=randomUUID(),calls=[];
  const ui=setup({cancel(){},querySearch:async input=>{calls.push(input);return {type:input.type,items:[{type:input.type,id,title:'Compiler CI',summary:'failure',source:{kind:'proof',id,evidenceId:'published-evidence'},record:{assertion:{scope:'CI only'}},matchReasons:['compiler → repository'],limitations:['No individual capability conclusion']}],nextCursor:calls.length===1?next:null,windowLimited:false};}});
  ui.menu.open();assert.deepEqual(ui.page.options.map(o=>o.title),['case','history','proof','capsule']);
  ui.choose('proof');ui.choose('关键词');ui.page.onConfirm('compiler');ui.choose('CI结论');ui.page.onConfirm('failure');
  assert.equal(calls.length,0);ui.choose('开始查询');await wait(()=>ui.page.options?.some(o=>o.title==='proof · Compiler CI'));
  assert.deepEqual(calls[0],{type:'proof',query:{query:'compiler',limit:8,conclusion:'failure'}});
  ui.choose('proof · Compiler CI');assert.ok(ui.page.message.includes('published-evidence'));assert.ok(ui.page.message.includes('No individual capability conclusion'));ui.page.onBack();
  ui.choose('下一页');await wait(()=>calls.length===2&&ui.page.kind==='select');assert.equal(calls[1].query.after,next);assert.ok(!ui.page.options.some(o=>o.title==='下一页'));
  ui.page.onBack();ui.choose('CI结论');ui.page.onConfirm('');ui.choose('开始查询');await wait(()=>calls.length===3);assert.equal(calls[2].query.conclusion,undefined);assert.equal(calls[2].query.after,undefined);
});
test('native search filters unavailable sources and ignores callbacks or results after leaving',async()=>{
  let release,canceled=0;
  const ui=setup({cancel(){canceled++;},querySearch:()=>new Promise(resolve=>{release=resolve;})},['proof']);
  ui.menu.open();assert.deepEqual(ui.page.options.map(o=>o.title),['proof']);ui.choose('proof');
  const stale=ui.page.routes['1'];ui.choose('开始查询');await wait(()=>release);ui.page.onBack();
  assert.equal(canceled,1);const returned=ui.page;stale();assert.equal(ui.page,returned);
  release({items:[],nextCursor:null});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(ui.page,returned);
  ui.expire();returned.routes['1']();assert.equal(ui.page,returned);
});

test('native builders-only session searches Worker and Hub public metadata using owner filters',async()=>{
  const calls=[],ownerId='GUID'+'0'.repeat(28);
  const ui=setup({cancel(){},querySearch:async input=>{calls.push(input);return {items:[],nextCursor:null};}},['builders']);
  ui.menu.open();assert.deepEqual(ui.page.options.map(o=>o.title),['worker','hub']);
  ui.choose('hub');assert.equal(ui.page.options.some(o=>o.title==='Capability ID'),false);
  ui.choose('登记所有者 ID');ui.page.onConfirm(ownerId);ui.choose('关键词');ui.page.onConfirm('Kulai Malaysia');
  ui.choose('开始查询');await wait(()=>calls.length===1&&ui.page.kind==='select');
  assert.deepEqual(calls[0],{type:'hub',query:{query:'Kulai Malaysia',limit:8,ownerId}});
});
test('native search explains retry timing without losing selected source filters',async()=>{
  const ui=setup({cancel(){},querySearch:async()=>{const error=new Error('Invalid endpoint response');error.code='GALAXY_RATE_LIMITED';error.retryAfterSeconds=12;throw error;}},['proof']);
  ui.menu.open();ui.choose('proof');ui.choose('CI结论');ui.page.onConfirm('failure');ui.choose('开始查询');
  await wait(()=>ui.page.kind==='info'&&ui.page.message.includes('12 秒'));ui.page.onBack();
  assert.equal(ui.page.options.find(o=>o.title==='CI结论').description,'failure');
});

test('native result feedback writes only on explicit save and preserves independent answers',async()=>{
  const id=randomUUID(),writes=[];
  const ui=setup({cancel(){},querySearch:async()=>({items:[{type:'proof',id,title:'Compiler',source:{kind:'proof',id},record:{},matchReasons:[],summary:'Example'}],nextCursor:null}),
    recordSearchFeedback:async(id,verdict)=>{writes.push({id,verdict});}},['proof']);
  ui.menu.open();ui.choose('proof');ui.choose('开始查询');await wait(()=>ui.page.options?.some(o=>o.title==='proof · Compiler'));
  ui.choose('proof · Compiler');ui.page.onBack();ui.choose('填写本机反馈');assert.equal(writes.length,0);
  ui.choose('是否相关');ui.choose('不相关');ui.choose('是否帮助选择');ui.choose('有帮助');assert.equal(writes.length,0);
  const stale=ui.page.routes['3'];ui.page.onBack();stale();assert.equal(writes.length,0);
  ui.choose('proof · Compiler');ui.page.onBack();ui.choose('填写本机反馈');ui.choose('是否相关');ui.choose('不相关');ui.choose('是否帮助选择');ui.choose('有帮助');
  ui.choose('保存反馈');await wait(()=>ui.page.kind==='info'&&ui.page.message.includes('已更新'));
  assert.deepEqual(writes,[{id,verdict:{relevance:'not-relevant',helpedSelection:true}}]);
});

test('native summary shows scoped totals and edits the selected revision after pagination',async()=>{
  let page;const reads=[],writes=[],next='b'.repeat(64),id='a'.repeat(64);
  const counts={responses:10,relevance:{relevant:6,notRelevant:3,unsure:1},helpedSelection:{yes:5,no:3,unanswered:2}};
  const controller={querySearchFeedback:async input=>{reads.push(input);return {endpoint:'https://official.example.org',summary:{...counts,sources:8,queries:9,bySource:{proof:counts,case:counts,history:counts,capsule:counts},unreadableEntries:0},
    items:[{id,sourceType:'proof',sourceId:randomUUID(),sourceVersion:randomUUID(),snapshotHash:'c'.repeat(64),criteria:{query:'Compiler'},relevance:'relevant',helpedSelection:true,revision:3,updatedAt:'2026-09-10T00:00:00Z'}],nextCursor:input.after?null:next};},
    editSearchFeedback:async input=>{writes.push(input);}};
  const menu=createSearchFeedbackMenu({controller,language:'zh-CN',isCurrent:()=>true,onBack:()=>{},select:value=>{page={kind:'select',...value};},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};}});
  const choose=title=>{const option=page.options.find(o=>o.title===title);assert.ok(option,title);page.routes[option.number]();};
  await menu.open();assert.match(page.title,/本机反馈 10 条/);choose('proof');await wait(()=>reads.length===2&&page.title.includes('不是成功率'));
  choose('下一页');await wait(()=>reads.length===3&&page.options.length===1);assert.equal(reads[2].after,next);assert.equal(reads[2].sourceType,'proof');
  choose('proof · Compiler');assert.match(page.message,/来源当前有效性未重新核查/);page.onBack();assert.equal(writes.length,0);
  choose('移除此条反馈');await wait(()=>page.kind==='info'&&page.message.includes('已更新'));
  assert.deepEqual(writes,[{id,revision:3,verdict:null}]);
});
