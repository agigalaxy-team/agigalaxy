import React,{useCallback,useEffect,useEffectEvent,useMemo,useRef,useState} from 'react';
import type {z} from 'zod/v4';
import {Button} from '@/components/ui/button';
import {useAccountSessionModel,useOnlineAccountDraftMemory} from "../accounts/account-session-scope";
import {useAccountConnection} from "../accounts/account-center";
import {useReadTasks} from "../../shared/reading/use-read-task";
import {accountFollowRelationshipSchema,type accountFollowStatusSchema} from '../../../../galaxy-official/src/shared/account-follows-schema.mjs';
import {createAccountFollowsClient} from './client.mjs';
import './account-follows.css';

export type AccountFollowRelationship=z.infer<typeof accountFollowRelationshipSchema>;
type Status=z.infer<typeof accountFollowStatusSchema>;
export function accountFollowMessage(error:unknown){
 const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
 return ({account_follow_changed:'关注状态已更新，已重新读取。',account_follow_target_unavailable:'此账户的资料当前不可读取。',
  account_follow_response_invalid:'暂时无法读取关注结果。',account_follow_operation_conflict:'这次关注暂时无法继续，请重新读取。',
  account_follow_cursor_unavailable:'这页关注暂时无法读取，请返回开头。',account_follow_pending:'有关注正在保存，请稍后再试。',official_account_changed:'登录账户已变化，请重新打开。',
  official_account_session_expired:'登录已到期，请重新登录。',official_account_unavailable:'暂时无法连接，联网后继续读取。'} as Record<string,string>)[code]??'暂时无法读取关注，请稍后重试。';
}
export function useAccountFollows(endpoint?:string){
 const model=useAccountSessionModel(),memory=useOnlineAccountDraftMemory(),connection=useAccountConnection(endpoint,model),latest=useRef(model);latest.current=model;
 const source=model.client,ownerId=connection.session?.account.id,csrf=connection.session?.csrfToken;
 const lease=useMemo(()=>source&&ownerId&&csrf?{client:source,accountId:ownerId,csrfToken:csrf}:null,[source,ownerId,csrf]);
 const client=useMemo(()=>source&&lease?createAccountFollowsClient({client:source,lease,memory,getCurrent:()=>latest.current}):null,[source,lease,memory]);
 return {model,memory,lease,client,available:model.phase==='signed-in'};
}

