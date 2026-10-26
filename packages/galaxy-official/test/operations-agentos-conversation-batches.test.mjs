import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {coalescedConversationEvents} from "../src/operations/agentos/conversation-stream.mjs";

test('transport batching keeps full Unicode semantics and native indices without crossing tools or waiting for completion',async()=>{
 let closed=0;
 const values=[];
 const source=async function*(){yield{kind:'text',eventIndex:1,text:'完整'};yield{kind:'text',eventIndex:3,text:' 🌌'};yield{kind:'reset',eventIndex:4,phase:'working'};yield{kind:'text',eventIndex:6,text:'|项目|结果|\n|---|---|\n'};yield{kind:'text',eventIndex:8,text:'|当前|保留|'};yield{kind:'terminal',eventIndex:9,status:'COMPLETED'};};
 for await(const value of coalescedConversationEvents(source(),{onClose:()=>closed++}))values.push(value);
 assert.deepEqual(values.map(value=>value.kind),['text','reset','text','terminal']);assert.equal(values[0].text,'完整 🌌');assert.equal(values[0].eventIndex,3);assert.equal(values[2].eventIndex,8);assert.equal(values[2].text,'|项目|结果|\n|---|---|\n|当前|保留|');assert.equal(closed,1);
 const controller=new AbortController();let finalized=false;
 const slow=async function*(){try{yield{kind:'text',eventIndex:1,text:'第一段'};await delay(5000,undefined,{signal:controller.signal});yield{kind:'text',eventIndex:2,text:'后续'};}finally{finalized=true;}};
 const reader=coalescedConversationEvents(slow(),{windowMs:5,onClose:()=>controller.abort()});
 const begin=performance.now(),first=await reader.next();assert.equal(first.value.text,'第一段');assert(performance.now()-begin<1000,'a partial response is emitted before a silent model finishes');
 await reader.return();assert.equal(finalized,true,'closing the observer drains its pending iterator without cancelling any business effect');
 const large='不截断'.repeat(9000),pieces=[];for await(const item of coalescedConversationEvents((async function*(){yield{kind:'text',eventIndex:1,text:large};})(),{maxTextBytes:16}))pieces.push(item.text);
 assert.equal(pieces.join(''),large,'flush threshold never clips a large source event');
});
