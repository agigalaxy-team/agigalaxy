import {z} from 'zod';
import {ServiceError} from '../../shared/service-error.mjs';

export const autonomyDomains=['overview','governance','messaging','discovery','maintenance'];
export const autonomyModes=['code','ai','ai-human','human-ai'];
export const autonomySources=['workbench','routine','event','recovery'];
export const autonomyStates=['queued','running','waiting-human','paused','completed','failed','stopped','blocked','unknown'];
export const autonomyModelStates=['not-started','dispatching','accepted','running','completed','failed','cancelled','unknown','not-required'];
export const autonomyBusinessStates=['not-started','pending','completed','failed','unknown','no-action'];
export const autonomyDefaults=Object.freeze({concurrency:2,healthSeconds:30,startGraceSeconds:120,roundSeconds:600,eventCoalesceSeconds:30});
export const terminalStates=new Set(['completed','failed','stopped','blocked']);
export const domainNames={overview:'总控',governance:'治理',messaging:'消息',discovery:'数据与发现',maintenance:'运维'};
export const fail=(code,status=409)=>{throw new ServiceError(code,status);};
export const parse=(schema,input)=>{const result=schema.safeParse(input);if(!result.success)fail('invalid_operations_autonomy_request',400);return result.data;};
export const iso=value=>value===null||value===undefined?null:new Date(value).toISOString();
const safeCode=z.string().regex(/^[a-z][a-z0-9_.:-]{0,119}$/),uuid=z.uuid();
export const targetTypes=['content-post','content-reply','content-section','account','business-account','community-report','chat-report','feedback','project','method','file-chat','file-forum','file-cleanup-plan','messaging-plan','recommendation-policy','search-quality','rule-key','maintenance','ai-role','ai-role-assignment','ai-work-account','strategy','strategy-configuration','strategy-run'];
export const planSchema=z.strictObject({strategyIds:z.array(uuid).max(50).default([]),grantIds:z.array(uuid).max(50).default([]),actions:z.array(safeCode).max(200).default([]),resourceIds:z.array(uuid).max(100).default([]),eventTypes:z.array(safeCode).max(50).default([])});
export const scheduleSchema=z.strictObject({kind:z.enum(['interval','daily']),minutes:z.number().int().min(1).max(10080).nullable().optional(),at:z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/).nullable().optional(),timezone:z.literal('Asia/Shanghai').default('Asia/Shanghai')});
export const configSchema=z.strictObject({operationId:uuid,expectedRevision:z.number().int().min(1),enabled:z.boolean(),mode:z.enum(autonomyModes),schedule:scheduleSchema,purpose:z.string().trim().min(1).max(120),goal:z.string().trim().max(4000),prompt:z.string().max(16000),plan:planSchema.default({})});
export const controlSchema=z.strictObject({operationId:uuid,expectedRevision:z.number().int().min(1),kind:z.enum(['pause','resume','stop','takeover','reconcile'])});
export const decisionSchema=z.strictObject({operationId:uuid,expectedRevision:z.number().int().min(1),callId:uuid,decision:z.enum(['rejected','cancelled','no-action'])});
export const enableSchema=z.strictObject({operationId:uuid,accounts:z.array(z.strictObject({domain:z.enum(autonomyDomains),expectedRevision:z.number().int().min(1)})).min(1).max(5)});
export const taskQuerySchema=z.strictObject({page:z.number().int().min(1).max(100000).default(1),limit:z.number().int().min(1).max(100).default(25),domain:z.enum(autonomyDomains).optional(),source:z.enum(autonomySources).optional(),state:z.enum(autonomyStates).optional(),mode:z.enum(autonomyModes).optional(),targetType:z.enum(targetTypes).optional(),targetId:z.string().min(1).max(128).optional()}).refine(x=>!!x.targetType===!!x.targetId);
export const authorizeSchema=z.strictObject({taskId:uuid,operation:z.enum(['read','run','tool'])});
export const reportSchema=z.strictObject({taskId:uuid,nativeRunId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),modelState:z.enum(autonomyModelStates),status:z.enum(['running','waiting-human','completed','failed','unknown']),code:safeCode.optional(),summary:z.string().max(4000).optional()});
export const toolSchema=z.strictObject({taskId:uuid,callId:uuid,nativeRunId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),tool:z.enum(['current-summary','query-operations','read-operation-object','execute-operation','manage-ai-role','manage-ai-prompt','read-ai-delegation']),arguments:z.record(z.string(),z.unknown())});
export function defaultConfiguration(domain){return{enabled:false,mode:'ai-human',schedule:domain==='maintenance'?{kind:'daily',at:null,timezone:'Asia/Shanghai'}:{kind:'interval',minutes:{overview:30,governance:20,messaging:30,discovery:60}[domain],timezone:'Asia/Shanghai'},purpose:'operations-'+domain,goal:'',prompt:'',plan:parse(planSchema,{})};}
export function nextDue(schedule,at){
 if(schedule.kind==='interval')return new Date(at.getTime()+schedule.minutes*60000);
 if(!schedule.at)fail('operations_autonomy_daily_time_required',400);
 const local=new Date(at.getTime()+8*3600000),[h,m]=schedule.at.split(':').map(Number);
 let due=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate(),h-8,m);
 if(due<=at.getTime())due+=86400000;return new Date(due);
}
export const boundaryPrompt='只处理本任务的用途与获准资料；当前角色、授权、对象条件和人工要求由服务逐次核对。模型结束不等于业务完成。未知结果查询原操作；停止或人工接管后不得继续写入。不得更改模型、凭据、人员授权或绕过人工批准。';
