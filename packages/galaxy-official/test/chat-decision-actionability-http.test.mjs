import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {serviceFixture} from './service-fixture.mjs';

async function fixture(accounts=['decision-author','decision-member','decision-target']){
 const f=await communityForumFixture(),people=[f.owner,f.responder,f.moderator];
 for(let i=0;i<people.length;i++)if(accounts[i])await f.login(people[i],accounts[i]);
 const roomId=randomUUID(),path='/v2/chat/rooms/'+roomId;
 await f.ok('/v2/chat/rooms/create',{who:people[0],input:{roomId,operationId:randomUUID(),title:'[本地合成] 成员请求可操作性'}});
 const read=who=>f.ok(path+'/read',{who,input:{}});
 const propose=async(who,action,fields={})=>{const current=await read(who),input={decisionId:randomUUID(),expectedRevision:current.revision,action,...fields};
  return{input,result:await f.ok(path+'/propose',{who,input})};};
 const vote=(who,id,choice)=>f.ok(path+'/vote',{who,input:{decisionId:id,choice}});
 const accept=(who,id)=>f.ok(path+'/accept',{who,input:{decisionId:id}});
 const decisions=async who=>(await f.ok(path+'/decisions',{who,input:{}})).decisions;
 const decision=async(who,id)=>(await decisions(who)).find(row=>row.decisionId===id);
 const snapshot=async()=>JSON.stringify((await f.db.query('SELECT * FROM chat_decisions WHERE room_id=$1 ORDER BY decision_id',[roomId])).rows);
 async function join(who,voters=[]){const invite=await propose(people[0],'invite',{targetSubjectId:who.actor.subjectId});for(const voter of voters)await vote(voter,invite.input.decisionId,'approve');await accept(who,invite.input.decisionId);return invite;}
 return{...f,people,roomId,path,read,propose,vote,accept,decision,decisions,snapshot,join};
}
const noActions=value=>{for(const name of ['canApprove','canReject','canCancel','canAccept','canDecline'])assert.equal(value[name],false,name);};

test('HTTP decision views identify the exact proposer, required current actor and applied settings without modifying original records',{timeout:60000},async()=>{
 const f=await fixture();try{
  const[a,b,c]=f.people;await f.join(b);await f.join(c,[b]);
  const setting=await f.propose(a,'retention',{retentionDays:7}),id=setting.input.decisionId,before=await f.snapshot();
  const author=await f.decision(a,id),member=await f.decision(b,id);
  assert.equal(author.proposerSubjectId,a.actor.subjectId);assert.equal(author.effectiveState,'pending');assert.equal(author.canCancel,true);
  assert.deepEqual(author.myVote,{subjectId:a.actor.subjectId,choice:'approve'});
  assert.equal(member.canApprove,true);assert.equal(member.canReject,true);assert.equal(member.canCancel,false);
  assert.equal(member.actionReasons.cancel,'chat_cancel_proposer_required');assert.equal(member.myVote,null);
  assert.ok(await f.snapshot()===before,'reading actionability preserves raw state, request/hash, votes and deadline');
  const refused=await f.request(f.path+'/vote',{who:b,input:{decisionId:id,choice:'cancel'}});assert.equal(refused.status,403);assert.equal(refused.body.error,'chat_access_denied');
  assert.ok(await f.snapshot()===before,'a different member cannot cancel or change the request');
  const voted=await f.vote(b,id,'approve');assert.equal(voted.state,'pending');assert.deepEqual(voted.myVote,{subjectId:b.actor.subjectId,choice:'approve'});
  const applied=await f.vote(c,id,'approve');assert.equal(applied.state,'accepted');assert.equal(applied.effectiveState,'accepted');noActions(applied);
  assert.equal((await f.read(a)).retentionDays,7);assert.equal((await f.decision(a,id)).proposerSubjectId,a.actor.subjectId);
  const removal=await f.propose(a,'remove',{targetSubjectId:c.actor.subjectId}),notRequired=await f.decision(c,removal.input.decisionId);
  assert.equal(notRequired.canApprove,false);assert.equal(notRequired.canReject,false);assert.equal(notRequired.canCancel,false);
  assert.equal(notRequired.actionReasons.approve,'chat_vote_not_required');
  const denied=await f.request(f.path+'/vote',{who:c,input:{decisionId:removal.input.decisionId,choice:'approve'}});assert.equal(denied.status,403);
 }finally{await f.close();}
});

