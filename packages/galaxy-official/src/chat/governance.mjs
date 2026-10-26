import {chatActorRef,isAccountChatRef,ensureChatParticipantWithin} from "./chat-actors.mjs";
import {ServiceError} from "../shared/service-error.mjs";
import {bindingControl} from "../infrastructure/identity-control-repository.mjs";
import {targetRestrictionsWithin,assertTargetOperation} from "../governance/target-governance-restrictions-v2.mjs";
import {chatCreateSchema,chatDecisionSchema,chatJoinSchema} from "../shared/chat-schema.mjs";
import {roomRule,roomRuleHash,administrators,assertGovernanceProposal,invitationRule,requireOriginalRule,successionLive} from "./chat-room-governance.mjs";
import {lockControllerMappingsWithin} from "../identity/controller-mapping-lock.mjs";
import {day,stamp,hash,fail,parse,uuid} from './helpers.mjs';
import {ChatReadModel} from './read-model.mjs';

// Original common decisions, recipient acceptance, room participation and explicitly authorized Agent grants.
export class ChatGovernance extends ChatReadModel{
 async create(actor,input){const x=parse(chatCreateSchema,input);return this.run(actor,true,async db=>{
  await lockControllerMappingsWithin(db,this.access.endpoint,[chatActorRef(actor)]);
  await this.requireAccount(db,actor);
  const old=(await db.query('SELECT * FROM chat_rooms WHERE creator_subject_id=$1 AND operation_id=$2',[chatActorRef(actor),x.operationId])).rows[0];
  if(old){if(old.request_hash!==hash(x))fail('chat_operation_conflict');return this.view(await this.requireRoom(db,actor,old.room_id));}
  if(x.parentRoomId){if(x.kind!=='ai-subzone')fail('invalid_chat_request',400);await this.requireRoom(db,actor,x.parentRoomId);}
  if(x.kind==='ai-subzone'&&!x.parentRoomId)fail('chat_parent_required',400);
  for(const taskId of x.taskRefs){if(!this.validateTaskRef)fail('chat_task_link_unavailable',503);await this.validateTaskRef(db,actor,taskId);}
  const party=isAccountChatRef(chatActorRef(actor))?chatActorRef(actor):await this.resolveControlParty(db,chatActorRef(actor));
  if(typeof party!=='string'||!party)fail('chat_control_relationship_unavailable',503);
  const created=await db.query(`INSERT INTO chat_rooms(room_id,creator_subject_id,operation_id,request_hash,title,kind,parent_room_id,task_refs,retention_days,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) ON CONFLICT DO NOTHING RETURNING room_id`,[x.roomId,chatActorRef(actor),x.operationId,hash(x),x.title,x.kind,x.parentRoomId??null,JSON.stringify(x.taskRefs),x.retentionDays,stamp(this.now())]);
  if(!created.rows.length){const replay=(await db.query('SELECT * FROM chat_rooms WHERE creator_subject_id=$1 AND operation_id=$2',[chatActorRef(actor),x.operationId])).rows[0];
   if(!replay||replay.request_hash!==hash(x))fail('chat_operation_conflict');return this.view(await this.requireRoom(db,actor,replay.room_id));}
  await db.query('INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$3,$4)',[x.roomId,chatActorRef(actor),party,stamp(this.now())]);
  return this.view(await this.requireRoom(db,actor,x.roomId));
 });}
 async proposeDecision(actor,roomId,input){const x=parse(chatDecisionSchema,input);return this.run(actor,true,async db=>{
   await this.requireAccount(db,actor);
  if(x.action==='join-rule'?x.joinRule===undefined:x.joinRule!==undefined)fail('invalid_chat_request',400);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['chat-decision:'+x.decisionId]);
  const ctx=await this.requireRoom(db,actor,roomId,{write:true}),r=ctx.room;
  const prior=(await db.query('SELECT * FROM chat_decisions WHERE decision_id=$1',[x.decisionId])).rows[0];
  if(prior){if(prior.room_id!==roomId||prior.proposer_subject_id!==chatActorRef(actor)||prior.request_hash!==hash(x))fail('chat_operation_conflict');return this.decisionView(prior,ctx,actor,db);}
  if(x.action==='invite'){await this.requireAccount(db,actor);await ensureChatParticipantWithin(db,x.targetSubjectId,this.access.endpoint);assertTargetOperation(ctx.governance,'invitations-paused');}
  if(r.state==='archived'||r.revision!==x.expectedRevision)fail('chat_revision_conflict');
  let parties=ctx.parties;
  if(['invite','remove','become-owner','transfer-owner','appoint-admin','revoke-admin','successor-owner'].includes(x.action)&&!x.targetSubjectId)fail('chat_target_required',400);
  if(x.action==='invite'&&ctx.members.some(m=>m.subject_id===x.targetSubjectId))fail('chat_already_member');
  if(['become-owner','transfer-owner','appoint-admin','revoke-admin','successor-owner'].includes(x.action)&&!ctx.members.some(m=>m.subject_id===x.targetSubjectId))fail('chat_target_not_member');
  if(x.action==='become-owner'&&r.mode!=='ownerless')fail('chat_owner_already_exists');
  if(x.action==='transfer-owner'&&r.mode!=='owned')fail('chat_owner_missing');
  assertGovernanceProposal(ctx,{subjectId:chatActorRef(actor)},x,this.now());
  const ruleAuthority=x.action==='invite'?invitationRule(ctx,chatActorRef(actor),this.now()):null;
  if(x.action==='remove'){
   const target=ctx.members.find(m=>m.subject_id===x.targetSubjectId);if(!target)fail('chat_target_not_member');
   parties=parties.filter(p=>p!==target.controller_ref);if(parties.length<2)fail('chat_two_party_removal_forbidden');
   if(target.controller_ref===ctx.members.find(m=>m.subject_id===chatActorRef(actor)).controller_ref)fail('chat_use_leave');
  }
  if(x.action==='retention'&&!x.retentionDays)fail('invalid_chat_request',400);
  if(x.action==='persistent'&&typeof x.persistent!=='boolean')fail('invalid_chat_request',400);
  if(x.action==='invite'){if(!this.consumeInviteWithin)fail('chat_invitation_adapter_unavailable',503);
   await this.consumeInviteWithin(db,actor,{roomId,eventId:x.decisionId,payloadHash:hash(x),recipientId:x.targetSubjectId});}
  const party=ctx.members.find(m=>m.subject_id===chatActorRef(actor)).controller_ref;
  if(ruleAuthority)parties=[party];
  const votes={[party]:{subjectId:chatActorRef(actor),choice:'approve'}},approved=parties.every(p=>votes[p]?.choice==='approve');
  let row=(await db.query(`INSERT INTO chat_decisions(decision_id,room_id,proposer_subject_id,member_revision,required_parties,votes,action,payload,request_hash,state,created_at,expires_at,authority_rule_version,authority_rule_hash)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[x.decisionId,roomId,chatActorRef(actor),r.member_revision,JSON.stringify(parties),JSON.stringify(votes),x.action,JSON.stringify(x),hash(x),approved?'approved':'pending',stamp(this.now()),stamp(this.now()+7*day),ruleAuthority?.version??null,ruleAuthority?.hash??null])).rows[0];
  if(approved)row=await this.applyDecision(db,ctx,row);return this.decisionView(row,ctx,actor,db);
 });}
 async decisionView(d,ctx,actor,db){
  const member=ctx.members.find(m=>m.subject_id===chatActorRef(actor)),party=member?.controller_ref;
  // Current controller mapping and time affect what may proceed, never the
  // saved request, votes or historical state. The write paths still verify
  // these conditions under their original locks before applying a decision.
  const effectiveState=['pending','approved'].includes(d.state)
   ?d.member_revision!==ctx.room.member_revision?'stale':Date.parse(d.expires_at)<=this.now()*1000?'expired':d.state:d.state;
  const closed=effectiveState==='stale'?'chat_membership_changed':effectiveState==='expired'?'chat_decision_expired':null;
  const pending=closed??(effectiveState!=='pending'?'chat_decision_unavailable':!member?'chat_access_denied':null);
  const reasons={approve:pending,reject:pending,cancel:pending,accept:closed,decline:closed};
  if(!pending){
   if(!d.required_parties.includes(party))reasons.approve=reasons.reject='chat_vote_not_required';
   if(chatActorRef(actor)!==d.proposer_subject_id)reasons.cancel='chat_cancel_proposer_required';
  }
  const blocked=async(fn)=>{try{await fn();return null;}catch(error){if(error instanceof ServiceError)return error.code;throw error;}};
  if(!reasons.approve)reasons.approve=await blocked(()=>{
   if(ctx.room.state==='archived')fail('chat_room_read_only');
   assertGovernanceProposal(ctx,{subjectId:d.proposer_subject_id},d.payload,this.now());
   if(d.action==='invite')assertTargetOperation(ctx.governance,'invitations-paused');
  });
  if(!closed){
   const accepting=['invite','become-owner','transfer-owner','appoint-admin','successor-owner'].includes(d.action);
   const unavailable=effectiveState!=='approved'||!accepting?'chat_decision_unavailable':d.payload.targetSubjectId!==chatActorRef(actor)?'chat_invitation_target_required'
    :ctx.room.state==='archived'?'chat_decision_unavailable':ctx.room.state==='owner-succession'&&d.action!=='successor-owner'?'chat_room_read_only'
    :d.action==='successor-owner'&&!successionLive(ctx.room,this.now())?'chat_succession_unavailable':d.action!=='invite'&&!member?'chat_access_denied':null;
   reasons.accept=reasons.decline=unavailable;
  }
  if(!reasons.accept)reasons.accept=await blocked(async()=>{
   await this.requireAccount(db,actor);
   assertGovernanceProposal(ctx,{subjectId:d.proposer_subject_id},d.payload,this.now());requireOriginalRule(ctx,d,this.now());
   if(d.action==='invite'){
    assertTargetOperation(ctx.governance,'invitations-paused');
    if(ctx.room.parent_room_id)await this.requireRoom(db,actor,ctx.room.parent_room_id);
   }
  });
  return{decisionId:d.decision_id,roomId:d.room_id,action:d.action,payload:d.payload,state:d.state,effectiveState,memberRevision:d.member_revision,
   proposerSubjectId:d.proposer_subject_id,votes:Object.values(d.votes),myVote:party&&d.votes[party]?{...d.votes[party]}:null,
   requiredPartyCount:d.required_parties.length,expiresAt:d.expires_at,
   canApprove:!reasons.approve,canReject:!reasons.reject,canCancel:!reasons.cancel,canAccept:!reasons.accept,canDecline:!reasons.decline,actionReasons:reasons,
   ...(d.authority_rule_version?{joinRuleAuthorization:{version:d.authority_rule_version,hash:d.authority_rule_hash}}:{})};
 }
 async decisions(actor,roomId){return this.run(actor,false,async db=>{const ctx=await this.requireRoom(db,actor,roomId),rows=(await db.query('SELECT * FROM chat_decisions WHERE room_id=$1 ORDER BY created_at DESC LIMIT 100',[roomId])).rows,decisions=[];
  for(const row of rows)decisions.push(await this.decisionView(row,ctx,actor,db));return{decisions};});}
 invitations(actor){return this.run(actor,false,async db=>{const rows=(await db.query(`SELECT d.*,r.title FROM chat_decisions d JOIN chat_rooms r USING(room_id)
  WHERE d.payload->>'targetSubjectId'=$1 AND d.state='approved' AND d.expires_at>$2 AND d.member_revision=r.member_revision AND r.state<>'archived'
  ORDER BY d.created_at DESC LIMIT 100`,[chatActorRef(actor),stamp(this.now())])).rows,invitations=[];
  for(const d of rows){if(d.action==='invite'&&(await targetRestrictionsWithin(db,'room',d.room_id,this.now())).scopes.includes('invitations-paused'))continue;
   const ctx=await this.requireRoom(db,actor,d.room_id,{member:false});
   if(d.member_revision!==ctx.room.member_revision)continue;
   try{requireOriginalRule(ctx,d,this.now());if(d.action==='successor-owner'&&!successionLive(ctx.room,this.now()))continue;
    if(ctx.room.state==='owner-succession'&&d.action!=='successor-owner')continue;
   }catch(error){if(error instanceof ServiceError&&error.status===409)continue;throw error;}
   invitations.push({...await this.decisionView(d,ctx,actor,db),title:d.title});}return{invitations};});}
 async voteDecision(actor,roomId,{decisionId,choice}){uuid(decisionId);if(!['approve','reject','cancel'].includes(choice))fail('invalid_chat_request',400);return this.run(actor,true,async db=>{
  const ctx=await this.requireRoom(db,actor,roomId,{write:true});if(choice!=='cancel')await this.requireAccount(db,actor);let d=(await db.query('SELECT * FROM chat_decisions WHERE decision_id=$1 AND room_id=$2 FOR UPDATE',[decisionId,roomId])).rows[0];
  if(!d)fail('chat_decision_not_found',404);if(d.state!=='pending')return this.decisionView(d,ctx,actor,db);
  if(d.member_revision!==ctx.room.member_revision)d.state='stale';else if(Date.parse(d.expires_at)<=this.now()*1000)d.state='expired';
  else if(choice==='cancel'){if(chatActorRef(actor)!==d.proposer_subject_id)fail('chat_access_denied',403);d.state='cancelled';}
  else{const party=ctx.members.find(m=>m.subject_id===chatActorRef(actor)).controller_ref;if(!d.required_parties.includes(party))fail('chat_access_denied',403);
   d.votes[party]={subjectId:chatActorRef(actor),choice};d.state=choice==='reject'?'rejected':d.required_parties.every(p=>d.votes[p]?.choice==='approve')?'approved':'pending';}
  await db.query('UPDATE chat_decisions SET votes=$2,state=$3 WHERE decision_id=$1',[d.decision_id,JSON.stringify(d.votes),d.state]);
  if(d.state==='approved'){assertGovernanceProposal(ctx,{subjectId:d.proposer_subject_id},d.payload,this.now());if(d.action==='invite')assertTargetOperation(ctx.governance,'invitations-paused');d=await this.applyDecision(db,ctx,d);}return this.decisionView(d,ctx,actor,db);
 });}
 async applyDecision(db,ctx,d){const x=d.payload,r=ctx.room;
  // Invitations and ownership transfers require the target's own acceptance.
  if(['invite','become-owner','transfer-owner','appoint-admin','successor-owner'].includes(d.action))return d;
  if(d.action==='remove')await db.query('UPDATE chat_memberships SET left_at=$3 WHERE room_id=$1 AND subject_id=$2',[r.room_id,x.targetSubjectId,stamp(this.now())]);
  if(d.action==='remove')await db.query('UPDATE chat_agent_grants SET revoked_at=$3 WHERE room_id=$1 AND subject_id=$2 AND revoked_at IS NULL',[r.room_id,x.targetSubjectId,stamp(this.now())]);
  if(d.action==='remove'&&r.owner_subject_id===x.targetSubjectId)await db.query("UPDATE chat_rooms SET state='owner-succession',succession_expires_at=$2 WHERE room_id=$1",[r.room_id,stamp(this.now()+7*day)]);
  if(d.action==='retention')await db.query('UPDATE chat_rooms SET retention_days=$2 WHERE room_id=$1',[r.room_id,x.retentionDays]);
  if(d.action==='persistent')await db.query('UPDATE chat_rooms SET persistent=$2 WHERE room_id=$1',[r.room_id,x.persistent]);
  if(['remove','revoke-admin'].includes(d.action))await db.query('UPDATE chat_rooms SET administrator_ids=$2 WHERE room_id=$1',[r.room_id,JSON.stringify(administrators(ctx).filter(id=>id!==x.targetSubjectId))]);
  if(d.action==='join-rule'){
   const current=roomRule(r,this.now()),rule={mode:x.joinRule.mode,version:current.version+1,decisionId:d.decision_id,requestHash:d.request_hash,expiresAt:x.joinRule.expiresAt??null};
   await db.query('UPDATE chat_rooms SET join_rule=$2 WHERE room_id=$1',[r.room_id,JSON.stringify(rule)]);
  }
  if(d.action==='dissolve')await db.query("UPDATE chat_rooms SET state='archived' WHERE room_id=$1",[r.room_id]);
  await db.query(`UPDATE chat_rooms SET revision=revision+1,member_revision=member_revision+$2,updated_at=$3 WHERE room_id=$1`,[r.room_id,['remove','revoke-admin','join-rule'].includes(d.action)?1:0,stamp(this.now())]);
  await db.query("UPDATE chat_decisions SET state='accepted' WHERE decision_id=$1",[d.decision_id]);d.state='accepted';return d;
 }
 async acceptInvite(actor,roomId,{decisionId,accept=true}){uuid(decisionId);if(typeof accept!=='boolean')fail('invalid_chat_request',400);return this.run(actor,true,async db=>{
  if(accept)await this.requireAccount(db,actor);
  const ctx=await this.requireRoom(db,actor,roomId,{member:false,write:true}),r=ctx.room;
  const d=(await db.query('SELECT * FROM chat_decisions WHERE decision_id=$1 AND room_id=$2 FOR UPDATE',[decisionId,roomId])).rows[0];
  if(!d||!['invite','become-owner','transfer-owner','appoint-admin','successor-owner'].includes(d.action)||d.payload.targetSubjectId!==chatActorRef(actor))fail('chat_access_denied',403);
  if(d.state==='accepted'){const active=ctx.members.some(m=>m.subject_id===chatActorRef(actor));
   return{state:'accepted',membershipActive:active,...(active?{room:this.view(ctx)}:{})};}
  if(d.state!=='approved'||r.state==='archived')fail('chat_decision_unavailable');
  if(d.member_revision!==r.member_revision)fail('chat_membership_changed');if(Date.parse(d.expires_at)<=this.now()*1000)fail('chat_invitation_expired');
  if(r.state==='owner-succession'&&d.action!=='successor-owner')fail('chat_room_read_only');
  if(d.action==='successor-owner'&&!successionLive(r,this.now()))fail('chat_succession_unavailable');
  if(accept){assertGovernanceProposal(ctx,{subjectId:d.proposer_subject_id},d.payload,this.now());requireOriginalRule(ctx,d,this.now());}
  if(d.action==='invite'){if(!this.markInviteRespondedWithin)fail('chat_invitation_adapter_unavailable',503);await this.markInviteRespondedWithin(db,{roomId,recipientId:chatActorRef(actor)});}
  if(!accept){await db.query("UPDATE chat_decisions SET state='rejected' WHERE decision_id=$1",[decisionId]);return{state:'rejected'};}
  if(d.action==='invite'){
   assertTargetOperation(ctx.governance,'invitations-paused');
   if(r.parent_room_id)await this.requireRoom(db,actor,r.parent_room_id);
   const party=isAccountChatRef(chatActorRef(actor))?chatActorRef(actor):await this.resolveControlParty(db,chatActorRef(actor));
   await db.query(`INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$3,$4)
    ON CONFLICT(room_id,subject_id) DO UPDATE SET controller_ref=$3,joined_at=$4,left_at=NULL,dismissed_revision=NULL`,[roomId,chatActorRef(actor),party,stamp(this.now())]);
   const multi=new Set([...ctx.parties,party]).size>1;
   await db.query(`UPDATE chat_rooms SET revision=revision+1,member_revision=member_revision+1,had_multiple=had_multiple OR $2,
    state=CASE WHEN $2 THEN 'active' ELSE state END,updated_at=$3 WHERE room_id=$1`,[roomId,multi,stamp(this.now())]);
  }else if(d.action==='appoint-admin'){
   await db.query('UPDATE chat_rooms SET administrator_ids=$2,revision=revision+1,member_revision=member_revision+1,updated_at=$3 WHERE room_id=$1',[roomId,JSON.stringify([...administrators(ctx),chatActorRef(actor)]),stamp(this.now())]);
  }else{
   if(!ctx.members.some(m=>m.subject_id===chatActorRef(actor)))fail('chat_access_denied',403);
   await db.query("UPDATE chat_rooms SET mode='owned',owner_subject_id=$2,administrator_ids=$4,persistent=COALESCE($5,persistent),state='active',succession_expires_at=NULL,revision=revision+1,member_revision=member_revision+1,updated_at=$3 WHERE room_id=$1",[roomId,chatActorRef(actor),stamp(this.now()),JSON.stringify(administrators(ctx).filter(id=>id!==chatActorRef(actor))),d.payload.persistent??null]);
  }
  await db.query("UPDATE chat_decisions SET state='accepted' WHERE decision_id=$1",[decisionId]);
  return {state:'accepted',room:this.view(await this.requireRoom(db,actor,roomId))};
 });}
 async leave(actor,roomId){return this.run(actor,true,async db=>{
  const ctx=await this.requireRoom(db,actor,roomId,{member:false,write:true}),r=ctx.room;
  if(!ctx.members.some(m=>m.subject_id===chatActorRef(actor)))return{left:true,taskParticipationChanged:false};
  await db.query('UPDATE chat_memberships SET left_at=$3 WHERE room_id=$1 AND subject_id=$2',[roomId,chatActorRef(actor),stamp(this.now())]);
  await db.query('UPDATE chat_agent_grants SET revoked_at=$3 WHERE room_id=$1 AND subject_id=$2 AND revoked_at IS NULL',[roomId,chatActorRef(actor),stamp(this.now())]);
  const parties=new Set(ctx.members.filter(m=>m.subject_id!==chatActorRef(actor)).map(m=>m.controller_ref));
  const state=!parties.size?'archived':r.owner_subject_id===chatActorRef(actor)?'owner-succession':parties.size===1&&r.mode==='ownerless'&&r.had_multiple?'single-member-decision':r.state;
  await db.query(`UPDATE chat_rooms SET state=$2,revision=revision+1,member_revision=member_revision+1,updated_at=$3,
   administrator_ids=$5,succession_expires_at=CASE WHEN $2='owner-succession' AND state<>'owner-succession' THEN $4 ELSE succession_expires_at END WHERE room_id=$1`,[roomId,state,stamp(this.now()),stamp(this.now()+7*day),JSON.stringify(administrators(ctx).filter(id=>id!==chatActorRef(actor)))]);
  return {left:true,taskParticipationChanged:false};
 });}
 async dismissDecision(actor,roomId){return this.run(actor,true,async db=>{const ctx=await this.requireRoom(db,actor,roomId,{write:true});await db.query('UPDATE chat_memberships SET dismissed_revision=$3 WHERE room_id=$1 AND subject_id=$2',[roomId,chatActorRef(actor),ctx.room.revision]);return{dismissed:true};});}
 async joinPreview(actor,roomId){return this.run(actor,false,async db=>{
  const ctx=await this.requireRoom(db,actor,roomId,{member:false}),rule=roomRule(ctx.room,this.now());
  if(rule.effectiveMode!=='open'||['archived','owner-succession'].includes(ctx.room.state))fail('chat_access_denied',403);
  if(ctx.room.parent_room_id)await this.requireRoom(db,actor,ctx.room.parent_room_id);
  assertTargetOperation(ctx.governance,'invitations-paused');
  return{roomId,title:ctx.room.title,ruleVersion:rule.version,ruleHash:roomRuleHash(rule),joinRule:rule,
   retentionDays:ctx.room.retention_days,historyPolicy:'all-authorized-history',requiresVerifiedAccount:true,joiningGrantsOtherMaterials:false,joiningStartsAgent:false};
 });}
 async join(actor,roomId,input){const x=parse(chatJoinSchema,input);return this.run(actor,true,async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['chat-decision:'+x.operationId]);
  const ctx=await this.requireRoom(db,actor,roomId,{member:false,write:true}),r=ctx.room;
  const previous=(await db.query('SELECT * FROM chat_decisions WHERE decision_id=$1',[x.operationId])).rows[0];
  if(previous){if(previous.action!=='open-join'||previous.room_id!==roomId||previous.proposer_subject_id!==chatActorRef(actor)||previous.request_hash!==hash(x))fail('chat_operation_conflict');
   const active=ctx.members.some(m=>m.subject_id===chatActorRef(actor));return{state:'accepted',membershipActive:active,...(active?{room:this.view(ctx)}:{})};}
  const rule=roomRule(r,this.now());
  if(rule.effectiveMode!=='open'||['archived','owner-succession'].includes(r.state))fail('chat_access_denied',403);
  if(rule.version!==x.ruleVersion||roomRuleHash(rule)!==x.ruleHash)fail('chat_join_rule_changed');
  assertTargetOperation(ctx.governance,'invitations-paused');await this.requireAccount(db,actor);
  if(r.parent_room_id)await this.requireRoom(db,actor,r.parent_room_id);
  if(ctx.members.some(m=>m.subject_id===chatActorRef(actor)))fail('chat_already_member');
  const party=isAccountChatRef(chatActorRef(actor))?chatActorRef(actor):await this.resolveControlParty(db,chatActorRef(actor));if(typeof party!=='string'||!party)fail('chat_control_relationship_unavailable',503);
  await db.query(`INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$3,$4)
   ON CONFLICT(room_id,subject_id) DO UPDATE SET controller_ref=$3,joined_at=$4,left_at=NULL,dismissed_revision=NULL`,[roomId,chatActorRef(actor),party,stamp(this.now())]);
  const multi=new Set([...ctx.parties,party]).size>1;
  await db.query(`UPDATE chat_rooms SET revision=revision+1,member_revision=member_revision+1,had_multiple=had_multiple OR $2,
   state=CASE WHEN $2 THEN 'active' ELSE state END,updated_at=$3 WHERE room_id=$1`,[roomId,multi,stamp(this.now())]);
  await db.query(`INSERT INTO chat_decisions(decision_id,room_id,proposer_subject_id,member_revision,required_parties,votes,action,payload,request_hash,state,created_at,expires_at,authority_rule_version,authority_rule_hash)
   VALUES($1,$2,$3,$4,'[]','{}','open-join',$5,$6,'accepted',$7,$8,$9,$10)`,[x.operationId,roomId,chatActorRef(actor),r.member_revision,JSON.stringify(x),hash(x),stamp(this.now()),stamp(this.now()+7*day),rule.version,roomRuleHash(rule)]);
  return{state:'accepted',membershipActive:true,room:this.view(await this.requireRoom(db,actor,roomId))};
 });}
 async grantAgent(actor,roomId,{grantId,bindingId,mode='read',primaryResponder=false,expiresAt}){
  uuid(grantId);uuid(bindingId);if(!['read','draft','respond'].includes(mode)||typeof primaryResponder!=='boolean'||primaryResponder&&mode!=='respond'||!Number.isInteger(expiresAt)||expiresAt<=this.now()||expiresAt>this.now()+30*day)fail('invalid_chat_request',400);
  return this.run(actor,true,async db=>{const ctx=await this.requireRoom(db,actor,roomId,{write:true});await this.requireAccount(db,actor);
   if(['archived','owner-succession'].includes(ctx.room.state))fail('chat_room_read_only');
   const b=await bindingControl(db,(await db.query('SELECT * FROM bindings WHERE id=$1 AND subject_id=$2',[bindingId,chatActorRef(actor)])).rows[0],{scope:'binding'});
   if(!b||!b.scopes.includes('binding')||b.revoked_at||Date.parse(b.expires_at)<=this.now()*1000)fail('chat_agent_not_authorized',403);
   if(primaryResponder){const p=ctx.members.find(m=>m.subject_id===chatActorRef(actor)).controller_ref;const ids=ctx.members.filter(m=>m.controller_ref===p).map(m=>m.subject_id);
    await db.query('UPDATE chat_agent_grants SET primary_responder=false WHERE room_id=$1 AND subject_id=ANY($2::text[]) AND revoked_at IS NULL',[roomId,ids]);}
   const old=(await db.query('SELECT * FROM chat_agent_grants WHERE grant_id=$1',[grantId])).rows[0];if(old)fail('chat_grant_exists');
   await db.query('INSERT INTO chat_agent_grants(grant_id,room_id,subject_id,binding_id,mode,primary_responder,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[grantId,roomId,chatActorRef(actor),bindingId,mode,primaryResponder,stamp(expiresAt),stamp(this.now())]);
   return{grantId,mode,primaryResponder,expiresAt,hostRuntimeStarted:false};});
 }
 queryAgentGrants(actor,roomId,{after='',limit=50,grantId}={}){
  if(after)uuid(after);if(grantId)uuid(grantId);if(!Number.isInteger(limit)||limit<1||limit>100)fail('invalid_chat_request',400);
  return this.run(actor,false,async db=>{
   const ctx=await this.requireRoom(db,actor,roomId);
   const rows=(await db.query(`SELECT * FROM chat_agent_grants WHERE room_id=$1 AND subject_id=$2
    AND ($3='' OR grant_id::text>$3) AND ($4::uuid IS NULL OR grant_id=$4) ORDER BY grant_id LIMIT $5`,[roomId,chatActorRef(actor),after,grantId??null,limit+1])).rows;
   const items=[];
   for(const row of rows.slice(0,limit)){
    const binding=await bindingControl(db,(await db.query('SELECT * FROM bindings WHERE id=$1 AND subject_id=$2',[row.binding_id,chatActorRef(actor)])).rows[0],{scope:'binding'});
    const state=row.revoked_at?'revoked':Date.parse(row.expires_at)<=this.now()*1000?'expired':!binding||binding.revoked_at||!binding.scopes.includes('binding')||Date.parse(binding.expires_at)<=this.now()*1000?'binding-unavailable':['archived','owner-succession'].includes(ctx.room.state)?'room-inactive':'active';
    items.push({grantId:row.grant_id,roomId,subjectId:row.subject_id,bindingId:row.binding_id,mode:row.mode,primaryResponder:row.primary_responder,
     expiresAt:Math.floor(Date.parse(row.expires_at)/1000),createdAt:row.created_at,revokedAt:row.revoked_at,state,hostRuntimeState:'unverified'});
   }
   return {items,next:rows.length>limit?items.at(-1).grantId:null,...(grantId?{grantId,state:items.length?'recorded':'absent'}:{})};
  });
 }
 queryAgentParticipants(actor,roomId,input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['after','limit'].includes(k)))fail('invalid_chat_request',400);
  const {after='',limit=50}=input;if(after)uuid(after);if(typeof after!=='string'||!Number.isInteger(limit)||limit<1||limit>100)fail('invalid_chat_request',400);
  return this.run(actor,false,async db=>{
   const ctx=await this.requireRoom(db,actor,roomId);
   const rows=(await db.query(`SELECT g.* FROM chat_agent_grants g JOIN chat_memberships m ON m.room_id=g.room_id AND m.subject_id=g.subject_id
    WHERE g.room_id=$1 AND m.left_at IS NULL AND ($2='' OR g.grant_id::text>$2)
    AND NOT EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=g.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased'))
    ORDER BY g.grant_id LIMIT $3`,[roomId,after,limit+1])).rows;
   const items=[];
   for(const row of rows.slice(0,limit)){
    const binding=await bindingControl(db,(await db.query('SELECT * FROM bindings WHERE id=$1 AND subject_id=$2',[row.binding_id,row.subject_id])).rows[0],{scope:'binding'});
    const state=row.revoked_at?'revoked':Date.parse(row.expires_at)<=this.now()*1000?'expired':!binding||binding.revoked_at||!binding.scopes.includes('binding')||Date.parse(binding.expires_at)<=this.now()*1000?'binding-unavailable':['archived','owner-succession'].includes(ctx.room.state)?'room-inactive':'active';
    items.push({grantId:row.grant_id,subjectId:row.subject_id,mode:row.mode,primaryResponder:row.primary_responder,
     expiresAt:Math.floor(Date.parse(row.expires_at)/1000),state,hostRuntimeState:'unverified',readScope:'current-room-authorized-history',
     allowedActions:state!=='active'?[]:row.mode==='respond'?['read','draft','respond']:row.mode==='draft'?['read','draft']:['read']});
   }
   return{items,next:rows.length>limit?items.at(-1).grantId:null};
  });
 }
 revokeAgent(actor,roomId,{grantId}){uuid(grantId);return this.run(actor,true,async db=>{await this.requireRoom(db,actor,roomId,{write:true});const r=await db.query('UPDATE chat_agent_grants SET revoked_at=COALESCE(revoked_at,$4) WHERE grant_id=$1 AND room_id=$2 AND subject_id=$3 RETURNING grant_id',[grantId,roomId,chatActorRef(actor),stamp(this.now())]);if(!r.rows.length)fail('chat_access_denied',403);return{revoked:true,hostRuntimeStopped:false};});}
}
