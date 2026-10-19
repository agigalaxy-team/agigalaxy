import * as z from 'zod/v4';
import {assertNoWorkCredentials} from '../../../galaxy-core/src/local-data-redaction.mjs';
import {ServiceError} from './service-error.mjs';

const opaque = z.string().min(1).max(512);
const subject = z.string().regex(/^GUID[0-9A-Z]{28}$/);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime();
const technicalId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:+-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_.:+-]*)?$/)
 .refine(value => !/^[a-z]:\//i.test(value));
const host = z.enum(['opencode','codex','claude-code','claude','gemini-cli','cursor','vscode','windsurf','openclaw','mcp','host','unknown']);
export const accountWorkOutcomeSchema = z.enum(['unknown','reported-success','reported-failure','partial','cancelled']);

// The overview is a field projection, not a summary judged to be safe by a model.
// Adding a prose field here would widen the selected upload type.
export const accountWorkEnvironmentSchema = z.strictObject({id:z.uuid(),version:z.number().int().positive(),observedAt:timestamp,
 facts:z.strictObject({host:technicalId.optional(),hostVersion:technicalId.optional(),platform:technicalId.optional(),
  architecture:technicalId.optional(),runtime:technicalId.optional(),runtimeVersion:technicalId.optional(),
  selectedModel:technicalId.optional(),actualModel:technicalId.optional(),
  tools:z.array(technicalId.refine(value=>!value.includes('/'))).max(256).optional()})});

function boundedMaterial(value,context){
 let nodes=0;
 function visit(item,depth){
  if(++nodes>4096||depth>16)return false;
  if(item===null||typeof item==='boolean')return true;
  if(typeof item==='number')return Number.isFinite(item);
  if(typeof item==='string')return item.length<=16384;
  if(Array.isArray(item))return item.length<=1000&&item.every(child=>visit(child,depth+1));
  if(typeof item!=='object'||Object.getPrototypeOf(item)!==Object.prototype)return false;
  return Object.entries(item).every(([key,child])=>key.length<=256&&!['__proto__','constructor','prototype'].includes(key)&&visit(child,depth+1));
 }
 if(!visit(value,0))context.addIssue({code:'custom',message:'Bounded work material required'});
}
const material = z.unknown().superRefine(boundedMaterial);
export const accountWorkObservationSchema = z.strictObject({
 id:z.uuid(),sequence,sourceId:opaque,revision:sequence,latestRevision:sequence,superseded:z.boolean(),
 kind:z.enum(['message','tool','session','artifact','claim','gap']),occurredAt:timestamp.nullable(),observedAt:timestamp,
 source:z.strictObject({kind:z.enum(['host-event','user-statement','model-report','tool-report','external-material']),
  messageId:opaque.optional(),partId:opaque.optional(),eventId:opaque.optional(),locator:z.string().max(2048).optional()}),
 content:z.strictObject({excerpt:z.string().max(4000),originalLength:sequence.optional(),
  retained:z.enum(['none','excerpt','full']),availableFromHost:z.boolean()}).nullable(),
 details:material,
 exclusions:z.array(z.strictObject({path:z.string().max(2048),kind:z.enum(['credential','inline-binary','depth-limit','cyclic-reference'])})).max(1000),
 environmentId:z.uuid().nullable(),environmentMeaning:z.literal('observed-at-collection'),localOnly:z.literal(true)
}).refine(value=>value.latestRevision>=value.revision&&value.superseded===(value.latestRevision>value.revision));

const common = {
 workId:opaque,galaxyId:subject,source:z.strictObject({host,sessionId:z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/).optional()}),
 workType:z.enum(['unknown','development','research','writing','design','operations','analysis','learning','other']),
 role:z.enum(['unknown','owner','participant','contributor','reviewer','observer']),startedAt:timestamp.optional(),updatedAt:timestamp.optional(),
 resultStatus:accountWorkOutcomeSchema,resultSource:z.enum(['user-model','host-observations']),
 environments:z.array(accountWorkEnvironmentSchema).max(1000)
};
const summary = z.strictObject({title:z.string().max(180),summary:z.string().max(12000),outcome:accountWorkOutcomeSchema,
 summaryRevision:sequence,sourceKind:z.enum(['user-model','host-observations']),updatedAt:timestamp.optional()});
const coverage = z.strictObject({observations:z.strictObject({sourceTotal:sequence,included:sequence,
 firstSequence:sequence.nullable(),lastSequence:sequence.nullable(),hasEarlier:z.boolean()}),
 omittedFields:z.array(z.enum(['summary','environments'])).max(2).refine(values=>new Set(values).size===values.length).optional()});
export const accountWorkProjectionSchema = z.discriminatedUnion('uploadLevel',[
 z.strictObject({...common,uploadLevel:z.literal('history-overview')}),
 z.strictObject({...common,uploadLevel:z.literal('work-content'),summary:summary.optional(),observations:z.array(accountWorkObservationSchema).max(2000).optional(),coverage:coverage.optional()}),
 // A work projection never contains a full conversation. Those bytes have a
 // separate explicitly selected private-archive endpoint and lifecycle.
 z.strictObject({...common,uploadLevel:z.literal('conversation-archive'),summary:summary.optional(),observations:z.array(accountWorkObservationSchema).max(2000).optional(),coverage:coverage.optional()})
]).superRefine((value,context)=>{
 if(new TextEncoder().encode(JSON.stringify(value)).length>524288)context.addIssue({code:'custom',message:'Work projection too large'});
 try{assertNoWorkCredentials(value);}catch{context.addIssue({code:'custom',message:'Credentials are excluded from work material'});}
 const environments=value.environments.map(item=>item.id);
 if(new Set(environments).size!==environments.length)context.addIssue({code:'custom',message:'Duplicate environment'});
 const observations=value.observations??[];
 if(new Set(observations.map(item=>item.id)).size!==observations.length)context.addIssue({code:'custom',message:'Duplicate observation'});
 if(value.coverage){
  const included=value.coverage.observations,omitted=value.coverage.omittedFields??[];
  if(included.included!==observations.length||included.sourceTotal<included.included
   ||included.firstSequence!==(observations[0]?.sequence??null)||included.lastSequence!==(observations.at(-1)?.sequence??null)
   ||included.hasEarlier!==(included.sourceTotal>included.included)
   ||observations.some((item,index)=>index>0&&item.sequence<=observations[index-1].sequence)
   ||omitted.includes('summary')&&value.summary!==undefined||omitted.includes('environments')&&value.environments.length>0)
   context.addIssue({code:'custom',message:'Work coverage does not match the uploaded window'});
 }
});

export const accountWorkPutSchema = z.strictObject({operationId:z.uuid(),workId:opaque,scopeId:z.uuid(),
 revision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),expectedRevision:sequence,data:accountWorkProjectionSchema})
 .refine(value=>value.workId===value.data.workId&&value.revision===value.expectedRevision+1);
export const accountWorkKeySchema = z.strictObject({workId:opaque});
export const accountWorkListSchema = z.strictObject({after:opaque.optional(),limit:z.number().int().min(1).max(50).default(20)});

export function parseAccountWorkInput(schema,input){
 const parsed=schema.safeParse(input);
 if(!parsed.success)throw new ServiceError('account_work_input_invalid');
 return parsed.data;
}
