'use client';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';

export function OperatorLoginNavigation({target,automatic}:{target:string;automatic:boolean}){
 const router=useRouter(),[attempt,setAttempt]=useState(0),[state,setState]=useState<'checking'|'unknown'|'signed-in'>('checking');
 useEffect(()=>{
  if(!automatic)return;
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
 },[target,automatic,attempt,router]);
 if(!automatic||state==='checking')return null;
 return <output>{state==='unknown'?'暂时无法确认管理登录，请重新核对。':'管理会话仍有效，后台身份暂未完成核验。'}<button type="button" onClick={()=>setAttempt(value=>value+1)}>重新核对登录</button></output>;
}
