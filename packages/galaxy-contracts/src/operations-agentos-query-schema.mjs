import {z} from 'zod';
import {businessUsersQuerySchema,businessSummaryQuerySchema,businessAuditQuerySchema} from './business-admin-schema.mjs';
import {operationsSectionsQuerySchema,operationsReportsQuerySchema,operationsFilesQuerySchema,operationsFilesSummaryQuerySchema,operationsResourcesQuerySchema} from './operations-business-schema.mjs';
import {operationsContentQuerySchema} from './operations-forum-content-schema.mjs';
import {feedbackQuerySchema} from './operations-feedback-schema.mjs';
import {messagingPlansQuerySchema,messagingRunsQuerySchema,messagingRecipientsQuerySchema,messagingPageSchema} from './operations-messaging-schema.mjs';
import {searchQualityOverviewSchema,searchQualityHistorySchema} from './operations-search-quality-schema.mjs';
import {recommendationOverviewSchema,recommendationHistorySchema} from './operations-recommendation-schema.mjs';
import {maintenanceBackupsQuerySchema,maintenancePlansQuerySchema,maintenanceLogsQuerySchema} from './operations-maintenance-schema.mjs';
import {p13PageSchema} from './p13-strategies-schema.mjs';
import {p14PageSchema,p14KeySchema} from './p14-rules-schema.mjs';
import {accountChatReportQuerySchema} from './account-chat-governance-schema.mjs';
import {operationsFileCleanupCandidatesSchema,operationsFileCleanupPlansSchema} from './operations-file-cleanup-schema.mjs';
import {registeredUsersQuerySchema} from './operations/accounts/registered-schema.mjs';

export const agentOsQueryDomains=['overview','governance','messaging','discovery','maintenance'];
const empty=z.strictObject({}),uuid=z.uuid(),opaque=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),page=z.strictObject({after:uuid.optional(),limit:z.number().int().min(1).max(50).default(20)});
const analyticsFilters=z.strictObject({days:z.number().int().min(1).max(90).default(7),scope:z.literal('accounts').optional(),accountId:uuid.optional()});
const runsFilters=z.strictObject({page:z.number().int().min(1).max(100000).default(1),limit:z.number().int().min(1).max(50).default(25),domain:z.enum(agentOsQueryDomains).optional(),state:z.enum(['PENDING','RUNNING','COMPLETED','PAUSED','CANCELLED','ERROR','REGENERATED']).optional()});
const jobFilters=page.extend({queue:z.enum(['information-watch','search-recovery','content-publication','account-notice','retention-cleanup','messaging-run','messaging-delivery'])});
const options={};
export const agentOsQueryViews={};
function add(module,view,filters=empty){(agentOsQueryViews[module]??=[]).push(view);(options[module]??=[]).push(z.strictObject({module:z.literal(module),view:z.literal(view),filters:filters.default({})}));}
add('accounts','list',businessUsersQuerySchema);add('accounts','summary',businessSummaryQuerySchema);
add('registered-users','list',registeredUsersQuerySchema);
for(const view of ['overview','general','mail','service-connections','advanced'])add('system-settings',view);
add('content','list',operationsContentQuerySchema.refine(q=>!q.query||!q.visibility||q.visibility==='visible'));add('content','sections',operationsSectionsQuerySchema);add('content','tags');
add('cases','list',operationsReportsQuerySchema);add('chat-reports','list',accountChatReportQuerySchema);
// Feedback prose is a dedicated support purpose. This general tool exposes metadata only and cannot search its private body.
add('feedback','list',feedbackQuerySchema.omit({query:true}));
add('files','list',operationsFilesQuerySchema);add('files','summary',operationsFilesSummaryQuerySchema);
add('files','cleanup-candidates',operationsFileCleanupCandidatesSchema);add('files','cleanup-plans',operationsFileCleanupPlansSchema);
add('resources','projects',operationsResourcesQuerySchema);add('resources','methods',operationsResourcesQuerySchema.omit({state:true}));
for(const kind of ['overview','business'])add('analytics',kind,analyticsFilters.omit({scope:true,accountId:true}));
for(const kind of ['retention','paths'])add('analytics',kind,analyticsFilters.refine(q=>!q.accountId||q.scope==='accounts'));
add('analytics','account',analyticsFilters.omit({scope:true}).extend({accountId:uuid}));
add('recommendations','overview',recommendationOverviewSchema);add('recommendations','policy');add('recommendations','history',recommendationHistorySchema);
add('search','overview',searchQualityOverviewSchema);add('search','history',searchQualityHistorySchema);
add('messaging','notices',messagingPageSchema);add('messaging','plans',messagingPlansQuerySchema);add('messaging','runs',messagingRunsQuerySchema);
add('messaging','recipients',messagingRecipientsQuerySchema.extend({runId:uuid}));add('messaging','history',messagingPageSchema.extend({planId:uuid}));
add('strategies','overview');add('strategies','versions',p13PageSchema);add('strategies','records',p13PageSchema);
add('rules','overview');add('rules','versions',p14PageSchema.extend({key:p14KeySchema}));
add('maintenance','overview');add('maintenance','backups',maintenanceBackupsQuerySchema);add('maintenance','plans',maintenancePlansQuerySchema);add('maintenance','logs',maintenanceLogsQuerySchema);
add('audit','list',businessAuditQuerySchema);add('runs','list',runsFilters);add('jobs','list',jobFilters);
for(const view of ['roles','personnel','automation'])add('permissions',view);
// Choose the declared route before parsing its cursor. Other modules may use
// numeric sequences and must never evaluate a file's opaque cursor as BigInt.
export const agentOsQueryArgumentsSchema=z.discriminatedUnion('module',Object.values(options).map(views=>views.length===1?views[0]:z.discriminatedUnion('view',views)));
export const agentOsReadKinds=['account','account-summary','registered-user','post','reply','section','case','chat-report','feedback','chat-file','forum-file','file-cleanup-plan','file-cleanup-operation','project','method','message-plan','message-run','notice','recommendation-theme','rule','strategy-run','strategy-version','search-version','ai-run','backup-point','restore-plan','role'];
export const agentOsReadArgumentsSchema=z.discriminatedUnion('kind',agentOsReadKinds.map(kind=>z.strictObject({kind:z.literal(kind),id:kind==='rule'?p14KeySchema:kind==='backup-point'?z.string().regex(/^[a-f0-9]{64}$/):kind==='ai-run'?opaque:uuid,filters:(kind==='account-summary'?businessSummaryQuerySchema:empty).default({})})));
export const agentOsQueryToolSchema=z.enum(['query-operations','read-operation-object']);
export const agentOsQueryContract={tools:['query-operations','read-operation-object'],modules:agentOsQueryViews,readKinds:agentOsReadKinds};

