import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {agentOsQueryArgumentsSchema,agentOsReadArgumentsSchema,agentOsQueryViews} from "../../shared/operations-agentos-query-schema.mjs";

const readModules={account:'accounts','account-summary':'accounts','registered-user':'registered-users',post:'content',reply:'content',section:'content',case:'cases','chat-report':'chat-reports',feedback:'feedback','chat-file':'files','forum-file':'files','file-cleanup-plan':'files','file-cleanup-operation':'files',project:'resources',method:'resources','message-plan':'messaging','message-run':'messaging',rule:'rules','strategy-run':'strategies','ai-run':'runs','backup-point':'maintenance','restore-plan':'maintenance',role:'permissions'};
const reads=new Set(['workbench-summary','query-operations','read-operation-object','read-ai-delegation']);
const aiManagementReadSchema=z.strictObject({aiAccountId:z.uuid().optional()});
const states=new Set(['started','completed','unavailable']);
const resultStates=new Set(['available','unavailable','not-configured','not-connected','read','invalid-request','unknown']);
const errorCode=value=>typeof value==='string'&&/^(?:operations|business_admin|invalid_operations|p13|search_quality|feedback|messaging|content|file|forum)_[a-z0-9_]{1,100}$/.test(value)?value:null;

// Routes are projected only after the same typed schema used by the read tool.
// No submitted value, ID, filter, query term or unknown key becomes evidence.
export function conversationReadRoute(tool,input){
 if(tool==='read-ai-delegation'){const parsed=aiManagementReadSchema.safeParse(input);return parsed.success?{module:'permissions',view:parsed.data.aiAccountId?'ai-work-prompt':'ai-delegation'}:{module:null,view:null};}
 const schema=tool==='query-operations'?agentOsQueryArgumentsSchema:tool==='read-operation-object'?agentOsReadArgumentsSchema:null;
 if(!schema)return {module:null,view:null};
 let parsed;try{parsed=schema.safeParse(input);}catch{return {module:null,view:null};}
 if(!parsed.success)return {module:null,view:null};
 return tool==='query-operations'?{module:parsed.data.module,view:parsed.data.view}:{module:readModules[parsed.data.kind]??null,view:parsed.data.kind};
}
export function conversationPriorReadReceipt(row){
 if(!reads.has(row?.tool)||!states.has(row?.state))return null;
 const metadata=row.metadata&&typeof row.metadata==='object'&&!Array.isArray(row.metadata)?row.metadata:{};
 const module=Object.hasOwn(agentOsQueryViews,metadata.module)?metadata.module:null;
 const view=module&&((row.tool==='query-operations'&&agentOsQueryViews[module].includes(metadata.view))||(row.tool==='read-operation-object'&&readModules[metadata.view]===module)||(row.tool==='read-ai-delegation'&&module==='permissions'&&['ai-work-prompt','ai-delegation'].includes(metadata.view)))?metadata.view:null;
 const timestamp=row.updated_at??row.created_at,date=timestamp instanceof Date?timestamp:new Date(timestamp);
 return {tool:row.tool,module,view,state:row.state,resultState:resultStates.has(metadata.state)?metadata.state:null,code:errorCode(metadata.code),observedAt:Number.isFinite(date.getTime())?date.toISOString():null};
}

