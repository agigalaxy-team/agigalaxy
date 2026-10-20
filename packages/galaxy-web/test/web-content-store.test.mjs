import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {createWebRuntime} from '../src/runtime.mjs';
import {createOfficialChatRuntime} from '../src/official-chat-runtime.mjs';
import {createCommunityForumClient,newForumDraft} from '../src/community-forum-client.mjs';
import {createWebStorage} from '../src/web-content-store.mjs';

const endpoint='https://official.example.org',prefix=`galaxy-web:${endpoint}:`,server=generateKeyPairSync('ed25519');
const config={endpoint,trustedKeys:new Map([['content-test',{publicKeyPem:server.publicKey.export({type:'spki',format:'pem'}),notBefore:0,notAfter:4102444800,revoked:false}]])};
function memory(){const rows=new Map(),reads=[],writes=[];return{rows,reads,writes,
 get:async key=>{reads.push(key);return structuredClone(rows.get(key));},put:async(key,value)=>{writes.push(key);rows.set(key,structuredClone(value));},
 update:async(key,change)=>{writes.push(key);const value=change(structuredClone(rows.get(key)));rows.set(key,structuredClone(value));return structuredClone(value);},close(){}};}

test('an unavailable identity database does not block account chat, account and visitor forum drafts, or public reads',async t=>{
 const content=memory();let identityOpens=0,contentOpens=0;
 const runtime=await createWebRuntime(config,{openIdentityStore:async()=>{identityOpens++;throw Error('Synthetic key database unavailable');},
  openContentStore:async()=>{contentOpens++;return content;},fetch:async()=>Response.json({items:[]})});
 t.after(()=>runtime.close());assert.equal(contentOpens,0,'website content storage opens only when content is used');
 assert.equal((await runtime.status()).identity,null);assert.equal(await runtime.resumeConnection(),null);
 const session={state:'signed-in',account:{id:randomUUID()},csrfToken:randomUUID(),expiresAt:Math.floor(Date.now()/1000)+3600};
 const account={id:session.account.id,assertCurrent(){},call:async()=>({items:[]})};
 const chat=createOfficialChatRuntime({base:runtime,endpoint,client:account,getSession:()=>session});
 assert.equal(typeof Object.getOwnPropertyDescriptor(runtime,'notifications').get,'function','the real base includes the Native-only getter that must not be evaluated');
 assert.equal(chat.notifications,undefined);assert.equal(chat.deviceHandoff,undefined);assert.equal(chat.trustPackages,undefined);
 await chat.updateLocal('chat-draft:one',()=>({text:'继续这段对话'}));assert.equal((await chat.getLocal('chat-draft:one')).text,'继续这段对话');
 for(const options of [{account},{browserDrafts:true}]){
  const forum=createCommunityForumClient(runtime,options);assert.equal(await forum.draft.load(),null);
  const draft=newForumDraft('create-post',{}, {title:'保留新帖子',body:'此处输入不依赖本机身份。'});
  await forum.draft.save(draft);assert.equal((await forum.draft.load()).body,draft.body);forum.close();
 }
 assert.ok([...content.rows.keys()].every(key=>key.startsWith(prefix+'account:')||key.startsWith(prefix+'visitor:community-forum:')));
 assert.deepEqual(await runtime.api.call('/v2/community/sections/query',{}, {authenticated:false}),{items:[]});
 await assert.rejects(runtime.createIdentity({confirmed:true}),{code:'local_galaxy_required'});
 await assert.rejects(runtime.connect({confirmed:true}),/确认连接当前身份/);
 assert.equal(identityOpens,1,'account actions never retry or read Native keys');
});

test('content failures stay at draft writes while GUID and visitor task data retain the original atomic store',async t=>{
 const identity=memory(),copies=[];identity.copyConfirmedDraft=async input=>{copies.push(input);return{copied:true,sourceRetained:true};};
 const storage=createWebStorage({prefix,openIdentityStore:async()=>identity,openContentStore:async()=>{throw Error('Synthetic content database unavailable');}});
 t.after(()=>storage.close());
 const guid='GUID1500000000000000000000000000',owner='account:'+randomUUID(),input={sourceKey:prefix+'visitor:task-draft',targetKey:prefix+guid+':task-draft',confirmed:true};
 await storage.put(input.sourceKey,{title:'原访客工作稿'});await storage.put(prefix+guid+':note',{text:'原 ID 本地内容'});
 await storage.copyConfirmedDraft(input);assert.deepEqual(copies,[input]);assert.equal(identity.rows.size,2);
 assert.equal(await storage.get(prefix+owner+':chat-draft:one'),undefined);
 await assert.rejects(storage.put(prefix+owner+':chat-draft:one',{text:'仍在输入框中'}),{code:'local_content_storage_unavailable'});
 assert.equal(identity.writes.some(key=>key.startsWith(prefix+'account:')),false);
 const readKeys=[],runtime=await createWebRuntime(config,{openIdentityStore:async()=>({get:async key=>{readKeys.push(key);throw Error('Synthetic active read failure');},close(){}}),
  openContentStore:async()=>memory(),fetch:async()=>Response.json({available:true})});
 t.after(()=>runtime.close());assert.equal((await runtime.status()).identity,null);
 assert.deepEqual(await runtime.api.call('/v2/community/sections/query',{}, {authenticated:false}),{available:true});
 await assert.rejects(runtime.createIdentity({confirmed:true}),{code:'local_galaxy_required'});
 assert.deepEqual(readKeys,[prefix+'active'],'a failed Native selection read does not continue into key material');
});
