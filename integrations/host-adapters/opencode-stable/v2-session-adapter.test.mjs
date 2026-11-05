import test from 'node:test';
import assert from 'node:assert/strict';
import {createV2SessionAdapter} from './v2-session-adapter.mjs';

test('V2 messages retain real source and selected archive follows every page', async()=>{
 const first={id:'msg_a',type:'user',text:'hello',time:{created:100}},second={id:'msg_b',type:'assistant',content:[{type:'text',text:'answer'}],time:{created:101,completed:102},model:{providerID:'p',modelID:'m'}};
 const calls=[];let listener;const context={ui:{router:{current:()=>({type:'session',sessionID:'ses_1'}),navigate:()=>{}}},data:{session:{message:{list:()=>[first,second]},get:()=>undefined,status:()=> 'idle'},location:{mcp:{server:{list:()=>[]}}},listen:fn=>(listener=fn,()=>{})},client:{message:{list:async input=>{calls.push(input);return input.cursor?{data:[second],cursor:{next:null}}:{data:[first],cursor:{next:'next'}};}}}};
 const adapter=createV2SessionAdapter(context);const messages=adapter.state.session.messages('ses_1');assert.equal(messages[1].v2Original,second);assert.equal(messages[1].role,'assistant');assert.equal(messages[1].time.completed,102);assert.deepEqual(adapter.state.part('msg_b'),[]);
 assert.deepEqual(await adapter.v2.syncMessages('ses_1'),[first,second]);assert.equal(calls.length,2);assert.equal((await adapter.client.session.message({sessionID:'ses_1',messageID:'msg_b'})).data.parts[0].text,'answer');
 let seen;adapter.event.on('session.idle',e=>seen=e);listener({details:{type:'session.execution.succeeded',data:{sessionID:'ses_1'}}});assert.equal(seen.properties.sessionID,'ses_1');adapter.closeData();
});
