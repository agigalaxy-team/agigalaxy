import test from 'node:test';
import assert from 'node:assert/strict';
import {applyConversationReceipt} from '../src/lib/workbench/conversation-turns.ts';
const old={runId:'old-run',operationId:'old-operation',status:'COMPLETED',content:'Completed answer',userInput:'Earlier question',createdAt:1,events:[],awaitingHuman:false};
const snapshot={domain:'overview',runs:[old]};
test('ACK and exact final receipt update only their own turn without replaying completed history',()=>{
 const accepted=applyConversationReceipt(snapshot,{operationId:'new-operation',runId:'new-run',state:'accepted'},'New question');
 assert.equal(accepted.runs[0],old);assert.equal(accepted.runs[1].status,'PENDING');assert.equal(accepted.runs[1].userInput,'New question');
 const final=applyConversationReceipt(accepted,{operationId:'new-operation',runId:'new-run',state:'COMPLETED',native:{...old,operationId:'new-operation',runId:'new-run',status:'COMPLETED',userInput:null,content:'New answer'}});
 assert.equal(final.runs.length,2);assert.equal(final.runs[0],old);assert.equal(final.runs[1].content,'New answer');assert.equal(final.runs[1].userInput,'New question');
});
test('unstarted and changed-context receipts cannot manufacture a turn; mismatched original receipts are rejected',()=>{
 assert.equal(applyConversationReceipt(snapshot,{operationId:'new-operation',runId:'new-run',state:'not-started'},'Question'),snapshot);
 assert.equal(applyConversationReceipt(snapshot,{operationId:'new-operation',runId:'new-run',state:'context-changed'},'Question'),snapshot);
 assert.throws(()=>applyConversationReceipt(snapshot,{operationId:'new-operation',runId:'new-run',native:{...old}}),/binding/);
});

test('timestamps keep same-run evidence and preserve explicit unknown',()=>{
 const initial=applyConversationReceipt(snapshot,{operationId:'new-operation',runId:'new-run',state:'accepted',sentAt:120},'Question');
 assert.equal(initial.runs[1].sentAt,120); assert.equal(initial.runs[1].completedAt,null);
 const running=applyConversationReceipt(initial,{operationId:'new-operation',runId:'new-run',native:{...old,operationId:'new-operation',runId:'new-run',status:'RUNNING',userInput:null}});
 assert.equal(running.runs[1].sentAt,120);
 const done=applyConversationReceipt(running,{operationId:'new-operation',runId:'new-run',native:{...old,operationId:'new-operation',runId:'new-run',status:'COMPLETED',sentAt:null,completedAt:130}});
 assert.equal(done.runs[1].sentAt,null); assert.equal(done.runs[1].completedAt,130);
 assert.throws(()=>applyConversationReceipt(done,{operationId:'new-operation',runId:'foreign-run'}),/binding/);
});
