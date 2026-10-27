'use client';
import Link from 'next/link';
import {LoadingFeedback,ReadFailure} from '../../../../packages/galaxy-web/src/shared/feedback/interaction-feedback';

export function CommandFeedback({command}:{command:{busy:boolean;pending:unknown;error:string;message:string;online?:boolean;retry:()=>Promise<unknown>}}){
  if(command.pending)return <p className="galaxy-operation-progress" role="status">{command.online===false?'网络已断开，连接恢复后会继续。':command.error||'正在处理…'}</p>;
  return <>{command.error?<p className="galaxy-error" role="alert">{command.error}</p>:command.message?<output role="status">{command.message}</output>:command.busy?<p role="status">正在处理…</p>:null}</>;
}
export function ReadStatus({loading,error,retry,empty}:{loading:boolean;error:string;retry:()=>Promise<unknown>;empty?:boolean}){
  return <><LoadingFeedback active={loading} label="正在读取…" className="galaxy-admin-read-status"/><ReadFailure message={error} onRetry={retry} retrying={loading}/>{!loading&&!error&&empty&&<p>暂无记录。</p>}</>;
}
export function AccountReference({id,label}:{id:string;label?:string|null}){
  return <Link href={'/admin/operations/users?account='+encodeURIComponent(id)} prefetch={false}>{label||'查看账户'}</Link>;
}
