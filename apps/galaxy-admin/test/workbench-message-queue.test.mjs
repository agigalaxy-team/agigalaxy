import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyMessageQueue,enqueueMessage,reserveMessage,markMessageAttempted,settleMessage,restoreUnattempted,parseMessageQueue,queueLaneMatches,bindProvisionalLane,pauseMessageLane,resumeMessageLane,editQueuedMessage,removeQueuedMessage,returnBusyMessage,markBusyLaneReady} from '../src/lib/workbench/workbench-message-queue.ts';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const item=(n,domain='overview',conversationId=id(100),taskId=null)=>({id:id(n),domain,conversationId,taskId,text:'message '+n,enqueuedAt:n});

test('FIFO editing and cancellation never change another item or original scope',()=>{
 let s=emptyMessageQueue();s=enqueueMessage(s,item(1));s=enqueueMessage(s,item(2));s=enqueueMessage(s,item(3));
 s=editQueuedMessage(s,id(1),'edited');s=removeQueuedMessage(s,id(2));assert.deepEqual(s.items.map(x=>x.id),[id(1),id(3)]);assert.equal(s.items[0].text,'edited');
 assert.equal(queueLaneMatches(s.items[0],'overview',id(100),null),true);assert.equal(queueLaneMatches(s.items[0],'governance',id(100),null),false);assert.equal(queueLaneMatches(s.items[0],'overview',id(101),null),false);assert.equal(queueLaneMatches(s.items[0],'overview',id(100),id(9)),false);
 s=reserveMessage(s,id(1),id(200));assert.equal(s.active[0].item.text,'edited');assert.equal(s.items[0].id,id(3));
 s=markMessageAttempted(s,id(200));s=settleMessage(s,id(200));assert.equal(s.items[0].id,id(3));
});
test('reload restores only provably unattempted reservations and never requeues unknown original operations',()=>{
 let s=reserveMessage(enqueueMessage(emptyMessageQueue(),item(1)),id(1),id(200));
 assert.equal(restoreUnattempted(parseMessageQueue(JSON.stringify(s))).items[0].id,id(1));
 s=markMessageAttempted(s,id(200));const recovered=restoreUnattempted(parseMessageQueue(JSON.stringify(s)));assert.equal(recovered.active[0].operationId,id(200));assert.equal(recovered.items.length,0);
 s=settleMessage(recovered,id(200),true);assert.equal(s.items[0].needsReview,true);assert.throws(()=>reserveMessage(s,id(1),id(201)));s=editQueuedMessage(s,id(1),'safe edit');assert.equal(reserveMessage(s,id(1),id(201)).active[0].attempted,false);
});
test('reject malformed, duplicate and foreign journal data',()=>{
 assert.throws(()=>parseMessageQueue(JSON.stringify({items:[item(1),item(1)],active:[]})));
 assert.throws(()=>parseMessageQueue(JSON.stringify({items:[],active:[{operationId:id(8),item:{...item(1),taskId:'foreign'},attempted:true,position:0}]})));
});
test('other lane remains independent while original unknown keeps its original operation',()=>{
 let s=enqueueMessage(enqueueMessage(emptyMessageQueue(),item(1)),item(2,'governance',id(101)));
 s=markMessageAttempted(reserveMessage(s,id(1),id(200)),id(200));s=reserveMessage(s,id(2),id(201));
 assert.equal(s.active.length,2);assert.equal(s.active[0].operationId,id(200));assert.equal(s.active[0].attempted,true);
 const restored=restoreUnattempted(parseMessageQueue(JSON.stringify(s)));assert.equal(restored.active.length,1);assert.equal(restored.active[0].operationId,id(200));assert.equal(restored.items[0].id,id(2));
});
test('first conversation binds queued messages only to the proven original operation',()=>{
 let s=enqueueMessage(enqueueMessage(emptyMessageQueue(),item(1,'overview',null)),item(2,'overview',null));
 s=reserveMessage(s,id(1),id(200));assert.equal(s.items[0].bootstrapOperationId,id(200));
 assert.throws(()=>bindProvisionalLane(s,id(200),id(100)));
 s=markMessageAttempted(s,id(200));s=enqueueMessage(s,item(3,'overview',null));assert.equal(s.items[1].bootstrapOperationId,id(200));
 s=bindProvisionalLane(s,id(200),id(100));assert.deepEqual(s.items.map(x=>x.conversationId),[id(100),id(100)]);assert.equal(s.active[0].item.conversationId,id(100));
 s=settleMessage(s,id(200));assert.equal(reserveMessage(s,id(2),id(201)).active[0].item.id,id(2));
});
test('unattempted bootstrap restore removes obsolete operation anchor',()=>{
 let s=enqueueMessage(enqueueMessage(emptyMessageQueue(),item(1,'overview',null)),item(2,'overview',null));s=reserveMessage(s,id(1),id(200));s=restoreUnattempted(s);assert.equal(s.items[0].bootstrapOperationId,undefined);assert.equal(s.items[1].bootstrapOperationId,undefined);
 s=reserveMessage(s,id(1),id(201));assert.equal(s.items[0].bootstrapOperationId,id(201));
});
test('failed or cancelled original pauses only its lane until explicit continuation',()=>{
 let s=enqueueMessage(enqueueMessage(emptyMessageQueue(),item(1)),item(2));s=markMessageAttempted(reserveMessage(s,id(1),id(200)),id(200));s=pauseMessageLane(s,id(200));
 assert.equal(s.paused[0].operationId,id(200));assert.throws(()=>reserveMessage(s,id(2),id(201)));
 s=enqueueMessage(s,item(3,'governance',id(101)));s=reserveMessage(s,id(3),id(202));assert.equal(s.active[0].operationId,id(202));
 s=resumeMessageLane(s,s.paused[0]);s=reserveMessage(s,id(2),id(201));assert.equal(s.active[1].operationId,id(201));
});


test('a definite busy rejection restores FIFO and retains a blocked lane across reload',()=>{
 let s=enqueueMessage(enqueueMessage(emptyMessageQueue(),item(1,'overview',null)),item(2,'overview',null));
 s=markMessageAttempted(reserveMessage(s,id(1),id(200)),id(200));s=returnBusyMessage(s,id(200),id(300),id(100));
 assert.deepEqual(s.items.map(x=>x.id),[id(1),id(2)]);assert.equal(s.active.length,0);assert.equal(s.items[0].needsReview,undefined);assert.equal(s.items[1].bootstrapOperationId,undefined);assert.equal(s.busy[0].ready,false);
 s=parseMessageQueue(JSON.stringify(s));s=markBusyLaneReady(s,s.busy[0],id(100));assert.equal(s.busy[0].observedConversationId,id(100));
 assert.equal(s.items[0].reservedOperationId,id(200));assert.throws(()=>reserveMessage(s,id(1),id(201)));s=reserveMessage(s,id(1),id(200));assert.equal(s.busy.length,0);assert.equal(s.active[0].item.bootstrapOperationId,id(200));assert.equal(s.items[0].bootstrapOperationId,id(200));
});

test('editing a definitely unadmitted message discards its frozen operation identity',()=>{let s=markMessageAttempted(reserveMessage(enqueueMessage(emptyMessageQueue(),item(1)),id(1),id(200)),id(200));s=returnBusyMessage(s,id(200),id(300),id(100));s=editQueuedMessage(s,id(1),'changed');assert.equal(s.items[0].reservedOperationId,undefined);assert.equal(reserveMessage(s,id(1),id(201)).active[0].operationId,id(201));});
