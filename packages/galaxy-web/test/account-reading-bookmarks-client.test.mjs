import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from '../../galaxy-official/test/community-forum-fixture.mjs';
import {accountBookmarkBrowser} from '../../galaxy-official/test/account-reading-bookmarks-fixture.mjs';
import {createAccountReadingBookmarksClient} from '../src/reading-bookmarks-client.mjs';
import {rememberBookmarkLogin,readBookmarkLogin,claimBookmarkLogin,finishBookmarkLogin} from '../src/account-bookmark-pending.mjs';

function journalStore(){
  const values=new Map();let tail=Promise.resolve();
  return {values,async getLocal(name,owner){return structuredClone(values.get(owner+':'+name));},updateLocal(name,update,owner){
    const next=tail.then(()=>{const key=owner+':'+name,value=update(structuredClone(values.get(key)));values.set(key,structuredClone(value));return structuredClone(value);});
    tail=next.catch(()=>{});return next;
  }};
}
async function setup(run){
  const f=await communityForumFixture({officialAccountPortal:true});try{
    await f.login(f.owner,'bookmark-client-source');const post=await f.post({title:'Client saved source',body:'This body is never kept in the pending journal.'});
    assert.equal((await f.write(f.owner,'create-post',post)).status,200);
    const browser=await accountBookmarkBrowser(f,'bookmark-client-account');
    await run(f,browser,{kind:'forum-post',postId:post.postId});
  }finally{await f.close();}
}
function transport(browser,{before=async()=>{},after=async()=>{}}={}){
  const trace=[];
  return {trace,async call(path,input,options){
    trace.push({path,input:structuredClone(input)});await before(path,input);
    assert.equal(options.session.account.id,browser.session.account.id);
    const result=await browser.request(path.split('/').at(-1),input);
    if(result.status!==200)throw Object.assign(Error(result.body.error),{code:result.body.error,outcome:'rejected'});
    await after(path,input,result.body);return result.body;
  }};
}

test('account bookmark resumes a lost actual Cookie HTTP acknowledgement without another command or a source body cache',()=>setup(async(f,browser,reference)=>{
  const store=journalStore();let lost=true;
  const api=transport(browser,{after:async path=>{if(path.endsWith('/command')&&lost){lost=false;throw Error('isolated dropped acknowledgement');}}});
  const client=createAccountReadingBookmarksClient({client:api,getSession:()=>browser.session,endpoint:f.owner.access.endpoint,store,locks:null});
  await assert.rejects(client.setSaved(reference,true),/dropped acknowledgement/);
  assert.equal((await client.pending()).length,1);
  assert.ok(!JSON.stringify([...store.values.values()]).includes('This body'));
  const recovered=await client.resumePending();assert.equal(recovered.items[0].state,'acknowledged');assert.equal((await client.pending()).length,0);
  assert.equal(api.trace.filter(item=>item.path.endsWith('/command')).length,1);
  assert.equal((await client.query()).items.length,1);await client.setSaved(reference,false);assert.equal((await client.query()).items.length,0);
}));

test('account changes fence a late status before writing the old action into a new account or its journal',()=>setup(async(f,browser,reference)=>{
  const store=journalStore(),started=Promise.withResolvers(),finish=Promise.withResolvers();let current=browser.session;
  const api=transport(browser,{before:async path=>{if(path.endsWith('/status')){started.resolve();await finish.promise;}}});
  const client=createAccountReadingBookmarksClient({client:api,getSession:()=>current,endpoint:f.owner.access.endpoint,store,locks:null});
  const action=client.setSaved(reference,true);await started.promise;current={...browser.session,account:{...browser.session.account,id:randomUUID()}};finish.resolve();
  await assert.rejects(action,{code:'official_account_changed'});assert.equal(store.values.size,0);assert.equal(api.trace.filter(item=>item.path.endsWith('/command')).length,0);
}));

test('guest bookmark login retains only one exact source and return path, and claimed work does not move between accounts',()=>{
  const values=new Map(),store={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
  const reference={kind:'chat-message',roomId:randomUUID(),messageId:randomUUID()},origin='https://website.example.org',target='/app/rooms/'+reference.roomId+'?message='+reference.messageId;
  const at=Date.now(),returnPath=rememberBookmarkLogin(reference,{target,origin,store,now:()=>at});
  const url=new URL(returnPath,origin),current={origin,pathname:url.pathname,search:url.search,hash:url.hash};
  const intent=readBookmarkLogin({current,store,now:()=>at+1});assert.deepEqual(intent.reference,reference);
  assert.equal(readBookmarkLogin({current:{...current,pathname:'/app/bookmarks'},store,now:()=>at+1}),null);
  const accountA=randomUUID();assert.equal(claimBookmarkLogin(intent,accountA,{store}),true);assert.equal(claimBookmarkLogin(intent,randomUUID(),{store}),false);
  let replaced;
  assert.equal(finishBookmarkLogin(intent,reference,{current,store,browserHistory:{state:{position:3},replaceState(state,_title,path){replaced={state,path};}}}),true);
  assert.equal(values.size,0);assert.equal(replaced.path,target);assert.deepEqual(replaced.state,{position:3});
});
