import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chatFixture,invite} from './chat-workflow.mjs';
import {chatRoomGovernanceV2MigrationSql} from '../src/infrastructure/chat-room-governance-v2-schema.mjs';

const input=(room,action,extra={})=>({decisionId:randomUUID(),expectedRevision:room.revision,action,...extra});
async function common(chat,people,roomId,action,extra={}){
 const proposal=input(await chat.get(people[0],roomId),action,extra);let result=await chat.proposeDecision(people[0],roomId,proposal);
 for(const person of people.slice(1))result=await chat.voteDecision(person,roomId,{decisionId:proposal.decisionId,choice:'approve'});
 return{proposal,result};
}
async function roomFixture(){
 const f=await chatFixture({transport:{available:true,project:async()=>{},send:async x=>({archiveId:x.messageId}),read:async()=>[]}}),roomId=randomUUID();
 if(!(await f.db.query("SELECT 1 FROM information_schema.columns WHERE table_name='chat_rooms' AND column_name='join_rule'")).rows.length)await f.db.exec(chatRoomGovernanceV2MigrationSql);
 await f.chat.create(f.people[0],{roomId,operationId:randomUUID(),title:'Synthetic shared governance'});
 await invite(f.chat,f.people[0],roomId,f.people[1]);await invite(f.chat,f.people[0],roomId,f.people[2],[f.people[1]]);
 return{...f,roomId};
}

test('standing shared join rules require common agreement and replace repeated old-member votes only inside their exact scope',async()=>{
 const f=await roomFixture();try{
  const{chat,people:[a,b,c],roomId}=f,rule=input(await chat.get(a,roomId),'join-rule',{joinRule:{mode:'member-invite',expiresAt:f.now()+60}});
  await chat.proposeDecision(a,roomId,rule);await chat.voteDecision(b,roomId,{decisionId:rule.decisionId,choice:'approve'});
  assert.equal((await chat.get(a,roomId)).joinRule.mode,'approval-required');
  await chat.voteDecision(c,roomId,{decisionId:rule.decisionId,choice:'approve'});
  const applied=await chat.get(a,roomId);assert.equal(applied.joinRule.mode,'member-invite');assert.equal(applied.joinRule.decisionId,rule.decisionId);
  const outsiders=await chatFixture({database:f.db,migrateDatabase:false}),[d,e]=outsiders.people;
  const invitation=input(applied,'invite',{targetSubjectId:d.subjectId}),approved=await chat.proposeDecision(b,roomId,invitation);
  assert.equal(approved.state,'approved');assert.equal(approved.requiredPartyCount,1);assert.equal(approved.joinRuleAuthorization.version,applied.joinRule.version);
  await assert.rejects(chat.get(d,roomId),/chat_access_denied/);await chat.acceptInvite(d,roomId,{decisionId:invitation.decisionId});
  assert.equal((await chat.get(d,roomId)).members.length,4,'Standing permission never joins someone before their own acceptance');
  const old=input(await chat.get(a,roomId),'invite',{targetSubjectId:e.subjectId});await chat.proposeDecision(a,roomId,old);
  f.advance(61);await assert.rejects(chat.acceptInvite(e,roomId,{decisionId:old.decisionId}),/chat_join_rule_changed/);
  assert.equal((await chat.invitations(e)).invitations.length,0);assert.equal((await chat.get(a,roomId)).joinRule.effectiveMode,'approval-required');
  await common(chat,[a,b,c,d],roomId,'join-rule',{joinRule:{mode:'member-invite'}});
  const pending=input(await chat.get(a,roomId),'invite',{targetSubjectId:e.subjectId});await chat.proposeDecision(a,roomId,pending);
  await common(chat,[a,b,c,d],roomId,'join-rule',{joinRule:{mode:'approval-required'}});
  await assert.rejects(chat.acceptInvite(e,roomId,{decisionId:pending.decisionId}),/chat_membership_changed/);
  assert.equal((await chat.invitations(e)).invitations.length,0);
 }finally{await f.close();}
});

