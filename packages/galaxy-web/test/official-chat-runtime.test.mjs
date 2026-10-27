import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfficialChatRuntime} from "../src/features/chat/official-chat-runtime.mjs";
import {chatSendSchema} from '../../galaxy-official/src/shared/chat-schema.mjs';

function fixture(){
 const endpoint='https://official.example.org',rows=new Map(),calls=[];let epoch=1;
 const sessionFor=(id=randomUUID())=>({state:'signed-in',account:{id},csrfToken:randomUUID(),expiresAt:Math.floor(Date.now()/1000)+3600});
 let session=sessionFor();
 const base={getLocal:async(key,owner)=>structuredClone(rows.get(owner+':'+key)),putLocal:async(key,value,owner)=>{rows.set(owner+':'+key,structuredClone(value));},updateLocal:async(key,fn,owner)=>{const value=fn(structuredClone(rows.get(owner+':'+key)));rows.set(owner+':'+key,structuredClone(value));return structuredClone(value);}};
 const client={call:async(path,input,options)=>{calls.push({path,input,accountId:options.session.account.id});return path.endsWith('/create')?{roomId:input.roomId}:path.endsWith('/propose')?{decisionId:input.decisionId}:{state:'accepted',messageId:randomUUID()};},transfer:async()=>new Response(new Uint8Array([1,2,3]),{headers:{'X-Galaxy-Content-Sha256':'synthetic'}})};
 const create=()=>createOfficialChatRuntime({base,endpoint,client,getSession:()=>session,getGeneration:()=>epoch});
 return{endpoint,rows,calls,client,create,current:()=>session,switchTo:value=>{session=value;epoch++;},sessionFor};
}
test('website chat uses the actual account session and an account-isolated atomic draft journal',async()=>{
 const f=fixture(),runtime=f.create(),account=f.current().account.id,other=f.sessionFor();
 await runtime.updateLocal('chat-draft:one',()=>({text:'当前账户的输入'}));
 assert.equal((await runtime.getLocal('chat-draft:one')).text,'当前账户的输入');
 const started=await runtime.chat.startConversation({inviteeSubjectId:'account:'+other.account.id},{confirmed:true});
 assert.ok(started.room.roomId);assert.equal(f.calls.length,2);assert.ok(f.calls.every(row=>row.accountId===account));
 assert.ok([...f.rows.keys()].every(key=>key.startsWith('account:'+account+':')));
 assert.equal(runtime.api.snapshot().subjectId,'account:'+account);
 assert.equal((await runtime.status()).identity,null,'the adapter never claims a local Galaxy identity');
 assert.throws(()=>runtime.getLocal('chat-draft:one','account:'+other.account.id),/official_account_changed/);
});
test('a pending account operation cannot revive across A to B to A or clear another account draft',async()=>{
 const f=fixture(),runtime=f.create(),a=f.current(),lease=runtime.receiptStatus.captureLease();
 let release;f.client.call=()=>new Promise(resolve=>{release=resolve;});
 const operation=runtime.api.call('/v2/chat/rooms/query',{});f.switchTo(f.sessionFor());f.switchTo(a);release({rooms:[]});
 await assert.rejects(operation,/账户会话已变化/);assert.throws(lease.assertCurrent,/账户会话已变化/);
 const fresh=f.create();await fresh.updateLocal('chat-draft:two',()=>({text:'新一页'}));assert.equal((await fresh.getLocal('chat-draft:two')).text,'新一页');
});
test('a selected file can be sent without invented text, while empty messages remain invalid',()=>{
 assert.equal(chatSendSchema.safeParse({clientMessageId:randomUUID(),text:''}).success,false);
 assert.equal(chatSendSchema.safeParse({clientMessageId:randomUUID(),text:'',attachments:[{id:randomUUID(),sha256:'a'.repeat(64)}]}).success,true);
});