test('verified identities sharing a control party see that party vote but only the precise proposer may cancel',{timeout:60000},async()=>{
 const f=await fixture(['decision-shared-account','decision-shared-account','decision-independent']);try{
  const[a,b,c]=f.people;await f.join(b);await f.join(c);assert.equal((await f.read(a)).independentMemberCount,2);
  const setting=await f.propose(a,'persistent',{persistent:true}),id=setting.input.decisionId,before=await f.snapshot(),sameParty=await f.decision(b,id);
  assert.equal(sameParty.proposerSubjectId,a.actor.subjectId);assert.deepEqual(sameParty.myVote,{subjectId:a.actor.subjectId,choice:'approve'});
  assert.equal(sameParty.canApprove,true);assert.equal(sameParty.canReject,true);assert.equal(sameParty.canCancel,false);
  assert.ok(await f.snapshot()===before);
  const changedVote=await f.vote(b,id,'approve');assert.equal(changedVote.state,'pending');assert.equal(changedVote.votes.length,1);
  assert.equal(changedVote.proposerSubjectId,a.actor.subjectId);assert.deepEqual(changedVote.myVote,{subjectId:b.actor.subjectId,choice:'approve'});
  assert.equal((await f.decision(a,id)).canCancel,true,'a later same-party vote never changes the original proposer');
  await f.vote(c,id,'approve');assert.equal((await f.read(a)).persistent,true);
 }finally{await f.close();}
});

test('current expiry, membership and controller changes project inactive requests without changing stored pending history',{timeout:60000},async()=>{
 const f=await fixture();try{
  const[a,b,c]=f.people;await f.join(b);await f.join(c,[b]);
  const expired=await f.propose(a,'retention',{retentionDays:30});
  // Expiry is represented only in this isolated historical sample. Existing
  // access sessions remain current; ordinary reads never expire the row.
  await f.db.query('UPDATE chat_decisions SET expires_at=$2 WHERE decision_id=$1',[expired.input.decisionId,new Date((f.clock.now-1)*1000).toISOString()]);
  let before=await f.snapshot(),view=await f.decision(a,expired.input.decisionId);assert.equal(view.state,'pending');assert.equal(view.effectiveState,'expired');noActions(view);
  assert.equal(view.actionReasons.cancel,'chat_decision_expired');assert.ok(await f.snapshot()===before);
  const stale=await f.propose(a,'persistent',{persistent:true});await f.ok(f.path+'/leave',{who:c,input:{}});
  before=await f.snapshot();view=await f.decision(b,stale.input.decisionId);assert.equal(view.state,'pending');assert.equal(view.effectiveState,'stale');noActions(view);
  assert.equal(view.actionReasons.approve,'chat_membership_changed');assert.ok(await f.snapshot()===before);
  const remapped=await f.propose(a,'retention',{retentionDays:7}),storedRoom=JSON.stringify((await f.db.query('SELECT member_revision,revision FROM chat_rooms WHERE room_id=$1',[f.roomId])).rows);
  const oldLinks=(await f.ok('/v1/identity/query',{who:b,input:{limit:100}})).items;await f.login(b,'decision-author');
  for(const link of oldLinks)await f.ok('/v1/identity/revoke',{who:b,input:{id:link.id}});
  before=await f.snapshot();view=await f.decision(a,remapped.input.decisionId);
  assert.equal(view.effectiveState,'stale');noActions(view);assert.ok(await f.snapshot()===before);
  assert.ok(JSON.stringify((await f.db.query('SELECT member_revision,revision FROM chat_rooms WHERE room_id=$1',[f.roomId])).rows)===storedRoom,'read-only controller mapping refresh does not persist revisions');
 }finally{await f.close();}
});

