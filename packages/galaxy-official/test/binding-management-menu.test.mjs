import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBindingManagementMenu } from '../../../integrations/host-adapters/opencode-stable/binding-management-menu.mjs';
const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,3));}throw new Error('Binding menu did not settle');};
function fixture(){
  const id=randomUUID(),installationId=randomUUID(),queries=[];let page,prepared=0,writes=0,canceled=0,current=true;
  const item={bindingId:id,installationId,scopes:['binding'],state:'active',createdAt:'2030-01-01T00:00:00.000Z',expiresAt:'2030-01-02T00:00:00.000Z',revokedAt:null};
  const preview={bindingId:id,previewJson:JSON.stringify({target:item,currentSession:false}),confirmation:'REVOKE '+id};
  const controller={cancel(){canceled++;},queryBindings:async input=>{queries.push(input);return {subjectId:'GUID'+'A'.repeat(28),currentBindingId:randomUUID(),items:[item],nextAfter:queries.length===1?id:null};},
    prepareBindingRevoke:async target=>{assert.equal(target,id);prepared++;return preview;},
    executeBindingRevoke:async(p,confirmation)=>{assert.equal(p,preview);assert.equal(confirmation,preview.confirmation);writes++;return {state:'revoked',currentSessionEnded:false};}};
  const menu=createBindingManagementMenu({controller,language:'zh-CN',isCurrent:()=>current,onBack:()=>{current=false;},
    select:value=>{page={kind:'select',...value};},prompt:value=>{page={kind:'prompt',...value};},info:(title,text,onBack)=>{page={kind:'info',title,text,onBack};}});
  return {menu,id,installationId,controller,queries,preview,page:()=>page,prepared:()=>prepared,writes:()=>writes,canceled:()=>canceled,
    choose(prefix){const option=page.options.find(value=>value.title.startsWith(prefix));assert.ok(option,prefix);page.routes[option.number]();}};
}
test('native installation list carries pagination and filtering, then requires exact target confirmation',async()=>{
  const f=fixture();f.menu.open();await wait(()=>f.page()?.kind==='select');
  f.choose('下一页');await wait(()=>f.queries.length===2&&f.page()?.kind==='select');assert.equal(f.queries[1].after,f.id);
  f.choose('其他绑定');assert.ok(f.page().title.includes('不支持保留原ID换钥'));f.choose('查看此安装实例的全部绑定');
  await wait(()=>f.queries.length===3&&f.page()?.kind==='select');assert.equal(f.queries[2].installationId,f.installationId);
  f.choose('其他绑定');f.choose('预览撤销此绑定');await wait(()=>f.page()?.kind==='prompt');
  assert.ok(f.page().title.includes(f.id)&&f.page().title.includes(f.installationId));assert.equal(f.writes(),0);
  f.page().onConfirm('wrong');assert.equal(f.writes(),0);assert.equal(f.canceled(),1);
  f.page().onBack();await wait(()=>f.page()?.kind==='select');f.choose('其他绑定');f.choose('预览撤销此绑定');await wait(()=>f.page()?.kind==='prompt');
  const confirmed=f.page();confirmed.onConfirm(f.preview.confirmation);await wait(()=>f.writes()===1&&f.page()?.kind==='info'&&f.page().text.includes('已撤销'));
  confirmed.onConfirm(f.preview.confirmation);assert.equal(f.writes(),1);
});
test('canceling a pending native revocation preview prevents a delayed prompt and any submission',async()=>{
  const f=fixture();let release;
  f.controller.prepareBindingRevoke=()=>new Promise(resolve=>{release=resolve;});
  f.menu.open();await wait(()=>f.page()?.kind==='select');f.choose('其他绑定');f.choose('预览撤销此绑定');
  await wait(()=>!!release);f.page().onBack();await wait(()=>f.page()?.kind==='select');const current=f.page();
  release(f.preview);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.page(),current);assert.equal(f.writes(),0);assert.equal(f.canceled(),1);
});
