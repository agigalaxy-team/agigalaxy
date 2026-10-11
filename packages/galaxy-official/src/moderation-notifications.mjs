import {canReadProjection} from './domain/consent-policy.mjs';
import {ServiceError} from './shared/service-error.mjs';

const stamp=n=>new Date(n*1000).toISOString(),day=86400;
const necessary=new Set(['pause','resume','resolve','appeal','revalidate']);

// The inbox projects live business events; it does not retain another copy of
// private reports, review statements, source material or invitation scope.
export class ModerationNotificationAdapter {
 constructor(moderation){this.moderation=moderation;}
 async candidatesWithin(db,actor,input={},exact=null){
  if(exact&&!['moderation-report','moderation-event'].includes(exact[0]))return[];
  const now=this.moderation.access.now(),after=input.after?.split(':');
  return(await db.query(`WITH notices AS (
   SELECT 'moderation-report'::text kind,r.id event_id,r.id report_id,r.reporter_id actor_id,r.created_at FROM moderation_reports r JOIN consents c ON c.id=r.consent_id
    WHERE r.reporter_id<>$1 AND c.revoked_at IS NULL AND c.expires_at>$2 AND c.intent->'viewers' ? $1
   UNION ALL
   SELECT 'moderation-event',e.id,e.report_id,e.subject_id,e.created_at FROM moderation_events e JOIN consents c ON c.id=e.consent_id
    WHERE e.subject_id<>$1 AND c.revoked_at IS NULL AND c.expires_at>$2 AND c.intent->'viewers' ? $1
  ) SELECT n.*,NULL::uuid room_id,NULL::uuid task_id,'incidents'::text category,r.read_at
   FROM notices n LEFT JOIN notification_reads r ON r.subject_id=$1 AND r.kind=n.kind AND r.event_id=n.event_id
   WHERE n.created_at>$3 AND ($4::uuid IS NULL OR (n.event_id,n.kind)>($4::uuid,$5::text))
    AND ($6::text IS NULL OR n.kind=$6 AND n.event_id=$7::uuid) AND (NOT $8::boolean OR r.event_id IS NULL)
   ORDER BY n.event_id,n.kind LIMIT 200`,[actor.subjectId,stamp(now),stamp(now-90*day),after?.[1]??null,after?.[0]??null,exact?.[0]??null,exact?.[1]??null,input.unreadOnly??false])).rows;
 }
 async noticeWithin(db,actor,noticeKind,eventId){
  if(!['moderation-report','moderation-event'].includes(noticeKind))return null;
  const initial=noticeKind==='moderation-report';
  const row=(await db.query(initial?'SELECT id,id report_id,reporter_id subject_id,consent_id,payload_text,created_at FROM moderation_reports WHERE id=$1':
   'SELECT id,report_id,subject_id,consent_id,payload_text,created_at FROM moderation_events WHERE id=$1',[eventId])).rows[0];
  if(!row||row.subject_id===actor.subjectId)return null;
  try{
   // Validate this exact current grant before readWithin parses any report or
   // invitation history. An old acceptance receipt cannot supply current ACL.
   const grant=await this.moderation.grant(db,row.subject_id,row.consent_id,row.id,row.payload_text);
   if(!canReadProjection(grant,{viewerId:actor.subjectId,now:this.moderation.access.now()}))return null;
   const view=await this.moderation.readWithin(db,actor,row.report_id);
   const event=initial?view.report:view.events.find(e=>e.id===row.id);
   if(!event)return null;
   const kind=initial?'report':event.kind;
   let expiresAt=grant.expiresAt;
   if(kind==='invite-verifier'){
    const own=view.verifierParticipation.own;
    if(event.verifierId!==actor.subjectId||own?.invitationId!==eventId||own.status!=='invited'
     ||!view.canAcceptVerifier||!view.verifierParticipation.sourceAvailable)return null;
    expiresAt=Math.min(expiresAt,own.expiresAt);
   }
   return{title:kind==='invite-verifier'?'邀请你参与具体复核':'举报或复核事项有更新',actorId:row.subject_id,
    category:kind==='invite-verifier'?'invitations':'incidents',eventKind:'moderation-'+kind,
    object:{type:'moderation',id:row.report_id,eventId:row.id,version:initial?1:event.version},
    serviceReceipt:necessary.has(kind),sourceExpiresAt:stamp(expiresAt)};
  }catch(error){if(error instanceof ServiceError&&[403,404,410].includes(error.status))return null;throw error;}
 }
}
