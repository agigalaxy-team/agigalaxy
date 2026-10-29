import {chatParticipantRefSchema} from "../../../../galaxy-contracts/src/chat-schema.mjs";
import {ReadingDetails,ReadingSummary} from "../../shared/reading/reading-details";
import React,{useEffect,useId,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {MemberAvatar,useMemberNames} from "../../shared/people/conversation-ui";
import {chatMemberName as memberName} from './chat-member-ui';
import {createConversationDirectory} from './conversation-directory';
import type {ChatRuntime} from './chat-workspace-types';

type InputValue={person:string;query:string;title:string};
const initial:InputValue={person:'',query:'',title:''};
export function ConversationStart({runtime,subjectId,busy,blocked=false,onStart,onClose}:{runtime:ChatRuntime;subjectId:string;busy:boolean;blocked?:boolean;onStart:(input:{inviteeSubjectId?:string;title?:string})=>Promise<boolean>;onClose:()=>void}){
 const locked=busy||blocked;
 const fieldId=useId(),key='galaxy-chat-start:'+JSON.stringify([runtime.api.endpoint,subjectId]);
 const searchInput=useRef<HTMLInputElement>(null),accountMode=subjectId.startsWith('account:'),knownAccount=new URLSearchParams(location.search).get('account');
 useEffect(()=>{searchInput.current?.focus();},[]);
 const [value,setValue]=useState<InputValue>(()=>{try{const saved=JSON.parse(sessionStorage.getItem(key)??'null');if(saved&&typeof saved.person==='string'&&typeof saved.query==='string'&&typeof saved.title==='string')return{person:saved.person,query:saved.query,title:saved.title};}catch{}return accountMode&&knownAccount&&/^[0-9a-f-]{36}$/.test(knownAccount)?{...initial,person:'account:'+knownAccount}:initial;});
 const directory=useMemo(()=>createConversationDirectory(runtime,subjectId),[runtime,subjectId]);
 const {people,names:accountNames,profiles,cursors,loading,loaded,error}=useSyncExternalStore(directory.subscribe,directory.read,directory.read);
 useEffect(()=>{directory.start();void directory.loadInitial().then(()=>{if(knownAccount)void directory.knownAccount(knownAccount);});return directory.close;},[directory,knownAccount]);
 const names=useMemberNames(runtime,subjectId,true,[...Object.keys(people),value.person]);
 const name=(id:string)=>memberName(id,subjectId,accountNames[id]??names[id]??undefined);
 useEffect(()=>{if(!accountMode)return;const timer=window.setTimeout(()=>void directory.search(value.query),200);return()=>window.clearTimeout(timer);},[accountMode,directory,value.query]);
 function change(patch:Partial<InputValue>){const next={...value,...patch};setValue(next);try{sessionStorage.setItem(key,JSON.stringify(next));}catch{}}
 const peopleIds=Object.keys(people).filter(id=>id!==subjectId),shown=peopleIds.filter(id=>!value.query.trim()||name(id).toLocaleLowerCase().includes(value.query.trim().toLocaleLowerCase()));
 const valid=chatParticipantRefSchema.safeParse(value.person).success&&value.person!==subjectId;
 async function start(withPerson=true){if(locked||withPerson&&!valid)return;const completed=await onStart({...(withPerson?{inviteeSubjectId:value.person}:{}),...(value.title.trim()?{title:value.title.trim()}:{})});if(completed)try{sessionStorage.removeItem(key);}catch{}}
 return <form className="conversation-start" onSubmit={event=>{event.preventDefault();void start();}}>
  <h2>想和谁聊？</h2><label htmlFor={fieldId+'-query'}>查找联系人<Input ref={searchInput} id={fieldId+'-query'} disabled={locked} value={value.query} maxLength={120} onChange={event=>change({query:event.target.value})} placeholder="按姓名查找"/></label>
  <div className="invite-person-list" role="radiogroup" aria-label="选择交流对象">{shown.map(id=><label className={'invite-person'+(value.person===id?' selected':'')} key={id}><input type="radio" name={fieldId+'-person'} checked={value.person===id} onChange={()=>change({person:id})} disabled={locked}/><MemberAvatar subjectId={id} profile={profiles[id]}/><span><strong>{name(id)}</strong><small>{people[id]}</small></span></label>)}</div>
  {loading&&<output>正在读取联系人…</output>}{loaded&&!loading&&!shown.length&&<p className="muted">{value.query?'已读取的联系人中没有这个姓名。':accountMode?'没有找到可查询的账户，也可以从帖子作者或账户资料发起对话。':'还没有其他联系人。可以使用对方给你的银河 ID 发出邀请。'}</p>}
  {error&&<p className="message error">{error}<button className="text-link" type="button" disabled={loading} onClick={()=>void directory.loadInitial()}>重新读取</button></p>}
  <div className="invite-more">{cursors.contacts&&<button type="button" className="text-link" disabled={loading} onClick={()=>void directory.load('contacts',cursors.contacts!)}>更多联系人</button>}{cursors.rooms&&<button type="button" className="text-link" disabled={loading} onClick={()=>void directory.load('rooms',cursors.rooms!)}>更早对话中的人</button>}</div>
  {!accountMode&&<ReadingDetails className="invite-known-person" mode="inline"><ReadingSummary>使用对方给我的银河 ID</ReadingSummary><label htmlFor={fieldId+'-manual'}>对方的银河 ID<Input id={fieldId+'-manual'} maxLength={32} disabled={locked} value={peopleIds.includes(value.person)?'':value.person} onChange={event=>change({person:event.target.value.trim()})} placeholder="粘贴对方的完整银河 ID"/></label></ReadingDetails>}
  {value.person&&<p className="invite-selection">{valid?<>邀请 <strong>{name(value.person)}</strong> 聊天</>:value.person===subjectId?'请选择想要交流的另一位成员。':accountMode?'请选择想要交流的账户。':'请输入对方完整的银河 ID。'}</p>}
  <label htmlFor={fieldId+'-title'}>话题名称 <span className="muted">可选</span><Input id={fieldId+'-title'} maxLength={120} disabled={locked} value={value.title} onChange={event=>change({title:event.target.value})} placeholder="也可以直接开始聊天"/></label>
  <p className="invite-impact">对方接受邀请后加入对话，可以阅读仍保留的消息。</p>
  <div className="button-row"><Button type="button" variant="ghost" disabled={locked} onClick={onClose}>取消</Button><Button type="submit" disabled={locked||!valid}>{busy?'正在处理…':'邀请并打开对话'}</Button></div>
  <button type="button" className="text-link" disabled={locked} onClick={()=>void start(false)}>先创建对话，稍后邀请</button>
 </form>;
}
