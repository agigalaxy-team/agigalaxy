import React,{useEffect,useState} from 'react';
import {GalaxyMark} from './galaxy-mark';
import './interaction-feedback.css';

type LoadingProps={active?:boolean;label?:string;scopeKey?:string;detail?:string;className?:string;delayMs?:number;slowAfterMs?:number};

/** Presentation only: the caller owns the request, content and permission state. */
export function LoadingFeedback({active=true,label='正在读取…',scopeKey='',detail='比平时稍久，正在继续读取。',className='',delayMs=160,slowAfterMs=8000}:LoadingProps){
  const key=JSON.stringify([scopeKey,label,delayMs,slowAfterMs]);
  const [state,setState]=useState({key,visible:active&&delayMs===0,slow:false});
  useEffect(()=>{
    if(!active){setState({key,visible:false,slow:false});return;}
    setState({key,visible:delayMs===0,slow:false});
    const appear=window.setTimeout(()=>setState({key,visible:true,slow:false}),Math.max(0,delayMs));
    const slow=window.setTimeout(()=>setState({key,visible:true,slow:true}),Math.max(delayMs,slowAfterMs));
    return()=>{window.clearTimeout(appear);window.clearTimeout(slow);};
  },[active,key,delayMs,slowAfterMs]);
  if(!active||state.key!==key||!state.visible)return null;
  return <div className={'interaction-loading '+className} role="status" aria-live="polite" aria-atomic="true" data-waiting={state.slow?'slow':'pending'}><GalaxyMark/><div><span>{label}</span>{state.slow&&detail&&<small>{detail}</small>}</div></div>;
}

type FailureProps={message?:string|null;onRetry?:()=>void|Promise<unknown>;retrying?:boolean;retryLabel?:string;className?:string};
export function ReadFailure({message,onRetry,retrying=false,retryLabel='重新读取',className=''}:FailureProps){
  if(!message)return null;
  return <div className={'interaction-read-failure '+className} role="alert"><p>{message}</p>{onRetry&&<button type="button" className="text-link" disabled={retrying} onClick={()=>void onRetry()}>{retrying?'正在重试…':retryLabel}</button>}</div>;
}

export function PageLoading({label='正在读取当前资料…',scopeKey}:{label?:string;scopeKey?:string}){
  return <div className="page-loading interaction-page-loading"><LoadingFeedback label={label} scopeKey={scopeKey}/><div className="interaction-placeholders" aria-hidden="true"><span/><span/><span/></div></div>;
}

