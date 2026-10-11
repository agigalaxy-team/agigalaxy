import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chatFixture,invite} from './chat-workflow.mjs';
import {createApi} from '../src/http.mjs';
import canonicalize from 'canonicalize';
import {digest} from '../src/shared/digest.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

// Real signed session HTTP and SQL; the archive here is an explicit contract
// double. Normal browser delivery is separately checked with real Prosody.
test('directory, context and edit receipt enforce current reading and independent human read facts through HTTP',{timeout:60000},async()=>{
 const bodies=new Map(),transport={available:true,project:async()=>{},send:async input=>{bodies.set(input.messageId,{archiveId:input.messageId,text:input.text,revision:1});return{archiveId:input.messageId};},
  read:async input=>input.ids.flatMap(id=>bodies.has(id)?[bodies.get(id)]:[]),edit:async input=>{const body=bodies.get(input.messageId);body.text=input.text;body.revision++;return{revision:body.revision};},erase:async input=>{bodies.delete(input.messageId);return{archiveDeleted:true};}};
 const f=await chatFixture({transport}),[a,b,c]=f.people,server=createApi({bindings:{endpoint:f.chat.access.endpoint},access:f.chat.access,chat:f.chat,rateLimit:1000});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const post=async(actor,path,input={})=>{const response=await fetch(base+path,{method:'POST',headers:{Authorization:'Bearer '+f.credentials.get(actor.subjectId),'content-type':'application/json'},body:JSON.stringify(input)});
  return{status:response.status,body:await response.json()};};
 const ok=async pending=>{const result=await pending;assert.equal(result.status,200,JSON.stringify(result.body));return result.body;};
 try{
  const rooms=[];for(let n=0;n<3;n++){const roomId=randomUUID();await f.chat.create(a,{roomId,operationId:randomUUID(),title:'Synthetic directory '+n});await invite(f.chat,a,roomId,b);rooms.push(roomId);}
  const first=await f.chat.send(a,rooms[0],{clientMessageId:randomUUID(),text:'Original first text'}),second=await f.chat.send(a,rooms[1],{clientMessageId:randomUUID(),text:'Original second text'});
  const grantId=randomUUID();await f.chat.grantAgent(a,rooms[2],{grantId,bindingId:a.bindingId,mode:'respond',expiresAt:f.now()+300});
  await f.chat.send(a,rooms[2],{clientMessageId:randomUUID(),text:'Explicit agent response',agentGrantId:grantId});
  const directory=await ok(post(b,'/v2/chat/rooms/directory'));assert.deepEqual(directory.rooms.map(item=>item.roomId),[rooms[2],rooms[1],rooms[0]]);
  assert.deepEqual(directory.rooms.map(item=>item.unreadHumanCount),[0,1,1]);assert.equal(directory.rooms[0].activityTimeBasis,'accepted-time');
  assert.equal((await f.db.query('SELECT count(*)::int AS count FROM chat_cursors')).rows[0].count,0,'Directory does not declare reading');
  const page=await ok(post(b,'/v2/chat/rooms/directory',{limit:1}));assert.ok(page.nextCursor);
  assert.equal((await post(c,'/v2/chat/rooms/directory',{cursor:page.nextCursor})).body.error,'invalid_chat_cursor');
  await f.chat.hide(b,rooms[1],second.messageId);const hidden=await ok(post(b,'/v2/chat/rooms/directory'));
  assert.equal(hidden.rooms[1].latestMessage,null);assert.equal(hidden.rooms[1].unreadHumanCount,0);assert.equal(JSON.stringify(hidden).includes('Original second text'),false);
  const hiddenContext=await ok(post(b,`/v2/chat/rooms/${rooms[1]}/messages/${second.messageId}/context`));assert.equal(hiddenContext.targetState,'hidden');assert.equal(hiddenContext.target,null);
  const context=await ok(post(b,`/v2/chat/rooms/${rooms[0]}/messages/${first.messageId}/context`));assert.equal(context.target.messageId,first.messageId);assert.equal(context.target.text,'Original first text');assert.equal(context.readExpiresAt,f.now()+60);
  assert.equal((await post(c,`/v2/chat/rooms/${rooms[0]}/messages/${first.messageId}/context`)).status,403);
  const ownGrant=randomUUID();await f.chat.grantAgent(b,rooms[0],{grantId:ownGrant,bindingId:b.bindingId,mode:'read',expiresAt:f.now()+300});
  await ok(post(b,`/v2/chat/rooms/${rooms[0]}/cursor`,{kind:'agent',sequence:context.target.sequence,agentGrantId:ownGrant}));
  assert.equal((await ok(post(b,'/v2/chat/rooms/directory'))).rooms.find(item=>item.roomId===rooms[0]).unreadHumanCount,1,'Agent read is not human read');
  await ok(post(b,`/v2/chat/rooms/${rooms[0]}/cursor`,{kind:'human',sequence:context.target.sequence,visibleMessageIds:[first.messageId]}));
  assert.equal((await ok(post(b,'/v2/chat/rooms/directory'))).rooms.find(item=>item.roomId===rooms[0]).unreadHumanCount,0);
  const operationId=randomUUID(),edit={operationId,expectedRevision:1,text:'Exact current correction'},edited=await f.chat.edit(a,rooms[0],first.messageId,edit);
  const {chatEditRequestHash}=await import('../src/shared/chat-message-request-hash.mjs'),requestHash=await chatEditRequestHash(edit);
  const receipt=await ok(post(a,`/v2/chat/rooms/${rooms[0]}/operation-receipt`,{operationId,requestHash}));assert.equal(receipt.state,'acknowledged');assert.equal(receipt.revision,edited.revision);assert.equal(JSON.stringify(receipt).includes(edit.text),false);
  assert.equal((await ok(post(b,`/v2/chat/rooms/${rooms[0]}/operation-receipt`,{operationId,requestHash}))).state,'absent');
  assert.equal((await ok(post(a,`/v2/chat/rooms/${rooms[0]}/operation-receipt`,{operationId,requestHash:'0'.repeat(64)}))).state,'conflict');
  assert.equal((await ok(post(b,'/v2/chat/rooms/directory'))).rooms.find(item=>item.roomId===rooms[0]).latestMessage.text,edit.text);
  // A global authorization adapter can reject between independent room
  // transactions. Its 403 is not a personally inaccessible room to skip.
  const authorized=f.chat.access.runAuthorized.bind(f.chat.access);let reads=0;
  f.chat.access.runAuthorized=(...args)=>++reads===3?Promise.reject(new ServiceError('access_denied',403)):authorized(...args);
  try{const rejected=await post(b,'/v2/chat/rooms/directory');assert.equal(rejected.status,403);
   assert.equal(JSON.stringify(rejected.body).includes('Explicit agent response'),false);
  }finally{f.chat.access.runAuthorized=authorized;}
  await f.chat.retract(a,rooms[0],first.messageId);const retracted=await ok(post(b,`/v2/chat/rooms/${rooms[0]}/messages/${first.messageId}/context`));assert.equal(retracted.targetState,'retracted');assert.equal(retracted.target.text,null);
  assert.equal((await ok(post(b,'/v2/chat/rooms/directory'))).rooms.find(item=>item.roomId===rooms[0]).latestMessage,null);
  await f.db.query("INSERT INTO deletion_requests(id,subject_id,binding_id,requester_public_key,payload_text,payload_hash,signature,state,revision) VALUES($1,$2,$3,'synthetic','{}','synthetic','synthetic','requested',1)",[randomUUID(),a.subjectId,a.bindingId]);
  const quarantined=await ok(post(b,'/v2/chat/rooms/directory'));assert.equal(quarantined.rooms.every(item=>item.latestMessage===null&&item.unreadHumanCount===0),true);
  await f.chat.leave(b,rooms[0]);assert.equal((await post(b,`/v2/chat/rooms/${rooms[0]}/messages/${first.messageId}/context`)).status,403);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.close();}
});

