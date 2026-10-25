import {z} from 'zod';
import {ServiceError} from '../../shared/service-error.mjs';
import {feedbackQuerySchema,feedbackHistorySchema,feedbackEventAuditSelectionSchema,feedbackEventAuditResultSchema,parseFeedback} from '../../shared/operations-feedback-schema.mjs';
import {transaction} from '../../database.mjs';
import {OperationsBusinessDomain,operationsStamp,operationsIso} from '../../operations-content-visibility.mjs';
import {operationsAnalyticsPeriod} from '../../operations-analytics.mjs';
import {FeedbackAttachmentsV1Service} from '../../feedback-attachments-v1.mjs';
import {hasOperationsPermission as permitted} from '../../operations-permission-catalog.mjs';
import {operationsOperatorNamesWithin} from '../../operations-history-identities.mjs';

const columns=`f.*,a.uid,p.display_name,(SELECT count(*)::int FROM feedback_attachments_v1 files WHERE files.endpoint=f.endpoint AND files.feedback_id=f.id) AS attachment_count`;
const source=`operations_feedback_v1 f JOIN community_accounts a ON a.id=f.account_id AND a.endpoint=f.endpoint
 LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id`;
const matching=`f.endpoint=$1 AND f.owner_deleted_at IS NULL AND ($2::text='' OR position(lower($2::text) in lower(f.title))>0
 OR position(lower($2::text) in lower(f.body))>0 OR position(upper($2::text) in a.uid)>0
 OR position(lower($2::text) in lower(coalesce(p.display_name,'')))>0)
 AND ($3::text IS NULL OR f.module=$3) AND ($4::timestamptz IS NULL OR f.created_at>=$4::timestamptz)
 AND f.created_at<=$5::timestamptz`;

