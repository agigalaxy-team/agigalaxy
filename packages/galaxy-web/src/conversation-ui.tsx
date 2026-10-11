import React,{useEffect,useState} from 'react';
import { Bell, MessageCircle, UserRound } from 'lucide-react';
import type {createWebRuntime} from './runtime.mjs';
import {createProfileClient} from './profile-client.mjs';
import {profilePath} from './profile-navigation.mjs';
import './person-profile.css';

type MemberRuntime={
 api:Pick<Awaited<ReturnType<typeof createWebRuntime>>['api'],'endpoint'|'snapshot'|'call'>;
 status:()=>Promise<{identity?:{subjectId:string}|null}>;
 receiptStatus:{captureLease:()=>{assertCurrent:()=>void}};
};
export function useMemberNames(runtime:MemberRuntime|null,subjectId:string|undefined,connected:boolean,subjectIds:Array<string|undefined|null>){
  const idsKey=JSON.stringify([...new Set(subjectIds.filter((id):id is string=>typeof id==='string'&&/^GUID[0-9A-Z]{28}$/.test(id)))].sort());
  const connection=runtime?.api.snapshot(),connectionKey=JSON.stringify([connection?.bindingId,connection?.generation]);
  const scopeKey=JSON.stringify([subjectId,connected,connectionKey,idsKey]);
  const [result,setResult]=useState<{scopeKey:string;names:Record<string,string|null>}>({scopeKey,names:{}});
  useEffect(()=>{if(!runtime)return;const ids=JSON.parse(idsKey) as string[];if(!ids.length)return;const client=createProfileClient(runtime,{subjectId:subjectId??null,authenticated:connected});let active=true,reading=false;
    const read=async()=>{if(!active||reading||document.hidden)return;reading=true;try{const result:Record<string,string|null>={};for(let start=0;start<ids.length;start+=20){const batch=await client.displayNames(ids.slice(start,start+20));if(!active)return;for(const item of batch)result[item.subjectId]=item.displayName;}if(active)setResult({scopeKey,names:result});}catch{if(active)setResult({scopeKey,names:{}});}finally{reading=false;}};
    void read();const timer=window.setInterval(()=>void read(),60000),visible=()=>void read();document.addEventListener('visibilitychange',visible);return()=>{active=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);client.close();};
  },[runtime,subjectId,connected,connectionKey,idsKey,scopeKey]);
  return result.scopeKey===scopeKey?result.names:{};
}

export function memberName(subjectId?: string, ownId?: string, name?: string) {
  if (subjectId && subjectId === ownId) return '我';
  return name?.trim() || (subjectId ? `成员 ${subjectId.slice(-6)}` : '银河成员');
}

export function MemberAvatar({ subjectId, own = false }: { subjectId?: string; own?: boolean }) {
  const hue = Array.from(subjectId ?? '').reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  return <span className={'member-avatar' + (own ? ' is-own' : '')} style={{ '--member-hue': hue } as React.CSSProperties} aria-hidden="true"><UserRound size={19} /></span>;
}

export function MemberLink({subjectId,name,ownId,navigate,avatar=false}: {subjectId?:string;name?:string;ownId?:string;navigate:(path:string)=>void;avatar?:boolean}) {
  const destination=profilePath(subjectId),label=memberName(subjectId,ownId,name);
  const content=<>{avatar&&<MemberAvatar subjectId={subjectId} own={subjectId===ownId}/>}<span>{label}</span></>;
  return destination?<a className="member-profile-link" href={destination} aria-label={`查看${label}的资料`} onClick={event=>{
    if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();navigate(destination);
  }}>{content}</a>:<span className="member-profile-link">{content}</span>;
}

export function MessageNavigation({ active, navigate }: { active: 'rooms' | 'notifications'; navigate: (path: string) => void }) {
  return <nav className="message-navigation" aria-label="消息分类">
    {([['rooms', '对话', MessageCircle], ['notifications', '通知', Bell]] as const).map(([id, label, Icon]) => <a key={id} href={'/app/' + id} aria-current={active === id ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate('/app/' + id); }}><Icon size={17} />{label}</a>)}
  </nav>;
}

export function readableTime(value?: string | number) {
  if (!value) return '';
  const time = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  if (!Number.isFinite(time.getTime())) return '';
  const today = new Date(), sameDay = time.toDateString() === today.toDateString();
  return time.toLocaleString('zh-CN', sameDay ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
