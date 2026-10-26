import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {communityForumFixture} from '../../galaxy-official/test/community-forum-fixture.mjs';
import {createNativeRuntime} from '../src/native-v2/runtime.mjs';
import {createNativeToolServer} from '../src/native-v2/server.mjs';
import {isWebIdentityTargetPath} from '../src/native-v2/identity/web-handoff.mjs';
import {nativeData} from './native-result.mjs';

test('anonymous Native community reading opens the exact discussion and returns without restoring withdrawn content',{timeout:60000},async()=>{
 const f=await communityForumFixture(),directory=await mkdtemp(join(tmpdir(),'galaxy-native-community-')),calls=[],opened=[];
 let runtime,server,client;
 try{
  await f.login(f.owner,'native-community-author');await f.login(f.responder,'native-community-responder');
  const p=await f.post({topic:'life',title:'修复旧灯的实际过程',body:'先确认松动的部位。\n\n更换后记录这次结果，不必先建立任务。'});
  assert.equal((await f.write(f.owner,'create-post',p)).status,200);
  const reply=await f.reply(p,{body:'这段过程里的第二步很清楚。'});
  assert.equal((await f.write(f.responder,'create-reply',reply)).status,200);
  runtime=await createNativeRuntime({dataDirectory:directory,endpoint:f.owner.bindings.endpoint,website:'https://selected.example',trustedKeys:f.owner.bindings.trustedKeys,now:()=>f.clock.now,
   fetch:async(url,options)=>{const path=new URL(url).pathname,response=await fetch(f.origin+path,options);calls.push({path,method:options?.method??'GET',status:response.status,authenticated:!!new Headers(options?.headers).get('authorization')});return response;},
   openBrowser:async url=>{opened.push(url);return{launched:true};}});
  server=createNativeToolServer(runtime);client=new Client({name:'synthetic-community-reader',version:'1'},{capabilities:{}});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  const invoke=async(name,input)=>{const response=await client.callTool({name,arguments:input});assert.notEqual(response.isError,true,JSON.stringify(response));return{response,data:nativeData(response)};};
  const list=await invoke('galaxy_community_query',{});assert.equal(list.data.items[0].payload.title,p.title);
  const topics=await invoke('galaxy_community_topics',{});assert.equal(topics.data.items.length,5);
  const filtered=await invoke('galaxy_community_query',{topic:'life',query:'旧灯'});assert.equal(filtered.data.items.length,1);
  assert.ok(list.response.content[0].text.includes(p.title));assert.ok(!list.response.content[0].text.includes('payloadHash'));
  const read=await invoke('galaxy_community_read',{postId:p.postId,versionId:p.versionId});
  assert.equal(read.data.payload.body,p.body);assert.ok(read.response.content[0].text.includes(p.body));
  assert.ok(read.response.content[0].text.includes('生活与兴趣'));
  const replies=await invoke('galaxy_community_replies',{postId:p.postId,postVersionId:p.versionId});
  assert.equal(replies.data.items[0].payload.body,reply.body);assert.ok(replies.response.content[0].text.includes(reply.body));
  assert.equal((await runtime.status()).identity,null);assert.equal((await runtime.status()).connected,false);
  const origin={host:'synthetic-original-host',workRef:'private original work stays in this device'},target={kind:'post',id:p.postId,versionId:p.versionId};
  const topicNavigation=await invoke('galaxy_open',{object:{kind:'community',topic:'life',query:'旧灯'},origin});
  assert.equal(topicNavigation.data.targetPath,'/app/community?topic=life&q='+encodeURIComponent('旧灯'));
  assert.equal(isWebIdentityTargetPath(topicNavigation.data.targetPath),true);
  assert.equal(isWebIdentityTargetPath('/app/community?topic=life&q=x&returnTo=https%3A%2F%2Fevil.example'),false);
  assert.equal(isWebIdentityTargetPath('/app/bookmarks'),true);
  const navigation=await invoke('galaxy_open',{object:target,origin});
  const expected='/app/community/posts/'+p.postId+'/versions/'+p.versionId;
  assert.equal(navigation.data.targetPath,expected);assert.equal(opened.at(-1),'https://selected.example'+expected);
  assert.equal(isWebIdentityTargetPath(expected),true);assert.equal(isWebIdentityTargetPath('/app/community'),true);
  const back=await invoke('galaxy_return',{navigationId:navigation.data.navigationId});
  assert.equal(back.data.current,true);assert.deepEqual(back.data.origin,origin);assert.equal(back.data.data.payload.body,p.body);
  assert.equal((await f.write(f.owner,'withdraw-post',{schemaVersion:1,operationId:randomUUID(),postId:p.postId,expectedHeadVersion:1})).status,200);
  const withdrawn=await invoke('galaxy_community_read',{postId:p.postId,versionId:p.versionId});
  assert.equal(withdrawn.data.availability,'withdrawn');assert.ok(withdrawn.response.content[0].text.includes('撤回'));assert.ok(!JSON.stringify(withdrawn.response).includes(p.body));
  const retained=await invoke('galaxy_return',{navigationId:navigation.data.navigationId});
  assert.equal(retained.data.current,false);assert.equal(retained.data.data,null);assert.equal(retained.data.sourceError,'forum_content_withdrawn');assert.deepEqual(retained.data.origin,origin);
  assert.equal((await invoke('galaxy_community_query',{})).data.items.length,0);
  assert.ok(calls.every(call=>call.path.startsWith('/v2/community/')));assert.ok(calls.every(call=>!call.authenticated));
  assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,0);
 }finally{
  await client?.close();await server?.close();await runtime?.close();await f.close();
  const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-native-community-'));
  await rm(target,{recursive:true,force:true});
 }
});
