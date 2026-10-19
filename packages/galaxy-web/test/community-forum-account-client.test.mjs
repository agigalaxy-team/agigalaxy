import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommunityForumClient,newForumDraft,forumDraftPayload} from '../src/community-forum-client.mjs';
import {createOfficialAccountClient} from '../src/official-account-client.mjs';
import {rememberForumLoginDraft,forumLoginDraft,forumOwnsContent} from '../src/forum-account-state.mjs';
import {defaultForumPolicy} from '../../galaxy-official/src/community-forum-policy-v1.mjs';

const endpoint='https://official.example.org',website='https://galaxy.example.org';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const now=()=>1800000000;
function localRuntime(){
 const rows=new Map();
 return{rows,api:{endpoint,snapshot:()=>null,call:async()=>{throw Error('Unexpected identity transport');}},
  getLocal:async(key,owner)=>structuredClone(rows.get(owner+'|'+key)),
  updateLocal:async(key,update,owner)=>{const next=update(structuredClone(rows.get(owner+'|'+key)));rows.set(owner+'|'+key,structuredClone(next));return structuredClone(next);}};
}

test('visitor can write a draft without an ID, and only the selected login draft joins an empty account draft',async()=>{
 const runtime=localRuntime(),guest=createCommunityForumClient(runtime,{browserDrafts:true,context:'feed',now});
 await guest.draft.load();const draft=newForumDraft('create-post',{}, {title:'登录前的原稿',body:'应保留的正文',topic:'technology'});await guest.draft.save(draft);
 await assert.rejects(guest.quotas(),{code:'official_account_session_expired'});
 const account=createCommunityForumClient(runtime,{context:'feed',account:{id,assertCurrent(){},call:async()=>{throw Error('No network needed for draft adoption');}},now});
 await account.draft.load();
 assert.equal((await account.draft.importVisitor({id:draft.id,revision:draft.revision+1})).status,'missing');
 assert.equal((await account.draft.importVisitor({id:draft.id,revision:draft.revision})).status,'imported');
 assert.equal((await account.draft.load()).body,draft.body);assert.equal(await guest.draft.load(),null);
 assert.equal([...runtime.rows.keys()].some(key=>key.includes('GUID')),false);
});

test('login never overwrites another account draft or moves a draft owned by a local ID',async()=>{
 const runtime=localRuntime(),guest=createCommunityForumClient(runtime,{browserDrafts:true,context:'feed',now});await guest.draft.load();
 const draft=newForumDraft('create-post',{}, {title:'访客原稿',body:'访客正文'});await guest.draft.save(draft);
 const account=createCommunityForumClient(runtime,{context:'feed',account:{id,assertCurrent(){},call:async()=>({})},now});await account.draft.load();
 const existing=newForumDraft('create-post',{}, {title:'账户原稿',body:'账户正文'});await account.draft.save(existing);
 const localKey='GUID15'+'0'.repeat(26)+'|community-forum:'+endpoint+':'+('GUID15'+'0'.repeat(26));
 runtime.rows.set(localKey,{privateIdDraft:true});
 assert.equal((await account.draft.importVisitor({id:draft.id,revision:draft.revision})).status,'occupied');
 assert.equal((await account.draft.load()).id,existing.id);assert.equal((await guest.draft.load()).id,draft.id);
 assert.deepEqual(runtime.rows.get(localKey),{privateIdDraft:true});
 const next=createCommunityForumClient(runtime,{context:'feed',account:{id:other,assertCurrent(){},call:async()=>({})},now});assert.equal(await next.draft.load(),null);
});

test('account publication preserves an unknown result and reads its original receipt without signing or publishing twice',async()=>{
 const runtime=localRuntime();let accepted=null,writes=0;
 const account={id,assertCurrent(){},async call(path,input){
  if(path==='/v2/community/posts'){writes++;accepted=JSON.parse(input.payloadJson);assert.deepEqual(Object.keys(input),['payloadJson']);throw new TypeError('fetch failed');}
  if(path==='/v2/community/receipt')return{...input,status:accepted?'acknowledged':'absent',locator:{kind:'post-version',postId:accepted?.postId,versionId:accepted?.versionId}};
  throw Error('Unexpected path '+path);
 }};
 const client=createCommunityForumClient(runtime,{account,context:'feed',now});await client.draft.load();
 const draft=newForumDraft('create-post',{}, {title:'无需本地 ID',body:'真实账户的内容',topic:'technology'});await client.draft.save(draft);
 const payload=forumDraftPayload(draft,defaultForumPolicy,now());
 const preview=await client.prepare('create-post',payload,{draftRef:{id:draft.id,revision:draft.revision}});
 await assert.rejects(client.execute(preview,{confirmed:true}),error=>error.resultUnknown===true);
 assert.equal((await client.pending())[0].state,'awaiting-receipt');
 assert.equal((await client.resumePending()).status,'acknowledged');assert.equal(writes,1);assert.equal(await client.draft.load(),null);
});

