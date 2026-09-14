import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyNotificationHistoryCompletion } from './notification-history-completion-workflow.mjs';
import { projectRequesterHistory,requesterHistoryPreview } from '../src/domain/requester-history.mjs';

test('explicit public feedback, participant inbox, archive and paged requester facts work through actual HTTP clients',async()=>{
  console.log(JSON.stringify(await verifyNotificationHistoryCompletion()));
});
test('maximum permitted history source text and 1000 events per request fit the 1 MiB client page',()=>{
  const requesterId='GUID'+'A'.repeat(28),long='界'.repeat(1200),items=[];
  for(let i=0;i<20;i++){
    const state={request:{id:randomUUID(),title:'界'.repeat(160),problem:long,scope:long,attemptedApproaches:Array(8).fill(long)},requesterId,createdAt:2000000000,
      events:Array.from({length:1000},(_,j)=>({event:{id:randomUUID(),kind:j%2?'accept':'change-scope',summary:long},actorId:requesterId,at:2000000000+j}))};
    const item=requesterHistoryPreview(projectRequesterHistory(state,()=>true));assert.equal(item.facts.length,8);assert.equal(item.counts.acceptances,500);items.push(item);
  }
  const bytes=Buffer.byteLength(JSON.stringify({subjectId:requesterId,items,nextAfter:randomUUID(),summaryScope:'visible-page-only',counts:{requests:20,acceptances:10000,cancellations:0,disputes:0}}));
  assert.ok(bytes<1048576);console.log(JSON.stringify({event:'requester_history_maximum_projection',requests:20,sourceEvents:20000,bytes}));
});
