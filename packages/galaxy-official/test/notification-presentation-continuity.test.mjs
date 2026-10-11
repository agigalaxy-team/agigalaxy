import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {summaryFixture} from './personal-summary-workflow.mjs';

test('a displayed original notification can be acknowledged after mute, human read or source withdrawal without replaying its content',async()=>{
 const f=await summaryFixture();try{const {inbox,roomId,message,people:[a,b,c]}=f;
  const claim=id=>({id,deliveryClientId:randomUUID(),claimId:randomUUID()}),first=claim('room-message:'+message.messageId);
  assert.equal((await inbox.claim(b,first)).claimed,true);
  await inbox.saveOptions(b,{expectedRevision:0,settings:{mutedRoomIds:[roomId]}});
  const mutedAck=await inbox.presented(b,first);assert.equal(mutedAck.presented,true);assert.equal(mutedAck.humanReadChanged,false);assert.equal(mutedAck.read,false);
  assert.equal(JSON.stringify(mutedAck).includes('Compare two valid approaches'),false);
  await inbox.saveOptions(b,{expectedRevision:1,settings:{}});
  f.advance(31);assert.equal((await inbox.claim(b,claim(first.id))).claimed,false,'The original display prevents another device from prompting again after unmute');
  assert.equal((await inbox.query(b)).items.find(item=>item.id===first.id).read,false,'Displayed ACK never marks human read');

  const secondMessage=await f.chat.send(a,roomId,{clientMessageId:randomUUID(),text:'Explicit human reading remains independent'}),second=claim('room-message:'+secondMessage.messageId);
  assert.equal((await inbox.claim(b,second)).claimed,true);await inbox.markRead(b,{id:second.id,reader:'human'});
  const readAck=await inbox.presented(b,second);assert.equal(readAck.presented,true);assert.equal(readAck.humanReadChanged,false);assert.equal(readAck.read,true);

  const thirdMessage=await f.chat.send(a,roomId,{clientMessageId:randomUUID(),text:'Withdrawn content must never return in old receipts'}),third=claim('room-message:'+thirdMessage.messageId);
  assert.equal((await inbox.claim(b,third)).claimed,true);await f.chat.retract(a,roomId,thirdMessage.messageId);
  const withdrawnAck=await inbox.presented(b,third);assert.equal(withdrawnAck.presented,true);assert.equal(JSON.stringify(withdrawnAck).includes('Withdrawn content'),false);
  assert.equal((await inbox.query(b)).items.some(item=>item.id===third.id),false);
  await assert.rejects(inbox.claim(b,claim(third.id)),{code:'notification_not_found'});
  assert.equal((await inbox.presented(c,third)).presented,false,'Another subject cannot acknowledge the owned original claim');
 }finally{await f.close();}
});

test('expired or replaced presentation claims cannot consume a new device lease',async()=>{
 const f=await summaryFixture();try{const {inbox,message,people:[,b]}=f,id='room-message:'+message.messageId;
  const old={id,deliveryClientId:randomUUID(),claimId:randomUUID()},next={id,deliveryClientId:randomUUID(),claimId:randomUUID()};
  assert.equal((await inbox.claim(b,old)).claimed,true);f.advance(31);
  assert.equal((await inbox.presented(b,old)).presented,false,'An unacknowledged expired lease is not a display receipt');
  assert.equal((await inbox.claim(b,next)).claimed,true);
  assert.equal((await inbox.presented(b,old)).presented,false);
  assert.equal((await inbox.presented(b,{...next,deliveryClientId:old.deliveryClientId})).presented,false);
  assert.equal((await inbox.presented(b,{...next,claimId:old.claimId})).presented,false);
  assert.equal((await inbox.presented(b,next)).presented,true);f.advance(31);
  assert.equal((await inbox.presented(b,next)).presented,true,'Exact acknowledged originals are idempotent after the original lease');
  assert.equal((await inbox.presented(b,old)).presented,false);
 }finally{await f.close();}
});
