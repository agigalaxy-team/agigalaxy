import {chatActorRef} from "../../chat-actors.mjs";
import {lockControllerMappingsWithin} from "../../controller-mapping-lock.mjs";
import {OperationsChatMessageVisibilityService} from "../../operations-chat-messages.mjs";
import {hasOperationsPermission as permitted} from "../../operations-permission-catalog.mjs";
import {fail} from './helpers.mjs';

// Current account/management principals, original known-party independence and case access. Selected disclosure never grants room history.
export class ChatReportAuthority{
 constructor({chat,businessAdmin,now=chat.now}){Object.assign(this,{chat,businessAdmin,now});this.db=chat.db;this.endpoint=chat.access.endpoint;this.messageVisibility=new OperationsChatMessageVisibilityService({governance:this});}
 account(actor){if(actor?.kind!=='official-account'||actor.endpoint!==this.endpoint)fail('chat_report_account_required',401);return actor;}
 run(actor,write,fn){this.account(actor);return this.chat.run(actor,write,fn,{control:true});}
 operator(actor,{write=false}={}){if(!this.businessAdmin)fail('business_admin_unavailable',503);return this.businessAdmin.require(actor,{write});}
 configuration(){return{categories:['advertising','harassment','privacy','misrepresentation','other'],maxMaterials:20,maxAttachmentsPerMessage:16,maxSummaryLength:1600,materialDisclosure:'explicitly-selected-messages-and-attachments',roomHistoryGranted:false};}
 expired(row){return !!row.closed_at&&new Date(row.closed_at).getTime()+180*86400000<=this.now()*1000;}
 async row(db,id,{write=false}={}){const row=(await db.query(`SELECT * FROM account_chat_reports_v1 WHERE id=$1 AND endpoint=$2 FOR ${write?'UPDATE':'SHARE'}`,[id,this.endpoint])).rows[0];if(!row)fail('chat_report_unavailable',404);return row;}
 async currentTargetWithin(db,row){const room=(await db.query('SELECT room_id,revision,state FROM chat_rooms WHERE room_id=$1 FOR SHARE',[row.room_id])).rows[0];return room?{type:'room',id:room.room_id,version:room.revision,state:room.state}:null;}
 async partyWithin(db,row,actor){
  const ref=chatActorRef(actor);if(row.reporter_account_id===actor.accountId||row.party_refs.includes(ref))return true;
  return !!(await db.query('SELECT 1 FROM chat_memberships WHERE room_id=$1 AND subject_id=$2 AND left_at IS NULL',[row.room_id,ref])).rows.length;
 }
 async independentWithin(db,row,operator){
  // This is an authorization predicate for known case relationships, not a
  // claim about a person's real-world independence. A management principal is
  // required; a normal Galaxy account is not. Only exact issuer+subject keys
  // can identify an existing business relationship here. Equal email addresses
  // or equal subject strings from different realms never create one.
  await db.query('SELECT room_id FROM chat_rooms WHERE room_id=$1 FOR SHARE',[row.room_id]);
  const refs=[...row.party_refs,...(await db.query('SELECT subject_id,controller_ref FROM chat_memberships WHERE room_id=$1 AND left_at IS NULL',[row.room_id])).rows.flatMap(member=>[member.subject_id,member.controller_ref]).filter(Boolean)];
  await lockControllerMappingsWithin(db,this.endpoint,refs.filter(ref=>/^GUID[A-Z0-9]{28}$/.test(ref)));
  if(this.businessAdmin.executorAuthority?.acceptsDuty(operator)){await this.businessAdmin.revalidate(operator,{db});return true;}
  const principal=(await db.query('SELECT issuer,external_subject FROM operations_operator_principals_v1 WHERE operator_id=$1 AND endpoint=$2 FOR SHARE',[operator.operatorId,this.endpoint])).rows[0];
  if(!principal)fail('business_admin_denied',403);
  const accounts=(await db.query('SELECT id FROM community_accounts WHERE endpoint=$1 AND issuer=$2 AND external_subject=$3',[this.endpoint,principal.issuer,principal.external_subject])).rows;
  for(const account of accounts){
   if(account.id===row.reporter_account_id||refs.includes('account:'+account.id))return false;
   const linked=(await db.query(`SELECT l.subject_id FROM community_account_links l JOIN external_identity_links e ON e.id=l.identity_link_id WHERE l.account_id=$1 AND e.endpoint=$2 AND e.revoked_at IS NULL`,[account.id,this.endpoint])).rows;
   if(linked.some(link=>refs.includes(link.subject_id)||refs.includes('subject:'+link.subject_id)))return false;
  }
  return true;
 }
 async assertDutyCaseWithin(db,actor,reportId){
  const authority=this.businessAdmin.executorAuthority;if(!authority?.acceptsDuty(actor))fail('business_admin_denied',403);
  await authority.requireDutyAction(actor,'chat-reports.materials.read',{db,purpose:'prepare'});const context=authority.dutyContext(actor),task=(await db.query('SELECT target_type,target_id FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2 FOR SHARE',[this.endpoint,context.taskId])).rows[0];
  if(!task||!(task.target_type==='chat-report'&&task.target_id===reportId)&&!context.resourceIds.includes(reportId))fail('operations_ai_case_purpose_denied',403);
 }
 async contextWithin(db,row,actor,{operator=false}={}){
  if(operator){const actual=await this.businessAdmin.revalidate(actor,{db}),independent=await this.independentWithin(db,row,actual);if(this.businessAdmin.executorAuthority?.acceptsDuty(actual)&&permitted(actual,'chat-reports.materials.read'))await this.assertDutyCaseWithin(db,actual,row.id);return{operator:true,independent,reporter:false,party:!independent,
   permissions:actual.businessAuthorization.permissions,canReadMaterials:permitted(actual,'chat-reports.materials.read'),canReadAttachments:permitted(actual,'chat-reports.attachments.read'),
   canManageCase:permitted(actual,'chat-reports.moderate')&&independent,canModerate:independent&&['chat-reports.moderate','chat-messages.hide','chat-messages.restore','chat-messages.keep'].some(code=>permitted(actual,code))};}
  this.account(actor);const party=await this.partyWithin(db,row,actor);if(!party)fail('chat_report_unavailable',404);
  return{operator:false,independent:false,reporter:row.reporter_account_id===actor.accountId,party,canModerate:false};
 }
}
