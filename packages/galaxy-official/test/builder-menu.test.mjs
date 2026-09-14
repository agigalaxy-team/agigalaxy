import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuilderMenu } from '../../../integrations/host-adapters/opencode-stable/builder-menu.mjs';
import { builderDeclaration } from './builders-workflow.mjs';
const wait=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('UI did not settle');};
test('native Hub directory check is explicit, displays matching scope and discards canceled results',async()=>{
  let page,called=0,release,seen;
  const current={builderId:'builder',declarationId:'declaration',type:'hub',declaration:{manifest:{sha256:'a'.repeat(64)}},registration:{},compatibility:{},reachability:{},evidence:{},versions:[],notices:[],reports:[]};
  const menu=createBuilderMenu({language:'zh-CN',isCurrent:()=>true,onBack(){},select:v=>{page={kind:'select',...v};},prompt(){},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};},
    controller:{cancel(){},async getBuilder(){return current;},async verifyHubDirectory(input){called++;seen=input;if(called===2)await new Promise(resolve=>{release=resolve;});return {directoryState:'matched',data:{endpoint:'https://hub.example.org'},profile:'galaxy-hub/1',manifestSha256:'a'.repeat(64),differences:[]};}}});
  const choose=()=>{const item=page.options.find(o=>o.title==='核对Hub签名与目录声明');assert.ok(item);page.routes[item.number]();};
  menu.openBuilder('builder');await wait(()=>page.kind==='select');assert.equal(called,0);
  choose();await wait(()=>page.message?.includes('元数据匹配'));
  assert.deepEqual(seen,{builderId:'builder',declarationId:'declaration',manifestSha256:'a'.repeat(64)});
  assert.match(page.message,/尚未连接或授权/);assert.match(page.message,/不认证运营者身份或执行能力/);
  page.onBack();await wait(()=>page.kind==='select');choose();await wait(()=>release);
  page.onBack();await wait(()=>page.kind==='select');const previous=page;release();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(page,previous);
});
test('native A2A endpoint configuration and probe are separately confirmed and preserve the declared target',async()=>{
  let page,prepared;
  const current={builderId:'builder',declarationId:'declaration',type:'worker',declaration:{name:'Worker'},registration:{},compatibility:{},reachability:{},evidence:{},versions:[],notices:[],reports:[],
    disclosure:{visibility:'Private',viewers:['viewer']},nodeControl:{state:'node-authorized-owner',controlId:'control'},nodeControlDisclosure:{visibility:'Private',viewers:['viewer']}};
  const menu=createBuilderMenu({language:'zh-CN',isCurrent:()=>true,onBack(){},select:v=>{page={kind:'select',...v};},prompt:v=>{page={kind:'prompt',...v};},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};},
    controller:{cancel(){},async getBuilder(){return current;},async prepareBuilder(input){prepared=input;return {endpoint:'https://fixture.example',payloadJson:JSON.stringify(input),intentJson:'builder.publish',confirmation:'CONFIRM BUILDER fixture'};}}});
  function choose(title){for(let i=0;i<4;i++){const item=page.options.find(o=>o.title===title);if(item)return page.routes[item.number]();const next=page.options.find(o=>o.title==='下一页');if(!next)break;page.routes[next.number]();}assert.fail(title);}
  menu.openBuilder('builder');await wait(()=>page.kind==='select');choose('配置A2A观测端点');
  for(const value of ['https://worker.example/a2a','https://worker.example/card','tenant'])page.onConfirm(value);
  await wait(()=>page.kind==='prompt'&&page.title.includes('builder.publish'));
  assert.deepEqual(prepared.declaration.a2a,{protocol:'a2a/1.0',transport:'JSONRPC',endpoint:'https://worker.example/a2a',cardUrl:'https://worker.example/card',tenant:'tenant'});
  assert.equal(prepared.visibility,'Private');assert.deepEqual(prepared.viewers,['viewer']);
  current.declaration=prepared.declaration;page.onCancel();await wait(()=>page.kind==='select');choose('请求端点可达性观测');
  await wait(()=>page.kind==='prompt'&&page.title.includes('builder.publish'));assert.deepEqual(prepared,{kind:'probe-request',builderId:'builder',baseDeclarationId:'declaration'});
});

