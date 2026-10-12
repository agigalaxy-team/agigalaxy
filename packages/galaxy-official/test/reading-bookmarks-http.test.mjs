import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {seedReadingBookmarkSources} from './reading-bookmarks-sources-fixture.mjs';
import {digest} from '../src/shared/digest.mjs';
import {readingBookmarkPath} from '../src/shared/reading-bookmarks-v1-schema.mjs';

const scopes=['binding','consent','assistance','moderation','data-export','data-delete','history','case-teaser','context','notifications','capsules'];
const route='/v2/reading-bookmarks/';
const save=(reference,saved=true,expectedRevision=0)=>({operationId:randomUUID(),reference,saved,expectedRevision});
async function setup(run){
  const f=await communityForumFixture({scopes});
  try{await f.login(f.owner,'bookmark-author');await run(f);}finally{await f.close();}
}
async function sources(f,count=1){
  const submit=async(path,payload,action)=>{
    const input=await f.owner.authorize(payload,action,{objectId:payload.eventId??payload.operationId??payload.id,visibility:'Public',purpose:'public-profile'});
    const result=await f.ok(path,{input});return {consentId:input.consentId,payloadHash:digest(input.payloadJson),result};
  };
  const corpus=await seedReadingBookmarkSources({subjectId:f.owner.actor.subjectId,submit,now:f.clock.now,count});
  const profile={id:randomUUID(),expectedRevision:0,selfDeclared:{displayName:'[合成] 资料作者',about:'目前允许阅读的个人说明。'}};
  const profileWrite=await submit('/v1/profiles/statements',profile,'profile.publish');
  const post=await f.post({title:'[合成] 阅读原帖',body:'这里是需要稍后回看的原帖正文。',topic:'learning'});
  assert.equal((await f.write(f.owner,'create-post',post)).status,200);
  return {...corpus,profileWrite,post,references:[{kind:'forum-post',postId:post.postId},corpus.capsules[0].reference,corpus.projects[0].reference,{kind:'person',subjectId:f.owner.actor.subjectId}]};
}

test('normal signed HTTP: four exact references are private across identities, shared across same-subject devices, and late ACK never revives cancellation',{timeout:60000},()=>setup(async f=>{
  const data=await sources(f),beforePreferences=await f.owner.notifications.preferences(f.owner.actor),commands=[];
  for(const reference of data.references){
    const command=save(reference),ack=await f.ok(route+'command',{input:command});
    assert.equal(ack.state,'acknowledged');assert.deepEqual(ack.bookmark.reference,reference);commands.push(command);
  }
  const deviceA={...f.owner};await f.reconnect(f.owner,scopes);
  assert.notEqual(f.owner.actor.bindingId,deviceA.actor.bindingId);assert.equal(f.owner.actor.subjectId,deviceA.actor.subjectId);
  const page=await f.ok(route+'query',{input:{}});assert.equal(page.visibility,'Private');assert.equal(page.items.length,4);
  for(const reference of data.references){const item=page.items.find(row=>JSON.stringify(row.reference)===JSON.stringify(reference));assert.equal(item.source.state,'available');assert.equal(item.source.path,readingBookmarkPath(reference));}
  assert.equal(readingBookmarkPath(data.references[0]),'/app/community/posts/'+data.post.postId);
  const other=await f.ok(route+'query',{who:f.responder,input:{}});assert.deepEqual(other.items,[]);
  const locator={operationId:commands[0].operationId,payloadHash:digest(JSON.stringify(commands[0]))};
  assert.equal((await f.ok(route+'receipt',{who:f.responder,input:locator})).state,'absent');
  const unauthorized=await f.request(route+'query',{authorization:false,input:{}});assert.equal(unauthorized.status,401);
  assert.equal((await f.request(route+'query',{input:{subjectId:deviceA.actor.subjectId}})).status,400);
  const removed=save(data.references[0],false,1);await f.ok(route+'command',{input:removed});
  assert.equal((await f.ok(route+'command',{who:deviceA,input:commands[0]})).bookmark.saved,true,'original ACK describes the original accepted save');
  assert.equal((await f.ok(route+'status',{input:{reference:data.references[0]}})).saved,false,'current choice remains removed');
  assert.equal((await f.ok(route+'query',{input:{}})).items.length,3);
  assert.deepEqual(await f.owner.notifications.preferences(f.owner.actor),beforePreferences,'bookmark intent does not change notification settings');
  const stored=(await f.db.query('SELECT reference FROM reading_bookmarks_v1 WHERE subject_id=$1',[deviceA.actor.subjectId])).rows;
  assert.ok(!JSON.stringify(stored).includes(data.post.body));assert.ok(!JSON.stringify(stored).includes(data.post.title));
  const beforeCount=(await f.db.query('SELECT count(*)::int n FROM reading_bookmark_operations_v1')).rows[0].n;
  assert.equal((await f.ok(route+'receipt',{input:locator})).state,'acknowledged');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM reading_bookmark_operations_v1')).rows[0].n,beforeCount);
}));

