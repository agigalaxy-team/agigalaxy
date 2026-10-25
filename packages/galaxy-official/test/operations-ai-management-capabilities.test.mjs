import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {managementCapabilitiesWithin} from '../src/operations/permissions/ai-management-capabilities.mjs';
import {bindOperationsAiUse,withOperationsAiWork} from '../src/shared/operations-ai-use.mjs';

// Projection-only contracts. Actual role/task/delegation authorization and
// database writes are covered by operations-ai-prompt-management's real PG leaf.
function fixture({readRights=true,readDelegation=true,duty=false,planActions=null,mode='ai'}={}){
 const source=randomUUID(),target={id:randomUUID(),domain:'maintenance',name:'明确获准目标',enabled:true},row={id:randomUUID(),version:3,enabled:true,target_ai_account_ids:[target.id],allowed_management_actions:['create','prompt-update',...(readDelegation?['read','prompt-read']:[])]},query=readRights?['ai.roles.read','ai.prompts.read','strategies.read']:[],write=['ai.roles.create','ai.prompts.update','strategies.ordinary.configure','strategies.ordinary.publish'];
 let actor={kind:duty?'operations-ai-service':'business-operator',operatorId:'capability-fixture',endpoint:'https://projection.synthetic.invalid',aiAccountId:source,domain:'overview'};
 if(!duty)actor=withOperationsAiWork(bindOperationsAiUse(actor,'overview'),{accountId:source,purpose:'prepare',resolve:async()=>{throw new Error('Projection fixture must not be used as an authorization resolver');}});
 const taskId=randomUUID(),original=actor,authority={acceptsDuty:value=>duty&&value===original,dutyContext:()=>({taskId}),human:async(value,{purpose})=>({...value,businessAuthorization:{permissions:purpose==='query'?query:write}}),requireDutyAction:async(value,_action,{purpose})=>({...value,businessAuthorization:{permissions:purpose==='query'?query:write}}),dutyActionReady:permission=>permission.startsWith('strategies.ordinary.')},owner={endpoint:'official',aiServiceAuthority:authority,
  delegationAvailabilityWithin:async()=>({delegationId:row.id,version:row.version,canReadRoles:readRights&&readDelegation,canReadPrompts:readRights&&readDelegation,targetAiAccountIds:[target.id]}),
  aiRoleDelegation:{current:async()=>row,account:async()=>target}};
 return()=>managementCapabilitiesWithin(owner,{query:async(_sql,args)=>{assert.deepEqual(args,['official',taskId,source]);return{rows:[{configuration:{plan:{actions:planActions??write}},mode}]};}}, {actor});
}
test('a human card with only write rights reports missing current read permission',async()=>{
 const value=await fixture({readRights:false})();for(const feature of [value.prompt.update,value.role.create,value.ordinaryStrategy.configure,value.ordinaryStrategy.publish]){assert.equal(feature.permissionAllowed,true);assert.equal(feature.delegated,true);assert.equal(feature.systemSupport,'connected');assert.equal(feature.available,false);assert.deepEqual(feature.reasons,['permission-missing']);}assert.deepEqual(value.targetAiAccounts,[]);
});

test('duty availability follows this original task action scope and human decision mode, without changing role facts',async()=>{
 const scoped=await fixture({duty:true,planActions:[]})();assert.equal(scoped.prompt.update.permissionAllowed,true);assert.equal(scoped.prompt.update.delegated,true);assert.equal(scoped.prompt.update.available,false);assert.deepEqual(scoped.prompt.update.reasons,['task-scope-missing']);assert.equal(scoped.prompt.read.available,true);
 const human=await fixture({duty:true,mode:'ai-human'})();assert.equal(human.prompt.update.available,false);assert.equal(human.prompt.update.confirmation,'human-console');assert.deepEqual(human.prompt.update.reasons,['human-required']);assert.equal(human.prompt.read.available,true);
});
test('a human card with only write delegation reports missing read delegation',async()=>{
 const value=await fixture({readDelegation:false})();for(const feature of [value.prompt.update,value.role.create]){assert.equal(feature.permissionAllowed,true);assert.equal(feature.delegated,true);assert.equal(feature.available,false);assert.deepEqual(feature.reasons,['delegation-missing']);}assert.equal(value.prompt.read.available,false);assert.equal(value.ordinaryStrategy.configure.available,true,'ordinary strategies use their existing boundary, not the role/prompt delegation');
});
test('qualified human preparation is available and duty write keeps its separate explicit-write semantics',async()=>{
 const human=await fixture()();assert.equal(human.prompt.update.available,true);assert.equal(human.role.create.available,true);assert.equal(human.ordinaryStrategy.configure.available,true);assert.equal(human.ordinaryStrategy.publish.available,true);assert.deepEqual(human.prompt.update.reasons,[]);assert.equal(human.prompt.update.confirmation,'operation-card');
 const duty=await fixture({readRights:false,readDelegation:false,duty:true})();assert.equal(duty.prompt.read.available,false);assert.equal(duty.prompt.update.permissionAllowed,true);assert.equal(duty.prompt.update.delegated,true);assert.equal(duty.prompt.update.available,true);assert.equal(duty.role.create.available,true);assert.deepEqual(duty.prompt.update.reasons,[]);assert.equal(duty.prompt.update.confirmation,'autonomous-tool');assert.equal(duty.modelConfiguration.confirmation,'human-console');
});