test('native Node work evidence keeps exact sources, optional task references and separate revoke confirmation',async()=>{
  let page,prepared,sent=0;
  const item={eventId:'work',state:'current',source:{caseId:'case'},executionAttributionVerified:false};
  const current={builderId:'builder',declarationId:'declaration',type:'worker',declaration:{name:'Fixture'},registration:{},compatibility:{},reachability:{},
    evidence:{nodeWorkEvidence:{items:[item]}},versions:[],reports:[],notices:[],nodeControl:{state:'node-authorized-owner',controlId:'control'},nodeControlDisclosure:{visibility:'Public',viewers:[]}};
  const preview={endpoint:'https://fixture.example',payloadJson:'exact-work-association',intentJson:'builder.publish',confirmation:'CONFIRM BUILDER work'};
  const menu=createBuilderMenu({language:'zh-CN',isCurrent:()=>true,onBack(){},select:v=>{page={kind:'select',...v};},prompt:v=>{page={kind:'prompt',...v};},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};},
    controller:{cancel(){},async getBuilder(){return current;},async prepareBuilder(input){prepared=input;return preview;},async executeBuilder(p,text){assert.equal(p,preview);assert.equal(text,preview.confirmation);sent++;return {eventId:'work'};}}});
  function choose(title){for(let i=0;i<4;i++){const item=page.options.find(o=>o.title.includes(title));if(item)return page.routes[item.number]();
    const next=page.options.find(o=>o.title==='下一页');if(!next)break;page.routes[next.number]();}assert.fail(title);}
  const open=async()=>{menu.openBuilder('builder');await wait(()=>page.kind==='select');};
  await open();choose('节点关联的任务证据');choose('current · work');choose('查看准确来源与局限');assert.ok(page.message.includes('executionAttributionVerified'));assert.equal(sent,0);
  await open();choose('以Node身份关联任务证据');
  for(const value of ['case','attempt','result','proof1,proof2','Node participation','https://agent.example/a2a','task1'])page.onConfirm(value);
  await wait(()=>page.kind==='prompt'&&page.title.includes('exact-work-association'));
  assert.deepEqual(prepared,{kind:'work-evidence',builderId:'builder',baseDeclarationId:'declaration',caseId:'case',attemptId:'attempt',resultId:'result',proofIds:['proof1','proof2'],summary:'Node participation',task:{protocol:'a2a/1.0',endpoint:'https://agent.example/a2a',taskId:'task1'}});
  const stale=page;stale.onCancel();await open();stale.onConfirm(preview.confirmation);assert.equal(sent,0);
  choose('节点关联的任务证据');choose('current · work');choose('撤销这份关联');page.onConfirm('Wrong association');
  await wait(()=>page.kind==='prompt'&&page.title.includes('builder.publish'));
  assert.deepEqual(prepared,{kind:'work-evidence-revoke',builderId:'builder',baseDeclarationId:'declaration',workEventId:'work',reason:'Wrong association'});
  page.onConfirm(preview.confirmation);await wait(()=>page.kind==='info'&&page.message.includes('已记录'));assert.equal(sent,1);
  delete current.nodeControlDisclosure;await open();assert.ok(!page.options.some(o=>o.title==='以Node身份关联任务证据'));
});