const issueCodes=new Set(['invalid_type','too_big','too_small','invalid_format','not_multiple_of','unrecognized_keys','invalid_union','invalid_key','invalid_element','invalid_value','custom']);
const routeList=Object.values(options).flat();
const jsonSchema=schema=>z.toJSONSchema(schema,{io:'input',unrepresentable:'any'});
const filterDefinitions=route=>jsonSchema(route.shape.filters);
let knownFilterKeys;
function publicFilterKeys(){
 return knownFilterKeys??=new Set(routeList.flatMap(route=>Object.keys(filterDefinitions(route).properties??{})));
}
function constraints(definition){
 const filterEnums={},filterNumberRanges={};
 for(const[key,property]of Object.entries(definition.properties??{})){
  const variants=property.anyOf??property.oneOf??[property],values=[];
  for(const variant of variants){
   const candidates=variant.enum??(Object.hasOwn(variant,'const')?[variant.const]:[]);
   for(const value of candidates)if((value===null||['string','number','boolean'].includes(typeof value))&&!values.includes(value))values.push(value);
   if(['number','integer'].includes(variant.type)){
    const range={};
    for(const field of ['minimum','maximum','exclusiveMinimum','exclusiveMaximum'])if(Number.isFinite(variant[field]))range[field]=variant[field];
    range.integer=variant.type==='integer';filterNumberRanges[key]=range;
   }
  }
  if(values.length)filterEnums[key]=values;
 }
 return{filterEnums,filterNumberRanges};
}
function safeIssues(issues,fields){
 const result=[],seen=new Set();
 const add=(items,prefix=[])=>{
  for(const issue of items??[]){
   const path=[];
   for(const field of [...prefix,...(Array.isArray(issue.path)?issue.path:[])]){
    if(typeof field!=='string'||!fields.has(field))break;
    path.push(field);
   }
   const code=issueCodes.has(issue.code)?issue.code:'invalid_request',key=JSON.stringify([path,code]);
   if(!seen.has(key)&&result.length<16){seen.add(key);result.push({path,code});}
   for(const branch of Array.isArray(issue.errors)?issue.errors:[])if(Array.isArray(branch))add(branch,path);
  }
 };
 add(issues);return result;
}

// This is feedback for the two fixed tools, not an arbitrary schema endpoint.
// Never include submitted values, unknown field names, patterns or error prose.
// A valid request returning a service error must not be relabelled as harmless.
export function agentOsQueryInvalidFeedback(tool,input){
 const schema=tool==='query-operations'?agentOsQueryArgumentsSchema:tool==='read-operation-object'?agentOsReadArgumentsSchema:null;
 if(!schema)return null;
 let parsed;try{parsed=schema.safeParse(input);}catch{return null;}
 if(parsed.success)return null;
 const query=tool==='query-operations',module=query&&typeof input?.module==='string'&&Object.hasOwn(options,input.module)?input.module:null,
  kind=!query&&agentOsReadKinds.includes(input?.kind)?input.kind:null,
  route=query?(options[module]??[]).find(item=>item.shape.view.value===input?.view):agentOsReadArgumentsSchema.options.find(item=>item.shape.kind.value===kind),
  view=query&&route?input.view:null,definition=route?filterDefinitions(route):{},allowedFilterKeys=Object.keys(definition.properties??{}),
  filterKeys=input?.filters&&typeof input.filters==='object'&&!Array.isArray(input.filters)?Object.keys(input.filters).filter(key=>publicFilterKeys().has(key)):[],
  fields=new Set(['module','view','kind','id','filters',...allowedFilterKeys]);
 return{tool,state:'invalid-request',code:'invalid_operations_agentos_query',nextStep:'correct-arguments',effectExecuted:false,
  module,view,...(!query?{kind}:{}),filterKeys,allowedFilterKeys,requiredFilterKeys:definition.required??[],...constraints(definition),
  ...(query&&module?{allowedViews:[...agentOsQueryViews[module]]}:query?{allowedModules:Object.keys(options)}:!kind?{allowedKinds:[...agentOsReadKinds]}:{}),
  issues:safeIssues(parsed.error.issues,fields)};
}
