import {z} from 'zod';
import {digest} from '../shared/digest.mjs';
import {ServiceError} from '../shared/service-error.mjs';
import {governanceReceiptHash} from '../shared/operations-governance-receipt-intent.mjs';
import {readReceipt} from './command-receipts.mjs';

const id=z.uuid(),revision=z.number().int().nonnegative(),positive=revision.min(1),iso=z.iso.datetime();
const visibility=z.object({version:positive,hidden:z.boolean(),until:iso.nullable(),operationId:id});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const topic=z.enum(['technology','arts','learning','life','galaxy','unclassified']);
const batchCodes=new Set(['operations_source_changed','operations_visibility_changed','operations_source_unavailable','operations_hide_expiry','operations_permission_denied','business_admin_denied','not_found']);
const scopeSchema=z.discriminatedUnion('family',[
 z.strictObject({family:z.literal('case'),id}),
 z.strictObject({family:z.literal('section'),id}),
 z.strictObject({family:z.literal('content'),kind:z.enum(['post','reply']),id}),
 z.strictObject({family:z.literal('batch')}),
 z.strictObject({family:z.literal('tag')}),
 z.strictObject({family:z.literal('resource'),kind:z.enum(['projects','methods']),id}),
]);
const resultSchemas={
 'community-report-resolve':z.object({reportId:id,version:positive,state:z.literal('resolved'),resolution:z.enum(['accepted','dismissed','needs-review']),restrictionAction:z.enum(['keep','release','hide']),restrictionEventId:id.nullable(),effectUntil:iso.nullable()}),
 'community-section-classify':z.object({sectionId:id,version:positive,category:topic}),
 'community-section-visibility':z.object({target:z.object({kind:z.literal('forum-section'),id}),sourceVersion:revision,visibility,sourcePermissionChanged:z.literal(false)}),
 'community-content-curation':z.object({kind:z.enum(['post','reply']),id,revision:positive,sourceVersion:revision}),
 'community-content-visibility':z.object({kind:z.enum(['post','reply']),id,visibility}),
 'community-tag-create':z.object({tag:z.object({id,version:positive,enabled:z.boolean()})}),
 'community-tag-update':z.object({tag:z.object({id,version:positive,enabled:z.boolean()})}),
 'resource-visibility':z.object({target:z.object({kind:z.enum(['project','method']),id}),sourceVersion:revision,visibility,sourcePermissionChanged:z.literal(false)}),
 'community-content-batch-visibility':z.object({items:z.array(z.object({kind:z.enum(['post','reply']),id,status:z.enum(['applied','rejected']),code:z.string().nullable(),visibility:visibility.optional()})).min(1).max(25),counts:z.object({applied:revision,rejected:revision})}),
};
function targetMatches(scope,action,s,result){
 if(scope.family==='case')return action==='community-report-resolve'&&s.id===scope.id&&result.reportId===scope.id;
 if(scope.family==='section')return ['community-section-classify','community-section-visibility'].includes(action)&&s.id===scope.id&&(result.sectionId??result.target?.id)===scope.id;
 if(scope.family==='content')return ['community-content-curation','community-content-visibility'].includes(action)&&s.id===scope.id&&(s.targetKind??s.kind)===scope.kind&&result.id===scope.id&&result.kind===scope.kind;
 if(scope.family==='tag')return ['community-tag-create','community-tag-update'].includes(action)&&(!s.id||s.id===result.tag.id);
 if(scope.family==='resource')return action==='resource-visibility'&&s.kind===scope.kind&&s.id===scope.id&&result.target.id===scope.id&&result.target.kind===(scope.kind==='projects'?'project':'method');
 if(scope.family==='batch')return action==='community-content-batch-visibility';
 return false;
}
function compatibleResult(action,s,r,operationId){
 if(action==='community-report-resolve')return r.version===s.expectedVersion+1&&r.resolution===s.resolution&&r.restrictionAction===(s.restrictionAction??(s.hideUntil!==undefined?'hide':'keep'))&&(r.restrictionAction==='keep'||r.restrictionAction==='release'&&r.effectUntil===null&&r.restrictionEventId===null||r.restrictionAction==='hide'&&r.effectUntil===new Date(s.hideUntil*1000).toISOString()&&r.restrictionEventId===operationId);
 if(action==='community-section-classify')return r.version===s.expectedVersion+1&&r.category===s.category;
 if(action==='community-section-visibility'||action==='resource-visibility'){
  const x=action==='resource-visibility'?s.command:s;
  return r.sourceVersion===x.expectedVersion&&r.visibility.version===x.expectedVisibilityVersion+1&&r.visibility.operationId===operationId&&r.visibility.hidden===(x.kind==='hide')&&r.visibility.until===(x.kind==='hide'?new Date(x.until*1000).toISOString():null);
 }
 if(action==='community-content-curation')return r.sourceVersion===s.expectedVersion&&r.revision===s.expectedRevision+1;
 if(action==='community-content-visibility')return r.visibility.version===s.expectedRevision+1&&r.visibility.operationId===operationId&&r.visibility.hidden===(s.kind==='hide')&&r.visibility.until===(s.kind==='hide'?new Date(s.until*1000).toISOString():null);
 if(action==='community-tag-create'||action==='community-tag-update')return r.tag.version===(s.expectedVersion??0)+1&&(s.enabled===null||s.enabled===r.tag.enabled);
 if(action==='community-content-batch-visibility'){
  if(!Array.isArray(s.items)||r.items.length!==s.items.length||r.counts.applied+r.counts.rejected!==r.items.length)return false;
  if(r.counts.applied!==r.items.filter(x=>x.status==='applied').length)return false;
  return r.items.every((x,index)=>{const input=s.items[index];return input.kind===x.kind&&input.id===x.id&&(x.status==='rejected'||x.visibility?.version===input.expectedRevision+1&&x.visibility.operationId===operationId&&x.visibility.hidden===(s.kind==='hide')&&x.visibility.until===(s.kind==='hide'?new Date(s.until*1000).toISOString():null));});
 }
 return false;
}

/** Original safe ledger metadata only. This never calls get/viewWithin or
 * treats a current mutable content body as the original HTTP save ACK. */
export function governanceCommandResult({db,endpoint,operator,authorize,now},operationId,input){
 const parsedScope=scopeSchema.safeParse(input);if(!parsedScope.success)throw new ServiceError('invalid_operations_command_receipt',400);const scope=parsedScope.data;
 return readReceipt({endpoint,operator,operationId,authorize,now,
  load:async op=>(await db.query('SELECT operator_id,actor_kind,action,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[endpoint,op])).rows,
  project:row=>{
   const s=row.selection,original=row.result,schema=Object.hasOwn(resultSchemas,row.action)?resultSchemas[row.action]:null;
   if(row.actor_kind!=='business-operator'||!schema||!object(s)||s.operationId!==operationId||!object(original)||original.operationId!==operationId||!iso.safeParse(original.recordedAt).success)return null;
   const parsed=schema.safeParse(original);if(!parsed.success)return null;
   const r=parsed.data;
   try{if(!targetMatches(scope,row.action,s,r)||!compatibleResult(row.action,s,r,operationId))return null;}catch{return null;}
   if(r.items)r.items=r.items.map(item=>({...item,code:item.code===null||batchCodes.has(item.code)?item.code:null}));
   return {kind:row.action,result:{...r,recordedAt:original.recordedAt,intentHash:governanceReceiptHash(row.action,s,digest)}};
  }});
}

