import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {accountBookmarkBrowser} from './account-reading-bookmarks-fixture.mjs';
import {digest} from '../src/shared/digest.mjs';

const command=(reference,saved=true,expectedRevision=0)=>({operationId:randomUUID(),reference,saved,expectedRevision});
async function source(f,overrides={}){
  const post=await f.post({title:'Synthetic source title',body:'Source body stays in its original service',...overrides});
  assert.equal((await f.write(f.owner,'create-post',post)).status,200);
  return {post,reference:{kind:'forum-post',postId:post.postId}};
}
async function signed(f,accountId,action,input,who=f.owner){
  const response=await fetch(f.origin+'/v2/account-bookmarks/'+action,{method:'POST',headers:{Authorization:'Bearer '+who.credential,'Content-Type':'application/json',
    ...(accountId?{'X-Galaxy-Account-ID':accountId}:{})},body:JSON.stringify(input)});
  return {status:response.status,body:await response.json()};
}

test('independent Cookie account saves currently readable posts without an ID and cannot read another account bookmarks',async()=>{
  const f=await communityForumFixture({officialAccountPortal:true});try{
    await f.login(f.owner,'bookmark-source');
    const {post,reference}=await source(f,{audience:{read:{kind:'accounts'},participate:{kind:'accounts'}}});
    const a=await accountBookmarkBrowser(f,'bookmark-account-a'),b=await accountBookmarkBrowser(f,'bookmark-account-b');
    assert.deepEqual(a.session.linkedIds,[]);assert.deepEqual(b.session.linkedIds,[]);
    const input=command(reference),ack=await a.ok('command',input);
    assert.equal(ack.bookmark.saved,true);
    const page=await a.ok('query',{category:'community'});assert.equal(page.accountId,a.session.account.id);assert.equal(page.items.length,1);
    assert.equal(page.items[0].source.state,'available');assert.equal(page.items[0].source.title,post.title);
    assert.equal(page.items[0].source.path,'/app/community/posts/'+post.postId);
    assert.deepEqual((await a.ok('query',{category:'private-chat'})).items,[]);
    assert.deepEqual((await b.ok('query',{})).items,[]);assert.equal((await b.ok('status',{reference})).saved,false);
    const receipt={operationId:input.operationId,payloadHash:digest(JSON.stringify(input))};
    assert.equal((await b.ok('receipt',receipt)).state,'absent');
    assert.equal((await a.request('command',command(reference,false,1),{'X-Galaxy-Account-CSRF':'not-valid'})).status,403);
    assert.equal((await a.request('query',{}, {'X-Galaxy-Account-ID':b.session.account.id})).body.error,'official_account_changed');
    assert.equal((await a.request('query',{}, {Authorization:'Bearer invalid'})).status,401);
    const rows=(await f.db.query('SELECT reference,origin_subject_id FROM account_reading_bookmarks_v2 WHERE account_id=$1',[a.session.account.id])).rows;
    assert.equal(rows[0].origin_subject_id,null);assert.deepEqual(rows[0].reference,reference);
    const operations=(await f.db.query('SELECT result,authorization_kind FROM account_reading_bookmark_operations_v2 WHERE account_id=$1',[a.session.account.id])).rows;
    assert.equal(operations[0].authorization_kind,'official-account');assert.ok(!JSON.stringify({rows,operations}).includes(post.body));assert.ok(!JSON.stringify({rows,operations}).includes(post.title));
  }finally{await f.close();}
});

