import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {communityForumFixture} from '../../galaxy-official/test/community-forum-fixture.mjs';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../src/native-v2/runtime.mjs';
import {createNativeToolServer} from '../src/native-v2/server.mjs';
import {createNativeBookmarkSetter} from '../src/native-v2/reading-bookmarks.mjs';
import {nativeData} from './native-result.mjs';

test('Native saves a private reference with one user choice, recovers lost delivery, and respects a later removal and source withdrawal',{timeout:60000},async()=>{
 const f=await communityForumFixture({scopes:browserScopes}),directory=await mkdtemp(join(tmpdir(),'galaxy-native-bookmarks-'));
 let runtime,other,server,client,loseCommand=false,loseReceipt=false;
 const commands=[];
 try{
  await f.login(f.owner,'bookmark-source-author');
  const post=await f.post({topic:'arts',title:'慢慢画完的水彩',body:'第一张练习的颜色与修改。\n\n先收藏起来，之后再读。'});
  assert.equal((await f.write(f.owner,'create-post',post)).status,200);
  const options={dataDirectory:directory,endpoint:f.owner.bindings.endpoint,website:'https://selected.example',trustedKeys:f.owner.bindings.trustedKeys,now:()=>f.clock.now,openBrowser:async()=>({launched:true})};
  const pass=(url,input)=>fetch(f.origin+new URL(url).pathname,input);
  runtime=await createNativeRuntime({...options,fetch:async(url,input)=>{
   const path=new URL(url).pathname;
   if(path==='/v2/reading-bookmarks/receipt'&&loseReceipt)throw Error('synthetic_receipt_transport_unavailable');
   const response=await pass(url,input);
   if(path==='/v2/reading-bookmarks/command'){
    commands.push(JSON.parse(input.body));
    if(loseCommand){loseCommand=false;await response.arrayBuffer();throw Error('synthetic_ack_lost_after_acceptance');}
   }
   return response;
  }});
  await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});
  server=createNativeToolServer(runtime);client=new Client({name:'synthetic-reading-bookmark-user',version:'1'},{capabilities:{}});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  const invoke=async(name,input)=>{const response=await client.callTool({name,arguments:input});return {response,data:nativeData(response)};};
  const reference={kind:'forum-post',postId:post.postId};
  loseCommand=true;
  const saved=await invoke('galaxy_bookmark_set',{reference,saved:true});
  assert.notEqual(saved.response.isError,true,JSON.stringify(saved));assert.equal(saved.data.bookmark.saved,true);
  assert.match(saved.response.content[0].text,/已收藏/);assert.ok(!saved.response.content[0].text.includes(post.postId));assert.equal(commands.length,1);
  const list=await invoke('galaxy_bookmarks',{});
  assert.equal(list.data.items[0].source.title,post.title);assert.match(list.response.content[0].text,/慢慢画完/);
  assert.equal((await f.ok('/v2/reading-bookmarks/query',{who:f.responder,input:{}})).items.length,0);
  // A second real runtime shares the user's selected identity and private
  // reference through a separate HTTP connection, not a copied content cache.
  other=await createNativeRuntime({...options,fetch:pass});
  const setOther=createNativeBookmarkSetter(other);
  assert.equal((await setOther({reference,saved:false})).bookmark.saved,false);
  // Lose both the next accepted save ACK and its immediate receipt lookup.
  loseCommand=true;loseReceipt=true;
  const unknown=await invoke('galaxy_bookmark_set',{reference,saved:true});
  assert.equal(unknown.response.isError,true);assert.equal(commands.length,2);
  // A separately journaled client (as the browser is) changes current state
  // without consuming this Native operation's recovery record.
  const otherState=await other.api.call('/v2/reading-bookmarks/status',{reference});
  const removed=await other.api.call('/v2/reading-bookmarks/command',{operationId:randomUUID(),reference,saved:false,expectedRevision:otherState.revision});
  assert.equal(removed.bookmark.saved,false);
  loseReceipt=false;
  const recovered=await invoke('galaxy_bookmark_set',{reference,saved:true});
  assert.notEqual(recovered.response.isError,true,JSON.stringify(recovered));
  assert.equal(recovered.data.bookmark.saved,false);assert.equal(commands.length,2);
  assert.match(recovered.response.content[0].text,/当前未收藏/);
  assert.equal((await invoke('galaxy_bookmarks',{})).data.items.length,0);
  assert.equal((await invoke('galaxy_bookmark_set',{reference,saved:true})).data.bookmark.saved,true);
  assert.equal((await f.write(f.owner,'withdraw-post',{schemaVersion:1,operationId:randomUUID(),postId:post.postId,expectedHeadVersion:1})).status,200);
  const withdrawn=await invoke('galaxy_bookmarks',{});
  assert.equal(withdrawn.data.items[0].source.state,'unavailable');
  assert.ok(!JSON.stringify(withdrawn.response).includes(post.body));assert.ok(!JSON.stringify(withdrawn.response).includes(post.title));
  assert.equal((await invoke('galaxy_bookmark_set',{reference,saved:false})).data.bookmark.saved,false);
  const stored=(await f.db.query('SELECT reference FROM reading_bookmarks_v1 WHERE subject_id=$1',[runtime.api.snapshot().subjectId])).rows;
  assert.deepEqual(stored.map(row=>row.reference),[reference]);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,0);
 }finally{
  await client?.close();await server?.close();runtime?.close();other?.close();await f.close();
  const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-native-bookmarks-'));
  await rm(target,{recursive:true,force:true});
 }
});
