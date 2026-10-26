import {CommunityForumPermissionsV1,forumStamp} from "../community/community-forum-permissions-v1.mjs";
import {defaultForumPolicy,forumPolicySchema,forumPolicyHash} from "../community/community-forum-policy-v1.mjs";
import {recordContentErasure} from './lifecycle-product-v2.mjs';

const day=86400;
async function eraseEvent(db,table,row,{at,retainedUntil,reason,requestId=null}){
 if(!row.payload_text)return false;
 await recordContentErasure(db,{table,key:row.id,subjectId:row.subject_id,accountId:row.subject_id?null:row.account_id,originalHash:row.payload_hash,requestId,at,retainedUntil,reason});
 await db.query(`UPDATE ${table} SET payload_text='',erased_at=COALESCE(erased_at,$2) WHERE id=$1`,[row.id,forumStamp(at)]);return true;
}
export async function prepareForumDeletionWithin(db,info){
 const counts={};
 for(const table of ['forum_events_v1','forum_governance_events_v1']){
  const rows=(await db.query(`SELECT id,subject_id,payload_hash,payload_text FROM ${table} WHERE subject_id=$1 AND payload_text<>'' ORDER BY id FOR UPDATE`,[info.subjectId])).rows;
  for(const row of rows)await eraseEvent(db,table,row,{...info,reason:'subject-deletion'});counts[table]=rows.length;
 }
 await db.query("UPDATE forum_posts_v1 SET state='withdrawn',current_version_id=NULL,erased_at=COALESCE(erased_at,$2) WHERE subject_id=$1",[info.subjectId,forumStamp(info.at)]);
 for(const table of ['forum_versions_v1','forum_replies_v1'])await db.query(`UPDATE ${table} SET state='withdrawn',erased_at=COALESCE(erased_at,$2) WHERE subject_id=$1`,[info.subjectId,forumStamp(info.at)]);
 await db.query('UPDATE forum_permissions_v1 SET revoked_at=COALESCE(revoked_at,$2),erased_at=COALESCE(erased_at,$2) WHERE subject_id=$1',[info.subjectId,forumStamp(info.at)]);
 return counts;
}
// Called after approved owner deletion's leaf pass. Foreign replies retain
// locators only, never the erased author's Account, public key or source text.
export async function minimizeForumDeletionWithin(db,info){
 await prepareForumDeletionWithin(db,info);
 // An online account survives deletion of its last associated local ID. Only
 // that ID's own statements are minimized; Cookie-authored records stay owned.
 await db.query('UPDATE forum_sections_v2 SET creator_subject_id=NULL WHERE creator_subject_id=$1',[info.subjectId]);
 await db.query('UPDATE forum_section_events_v2 SET subject_id=NULL,consent_id=NULL WHERE subject_id=$1',[info.subjectId]);
 for(const table of ['forum_posts_v1','forum_versions_v1','forum_replies_v1','forum_events_v1','forum_governance_events_v1','forum_write_receipts_v1'])
  await db.query(`UPDATE ${table} SET subject_id=NULL,account_id=NULL${['forum_events_v1','forum_governance_events_v1','forum_write_receipts_v1'].includes(table)?',consent_id=NULL':''} WHERE subject_id=$1`,[info.subjectId]);
 await db.query("UPDATE forum_permissions_v1 SET subject_id=NULL,account_id=NULL,consent_id=NULL,origin_binding_id=NULL,source_device_id=NULL,source_key_id=NULL,signer_public_key='',fields='[]',viewers='[]' WHERE subject_id=$1",[info.subjectId]);
 await db.query('UPDATE forum_reports_v1 SET subject_id=NULL,reporter_id=NULL,account_id=NULL WHERE subject_id=$1',[info.subjectId]);
 await db.query('UPDATE forum_reports_v1 SET target_author_id=NULL WHERE target_author_id=$1',[info.subjectId]);
 return {forumRetainedSourcesMinimized:true};
}
export async function cleanupForumWithin(db,at,{policy=defaultForumPolicy,endpoint}={}){
 const parsed=forumPolicySchema.parse(policy),policyHash=forumPolicyHash(parsed),removed={forumBodies:0,forumGovernanceBodies:0},
  permissions=new CommunityForumPermissionsV1({endpoint,now:()=>at},null,{policy:parsed,policyHash});
 if(typeof endpoint!=='string'){
  // Older cleanup callers had no endpoint argument. Existing evidence records
  // carry one exact endpoint; never infer a public hostname from configuration.
  const endpoints=(await db.query("SELECT DISTINCT c.intent->>'endpoint' endpoint FROM forum_permissions_v1 p JOIN consents c ON c.id=p.consent_id LIMIT 2")).rows;
  if(endpoints.length>1)throw new Error('Forum retention endpoint required');permissions.access.endpoint=endpoints[0]?.endpoint??'';
 }
 for(const table of ['forum_events_v1','forum_governance_events_v1']){
  const rows=(await db.query(`SELECT e.id,e.subject_id,e.account_id,e.payload_text,e.payload_hash,p.id permission_id FROM ${table} e
   LEFT JOIN forum_permissions_v1 p ON p.event_id=e.id LEFT JOIN consents c ON c.id=p.consent_id LEFT JOIN bindings b ON b.id=p.origin_binding_id
   LEFT JOIN subject_control_events ce ON ce.id=b.revocation_control_event_id
   WHERE e.payload_text<>'' AND (p.id IS NULL OR p.erased_at IS NOT NULL OR p.published_until<=$1 OR p.revoked_at IS NOT NULL
    OR (p.authorization_kind='official-account' AND p.account_id IS NULL)
    OR (p.authorization_kind='id-consent' AND (p.subject_id IS NULL OR c.expires_at<=$1 OR c.revoked_at IS NOT NULL OR b.id IS NULL
     OR b.revoked_at IS NOT NULL AND (b.revocation_kind IS DISTINCT FROM 'recovery' OR ce.kind IS DISTINCT FROM 'recover' OR ce.subject_id IS DISTINCT FROM p.subject_id))))
   ORDER BY e.created_at,e.id LIMIT 100 FOR UPDATE OF e`,[forumStamp(at)])).rows;
  for(const row of rows){
   // Worker reads provenance without control/Consent row-lock mutation rights.
   const state=await permissions.statusWithin(db,row.permission_id,{viewerId:row.subject_id,lock:false,checkAudience:false});
   // A cancellable pending deletion only hides reads. It does not erase data.
   if(state.allowed||state.reasons.every(reason=>reason==='deletion-pending'))continue;
   if(await eraseEvent(db,table,row,{at,retainedUntil:at+parsed.auditDays*day,reason:'temporary-content-expired'}))removed[table==='forum_events_v1'?'forumBodies':'forumGovernanceBodies']++;
  }
 }
 removed.forumDailyUsage=(await db.query(`DELETE FROM forum_daily_usage_v1 WHERE (account_id,day,category) IN
  (SELECT account_id,day,category FROM forum_daily_usage_v1 WHERE day<$1::date ORDER BY day,account_id,category LIMIT 100)`,[forumStamp(at-parsed.dailyUsageDays*day)])).rowCount;
 removed.forumReceipts=(await db.query('DELETE FROM forum_write_receipts_v1 WHERE operation_id IN (SELECT operation_id FROM forum_write_receipts_v1 WHERE retained_until<=$1 ORDER BY retained_until,operation_id LIMIT 100)',[forumStamp(at)])).rowCount;
 // Closed private cases have their own bounded audit window, not an expiry
 // extension for statements. Preserve open appeals and decisions still active.
 const reports=(await db.query('SELECT id FROM public.galaxy_worker_lock_closed_forum_reports($1)',[forumStamp(at)])).rows;
 for(const row of reports){await db.query('DELETE FROM forum_governance_events_v1 WHERE report_id=$1',[row.id]);await db.query('DELETE FROM forum_reports_v1 WHERE id=$1',[row.id]);}
 removed.forumClosedReports=reports.length;
 // Finite leaf cleanup keeps only locators actually referenced by independent
 // replies or governance targets. It never deletes another author's reply.
 const cutoff=forumStamp(at-parsed.auditDays*day);
 removed.forumReplies=(await db.query(`DELETE FROM forum_replies_v1 r WHERE id IN (SELECT r.id FROM forum_replies_v1 r WHERE r.published_until<=$1
  AND NOT EXISTS(SELECT 1 FROM forum_replies_v1 child WHERE child.reply_to_id=r.id)
  AND NOT EXISTS(SELECT 1 FROM forum_reports_v1 g WHERE g.target->>'replyId'=r.id::text) ORDER BY r.published_until,r.id LIMIT 100)`,[cutoff])).rowCount;
 removed.forumVersions=(await db.query(`DELETE FROM forum_versions_v1 v WHERE id IN (SELECT v.id FROM forum_versions_v1 v WHERE v.published_until<=$1
  AND NOT EXISTS(SELECT 1 FROM forum_replies_v1 r WHERE r.post_version_id=v.id)
  AND NOT EXISTS(SELECT 1 FROM forum_reports_v1 g WHERE g.target->>'versionId'=v.id::text) ORDER BY v.published_until,v.id LIMIT 100)`,[cutoff])).rowCount;
 removed.forumHeads=(await db.query(`DELETE FROM forum_posts_v1 WHERE id IN (SELECT p.id FROM forum_posts_v1 p WHERE p.updated_at<=$1
  AND NOT EXISTS(SELECT 1 FROM forum_versions_v1 v WHERE v.post_id=p.id) AND NOT EXISTS(SELECT 1 FROM forum_replies_v1 r WHERE r.post_id=p.id) ORDER BY p.updated_at,p.id LIMIT 100)`,[cutoff])).rowCount;
 removed.forumEvents=(await db.query(`DELETE FROM forum_events_v1 e WHERE id IN (SELECT e.id FROM forum_events_v1 e WHERE e.payload_text='' AND e.created_at<=$1
  AND NOT EXISTS(SELECT 1 FROM forum_versions_v1 v WHERE v.publication_event_id=e.id) AND NOT EXISTS(SELECT 1 FROM forum_replies_v1 r WHERE r.publication_event_id=e.id) ORDER BY e.created_at,e.id LIMIT 100)`,[cutoff])).rowCount;
 const compact=(await db.query('SELECT public.galaxy_worker_prune_forum_authorizations($1) result',[forumStamp(at)])).rows[0].result;
 removed.forumPermissions=compact.permissions;removed.forumAuthorizationRecords=compact.consents;removed.forumAcceptedAudits=compact.audits;
 return {...removed,forumPolicyHash:policyHash};
}