test('directory checks latest candidates and unread humans without transporting already-read long history',{timeout:60000},async()=>{
 const bodies=new Map(),reads=[],metadataReads=[];
 const transport={available:true,project:async()=>{},
  read:async input=>{reads.push(input.ids);return input.ids.flatMap(id=>bodies.has(id)?[bodies.get(id)]:[]);},
  readMetadata:async input=>{metadataReads.push(input.ids);return input.ids.flatMap(id=>bodies.has(id)?[{archiveId:id,revision:bodies.get(id).revision}]:[]);},
  erase:async input=>{bodies.delete(input.messageId);return{archiveDeleted:true};}};
 const f=await chatFixture({transport}),[a,b]=f.people,roomId=randomUUID();
 try{
  await f.chat.create(a,{roomId,operationId:randomUUID(),title:'Synthetic long history'});await invite(f.chat,a,roomId,b);
  // Explicit SQL/archive contract samples isolate directory read cost. This is
  // not evidence of real delivery; the independent Prosody scene tests that.
  const insert=async(count,prefix)=>{
   const records=Array.from({length:count},(_,index)=>{
    const messageId=randomUUID(),clientMessageId=randomUUID(),text=prefix+' '+index;
    bodies.set(messageId,{archiveId:messageId,revision:1,text});
    return{message_id:messageId,client_message_id:clientMessageId,payload_hash:digest(canonicalize({clientMessageId,text,replyTo:null,agentGrantId:null,attachmentRefs:[]})),content_bytes:Buffer.byteLength(text)};
   });
   return(await f.db.query(`INSERT INTO chat_message_refs(message_id,room_id,subject_id,client_message_id,payload_hash,actor_kind,sent_at,expires_at,content_bytes,state,archive_id,accepted_order,accepted_at)
    SELECT x.message_id,$2,$3,x.client_message_id,x.payload_hash,'human',$4,$5,x.content_bytes,'accepted',x.message_id::text,public.galaxy_chat_next_directory_order(),$4
     FROM jsonb_to_recordset($1::jsonb) AS x(message_id uuid,client_message_id uuid,payload_hash text,content_bytes integer)
    RETURNING message_id,sequence::text`,[JSON.stringify(records),roomId,a.subjectId,new Date(f.now()*1000).toISOString(),new Date((f.now()+86400)*1000).toISOString()])).rows;
  };
  const old=await insert(500,'Already read original');await f.chat.cursor(b,roomId,{kind:'human',sequence:old.at(-1).sequence});
  const allRead=await f.chat.directory(b);
  assert.equal(allRead.rooms[0].unreadHumanCount,0);assert.equal(metadataReads.flat().length,20);assert.deepEqual(reads.map(ids=>ids.length),[1]);
  assert.equal(allRead.rooms[0].latestMessage.messageId,old.at(-1).message_id);
  const fresh=await insert(140,'Unread original');
  bodies.delete(fresh[0].message_id);await f.chat.hide(b,roomId,fresh[1].message_id);
  await f.db.query('UPDATE chat_message_refs SET expires_at=$2 WHERE message_id=$1',[fresh[2].message_id,new Date((f.now()-1)*1000).toISOString()]);
  await f.chat.retract(a,roomId,fresh[3].message_id);
  reads.length=0;metadataReads.length=0;
  const current=await f.chat.directory(b);assert.equal(current.rooms[0].unreadHumanCount,136);
  assert.equal(metadataReads.length,3);assert.equal(metadataReads.flat().length,157);
  assert.equal(metadataReads.every(ids=>ids.length<=100),true);assert.deepEqual(reads.map(ids=>ids.length),[1]);
  assert.equal(metadataReads.flat().some(id=>old.some(record=>record.message_id===id)),false);
  // An older component may return full bodies for the same narrow requests.
  // Its fallback remains correct without scanning the 500 already-read rows.
  delete transport.readMetadata;reads.length=0;
  const compatible=await f.chat.directory(b);assert.equal(compatible.rooms[0].unreadHumanCount,136);
  assert.equal(reads.flat().length,158);assert.equal(reads.every(ids=>ids.length<=100),true);
  assert.equal(compatible.rooms[0].latestMessage.messageId,fresh.at(-1).message_id);
 }finally{await f.close();}
});