test('invitation and succession actionability follows current target, account, original rule, read-only room and governance conditions',{timeout:60000},async()=>{
 const f=await fixture(['decision-live-author',null,'decision-live-third']);try{
  const[a,b,c]=f.people,invitation=await f.propose(a,'invite',{targetSubjectId:b.actor.subjectId}),id=invitation.input.decisionId;
  let before=await f.snapshot();const invites=await f.ok('/v2/chat/invitations/query',{who:b,input:{}});let view=invites.invitations.find(row=>row.decisionId===id);
  assert.equal(view.canAccept,false);assert.equal(view.actionReasons.accept,'account_verification_required');assert.equal(view.canDecline,true);assert.equal(view.canCancel,false);
  assert.ok(await f.snapshot()===before);
  await f.login(b,'decision-live-member');view=(await f.ok('/v2/chat/invitations/query',{who:b,input:{}})).invitations.find(row=>row.decisionId===id);assert.equal(view.canAccept,true);
  const authorView=await f.decision(a,id);assert.equal(authorView.canAccept,false);assert.equal(authorView.actionReasons.accept,'chat_invitation_target_required');
  await f.accept(b,id);await f.join(c,[b]);
  const outsider=await serviceFixture(['binding'],f.db,{migrateDatabase:false,now:f.clock.now,syntheticCommunityQuota:false});await f.login(outsider,'decision-rule-target');
  const paused=await f.propose(a,'invite',{targetSubjectId:outsider.actor.subjectId});
  // A current restriction is an explicit isolated fixture record. It does not
  // manufacture a moderation decision, original Consent or signature.
  const reportId=randomUUID();await f.db.query(`INSERT INTO target_reports_v2(id,subject_id,target_type,room_id,target_version,party_ids,restriction_scopes,restriction_until,created_at)
   VALUES($1,$2,'room',$3,1,'[]','["invitations-paused"]',$4,$5)`,[reportId,a.actor.subjectId,f.roomId,new Date((f.clock.now+60)*1000).toISOString(),new Date(f.clock.now*1000).toISOString()]);
  before=await f.snapshot();view=await f.decision(b,paused.input.decisionId);assert.equal(view.canApprove,false);assert.equal(view.actionReasons.approve,'target_operation_restricted');assert.equal(view.canReject,true);
  assert.equal((await f.decision(a,paused.input.decisionId)).canCancel,true);assert.ok(await f.snapshot()===before);
  await f.db.query('UPDATE target_reports_v2 SET restriction_until=$2 WHERE id=$1',[reportId,new Date((f.clock.now-1)*1000).toISOString()]);
  const rule=await f.propose(a,'join-rule',{joinRule:{mode:'member-invite',expiresAt:f.clock.now+60}});await f.vote(b,rule.input.decisionId,'approve');await f.vote(c,rule.input.decisionId,'approve');
  const originalRuleInvite=await f.propose(b,'invite',{targetSubjectId:outsider.actor.subjectId});
  view=(await f.ok('/v2/chat/invitations/query',{who:outsider,input:{}})).invitations.find(row=>row.decisionId===originalRuleInvite.input.decisionId);assert.equal(view.canAccept,true);
  f.clock.now+=61;before=await f.snapshot();
  assert.equal((await f.ok('/v2/chat/invitations/query',{who:outsider,input:{}})).invitations.some(row=>row.decisionId===originalRuleInvite.input.decisionId),false);
  view=await f.owner.chat.run(outsider.actor,false,async db=>{const ctx=await f.owner.chat.requireRoom(db,outsider.actor,f.roomId,{member:false}),
   original=(await db.query('SELECT * FROM chat_decisions WHERE decision_id=$1',[originalRuleInvite.input.decisionId])).rows[0];return f.owner.chat.decisionView(original,ctx,outsider.actor,db);});
  assert.equal(view.state,'approved');assert.equal(view.canAccept,false);assert.equal(view.actionReasons.accept,'chat_join_rule_changed');assert.equal(view.canDecline,true);
  assert.ok(await f.snapshot()===before,'expired original rule is read without changing the original approval');
  const unavailable=await f.request(f.path+'/accept',{who:outsider,input:{decisionId:originalRuleInvite.input.decisionId}});assert.equal(unavailable.status,409);assert.equal(unavailable.body.error,'chat_join_rule_changed');
  const ownership=await f.propose(a,'become-owner',{targetSubjectId:a.actor.subjectId});await f.vote(b,ownership.input.decisionId,'approve');await f.vote(c,ownership.input.decisionId,'approve');await f.accept(a,ownership.input.decisionId);
  const pending=await f.propose(a,'retention',{retentionDays:7});await f.ok(f.path+'/leave',{who:a,input:{}});
  view=await f.decision(b,pending.input.decisionId);assert.equal(view.effectiveState,'stale');noActions(view);assert.equal((await f.read(b)).state,'owner-succession');
  const successor=await f.propose(b,'successor-owner',{targetSubjectId:b.actor.subjectId});view=await f.decision(c,successor.input.decisionId);assert.equal(view.canApprove,true);
  await f.db.query('UPDATE chat_rooms SET succession_expires_at=$2 WHERE room_id=$1',[f.roomId,new Date((f.clock.now-1)*1000).toISOString()]);
  before=await f.snapshot();view=await f.decision(c,successor.input.decisionId);assert.equal(view.state,'pending');assert.equal(view.canApprove,false);assert.equal(view.actionReasons.approve,'chat_succession_unavailable');assert.equal(view.canReject,true);
  assert.equal((await f.decision(b,successor.input.decisionId)).canCancel,true);assert.ok(await f.snapshot()===before);
 }finally{await f.close();}
});
