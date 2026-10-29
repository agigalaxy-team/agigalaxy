import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPublicCommunityFeedback} from '../src/features/discovery/public-feedback.mjs';
import {createAccountReadingBookmarksClient} from '../src/features/bookmarks/client.mjs';
import {createCommunityForumClient,newForumDraft,forumDraftPayload} from "../src/features/community-forum/community-forum-client.mjs";
import {sha256Hex} from '../../galaxy-contracts/src/web-primitives.mjs';
import {readingBookmarkKey} from '../../galaxy-contracts/src/reading-bookmarks-v1-schema.mjs';
import {defaultForumPolicy} from "../../galaxy-contracts/src/policies/forum-quota.mjs";

const endpoint='https://official.example.org',websiteOrigin='https://galaxy.example.org';
const now=()=>Math.floor(Date.now()/1000);
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function sourcePost(id,version=randomUUID(),extra={}){
 return {locator:{kind:'post',postId:id},currentVersionId:version,availability:'available',publishedUntil:now()+3600,payload:{title:'Public source',body:'SOURCE_BODY_NEVER_IN_USAGE'},...extra};
}
function sourceReply(id,extra={}){
 return {locator:{kind:'reply',replyId:id,postId:randomUUID(),postVersionId:randomUUID(),contentRevision:1},revision:1,availability:'available',parentAvailability:'available',publishedUntil:now()+3600,payload:{body:'REPLY_BODY_NEVER_IN_USAGE'},...extra};
}
function usageTransport(owner=randomUUID()){
 let currentAccount=owner;
 const sources=new Map(),events=[],reads=[],sessionReads=[],accepted=new Map();
 const session=()=>({state:'signed-in',account:{id:currentAccount,uid:'Sample12UID34',displayName:'Sample',email:'sample@example.org',emailVerified:true},csrfToken:'synthetic-account-csrf',expiresAt:now()+3600,linkedIds:[],nextAfter:null,galaxyAuthorization:false});
 const fetcher=async(url,options={})=>{
  const path=new URL(url).pathname;
  if(path==='/v1/account/session'){sessionReads.push(path);return response(currentAccount?session():{state:'signed-out',galaxyAuthorization:false});}
  if(path==='/v1/discovery/config')return response({csrfToken:'synthetic-discovery-csrf'});
  if(path==='/v1/discovery/events'){
   assert.equal(options.headers['X-Galaxy-Account-ID'],owner);
   assert.equal(options.headers['X-Galaxy-Account-CSRF'],'synthetic-account-csrf');
   assert.equal(options.headers['X-Galaxy-Discovery-CSRF'],'synthetic-discovery-csrf');
   const input=JSON.parse(options.body);
   assert.deepEqual(Object.keys(input).sort(),['content','eventId','name','pageKey']);
   assert.equal(input.pageKey,'community');assert.equal(JSON.stringify(input).includes('NEVER_IN_USAGE'),false);
   const old=accepted.get(input.eventId);if(old)assert.deepEqual(input,old);else{accepted.set(input.eventId,input);events.push(input);}
   return response({state:'accepted'},202);
  }
  if(/^\/v2\/community\/(posts|replies)\/[0-9a-f-]{36}$/.test(path)){
   assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');
   assert.deepEqual(options.headers,{Accept:'application/json'});reads.push(path);
   const value=sources.get(path);return value instanceof Function?value():response(value??{availability:'unavailable'},value?200:404);
  }
  throw Error('Unexpected synthetic route '+path);
 };
 return {owner,session,sources,events,reads,sessionReads,fetcher,changeAccount:value=>{currentAccount=value;},feedback:createPublicCommunityFeedback({endpoint,accountId:owner,websiteOrigin,fetcher,now})};
}
function memoryStore(){
 const values=new Map();let tail=Promise.resolve();
 return {values,getLocal:async(name,owner)=>structuredClone(values.get(owner+'|'+name)),updateLocal(name,update,owner){const next=tail.then(()=>{const key=owner+'|'+name,value=update(structuredClone(values.get(key)));values.set(key,structuredClone(value));return structuredClone(value);});tail=next.catch(()=>{});return next;}};
}
function bookmarkTransport(){
 const states=new Map(),receipts=new Map();let loseAck=false,writes=0;
 return {states,receipts,dropNextAck:()=>{loseAck=true;},get writes(){return writes;},async call(path,input){
  const kind=path.split('/').at(-1);
  if(kind==='receipt')return structuredClone(receipts.get(input.operationId)??{...input,state:'absent'});
  if(kind==='status')return structuredClone(states.get(readingBookmarkKey(input.reference))??{reference:input.reference,saved:false,revision:0});
  assert.equal(kind,'command');writes++;
  const key=readingBookmarkKey(input.reference),previous=states.get(key),bookmark={reference:input.reference,saved:input.saved,revision:(previous?.revision??0)+1,id:previous?.id??randomUUID(),savedAt:new Date().toISOString()};states.set(key,bookmark);
  const result={state:'acknowledged',operationId:input.operationId,payloadHash:await sha256Hex(JSON.stringify(input)),bookmark};receipts.set(input.operationId,result);
  if(loseAck){loseAck=false;throw Error('Synthetic acknowledgement lost');}return structuredClone(result);
 }};
}