const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
// A completed receipt is a locator, never a restored source snapshot or a new
// authority. Only the currently readable object's closed metadata is included.
export function conversationPriorActionTarget(row){
 const request=row?.proposal?.request,target=row?.proposal?.target,result=row?.result,receipt=result?.receipt,kind=row?.proposal?.kind;
 if(kind==='account-restriction'){
  const command=row.proposal.command,action=request?.action;
  if(row.state!=='completed'||request?.kind!==kind||!['apply','release'].includes(action)
   ||row.proposal.requiredAction!=='accounts.restriction.'+action||!uuid(row.id)||!uuid(row.operation_id)||!uuid(request.targetId)
   ||target?.kind!=='account'||target.id!==request.targetId||result?.state!=='completed'||result.operationId!==row.operation_id
   ||receipt?.operationId!==row.operation_id||receipt.accountId!==request.targetId
   ||!Number.isSafeInteger(command?.expectedRevision)||command.expectedRevision<0||receipt.revision!==command.expectedRevision+1
   ||command.reason!==request.reason||(action==='apply')!==Object.hasOwn(command,'until')
   ||action==='apply'&&(command.until!==request.until||typeof request.until!=='string'||!Number.isFinite(Date.parse(request.until))))return null;
  return{kind:'account',id:request.targetId};
 }
 if(kind==='feedback-update'){
  const command=row.proposal.command;
  if(row.state!=='completed'||request?.kind!==kind||!uuid(row.id)||!uuid(row.operation_id)||!uuid(request.targetId)
   ||target?.kind!=='feedback'||target.id!==request.targetId||result?.state!=='completed'||result.operationId!==row.operation_id
   ||receipt?.operationId!==row.operation_id||receipt.feedbackId!==request.targetId
   ||!Number.isSafeInteger(command?.expectedRevision)||command.expectedRevision<1
   ||receipt.revision!==command.expectedRevision+1
   ||!['category','module','state','note'].some(key=>Object.hasOwn(request,key)))return null;
  for(const key of ['category','module','state','note'])if(Object.hasOwn(request,key)&&request[key]!==command[key])return null;
  return{kind:'feedback',id:request.targetId};
 }
 if(row?.state!=='completed'||!['content-visibility','content-curation'].includes(kind)||request?.kind!==kind
  ||!['post','reply'].includes(request.targetKind)
  ||!uuid(row.id)||!uuid(row.operation_id)||!uuid(request.targetId)||target?.kind!==request.targetKind||target?.id!==request.targetId
  ||result?.state!=='completed'||result.operationId!==row.operation_id||receipt?.operationId!==row.operation_id)return null;
 if(kind==='content-visibility'){
  if(!['hide','restore'].includes(request.action)||receipt.hidden!==(request.action==='hide'))return null;
 }else{
  const command=row.proposal.command;
  if(!command||!Number.isSafeInteger(command.expectedVersion)||command.expectedVersion<1
   ||!Number.isSafeInteger(command.expectedRevision)||command.expectedRevision<0
   ||!Number.isSafeInteger(receipt.version)||!Number.isSafeInteger(receipt.revision)
   ||receipt.version!==command.expectedVersion||receipt.revision!==command.expectedRevision+1||receipt.hidden!==null
   ||!['topic','pinned','featured','tagIds'].some(key=>Object.hasOwn(request,key)))return null;
 }
 return {kind:request.targetKind,id:request.targetId};
}
export function conversationPriorActionReference(row,current){
 const target=conversationPriorActionTarget(row),request=row?.proposal?.request,receipt=row?.result?.receipt,data=current?.data;
 if(target?.kind==='feedback'){
  if(current?.tool!=='read-operation-object'||current.module!=='feedback'||current.availability!=='available'
   ||current.purpose!=='feedback-processing'||data?.id!==target.id||data.revision!==receipt.revision
   ||!Number.isSafeInteger(current.checkedAt)||!Number.isSafeInteger(current.readExpiresAt)||current.readExpiresAt<=current.checkedAt)return null;
  const date=new Date(row.updated_at??row.created_at);
  // A later human or business revision owns its own context. Do not reuse
  // an older effect as the basis for continuing or undoing that new decision.
  return{cardId:row.id,operationId:row.operation_id,kind:'feedback-update',action:'update',state:'completed',target,
   recordedEffect:{revision:receipt.revision},observedAt:Number.isFinite(date.getTime())?date.toISOString():null,
   current:{revision:data.revision,checkedAt:current.checkedAt,readExpiresAt:current.readExpiresAt}};
 }
 if(!target||data?.kind!==target.kind||data.id!==target.id
  ||data.sourceState!=='available'||typeof data.visibility?.hidden!=='boolean'
  ||!Number.isSafeInteger(current?.checkedAt)||!Number.isSafeInteger(current?.readExpiresAt)||current.readExpiresAt<=current.checkedAt)return null;
 const date=new Date(row.updated_at??row.created_at),curation=row.proposal.kind==='content-curation';
 if(curation&&(!Number.isSafeInteger(data.version)||data.version<1||!Number.isSafeInteger(data.curation?.revision)||data.curation.revision<0))return null;
 return {cardId:row.id,operationId:row.operation_id,kind:row.proposal.kind,action:curation?'curate':request.action,state:'completed',
  target,recordedEffect:curation?{sourceVersion:receipt.version,curationRevision:receipt.revision}:{hidden:receipt.hidden},
  observedAt:Number.isFinite(date.getTime())?date.toISOString():null,
  current:{sourceState:'available',hidden:data.visibility.hidden,...(curation?{sourceVersion:data.version,curationRevision:data.curation.revision}:{}),checkedAt:current.checkedAt,readExpiresAt:current.readExpiresAt}};
}


const restrictionMetadata=value=>{
 if(value?.scope!=='community-participation'||!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.active!=='boolean'
  ||value.until!==null&&(typeof value.until!=='string'||!Number.isFinite(Date.parse(value.until))))return null;
 return{scope:'community-participation',revision:value.revision,active:value.active,until:value.until===null?null:new Date(value.until).toISOString()};
};
// This is deliberately not governance prose: reasons, names, message content
// and operator identity do not leave the original account audit reader.
export function conversationAccountRestrictionReference(row,original,current){
 const target=conversationPriorActionTarget(row),request=row?.proposal?.request,command=row?.proposal?.command,receipt=row?.result?.receipt;
 if(target?.kind!=='account'||original?.state!=='recorded'||original.operationId!==row.operation_id||original.accountId!==target.id
  ||original.action!==(request.action==='apply'?'restriction-set':'restriction-release')
  ||!isDeepStrictEqual(original.selection,{...command,operationId:row.operation_id}))return null;
 const result=original.result,before=restrictionMetadata(result?.before),after=restrictionMetadata(result?.restriction),present=restrictionMetadata(current?.account?.restriction),card=restrictionMetadata({...receipt.restriction,revision:receipt.revision});
 if(result?.operationId!==row.operation_id||result.accountId!==target.id||current?.account?.accountId!==target.id
  ||!before||!after||!present||!card||before.revision!==command.expectedRevision||after.revision!==before.revision+1||!isDeepStrictEqual(card,after)
  ||!Number.isSafeInteger(current.checkedAt)||!Number.isSafeInteger(current.readExpiresAt)||current.readExpiresAt<=current.checkedAt)return null;
 if(request.action==='apply'?(after.active!==true||after.until!==new Date(request.until).toISOString()||result.restriction.reason!==request.reason)
  :(after.active!==false||after.until!==null||result.restriction.reason!==null))return null;
 const date=new Date(original.recordedAt??row.updated_at??row.created_at);
 return{cardId:row.id,operationId:row.operation_id,kind:'account-restriction',action:request.action,state:'completed',target,
  source:'same-owner-human-confirmed-card-and-domain-original-receipt',
  recordedEffect:{operationId:row.operation_id,before,after},currentMatchesOriginal:isDeepStrictEqual(present,after),
  observedAt:Number.isFinite(date.getTime())?date.toISOString():null,
  current:{...present,checkedAt:current.checkedAt,readExpiresAt:current.readExpiresAt}};
}
