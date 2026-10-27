'use client';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Brand} from './Brand';
import './operator-entry.css';

export function OperatorLoginNavigation({target,reason}:{target:string;reason:string|null}){
 const router=useRouter(),[attempt,setAttempt]=useState(0),[state,setState]=useState<'checking'|'unknown'|'signed-in'>('checking');
 useEffect(()=>{
  if(reason)return;
  const controller=new AbortController();let active=true;setState('checking');
  void(async()=>{try{
   const response=await fetch('/v1/operations/session',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});
   if(!response.ok)throw Error('session_unknown');const value=await response.json();if(!active)return;
   if(value.state==='signed-out'){window.location.replace(target);return;}
   if(value.state!=='signed-in')throw Error('session_unknown');
   // A live portal session is not repaired by another SSO round trip. Retry the
   // current server projection only after the person explicitly requests it.
   setState('signed-in');if(attempt>0)router.refresh();
  }catch{if(active&&!controller.signal.aborted)setState('unknown');}})();
  return()=>{active=false;controller.abort();};
 },[target,reason,attempt,router]);
 const checking=!reason&&state==='checking';
 return <main className="galaxy-operator-login galaxy-operator-entry"><div className="galaxy-operator-entry-card"><Brand/>{checking&&<i className="galaxy-entry-spinner" aria-hidden="true"/>}<h1>{checking?'正在打开管理登录':reason?'登录未完成':'暂时无法打开管理登录'}</h1><p role="status">{checking?'正在前往管理账户验证。':reason==='stale'?'这次登录请求已失效，请重新开始。':reason?'管理登录未完成，请重新登录或联系根管理员核对账户状态。':state==='unknown'?'暂时无法确认管理登录，请重新核对。':'管理会话仍有效，后台身份暂未完成核验。'}</p>{reason?<a href={target} className="galaxy-primary-action">重新登录</a>:!checking&&<button type="button" className="galaxy-primary-action" onClick={()=>setAttempt(value=>value+1)}>重新核对登录</button>}<small>AGI GALAXY · OPERATIONS</small></div></main>;
}
