import type {AiManagementCapabilities} from './ai-management-capabilities';

export type AgentOsDomain='overview'|'governance'|'messaging'|'discovery'|'maintenance';
export type AgentOsStatus={state:'connected'|'not-configured'|'unavailable';modelState:'configured'|'not-configured'|'unknown';framework:'agno';version:string;checkedAt:number;readExpiresAt:number};
export type AgentOsExecution={id:string;domain:AgentOsDomain;grantId:string;grantVersion:number;executorKind:'ai'|'program';mode:'assisted'|'automatic';operatorId:string|null;createdBy:string;actions:string[];resourceIds:string[];state:'active'|'paused'|'stopped';revision:number;sessionId:string;hasPreparedCommand:boolean;createdAt:string;updatedAt:string};
export type AgentOsGrantOption={id:string;name:string;version:number;domain:AgentOsDomain;mode:'assisted';resourceIds:string[];resourceScope:{kind:'selected';resourceIds:string[]}|{kind:'eligible'}|{kind:'unresolved'};actions:string[]};
export type AgentOsOptions={items:AgentOsGrantOption[];checkedAt:number;readExpiresAt:number};
export type AgentOsExecutions={items:AgentOsExecution[];checkedAt:number;readExpiresAt:number};
export type AgentOsNativeRun={runId:string;operationId:string|null;status:string;content:string|null;userInput:string|null;createdAt:number|null;events:{event:string;eventIndex:number|null;createdAt:number|null}[];awaitingHuman:boolean;cancellation?:{operationId:string;state:'dispatching'|'accepted'|'unknown';recordedAt:string|null};errorCode?:string|null;failure?:{stage:'model-request';category:'rate-limit'|'timeout'|'connection'|'context-limit'|'service-unavailable'|'request-rejected'|'unknown';reportedStatus:number|null}|null;businessActivity?:{state:'not-started'|'check-records'|'unknown';basis:'same-owner-turn-tool-and-card-ledger'}};
export type AgentOsPreparedAction={tool:'content-visibility';targetKind:'post'|'reply';targetId:string;input:{kind:'hide'|'restore';until?:number;reason:string;expectedVersion:number;expectedRevision:number}};
export type AgentOsDetail={execution:AgentOsExecution;preparedAction:AgentOsPreparedAction|null;native:{executionId:string;runs:AgentOsNativeRun[];traces:{traceId:string;status:string;durationMs:number;runId:string|null}[];traceCount:number;modelState:string}|null;runtimeState:string;modelState:string;checkedAt:number;readExpiresAt:number};
export type AgentOsCommand={execution?:AgentOsExecution;executionId?:string;kind?:string|null;preparedAction?:AgentOsPreparedAction|null;operationId?:string;runId?:string|null;state?:string;native?:AgentOsNativeRun|null;replayed?:boolean;cancelledOperationId?:string};
export type AgentOsConversation={domain:AgentOsDomain;runs:AgentOsNativeRun[];runtimeState:'connected'|'unavailable'|'not-configured';modelState:'configured'|'not-configured'|'unknown';capabilities:{canSend:boolean;canStream?:boolean;canCancel?:boolean};managementCapabilities?:AiManagementCapabilities|null;blockedReason:null|'runtime-unavailable'|'runtime-not-ready'|'model-not-configured';checkedAt:number;readExpiresAt:number};
export const agentOsConversationPath=(domain:AgentOsDomain)=>'/v1/operations/agentos/conversations/'+domain;
export const agentOsConversationOperationPath=(domain:AgentOsDomain,operationId:string)=>agentOsConversationPath(domain)+'/operations/'+encodeURIComponent(operationId);
export const agentOsConversationCancelPath=(domain:AgentOsDomain,operationId:string)=>agentOsConversationOperationPath(domain,operationId)+'/cancel';
export const agentOsOriginalCommandPath=(operationId:string)=>'/v1/operations/agentos/operations/'+encodeURIComponent(operationId);
export type AgentOsSession={state:'signed-in';operator:{id:string;businessAuthorization?:{permissions:string[]}};csrfToken:string;expiresAt:number}|{state:'signed-out'};
export function agentOsCanUseDomain(session:AgentOsSession|null|undefined,domain:AgentOsDomain){
 const permissions=session?.state==='signed-in'?session.operator.businessAuthorization?.permissions:undefined;
 return permissions?.includes('workbench.read')===true&&operationsAiUseAllowed(permissions,domain);
}
export const agentOsErrors:Record<string,string>={
 operations_ai_prompt_version_changed:'岗位工作要求已有更新，请按当前版本重新准备。',operations_ai_prompt_no_change:'岗位工作要求与当前内容相同，无需保存。',operations_ai_delegation_version_changed:'总控管理范围已有更新，请按当前范围重新准备。',operations_ai_delegation_denied:'当前未获准执行这项总控管理动作。',operations_ai_delegation_target_denied:'这个岗位当前不在获准管理范围内。',operations_agentos_prompt_review_unavailable:'岗位工作要求的完整变更暂时无法取得，尚未执行。',
 operations_agentos_ai_use_denied:'当前未获准使用本领域 AI。',
 operations_agentos_not_configured:'运行服务尚未配置。',operations_agentos_model_not_configured:'模型尚未配置，请先保留问题。',operations_agentos_conversation_not_ready:'沟通服务尚未就绪，输入已保留。',
 operations_agentos_execution_inactive:'这个任务已暂停或结束。',operations_agentos_execution_changed:'任务状态已有变化，已读取当前记录。',
 operations_agentos_authority_changed:'任务授权已有变化，请按当前授权重新开始。',operations_agentos_scope_denied:'这次操作超出任务已选范围。',
 operations_agentos_scope_required:'请先在权限管理中确定助手可处理的对象。',operations_agentos_source_changed:'已用来源发生变化，请重新开始任务。',
 operations_agentos_human_review_required:'现有处置需要人工复核。',operations_agentos_result_unknown:'运行结果暂未确认，正在查询原请求。',
 operations_agentos_operation_conflict:'原请求内容不一致，请按当前记录继续。',operations_agentos_run_not_paused:'这次运行已不在等待确认。',
 operations_agentos_cancel_already_requested:'这次回复已有停止请求，正在读取原结果。',operations_agentos_conversation_transport_unavailable:'这次回复的实时连接暂不可用，仍会查询原结果。',operations_agentos_run_not_available:'这次回复的运行记录尚未取得，正在读取原结果。',
};
const nativeRunLabels:Record<string,string>={PENDING:'等待运行',RUNNING:'正在运行',COMPLETED:'已完成',PAUSED:'等待人工',CANCELLED:'已取消',ERROR:'运行失败',REGENERATED:'已重新生成'};
export const nativeRunLabel=(status:string)=>nativeRunLabels[status]??'状态未确认';
export function nativeConversationFailure(run:AgentOsNativeRun){
 const category=run.errorCode==='operations_agentos_model_request_failed'&&run.failure?.stage==='model-request'?run.failure.category:null;
 const messages:Record<string,{title:string;detail:string;retryable:boolean}>={
  timeout:{title:'模型请求超时',detail:'模型服务未在限定时间内返回完整答复。',retryable:true},
  'rate-limit':{title:'模型请求暂时受限',detail:'模型服务暂时限制了请求频率，请稍后再试。',retryable:true},
  connection:{title:'模型连接中断',detail:'这次未能连接模型服务。',retryable:true},
  'service-unavailable':{title:'模型服务暂时不可用',detail:'模型服务这次未能正常响应。',retryable:true},
  'context-limit':{title:'超出模型上下文限制',detail:'这次请求超过模型的上下文限制，需要调整提问或检查模型设置。',retryable:false},
  'request-rejected':{title:'模型请求被拒绝',detail:'模型服务拒绝了这次请求，需要检查模型设置或服务状态。',retryable:false},
 };
 const failure=category&&messages[category]?messages[category]:run.errorCode==='operations_agentos_authority_changed'
  ?{title:'回复因权限变化而中断',detail:'请按当前权限重新核对这次处理。',retryable:false}
  :run.errorCode==='operations_authorization_unavailable'
   ?{title:'当前权限暂时无法核对',detail:'这次回复已中断，读取恢复后可继续查看原记录。',retryable:false}
   :{title:'这次没有取得答复',detail:'模型服务未返回完整结果，具体原因尚未记录。',retryable:run.errorCode==='operations_agentos_model_request_failed'};
 const knownActivity=run.businessActivity?.basis==='same-owner-turn-tool-and-card-ledger'?run.businessActivity.state:'unknown';
 const processingNotice=knownActivity==='not-started'?'本轮没有发起业务处理。':knownActivity==='check-records'?'本轮已有处理记录，请先核对原结果，避免重复办理。':'本轮业务处理状态尚未确认，请以原记录为准。';
 const bound=typeof run.operationId==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(run.operationId)&&typeof run.runId==='string'&&!!run.runId;
 const canRetry=run.status==='ERROR'&&failure.retryable&&knownActivity==='not-started'&&bound&&typeof run.userInput==='string'&&!!run.userInput.trim()&&run.userInput.length<=12000;
 return{...failure,processingNotice,canRetry};
}
export function nativeConversationRetryMessage(conversation:(AgentOsConversation&{contextChanged?:boolean})|null|undefined,runId:string){
 if(!conversation?.capabilities.canSend||conversation.contextChanged)return null;
 const current=conversation.runs.find(run=>run.runId===runId);
 if(!current||!nativeConversationFailure(current).canRetry||typeof current.userInput!=='string')return null;
 return current.userInput;
}
export function nativeConversationFailureLabel(run:AgentOsNativeRun){const failure=nativeConversationFailure(run);return failure.title+'。'+failure.detail+failure.processingNotice;}
import {operationsAiUseAllowed} from '../../../../packages/galaxy-official/src/shared/operations-ai-use.mjs';