test('account save receipts cannot revive cancellation and position cursors survive removal without crossing owners',async()=>{
  const f=await communityForumFixture({officialAccountPortal:true});try{
    await f.login(f.owner,'bookmark-pages-author');const sources=[];
    for(let i=0;i<3;i++)sources.push(await source(f,{title:'Page '+i}));
    const a=await accountBookmarkBrowser(f,'bookmark-pages-a'),b=await accountBookmarkBrowser(f,'bookmark-pages-b');
    const first=command(sources[0].reference);await a.ok('command',first);
    for(const item of sources.slice(1))await a.ok('command',command(item.reference));
    const page=await a.ok('query',{limit:1});assert.match(page.nextAfter,/^rb2\./);
    await a.ok('command',command(page.items[0].reference,false,page.items[0].revision));
    await f.db.query('DELETE FROM account_reading_bookmarks_v2 WHERE id=$1',[page.items[0].id]);
    const next=await a.ok('query',{limit:1,after:page.nextAfter});assert.equal(next.items.length,1);assert.notEqual(next.items[0].id,page.items[0].id);
    assert.equal((await b.request('query',{limit:1,after:page.nextAfter})).status,409);
    const current=await a.ok('status',{reference:sources[0].reference});
    if(current.saved)await a.ok('command',command(sources[0].reference,false,current.revision));
    const original=await a.ok('command',first);assert.equal(original.bookmark.saved,true);
    assert.equal((await a.ok('status',{reference:sources[0].reference})).saved,false);
    assert.equal((await a.request('command',{...first,saved:false})).body.error,'reading_bookmark_operation_conflict');
    const item=sources[1],withdraw={schemaVersion:1,operationId:randomUUID(),postId:item.post.postId,expectedHeadVersion:1};
    assert.equal((await f.write(f.owner,'withdraw-post',withdraw)).status,200);
    const stale=(await a.ok('query',{})).items.find(row=>row.reference.postId===item.post.postId);
    if(stale){assert.equal(stale.source.state,'unavailable');assert.ok(!JSON.stringify(stale).includes(item.post.body));await a.ok('command',command(item.reference,false,stale.revision));}
    assert.equal((await a.request('command',command(item.reference,true,(await a.ok('status',{reference:item.reference})).revision))).status,404);
  }finally{await f.close();}
});

test('ID proxy targets an effective account while old subject bookmarks stay separate and unlink immediately stops account use',async()=>{
  const f=await communityForumFixture({officialAccountPortal:true});try{
    const a=await accountBookmarkBrowser(f,'bookmark-proxy-a');await f.login(f.owner,'bookmark-proxy-a');
    const {reference}=await source(f),legacyId=randomUUID(),at=new Date(f.clock.now*1000).toISOString();
    // An existing historical subject locator is not evidence of account ownership.
    await f.db.query(`INSERT INTO reading_bookmarks_v1(id,subject_id,reference_key,reference,saved,revision,created_at,saved_at,updated_at)
      VALUES($1,$2,$3,$4,true,1,$5,$5,$5)`,[legacyId,f.owner.actor.subjectId,'forum-post:'+reference.postId,JSON.stringify(reference),at]);
    const b=await accountBookmarkBrowser(f,'bookmark-proxy-b');await f.login(f.owner,'bookmark-proxy-b');
    assert.deepEqual((await a.ok('query',{})).items,[]);assert.deepEqual((await b.ok('query',{})).items,[]);
    assert.equal((await signed(f,null,'command',command(reference))).body.error,'account_selection_required');
    assert.equal((await signed(f,b.session.account.id,'command',command(reference))).status,200);
    assert.equal((await b.ok('query',{})).items.length,1);assert.deepEqual((await a.ok('query',{})).items,[]);
    assert.equal((await signed(f,b.session.account.id,'query',{},f.responder)).status,403,'a bare ID has no account capability');
    const link=(await f.ok('/v1/identity/query',{input:{}})).items.find(row=>row.externalSubject==='bookmark-proxy-b');assert.ok(link);
    await f.ok('/v1/identity/revoke',{input:{id:link.id}});
    assert.equal((await signed(f,b.session.account.id,'query',{})).status,403);
    assert.equal((await b.ok('query',{})).items.length,1,'account owner retains its private collection');
    assert.equal((await f.db.query('SELECT count(*)::int n FROM reading_bookmarks_v1 WHERE id=$1',[legacyId])).rows[0].n,1,'historical source locator is not reassigned or destroyed');
  }finally{await f.close();}
});