test('administrator designation requires affected parties and the recipient acceptance without granting private or Agent control',async()=>{
 const f=await roomFixture();try{
  const{chat,people:[a,b,c],roomId}=f,ownership=await common(chat,[a,b,c],roomId,'become-owner',{targetSubjectId:a.subjectId});
  await chat.acceptInvite(a,roomId,{decisionId:ownership.proposal.decisionId});
  const appoint=await common(chat,[a,b,c],roomId,'appoint-admin',{targetSubjectId:b.subjectId});
  assert.deepEqual((await chat.get(a,roomId)).administratorSubjectIds,[]);
  await chat.acceptInvite(b,roomId,{decisionId:appoint.proposal.decisionId});
  assert.deepEqual((await chat.get(a,roomId)).administratorSubjectIds,[b.subjectId]);
  const view=await chat.get(b,roomId);assert.equal(view.managementAuthority.privateMaterialsGranted,false);assert.equal(view.managementAuthority.otherAgentControlGranted,false);
  await common(chat,[a,b,c],roomId,'join-rule',{joinRule:{mode:'manager-invite'}});
  const outsiders=await chatFixture({database:f.db,migrateDatabase:false}),[d,e]=outsiders.people;
  await assert.rejects(chat.proposeDecision(c,roomId,input(await chat.get(c,roomId),'invite',{targetSubjectId:d.subjectId})),/chat_manager_required/);
  const inviteByAdmin=input(await chat.get(b,roomId),'invite',{targetSubjectId:d.subjectId});assert.equal((await chat.proposeDecision(b,roomId,inviteByAdmin)).state,'approved');
  await chat.acceptInvite(d,roomId,{decisionId:inviteByAdmin.decisionId});
  await assert.rejects(chat.proposeDecision(b,roomId,input(await chat.get(b,roomId),'transfer-owner',{targetSubjectId:c.subjectId})),/chat_owner_required/);
  await common(chat,[a,b,c,d],roomId,'revoke-admin',{targetSubjectId:b.subjectId});
  await assert.rejects(chat.proposeDecision(b,roomId,input(await chat.get(b,roomId),'invite',{targetSubjectId:e.subjectId})),/chat_manager_required/);
  assert.deepEqual((await chat.get(a,roomId)).administratorSubjectIds,[]);
 }finally{await f.close();}
});

test('ownerless succession has a real common nomination path and unrelated departures never reset its seven-day deadline',async()=>{
 const f=await roomFixture();try{
  const{chat,people:[a,b,c],roomId}=f,ownership=await common(chat,[a,b,c],roomId,'become-owner',{targetSubjectId:a.subjectId});
  await chat.acceptInvite(a,roomId,{decisionId:ownership.proposal.decisionId});
  const message=await chat.send(b,roomId,{clientMessageId:randomUUID(),text:'Existing message keeps its original TTL'});
  await chat.leave(a,roomId);
  const start=(await chat.get(b,roomId)).successionExpiresAt;assert.ok(start);
  await assert.rejects(chat.send(b,roomId,{clientMessageId:randomUUID(),text:'Must stay read-only'}),/room_read_only/);
  f.advance(120);await chat.leave(c,roomId);assert.equal(Date.parse((await chat.get(b,roomId)).successionExpiresAt),Date.parse(start));
  const successor=await common(chat,[b],roomId,'successor-owner',{targetSubjectId:b.subjectId});
  const retention=(await chat.get(b,roomId)).retentionDays;
  await chat.acceptInvite(b,roomId,{decisionId:successor.proposal.decisionId});assert.equal((await chat.get(b,roomId)).ownerSubjectId,b.subjectId);
  assert.equal((await chat.get(b,roomId)).retentionDays,retention);
  assert.equal(Date.parse((await chat.messageStatus(b,roomId,{clientMessageId:message.clientMessageId})).expiresAt),Date.parse(message.expiresAt));
 }finally{await f.close();}
});