// Current authorized projections; no private feedback enters a general profile or search source.
export class OperationsFeedbackReadModel extends OperationsBusinessDomain {
 constructor({businessAdmin,accounts,feedbackAttachments=null,now}){super({businessAdmin,now});this.accounts=accounts;
  this.feedbackAttachments=feedbackAttachments??new FeedbackAttachmentsV1Service({db:this.db,endpoint:this.endpoint,accounts,now:this.now});}
 item(row){return {id:row.id,account:{accountId:row.account_id,uid:row.uid,displayName:row.display_name??null},title:row.title,
  excerpt:row.body.slice(0,160),category:row.category,module:row.module,state:row.state,revision:row.revision,
  createdAt:operationsIso(row.created_at),updatedAt:operationsIso(row.updated_at),attachmentCount:Number(row.attachment_count??0)};}
 async headWithin(db,id,{lock=false}={}){
  parseFeedback(z.uuid(),id);
   const row=(await db.query(`SELECT ${columns} FROM ${source} WHERE f.id=$1 AND f.endpoint=$2 AND f.owner_deleted_at IS NULL${lock?' FOR UPDATE OF f':''}`,[id,this.endpoint])).rows[0];
  if(!row)throw new ServiceError('not_found',404);return row;
 }
 async detailWithin(db,actor,id,input={}){
  const q=parseFeedback(feedbackHistorySchema,input),row=await this.headWithin(db,id);
  const events=(await db.query(`SELECT * FROM operations_feedback_events_v1 WHERE endpoint=$1 AND feedback_id=$2
   AND ($3::bigint IS NULL OR sequence<$3::bigint) ORDER BY sequence DESC LIMIT 51`,[this.endpoint,id,q.historyAfter??null])).rows;
  const history=events.slice(0,50),names=await operationsOperatorNamesWithin(db,{endpoint:this.endpoint,operatorIds:history.map(event=>event.operator_id)});
  return {feedback:{...this.item(row),body:row.body,submittedCategory:row.submitted_category,submittedModule:row.submitted_module,attachments:await this.feedbackAttachments.forFeedbackWithin(db,id)},
   history:{items:history.map(event=>({id:event.id,sequence:String(event.sequence),kind:event.kind,operatorId:event.operator_id,operatorDisplayName:names.get(event.operator_id)??null,
    category:event.category,module:event.module,state:event.state,note:event.note,createdAt:operationsIso(event.created_at)})),
    nextAfter:events.length>50?String(events[49].sequence):null},permissions:{canManage:permitted(actor,'feedback.update')},checkedAt:this.now()};
 }
 list(operator,input={}){
  const q=parseFeedback(feedbackQuerySchema,input),now=this.now(),from=q.days==='all'?null:operationsAnalyticsPeriod(now,q.days).period.from,
   args=[this.endpoint,q.query,q.module??null,from,operationsStamp(now)];
  // The search text is private input too: the cross-module audit stores only
  // the filter kind, never the words or feedback prose being looked up.
  const selection={hasQuery:!!q.query,module:q.module??null,days:q.days,category:q.category??null,state:q.state??null,after:q.after??null,limit:q.limit};
  return this.run(operator,false,'feedback-query',selection,async(db,actor)=>{
   const summary=(await db.query(`SELECT count(*)::integer AS total,count(*) FILTER(WHERE f.category IS NULL)::integer AS unclassified,
    count(*) FILTER(WHERE f.state='pending')::integer AS pending,count(*) FILTER(WHERE f.state='closed')::integer AS closed,
    count(*) FILTER(WHERE f.category='problem')::integer AS problem,count(*) FILTER(WHERE f.category='suggestion')::integer AS suggestion
    FROM ${source} WHERE ${matching}`,args)).rows[0];
   const rows=(await db.query(`SELECT ${columns} FROM ${source} WHERE ${matching}
    AND ($6::text IS NULL OR CASE WHEN $6='unclassified' THEN f.category IS NULL ELSE f.category=$6 END)
    AND ($7::text IS NULL OR f.state=$7) AND ($8::bigint IS NULL OR f.sequence<$8::bigint)
    ORDER BY f.sequence DESC LIMIT $9`,[...args,q.category??null,q.state??null,q.after??null,q.limit+1])).rows;
   return {items:rows.slice(0,q.limit).map(row=>this.item(row)),nextAfter:rows.length>q.limit?String(rows[q.limit-1].sequence):null,
    summary:{total:summary.total,unclassified:summary.unclassified,pending:summary.pending,closed:summary.closed,
     byCategory:[{category:null,count:summary.unclassified},{category:'problem',count:summary.problem},{category:'suggestion',count:summary.suggestion}]},
    permissions:{canManage:permitted(actor,'feedback.update')},checkedAt:now};
  });
 }
 get(operator,id,input={}){
  const q=parseFeedback(feedbackHistorySchema,input);parseFeedback(z.uuid(),id);
  return this.run(operator,false,'feedback-read',{id,historyAfter:q.historyAfter??null},(db,actor)=>this.detailWithin(db,actor,id,q));
 }
 async operation(operator,id,operationId){
  parseFeedback(z.uuid(),id);parseFeedback(z.uuid(),operationId);
  const actor=await this.businessAdmin.authorizeAction(operator,'feedback.read');
  if(actor.kind!=='business-operator'&&!this.businessAdmin.executorAuthority?.acceptsDuty(actor))throw new ServiceError('business_admin_denied',403);
  return transaction(this.db,async db=>{
   await this.businessAdmin.authorizeAction(actor,'feedback.read',{db});await this.principalWithin(db,actor);
   const row=(await db.query('SELECT operator_id,action,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];
   const checkedAt=this.now(),metadata={operationId,feedbackId:id,checkedAt,readExpiresAt:checkedAt+30,metadataOnly:true};
   if(!row){await this.businessAdmin.authorizeAction(actor,'feedback.read',{db});return{state:'not-recorded',...metadata,action:null,selection:null,result:null,recordedAt:null};}
   if(row.operator_id!==actor.operatorId||row.action!=='feedback-update'||row.selection?.id!==id||row.selection?.resourceId!==id)throw new ServiceError('not_found',404);
   const input=feedbackEventAuditSelectionSchema.safeParse(row.selection),output=feedbackEventAuditResultSchema.safeParse(row.result);
   if(!input.success||!output.success||input.data.operationId!==operationId||output.data.operationId!==operationId||output.data.feedbackId!==id||output.data.revision!==input.data.expectedRevision+1)throw new ServiceError('feedback_operation_unavailable',503);
   const {id:_id,resourceId:_resourceId,operationId:_operationId,...selection}=input.data;
   await this.businessAdmin.authorizeAction(actor,'feedback.read',{db});
   return{state:'recorded',...metadata,action:'feedback-update',selection,result:output.data,recordedAt:output.data.recordedAt};
  });
 }
 attachmentContent(operator,id,attachmentId,{authorize=null}={}){parseFeedback(z.uuid(),id);parseFeedback(z.uuid(),attachmentId);
  return this.run(operator,false,'feedback-read',{id,attachmentId},(db,actor)=>this.feedbackAttachments.contentWithin(db,{feedbackId:id,attachmentId,
   assertReadable:async()=>{const fresh=await this.businessAdmin.authorizeAction(authorize?await authorize():operator,'feedback.attachments.read',{db});
    if(fresh.operatorId!==actor.operatorId)throw new ServiceError('business_admin_denied',403);
    await this.principalWithin(db,fresh);return this.headWithin(db,id);}}));
 }
}
