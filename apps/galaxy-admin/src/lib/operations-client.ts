'use client';
import {operationsReadSignal} from './operations-read-lifecycle';

export class OperationsRequestError extends Error{
  constructor(readonly status:number,readonly code:string,readonly conversationBusy?:{operationId:string;blockingOperationId:string;conversationId:string;admitted:false}){super(code);this.name='OperationsRequestError';}
}
// GET recovery only. These classes identify transport/temporary availability,
// not a business rejection. 429 requires a separate Retry-After contract.
export function operationsMayRetryRead(error:unknown):boolean{
  if(error instanceof OperationsRequestError)return error.status===408||error.status>=500&&error.status<600;
  return error instanceof TypeError||error instanceof Error&&error.name==='TimeoutError';
}
export async function operationsRequest<T>(path:string,{signal,csrfToken,body}:{signal?:AbortSignal;csrfToken?:string;body?:Record<string,unknown>}={}):Promise<T>{
  const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000);
  const guardedSignal=body?requestSignal:AbortSignal.any([requestSignal,operationsReadSignal()]);
  if(!body)guardedSignal.throwIfAborted();
  const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',headers:body?{'Content-Type':'application/json','X-Galaxy-Operator-CSRF':csrfToken??''}:undefined,body:body?JSON.stringify(body):undefined,signal:guardedSignal});
  if(!response.ok){
    const value=await response.json().catch(()=>null),code=typeof value?.error==='string'?value.error:typeof value?.error?.code==='string'?value.error.code:'operations_unavailable';
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const busy=response.status===409&&code==='operations_agentos_conversation_busy'&&value?.admitted===false&&typeof value.operationId==='string'&&uuid.test(value.operationId)&&typeof value.blockingOperationId==='string'&&uuid.test(value.blockingOperationId)&&typeof value.conversationId==='string'&&uuid.test(value.conversationId)?{operationId:value.operationId,blockingOperationId:value.blockingOperationId,conversationId:value.conversationId,admitted:false as const}:undefined;
    throw new OperationsRequestError(response.status,code,busy);
  }
  const value=await response.json(),cursor=response.headers.get('X-Galaxy-Event-Cursor');
  return !body&&cursor&&/^[0-9]{1,20}$/.test(cursor)&&value&&typeof value==='object'&&!Array.isArray(value)?{...value,webEventCursor:cursor} as T:value as T;
}
export function operationsFailure(error:unknown,fallback:string){
  if(!(error instanceof OperationsRequestError))return fallback;
  if(error.status===401)return '管理登录已到期，请重新登录。';
  if(error.status===403){
    const messages:Record<string,string>={operations_permission_denied:'当前身份没有这项操作权限。',operations_csrf_invalid:'本次请求的来源未通过校验。',operations_access_denied:'本次请求未通过安全核验。',operations_request_denied:'本次请求未获准。',business_admin_denied:'当前管理身份未通过核验。'};
    return Object.hasOwn(messages,error.code)?messages[error.code]:'本次操作未获准。';
  }
  const messages:Record<string,string>={audit_snapshot_expired:'这次记录范围已到期，请刷新记录。',audit_snapshot_mismatch:'筛选条件与这次记录范围不一致，请刷新记录。',audit_snapshot_unavailable:'这次记录范围已不可读取，请刷新记录。',operations_job_not_found:'这条任务记录已不存在。',operations_job_not_failed:'任务状态已变化，请读取当前状态。',operations_queue_unknown:'任务队列不存在，请返回列表。',search_job_not_found:'这条检索任务已不存在。',search_recovery_conflict:'来源或任务状态已变化，请读取当前记录。',search_index_disabled:'检索索引当前未启用，不能重新安排任务。',invalid_search_recovery:'检索任务参数无效，请重新读取记录。'};
  return Object.hasOwn(messages,error.code)?messages[error.code]:fallback;
}
