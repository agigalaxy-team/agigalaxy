import test from 'node:test';
import assert from 'node:assert/strict';
import {v2WorkObservations} from './v2-work-observations.mjs';
const helpers={asTime:x=>x==null?undefined:String(x),content:text=>({excerpt:text}),short:(x,n)=>typeof x==='string'?x.slice(0,n):''};
test('V2 text and real tool call retain source without invented part IDs',()=>{
 const info={id:'msg_a',role:'assistant',time:{created:1,completed:4}};
 const raw={type:'assistant',content:[{type:'text',text:'hello'},{type:'tool',id:'call_a',name:'read',state:{status:'completed',content:[{type:'text',text:'result'}]},time:{created:2,completed:3}}]};
 const observations=v2WorkObservations(raw,info,helpers);assert.equal(observations[0].source.messageId,'msg_a');assert.equal(observations[0].source.partId,undefined);assert.equal(observations[1].details.callId,'call_a');assert.equal(observations[1].source.partId,undefined);assert.equal(observations[1].content.excerpt,'result');
});