export function AccountFollowControl({targetAccountId,endpoint,initialRelationship,initialCanFollow,showDirectoryLink=true,onChanged}:{targetAccountId:string;endpoint?:string;
 initialRelationship?:AccountFollowRelationship;initialCanFollow?:boolean;showDirectoryLink?:boolean;onChanged?:(following:boolean,returnFocus?:boolean)=>void}){
 const {model,client,available}=useAccountFollows(endpoint),[value,setValue]=useState<Status|null>(null),[busy,setBusy]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState('');
 const tasks=useReadTasks('account-follow-control:'+targetAccountId+':'+(client?.ownerId??'visitor')+':'+(model.session?.csrfToken??'')),
  working=useRef(false),button=useRef<HTMLButtonElement>(null),read=useRef<(()=>void)|null>(null),changed=useRef(onChanged);changed.current=onChanged;
 const ownerGeneration=useMemo(()=>({client,targetAccountId,available}),[client,targetAccountId,available]),latestGeneration=useRef(ownerGeneration);latestGeneration.current=ownerGeneration;
 const refreshAccount=useEffectEvent(()=>model.refresh());
 useEffect(()=>{
  let active=true,blocked=false,timer:ReturnType<typeof setTimeout>|undefined;
  working.current=false;setValue(null);setError('');setBusy(false);setPending(!!client?.pending(targetAccountId));
  const update=()=>{
   if(!active||!client||!available||working.current||blocked||document.hidden||navigator.onLine===false)return;
   working.current=true;
   void tasks.run({lane:'status',key:targetAccountId},async({signal})=>{
    const original=client.pending(targetAccountId),receipt=original?await client.recover(targetAccountId,{signal}):null;
    return {status:await client.status(targetAccountId,{signal}),recovered:receipt?.state==='acknowledged'};
   },{onSuccess:result=>{setValue(result.status);setPending(!!client.pending(targetAccountId));setError('');if(result.recovered)changed.current?.(result.status.relationship.following,false);},
    onError:problem=>{setValue(null);setPending(!!client.pending(targetAccountId));setError(accountFollowMessage(problem));
     const status=problem&&typeof problem==='object'&&'status'in problem?Number(problem.status):0;
     if(status===401||status===403){blocked=true;void refreshAccount();}
    },onSettled:()=>{working.current=false;if(active&&!blocked&&(!initialRelationship||client.pending(targetAccountId)))timer=setTimeout(update,client.pending(targetAccountId)?3000:30000);}});
  };
  read.current=()=>{blocked=false;if(timer)clearTimeout(timer);update();};
  if(client&&available&&client.ownerId!==targetAccountId){
   if(initialRelationship&&!client.pending(targetAccountId))setValue({accountId:client.ownerId,relationship:initialRelationship,canFollow:initialCanFollow===true,checkedAt:Math.floor(Date.now()/1000)});
   else update();
  }
  const online=()=>update();window.addEventListener('online',online);window.addEventListener('focus',online);
  return()=>{active=false;read.current=null;working.current=false;tasks.cancel();if(timer)clearTimeout(timer);window.removeEventListener('online',online);window.removeEventListener('focus',online);};
 },[client,targetAccountId,available,initialRelationship,initialCanFollow,tasks]);
 const change=useCallback(async()=>{
  if(!client||!available||working.current)return;const focused=document.activeElement===button.current,current=()=>latestGeneration.current===ownerGeneration;working.current=true;setBusy(true);setError('');tasks.cancel();
  try{
   if(client.pending(targetAccountId))await client.recover(targetAccountId);
   else await client.change(targetAccountId,!value?.relationship.following);
   client.current();const status=await client.status(targetAccountId);client.current();if(!current())return;setValue(status);setPending(!!client.pending(targetAccountId));
   if(!client.pending(targetAccountId))changed.current?.(status.relationship.following,focused&&document.activeElement===button.current);
  }catch(problem){if(!current())return;setError(accountFollowMessage(problem));
   if(client){try{client.current();setPending(!!client.pending(targetAccountId));}catch{/* A new owner must not receive the old result. */}}
  }finally{if(current()){working.current=false;setBusy(false);read.current?.();}}
 },[client,available,tasks,targetAccountId,value?.relationship.following,ownerGeneration]);
 if(model.phase==='signed-out')return model.client?<a className="text-link" href={model.client.loginUrl('login',location.pathname+location.search+location.hash)}>登录后关注</a>:null;
 if(client?.ownerId===targetAccountId)return null;
 if(!available)return <span className="account-follow-message">{model.phase==='offline'?'离线时无法更改关注。':model.phase==='unavailable'?'暂时无法连接账户。':'正在读取账户状态…'}</span>;
 return <div className="account-follow-control">
  <Button ref={button} type="button" focusableWhenDisabled variant={value?.relationship.following?'outline':'default'} aria-pressed={value?.relationship.following??false}
   disabled={busy||pending||!value||!value.canFollow&&!value.relationship.following} onClick={()=>void change()}>
   {busy?'正在保存…':value?.relationship.following?'取消关注':'关注'}
  </Button>
  {pending&&<output className="account-follow-message">{client?.pending(targetAccountId)?.command.following===false?'正在取消关注…':'正在保存关注…'}</output>}
  {showDirectoryLink&&value&&<a className="text-link" href="/app/account?section=following">我的关注</a>}
  {error&&<output className="account-follow-message" >{error} <button type="button" className="text-link" disabled={busy} onClick={()=>read.current?.()}>重试读取</button></output>}
  {value&&!value.canFollow&&!value.relationship.following&&!error&&<span className="account-follow-message">此账户当前无法关注。</span>}
 </div>;
}
