import * as z from 'zod/v4';
import {ServiceError} from './shared/service-error.mjs';
import {transaction} from './database.mjs';
import {recordNotificationAudit} from './infrastructure/notification-audit.mjs';
import {inboxIdSchema,inboxOptionsSchema,inboxQuerySchema,inboxClaimSchema} from './shared/notification-inbox-schema.mjs';
import {commentNotificationView} from './task-comment-notifications.mjs';
import {targetGovernanceNoticeWithin} from './target-governance-notifications-v2.mjs';
const day=86400,stamp=n=>new Date(n*1000).toISOString();
const fail=(c,s=409)=>{throw new ServiceError(c,s);};
function parse(schema,x){const p=schema.safeParse(x);if(!p.success)fail('invalid_inbox_request',400);return p.data;}
const compare=(a,b)=>a.event_id.localeCompare(b.event_id)||a.kind.localeCompare(b.kind);
const key=c=>c.kind+':'+c.event_id;

// This is a projection over business sources, not a delivery queue or a model.
export class NotificationInboxService {
 constructor({access,notifications,chat,tasks=null,comments=null,commentGovernance=null,moderationNotifications=null}){Object.assign(this,{access,notifications,chat,tasks,comments,commentGovernance,moderationNotifications});}
 run(actor,write,fn){return write?this.access.runResourceWrite(actor,'notifications',{},fn):this.access.runAuthorized(actor,'notifications',fn);}
 async optionsWithin(db,actor){const r=(await db.query('SELECT revision,settings FROM notification_options_v2 WHERE subject_id=$1',[actor.subjectId])).rows[0];
  return{revision:r?.revision??0,settings:parse(inboxOptionsSchema,r?.settings??{}),externalDelivery:'disabled'};}
 options(actor){return this.run(actor,false,db=>this.optionsWithin(db,actor));}
 saveOptions(actor,input){const x=parse(z.strictObject({expectedRevision:z.number().int().nonnegative(),settings:inboxOptionsSchema}),input);
  return this.run(actor,true,async(db,authorization)=>{
   await db.query('INSERT INTO notification_options_v2(subject_id,settings,updated_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[actor.subjectId,JSON.stringify(parse(inboxOptionsSchema,{})),stamp(this.access.now())]);
   const r=(await db.query('SELECT revision FROM notification_options_v2 WHERE subject_id=$1 FOR UPDATE',[actor.subjectId])).rows[0];if(r.revision!==x.expectedRevision)fail('inbox_options_conflict');
   await db.query('UPDATE notification_options_v2 SET settings=$2,revision=revision+1,updated_at=$3 WHERE subject_id=$1',[actor.subjectId,JSON.stringify(x.settings),stamp(this.access.now())]);
   await recordNotificationAudit(db,actor,authorization,{action:'notification.preferences',objectId:actor.subjectId,idempotencyKey:'inbox-v2:'+(r.revision+1)});
   return this.optionsWithin(db,actor);
  });
 }
 async isBlockedWithin(db,viewerId,candidateId){if(!viewerId||!candidateId)return false;
  return (await db.query(`SELECT subject_id FROM notification_options_v2 WHERE (subject_id=$1 AND settings->'blockedSubjectIds' ? $2)
   OR (subject_id=$2 AND settings->'blockedSubjectIds' ? $1) LIMIT 1`,[viewerId,candidateId])).rows.length>0;
 }
 async newCandidates(db,actor,x,exact=null){const after=x.after?.split(':');return(await db.query(`WITH inbox AS (
  SELECT 'room-message'::text kind,m.message_id event_id,m.room_id,NULL::uuid task_id,m.subject_id actor_id,m.sent_at created_at,'rooms'::text category
   FROM chat_message_refs m JOIN chat_memberships s ON s.room_id=m.room_id AND s.subject_id=$1 AND s.left_at IS NULL
   WHERE m.subject_id<>$1 AND m.state='accepted' AND m.expires_at>$2
  UNION ALL
  SELECT 'room-invite',d.decision_id,d.room_id,NULL::uuid,d.proposer_subject_id,d.created_at,'invitations'
   FROM chat_decisions d JOIN chat_rooms r USING(room_id) WHERE d.action='invite' AND d.payload->>'targetSubjectId'=$1
   AND d.state='approved' AND d.expires_at>$2 AND d.member_revision=r.member_revision AND r.state<>'archived'
  UNION ALL
  SELECT 'task-v2',e.id,NULL::uuid,e.task_id,e.subject_id,e.created_at,
   CASE WHEN e.kind='invite' THEN 'invitations' ELSE 'collaboration' END
   FROM task_events e JOIN task_requests t ON t.id=e.task_id JOIN consents c ON c.id=e.consent_id
   WHERE e.subject_id<>$1 AND e.kind NOT IN ('create','suggest-contacts') AND
    (t.requester_id=$1 OR c.intent->'viewers' ? $1 OR EXISTS(SELECT 1 FROM task_participations p WHERE p.task_id=t.id AND p.subject_id=$1))
  UNION ALL
  SELECT 'task-comment',e.id,NULL::uuid,c.task_id,e.subject_id,e.created_at,'collaboration'
   FROM task_comment_events_v2 e JOIN task_comments_v2 c ON c.id=e.comment_id JOIN task_requests t ON t.id=c.task_id
   LEFT JOIN task_comments_v2 parent ON parent.id=c.reply_to_id
   WHERE e.id=c.current_event_id AND e.kind<>'retract' AND e.subject_id<>$1 AND (t.requester_id=$1 OR parent.subject_id=$1)
  UNION ALL
  SELECT 'comment-governance',e.id,NULL::uuid,c.task_id,e.subject_id,e.created_at,'incidents'
   FROM comment_governance_events_v2 e JOIN comment_reports_v2 r ON r.id=e.report_id JOIN task_comments_v2 c ON c.id=r.comment_id JOIN consents s ON s.id=e.consent_id
   WHERE e.subject_id<>$1 AND s.intent->'viewers' ? $1
  UNION ALL
  SELECT 'qualification-request',e.id,NULL::uuid,r.task_id,e.subject_id,e.created_at,'materials'
   FROM qualification_permission_request_events e JOIN qualification_permission_requests r ON r.id=e.request_id
   WHERE e.subject_id<>$1 AND (r.subject_id=$1 OR r.source_author_id=$1) AND r.expires_at>$2
  UNION ALL
  SELECT 'information-change',e.id,NULL::uuid,NULL::uuid,e.subject_id,e.available_at,'materials'
   FROM information_watch_changes_v2 e WHERE e.subject_id=$1 AND e.available_at<=$2 AND e.expires_at>$2
  UNION ALL
  SELECT 'target-governance',e.id,r.room_id,r.task_id,e.subject_id,e.created_at,'incidents'
   FROM target_governance_events_v2 e JOIN target_reports_v2 r ON r.id=e.report_id JOIN consents s ON s.id=e.consent_id
   WHERE e.subject_id<>$1 AND (s.intent->'viewers' ? $1 OR r.party_ids ? $1 AND e.kind IN ('review','pause','resolve','resume','appeal','withdraw-report'))
 ) SELECT i.*,r.read_at FROM inbox i LEFT JOIN notification_reads r ON r.subject_id=$1 AND r.kind=i.kind AND r.event_id=i.event_id
  WHERE i.created_at>$3 AND ($4::uuid IS NULL OR (i.event_id,i.kind)>($4::uuid,$5::text))
  AND ($6::text IS NULL OR i.kind=$6 AND i.event_id=$7::uuid) AND (NOT $8::boolean OR r.event_id IS NULL)
  ORDER BY i.event_id,i.kind LIMIT 200`,[actor.subjectId,stamp(this.access.now()),stamp(this.access.now()-90*day),after?.[1]??null,after?.[0]??null,exact?.[0]??null,exact?.[1]??null,x.unreadOnly??false])).rows;}
 async visibleWithin(db,actor,c){
  if(['moderation-report','moderation-event'].includes(c.kind))return this.moderationNotifications?.noticeWithin(db,actor,c.kind,c.event_id)??null;
  if(c.kind==='target-governance')return targetGovernanceNoticeWithin(db,actor,c.event_id,this.targetGovernance);
  if(c.kind==='information-change')return this.informationWatches?.notificationWithin(db,actor,c.event_id)??null;
  if(c.kind==='qualification-request'){
   if(!this.qualificationRequests)return null;
   const row=(await db.query('SELECT request_id FROM qualification_permission_request_events WHERE id=$1',[c.event_id])).rows[0];if(!row)return null;
   const view=await this.qualificationRequests.readWithin(db,actor,{requestId:row.request_id});
   const event=view.history?.find(e=>e.eventId===c.event_id);if(!event)return null;
   return{title:'限定资格计算许可事项',eventKind:'qualification-permission-'+event.kind,actorId:event.by,
    object:{type:'qualification-request',id:row.request_id},sourceExpiresAt:view.expiresAt,serviceReceipt:event.kind!=='request'};
  }
  if(['task-comment','comment-governance'].includes(c.kind))return commentNotificationView(db,actor,c,this);
  if(c.kind==='room-message'){
   const ctx=await this.chat.requireRoom(db,actor,c.room_id);
   const r=(await db.query(`SELECT m.*,EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=m.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased')) author_pending
    FROM chat_message_refs m WHERE m.message_id=$1 AND m.room_id=$2 FOR SHARE OF m`,[c.event_id,c.room_id])).rows[0];
   if(!r||r.state!=='accepted'||Date.parse(r.expires_at)<=this.access.now()*1000||r.author_pending)return null;
   return{title:ctx.room.title,eventKind:'room-message',actorId:r.subject_id,object:{type:'room',id:c.room_id,messageId:r.message_id},sourceExpiresAt:new Date(r.expires_at).toISOString()};
  }
  if(c.kind==='room-invite'){
   const ctx=await this.chat.requireRoom(db,actor,c.room_id,{member:false});if(ctx.room.parent_room_id)await this.chat.requireRoom(db,actor,ctx.room.parent_room_id);
   const d=(await db.query('SELECT * FROM chat_decisions WHERE decision_id=$1 FOR SHARE',[c.event_id])).rows[0];
   if(!d||d.state!=='approved'||d.member_revision!==ctx.room.member_revision||Date.parse(d.expires_at)<=this.access.now()*1000||ctx.room.state==='archived')return null;
   if(d.action==='invite'&&ctx.governance.scopes.includes('invitations-paused'))return null;
   return{title:ctx.room.title,eventKind:'room-invitation',actorId:d.proposer_subject_id,object:{type:'room-invitation',id:d.decision_id,roomId:d.room_id}};
  }
  if(c.kind==='task-v2'){
   if(!this.tasks)return null;const t=await this.tasks.requireTaskWithin(db,actor,c.task_id);
   const e=await this.tasks.taskRepository.event(db,c.event_id);if(!e||!this.tasks.visible(await this.tasks.taskGrant(db,e),actor.subjectId))return null;
   const event=JSON.parse(e.payload_text).event;
   if(e.kind==='invite'&&event?.recipientId!==actor.subjectId)return null;
   if(e.kind==='invite'&&t.governance.scopes.includes('new-participation-paused'))return null;
   const current=await this.tasks.readTaskWithin(db,actor,c.task_id);
   return{title:current.request.title,...(current.textView?{textView:{title:current.textView.fields.title}}:{}),eventKind:e.kind,actorId:e.subject_id,object:{type:'task',id:e.task_id,eventId:e.id},serviceReceipt:['dispute','confirm-resolution','propose-resolution'].includes(e.kind)};
  }
  const v=await this.notifications.visible(db,actor,c);if(!v)return null;const {summary:_summary,...safe}=v;
  return {...safe,object:c.kind==='capsule'&&v.object?v.object:c.assistance_id?{type:'assistance',id:c.assistance_id}:c.kind==='incident'?{type:'incident',id:v.incidentId}:{type:c.kind,id:c.event_id},serviceReceipt:c.kind==='incident'};
 }
 async collectWithin(db,actor,x,exact=null){
  const legacy=await this.notifications.preferencesWithin(db,actor),extra=await this.optionsWithin(db,actor);
  const settings={...legacy.settings,invitations:true,collaboration:true,materials:true,capsules:true,incidents:true,mutedAssistanceIds:[]};
  const a=await this.notifications.candidates(db,actor,x,settings,exact,legacy.archivedBefore),b=await this.newCandidates(db,actor,x,exact);
  const m=await this.moderationNotifications?.candidatesWithin(db,actor,x,exact)??[];
  const candidates=[...a,...b,...m].filter(c=>Date.parse(c.created_at)>this.access.now()*1000-90*day*1000&&(!legacy.archivedBefore||Date.parse(c.created_at)>=Date.parse(legacy.archivedBefore))).sort(compare).slice(0,200);
  return{candidates,legacy,extra,possiblyMore:[a,b,m].some(list=>list.length===200)||a.length+b.length+m.length>200};
 }
 async itemWithin(db,actor,c,legacy,extra){try{
  const v=await this.visibleWithin(db,actor,c);if(!v)return null;
  const s=extra.settings,roomId=c.room_id,blocked=s.blockedSubjectIds.includes(v.actorId)||s.roomBlocks.some(b=>b.roomId===roomId&&b.subjectId===v.actorId);
  const category=v.category??c.category,categoryDisabled=legacy.settings[category]===false;
  const quiet=!legacy.settings.enabled||categoryDisabled||blocked||legacy.settings.mutedAssistanceIds.includes(c.assistance_id)
   ||roomId&&(s.mutedRoomIds.includes(roomId)||!s.rooms)||['task-v2','task-comment'].includes(c.kind)&&!s.tasks;
  if(!v.serviceReceipt&&(blocked||!legacy.settings.enabled||categoryDisabled))return null;
  const present=(await db.query('SELECT presented_at FROM notification_presentations WHERE subject_id=$1 AND kind=$2 AND event_id=$3',[actor.subjectId,c.kind,c.event_id])).rows[0];
  return{id:key(c),category,at:new Date(c.created_at).toISOString(),read:!!c.read_at,...v,
   quiet:!!quiet,interruptiveEligible:!quiet&&!c.read_at&&!present?.presented_at,presented:!!present?.presented_at};
 }catch(e){if(e instanceof ServiceError&&[403,404].includes(e.status))return null;throw e;}}
 query(actor,input={}){const x=parse(inboxQuerySchema,input);return this.run(actor,false,async db=>{
  const {candidates,legacy,extra,possiblyMore}=await this.collectWithin(db,actor,x),items=[];let scanned=null,stopped=false;
  for(const c of candidates){scanned=key(c);const item=await this.itemWithin(db,actor,c,legacy,extra);if(item)items.push(item);if(items.length===x.limit){stopped=true;break;}}
  return{items,nextAfter:stopped||possiblyMore?scanned:null,lastCheckedAt:stamp(this.access.now()),externalDelivery:'disabled',deliveryConfirmed:false};
 });}
 async oneWithin(db,actor,id){const {candidates,legacy,extra}=await this.collectWithin(db,actor,{},id.split(':'));const c=candidates.find(c=>key(c)===id);
  const item=c&&await this.itemWithin(db,actor,c,legacy,extra);if(!item)fail('notification_not_found',404);return item;}
 claim(actor,input){const x=parse(inboxClaimSchema,input);return this.run(actor,true,async db=>{
  const item=await this.oneWithin(db,actor,x.id),[kind,id]=x.id.split(':');
  if(!item.interruptiveEligible)return{id:x.id,claimed:false,presented:item.presented,quiet:item.quiet};
  const r=(await db.query(`INSERT INTO notification_presentations(subject_id,kind,event_id,client_id,claim_id,lease_until,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(subject_id,kind,event_id) DO UPDATE SET client_id=EXCLUDED.client_id,
   claim_id=EXCLUDED.claim_id,lease_until=EXCLUDED.lease_until
   WHERE notification_presentations.presented_at IS NULL AND (notification_presentations.lease_until<=$8 OR
    notification_presentations.client_id=$4 AND notification_presentations.claim_id=$5) RETURNING claim_id,lease_until`,
   [actor.subjectId,kind,id,x.deliveryClientId,x.claimId,stamp(this.access.now()+30),stamp(Math.min(Date.parse(item.at)/1000+90*day,item.sourceExpiresAt?Date.parse(item.sourceExpiresAt)/1000:Infinity)),stamp(this.access.now())])).rows[0];
  return{id:x.id,claimed:!!r,claimId:r?.claim_id??null,leaseUntil:r?new Date(r.lease_until).toISOString():null,deliveryConfirmed:false};
 });}
 presented(actor,input){const x=parse(inboxClaimSchema,input);return this.run(actor,false,async db=>{
  // This acknowledges a previously claimed display, not another source read.
  // A mute, human read or withdrawal after display must not lose its original
  // receipt and let another device prompt again. Exact ownership and the
  // original live lease remain required; no old event body is retrieved.
  const [kind,id]=x.id.split(':');const r=await db.query(`UPDATE notification_presentations SET presented_at=COALESCE(presented_at,$6)
   WHERE subject_id=$1 AND kind=$2 AND event_id=$3 AND client_id=$4 AND claim_id=$5 AND (presented_at IS NOT NULL OR lease_until>$6) RETURNING event_id`,
   [actor.subjectId,kind,id,x.deliveryClientId,x.claimId,stamp(this.access.now())]);
  const read=(await db.query('SELECT 1 FROM notification_reads WHERE subject_id=$1 AND kind=$2 AND event_id=$3',[actor.subjectId,kind,id])).rows.length>0;
  return{id:x.id,presented:r.rows.length>0,acknowledgement:'client-reported-display',read,humanReadChanged:false};
 });}
 markRead(actor,input){const x=parse(z.strictObject({id:inboxIdSchema,reader:z.literal('human')}),input);return this.run(actor,true,async(db,authorization)=>{
  await this.oneWithin(db,actor,x.id);const [kind,id]=x.id.split(':');
  await db.query('INSERT INTO notification_preferences(subject_id,settings) VALUES($1,$2) ON CONFLICT DO NOTHING',[actor.subjectId,JSON.stringify((await this.notifications.preferencesWithin(db,actor)).settings)]);
  await db.query('SELECT subject_id FROM notification_preferences WHERE subject_id=$1 FOR UPDATE',[actor.subjectId]);
  await this.oneWithin(db,actor,x.id);
  const r=await db.query('INSERT INTO notification_reads(subject_id,kind,event_id,read_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id',[actor.subjectId,kind,id,stamp(this.access.now())]);
  if(r.rows.length)await recordNotificationAudit(db,actor,authorization,{action:'notification.read',objectId:id,idempotencyKey:x.id});
  return{id:x.id,read:true};
 });}
 // Worker-only cleanup. API roles do not receive DELETE for these tables.
 async eraseSubjectWithin(db,subjectId){
  const a=await db.query('DELETE FROM notification_presentations WHERE subject_id=$1 RETURNING event_id',[subjectId]);
  await db.query('DELETE FROM notification_options_v2 WHERE subject_id=$1',[subjectId]);return{removedPresentations:a.rows.length,sourceEventsDeleted:false};
 }
 async purgeExpired(db=this.access.db){return transaction(db,async tx=>{const r=await tx.query('DELETE FROM notification_presentations WHERE expires_at<=$1 RETURNING event_id',[stamp(this.access.now())]);return{removedPresentations:r.rows.length,sourceEventsDeleted:false};});}
}
