import {randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import {z} from 'zod';
import {digest} from '../../shared/digest.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {feedbackSubmitSchema,feedbackEventSchema,parseFeedback} from '../../shared/operations-feedback-schema.mjs';
import {operationsStamp,operationsIso} from "../public-content/content-visibility.mjs";
import {OperationsFeedbackReadModel} from './read-model.mjs';

// Product feedback intake and operator commands preserve the original SQL, IDs and authorization chain.
export class OperationsFeedbackService extends OperationsFeedbackReadModel {
 async submit(actor,input){
  const x=parseFeedback(feedbackSubmitSchema,input);
  if(actor?.kind!=='official-account'||actor.endpoint!==this.endpoint||!z.uuid().safeParse(actor.accountId).success)
   throw new ServiceError('official_account_login_required',401);
  if(!this.accounts)throw new ServiceError('official_account_unavailable',503);
  const {attachments,...submission}=x,references=attachments??[];
  // Empty references preserve pre-attachment acknowledgement recovery.
  const fingerprint=digest(canonicalize(references.length?{...submission,attachments:references}:submission));
  // A participation restriction does not prevent asking the site for help.
  // The current real account and the per-account lock still protect intake.
  return this.accounts.runAuthorized(actor,'binding',async(db,_authorization,current)=>{
   const account=await this.accounts.resolveWithin(db,current,{accountId:actor.accountId,requireExplicit:true});
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912395))',[this.endpoint+':feedback-intake:'+account.id]);
   const prior=(await db.query(`SELECT id,request_hash,created_at,owner_deleted_at FROM operations_feedback_v1
    WHERE endpoint=$1 AND account_id=$2 AND submission_operation_id=$3`,[this.endpoint,account.id,x.operationId])).rows[0];
   if(prior){
    if(prior.request_hash!==fingerprint)throw new ServiceError('feedback_operation_conflict',409);
    return {feedbackId:prior.id,operationId:x.operationId,submittedAt:operationsIso(prior.created_at),replayed:true,...(prior.owner_deleted_at?{deleted:true}:{})};
   }
   const now=this.now(),at=operationsStamp(now),usage=(await db.query(`SELECT count(*)::integer AS day,
    count(*) FILTER(WHERE created_at>$4::timestamptz)::integer AS minute FROM operations_feedback_v1
    WHERE endpoint=$1 AND account_id=$2 AND created_at>$3::timestamptz`,
   [this.endpoint,account.id,operationsStamp(now-86400),operationsStamp(now-60)])).rows[0];
   if(usage.minute>0)throw new ServiceError('feedback_rate_limited',429);
   if(usage.day>=5)throw new ServiceError('feedback_daily_limit',429);
   const id=randomUUID(),title=x.title??x.body.split(/\r?\n/).find(line=>line.trim())?.trim().slice(0,120)??'使用反馈';
   await db.query(`INSERT INTO operations_feedback_v1(id,endpoint,account_id,submission_operation_id,request_hash,title,body,
    submitted_category,submitted_module,category,module,state,revision,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$9,'pending',1,$10,$10)`,
   [id,this.endpoint,account.id,x.operationId,fingerprint,title,x.body,x.category,x.module,at]);
   await this.feedbackAttachments.bindWithin(db,{accountId:account.id,operationId:x.operationId,feedbackId:id,references});
   await db.query(`INSERT INTO operations_feedback_events_v1(id,feedback_id,endpoint,kind,operator_id,operation_id,revision,category,module,state,note,http_request_id,created_at)
    VALUES($1,$2,$3,'submitted',NULL,$4,1,$5,$6,'pending',NULL,$7,$8)`,
   [randomUUID(),id,this.endpoint,x.operationId,x.category,x.module,actor.httpRequestId??null,at]);
   return {feedbackId:id,operationId:x.operationId,submittedAt:at,replayed:false};
  },{control:true});
 }
 async submissionOperation(actor,operationId){
  parseFeedback(z.uuid(),operationId);
  if(actor?.kind!=='official-account'||actor.endpoint!==this.endpoint||!z.uuid().safeParse(actor.accountId).success)
   throw new ServiceError('official_account_login_required',401);
  if(!this.accounts)throw new ServiceError('official_account_unavailable',503);
  // Recover only this currently authenticated owner's original submission.
  // A missing row is not permission to resend a possibly in-flight POST.
  return this.accounts.runAuthorized(actor,'binding',async(db,_authorization,current)=>{
   const account=await this.accounts.resolveWithin(db,current,{accountId:actor.accountId,requireExplicit:true});
   const row=(await db.query(`SELECT id,created_at,owner_deleted_at FROM operations_feedback_v1
    WHERE endpoint=$1 AND account_id=$2 AND submission_operation_id=$3`,[this.endpoint,account.id,operationId])).rows[0];
   return row?{state:'recorded',operationId,feedbackId:row.id,submittedAt:operationsIso(row.created_at),deleted:!!row.owner_deleted_at}
    :{state:'not-recorded',operationId};
  },{control:true});
 }
 async event(operator,id,input){
  const x=parseFeedback(feedbackEventSchema,input);parseFeedback(z.uuid(),id);
  const {note,...metadata}=x,selection={id,...metadata,noteHash:note?digest(note):null};
  const result=await this.command(operator,'feedback-update',selection,async(db,actor)=>{
   const row=await this.headWithin(db,id,{lock:true});
   if(row.revision!==x.expectedRevision)throw new ServiceError('feedback_revision_conflict',409);
   const category=Object.hasOwn(x,'category')?x.category:row.category,module=x.module??row.module,state=x.state??row.state;
   if(!note&&category===row.category&&module===row.module&&state===row.state)throw new ServiceError('feedback_no_change',409);
   const revision=row.revision+1,at=operationsStamp(this.now());
   await db.query(`UPDATE operations_feedback_v1 SET category=$3,module=$4,state=$5,revision=$6,updated_at=$7 WHERE id=$1 AND endpoint=$2`,
   [id,this.endpoint,category,module,state,revision,at]);
   await db.query(`INSERT INTO operations_feedback_events_v1(id,feedback_id,endpoint,kind,operator_id,operation_id,revision,category,module,state,note,http_request_id,created_at)
    VALUES($1,$2,$3,'updated',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
   [randomUUID(),id,this.endpoint,actor.operatorId,x.operationId,revision,category,module,state,note??null,actor.httpRequestId??null,at]);
   // Only immutable receipt metadata enters general audit/idempotency data.
   return {feedbackId:id,revision};
  });
  return {...await this.get(operator,id),operationId:x.operationId,replayed:result.replayed??false};
 }
}
