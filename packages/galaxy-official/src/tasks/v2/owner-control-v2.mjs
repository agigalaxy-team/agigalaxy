import {ServiceError} from "../../shared/service-error.mjs";
import {digest} from "../../shared/digest.mjs";
import {applyTaskV2} from "../../domain/task-v2.mjs";
import {taskOwnerControlPrepareV2Schema,taskOwnerControlRequestV2Schema,taskOwnerControlEnvelopeV2Schema,
  taskOwnerControlPreviewV2Schema,taskOwnerControlResultV2Schema} from "../../shared/task-owner-control-v2-schema.mjs";

const effects=Object.freeze({historyRetained:true,materialAccessChanged:false,completeTaskAccessGranted:false,settlementExecuted:false});
function parse(schema,input){const parsed=schema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_task_owner_control');return parsed.data;}

// A narrow fresh owner control intent after same-ID device recovery. The source
// checker proves retention and recovery; no task.owner-read permit is consumed.
export class TaskOwnerControlServiceV2 {
  constructor(access,consents,{tasks,ownerRead,maxControlSeconds=3600}={}){
    if(!tasks?.taskRepository||!ownerRead?.sourceWithin||!Number.isInteger(maxControlSeconds)||maxControlSeconds<1||maxControlSeconds>3600)
      throw new Error('invalid_owner_control_configuration');
    this.access=access;this.consents=consents;this.tasks=tasks;this.ownerRead=ownerRead;this.maxControlSeconds=maxControlSeconds;
  }
  async sourceWithin(db,actor,taskId,authorization){
    try{return await this.ownerRead.sourceWithin(db,actor,taskId,[],this.ownerRead.current(authorization));}
    catch(error){if(error.code==='task_owner_read_source_unavailable')throw new ServiceError('task_owner_control_source_unavailable',403);throw error;}
  }
  async pausedWithin(db,task,kind){
    if(task.case_id&&kind==='close'&&(await db.query('SELECT 1 FROM moderation_reports WHERE case_id=$1 AND paused=true LIMIT 1',[task.case_id])).rows.length)
      throw new ServiceError('task_paused',403);
  }
  prepare(actor,input){
    const request=parse(taskOwnerControlPrepareV2Schema,input);
    if(request.kind==='close'&&request.terminationIntent!=='terminate-task')
      throw new ServiceError('task_termination_intent_required',409);
    return this.access.runAuthorized(actor,'assistance',async(db,authorization)=>{
      const {task,events}=await this.sourceWithin(db,actor,request.taskId,authorization),root=events[0];
      const existing=(await db.query('SELECT task_id,subject_id FROM task_events WHERE id=$1',[request.operationId])).rows[0];
      if(existing)throw new ServiceError(existing.task_id===task.id&&existing.subject_id===actor.subjectId
        ?'task_owner_control_receipt_required':'task_event_conflict',409);
      const row=(await db.query("SELECT snapshot->>'state' AS state FROM task_requests WHERE id=$1",[task.id])).rows[0];
      if(['canceled','closed'].includes(row?.state))throw new ServiceError('task_transition_denied',409);
      await this.pausedWithin(db,task,request.kind);
      const envelope={taskId:task.id,event:{kind:request.kind,eventId:request.operationId,expectedTaskVersion:task.version,reason:request.reason,
        ...(request.kind==='close'?{terminationIntent:request.terminationIntent}:{})}};
      const payloadJson=JSON.stringify(parse(taskOwnerControlEnvelopeV2Schema,envelope));
      return taskOwnerControlPreviewV2Schema.parse({taskId:task.id,operationId:request.operationId,kind:request.kind,expectedTaskVersion:task.version,
        payloadJson,payloadHash:digest(payloadJson),expiresAt:Math.min(Math.floor(this.access.now())+this.maxControlSeconds,root.readExpiresAt),
        authorization:{action:'assistance.publish',objectId:request.operationId,visibility:'Private',viewers:[],purpose:'operational',
          recipient:this.access.endpoint,fields:['taskId','event'],...this.ownerRead.current(authorization)},
        source:{eventId:root.id,version:root.version,payloadHash:root.payload_hash,expiresAt:root.readExpiresAt},...effects});
    });
  }
  async execute(actor,taskId,input){
    const request=parse(taskOwnerControlRequestV2Schema,input);let envelope;
    try{envelope=parse(taskOwnerControlEnvelopeV2Schema,JSON.parse(request.payloadJson));}catch{throw new ServiceError('invalid_task_owner_control');}
    if(envelope.taskId!==taskId)throw new ServiceError('task_owner_control_scope_mismatch',403);
    const event=envelope.event;
    try{return await this.access.runResourceWrite(actor,'assistance',{control:true},async(db,authorization)=>{
      // Serialize the event identity before the Task. The ordinary event path
      // may still race this new path; its PK conflict is translated below.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['task-owner-control-event:'+event.eventId]);
      const row=await this.tasks.taskRepository.get(db,taskId,{lock:true});
      if(!row||row.requester_id!==actor.subjectId)throw new ServiceError('not_found',404);
      const {events}=await this.sourceWithin(db,actor,taskId,authorization),root=events[0];
      const grant=await this.consents.require(db,{id:request.consentId,subjectId:actor.subjectId,action:'assistance.publish',
        objectId:event.eventId,recipient:this.access.endpoint,payloadJson:request.payloadJson});
      if(grant.currentVisibility?.deletionPending)throw new ServiceError('task_owner_control_source_unavailable',403);
      if(grant.bindingId!==authorization.callerBindingId||grant.visibility!=='Private'||grant.viewers.length!==0||grant.purpose!=='operational'
        ||grant.fields.length!==2||!['taskId','event'].every(key=>grant.fields.includes(key))
        ||grant.expiresAt>Math.min(Math.floor(this.access.now())+this.maxControlSeconds,root.readExpiresAt))
        throw new ServiceError('task_owner_control_scope_mismatch',403);
      const original=await this.tasks.taskRepository.event(db,root.id);
      if(!original?.payload_text||digest(original.payload_text)!==root.payload_hash)
        throw new ServiceError('task_owner_control_integrity_error',500);
      // Replay retains the original Consent ID and literal payload hash. A new
      // Consent after a lost ACK cannot disguise the already accepted intent.
      const replay=await this.tasks.taskReplay(db,actor,taskId,event.eventId,request.consentId,request.payloadJson);
      if(replay)return taskOwnerControlResultV2Schema.parse({...replay,state:event.kind==='stop-enrollment'?'enrollment-stopped':event.kind==='cancel'?'canceled':'closed',
        payloadHash:digest(request.payloadJson),authority:'accepted-operation-only',currentAccessGranted:false,...effects});
      await this.pausedWithin(db,row,event.kind);
      const next=applyTaskV2(row.snapshot,actor.subjectId,event,this.access.now());
      await this.tasks.taskRepository.save(db,next);
      const receipt=await this.tasks.recordTaskEvent(db,actor,authorization,next,{eventId:event.eventId,kind:event.kind,
        consentId:request.consentId,payloadJson:request.payloadJson});
      return taskOwnerControlResultV2Schema.parse({...receipt,...(event.kind==='stop-enrollment'?{state:'enrollment-stopped'}:{}),payloadHash:digest(request.payloadJson),authority:'accepted-operation-only',
        currentAccessGranted:false,...effects});
    });}catch(error){if(error.code==='23505')throw new ServiceError('task_event_conflict',409);throw error;}
  }
}
