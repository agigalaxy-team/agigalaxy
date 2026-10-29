import {z} from 'zod';
import {ServiceError} from './service-error.mjs';
import {p14ConditionSchema} from './p14-rules-schema.mjs';

export const p13Domains=['overview','governance','messaging','discovery','maintenance'];
export const p13Modes=['code-automatic','ai-autonomous','ai-human-participation','human-led'];
export const p13Workflow={id:'galaxy-p13-selected-content-v1',version:1};
const note=z.string().trim().min(1).max(2400);
const maybeNote=note.nullable();
const ids=z.array(z.uuid()).max(200).refine(v=>new Set(v).size===v.length);
const parameterPath=z.array(z.number().int().min(0).max(19)).min(1).max(6);
const condition=p14ConditionSchema.superRefine((tree,c)=>{let n=0;function check(node,depth){if(depth>6||++n>1000){c.addIssue({code:'custom',message:'condition too large'});return;}if(node.rules)node.rules.forEach(v=>check(v,depth+1));else if(!['textLength','linkCount','attachmentCount'].includes(node.field))c.addIssue({code:'custom',message:'unsupported content predicate'});}check(tree,0);});
const uniqueValues=value=>new Set(value).size===value.length;
export const p13ExecutionSchema=z.strictObject({
 aiDomain:z.enum(p13Domains),
 trigger:z.strictObject({kind:z.enum(['manual','interval','daily','event']),minutes:z.number().int().min(1).max(10080).optional(),
  at:z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/).nullable().optional(),eventTypes:z.array(z.string().regex(/^[a-z][a-z0-9_.:-]{0,119}$/)).max(50).refine(uniqueValues).default([])}),
 mode:z.enum(['code','ai','ai-human','human-ai']),
 grantIds:z.array(z.uuid()).max(50).refine(uniqueValues),
 resourceScope:z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('eligible')}),z.strictObject({kind:z.literal('selected'),resourceIds:ids}),z.strictObject({kind:z.literal('unresolved')})]),
 requiredRehearsal:z.boolean(),actions:z.array(z.string().regex(/^[a-z][a-z0-9_.:-]{0,119}$/)).max(200).refine(uniqueValues)
});
export const p13StrategySchema=z.strictObject({
 id:z.uuid(),name:z.string().trim().min(1).max(120),domain:z.enum(p13Domains),objective:maybeNote,
 enabled:z.boolean(),mode:z.enum(p13Modes),
 template:z.enum(['selected-public-content-visibility','analysis-only','business-action']),
 execution:p13ExecutionSchema.nullable().optional(),
 judgment:z.enum(['prepared-command','semantic']),instructions:maybeNote,
 condition:condition.nullable().default(null),
 ordinaryBounds:z.strictObject({parameters:z.array(z.strictObject({path:parameterPath,minimum:z.number().int().nonnegative(),maximum:z.number().int().nonnegative()}).refine(v=>v.maximum>=v.minimum)).max(30),
  modes:z.array(z.enum(['code-automatic','ai-autonomous','ai-human-participation'])).max(3).refine(v=>new Set(v).size===v.length),canEnable:z.boolean(),canDisable:z.boolean(),canCreate:z.boolean().optional()}).nullable().default(null),
 // A human can explicitly approve a previous, validated version as a recovery
 // target. Empty conditions never mean "recover for any failure".
 recovery:z.strictObject({versionId:z.uuid().nullable(),conditions:z.array(z.enum(['native-unavailable','workflow-failed'])).max(2).refine(v=>new Set(v).size===v.length)})
}).superRefine((v,c)=>{
 if(v.template==='selected-public-content-visibility'&&v.domain!=='governance')c.addIssue({code:'custom',message:'unsupported domain',path:['domain']});
 if(v.execution&&v.template==='analysis-only'&&v.execution.actions.length)c.addIssue({code:'custom',message:'analysis strategy cannot authorize writes',path:['execution','actions']});
 if(v.execution&&({code:'code-automatic',ai:'ai-autonomous','ai-human':'ai-human-participation','human-ai':'human-led'}[v.execution.mode]!==v.mode))c.addIssue({code:'custom',message:'leadership mode must agree',path:['execution','mode']});
 if(v.judgment==='semantic'&&!v.instructions)c.addIssue({code:'custom',message:'semantic instructions required',path:['instructions']});
 if((v.recovery.versionId===null)!==(v.recovery.conditions.length===0))c.addIssue({code:'custom',message:'explicit recovery conditions required',path:['recovery']});
 if(v.ordinaryBounds){const paths=new Set();for(const bound of v.ordinaryBounds.parameters){const key=bound.path.join('.');let node=v.condition;for(const i of bound.path)node=node?.rules?.[i];
  if(paths.has(key)||!node||node.rules||typeof node.value!=='number')c.addIssue({code:'custom',message:'ordinary bound requires a unique numeric condition leaf',path:['ordinaryBounds']});paths.add(key);
 }}
});
export const p13ConfigurationSchema=z.strictObject({
 common:z.strictObject({objective:maybeNote,automationEnabled:z.boolean()}),
 domains:z.array(z.strictObject({key:z.enum(p13Domains),objective:maybeNote,priority:maybeNote,executionEnabled:z.boolean()})).length(5)
  .refine(v=>new Set(v.map(x=>x.key)).size===5),
 strategies:z.array(p13StrategySchema).max(200).refine(v=>new Set(v.map(x=>x.id)).size===v.length)
});
export const p13EmptyConfiguration={common:{objective:null,automationEnabled:false},domains:p13Domains.map(key=>({key,objective:null,priority:null,executionEnabled:false})),strategies:[]};
const command={operationId:z.uuid(),expectedRevision:z.number().int().nonnegative()};
export const p13DraftSchema=z.strictObject({...command,configuration:p13ConfigurationSchema,reason:note});
export const p13PublishSchema=z.strictObject({...command,versionId:z.uuid(),rehearsalId:z.uuid(),reason:note});
export const p13RehearsalSchema=z.strictObject({operationId:z.uuid(),versionId:z.uuid(),executionIds:ids});
export const p13RunSchema=z.strictObject({operationId:z.uuid(),strategyId:z.uuid(),executionId:z.uuid()});
export const p13ContinueSchema=z.strictObject({operationId:z.uuid(),confirmed:z.boolean().optional(),inputDecision:z.enum(['proceed','no-action']).optional()}).refine(v=>(v.confirmed!==undefined)!==(v.inputDecision!==undefined));
export const p13ControlSchema=z.strictObject({...command,kind:z.enum(['pause','resume']),reason:note});
export const p13OrdinaryDraftSchema=z.strictObject({...command,strategyId:z.uuid(),parameterEdits:z.array(z.strictObject({path:parameterPath,value:z.number().int().nonnegative()})).max(30).default([]),mode:z.enum(['code-automatic','ai-autonomous','ai-human-participation','human-led']).optional(),enabled:z.boolean().optional()}).refine(v=>v.parameterEdits.length>0||v.mode!==undefined||v.enabled!==undefined);
export const p13OrdinaryPublishSchema=z.strictObject({...command,strategyId:z.uuid(),versionId:z.uuid()});
export const p13PageSchema=z.strictObject({after:z.string().regex(/^[1-9][0-9]{0,18}$/).optional(),limit:z.coerce.number().int().min(1).max(50).default(20),strategyId:z.uuid().optional()});
export const p13NativeStepSchema=z.strictObject({runId:z.uuid(),executionId:z.uuid(),nativeRunId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),phase:z.enum(['prepare','decision','effect','finished','failed']),decision:z.enum(['proceed','human-required','needs-input','no-action']).optional(),failure:z.enum(['native-unavailable','workflow-failed']).optional()});
export function p13Parse(schema,input){
 const strategies=input?.configuration?.strategies??(schema===p13ConfigurationSchema?input?.strategies:null);let size=0;
 const queue=Array.isArray(strategies)?strategies.filter(Boolean).map(s=>({node:s.condition,depth:0})):[];
 while(queue.length){const {node,depth}=queue.pop();if(!node)continue;if(depth>6||++size>1000)throw new ServiceError('invalid_p13_strategy_request',400);if(Array.isArray(node.rules))for(const n of node.rules)queue.push({node:n,depth:depth+1});}
 const r=schema.safeParse(input);if(!r.success)throw new ServiceError('invalid_p13_strategy_request',400);return r.data;
}
