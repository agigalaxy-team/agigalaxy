import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeConversationDisplayRuns,nativeConversationPreviousAttempts} from '../src/lib/agentos-client.ts';

test('regeneration presents one logical question while unrelated identical questions remain distinct',()=>{
 const failed={runId:'first',userInput:'核对当前情况',status:'REGENERATED'};
 const recovered={runId:'second',userInput:'核对当前情况',status:'COMPLETED',regeneratedFrom:'first'};
 assert.deepEqual(nativeConversationDisplayRuns([failed,recovered]),[recovered]);
 const again={runId:'third',userInput:'核对当前情况',status:'COMPLETED'};
 assert.deepEqual(nativeConversationDisplayRuns([recovered,again]),[recovered,again]);
 assert.deepEqual(nativeConversationDisplayRuns([failed]),[failed]);
 const retry={runId:'fourth',userInput:'核对当前情况',status:'RUNNING',regeneratedFrom:'second'};
 assert.deepEqual(nativeConversationDisplayRuns([failed,recovered,retry]),[retry]);
 assert.deepEqual(nativeConversationPreviousAttempts([failed,recovered,retry],retry),[failed,recovered]);
 assert.deepEqual(nativeConversationPreviousAttempts([retry],retry),[]);
 const cycle={...failed,regeneratedFrom:'fourth'};
 assert.deepEqual(nativeConversationPreviousAttempts([cycle,recovered,retry],retry),[cycle,recovered]);
});
