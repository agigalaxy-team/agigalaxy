import React,{useEffect,useState} from 'react';
import {MemberLink,memberName,useMemberNames} from './conversation-ui';
import type {ChatRuntime} from './chat-workspace-types';

export function chatMemberName(ref?:string,ownId?:string,name?:string){
 return ref?.startsWith('account:')&&!name?.trim()&&ref!==ownId?'银河账户':memberName(ref,ownId,name);
}

export function useChatMemberNames(runtime:ChatRuntime,owner:string,connected:boolean,refs:Array<string|undefined|null>){
 const legacy=useMemberNames(runtime,owner,connected,refs);
 const ids=JSON.stringify([...new Set(refs.filter((ref):ref is string=>typeof ref==='string'&&/^account:[0-9a-f-]{36}$/.test(ref)))].sort());
 const [value,setValue]=useState<{key:string;names:Record<string,string|null>}>({key:'',names:{}});
 const key=JSON.stringify([runtime.api.endpoint,owner,connected,ids]);
 useEffect(()=>{if(!connected)return;let active=true;const lease=runtime.receiptStatus.captureLease();
  const read=async()=>{const names:Record<string,string|null>={};try{const refs=JSON.parse(ids) as string[];
   for(let index=0;index<refs.length;index+=50){lease.assertCurrent();const page=await runtime.api.call('/v2/chat/accounts/query',{accountIds:refs.slice(index,index+50).map(ref=>ref.slice(8))});lease.assertCurrent();
    for(const item of page.items??[])if(typeof item.actorRef==='string')names[item.actorRef]=typeof item.displayName==='string'?item.displayName:null;}
   if(active)setValue({key,names});
  }catch{if(active)setValue({key,names:{}});}};
  void read();return()=>{active=false;};
 },[runtime,owner,connected,ids,key]);
 return {...legacy,...(value.key===key?value.names:{})};
}
export function ChatMemberLink({subjectId,name,ownId,navigate}:{subjectId?:string;name?:string;ownId?:string;navigate:(path:string)=>void}){
 if(!subjectId?.startsWith('account:'))return <MemberLink subjectId={subjectId} name={name} ownId={ownId} navigate={navigate}/>;
 const path='/app/accounts/'+subjectId.slice(8),label=subjectId===ownId?'我':name||'银河账户';
 return <a className="member-profile-link" href={path} onClick={event=>{if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(path);}}}>{label}</a>;
}