test('an unverified network session stops new and late chat requests while retaining its own local draft',async()=>{
 const f=fixture();let verified=f.current();
 const runtime=createOfficialChatRuntime({base:{getLocal:async key=>f.rows.get(key),putLocal:async(key,value)=>{f.rows.set(key,value);},updateLocal:async(key,fn)=>{const value=fn(f.rows.get(key));f.rows.set(key,value);return value;}},endpoint:f.endpoint,client:f.client,getSession:f.current,getNetworkSession:()=>verified});
 verified=null;await runtime.updateLocal('draft',()=>({text:'离线时自己的输入'}));
 await assert.rejects(runtime.api.call('/v2/chat/rooms/query',{}),{code:'official_account_unavailable'});assert.equal(f.calls.length,0);
 assert.equal((await runtime.getLocal('draft')).text,'离线时自己的输入');
 verified=f.current();let release;f.client.call=()=>new Promise(resolve=>{release=resolve;});
 const pending=runtime.api.call('/v2/chat/rooms/query',{});verified=null;release({rooms:[]});
 await assert.rejects(pending,{code:'official_account_unavailable'});
 verified=f.current();f.client.call=async()=>({rooms:[]});assert.deepEqual(await runtime.api.call('/v2/chat/rooms/query',{}),{rooms:[]});
});


test('shared Query deduplicates private-chat reads, reuses valid pages on return and rechecks receipts independently',async()=>{
 const {QueryClient}=await import('@tanstack/react-query');
 const f=fixture(),query=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
 const key=(...parts)=>['galaxy',f.endpoint,'web',f.current().account.id,'chat',...parts];
 const make=()=>createOfficialChatRuntime({base:{getLocal:async()=>null,putLocal:async()=>{},updateLocal:async()=>null},endpoint:f.endpoint,client:f.client,getSession:f.current,query,queryKey:key});
 const room=randomUUID(),path='/v2/chat/rooms/'+room+'/history';let reads=0;
 f.client.call=async route=>{reads++;return route.endsWith('/history')?{messages:[],readExpiresAt:Math.floor(Date.now()/1000)+60}:{state:'unknown'};};
 const first=make();await Promise.all([first.api.call(path,{limit:50}),first.api.call(path,{limit:50})]);assert.equal(reads,1);
 const returned=make();await returned.api.call(path,{limit:50});assert.equal(reads,1,'returning to a valid query does not refetch');
 await query.invalidateQueries({queryKey:key()});await returned.api.call(path,{limit:50});assert.equal(reads,2);
 await returned.api.call('/v2/chat/rooms/'+room+'/operation-receipt',{operationId:'original'});
 await returned.api.call('/v2/chat/rooms/'+room+'/operation-receipt',{operationId:'original'});assert.equal(reads,4,'unknown receipts are checked, never replayed as writes');
 query.setQueryData(key(path,{limit:50}),{messages:[],readExpiresAt:Math.floor(Date.now()/1000)-1});
 await returned.api.call(path,{limit:50});assert.equal(reads,5,'expired permission windows never reuse cached data');
 query.clear();
});


test('account unknown send recovery only checks the original receipt, including an explicit recheck',async()=>{
 const f=fixture(),runtime=f.create(),roomId=randomUUID();let sends=0,receipts=0;
 f.client.call=async(path,input)=>{
  if(path.endsWith('/send')){sends++;throw Error('response-lost');}
  if(path.endsWith('/receipt')){receipts++;return {roomId,...input,state:'absent',checkedAt:new Date().toISOString(),currentAccessGranted:false,contentReturned:false,othersReadStatus:'not-asserted',acceptedByRoom:false};}
  throw Error('unexpected operation');
 };
 await assert.rejects(runtime.chat.send(roomId,'approved original',{confirmed:true}),/response-lost/);
 const original=await runtime.chat.pending(roomId);
 assert.equal((await runtime.chat.resumePending(roomId)).state,'absent');
 assert.equal((await runtime.chat.resumePending(roomId,{explicitRetry:true})).state,'absent');
 assert.equal(sends,1);assert.equal(receipts,2);assert.deepEqual((await runtime.chat.pending(roomId)).input,original.input);
});
