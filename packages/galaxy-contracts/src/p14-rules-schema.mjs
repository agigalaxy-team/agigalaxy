import {z} from 'zod';
import {domainToASCII} from 'node:url';
import {ServiceError} from './service-error.mjs';

export const p14RuleKeys=['resource-budget','community-quota','forum-quota','business-controls'];
export const p14Targets=['forum-post','forum-reply','chat-message','forum-upload','chat-upload'];
export const p14FeatureForTarget=Object.freeze({'forum-post':'forumPost','forum-reply':'forumReply','chat-message':'chatSend','forum-upload':'attachmentUpload','chat-upload':'attachmentUpload'});
const uuid=z.uuid(),text=max=>z.string().trim().min(1).max(max).refine(value=>!/[\p{Cc}\p{Cs}]/u.test(value));
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const unique=values=>new Set(values).size===values.length;
export function p14Domain(value){
 if(typeof value!=='string'||value.length>253||/[/\\:@?#\s]/u.test(value))return null;
 const name=domainToASCII(value.toLowerCase().replace(/\.$/,''));
 return name&&name.length<=253&&name.includes('.')&&name.split('.').every(part=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))?name:null;
}
const leaf=z.strictObject({field:z.enum(['accountTier','subjectType','textLength','linkCount','attachmentCount','fileBytes','keywordList','domainList']),
 operator:z.enum(['eq','neq','gt','gte','lt','lte','matches']),value:z.union([z.string().min(1).max(160),integer])}).superRefine((value,ctx)=>{
 const valid=['keywordList','domainList'].includes(value.field)?value.operator==='matches'&&uuid.safeParse(value.value).success:
 ['accountTier','subjectType'].includes(value.field)?['eq','neq'].includes(value.operator)&&typeof value.value==='string'&&
 (value.field==='accountTier'?['new','normal']:['person','agent','organization']).includes(value.value):
 ['eq','neq','gt','gte','lt','lte'].includes(value.operator)&&typeof value.value==='number';
 if(!valid)ctx.addIssue({code:'custom',message:'Unsupported field/operator/value'});
});
export const p14ConditionSchema=z.lazy(()=>z.strictObject({combinator:z.enum(['and','or']),rules:z.array(z.union([leaf,p14ConditionSchema])).min(1).max(20)}));
const list=z.strictObject({id:uuid,name:text(80),kind:z.enum(['keyword','domain']),enabled:z.boolean(),entries:z.array(text(160)).max(500)}).superRefine((value,ctx)=>{
 if(!unique(value.entries.map(entry=>value.kind==='domain'?p14Domain(entry):entry.normalize('NFKC').toLocaleLowerCase('und'))))ctx.addIssue({code:'custom',message:'Duplicate list entries'});
 if(value.kind==='domain'&&value.entries.some(entry=>!p14Domain(entry)))ctx.addIssue({code:'custom',message:'A domain list requires host names'});
});
const exception=z.strictObject({id:uuid,name:text(80),enabled:z.boolean(),accountIds:z.array(uuid).min(1).max(100).refine(unique)});
const rule=z.strictObject({id:uuid,name:text(80),enabled:z.boolean(),targets:z.array(z.enum(p14Targets)).min(1).max(5).refine(unique),
 conditions:p14ConditionSchema,action:z.literal('reject'),exceptions:z.array(exception).max(30)});
const supported={
 'forum-post':['accountTier','subjectType','textLength','linkCount','attachmentCount','keywordList','domainList'],
 'forum-reply':['accountTier','subjectType','textLength','linkCount','attachmentCount','keywordList','domainList'],
 'chat-message':['accountTier','subjectType','textLength','linkCount','attachmentCount','keywordList','domainList'],
 'forum-upload':['accountTier','subjectType','fileBytes'],'chat-upload':['accountTier','subjectType','fileBytes'],
};
export const p14SupportedFields=Object.freeze(supported);
export const p14ControlsSchema=z.strictObject({schema:z.literal('business-controls/1'),features:z.strictObject({forumPost:z.boolean(),forumReply:z.boolean(),chatSend:z.boolean(),attachmentUpload:z.boolean()}),
 lists:z.array(list).max(50),rules:z.array(rule).max(100)}).superRefine((value,ctx)=>{
 if(!unique(value.lists.map(item=>item.id))||!unique(value.rules.map(item=>item.id)))ctx.addIssue({code:'custom',message:'Duplicate rule/list identity'});
 const lists=new Map(value.lists.map(item=>[item.id,item]));let count=0;
 function inspect(node,targets,depth){
  if(depth>6||++count>1000){ctx.addIssue({code:'custom',message:'Condition tree too large'});return;}
  if(node.rules){for(const child of node.rules)inspect(child,targets,depth+1);return;}
  if(targets.some(target=>!supported[target].includes(node.field)))ctx.addIssue({code:'custom',message:'Field unavailable for target'});
  if(['keywordList','domainList'].includes(node.field)&&lists.get(node.value)?.kind!==(node.field==='keywordList'?'keyword':'domain'))ctx.addIssue({code:'custom',message:'Missing or mismatched list'});
 }
 for(const item of value.rules){if(!unique(item.exceptions.map(entry=>entry.id)))ctx.addIssue({code:'custom',message:'Duplicate exception identity'});inspect(item.conditions,item.targets,0);}
});
export const p14EmptyControls=Object.freeze({schema:'business-controls/1',features:{forumPost:true,forumReply:true,chatSend:true,attachmentUpload:true},lists:[],rules:[]});
export const p14KeySchema=z.enum(p14RuleKeys);
export const p14PageSchema=z.strictObject({after:z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>BigInt(value)<=9223372036854775807n).optional(),limit:z.number().int().min(1).max(50).default(20)});
const base={operationId:uuid,expectedRevision:integer,reason:text(500)};
export const p14DraftSchema=z.strictObject({...base,policy:z.unknown()});
export const p14PublishSchema=z.strictObject({...base,versionId:uuid});
export const p14SampleFactsSchema=z.strictObject({target:z.enum(p14Targets).optional(),accountTier:z.enum(['new','normal']).optional(),subjectType:z.enum(['person','agent','organization']).optional(),
 text:z.string().max(20000).optional(),links:z.array(z.string().max(2048)).max(30).optional(),attachmentCount:integer.optional(),fileBytes:integer.optional(),accountId:uuid.optional(),
 quotaCategory:z.enum(['task','comment','invitation','post','version','reply','report']).optional(),used:integer.optional(),
 before:z.strictObject({payloadBytes:integer,queuedJobs:integer,activeExports:integer}).optional(),after:z.strictObject({payloadBytes:integer,queuedJobs:integer,activeExports:integer}).optional()});
export const p14SampleSchema=z.strictObject({versionId:uuid.optional(),policy:z.unknown().optional(),sample:p14SampleFactsSchema}).refine(value=>Number(value.versionId!==undefined)+Number(value.policy!==undefined)===1);
export function p14Parse(schema,value){
 // Check nesting before Zod's recursive condition schema. A malformed request
 // cannot turn an unsupported/deep condition into a false result or overflow.
 if(schema===p14ControlsSchema){const roots=Array.isArray(value?.rules)?value.rules.map(rule=>({node:rule?.conditions,depth:0})):[];let count=0;
  while(roots.length){const {node,depth}=roots.pop();if(depth>6||++count>1000)throw new ServiceError('invalid_operations_rule_request',400);if(Array.isArray(node?.rules))for(const child of node.rules)roots.push({node:child,depth:depth+1});}}
 const parsed=schema.safeParse(value);if(!parsed.success)throw new ServiceError('invalid_operations_rule_request',400);return parsed.data;
}
