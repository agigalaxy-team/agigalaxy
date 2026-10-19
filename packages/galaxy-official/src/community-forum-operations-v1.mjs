import {ServiceError} from './shared/service-error.mjs';
import {digest} from './shared/digest.mjs';
import {forumStamp} from './community-forum-permissions-v1.mjs';

export async function lockForumOperation(db,operationId){await db.query('SELECT pg_advisory_xact_lock(734912318,hashtext($1))',[operationId]);}
export async function priorForumOperation(db,actor,operationId,payloadJson){
 const row=(await db.query(`SELECT subject_id,account_id,payload_hash,result,locator FROM forum_write_receipts_v1 WHERE operation_id=$1
  UNION ALL SELECT subject_id,account_id,payload_hash,result,NULL::jsonb locator FROM forum_events_v1 WHERE id=$1
  UNION ALL SELECT subject_id,account_id,payload_hash,result,NULL::jsonb locator FROM forum_governance_events_v1 WHERE operation_id=$1
  UNION ALL SELECT subject_id,account_id,payload_hash,result,NULL::jsonb locator FROM forum_section_events_v2 WHERE id=$1 LIMIT 1`,[operationId])).rows[0];
 if(!row)return null;
 const owns=actor.kind==='official-account'?row.account_id===actor.accountId:!!actor.subjectId&&row.subject_id===actor.subjectId&&(!actor.accountId||actor.accountId===row.account_id);
 if(!owns||row.payload_hash!==digest(payloadJson))throw new ServiceError('forum_operation_conflict',409);
 return {...row.result,acknowledged:true,authority:'accepted-operation-only'};
}
export async function recordForumReceipt(db,actor,{operationId,consentId,payloadJson,accountId=null,category=null,locator,result,now,auditDays}){
 await db.query(`INSERT INTO forum_write_receipts_v1(operation_id,subject_id,account_id,category,payload_hash,consent_id,locator,result,created_at,retained_until,actor_kind)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[operationId,actor.subjectId??null,accountId,category,digest(payloadJson),consentId,JSON.stringify(locator),JSON.stringify(result),forumStamp(now),forumStamp(now+auditDays*86400),actor.kind==='official-account'?'official-account':'identity']);
}
export async function recordForumAudit(db,actor,authorization,{operationId,consentId,action,sourceTable='forum_events_v1',sourceEventId=operationId}){
 if(actor.kind==='official-account'){
  // The append-only forum event is the account's accepted-action audit, with
  // its real account and HTTP request. It is not an ID signature audit.
  if(!['forum_events_v1','forum_section_events_v2','forum_governance_events_v1'].includes(sourceTable))throw new Error('Invalid forum audit source');
  const event=(await db.query(`SELECT id FROM ${sourceTable} WHERE id=$1 AND account_id=$2 AND actor_kind='official-account'
   AND subject_id IS NULL AND consent_id IS NULL AND http_request_id IS NOT DISTINCT FROM $3::uuid`,[sourceEventId,actor.accountId,actor.httpRequestId??null])).rows[0];
  if(!event||authorization.kind!=='official-account'||authorization.accountId!==actor.accountId)throw new Error('Forum account audit context unavailable');
  return;
 }
 const result=await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,
  http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
  SELECT $1,$4,$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,$5,c.id,b.id,$6,$2::text,b.scopes,$7::jsonb,
  cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id
  JOIN bindings cb ON cb.id=$8::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=$3 AND c.subject_id=$1 RETURNING sequence`,
  [actor.subjectId,operationId,consentId,action,['forum.governance.resolve','forum.section.classify'].includes(action)?'moderation':'assistance',actor.httpRequestId??null,JSON.stringify(authorization.credentialScopes),authorization.callerBindingId]);
 if(result.rows.length!==1)throw new Error('Forum audit context unavailable');
}
export async function forumReceiptWithin(db,actor,{operationId,payloadHash}){
 const owner=actor.kind==='official-account'?'account_id':'subject_id',key=actor.kind==='official-account'?actor.accountId:actor.subjectId;
 const row=(await db.query(`SELECT subject_id,account_id,payload_hash,locator,result FROM forum_write_receipts_v1 WHERE operation_id=$1 AND ${owner}=$2
  UNION ALL SELECT subject_id,account_id,payload_hash,NULL::jsonb locator,result FROM forum_events_v1 WHERE id=$1 AND ${owner}=$2
  UNION ALL SELECT subject_id,account_id,payload_hash,NULL::jsonb locator,result FROM forum_governance_events_v1 WHERE operation_id=$1 AND ${owner}=$2
  UNION ALL SELECT subject_id,account_id,payload_hash,NULL::jsonb locator,result FROM forum_section_events_v2 WHERE id=$1 AND ${owner}=$2 LIMIT 1`,[operationId,key])).rows[0];
 if(row&&actor.kind!=='official-account'&&actor.accountId&&row.account_id!==actor.accountId)return {operationId,payloadHash,status:'absent',authority:'accepted-operation-only; not-current-read-access'};
 const status=!row?'absent':row.payload_hash===payloadHash?'acknowledged':'conflict';
 return {operationId,payloadHash,status,...(status==='acknowledged'?{locator:row.locator??row.result.locator??locatorForResult(row.result),result:row.result}:{}),authority:'accepted-operation-only; not-current-read-access'};
}
function locatorForResult(value){return value.sectionId?{kind:'section',sectionId:value.sectionId}:value.replyId?{kind:'reply',replyId:value.replyId,contentRevision:1}:value.versionId?{kind:'post-version',postId:value.postId,versionId:value.versionId}:value.postId?{kind:'post',postId:value.postId}:{kind:'report',reportId:value.reportId};}
