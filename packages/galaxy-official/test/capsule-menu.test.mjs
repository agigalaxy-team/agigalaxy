import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapsuleMenu } from '../../../integrations/host-adapters/opencode-stable/capsule-menu.mjs';
const wait=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('UI did not settle');};
test('native Capsule reading is passive and application requires explicit payload confirmation',async()=>{
  let page,prepared,submitted=0;
  const version={title:'Compiler guide',version:1,license:'MIT',problemPattern:'Missing module',solutionStrategy:'Inspect exports',applicableScope:'Node',limitations:['Fixture'],environment:{name:'Node',version:'24'},tools:[],skills:[],mcpRefs:[],verificationMethod:'Reported',sourceResolution:{caseId:'source',resultId:'result',proofIds:[]}};
  const current={capsuleId:'capsule',versionId:'v1',authorId:'author',version,versions:[{versionId:'v1',version:1,title:version.title}],notices:[],deprecated:false,securityIssue:false,sourceNeedsReview:false,sourceProofs:[]};
  const preview={capsuleId:'capsule',eventId:'event',endpoint:'https://fixture.example',intentJson:'{"action":"capsule.use"}',payloadJson:'{}',confirmation:'CONFIRM CAPSULE fixture'};
  const menu=createCapsuleMenu({language:'zh-CN',isCurrent:()=>true,onBack:()=>{},select:v=>{page={kind:'select',...v};},prompt:v=>{page={kind:'prompt',...v};},info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};},
    controller:{cancel(){},async getCapsule(){return current;},async prepareCapsule(input){prepared=input;return preview;},async executeCapsule(value,confirmation){assert.equal(value,preview);assert.equal(confirmation,preview.confirmation);submitted++;return preview;}}});
  const choose=title=>{const option=page.options.find(o=>o.title===title);assert.ok(option,title);page.routes[option.number]();};
  menu.openCapsule('capsule','v1');await wait(()=>page.options?.some(o=>o.title==='阅读解决策略'));choose('阅读解决策略');assert.ok(page.message.includes('Inspect exports'));assert.equal(submitted,0);assert.equal(prepared,undefined);page.onBack();await wait(()=>page.options?.some(o=>o.title==='记录实际应用结果'));
  choose('记录实际应用结果');for(const value of ['new-case','Actually applied','attempt','result','New runtime'])page.onConfirm(value);choose('公开已选内容');await wait(()=>page.kind==='prompt'&&page.title.includes('capsule.use'));assert.equal(submitted,0);assert.equal(prepared.kind,'apply');assert.equal(prepared.environmentDifference,'New runtime');assert.equal(prepared.visibility,'Public');
  page.onConfirm(preview.confirmation);await wait(()=>submitted===1);
  current.deprecated=true;menu.openCapsule('capsule','v1');await wait(()=>page.kind==='select'&&page.title.includes('true'));assert.ok(!page.options.some(o=>o.title==='记录实际应用结果'));assert.ok(page.options.some(o=>o.title==='阅读解决策略'));
});
