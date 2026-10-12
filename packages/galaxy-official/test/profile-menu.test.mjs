import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfileMenu } from '../../../integrations/host-adapters/opencode-stable/profile-menu.mjs';

async function waitFor(predicate){const until=Date.now()+4000;while(!predicate()){if(Date.now()>until)throw new Error('Profile menu transition timeout');await new Promise(resolve=>setTimeout(resolve,5));}}
test('native Profile menu separates self claims and facts, defaults private and previews exact replacement',async()=>{
  let page,active=true,prepared,executed=0,revision=0,canceled=0;
  const subjectId='GUID'+'0'.repeat(28),self={displayName:'Existing name',about:'Private about',claimedCapabilities:['Claimed only']};
  const controller={cancel:()=>canceled++,status:async()=>({state:'session-local',subjectId,scopes:['history','consent']}),
    queryHistory:async()=>({selfDeclared:self,selfDeclaredRevision:revision,items:[{title:'Actual Case',state:'open'}],nextCursor:null}),
    prepareProfile:async input=>{prepared=input;return {endpoint:'https://official.example.org',payloadJson:JSON.stringify(input.selfDeclared),intentJson:JSON.stringify({visibility:input.visibility,viewers:input.viewers}),confirmation:'CONFIRM PROFILE fixture'};},
    executeProfile:async(_preview,confirmation)=>{assert.equal(confirmation,'CONFIRM PROFILE fixture');executed++;return {revision:++revision};}};
  const menu=createProfileMenu({controller,language:'zh-CN',isCurrent:()=>active,onBack:()=>{active=false;},
    select:value=>{page={kind:'select',...value};},prompt:value=>{page={kind:'prompt',...value};},info:(title,message,onConfirm)=>{page={kind:'info',title,message,onConfirm};}});
  menu.open();await waitFor(()=>page?.kind==='select');
  assert.match(page.title,/自述（未经认证）/);assert.match(page.title,/事实派生履历/);assert.match(page.title,/Actual Case/);
  page.routes[1]();page.routes[2]();const stale=page.onConfirm;page.onConfirm('New about');
  stale('Late overwritten text');assert.equal(page.options.find(o=>o.number==='2').description,'New about');
  page.routes[6]();await waitFor(()=>page.kind==='select'&&page.options.some(o=>o.title==='允许本次内容与范围'));
  assert.equal(prepared.visibility,'Private');assert.deepEqual(prepared.viewers,[]);assert.equal(prepared.expectedRevision,0);
  const scope=page.options.find(option=>option.number==='1').description;
  assert.ok(scope.includes('New about'));assert.match(scope,/仅自己/);assert.equal(executed,0);
  page.routes[2]();assert.equal(page.kind,'info');assert.ok(page.message.includes(JSON.stringify(prepared.selfDeclared)));
  assert.equal(executed,0);page.onConfirm();
  page.routes[1]();await waitFor(()=>page.kind==='info'&&executed===1);
  page.onConfirm();await waitFor(()=>page.kind==='select');
  page.routes[1]();page.routes[7]();assert.equal(executed,1);
  page.routes[6]();await waitFor(()=>page.kind==='select'&&page.options.some(o=>o.title==='允许本次内容与范围'));assert.deepEqual(prepared.selfDeclared,{});
  const lateConfirmation=page.routes[1];page.onBack();lateConfirmation();
  assert.equal(executed,1);assert.ok(canceled>0);
});
test('native Profile menu offers read-only empty profiles and discards a late result after leaving',async()=>{
  let page,active=true,release,cancels=0,queries=0;
  const controller={cancel:()=>cancels++,status:async()=>({state:'session-local',subjectId:'GUID'+'0'.repeat(28),scopes:['history']}),
    queryHistory:()=>++queries===1?Promise.resolve({selfDeclared:{},items:[],nextCursor:null}):new Promise(resolve=>{release=resolve;})};
  const menu=createProfileMenu({controller,language:'en-US',isCurrent:()=>active,onBack:()=>{active=false;},
    select:value=>{page=value;},prompt:()=>assert.fail('Unexpected prompt'),info:(title,message,onConfirm)=>{page={title,message,onConfirm};}});
  menu.open();await waitFor(()=>page?.options);
  assert.ok(!page.options.some(option=>option.number==='1'));assert.match(page.title,/No history; no default certification/);
  page.routes[2]();await waitFor(()=>release);page.onConfirm();
  const left=page;release({selfDeclared:{},items:[],nextCursor:null});await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(page,left);assert.equal(cancels,1);
});
