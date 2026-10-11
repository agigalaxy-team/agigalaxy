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
  const scopeKey=JSON.stringify([runtime?.api.endpoint,subjectId,connected,connectionKey,idsKey]);
  const [result,setResult]=useState<{scopeKey:string;names:Record<string,string|null>}>({scopeKey,names:{}});
  useEffect(()=>{if(!runtime)return;const ids=JSON.parse(idsKey) as string[];if(!ids.length)return;
    const client=createProfileClient(runtime,{subjectId:subjectId??null,authenticated:connected});
    let active=true,sequence=0,reading:number|null=null,expiryTimer:number|undefined;
    let cached:Record<string,{name:string|null;expiresAt:number}>={};
    const publish=()=>{if(!active)return;if(expiryTimer!==undefined)window.clearTimeout(expiryTimer);
      const now=Date.now(),names:Record<string,string|null>={};let until=Infinity;
      for(const [id,item] of Object.entries(cached)){if(navigator.onLine===false||item.expiresAt<=now){delete cached[id];continue;}names[id]=item.name;until=Math.min(until,item.expiresAt);}
      setResult({scopeKey,names});if(Number.isFinite(until))expiryTimer=window.setTimeout(publish,Math.max(0,until-now));
    };
    const read=async()=>{if(!active||reading!==null||document.hidden||navigator.onLine===false)return;
      const token=++sequence,startedAt=Date.now();reading=token;
      try{const next:typeof cached={};for(let start=0;start<ids.length;start+=20){const batch=await client.displayNames(ids.slice(start,start+20));if(!active||sequence!==token)return;
        for(const item of batch){const until='readExpiresAt'in item?item.readExpiresAt:undefined,limit=until===undefined?startedAt+60000:Number.isFinite(until)?Math.min(startedAt+60000,until*1000):0;next[item.subjectId]={name:item.displayName,expiresAt:limit};}}
        if(active&&sequence===token){cached=next;publish();}
      }catch{if(active&&sequence===token){cached={};publish();}}finally{if(reading===token)reading=null;}
    };
    const visible=()=>{publish();void read();},offline=()=>{sequence++;reading=null;cached={};publish();};
    void read();const timer=window.setInterval(()=>void read(),45000);
    document.addEventListener('visibilitychange',visible);window.addEventListener('focus',visible);window.addEventListener('online',visible);window.addEventListener('offline',offline);
    return()=>{active=false;sequence++;window.clearInterval(timer);if(expiryTimer!==undefined)window.clearTimeout(expiryTimer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',visible);window.removeEventListener('online',visible);window.removeEventListener('offline',offline);client.close();};
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
