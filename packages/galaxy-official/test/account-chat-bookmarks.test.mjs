import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {ReadingBookmarksV1} from "../src/accounts/reading-bookmarks-v1.mjs";
import {ServiceError} from '../src/shared/service-error.mjs';

// Real account/SQL/source authorization. The fixture transport is an explicit
// RAM contract, not evidence of delivery through a running Prosody service.
test('private-chat account bookmarks read the current source and retain only locators after hide, withdrawal, expiry or leaving',async t=>{
  const f=await accountChatFixture();t.after(f.close);
  const[a,b,c]=f.people,roomId=await joinAccountConversation(f,a,b),bookmarks=new ReadingBookmarksV1(f.access,{accounts:f.accounts,chat:f.chat});
  const references=[];
  for(const text of ['Original discussion point','A second point','An expiring point','A point to revisit']){
    const sent=await f.chat.send(a,roomId,{clientMessageId:randomUUID(),text});
    const reference={kind:'chat-message',roomId,messageId:sent.messageId};references.push(reference);
    await bookmarks.accountCommand(b,{operationId:randomUUID(),reference,saved:true,expectedRevision:0});
  }
  let page=await bookmarks.accountQuery(b,{category:'private-chat'});
  assert.equal(page.items.length,4);assert.ok(page.items.every(item=>item.source.state==='available'));
  assert.ok(page.items.every(item=>item.source.path==='/app/rooms/'+roomId+'?message='+item.reference.messageId));
  assert.deepEqual((await bookmarks.accountQuery(b,{category:'community'})).items,[]);
  assert.deepEqual((await bookmarks.accountQuery(a,{})).items,[]);
  await assert.rejects(bookmarks.accountCommand(c,{operationId:randomUUID(),reference:references[0],saved:true,expectedRevision:0}),{code:'reading_bookmark_source_unavailable'});
  await f.chat.edit(a,roomId,references[0].messageId,{operationId:randomUUID(),expectedRevision:1,text:'Revised discussion point'});
  const edited=(await bookmarks.accountQuery(b,{})).items.find(item=>item.reference.messageId===references[0].messageId);
  assert.equal(edited.source.revision,2);assert.equal(edited.source.summary,'Revised discussion point');
  const originalRead=f.transport.read.bind(f.transport);f.transport.read=async()=>{throw new ServiceError('chat_transport_unavailable',503);};
  page=await bookmarks.accountQuery(b,{});assert.ok(page.items.every(item=>item.source.state==='temporarily-unavailable'));
  assert.ok(!JSON.stringify(page).includes('Revised discussion point'));f.transport.read=originalRead;
  await f.chat.hide(b,roomId,references[0].messageId);await f.chat.retract(a,roomId,references[1].messageId);
  await f.db.query('UPDATE chat_message_refs SET expires_at=$2 WHERE message_id=$1',[references[2].messageId,new Date((f.now()-1)*1000).toISOString()]);
  page=await bookmarks.accountQuery(b,{});
  assert.equal(page.items.find(item=>item.reference.messageId===references[0].messageId).source.reason,'source-not-readable');
  assert.equal(page.items.find(item=>item.reference.messageId===references[1].messageId).source.reason,'source-withdrawn');
  assert.equal(page.items.find(item=>item.reference.messageId===references[2].messageId).source.reason,'source-expired');
  await f.chat.leave(b,roomId);page=await bookmarks.accountQuery(b,{});
  assert.equal(page.items.length,4);assert.ok(page.items.every(item=>item.source.state==='unavailable'));
  assert.ok(!JSON.stringify(page).includes('discussion point'));
  for(const reference of references)await bookmarks.accountCommand(b,{operationId:randomUUID(),reference,saved:false,expectedRevision:1});
  assert.deepEqual((await bookmarks.accountQuery(b,{})).items,[]);
  const stored=(await f.db.query('SELECT reference,origin_subject_id FROM account_reading_bookmarks_v2 WHERE account_id=$1',[b.accountId])).rows;
  assert.equal(stored.length,4);assert.ok(stored.every(row=>row.origin_subject_id===null));
  assert.ok(!JSON.stringify(stored).includes('discussion point'));
  assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM subjects')).rows[0].n),0);
});
