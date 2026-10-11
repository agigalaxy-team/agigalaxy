import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatClient,chatSendRequestHash } from '../../galaxy-web/src/chat-client.mjs';

function exactReceipt(roomId,input,state='accepted') { return {roomId,...input,state,checkedAt:new Date().toISOString(),currentAccessGranted:false,contentReturned:false,othersReadStatus:'not-asserted',acceptedByRoom:state==='accepted',
 ...(!['absent','conflict'].includes(state)?{messageId:crypto.randomUUID(),revision:1,sentAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),historicalAcceptanceRecorded:state!=='pending',archiveCleanupState:'not-requested'}:{})}; }

test('browser chat retains stable send and edit operations across lost replies and reload, without auto resending drafts', async () => {
  const rows = new Map(), calls = [], roomId = crypto.randomUUID(), messageId = crypto.randomUUID();
  let drop = true, accepted = false;
  const configuration = { getLocal: async key => structuredClone(rows.get(key)), putLocal: async (key, value) => rows.set(key, structuredClone(value)),
    updateLocal: async (key, updater) => atomicMap(rows, key, updater),
    api: { snapshot: () => ({ subjectId: 'test-viewer' }), call: async (path, input) => {
      calls.push({ path, input });
      if (path.endsWith('/receipt')) return exactReceipt(roomId,input,accepted?'accepted':'pending');
      if (drop) { drop = false; accepted = true; throw new Error('lost reply'); }
      return { messageId, state: 'accepted', revision: 2 };
    } } };
  let chat = createChatClient(configuration);
  await assert.rejects(chat.send(roomId, '只在确认后发出'), /确认/); assert.equal(calls.length, 0);
  await assert.rejects(chat.send(roomId, '需保留的原消息', { confirmed: true }), /lost reply/);
  const pending = await chat.pending(roomId); assert.equal(pending.input.text, '需保留的原消息');
  chat = createChatClient(configuration); assert.equal(calls.length, 1);
  await assert.rejects(chat.send(roomId, '不可悄悄变成第二条', { confirmed: true }), /上一次操作/);
  const receipt = await chat.retry(roomId, { confirmed: true }); assert.equal(receipt.state, 'accepted'); assert.equal(calls.filter(call => call.path.endsWith('/send')).length, 1);
  assert.equal(await chat.pending(roomId), null);
  drop = true;
  await assert.rejects(chat.edit(roomId, messageId, { expectedRevision: 1, text: '编辑后的内容' }, { confirmed: true }), /lost reply/);
  const firstEdit = calls.at(-1).input;
  chat = createChatClient(configuration); await chat.retry(roomId, { confirmed: true });
  assert.deepEqual(calls.at(-1).input, firstEdit); assert.equal(await chat.pending(roomId), null);
});

test('a legacy journal normalizes the old omitted replyTo and retains an original conflict without resending',async()=>{
 const f=continuityFixture(),input={clientMessageId:crypto.randomUUID(),text:'Legacy original bytes'},key=`chat-operation:${f.roomId}`;
 f.rows.set(key,{roomId:f.roomId,path:`/v2/chat/rooms/${f.roomId}/send`,input});
 f.configuration.api.call=async(path,query)=>{f.calls.push({path,input:query});return exactReceipt(f.roomId,query,'conflict');};
 const client=createChatClient(f.configuration);await assert.rejects(client.retry(f.roomId,{confirmed:true}),/chat_message_receipt_conflict/);
 const pending=await client.pending(f.roomId);assert.equal(pending.requestHash,await chatSendRequestHash({...input,replyTo:null}));assert.equal(f.calls.length,1);assert.equal(f.calls[0].input.requestHash,pending.requestHash);assert.equal(pending.input.text,input.text);
});

