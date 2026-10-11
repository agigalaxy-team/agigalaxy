import {randomUUID} from 'node:crypto';
import {compactVerify,importSPKI} from 'jose';
import {ServiceError} from './shared/service-error.mjs';
import {digest} from './shared/digest.mjs';
import canonicalize from 'canonicalize';

export const forumStamp=seconds=>new Date(seconds*1000).toISOString();
export const forumSeconds=value=>Math.floor(Date.parse(value)/1000);
export class CommunityForumPermissionsV1 {
 constructor(access,consents,{policy,policyHash}){Object.assign(this,{access,consents,policy,policyHash});}
 async captureWithin(db,actor,{consentId,payloadJson,spec,eventId,accountId=null,publishedUntil=null,allowedViewers=null,requiredViewers=[]}){
  const grant=await this.consents.require(db,{id:consentId,subjectId:actor.subjectId,action:spec.action,objectId:spec.objectId,recipient:this.access.endpoint,payloadJson});
  if(grant.currentVisibility?.deletionPending||grant.visibility!==spec.visibility||grant.purpose!==(spec.visibility==='Public'?'public-profile':'operational')
   ||Object.keys(JSON.parse(payloadJson)).sort((a,b)=>a<b?-1:a>b?1:0).join(',')!==[...grant.fields].sort((a,b)=>a<b?-1:a>b?1:0).join(','))throw new ServiceError('forum_permission_mismatch',403);
  if(spec.visibility==='Public'&&grant.viewers.length)throw new ServiceError('forum_permission_mismatch',403);
  if(allowedViewers&&grant.viewers.some(id=>id!==actor.subjectId&&!allowedViewers.includes(id)))throw new ServiceError('forum_private_audience_mismatch',403);
  if(requiredViewers.some(id=>id!==actor.subjectId&&!grant.viewers.includes(id)))throw new ServiceError('forum_decision_notice_required',403);
  const until=publishedUntil??grant.expiresAt,now=this.access.now();
  if(until<=now||until>grant.expiresAt||until>now+this.policy.maxPermissionSeconds)throw new ServiceError('forum_permission_expiry',403);
  const row=(await db.query(`SELECT c.*,b.device_id,b.key_id,b.control_epoch binding_epoch,
   COALESCE(d.public_key,s.public_key) signer_public_key FROM consents c JOIN bindings b ON b.id=c.binding_id
   JOIN subjects s ON s.id=c.subject_id LEFT JOIN device_authorizations d ON d.subject_id=c.subject_id AND d.device_id=b.device_id
   WHERE c.id=$1 AND c.subject_id=$2`,[consentId,actor.subjectId])).rows[0];
  if(!row?.signature_envelope||!row.signed_payload_text||!row.signer_public_key||digest(row.signature_envelope)!==row.signature_hash)
   throw new ServiceError('forum_signature_evidence_required',403);
  try{
   const verified=await compactVerify(row.signature_envelope,await importSPKI(row.signer_public_key,'Ed25519'),{algorithms:['Ed25519']});
   if(Object.keys(verified.protectedHeader).sort().join(',')!=='alg,typ'||verified.protectedHeader.typ!=='galaxy-consent+jws'
    ||Buffer.from(verified.payload).toString('utf8')!==row.signed_payload_text||canonicalize(JSON.parse(row.signed_payload_text))!==canonicalize(row.intent))throw Error();
  }catch{throw new ServiceError('forum_signature_evidence_required',403);}
  const id=randomUUID();
  await db.query(`INSERT INTO forum_permissions_v1(id,subject_id,account_id,event_id,consent_id,origin_binding_id,source_device_id,source_key_id,
   accepted_epoch,accepted_control_hash,signer_public_key,signature_hash,payload_hash,action,object_id,visibility,fields,viewers,issued_at,published_until,accepted_at,authorization_audit_until,policy_hash)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
   [id,actor.subjectId,accountId,eventId,consentId,row.binding_id,row.device_id,row.signer_key_id??row.key_id,row.control_epoch??0,row.control_event_hash,
    row.signer_public_key,row.signature_hash,digest(payloadJson),spec.action,spec.objectId,spec.visibility,JSON.stringify(grant.fields),JSON.stringify(grant.viewers),
    forumStamp(grant.issuedAt),forumStamp(until),forumStamp(now),forumStamp(Math.max(until,grant.expiresAt)+this.policy.auditDays*86400),this.policyHash]);
  return {id,grant,publishedUntil:until};
 }
 async statusWithin(db,id,{viewerId=null,visibility=null,payloadHash=null,action=null,objectId=null,lock=true}={}){
  const row=(await db.query(`SELECT p.id,p.subject_id,p.account_id,p.event_id,p.consent_id,p.origin_binding_id,p.source_device_id,p.source_key_id,
    p.accepted_epoch,p.accepted_control_hash,p.signature_hash,p.payload_hash,p.action,p.object_id,p.visibility,p.fields,p.viewers,
    p.issued_at,p.published_until,p.accepted_at,p.revoked_at,p.erased_at,p.policy_hash,c.intent,c.revoked_at consent_revoked,c.signature_hash consent_signature_hash,
    b.revoked_at binding_revoked,b.revocation_kind,b.revocation_control_event_id,b.revocation_request_id,b.expires_at binding_expires,
    e.kind revocation_event_kind,e.subject_id revocation_event_subject
    FROM forum_permissions_v1 p JOIN consents c ON c.id=p.consent_id JOIN bindings b ON b.id=p.origin_binding_id
    LEFT JOIN subject_control_events e ON e.id=b.revocation_control_event_id WHERE p.id=$1${lock?' FOR SHARE OF p,c,b':''}`,[id])).rows[0];
  if(!row)return {allowed:false,reasons:['permission-unavailable'],row:null};
  const reasons=[],now=this.access.now(),intent=row.intent;
  if(!row.subject_id||row.erased_at)reasons.push('content-erased');
  if(forumSeconds(row.published_until)<=now||intent.expiresAt<=now)reasons.push('content-expired');
  if(row.revoked_at)reasons.push('permission-revoked');
  if(row.consent_revoked)reasons.push('consent-revoked');
  if(row.consent_signature_hash!==row.signature_hash||intent.subjectId!==row.subject_id||intent.bindingId!==row.origin_binding_id
   ||intent.endpoint!==this.access.endpoint||intent.recipient!==this.access.endpoint||intent.action!==row.action||intent.objectId!==row.object_id
   ||intent.payloadHash!==row.payload_hash||JSON.stringify(intent.fields)!==JSON.stringify(row.fields)||JSON.stringify(intent.viewers)!==JSON.stringify(row.viewers)
   ||intent.visibility!==row.visibility||forumSeconds(row.published_until)>intent.expiresAt||payloadHash&&payloadHash!==row.payload_hash||action&&action!==row.action||objectId&&objectId!==row.object_id)
   reasons.push('permission-evidence-mismatch');
  if(visibility&&row.visibility!==visibility)reasons.push('audience-mismatch');
  if(row.visibility==='Public'&&intent.purpose!=='public-profile'||row.visibility==='Private'&&viewerId!==row.subject_id&&!row.viewers.includes(viewerId))reasons.push('audience-mismatch');
  if(row.binding_revoked){
   if(row.revocation_kind==='explicit-binding')reasons.push('binding-explicitly-revoked');
   else if(row.revocation_kind==='device-revoked')reasons.push('source-device-revoked');
   else if(row.revocation_kind!=='recovery'||row.revocation_event_kind!=='recover'||row.revocation_event_subject!==row.subject_id)reasons.push('historical-cause-unavailable');
  }
  if(row.subject_id&&(await db.query("SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased') LIMIT 1",[row.subject_id])).rows.length)
   reasons.push('deletion-pending');
  return {allowed:reasons.length===0,reasons,row};
 }
 async requireWithin(db,id,options={}){const state=await this.statusWithin(db,id,options);if(!state.allowed)throw new ServiceError('forum_content_unavailable',403);return state.row;}
 async detailWithin(db,actor,id){
  const state=await this.statusWithin(db,id,{viewerId:actor.subjectId});if(!state.row||state.row.subject_id!==actor.subjectId)throw new ServiceError('not_found',404);
  const p=state.row;return {permissionId:p.id,eventId:p.event_id,objectId:p.object_id,visibility:p.visibility,publishedUntil:forumSeconds(p.published_until),
   originBindingExpiresAt:forumSeconds(p.binding_expires),revokedAt:p.binding_revoked?forumSeconds(p.binding_revoked):null,
   revocationKind:p.revocation_kind??null,revocationEventId:p.revocation_control_event_id??null,revocationRequestId:p.revocation_request_id??null,
   stoppedReasons:state.reasons,checkedAt:this.access.now(),authority:'current-forum-permission-only'};
 }
 detail(actor,id){return this.access.runAuthorized(actor,actor.scopes?.includes('assistance')?'assistance':'moderation',db=>this.detailWithin(db,actor,id));}
 async publicEvidenceWithin(db,permission){
  const row=(await db.query('SELECT c.intent,c.signature_envelope,p.signer_public_key FROM consents c JOIN forum_permissions_v1 p ON p.consent_id=c.id WHERE p.id=$1',[permission.id])).rows[0];
  return {consentId:permission.consent_id,intent:row.intent,signatureEnvelope:row.signature_envelope,signerPublicKey:row.signer_public_key,
   acceptedEpoch:permission.accepted_epoch,acceptedControlHead:permission.accepted_control_hash};
 }
}