test('current independent control parties vote once and governance change invalidates a concurrent prepared appointment',async()=>{
 const f=await roomFixture();try{
  const{chat,people:[a,b,c],roomId}=f;
  const ownership=await common(chat,[a,b,c],roomId,'become-owner',{targetSubjectId:a.subjectId});await chat.acceptInvite(a,roomId,{decisionId:ownership.proposal.decisionId});
  const first=await common(chat,[a,b,c],roomId,'appoint-admin',{targetSubjectId:b.subjectId}),second=await common(chat,[a,b,c],roomId,'appoint-admin',{targetSubjectId:c.subjectId});
  await chat.acceptInvite(b,roomId,{decisionId:first.proposal.decisionId});
  await assert.rejects(chat.acceptInvite(c,roomId,{decisionId:second.proposal.decisionId}),/chat_membership_changed/);
  const outsider=(await chatFixture({database:f.db,migrateDatabase:false})).people[0];
  const oldInvite=await common(chat,[a,b,c],roomId,'invite',{targetSubjectId:outsider.subjectId});
  assert.equal((await chat.invitations(outsider)).invitations.length,1);
  const previousView=await chat.get(a,roomId);chat.resolveControlParty=async(_db,id)=>id===a.subjectId?'verified-controller:a':'verified-controller:bc';
  const preview=await chat.get(a,roomId);assert.equal(preview.independentMemberCount,2);
  assert.equal((await chat.invitations(outsider)).invitations.length,0,'Old persisted member revision cannot expose a stale current invitation');
  await assert.rejects(chat.acceptInvite(outsider,roomId,{decisionId:oldInvite.proposal.decisionId}),/chat_membership_changed/);
  await assert.rejects(chat.proposeDecision(a,roomId,input(previousView,'join-rule',{joinRule:{mode:'member-invite'}})),/chat_revision_conflict/);
  const rule=input(await chat.get(a,roomId),'join-rule',{joinRule:{mode:'member-invite'}});
  const proposal=await chat.proposeDecision(a,roomId,rule);assert.equal(proposal.requiredPartyCount,2);
  const complete=await chat.voteDecision(c,roomId,{decisionId:rule.decisionId,choice:'approve'});assert.equal(complete.state,'accepted');assert.equal(complete.votes.length,2);
 }finally{await f.close();}
});

test('expired succession cannot nominate a new owner even before the maintenance worker runs',async()=>{
 const f=await roomFixture();try{
  const{chat,people:[a,b,c],roomId}=f,ownership=await common(chat,[a,b,c],roomId,'become-owner',{targetSubjectId:a.subjectId});await chat.acceptInvite(a,roomId,{decisionId:ownership.proposal.decisionId});await chat.leave(a,roomId);
  const deadline=(await chat.get(b,roomId)).successionExpiresAt;assert.equal(Date.parse(deadline)-f.now()*1000,7*86400000);
  // Privileged fixture expiry represents the seven-day-old room while keeping
  // these newly signed access sessions live; production has no such API.
  await f.db.query('UPDATE chat_rooms SET succession_expires_at=$2 WHERE room_id=$1',[roomId,new Date((f.now()-1)*1000).toISOString()]);
  await assert.rejects(chat.proposeDecision(b,roomId,input(await chat.get(b,roomId),'successor-owner',{targetSubjectId:b.subjectId})),/chat_succession_unavailable/);
  await assert.rejects(chat.proposeDecision(b,roomId,input(await chat.get(b,roomId),'join-rule',{joinRule:{mode:'open'}})),/chat_room_read_only/);
  await chat.purgeExpired();assert.equal((await chat.get(c,roomId)).state,'archived');
 }finally{await f.close();}
});