test('real bookmark completion and lost-ACK recovery emit only confirmed public saves with a stable event ID',async()=>{
 const f=usageTransport(),api=bookmarkTransport(),deliveries=[],store=memoryStore();
 const client=createAccountReadingBookmarksClient({client:api,endpoint,getSession:f.session,store,locks:null,onAcknowledged:value=>{const delivery=f.feedback.bookmark(value);deliveries.push(delivery);return delivery;}});
 const first={kind:'forum-post',postId:randomUUID()},version=randomUUID();f.sources.set('/v2/community/posts/'+first.postId,sourcePost(first.postId,version));
 const saved=await client.setSaved(first,true);await Promise.all(deliveries);
 assert.deepEqual(f.events.map(row=>[row.name,row.eventId,row.content]),[['content-bookmark',saved.operationId,{kind:'post',id:first.postId,version}]]);
 const reads=f.reads.length;assert.equal(await f.feedback.bookmark(saved),true);assert.equal(f.events.length,1);assert.equal(f.reads.length,reads);
 await client.setSaved(first,false);await Promise.all(deliveries);assert.equal(f.events.length,1);
 const recoveredRef={kind:'forum-post',postId:randomUUID()};f.sources.set('/v2/community/posts/'+recoveredRef.postId,sourcePost(recoveredRef.postId));api.dropNextAck();
 await assert.rejects(client.setSaved(recoveredRef,true),/acknowledgement lost/);assert.equal(f.events.length,1);const original=(await client.pending())[0].command.operationId;
 const writes=api.writes,restored=await client.resumePending();await Promise.all(deliveries);
 assert.equal(restored.items[0].state,'acknowledged');assert.equal(api.writes,writes);assert.equal(f.events.length,2);assert.equal(f.events[1].eventId,original);
 const beforePrivate=f.reads.length;await client.setSaved({kind:'chat-message',roomId:randomUUID(),messageId:randomUUID()},true);await Promise.all(deliveries);
 assert.equal(f.reads.length,beforePrivate);assert.equal(f.events.length,2);
 const restricted={kind:'forum-post',postId:randomUUID()};f.sources.set('/v2/community/posts/'+restricted.postId,{availability:'unavailable'});
 assert.equal((await client.setSaved(restricted,true)).state,'acknowledged');await Promise.all(deliveries);assert.equal(f.events.length,2);
 assert.equal(JSON.stringify([...store.values.values()]).includes('NEVER_IN_USAGE'),false);
});

