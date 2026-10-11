import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatClient} from '../src/chat-client.mjs';

const receipt=(roomId,input,state)=>({roomId,...input,state,checkedAt:new Date().toISOString(),currentAccessGranted:false,contentReturned:false,
 othersReadStatus:'not-asserted',acceptedByRoom:state==='accepted',...(['absent','conflict'].includes(state)?{}:{messageId:crypto.randomUUID(),revision:1,
 sentAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),historicalAcceptanceRecorded:state!=='pending',archiveCleanupState:'not-requested'})});
function fixture(){
 const rows=new Map(),calls=[],roomId=crypto.randomUUID();let current={subjectId:'owner',bindingId:crypto.randomUUID(),generation:1},accepted=false,drop=true;
 const api={endpoint:'https://chat.example.org',snapshot:()=>({...current}),call:async(path,input)=>{
  calls.push({path,input});if(path.endsWith('/receipt'))return receipt(roomId,input,accepted?'accepted':'absent');
  if(drop){drop=false;throw Error('offline');}accepted=true;return{state:'accepted',messageId:crypto.randomUUID()};}};
 const options={api,getLocal:async key=>structuredClone(rows.get(key)),putLocal:async(key,value)=>rows.set(key,structuredClone(value)),
  updateLocal:async(key,update)=>{const value=update(structuredClone(rows.get(key)));rows.set(key,structuredClone(value));return structuredClone(value);}};
 return{rows,calls,roomId,api,client:()=>createChatClient(options),accepted:()=>{accepted=true;},change:()=>{current={...current,generation:current.generation+1};}};
}
test('background recovery continues the exact approved send, never a local draft or a new message',async()=>{
 const f=fixture(),client=f.client();
 f.rows.set('chat-draft:'+f.roomId,'A different unsent draft');
 assert.deepEqual(await client.resumePending(f.roomId),{state:'none'});assert.equal(f.calls.length,0);
 await assert.rejects(client.send(f.roomId,'Approved original',{confirmed:true}),/offline/);
 const original=(await client.pending(f.roomId)).input;
 assert.equal((await client.resumePending(f.roomId)).state,'accepted');
 assert.deepEqual(f.calls.filter(item=>item.path.endsWith('/send')).map(item=>item.input),[original,original]);
 assert.equal(await client.pending(f.roomId),null);assert.equal(f.rows.get('chat-draft:'+f.roomId),'A different unsent draft');
});
test('accepted unknown sends resolve without resending; stopped messages are queried automatically without body or resend',async()=>{
 const f=fixture(),client=f.client();
 await assert.rejects(client.send(f.roomId,'Accepted but response lost',{confirmed:true}),/offline/);f.accepted();
 assert.equal((await client.resumePending(f.roomId)).state,'accepted');assert.equal(f.calls.filter(item=>item.path.endsWith('/send')).length,1);
 f.api.call=async(path,input)=>{f.calls.push({path,input});if(path.endsWith('/receipt'))return receipt(f.roomId,input,'accepted');throw Error('offline');};
 await assert.rejects(client.send(f.roomId,'Stopped original',{confirmed:true}),/offline/);
 await client.stopRetry(f.roomId,{confirmed:true});const original=(await client.stopped(f.roomId))[0];
 assert.equal(Object.hasOwn(original.input,'text'),false);
 const result=await client.reconcileStoppedAll();assert.equal(result[0].receipt.state,'accepted');
 assert.equal((await client.resumePending(f.roomId)).state,'none');assert.equal(f.calls.filter(item=>item.path.endsWith('/send')).length,2);
 const count=f.calls.length;await client.reconcileStoppedAll();assert.equal(f.calls.length,count,'Confirmed stopped records do not keep polling');
});
test('automatic recovery fences a changed session while awaiting the exact original receipt',async()=>{
 const f=fixture(),client=f.client();await assert.rejects(client.send(f.roomId,'Original',{confirmed:true}),/offline/);
 let resolve,entered;const started=new Promise(r=>{entered=r;});f.api.call=async()=>{entered();return new Promise(r=>{resolve=r;});};
 const recovering=client.resumePending(f.roomId);await started;f.change();const original=f.rows.get('chat-operation:'+f.roomId);
 resolve(receipt(f.roomId,{clientMessageId:original.input.clientMessageId,requestHash:original.requestHash},'accepted'));
 await assert.rejects(recovering,/身份或连接已改变/);assert.equal(f.rows.get('chat-operation:'+f.roomId).input.text,'Original');
});
test('latest history uses current authorization and rejects an ambiguous forward selection',async()=>{
 const f=fixture(),client=f.client();f.api.call=async(path,input)=>{f.calls.push({path,input});return{messages:[],previous:null,after:'0',scannedThrough:'0',next:null};};
 await client.latestHistory(f.roomId,{before:'23',limit:10});
 assert.deepEqual(f.calls[0].input,{after:'0',limit:10,latest:true,before:'23'});
 await assert.rejects(async()=>client.latestHistory(f.roomId,{before:'0'}));
});