test('owner and accepted administrators are capped at ten across separately approved concurrent appointments',async()=>{
 const f=await roomFixture();try{
  const{chat,people:[a,b,c],roomId}=f,ownership=await common(chat,[a,b,c],roomId,'become-owner',{targetSubjectId:a.subjectId});await chat.acceptInvite(a,roomId,{decisionId:ownership.proposal.decisionId});
  await common(chat,[a,b,c],roomId,'join-rule',{joinRule:{mode:'manager-invite'}});
  const members=[a,b,c];for(let batch=0;batch<3;batch++){
   const extra=await chatFixture({database:f.db,migrateDatabase:false});
   for(const person of extra.people){const proposal=input(await chat.get(a,roomId),'invite',{targetSubjectId:person.subjectId});await chat.proposeDecision(a,roomId,proposal);await chat.acceptInvite(person,roomId,{decisionId:proposal.decisionId});members.push(person);}
  }
  for(const person of members.slice(1,9)){const appointment=await common(chat,members,roomId,'appoint-admin',{targetSubjectId:person.subjectId});await chat.acceptInvite(person,roomId,{decisionId:appointment.proposal.decisionId});}
  const ninth=await common(chat,members,roomId,'appoint-admin',{targetSubjectId:members[9].subjectId}),tenth=await common(chat,members,roomId,'appoint-admin',{targetSubjectId:members[10].subjectId});
  await chat.acceptInvite(members[9],roomId,{decisionId:ninth.proposal.decisionId});
  assert.equal((await chat.get(a,roomId)).administratorSubjectIds.length,9);
  await assert.rejects(chat.acceptInvite(members[10],roomId,{decisionId:tenth.proposal.decisionId}),/chat_membership_changed/);
  await assert.rejects(chat.proposeDecision(a,roomId,input(await chat.get(a,roomId),'appoint-admin',{targetSubjectId:members[10].subjectId})),/chat_administrator_limit/);
 }finally{await f.close();}
});

test('open joins bind the current common rule and the original accepted operation cannot rejoin after leaving',async()=>{
 const f=await roomFixture();try{
  const{chat,people:[a,b,c],roomId}=f,outsiders=await chatFixture({database:f.db,migrateDatabase:false}),[d,e]=outsiders.people;
  await assert.rejects(chat.joinPreview(d,roomId),/chat_access_denied/);
  const voted=await common(chat,[a,b,c],roomId,'join-rule',{joinRule:{mode:'open',expiresAt:f.now()+100}}),preview=await chat.joinPreview(d,roomId);
  assert.equal(preview.joinRule.decisionId,voted.proposal.decisionId);assert.equal(Object.hasOwn(preview,'members'),false);assert.equal(preview.joiningGrantsOtherMaterials,false);
  const request={operationId:randomUUID(),ruleVersion:preview.ruleVersion,ruleHash:preview.ruleHash},first=await chat.join(d,roomId,request);
  assert.equal(first.membershipActive,true);assert.equal((await chat.join(d,roomId,request)).room.revision,first.room.revision);
  await assert.rejects(chat.join(d,roomId,{...request,ruleHash:'0'.repeat(64)}),/chat_operation_conflict/);
  await chat.leave(d,roomId);const replay=await chat.join(d,roomId,request);assert.equal(replay.membershipActive,false);assert.equal(replay.room,undefined);
  await assert.rejects(chat.get(d,roomId),/chat_access_denied/);
  await common(chat,[a,b,c],roomId,'join-rule',{joinRule:{mode:'open'}});
  await assert.rejects(chat.join(e,roomId,{...request,operationId:randomUUID()}),/chat_join_rule_changed/);
  const current=await chat.joinPreview(e,roomId);await common(chat,[a,b,c],roomId,'join-rule',{joinRule:{mode:'approval-required'}});
  await assert.rejects(chat.join(e,roomId,{operationId:randomUUID(),ruleVersion:current.ruleVersion,ruleHash:current.ruleHash}),/chat_access_denied/);
 }finally{await f.close();}
});
