import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ProsodyChatTransport} from '../src/infrastructure/prosody-chat.mjs';
import {ChatSharedSummaryService} from "../src/chat/chat-shared-summaries.mjs";
import {sharedSummaryRequestHash} from "../src/clients/chat-shared-summary.mjs";
import {ServiceError} from '../src/shared/service-error.mjs';
import {chatFixture,invite} from './chat-workflow.mjs';

test('isolated real Prosody confirms the same shared-notice erase after a lost cleanup acknowledgement and departure',{timeout:60000},async()=>{
 assert.equal(process.env.GALAXY_TEST_CHAT_ISOLATED,'1','Explicit isolated Prosody profile required; do not use the running API component');
 const transport=new ProsodyChatTransport({service:process.env.GALAXY_TEST_CHAT_SERVICE??'xmpp://127.0.0.1:5347',domain:'gateway.galaxy.internal',roomsDomain:'rooms.galaxy.internal',
  secret:(await readFile(process.env.GALAXY_TEST_CHAT_SECRET_FILE,'utf8')).trim()});
 let f;
 try{await transport.start();f=await chatFixture({transport});const[a,b]=f.people,roomId=randomUUID(),shared=new ChatSharedSummaryService({db:f.db,access:f.chat.access,chat:f.chat,now:f.now});
  await f.chat.create(a,{roomId,operationId:randomUUID(),title:'Synthetic selected shared-notice cleanup'});await invite(f.chat,a,roomId,b);
  const request={shareId:randomUUID(),roomId,expectedMemberRevision:2,audience:'room-authorized-members',content:{generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'0',complete:false},
   fragments:[{id:randomUUID(),kind:'personal-note',text:'Selected synthetic explanation stored separately from MAM',sourceRefs:[]}],keyMessageRefs:[]}};
  const query={roomId,shareId:request.shareId,requestHash:await sharedSummaryRequestHash(request)},published=await shared.publish(b,request);
  const archived=await transport.exportOwn({roomId,subjectId:b.subjectId,ids:[published.messageId]});assert.equal(archived.length,1);assert.equal(archived[0].text.includes(request.content.fragments[0].text),false);
  const realErase=transport.erase.bind(transport);let loseAck=true;const targets=[];
  transport.erase=async input=>{targets.push(input);const acknowledgement=await realErase(input);assert.equal(acknowledgement.archiveDeleted,true,'Actual Prosody returns the strict positive archive ACK');
   if(loseAck){loseAck=false;throw new ServiceError('chat_delivery_unknown',504);}return acknowledgement;};
  const unknown=await shared.retract(b,{roomId,shareId:request.shareId});assert.equal(unknown.noticeArchiveDeleted,false);assert.equal(unknown.noticeCleanupPending,true);
  await f.chat.leave(b,roomId);const pending=await shared.receipt(b,query);assert.equal(pending.state,'retracted');assert.equal(pending.noticeCleanupState,'pending');assert.equal(pending.contentReturned,false);
  assert.equal((await transport.exportOwn({roomId,subjectId:b.subjectId,ids:[published.messageId]})).length,0,'The external erase happened even though its original acknowledgement was lost');
  const stopped=await shared.retract(b,{roomId,shareId:request.shareId});assert.equal(stopped.noticeArchiveDeleted,true);assert.equal(stopped.noticeCleanupPending,false);
  assert.deepEqual(targets,[{roomId,messageId:published.messageId},{roomId,messageId:published.messageId}]);
  const receipt=await shared.receipt(b,query);assert.equal(receipt.noticeCleanupState,'recorded-complete');assert.equal(receipt.archiveScope,'shared-summary-notice-only');assert.equal(receipt.othersReadStatus,'not-asserted');
  assert.equal((await transport.exportOwn({roomId,subjectId:b.subjectId,ids:[published.messageId]})).length,0);
  console.log(JSON.stringify({event:'shared_summary_real_prosody_cleanup_verified',transport:'isolated-Prosody-MUC-MAM',metadataDatabase:'PGlite',strictArchiveAck:true,lostAckRemainedPending:true,sameTargetAfterDeparture:true,oldBodyReturned:false,actualHostDeliveryVerified:false}));
 }finally{if(f)await f.close();await transport.stop();}
});
