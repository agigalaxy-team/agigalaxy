import React,{useEffect,useState} from 'react';
import {MemberLink,memberName,useMemberNames,type MemberAvatarProfile} from "../../shared/people/conversation-ui";
import {accountAvatarKey} from "../../../../galaxy-official/src/shared/account-profile-presentation.mjs";
import type {ChatRuntime} from './chat-workspace-types';

export function chatMemberName(ref?:string,ownId?:string,name?:string){
 return ref?.startsWith('account:')&&!name?.trim()&&ref!==ownId?'银河账户':memberName(ref,ownId,name);
}
const accountRef=/^account:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const type=(value:unknown):MemberAvatarProfile['subjectType']=>value==='person'||value==='organization'||value==='agent'?value:null;

export function useChatMembers(runtime:ChatRuntime,owner:string,connected:boolean,refs:Array<string|undefined|null>){
 const legacy=useMemberNames(runtime,owner,connected,refs);
 const ids=JSON.stringify([...new Set(refs.filter((ref):ref is string=>typeof ref==='string'&&accountRef.test(ref)))].sort());
 const connection=runtime.api.snapshot(),key=JSON.stringify([runtime.api.endpoint,owner,connected,connection?.bindingId,connection?.generation,ids]);
 const [value,setValue]=useState<{key:string;names:Record<string,string|null>;profiles:Record<string,MemberAvatarProfile>}>({key:'',names:{},profiles:{}});
 useEffect(()=>{if(!connected)return;let active=true;
  const read=async()=>{const names:Record<string,string|null>={},profiles:Record<string,MemberAvatarProfile>={};try{
   const lease=runtime.receiptStatus.captureLease(),refs=JSON.parse(ids) as string[];
   for(let index=0;index<refs.length;index+=50){lease.assertCurrent();const page=await runtime.api.call('/v2/chat/accounts/query',{accountIds:refs.slice(index,index+50).map(ref=>ref.slice(8))});lease.assertCurrent();
    for(const item of page.items??[])if(typeof item.accountId==='string'&&item.actorRef==='account:'+item.accountId&&refs.includes(item.actorRef)){
     names[item.actorRef]=typeof item.displayName==='string'?item.displayName:null;
     profiles[item.actorRef]={accountId:item.accountId,avatarKey:accountAvatarKey(item.avatarKey),subjectType:type(item.subjectType)};
    }}
   if(active)setValue({key,names,profiles});
  }catch{if(active)setValue({key,names:{},profiles:{}});}};
  void read();return()=>{active=false;};
 },[runtime,owner,connected,ids,key]);
 return {names:{...legacy,...(value.key===key?value.names:{})},profiles:value.key===key?value.profiles:{}};
}
export function useChatMemberNames(runtime:ChatRuntime,owner:string,connected:boolean,refs:Array<string|undefined|null>){
 return useChatMembers(runtime,owner,connected,refs).names;
}
export function ChatMemberLink({subjectId,name,ownId,navigate}:{subjectId?:string;name?:string;ownId?:string;navigate:(path:string)=>void}){
 if(!subjectId?.startsWith('account:'))return <MemberLink subjectId={subjectId} name={name} ownId={ownId} navigate={navigate}/>;
 const path='/app/accounts/'+subjectId.slice(8),label=subjectId===ownId?'我':name||'银河账户';
 return <a className="member-profile-link" href={path} onClick={event=>{if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(path);}}}>{label}</a>;
}

