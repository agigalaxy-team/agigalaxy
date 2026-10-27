import {SelectionRail} from '../navigation/SelectionRail';
import React,{createContext,useContext,useEffect,useState} from 'react';
import { Bell, MessageCircle, UserRound } from 'lucide-react';
import type {createWebRuntime} from "../../runtime.mjs";
import {createProfileClient} from "../../features/profiles/profile-client.mjs";
import {profilePath} from "../../features/profiles/profile-navigation.mjs";
import "../../features/profiles/person-profile.css";
import './conversation-visuals.css';
import {AccountProfileAvatar} from "../../features/accounts/account-profile-avatar";

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

export type MemberAvatarProfile={accountId:string;avatarKey:string|null;subjectType:'person'|'organization'|'agent'|null};
const MemberAvatarProfiles=createContext<Record<string,MemberAvatarProfile>>({});
export function MemberAvatarProvider({profiles,children}:{profiles:Record<string,MemberAvatarProfile>;children:React.ReactNode}){
 return <MemberAvatarProfiles.Provider value={profiles}>{children}</MemberAvatarProfiles.Provider>;
}
export function MemberAvatar({subjectId,own=false,name,profile}:{subjectId?:string;own?:boolean;name?:string;profile?:MemberAvatarProfile}){
 const profiles=useContext(MemberAvatarProfiles),account=/^account:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(subjectId??'');
 if(account){const current=profile??profiles['account:'+account[1]],available=current?.accountId===account[1]?current:null;
  return <AccountProfileAvatar seed={account[1]} avatarKey={available?.avatarKey} subjectType={available?.subjectType} className={'member-avatar'+(own?' is-own':'')}/>;
 }
 const hue=Array.from(subjectId??'').reduce((sum,char)=>sum+char.charCodeAt(0),0)%360;
 const initial=name?.trim()&&!/^(我|成员 |银河成员)/.test(name.trim())?Array.from(name.trim())[0]:null;
 return <span className={'member-avatar'+(own?' is-own':'')} style={{'--member-hue':hue} as React.CSSProperties} aria-hidden="true">{initial?<span className="member-initial">{initial}</span>:<UserRound size={19}/>}</span>;
}

export function MemberLink({subjectId,name,ownId,navigate,avatar=false}: {subjectId?:string;name?:string;ownId?:string;navigate:(path:string)=>void;avatar?:boolean}) {
  const destination=profilePath(subjectId),label=memberName(subjectId,ownId,name);
  const content=<>{avatar&&<MemberAvatar subjectId={subjectId} own={subjectId===ownId} name={name}/>}<span>{label}</span></>;
  return destination?<a className="member-profile-link" href={destination} aria-label={`查看${label}的资料`} onClick={event=>{
    if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();navigate(destination);
  }}>{content}</a>:<span className="member-profile-link">{content}</span>;
}

export function MessageNavigation({ active, navigate }: { active: 'rooms' | 'notifications'; navigate: (path: string) => void }) {
  return <SelectionRail active={active} className="message-navigation" aria-label="消息分类">
    <a href="/app/community?section=notifications" onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate('/app/community?section=notifications');}}}><MessageCircle size={17}/>社区回复</a>
    {([['rooms', '对话', MessageCircle], ['notifications', '通知', Bell]] as const).map(([id, label, Icon]) => <a key={id} href={'/app/' + id} aria-current={active === id ? 'page' : undefined} onClick={event => { if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return; event.preventDefault(); navigate('/app/' + id); }}><Icon size={17} />{label}</a>)}
  </SelectionRail>;
}

export function readableTime(value?: string | number) {
  if (!value) return '';
  const time = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  if (!Number.isFinite(time.getTime())) return '';
  const today = new Date(), sameDay = time.toDateString() === today.toDateString();
  return time.toLocaleString('zh-CN', sameDay ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
