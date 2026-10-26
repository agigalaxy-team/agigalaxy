import canonicalize from 'canonicalize';
import {digest} from "../shared/digest.mjs";
import {ServiceError} from "../shared/service-error.mjs";

export const initialJoinRule={mode:'approval-required',version:1,decisionId:null,requestHash:null,expiresAt:null};
const fail=code=>{throw new ServiceError(code,409);};
export function roomRule(room,now){
 const rule=room.join_rule??initialJoinRule,expired=rule.expiresAt!==null&&rule.expiresAt<=now;
 return{...rule,requestHash:rule.requestHash,active:!expired,effectiveMode:expired?'approval-required':rule.mode};
}
export const roomRuleHash=rule=>digest(canonicalize({mode:rule.mode,version:rule.version,decisionId:rule.decisionId,requestHash:rule.requestHash,expiresAt:rule.expiresAt}));
export const administrators=ctx=>(ctx.room.administrator_ids??[]).filter(id=>ctx.members.some(m=>m.subject_id===id)&&id!==ctx.room.owner_subject_id);
export const roomManager=(ctx,id)=>ctx.room.mode==='owned'&&(ctx.room.owner_subject_id===id||administrators(ctx).includes(id));
export function successionLive(room,now){return room.state==='owner-succession'&&room.succession_expires_at&&Date.parse(room.succession_expires_at)>now*1000;}
export function assertGovernanceProposal(ctx,actor,input,now){
 const r=ctx.room;
 if(r.state==='owner-succession'&&!['successor-owner','dissolve'].includes(input.action))fail('chat_room_read_only');
 if(input.action==='successor-owner'&&!successionLive(r,now))fail('chat_succession_unavailable');
 if(input.action==='transfer-owner'&&r.owner_subject_id!==actor.subjectId)fail('chat_owner_required');
 if(['appoint-admin','revoke-admin'].includes(input.action)&&r.mode!=='owned')fail('chat_owner_missing');
 if(input.action==='appoint-admin'){
  if(r.owner_subject_id===input.targetSubjectId||administrators(ctx).includes(input.targetSubjectId))fail('chat_already_manager');
  if(1+administrators(ctx).length>=10)fail('chat_administrator_limit');
 }
 if(input.action==='revoke-admin'&&!administrators(ctx).includes(input.targetSubjectId))fail('chat_administrator_not_found');
 if(input.action==='join-rule'&&input.joinRule.expiresAt!==undefined&&input.joinRule.expiresAt<=now)fail('chat_join_rule_expired');
 if(input.action==='join-rule'&&input.joinRule.mode==='manager-invite'&&r.mode!=='owned')fail('chat_owner_missing');
}
export function invitationRule(ctx,actorId,now){
 const rule=roomRule(ctx.room,now),mode=rule.effectiveMode;
 if(mode==='approval-required')return null;
 if(mode==='manager-invite'&&!roomManager(ctx,actorId))throw new ServiceError('chat_manager_required',403);
 return{version:rule.version,hash:roomRuleHash(rule)};
}
export function requireOriginalRule(ctx,decision,now){
 if(decision.authority_rule_version===null||decision.authority_rule_version===undefined)return;
 const rule=roomRule(ctx.room,now);
 if(!rule.active||rule.version!==decision.authority_rule_version||roomRuleHash(rule)!==decision.authority_rule_hash)fail('chat_join_rule_changed');
}
