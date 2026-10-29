import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createChatClient,chatSendRequestHash,chatEditRequestHash} from "../src/features/chat/chat-client.mjs";

function fixture(call){const rows=new Map(),calls=[];let current={subjectId:'GUID0000000000000000000000000001',bindingId:randomUUID(),generation:1};
 const configuration={api:{endpoint:'https://chat.example.org',snapshot:()=>({...current}),call:async(path,input)=>{calls.push({path,input});return call(path,input);}},
  getLocal:async key=>structuredClone(rows.get(key)),putLocal:async(key,value)=>rows.set(key,structuredClone(value)),
  updateLocal:async(key,update)=>{const next=update(structuredClone(rows.get(key)));rows.set(key,structuredClone(next));return structuredClone(next);}};
 return{rows,calls,configuration,client:()=>createChatClient(configuration),change:patch=>{current={...current,...patch};}};
}
const sendReceipt=(roomId,input,state,messageId)=>({roomId,...input,state,checkedAt:new Date().toISOString(),currentAccessGranted:false,contentReturned:false,
 othersReadStatus:'not-asserted',acceptedByRoom:state==='accepted',...(state==='accepted'?{messageId,revision:1,sentAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),historicalAcceptanceRecorded:true,archiveCleanupState:'not-requested'}:{})});

test('caller send ID and body-free journal locator survive loss; exact ACK retires only the original operation',async()=>{
 const roomId=randomUUID(),clientMessageId=randomUUID(),messageId=randomUUID();let original,locator;
 const f=fixture(async(path,input)=>{if(path.endsWith('/receipt'))return sendReceipt(roomId,input,'accepted',messageId);original=input;throw Error('lost HTTP response');});
 await assert.rejects(f.client().send(roomId,'Original selected text',{confirmed:true,clientMessageId,onJournal:async value=>{
  locator=value;assert.equal(f.calls.length,0);assert.equal(f.rows.get('chat-operation:'+roomId).input.clientMessageId,clientMessageId);}}),/lost HTTP/);
 assert.equal(locator.requestHash,await chatSendRequestHash(original));assert.equal(JSON.stringify(locator).includes(original.text),false);
 assert.equal((await f.client().resumePending(roomId)).state,'accepted');assert.equal(f.calls.filter(item=>item.path.endsWith('/send')).length,1);
 assert.equal((await f.client().receiptFor(roomId,locator)).exactOperationConfirmed,true);assert.equal(f.rows.get('chat-operation:'+roomId),null);
});

test('caller edit ID uses an exact body-free receipt after response loss and after local journal retirement',async()=>{
 const roomId=randomUUID(),messageId=randomUUID(),operationId=randomUUID(),editedAt=new Date().toISOString();let original,locator;
 const f=fixture(async(path,input)=>{if(path.endsWith('/operation-receipt'))return{roomId,...input,state:'acknowledged',messageId,revision:2,editedAt,currentAccessGranted:false,contentReturned:false};original=input;throw Error('lost edit response');});
 await assert.rejects(f.client().edit(roomId,messageId,{operationId,expectedRevision:1,text:'My exact correction'},{confirmed:true,onJournal:value=>{locator=value;}}),/lost edit/);
 assert.equal(original.operationId,operationId);assert.equal(locator.requestHash,await chatEditRequestHash(original));
 assert.equal((await f.client().resumePending(roomId)).state,'acknowledged');assert.equal(f.calls.filter(item=>item.path.endsWith('/edit')).length,1);
 assert.equal((await f.client().receiptFor(roomId,locator)).state,'acknowledged');assert.equal(JSON.stringify(locator).includes(original.text),false);
});

test('a confirmed business rejection blocks only automatic sends; exact reads and explicit same-ID retry remain',async()=>{
 const roomId=randomUUID(),clientMessageId=randomUUID(),messageId=randomUUID();let rejecting=true,accepted=false;
 const f=fixture(async(path,input)=>{if(path.endsWith('/receipt'))return sendReceipt(roomId,input,accepted?'accepted':'absent',messageId);
  if(rejecting)throw Object.assign(Error('chat_access_denied'),{code:'chat_access_denied',status:403,outcome:'rejected'});accepted=true;return{messageId,state:'accepted'};});
 await assert.rejects(f.client().send(roomId,'Keep this exact request',{confirmed:true,clientMessageId}),/chat_access_denied/);
 const before=await f.client().pending(roomId);
 for(let n=0;n<3;n++)await assert.rejects(f.client().resumePending(roomId),error=>error.code==='chat_operation_business_rejected');
 rejecting=false;await assert.rejects(f.client().resumePending(roomId),error=>error.code==='chat_operation_business_rejected');
 assert.equal(f.calls.filter(item=>item.path.endsWith('/send')).length,1);
 await f.client().retry(roomId,{confirmed:true});assert.equal(f.calls.filter(item=>item.path.endsWith('/send')).length,2);
 assert.deepEqual(f.calls.filter(item=>item.path.endsWith('/send')).map(item=>item.input),[before.input,before.input]);
});