test('original receipt completion after reconnecting cannot clear its journal or resend',async()=>{
 const f=continuityFixture(),wait=deferred(),entered=deferred(),input={clientMessageId:crypto.randomUUID(),text:'Pending exact original',replyTo:null},key=`chat-operation:${f.roomId}`;
 f.rows.set(key,{roomId:f.roomId,path:`/v2/chat/rooms/${f.roomId}/send`,input,requestHash:await chatSendRequestHash(input)});
 f.configuration.api.call=async(_path,query)=>{entered.resolve(query);return wait.promise;};
 const client=createChatClient(f.configuration),pending=client.retry(f.roomId,{confirmed:true}),query=await entered.promise;f.switch({generation:2});wait.resolve(exactReceipt(f.roomId,query));
 await assert.rejects(pending,/身份或连接已改变/);assert.equal(f.writes.length,0);assert.equal(f.rows.get(key).input.clientMessageId,input.clientMessageId);
});

test('journal persistence completing after reconnect retains the operation and does not start a new send',async()=>{
 const f=continuityFixture(),persist=deferred(),entered=deferred();f.configuration.updateLocal=async(key,updater)=>{const next=atomicMap(f.rows,key,updater);entered.resolve();await persist.promise;return next;};
 const client=createChatClient(f.configuration),pending=client.send(f.roomId,'Saved original selected message',{confirmed:true});await entered.promise;f.switch({generation:2});persist.resolve();
 await assert.rejects(pending,/身份或连接已改变/);assert.equal(f.calls.length,0);assert.equal(f.rows.get(`chat-operation:${f.roomId}`).input.text,'Saved original selected message');
 assert.equal((await createChatClient(f.configuration).pending(f.roomId)).input.text,'Saved original selected message');
});

test('stopping local retry retains a body-free exact locator and only reconciles a late accepted receipt',async()=>{
 const f=continuityFixture(),input={clientMessageId:crypto.randomUUID(),text:'Explicit original private message',replyTo:null},key=`chat-operation:${f.roomId}`;let state='pending';
 f.rows.set(key,{roomId:f.roomId,path:`/v2/chat/rooms/${f.roomId}/send`,input});f.configuration.api.call=async(path,query)=>{f.calls.push({path,input:query});return exactReceipt(f.roomId,query,state);};
 const client=createChatClient(f.configuration);assert.equal((await client.stopRetry(f.roomId,{confirmed:true})).serverOperationCancelled,false);
 assert.equal(await client.pending(f.roomId),null);const original=(await client.stopped(f.roomId))[0];assert.equal(Object.hasOwn(original.input,'text'),false);assert.equal(original.requestHash,await chatSendRequestHash(input));
 assert.deepEqual(await createChatClient(f.configuration).stoppedRooms(),{roomIds:[f.roomId]});
 assert.equal(JSON.stringify(f.rows.get('chat-stopped-room-index')).includes(input.text),false);
 assert.equal((await client.reconcileStopped(f.roomId,input.clientMessageId)).localRetryStopped,true);assert.equal(f.calls.every(x=>x.path.endsWith('/receipt')),true);
 state='accepted';assert.equal((await client.reconcileStopped(f.roomId,input.clientMessageId)).state,'accepted');assert.equal(await client.pending(f.roomId),null);assert.equal((await client.stopped(f.roomId))[0].receipt.state,'accepted');
});

test('stopped room index isolates its owner and withholds a late local read after binding changes',async()=>{
 const f=continuityFixture(),owner=f.configuration.api.snapshot();
 f.rows.set('chat-stopped-room-index',{owner:{subjectId:owner.subjectId,endpoint:f.configuration.api.endpoint},roomIds:[f.roomId]});
 f.switch({subjectId:'different-owner'});await assert.rejects(createChatClient(f.configuration).stoppedRooms(),/回执记录不可用/);
 f.switch({subjectId:owner.subjectId});const entered=deferred(),wait=deferred();f.configuration.getLocal=async()=>{entered.resolve();return wait.promise;};
 const client=createChatClient(f.configuration),result=client.stoppedRooms();await entered.promise;f.switch({generation:2});
 wait.resolve(f.rows.get('chat-stopped-room-index'));await assert.rejects(result,/身份或连接已改变/);assert.equal(f.calls.length,0);
});

