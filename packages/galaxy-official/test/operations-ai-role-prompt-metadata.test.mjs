import test from 'node:test';
import assert from 'node:assert/strict';
import {OperationsAiRunsService} from '../src/operations-ai-runs.mjs';

test('actual native prompt version metadata is closed, conversation-bound and carries no role body',async()=>{
 const cid='11111111-1111-4111-8111-111111111111',raw={runId:'native-metadata',conversationId:cid,domain:'governance',sessionId:'session-one',componentId:'galaxy-conversation-governance',componentType:'agent',state:'COMPLETED',rolePromptVersion:7,boundaryVersion:'galaxy-conversation-boundary-v3',promptVersion:'galaxy-conversation-v2',prompt:'PRIVATE_WORK_REQUIREMENTS'};
 let bound=true;const checked=[];
 const service=new OperationsAiRunsService({authority:{db:{query:async()=>({rows:bound?[{id:cid,domain:'governance',session_id:'session-one',display_name:'管理者'}]:[]})},endpoint:'official',now:()=>1000,human:async(_actor,{action})=>{checked.push(action);}},client:{runs:async()=>({items:[raw],total:1})}});
 let value=(await service.runs({})).items[0];assert.equal(value.rolePromptVersion,7);assert.equal(value.boundaryVersion,'galaxy-conversation-boundary-v3');assert.equal(JSON.stringify(value).includes('PRIVATE_WORK_REQUIREMENTS'),false);assert.deepEqual(checked,['audit.read','audit.read']);
 bound=false;value=(await service.runs({})).items[0];assert.equal(value.rolePromptVersion,null);assert.equal(value.boundaryVersion,null);
 bound=true;raw.rolePromptVersion=3.5;raw.boundaryVersion='caller-defined-boundary';value=(await service.runs({})).items[0];assert.equal(value.rolePromptVersion,null);assert.equal(value.boundaryVersion,null);
});