test('native Node proof export requires direct Node confirmation and leaves ordinary viewers with registry snapshots',async()=>{
  let page,prepared=0,signed=0,snapshots=0;
  const current={builderId:'builder',type:'worker',declaration:{name:'Worker'},registration:{state:'registered'},compatibility:{state:'unverified'},reachability:{},evidence:{},versions:[],notices:[],reports:[],nodeControl:{state:'node-authorized-owner',controlId:'control'},nodeControlDisclosure:{visibility:'Public',viewers:[]}};
  const preview={controlId:'control',payloadJson:'exact-node-proof-claims',confirmation:'CONFIRM NODE PROOF exact',endpoint:'https://fixture.example'};
  const menu=createBuilderMenu({language:'zh-CN',isCurrent:()=>true,onBack(){},select:v=>{page={kind:'select',...v};},prompt:v=>{page={kind:'prompt',...v};},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};},
    controller:{cancel(){},async getBuilder(){return current;},async exportNodeControl(){snapshots++;return {nodeSignatureVerified:false};},async prepareNodeControlProof(){prepared++;return preview;},async executeNodeControlProof(p,text){assert.equal(p,preview);assert.equal(text,preview.confirmation);signed++;return {path:'local-proof.json'};}}});
  const choose=title=>{const item=page.options.find(o=>o.title===title);assert.ok(item,title);page.routes[item.number]();};
  const open=async()=>{menu.openBuilder('builder');await wait(()=>page.kind==='select'&&page.options.some(o=>o.title==='节点授权证明'));choose('节点授权证明');};
  await open();choose('读取服务签名授权快照');await wait(()=>page.kind==='info');assert.equal(snapshots,1);assert.equal(signed,0);
  await open();choose('用Node密钥签署并保存证明');await wait(()=>page.kind==='prompt');assert.ok(page.title.includes('exact-node-proof-claims'));assert.equal(prepared,1);assert.equal(signed,0);
  const stale=page;stale.onCancel();await open();stale.onConfirm(preview.confirmation);assert.equal(signed,0);
  choose('用Node密钥签署并保存证明');await wait(()=>page.kind==='prompt');page.onConfirm(preview.confirmation);
  await wait(()=>page.kind==='info'&&page.message.includes('local-proof.json'));assert.equal(signed,1);
  delete current.nodeControlDisclosure;await open();assert.ok(!page.options.some(o=>o.title==='用Node密钥签署并保存证明'));
});

test('native owner recovery chooses fresh notice visibility without reviving unavailable declaration text',async()=>{
  let page,prepared;
  const current={mode:'owner-management',builderId:'builder',declarationId:'old-declaration',revision:3,type:'worker',declaration:null,declarationState:'unavailable',
    delisted:false,securityIssue:false,allowedActions:['declare','delist','correction','security-issue']};
  const menu=createBuilderMenu({language:'zh-CN',isCurrent:()=>true,onBack(){},select:v=>{page={kind:'select',...v};},prompt:v=>{page={kind:'prompt',...v};},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};},
    controller:{cancel(){},async queryOwnedBuilders(){return {items:[{builderId:'builder',type:'worker',name:null,declarationState:'unavailable'}],nextAfter:null};},async getBuilderManagement(){return current;},
      async queryBuilderNotices(){return {items:[],nextAfter:null};},async prepareBuilder(input){prepared=input;return {confirmation:'CONFIRM BUILDER notice',intentJson:'builder.publish',payloadJson:'{}'};}}});
  const choose=title=>{const item=page.options.find(o=>o.title===title);assert.ok(item,title);page.routes[item.number]();};
  menu.open();choose('管理我的登记');await wait(()=>page.kind==='select'&&page.options.some(o=>o.title==='builder'));choose('builder');
  await wait(()=>page.kind==='select'&&page.options.some(o=>o.title==='从目录下架'));
  assert.ok(!page.options.some(o=>o.title==='恢复目录展示'||o.title==='解决安全问题'));
  choose('从目录下架');page.onConfirm('This release is withdrawn');assert.equal(prepared,undefined);
  choose('公开已选内容');await wait(()=>page.kind==='prompt'&&page.title.includes('builder.publish'));
  assert.deepEqual(prepared,{management:true,kind:'maintenance',builderId:'builder',baseDeclarationId:'old-declaration',baseRevision:3,action:'delist',summary:'This release is withdrawn',visibility:'Public',viewers:[]});
  const stale=page.onConfirm;page.onCancel();stale('CONFIRM BUILDER notice');
});

