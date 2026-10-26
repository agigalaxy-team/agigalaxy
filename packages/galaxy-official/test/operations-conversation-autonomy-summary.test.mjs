import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationSummary} from "../src/operations/agentos/conversations.mjs";
import {aiWorkCapabilities} from '../src/shared/operations-ai-work-capabilities.mjs';

const taskId='02f8bc15-aa57-41ce-b82c-d3cc8c250975';
const snapshot=()=>({checkedAt:123,readExpiresAt:153,availability:{ai:'available'},autonomy:{checkedAt:123,readExpiresAt:153,summary:{enabledAccounts:0,healthyAccounts:0,businessCompleted:0,unknown:null,secret:'DO_NOT_FORWARD'},accounts:[{domain:'overview',health:'pending',config:{enabled:false,prompt:'DO_NOT_FORWARD'}}],recentTasks:[{id:taskId,domain:'overview',source:'workbench',state:'completed',businessState:'not-started',title:'DO_NOT_FORWARD',summary:'DO_NOT_FORWARD',updatedAt:'2026-10-26T00:00:00Z',configuration:{secret:'DO_NOT_FORWARD'}},{id:'not-a-task',domain:'overview',state:'completed',source:'workbench'}],humanTasks:[],exceptions:[]}});
test('workbench automatic-operation snapshot requires current intersected permission and source availability',()=>{
 const value=snapshot(),denied=conversationSummary(value,'overview',[]);
 assert.equal(denied.availability.autonomy,'not-authorized');assert.equal(denied.autonomy,undefined);
 value.availability.ai='unavailable';const unavailable=conversationSummary(value,'overview',['autonomy.read']);
 assert.equal(unavailable.availability.autonomy,'unavailable');assert.equal(unavailable.autonomy,undefined);
 assert.deepEqual(aiWorkCapabilities('messaging',[]).queryPermissions,[]);
 assert.deepEqual(aiWorkCapabilities('messaging',['autonomy.read']).queryPermissions,['autonomy.read']);
});
test('workbench automatic-operation snapshot retains true zero and unknown with closed task metadata',()=>{
 const result=conversationSummary(snapshot(),'overview',['autonomy.read']);
 assert.equal(result.availability.autonomy,'available');assert.equal(result.autonomy.summary.businessCompleted,0);assert.equal(result.autonomy.summary.unknown,null);
 assert.equal(result.autonomy.accounts[0].enabled,false);assert.equal(result.autonomy.recentTasks.length,1);
 assert.equal(result.autonomy.recentTasks[0].href,'/admin/operations/ai-runs?task='+taskId);
 assert.equal(JSON.stringify(result).includes('DO_NOT_FORWARD'),false);assert.equal(JSON.stringify(result).includes('not-a-task'),false);
});