test('source revocation or expiry keeps locators but never returns prior text; failure is temporary, and removal requires no new source grant',{timeout:60000},()=>setup(async f=>{
  const data=await sources(f);
  for(const reference of data.references)await f.ok(route+'command',{input:save(reference)});
  await f.owner.consents.revoke(f.owner.actor,data.capsules[0].consentId);
  await f.owner.consents.revoke(f.owner.actor,data.profileWrite.consentId);
  const withdraw={schemaVersion:1,operationId:randomUUID(),postId:data.post.postId,expectedHeadVersion:1};
  assert.equal((await f.write(f.owner,'withdraw-post',withdraw)).status,200);
  const row=await f.ok(route+'query',{input:{kind:'project'}});assert.equal(row.items[0].source.state,'available');
  await f.db.query('UPDATE consents SET expires_at=$2 WHERE id=$1',[data.projects[0].consentId,new Date((f.clock.now+2)*1000).toISOString()]);
  const short=await f.ok(route+'query',{input:{kind:'project'}});assert.equal(short.items[0].source.availableUntil,f.clock.now+2);
  f.clock.now+=3;
  const unavailable=await f.ok(route+'query',{input:{}});assert.equal(unavailable.items.length,4);assert.ok(unavailable.items.every(item=>item.source.state==='unavailable'));
  assert.ok(!JSON.stringify(unavailable).includes(data.post.title));assert.ok(!JSON.stringify(unavailable).includes(data.capsules[0].title));assert.ok(!JSON.stringify(unavailable).includes(data.projects[0].title));
  assert.equal(unavailable.items.find(item=>item.reference.kind==='forum-post').source.reason,'source-withdrawn');
  for(const reference of data.references){const ack=await f.ok(route+'command',{input:save(reference,false,1)});assert.equal(ack.bookmark.saved,false);}
  assert.deepEqual((await f.ok(route+'query',{input:{}})).items,[]);
  const missing={kind:'project',projectId:randomUUID()};assert.equal((await f.request(route+'command',{input:save(missing)})).body.error,'reading_bookmark_source_unavailable');
}));

test('complete private keyset pages and object CAS reject foreign cursors and stale opposing intent without touching original source bytes',{timeout:60000},()=>setup(async f=>{
  const data=await sources(f,4),references=data.projects.map(row=>row.reference);
  for(const reference of references)await f.ok(route+'command',{input:save(reference)});
  const first=await f.ok(route+'query',{input:{kind:'project',limit:2}}),second=await f.ok(route+'query',{input:{kind:'project',limit:2,after:first.nextAfter}});
  assert.equal(first.items.length,2);assert.equal(second.items.length,2);assert.equal(second.nextAfter,null);assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,4);
  assert.equal((await f.request(route+'query',{who:f.responder,input:{after:first.nextAfter}})).body.error,'reading_bookmark_cursor_unavailable');
  const original=save(references[0],false,1);await f.ok(route+'command',{input:original});
  const stale=await f.request(route+'command',{input:save(references[0],true,1)});assert.equal(stale.status,409);assert.equal(stale.body.error,'reading_bookmark_changed');
  assert.equal((await f.ok(route+'status',{input:{reference:references[0]}})).saved,false);
  const conflict=await f.request(route+'command',{input:{...original,saved:true}});assert.equal(conflict.status,409);assert.equal(conflict.body.error,'reading_bookmark_operation_conflict');
  const rows=(await f.db.query('SELECT result FROM reading_bookmark_operations_v1')).rows;
  assert.ok(rows.every(row=>!JSON.stringify(row).includes('[本地合成]')));
}));