test('native persistent retry separates reconciliation from sending and ignores canceled confirmation callbacks',async()=>{
  let page,prepared=0,sent=0,reconciled=0;
  const preview={eventId:'event',confirmation:'CONFIRM BUILDER event exact',intentJson:'original-intent',payloadJson:'original-event',endpoint:'https://fixture.example'};
  const menu=createBuilderMenu({language:'zh-CN',isCurrent:()=>true,onBack(){},select:v=>{page={kind:'select',...v};},prompt:v=>{page={kind:'prompt',...v};},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};},
    controller:{cancel(){},async listBuilderOperations(){return {items:[{eventId:'event',builderId:'builder',kind:'declare',status:'unknown'}]};},
      async reconcileBuilder(id){assert.equal(id,'event');reconciled++;return {state:'absent'};},async prepareBuilderRetry(id){assert.equal(id,'event');prepared++;return preview;},
      async executeBuilder(p,text){assert.equal(p,preview);assert.equal(text,preview.confirmation);sent++;return {eventId:'event'};}}});
  const choose=title=>{const item=page.options.find(o=>o.title===title);assert.ok(item,title);page.routes[item.number]();};
  const openRecord=async()=>{menu.open();choose('本机建设者待办');await wait(()=>page.kind==='select'&&page.options.some(o=>o.title==='declare · event'));choose('declare · event');};
  await openRecord();assert.ok(!page.options.some(o=>o.title==='移除此本机记录'));choose('核对远端事件结果');
  await wait(()=>page.kind==='info'&&page.message.includes('absent'));assert.equal(reconciled,1);assert.equal(prepared,0);assert.equal(sent,0);
  await openRecord();choose('预览原事件重试');await wait(()=>page.kind==='prompt');const canceled=page;
  canceled.onCancel();await openRecord();canceled.onConfirm(preview.confirmation);assert.equal(sent,0);
  choose('预览原事件重试');await wait(()=>page.kind==='prompt');const active=page;
  active.onConfirm(preview.confirmation);active.onConfirm(preview.confirmation);await wait(()=>page.kind==='info'&&page.message.includes('已记录'));
  assert.equal(sent,1);assert.equal(prepared,2);
});

test('native builder declarations map all three types and require one exact final confirmation',async()=>{
  let page,prepared,submitted=0;
  const preview={endpoint:'https://fixture.example',intentJson:'{"action":"builder.publish"}',payloadJson:'{}',confirmation:'CONFIRM BUILDER fixture',eventId:'event'};
  const menu=createBuilderMenu({language:'zh-CN',isCurrent:()=>true,onBack(){},select:v=>{page={kind:'select',...v};},prompt:v=>{page={kind:'prompt',...v};},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};},
    controller:{cancel(){},async prepareBuilder(input){prepared=input;return preview;},async executeBuilder(p,c){assert.equal(p,preview);assert.equal(c,preview.confirmation);submitted++;return preview;}}});
  const choose=title=>{const item=page.options.find(o=>o.title===title);assert.ok(item,title);page.routes[item.number]();};
  for(const type of ['worker','bridge','hub']){
    menu.open();choose('新建登记');choose(type);
    const values=['Fixture','Fixture scope','1','a'.repeat(64),'b'.repeat(40),'https://fixture.example/artifact','https://fixture.example/policy','https://fixture.example/contact',
      'dependency | 1 | '+'c'.repeat(64),'Upgrade preserving identity','Rollback',''];
    if(type==='worker')values.push('GUID'+'0'.repeat(28),'config1','Public config summary','model', 'compiler','coding','2','coding | Declared claim | Fixture limitation');
    else if(type==='bridge')values.push('GitHub','run','Evidence','Preserve provenance','source-assertion','Owner grant','1','Source ID','Invalidate linked result','Source control unverified');
    else values.push('Operator','https://fixture.example/charter','Fixture','https://hub.example','https://hub.example/manifest','d'.repeat(64),'1','Exit','Export');
    values.push('yes');for(const value of values){assert.equal(page.kind,'prompt');page.onConfirm(value);}
    choose('公开已选内容');await wait(()=>page.kind==='prompt'&&page.title.includes('builder.publish'));
    assert.equal(prepared.declaration.type,type);assert.equal(prepared.visibility,'Public');assert.equal(submitted,['worker','bridge','hub'].indexOf(type));
    page.onConfirm(preview.confirmation);await wait(()=>page.kind==='info'&&page.message.includes('已记录'));
  }
  assert.equal(prepared.declaration.manifest.sha256,'d'.repeat(64));
});

