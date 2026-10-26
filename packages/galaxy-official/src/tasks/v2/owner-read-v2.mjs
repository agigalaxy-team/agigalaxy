import { digest } from "../../shared/digest.mjs";
import { ServiceError } from "../../shared/service-error.mjs";
import { productV2Retention } from "../../infrastructure/lifecycle-registry-v2.mjs";
import { taskOwnerReadPrepareV2Schema, taskOwnerReadDescriptorV2Schema, taskOwnerReadRequestV2Schema,
  taskOwnerReadPreviewV2Schema, taskOwnerReadResultV2Schema } from "../../shared/task-owner-read-v2-schema.mjs";

const guarantees = Object.freeze({projection:'currently-authorized-authored-events',completeTaskSnapshot:false,
  contextAccessGranted:false,referenceAccessGranted:false,taskWriteGranted:false});
function parse(schema, input) {
  const result=schema.safeParse(input);
  if(!result.success)throw new ServiceError('invalid_task_owner_read');
  return result.data;
}
const unavailable = () => { throw new ServiceError('task_owner_read_source_unavailable',403); };
const seconds = value => Date.parse(value)/1000;

// An explicit new owner-only reading intent. This neither repairs the old grant
// nor changes Task GET/write authorization or rebuilds a partial Task snapshot.
export class TaskOwnerReadServiceV2 {
  constructor(access, consents, {maxReadSeconds=3600}={}) {
    if(!Number.isInteger(maxReadSeconds)||maxReadSeconds<1||maxReadSeconds>3600)throw new Error('invalid_owner_read_ttl');
    this.access=access;this.consents=consents;this.maxReadSeconds=maxReadSeconds;
  }
  current(authorization) {
    const control=authorization.identityControl;
    if(!control?.deviceId||!control.epoch)throw new ServiceError('task_owner_read_control_required',403);
    return {bindingId:authorization.callerBindingId,deviceId:control.deviceId,controlEpoch:control.epoch};
  }
  async sourceWithin(db, actor, taskId, eventIds, control) {
    const now=this.access.now();
    const task=(await db.query(`SELECT id,requester_id,root_event_id,version,case_id,
      COALESCE((snapshot->>'contentDeleted')::boolean,false) AS content_deleted
      FROM task_requests WHERE id=$1 AND requester_id=$2 FOR SHARE`,[taskId,actor.subjectId])).rows[0];
    if(!task)throw new ServiceError('not_found',404);
    if(task.content_deleted)unavailable();
    if((await db.query("SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased') LIMIT 1",[actor.subjectId])).rows.length)unavailable();
    if(task.case_id){
      const source=(await db.query('SELECT state FROM cases WHERE id=$1 AND subject_id=$2 FOR SHARE',[task.case_id,actor.subjectId])).rows[0];
      if(!source||source.state==='withdrawn')unavailable();
    }
    const ids=[...new Set([task.root_event_id,...eventIds])];
    // The owning Task lock serializes API writes and lifecycle erasure. Event
    // bytes are immutable to galaxy_api (SELECT/INSERT, no UPDATE privilege),
    // so event row locks would wrongly require UPDATE. Preview loads metadata.
    const events=(await db.query(`SELECT id,version,kind,payload_hash,created_at,consent_id,
      (length(payload_text)>0) AS content_retained FROM task_events
      WHERE task_id=$1 AND subject_id=$2 AND id=ANY($3::uuid[]) ORDER BY version`,[taskId,actor.subjectId,ids])).rows;
    if(events.length!==ids.length)throw new ServiceError('not_found',404);
    for(const event of events){
      if(!event.content_retained)unavailable();
      const original=(await db.query(`SELECT c.intent,c.expires_at,c.revoked_at,c.subject_id,c.binding_id,
        b.device_id,b.control_epoch,b.expires_at AS binding_expires_at,b.revoked_at AS binding_revoked_at
        FROM consents c JOIN bindings b ON b.id=c.binding_id
        WHERE c.id=$1 AND c.subject_id=$2 AND b.subject_id=$2 AND b.audience=$3 FOR SHARE OF c`,
      [event.consent_id,actor.subjectId,this.access.endpoint])).rows[0];
      if(!original||original.revoked_at||original.intent.action!=='assistance.publish'
        ||original.intent.objectId!==event.id||original.intent.recipient!==this.access.endpoint
        ||original.intent.payloadHash!==event.payload_hash||!original.binding_revoked_at
        ||!original.device_id||!original.control_epoch||original.control_epoch>=control.controlEpoch)unavailable();
      // The recovered binding is already revoked and immutable through the
      // Binding API. Lock its Consent, not this old binding: cross-binding
      // revocation locks bindings in UUID order, while Access owns the current
      // binding first. Identity recovery is serialized by the subject lock.
      // Recovery is the only allowed reason for invalidating the old binding.
      // The explicit audit exclusion also disambiguates equal clock timestamps.
      const recovery=(await db.query(`SELECT r.accepted_at,r.sequence FROM subject_control_events r
        JOIN device_authorizations d ON d.subject_id=r.subject_id AND d.device_id=$2 AND d.epoch=$3
        WHERE r.subject_id=$1 AND r.kind='recover' AND r.epoch=$3+1
        AND r.accepted_at=$4::timestamptz AND d.status='revoked' AND d.revoked_at=r.accepted_at
        AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.actor=$1 AND a.action='binding.revoke'
          AND a.object_id=$5 AND a.outcome='accepted')`,
      [actor.subjectId,original.device_id,original.control_epoch,original.binding_revoked_at,original.binding_id])).rows[0];
      if(!recovery||seconds(original.binding_expires_at)<=seconds(recovery.accepted_at))unavailable();
      // revoke-device has no binding.revoke audit. Its exact accepted control
      // event must also be excluded, even when two commits share a timestamp.
      const revocations=(await db.query(`SELECT payload_text FROM subject_control_events
        WHERE subject_id=$1 AND epoch=$2 AND kind='revoke-device' AND sequence<$3`,
      [actor.subjectId,original.control_epoch,recovery.sequence])).rows;
      for(const revocation of revocations){
        let request;
        try{request=JSON.parse(revocation.payload_text).request;if(request?.kind!=='revoke-device'||typeof request.deviceId!=='string')throw new Error();}
        catch{throw new ServiceError('task_owner_read_integrity_error',500);}
        if(request.deviceId===original.device_id)unavailable();
      }
      let expires=Math.min(seconds(original.expires_at),original.intent.expiresAt);
      if(productV2Retention.taskEvents.temporaryKinds.includes(event.kind))
        expires=Math.min(expires,seconds(event.created_at)+productV2Retention.taskEvents.temporaryContentDays*86400);
      if(!Number.isFinite(expires)||expires<=now)unavailable();
      event.readExpiresAt=Math.floor(expires);
    }
    return {task,events};
  }
  prepare(actor,input) {
    const request=parse(taskOwnerReadPrepareV2Schema,input);
    return this.access.runAuthorized(actor,'assistance',async(db,authorization)=>{
      const control=this.current(authorization);
      const {task,events}=await this.sourceWithin(db,actor,request.taskId,request.eventIds??[],control);
      const expiresAt=Math.min(Math.floor(this.access.now())+this.maxReadSeconds,...events.map(e=>e.readExpiresAt));
      const descriptor={version:1,operationId:request.operationId,taskId:task.id,taskVersion:task.version,...control,
        eventRefs:events.map(e=>({eventId:e.id,version:e.version,payloadHash:e.payload_hash})),expiresAt};
      const payloadJson=JSON.stringify(parse(taskOwnerReadDescriptorV2Schema,descriptor));
      return taskOwnerReadPreviewV2Schema.parse({taskId:task.id,latestTaskVersion:task.version,...guarantees,
        payloadJson,payloadHash:digest(payloadJson),expiresAt,events:events.map(e=>({eventId:e.id,version:e.version,
          kind:e.kind,payloadHash:e.payload_hash,createdAt:new Date(e.created_at).toISOString(),readExpiresAt:e.readExpiresAt}))});
    });
  }
  read(actor,taskId,input) {
    const request=parse(taskOwnerReadRequestV2Schema,input);let descriptor;
    try{descriptor=parse(taskOwnerReadDescriptorV2Schema,JSON.parse(request.payloadJson));}
    catch{throw new ServiceError('invalid_task_owner_read');}
    if(taskId!==descriptor.taskId)throw new ServiceError('task_owner_read_scope_mismatch',403);
    return this.access.runAuthorized(actor,'assistance',async(db,authorization)=>{
      const control=this.current(authorization);
      if(Object.keys(control).some(k=>control[k]!==descriptor[k])||descriptor.expiresAt<=this.access.now()
        ||descriptor.expiresAt>Math.floor(this.access.now())+this.maxReadSeconds)
        throw new ServiceError('task_owner_read_scope_mismatch',403);
      const grant=await this.consents.require(db,{id:request.consentId,subjectId:actor.subjectId,action:'task.owner-read',
        objectId:descriptor.operationId,recipient:this.access.endpoint,payloadJson:request.payloadJson});
      if(grant.currentVisibility?.deletionPending)unavailable();
      const consent=(await db.query('SELECT binding_id FROM consents WHERE id=$1',[request.consentId])).rows[0];
      if(consent?.binding_id!==control.bindingId||grant.bindingId!==control.bindingId||grant.visibility!=='Private'
        ||grant.viewers.length!==0||grant.purpose!=='operational'||grant.expiresAt!==descriptor.expiresAt
        ||grant.fields.length!==Object.keys(descriptor).length
        ||Object.keys(descriptor).some(k=>!grant.fields.includes(k)))throw new ServiceError('task_owner_read_scope_mismatch',403);
      const {task,events}=await this.sourceWithin(db,actor,taskId,descriptor.eventRefs.map(e=>e.eventId),control);
      if(task.version!==descriptor.taskVersion||JSON.stringify(events.map(e=>({eventId:e.id,version:e.version,payloadHash:e.payload_hash})))!==JSON.stringify(descriptor.eventRefs)
        ||events.some(e=>descriptor.expiresAt>e.readExpiresAt))throw new ServiceError('task_owner_read_preview_changed',409);
      const body=(await db.query('SELECT id,payload_text FROM task_events WHERE task_id=$1 AND subject_id=$2 AND id=ANY($3::uuid[])',
        [taskId,actor.subjectId,events.map(e=>e.id)])).rows;
      const contents=new Map(body.map(e=>[e.id,e.payload_text]));
      return taskOwnerReadResultV2Schema.parse({taskId,latestTaskVersion:task.version,...guarantees,events:events.map(e=>{
        const payloadJson=contents.get(e.id);
        if(typeof payloadJson!=='string'||digest(payloadJson)!==e.payload_hash)throw new ServiceError('task_owner_read_integrity_error',500);
        // Accepted original bytes are disclosed as original facts, not a new
        // schema-normalised snapshot. Invalid retained bytes remain an error.
        try{const value=JSON.parse(payloadJson);if(!value||Array.isArray(value)||typeof value!=='object')throw new Error();}
        catch{throw new ServiceError('task_owner_read_integrity_error',500);}
        return {eventId:e.id,version:e.version,kind:e.kind,payloadHash:e.payload_hash,payloadJson};
      })});
    });
  }
}