test('account transport binds every forum request to the expected account and the current CSRF value',async()=>{
 const calls=[],session={state:'signed-in',account:{id},csrfToken:'synthetic-csrf',expiresAt:now()+3600};
 const client=createOfficialAccountClient({endpoint,website,now,fetch:async(url,options)=>{calls.push({url,options});return new Response('{}',{status:200});}});
 await client.call('/v2/community/posts/owned',{}, {session});await client.call('/v2/community/quotas',null,{method:'GET',session});
 for(const {options}of calls){assert.equal(options.credentials,'include');assert.equal(options.redirect,'error');assert.equal(options.headers['X-Galaxy-Account-ID'],id);assert.equal(options.headers['X-Galaxy-Account-CSRF'],session.csrfToken);assert.equal(options.headers.Authorization,undefined);}
 await assert.rejects(client.call('/v2/community/posts',{}, {session:{...session,expiresAt:now()}}),{code:'official_account_session_expired'});
 await assert.rejects(client.call('https://elsewhere.example/v2/community/posts',{}, {session}),{code:'official_account_request_invalid'});assert.equal(calls.length,2);
});

test('restricted content reads use the current account and never retry anonymously after rejection',async()=>{
 const runtime=localRuntime(),calls=[];
 const client=createCommunityForumClient(runtime,{account:{id,assertCurrent(){},async call(path,input,options){calls.push({path,input,options});if(path.includes('/replies/'))throw Object.assign(Error('official_account_changed'),{code:'official_account_changed'});return {items:[]};}},now});
 await client.posts({sectionId:other});await client.section(other);
 await assert.rejects(client.reply(other),{code:'official_account_changed'});
 assert.deepEqual(calls.map(value=>value.path),['/v2/community/posts/query','/v2/community/sections/'+other,'/v2/community/replies/'+other]);
 assert.deepEqual(calls[0].input,{sectionId:other});
});

test('a member section keeps the selected audience and reconciles its original account operation after an unknown response',async()=>{
 const runtime=localRuntime(),audience={read:{kind:'accounts'},participate:{kind:'selected-accounts',accountIds:[id,other]}};
 let accepted=null,writes=0;
 const client=createCommunityForumClient(runtime,{context:'sections',account:{id,assertCurrent(){},async call(path,input){
  if(path==='/v2/community/sections'){writes++;accepted=JSON.parse(input.payloadJson);throw new TypeError('fetch failed');}
  if(path==='/v2/community/receipt')return {...input,status:accepted?'acknowledged':'absent',locator:{kind:'section',sectionId:accepted?.sectionId}};
  throw Error('Unexpected path '+path);
 }},now});
 await client.draft.load();const draft=newForumDraft('create-section',{}, {title:'长期研究讨论',theme:'交流真实观察和方法',description:'由普通成员维护',audience});await client.draft.save(draft);
 const preview=await client.prepare(draft.kind,forumDraftPayload(draft,defaultForumPolicy,now()),{draftRef:{id:draft.id,revision:draft.revision}});
 assert.deepEqual(preview.payload.audience,audience);assert.equal(preview.payload.state,'active');
 await assert.rejects(client.execute(preview,{confirmed:true}),error=>error.resultUnknown===true);
 const result=await client.resumePending();assert.equal(result.status,'acknowledged');assert.equal(result.locator.sectionId,preview.payload.sectionId);assert.equal(writes,1);assert.equal(await client.draft.load(),null);
});

test('login return references contain navigation only and preserve exact drafts and acting-account ownership',()=>{
 const rows=new Map(),storage={getItem:key=>rows.get(key)??null,setItem:(key,value)=>rows.set(key,value)};
 const draft=newForumDraft('create-reply',{}, {body:'私人文字不进入导航引用'}),scope={endpoint,context:'post:original',path:'/app/community/posts/original?reply=1#discussion'};
 assert.equal(rememberForumLoginDraft({...scope,draft},storage,1000),true);
 assert.equal([...rows.values()].join('').includes(draft.body),false);assert.deepEqual(forumLoginDraft(scope,storage,1001),{id:draft.id,revision:draft.revision});
 assert.equal(forumLoginDraft({...scope,path:'/app/community'},storage,1001),null);assert.equal(forumLoginDraft(scope,storage,601001),null);
 const content={authorId:'original-ID',authorAccountId:id};assert.equal(forumOwnsContent(content,{accountId:id}),true);assert.equal(forumOwnsContent(content,{accountId:other}),false);assert.equal(forumOwnsContent(content,{subjectId:'original-ID',targetAccountId:other}),false);
 assert.equal(forumOwnsContent({authorId:null,authorAccountId:id},{subjectId:'authorized-local-ID',targetAccountId:id}),true);
 assert.equal(forumOwnsContent({authorId:null,authorAccountId:other},{subjectId:'authorized-local-ID',targetAccountId:id}),false);
});
