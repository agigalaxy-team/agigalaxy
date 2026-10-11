import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeletionMenu } from '../../../integrations/host-adapters/opencode-stable/deletion-menu.mjs';
const wait=async(check)=>{for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Menu did not settle');};
test('native deletion menu separates takeout choice, signed submission and review state from physical deletion',async()=>{
  let page,prepared,executed=0;
  const id='4e8b2be3-5ba2-4783-9bd9-6dbe30d2765e';
  const menu=createDeletionMenu({language:'zh-CN',isCurrent:()=>true,onBack(){},
    select:value=>{page={kind:'select',...value};},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};},
    controller:{cancel(){},async prepareDeletion(input){prepared=input;return{id,requestId:id,endpoint:'https://fixture.example',confirmation:'fixture-confirm',payloadJson:JSON.stringify({...input,subjectId:'synthetic-owner'})};},
      async executeDeletion(_preview,confirmation){assert.equal(confirmation,'fixture-confirm');executed++;return{id};},
      async readDeletion(method,input){assert.equal(method,'read');assert.equal(input.id,id);return{id,state:'approved',revision:2,events:[],nextAfterRevision:null};}}});
  menu.open();page.routes[1]();assert.equal(prepared,undefined);page.routes[2]();await wait(()=>page.kind==='info'&&page.title==='申请删除本人资料');
  assert.equal(executed,0);assert.match(page.message,/不立即擦除/);assert.match(page.message,/fixture.example/);page.onBack();await wait(()=>page.kind==='select');
  assert.equal(prepared.takeout,'not-needed');assert.equal(executed,0);assert.ok(page.options.find(o=>o.title==='提交申请').description.includes('不立即擦除'));assert.equal(page.title,'申请删除本人资料');assert.match(page.options.find(o=>o.number==='3').description,/fixture.example/);
  page.routes[1]();await wait(()=>page.kind==='select'&&page.title.includes('已审核'));assert.equal(executed,1);assert.ok(page.title.includes('尚未物理删除'));
  page.routes[2]();await wait(()=>page.kind==='info'&&page.title==='取消这次申请');assert.equal(prepared.action,'cancel');assert.equal(prepared.expectedRevision,2);assert.equal(executed,1);
});

test('choosing a saved request reads its current status with the existing holder proof once, without a second signing dialog or a deletion write',async()=>{
  let page,reads=0;const id='f2e380b1-03c6-4ea2-b6a9-b389e6558b97',preview={requestId:id,confirmation:'original-status-confirmation'};
  const menu=createDeletionMenu({language:'zh-CN',isCurrent:()=>true,onBack(){},canSubmit:false,records:{async list(){return{records:[{requestId:id,recordedAt:2000000000}]};},async observe(){}},
    select:v=>{page={kind:'select',...v};},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};},
    controller:{cancel(){},async prepareDeletionStatus(input){assert.deepEqual(input,{requestId:id});return preview;},async executeDeletionStatus(value,confirmation){assert.equal(value,preview);assert.equal(confirmation,preview.confirmation);reads++;return{id,state:'requested'};}}});
  menu.open();page.routes[3]();await wait(()=>page.kind==='select'&&page.title.includes('选择已有申请'));assert.equal(reads,0);
  const open=page.routes[1];open();await wait(()=>page.kind==='info'&&page.title==='已申请');assert.equal(reads,1);assert.match(page.message,/尚未物理删除/);
  open();await new Promise(r=>setTimeout(r,10));assert.equal(reads,1);
});
