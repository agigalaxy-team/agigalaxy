'use client';

export class OperationsRequestError extends Error{
  constructor(readonly status:number,readonly code:string){super(code);this.name='OperationsRequestError';}
}
export async function operationsRequest<T>(path:string,{signal,csrfToken,body}:{signal?:AbortSignal;csrfToken?:string;body?:Record<string,unknown>}={}):Promise<T>{
  const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',headers:body?{'Content-Type':'application/json','X-Galaxy-Operator-CSRF':csrfToken??''}:undefined,body:body?JSON.stringify(body):undefined,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
  if(!response.ok){
    const value=await response.json().catch(()=>null),code=typeof value?.error==='string'?value.error:typeof value?.error?.code==='string'?value.error.code:'operations_unavailable';
    throw new OperationsRequestError(response.status,code);
  }
  return response.json() as Promise<T>;
}
export function operationsFailure(error:unknown,fallback:string){
  if(!(error instanceof OperationsRequestError))return fallback;
  if(error.status===401)return '管理登录已到期，请重新登录。';
  if(error.status===403)return '当前登录没有这项操作权限，请重新登录或联系管理员。';
  const messages:Record<string,string>={operations_job_not_found:'这条任务记录已不存在。',operations_job_not_failed:'任务状态已变化，请读取当前状态。',operations_queue_unknown:'任务队列不存在，请返回列表。',search_job_not_found:'这条检索任务已不存在。',search_recovery_conflict:'来源或任务状态已变化，请读取当前记录。',search_index_disabled:'检索索引当前未启用，不能重新安排任务。',invalid_search_recovery:'检索任务参数无效，请重新读取记录。'};
  return messages[error.code]??fallback;
}
