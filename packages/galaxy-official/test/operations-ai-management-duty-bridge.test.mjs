import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOperationsAgentOsDutyTools} from '../src/operations-agentos-duty-tools.mjs';

// Bridge-only assertions. Full WeakMap, current-role, delegation, SQL and
// version checks are exercised by operations-ai-prompt-management.test.mjs.
function fixture(){
 const task={id:randomUUID(),ai_account_id:randomUUID()},actor={taskId:task?.id,aiAccountId:task?.ai_account_id},operationId=randomUUID(),target=randomUUID();
 const calls={save:0,get:0,read:0},args={aiAccountId:target,expectedRevision:4,expectedPromptVersion:2,prompt:'Closed role work requirements.'};
 const saved={operationId,delegationVersion:7,prompt:{aiAccountId:target,configId:randomUUID(),revision:5,promptVersion:3},recordedAt:'2026-10-26T00:00:00Z'};
 const permissions={async delegatedPrompt(_actor,input){assert.equal(input.aiAccountId,target);calls.read++;return{availability:'available',prompt:'Authorized source only.'};},async delegatedPromptSave(_actor,input){assert.equal(input.operationId,operationId);calls.save++;return saved;},async delegatedManagementOperation(_actor,id,input){assert.equal(id,operationId);assert.equal(input.kind,'prompt-save');assert.deepEqual(input.input,{...args,operationId});calls.get++;return{state:'recorded',result:saved};}};
 const execute=createOperationsAgentOsDutyTools({authority:{acceptsDuty:value=>value===actor},permissions});
 return{task,actor,operationId,target,args,calls,saved,permissions,execute};
}

test('prompt-only delegated read does not require the role directory and durable writer returns metadata only',async()=>{
 const f=fixture();await f.execute({...f,tool:'read-ai-delegation',arguments:{aiAccountId:f.target}});assert.equal(f.calls.read,1);
 const result=await f.execute({...f,tool:'manage-ai-prompt',arguments:f.args});assert.equal(f.calls.save,1);assert.equal(result.state,'completed');assert.equal(result.receipt.promptVersion,3);assert.equal(result.businessReceipt.targetId,f.target);assert.equal(result.businessReceipt.basis,'persisted-domain-operation-receipt');assert.equal(JSON.stringify(result).includes(f.args.prompt),false);
});

test('an accepted or uncertain original management call only reads its original operation and never writes again',async()=>{
 const f=fixture(),result=await f.execute({...f,tool:'manage-ai-prompt',arguments:f.args,reconcile:true});assert.equal(result.state,'completed');assert.equal(f.calls.save,0);assert.equal(f.calls.get,1);
 f.permissions.delegatedManagementOperation=async()=>({state:'not-recorded'});
 const unknown=await f.execute({...f,tool:'manage-ai-prompt',arguments:f.args,reconcile:true});assert.equal(unknown.effectState,'unknown');assert.equal(unknown.businessReceipt.state,'unknown');assert.equal(f.calls.save,0);
});

test('read revocation after an uncertain attempt is not interpreted as absence or a new write',async()=>{
 const f=fixture();f.permissions.delegatedManagementOperation=async()=>{throw Object.assign(Error('Current read withdrawn'),{code:'operations_permission_denied',status:403});};
 await assert.rejects(f.execute({...f,tool:'manage-ai-prompt',arguments:f.args,reconcile:true}),{code:'operations_permission_denied'});assert.equal(f.calls.save,0);
});

test('forged authority/original IDs and mismatched prompt receipts cannot manufacture completed business results',async()=>{
 const f=fixture();for(const injection of [{operationId:randomUUID()},{actor:{}},{role:'administrator'}])await assert.rejects(f.execute({...f,tool:'manage-ai-prompt',arguments:{...f.args,...injection}}),{code:'invalid_operations_autonomy_request'});
 f.saved.prompt.promptVersion=99;await assert.rejects(f.execute({...f,tool:'manage-ai-prompt',arguments:f.args}),{code:'operations_autonomy_original_receipt_unknown'});
});
