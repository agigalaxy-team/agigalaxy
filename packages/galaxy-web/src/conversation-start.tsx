import React,{useEffect,useId,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {MemberAvatar,memberName,useMemberNames} from './conversation-ui';
import {createConversationDirectory} from './conversation-directory';
import type {ChatRuntime} from './chat-workspace-types';

type InputValue={person:string;query:string;title:string};
const initial:InputValue={person:'',query:'',title:''};
export function ConversationStart({runtime,subjectId,busy,onStart,onClose}:{runtime:ChatRuntime;subjectId:string;busy:boolean;onStart:(input:{inviteeSubjectId?:string;title?:string})=>Promise<boolean>;onClose:()=>void}){
 const fieldId=useId(),key='galaxy-chat-start:'+JSON.stringify([runtime.api.endpoint,subjectId]);
 const searchInput=useRef<HTMLInputElement>(null);
 useEffect(()=>{searchInput.current?.focus();},[]);
 const [value,setValue]=useState<InputValue>(()=>{try{const saved=JSON.parse(sessionStorage.getItem(key)??'null');if(saved&&typeof saved.person==='string'&&typeof saved.query==='string'&&typeof saved.title==='string')return{person:saved.person,query:saved.query,title:saved.title};}catch{}return initial;});
 const directory=useMemo(()=>createConversationDirectory(runtime,subjectId),[runtime,subjectId]);
 const {people,cursors,loading,loaded,error}=useSyncExternalStore(directory.subscribe,directory.read,directory.read);
 useEffect(()=>{directory.start();void directory.loadInitial();return directory.close;},[directory]);
 const names=useMemberNames(runtime,subjectId,true,[...Object.keys(people),value.person]);
 const name=(id:string)=>memberName(id,subjectId,names[id]??undefined);
 function change(patch:Partial<InputValue>){const next={...value,...patch};setValue(next);try{sessionStorage.setItem(key,JSON.stringify(next));}catch{}}
 const peopleIds=Object.keys(people).filter(id=>id!==subjectId),shown=peopleIds.filter(id=>!value.query.trim()||name(id).toLocaleLowerCase().includes(value.query.trim().toLocaleLowerCase()));
 const valid=/^GUID[A-Z0-9]{28}$/.test(value.person)&&value.person!==subjectId;
 async function start(withPerson=true){if(busy||withPerson&&!valid)return;const completed=await onStart({...(withPerson?{inviteeSubjectId:value.person}:{}),...(value.title.trim()?{title:value.title.trim()}:{})});if(completed)try{sessionStorage.removeItem(key);}catch{}}
 return <form className="conversation-start" onSubmit={event=>{event.preventDefault();void start();}}>
  <h2>想和谁聊？</h2><label htmlFor={fieldId+'-query'}>查找联系人<Input ref={searchInput} id={fieldId+'-query'} disabled={busy} value={value.query} onChange={event=>change({query:event.target.value})} placeholder="按姓名查找"/></label>
  <div className="invite-person-list" role="radiogroup" aria-label="选择交流对象">{shown.map(id=><label className={'invite-person'+(value.person===id?' selected':'')} key={id}><input type="radio" name={fieldId+'-person'} checked={value.person===id} onChange={()=>change({person:id})} disabled={busy}/><MemberAvatar subjectId={id}/><span><strong>{name(id)}</strong><small>{people[id]}</small></span></label>)}</div>
  {loading&&<output>正在读取联系人…</output>}{loaded&&!loading&&!shown.length&&<p className="muted">{value.query?'已读取的联系人中没有这个姓名。':'还没有其他联系人。可以使用对方给你的银河 ID 发出邀请。'}</p>}
  {error&&<p className="message error">{error}<button className="text-link" type="button" disabled={loading} onClick={()=>void directory.loadInitial()}>重新读取</button></p>}
  <div className="invite-more">{cursors.contacts&&<button type="button" className="text-link" disabled={loading} onClick={()=>void directory.load('contacts',cursors.contacts!)}>更多联系人</button>}{cursors.rooms&&<button type="button" className="text-link" disabled={loading} onClick={()=>void directory.load('rooms',cursors.rooms!)}>更早对话中的人</button>}</div>
  <details className="invite-known-person" open={!!value.person&&!peopleIds.includes(value.person)}><summary>使用对方给我的银河 ID</summary><label htmlFor={fieldId+'-manual'}>对方的银河 ID<Input id={fieldId+'-manual'} maxLength={32} disabled={busy} value={peopleIds.includes(value.person)?'':value.person} onChange={event=>change({person:event.target.value.trim()})} placeholder="粘贴对方的完整银河 ID"/></label></details>
  {value.person&&<p className="invite-selection">{valid?<>邀请 <strong>{name(value.person)}</strong> 聊天</>:value.person===subjectId?'请选择想要交流的另一位成员。':'请输入对方完整的银河 ID。'}</p>}
  <label htmlFor={fieldId+'-title'}>话题名称 <span className="muted">可选</span><Input id={fieldId+'-title'} maxLength={120} disabled={busy} value={value.title} onChange={event=>change({title:event.target.value})} placeholder="也可以直接开始聊天"/></label>
  <p className="invite-impact">对方接受邀请后加入对话，可以阅读仍保留的消息。</p>
  <div className="button-row"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy||!valid}>{busy?'正在发出邀请…':'邀请并打开对话'}</Button></div>
  <button type="button" className="text-link" disabled={busy} onClick={()=>void start(false)}>先创建对话，稍后邀请</button>
 </form>;
}
