import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {verifySharedSummaryWorkflow} from './chat-shared-summary-workflow.mjs';
import {prepareRoomSummaryShare} from '../src/chat-shared-summary-client.mjs';
test('explicit shared version, stable room message and current source lifecycle',async()=>verifySharedSummaryWorkflow());
test('selection preparation never uploads private unselected content',async()=>{
 const roomId=randomUUID(),first=randomUUID(),second=randomUUID(),content={generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'1',complete:true},
  fragments:[{id:first,kind:'personal-note',text:'Share this',sourceRefs:[]},{id:second,kind:'personal-note',text:'Private note',sourceRefs:[]}],keyMessageRefs:[]};
 const local={get:async()=>({roomId,localRevision:3,content})},selected=await prepareRoomSummaryShare({local,summaryId:randomUUID(),expectedLocalRevision:3,fragmentIds:[first],keyMessageRefs:[],room:{roomId,memberRevision:2}});
 assert.equal(selected.request.content.fragments.length,1);assert(!JSON.stringify(selected.request).includes('Private note'));assert.equal(selected.localRevision,3);assert.equal(content.fragments.length,2);
 await assert.rejects(prepareRoomSummaryShare({local,summaryId:randomUUID(),expectedLocalRevision:3,fragmentIds:[randomUUID()],keyMessageRefs:[],room:{roomId,memberRevision:2}}),/selection_changed/);
 await assert.rejects(prepareRoomSummaryShare({local,summaryId:randomUUID(),expectedLocalRevision:2,fragmentIds:[first],keyMessageRefs:[],room:{roomId,memberRevision:2}}),/selection_changed/);
});