test('native report export is explicit and unavailable for untracked suites',async()=>{
  let page,exports=0;
  const report={id:'report',suite:{name:'Suite',version:'1'},validity:'current',suiteStatus:{portable:true,state:'current'},checks:[]};
  const current={builderId:'builder',declaration:{},registration:{},compatibility:{},reachability:{},evidence:{},versions:[],reports:[report],notices:[]};
  const menu=createBuilderMenu({language:'zh-CN',isCurrent:()=>true,onBack(){},select:v=>{page={kind:'select',...v};},prompt(){},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};},
    controller:{cancel(){},async getBuilder(){return current;},async exportBuilderReport(input){assert.deepEqual(input,{builderId:'builder',reportId:'report'});exports++;return {signed:'fixture-signed-report',capabilityVerified:false};}}});
  const choose=title=>{const item=page.options.find(o=>o.title.includes(title));assert.ok(item,title);page.routes[item.number]();};
  menu.openBuilder('builder');await wait(()=>page.kind==='select');choose('兼容报告与失败项');choose('Suite');
  assert.equal(exports,0);choose('生成可携带签名报告');await wait(()=>page.kind==='info'&&page.message.includes('fixture-signed-report'));assert.equal(exports,1);
  report.suiteStatus.portable=false;menu.openBuilder('builder');await wait(()=>page.kind==='select');choose('兼容报告与失败项');choose('Suite');
  assert.ok(!page.options.some(o=>o.title.includes('生成')));
});
test('native builder reading is passive and maintenance/report routes use their correct permissions',async()=>{
  let page,prepared,submitted=0;
  const current={builderId:'builder',declarationId:'declaration',type:'worker',declaration:builderDeclaration('worker','GUID'+'0'.repeat(28)),registration:{state:'registered'},compatibility:{state:'unverified'},reachability:{endpointReachable:null},evidence:{state:'none-current'},versions:[],reports:[],notices:[],disclosure:{visibility:'Public',viewers:[]},delisted:false,securityIssue:false};
  const preview={endpoint:'https://fixture.example',intentJson:'builder.publish',payloadJson:'{}',confirmation:'CONFIRM BUILDER fixture',eventId:'event'};
  const menu=createBuilderMenu({language:'zh-CN',isCurrent:()=>true,onBack(){},select:v=>{page={kind:'select',...v};},prompt:v=>{page={kind:'prompt',...v};},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};},
    controller:{cancel(){},async getBuilder(){return current;},async prepareBuilder(input){prepared=input;return preview;},async executeBuilder(){submitted++;return preview;}}});
  const choose=title=>{const item=page.options.find(o=>o.title===title);assert.ok(item,title);page.routes[item.number]();};
  menu.openBuilder('builder');await wait(()=>page.kind==='select');choose('登记、兼容、心跳与证据');assert.ok(page.message.includes('endpointReachable'));assert.equal(prepared,undefined);assert.equal(submitted,0);
  page.onBack();await wait(()=>page.kind==='select');choose('维护登记');choose('从目录下架');page.onConfirm('Fixture notice');await wait(()=>page.kind==='prompt'&&page.title.includes('builder.publish'));
  assert.equal(prepared.kind,'maintenance');assert.equal(prepared.action,'delist');assert.equal(prepared.baseDeclarationId,'declaration');page.onCancel();await wait(()=>page.kind==='select');assert.equal(submitted,0);
  delete current.disclosure;current.reportDisclosure={visibility:'Public',viewers:[]};menu.openBuilder('builder');await wait(()=>page.kind==='select'&&page.options.some(o=>o.title==='提交兼容报告'));
  assert.ok(!page.options.some(o=>o.title==='维护登记'));choose('提交兼容报告');
  for(const value of ['Suite','1','a'.repeat(64),'https://suite.example/test','2026-09-10T08:00:00+08:00','2026-09-10T09:00:00+08:00',...Array(7).fill('not-tested | Fixture'), 'Scoped results only'])page.onConfirm(value);
  await wait(()=>page.kind==='prompt'&&page.title.includes('builder.publish'));assert.equal(prepared.kind,'compatibility');assert.equal(prepared.profile,'galaxy-conformance/2');assert.equal(prepared.checks.length,7);assert.equal(prepared.checks[1].id,'evidence');assert.equal(prepared.checks[0].status,'not-tested');
  page.onCancel();delete current.reportDisclosure;current.nodeControlDisclosure={visibility:'Public',viewers:[]};current.nodeControl={state:'node-authorized-owner',controlId:'control'};
  menu.openBuilder('builder');await wait(()=>page.kind==='select'&&page.options.some(o=>o.title==='以Node身份授权此登记'));
  choose('以Node身份授权此登记');await wait(()=>page.kind==='prompt'&&page.title.includes('builder.publish'));assert.equal(prepared.kind,'node-control');page.onCancel();
  await wait(()=>page.kind==='select');choose('撤销Node登记授权');page.onConfirm('Node no longer approves this owner');await wait(()=>page.kind==='prompt'&&page.title.includes('builder.publish'));assert.equal(prepared.kind,'node-control-revoke');

});