test('two chat instances preserve both stopped room indexes without storing draft content',async()=>{
 const f=continuityFixture(),second=crypto.randomUUID(),client1=createChatClient(f.configuration),client2=createChatClient(f.configuration);
 for(const roomId of [f.roomId,second])f.rows.set(`chat-operation:${roomId}`,{roomId,path:`/v2/chat/rooms/${roomId}/send`,input:{clientMessageId:crypto.randomUUID(),text:'Private original '+roomId,replyTo:null}});
 await Promise.all([client1.stopRetry(f.roomId,{confirmed:true}),client2.stopRetry(second,{confirmed:true})]);
 assert.deepEqual(new Set((await client1.stoppedRooms()).roomIds),new Set([f.roomId,second]));
 assert.equal(JSON.stringify(f.rows.get('chat-stopped-room-index')).includes('Private original'),false);assert.equal(f.calls.length,0);
});

function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};}
function atomicMap(rows,key,updater){const next=updater(structuredClone(rows.get(key)));if(next&&typeof next.then==='function')throw Error('synchronous_update_required');rows.set(key,structuredClone(next));return structuredClone(next);}
function continuityFixture(){const rows=new Map(),calls=[],writes=[],roomId=crypto.randomUUID();let current={subjectId:'test-owner',bindingId:crypto.randomUUID(),generation:1};
 const api={endpoint:'https://chat.example.org',snapshot:()=>({...current}),call:async(path,input)=>{calls.push({path,input});return{state:'accepted'};}};
 const configuration={api,getLocal:async key=>structuredClone(rows.get(key)),putLocal:async(key,value)=>{writes.push({key,value});rows.set(key,structuredClone(value));},
 updateLocal:async(key,updater)=>{const next=atomicMap(rows,key,updater);writes.push({key,value:next});return next;}};
 return{configuration,rows,calls,writes,roomId,switch:patch=>{current={...current,...patch};}};
}

test('pending storage completion cannot return private operations after a same-identity binding generation change',async()=>{
 const f=continuityFixture(),wait=deferred(),record={roomId:f.roomId,path:`/v2/chat/rooms/${f.roomId}/send`,input:{clientMessageId:crypto.randomUUID(),text:'Private pending body',replyTo:null}};
 f.configuration.getLocal=async()=>wait.promise;const client=createChatClient(f.configuration),pending=client.pending(f.roomId);f.switch({generation:2});wait.resolve(record);
 await assert.rejects(pending,/身份或连接已改变/);assert.equal(f.calls.length,0);
});

test('owner changes during the initial journal read prevent writing the old message into the new identity',async()=>{
 const f=continuityFixture(),wait=deferred();f.configuration.getLocal=async()=>wait.promise;const client=createChatClient(f.configuration),operation=client.send(f.roomId,'Old identity selected message',{confirmed:true});
 f.switch({subjectId:'different-owner'});wait.resolve(null);await assert.rejects(operation,/身份或连接已改变/);assert.equal(f.writes.length,0);assert.equal(f.calls.length,0);
});

test('journal clear completion cannot return an old accepted operation after reconnecting the same owner',async()=>{
 const f=continuityFixture(),clearing=deferred(),entered=deferred();f.configuration.updateLocal=async(key,updater)=>{const next=atomicMap(f.rows,key,updater);if(next===null){entered.resolve();await clearing.promise;}return next;};
 const client=createChatClient(f.configuration),operation=client.send(f.roomId,'Original accepted message',{confirmed:true});await entered.promise;f.switch({bindingId:crypto.randomUUID(),generation:2});clearing.resolve();
 await assert.rejects(operation,/身份或连接已改变/);assert.equal(f.calls.length,1);
});