function forumRuntime(){
 const store=memoryStore();return {...store,api:{endpoint,snapshot:()=>null,call:async()=>{throw Error('No identity transport permitted');}}};
}
function forumTransport(f){
 const accepted=new Map();let lost=false;const writes=[];
 return {writes,dropNextAck:()=>{lost=true;},account:{id:f.owner,assertCurrent(){assert.equal(f.session().account.id,f.owner);},async call(path,input){
  if(path==='/v2/community/receipt')return {...input,status:accepted.has(input.operationId)?'acknowledged':'absent',...(accepted.has(input.operationId)?{locator:accepted.get(input.operationId)}:{})};
  const payload=JSON.parse(input.payloadJson);writes.push(payload.operationId);let locator;
  if(path==='/v2/community/posts'){
   locator={kind:'post-version',postId:payload.postId,versionId:payload.versionId};f.sources.set('/v2/community/posts/'+payload.postId,sourcePost(payload.postId,payload.versionId));
  }else if(path==='/v2/community/replies'){
   locator={kind:'reply',replyId:payload.replyId,contentRevision:1};f.sources.set('/v2/community/replies/'+payload.replyId,sourceReply(payload.replyId));
  }else if(path==='/v2/community/reports')locator={kind:'report',reportId:payload.reportId};
  else throw Error('Unexpected forum write '+path);
  accepted.set(payload.operationId,locator);if(lost){lost=false;throw Error('Synthetic publication acknowledgement lost');}return {acknowledged:true};
 }}};
}
test('real forum execute and receipt recovery collect current post versions and replies, excluding private report completion',async()=>{
 const f=usageTransport(),api=forumTransport(f),deliveries=[];
 const client=createCommunityForumClient(forumRuntime(),{account:api.account,now,onAcknowledged:value=>{const delivery=f.feedback.participation(value);deliveries.push(delivery);return delivery;}});
 const publish=async(kind,target={},values={})=>{
  const draft=newForumDraft(kind,target,{title:'Confirmed publication',body:'BUSINESS_BODY_NEVER_IN_USAGE',topic:'technology',audience:{read:{kind:'everyone'},participate:{kind:'accounts'}},...values});
  const prepared=await client.prepare(kind,forumDraftPayload(draft,defaultForumPolicy,now()));return {prepared,execute:()=>client.execute(prepared,{confirmed:true})};
 };
 const first=await publish('create-post');assert.equal(f.events.length,0);const created=await first.execute();await Promise.all(deliveries);
 assert.equal(f.events.length,1);assert.equal(f.events[0].eventId,created.operationId);assert.deepEqual(f.events[0].content,{kind:'post',id:first.prepared.payload.postId,version:first.prepared.payload.versionId});
 const next=await publish('publish-version',{postId:first.prepared.payload.postId,expectedHeadVersion:1});await next.execute();await Promise.all(deliveries);
 assert.equal(f.events.length,2);assert.equal(f.events[1].content.version,next.prepared.payload.versionId);
 const reply=await publish('create-reply',{postId:first.prepared.payload.postId,versionId:next.prepared.payload.versionId});api.dropNextAck();
 await assert.rejects(reply.execute(),/acknowledgement lost/);assert.equal(f.events.length,2);const writes=api.writes.length;
 const recovered=await client.resumePending();await Promise.all(deliveries);assert.equal(api.writes.length,writes);assert.equal(f.events.length,3);
 assert.equal(f.events[2].eventId,recovered.operationId);assert.deepEqual(f.events[2].content,{kind:'reply',id:reply.prepared.payload.replyId,version:'1'});
 const report=await publish('create-report',{kind:'post-version',postId:first.prepared.payload.postId,versionId:next.prepared.payload.versionId});await report.execute();await Promise.all(deliveries);
 assert.equal(f.events.length,3);assert.equal(f.reads.length,3);
});

test('unknown results, stale/nonpublic/expired sources, unavailable reply parents and changed accounts never become success events',async()=>{
 const f=usageTransport(),postId=randomUUID(),version=randomUUID(),receipt={status:'acknowledged',operationId:randomUUID(),locator:{kind:'post-version',postId,versionId:version}};
 assert.equal(await f.feedback.participation({kind:'create-post',receipt:{...receipt,status:'absent'}}),false);assert.equal(f.reads.length,0);
 for(const view of [sourcePost(postId,randomUUID()),sourcePost(postId,version,{publishedUntil:now()-1}),sourcePost(postId,version,{availability:'unavailable'})]){
  f.sources.set('/v2/community/posts/'+postId,view);assert.equal(await f.feedback.participation({kind:'create-post',receipt:{...receipt,operationId:randomUUID()}}),false);
 }
 const replyId=randomUUID();f.sources.set('/v2/community/replies/'+replyId,sourceReply(replyId,{parentAvailability:'unavailable'}));
 assert.equal(await f.feedback.participation({kind:'create-reply',receipt:{status:'acknowledged',operationId:randomUUID(),locator:{kind:'reply',replyId,contentRevision:1}}}),false);
 f.sources.set('/v2/community/posts/'+postId,sourcePost(postId,version));f.changeAccount(randomUUID());
 assert.equal(await f.feedback.participation({kind:'create-post',receipt:{...receipt,operationId:randomUUID()}}),false);assert.equal(f.events.length,0);
 f.changeAccount(null);
 assert.equal(await f.feedback.bookmark({state:'acknowledged',operationId:randomUUID(),bookmark:{saved:true,reference:{kind:'forum-post',postId}}}),false);assert.equal(f.events.length,0);
});
