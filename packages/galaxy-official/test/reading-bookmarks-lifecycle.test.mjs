import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {approveFixtureDeletion} from './deletion-execute-workflow.mjs';
import {executeDeletion} from '../src/operations/deletion-execute.mjs';

test('ordinary private bookmarks export only owner locators and receipts, and account deletion preserves another reader’s bookmark',{timeout:60000},async()=>{
 const f=await communityForumFixture();
 try{
  await f.login(f.owner,'bookmark-lifecycle-source');
  const post=await f.post({topic:'learning',title:'PRIVATE_BOOKMARK_SOURCE_TITLE',body:'ORIGINAL_SOURCE_BODY_NOT_COPIED_INTO_BOOKMARK_EXPORT'});
  assert.equal((await f.write(f.owner,'create-post',post)).status,200);
  const reference={kind:'forum-post',postId:post.postId};
  const command=(who,saved,expectedRevision)=>f.ok('/v2/reading-bookmarks/command',{who,input:{operationId:randomUUID(),reference,saved,expectedRevision}});
  await command(f.owner,true,0);await command(f.owner,false,1);await command(f.responder,true,0);
  const ticket=await f.owner.dataExport.create(f.owner.actor,{id:randomUUID(),datasets:['reading-bookmarks','reading-bookmark-operations']});
  const bookmarks=await f.owner.dataExport.page(f.owner.actor,{id:ticket.id,dataset:'reading-bookmarks'});
  const operations=await f.owner.dataExport.page(f.owner.actor,{id:ticket.id,dataset:'reading-bookmark-operations'});
  assert.equal(bookmarks.items.length,1);assert.equal(bookmarks.items[0].saved,false);
  assert.deepEqual(bookmarks.items[0].reference,reference);assert.equal(operations.items.length,2);
  for(const row of [...bookmarks.items,...operations.items])assert.equal(row.subject_id,f.owner.actor.subjectId);
  assert.ok(!JSON.stringify({bookmarks,operations}).includes(post.body));assert.ok(!JSON.stringify({bookmarks,operations}).includes(post.title));
  const deletion=await approveFixtureDeletion(f.owner,f.db,{auditUntil:f.clock.now+60});
  await executeDeletion(f.db,deletion,{now:()=>f.clock.now});
  for(const table of ['reading_bookmarks_v1','reading_bookmark_operations_v1']){
   assert.equal((await f.db.query('SELECT count(*)::int n FROM '+table+' WHERE subject_id=$1',[f.owner.actor.subjectId])).rows[0].n,0);
   assert.equal((await f.db.query('SELECT count(*)::int n FROM '+table+' WHERE subject_id=$1',[f.responder.actor.subjectId])).rows[0].n,1);
  }
  const retained=await f.ok('/v2/reading-bookmarks/query',{who:f.responder,input:{}});
  assert.deepEqual(retained.items[0].reference,reference);assert.equal(retained.items[0].source.state,'unavailable');
  assert.ok(!JSON.stringify(retained).includes(post.body));
 }finally{await f.close();}
});
