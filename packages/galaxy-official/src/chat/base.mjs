import {chatActorRef,isAccountChatRef,ensureChatActorWithin} from "../chat-actors.mjs";
import {lockSubjectResourceBudget,subjectResourceUsage,enforceResourceGrowth} from "../infrastructure/resource-budgets.mjs";
import {targetRestrictionsWithin} from "../target-governance-restrictions-v2.mjs";
import {lockControllerMappingsWithin} from "../controller-mapping-lock.mjs";
import {fail,uuid} from './helpers.mjs';

// Current Access/account authority, room membership and independent controller mapping. The MUC projection is never the authority for Galaxy governance.
export class ChatAuthority{
 constructor({db,access,transport,now=()=>Math.floor(Date.now()/1000),resolveControlParty=async(_db,id)=>`subject:${id}`,validateTaskRef=null,
  requireAccountWithin=null,consumeInviteWithin=null,markInviteRespondedWithin=null,accounts=null}){
  Object.assign(this,{db,access,transport,now,resolveControlParty,validateTaskRef,requireAccountWithin,consumeInviteWithin,markInviteRespondedWithin,accounts});
 }
 async requireAccount(db,actor){if(!this.requireAccountWithin)fail('chat_account_adapter_unavailable',503);await this.requireAccountWithin(db,actor);}
 run(actor,write,fn,{control=false}={}){
   const execute=async db=>{await ensureChatActorWithin(db,actor,this.access.endpoint);return fn(db);};
   if(actor?.kind!=='official-account')return write?this.access.runResourceWrite(actor,'binding',{control},execute):this.access.runAuthorized(actor,'binding',execute);
   if(!this.accounts)fail('official_account_unavailable',503);
   return this.accounts.runAuthorized(actor,'binding',async db=>{
     const budget=write&&!control?this.access.resourceBudgetPolicy:null,ref=chatActorRef(actor);
     if(budget)await lockSubjectResourceBudget(db,ref);
     const before=budget?await subjectResourceUsage(db,ref,this.now()):null;
     const result=await execute(db);
     if(before)enforceResourceGrowth(before,await subjectResourceUsage(db,ref,this.now()),budget);
     return result;
   },{resourceWrite:false,control});
 }
 async members(db,roomId){return(await db.query('SELECT m.*,p.display_name,account.uid FROM chat_memberships m LEFT JOIN chat_participants_v3 a ON a.actor_ref=m.subject_id LEFT JOIN community_accounts account ON account.id=a.account_id LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.account_id WHERE m.room_id=$1 AND m.left_at IS NULL ORDER BY m.subject_id',[roomId])).rows;}
 async requireRoom(db,actor,roomId,{member=true,write=false}={}){
  uuid(roomId);const r=(await db.query(`SELECT * FROM chat_rooms WHERE room_id=$1 ${write?'FOR UPDATE':'FOR SHARE'}`,[roomId])).rows[0];
  if(!r)fail('chat_room_not_found',404);
  const members=await this.members(db,roomId);
  if(member&&!members.some(m=>m.subject_id===chatActorRef(actor)))fail('chat_access_denied',403);
  if(member&&r.parent_room_id)await this.requireRoom(db,actor,r.parent_room_id);
  // Hold the whole current mapping snapshot until transaction completion,
  // including an absent/new joining subject. Link/unlink takes the same key
  // exclusively; a final metadata re-read alone would leave a commit race.
  await lockControllerMappingsWithin(db,this.access.endpoint,[...members.map(m=>m.subject_id),chatActorRef(actor)]);
  const mapped=[];for(const m of members)mapped.push({...m,controller_ref:isAccountChatRef(m.subject_id)?m.subject_id:await this.resolveControlParty(db,m.subject_id)});
  if(mapped.some(m=>typeof m.controller_ref!=='string'||!m.controller_ref.length))fail('chat_control_relationship_unavailable',503);
  if(mapped.some((m,i)=>m.controller_ref!==members[i].controller_ref)){
   if(write){
    for(const m of mapped)await db.query('UPDATE chat_memberships SET controller_ref=$3 WHERE room_id=$1 AND subject_id=$2',[roomId,m.subject_id,m.controller_ref]);
    await db.query('UPDATE chat_rooms SET member_revision=member_revision+1,revision=revision+1 WHERE room_id=$1',[roomId]);
   }
   // A read reflects the same current control-party version that the next
   // locked write will persist. Failed stale writes roll back their refresh.
   r.member_revision++;r.revision++;
  }
  return {room:r,members:mapped,parties:[...new Set(mapped.map(m=>m.controller_ref))].sort((a,b)=>a<b?-1:a>b?1:0),governance:await targetRestrictionsWithin(db,'room',roomId,this.now())};
 }
 async agent(db,actor,roomId,grantId,{send=false}={}){
  if(!grantId)return null;const g=(await db.query('SELECT * FROM chat_agent_grants WHERE grant_id=$1 AND room_id=$2 AND subject_id=$3',[grantId,roomId,chatActorRef(actor)])).rows[0];
  if(!g||g.binding_id!==actor.bindingId||g.revoked_at||Date.parse(g.expires_at)<=this.now()*1000||(send&&g.mode!=='respond'))fail('chat_agent_not_authorized',403);return g;
 }
}