test('confirmed absent edit conflict can stop local retry without clearing the original input or impersonating remote cancellation',async()=>{
 const roomId=randomUUID(),messageId=randomUUID(),operationId=randomUUID();let conflict=true;
 const f=fixture(async(path,input)=>{if(path.endsWith('/operation-receipt'))return{roomId,...input,state:'absent',currentAccessGranted:false,contentReturned:false};
  if(conflict)throw Object.assign(Error('chat_revision_conflict'),{code:'chat_revision_conflict',status:409,outcome:'rejected'});return{messageId,revision:3};});
 await assert.rejects(f.client().edit(roomId,messageId,{operationId,expectedRevision:1,text:'Retained my modification'},{confirmed:true}),/chat_revision_conflict/);
 const pending=await f.client().pending(roomId),locator={kind:'edit',operationId,requestHash:pending.requestHash};
 assert.equal((await f.client().receiptFor(roomId,locator)).exactOperationConfirmed,false);
 assert.equal((await f.client().stopRetry(roomId,{confirmed:true})).serverOperationCancelled,false);
 const stopped=(await f.client().stopped(roomId))[0];assert.equal(Object.hasOwn(stopped.input,'text'),false);assert.equal(stopped.input.operationId,operationId);
 conflict=false;await f.client().edit(roomId,messageId,{expectedRevision:2,text:pending.input.text},{confirmed:true});
 assert.equal(f.calls.filter(item=>item.path.endsWith('/edit')).length,2);assert.equal((await f.client().receiptFor(roomId,locator)).exactOperationConfirmed,false);
});

test('journal callback failure performs no network write and keeps the exact approved original recoverable',async()=>{
 const roomId=randomUUID(),clientMessageId=randomUUID(),messageId=randomUUID();
 const f=fixture(async(path,input)=>path.endsWith('/receipt')?sendReceipt(roomId,input,'absent',messageId):{messageId,state:'accepted'});
 await assert.rejects(f.client().send(roomId,'Retained after draft association failure',{confirmed:true,clientMessageId,onJournal:()=>{throw Error('local draft conflict');}}),/local draft conflict/);
 assert.equal(f.calls.length,0);assert.equal((await f.client().pending(roomId)).input.clientMessageId,clientMessageId);
 await f.client().resumePending(roomId);assert.equal(f.calls.filter(item=>item.path.endsWith('/send')).length,1);
});

test('directory and exact message context withhold late content after the same owner reconnects',async()=>{
 let resolve;const waiting=new Promise(done=>{resolve=done;}),f=fixture(()=>waiting),client=f.client(),roomId=randomUUID();
 const directory=client.directory(),context=client.context(roomId,randomUUID());f.change({generation:2});resolve({rooms:[],messages:[]});
 await assert.rejects(directory,/身份或连接已改变/);await assert.rejects(context,/身份或连接已改变/);
});

test('a started conversation journals one create and one original invitation, never accepting on behalf of the recipient',async()=>{
 const roomId=randomUUID(),operationId=randomUUID(),decisionId=randomUUID(),inviteeSubjectId='GUID0000000000000000000000000002';let lost=true;
 const f=fixture(async(path,input)=>{if(path.endsWith('/create'))return{roomId,revision:1};if(lost){lost=false;throw Error('lost invitation response');}return{decisionId:input.decisionId,state:'approved'};});
 await assert.rejects(f.client().startConversation({roomId,operationId,decisionId,inviteeSubjectId},{confirmed:true}),/lost invitation/);
 const pending=await f.client().pending(null);assert.equal(pending.input.title,'对话');assert.equal(pending.invitationInput.targetSubjectId,inviteeSubjectId);
 const result=await f.client().resumePending(null);assert.equal(result.invitation.state,'approved');
 assert.deepEqual(f.calls[0].input,f.calls[2].input);assert.deepEqual(f.calls[1].input,f.calls[3].input);assert.equal(f.calls.some(item=>item.path.endsWith('/accept')),false);
});
