import { ReadingDetails, ReadingSummary } from "../../shared/reading/reading-details";
import React,{useCallback,useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {capsuleRefKey} from './capsule-workspace-client.mjs';
import {MemberAvatar,memberName,useMemberNames,readableTime} from "../../shared/people/conversation-ui";
import {useChoiceViewLease,type ChoiceViewLease} from "../../shared/operations/choice-retained-operations";
import type {CapsuleAuthorRuntime,CapsuleSourceItem,CapsuleSourceRef} from './capsule-authoring-types';
import './capsule-source-reading.css';

type Props={runtime:CapsuleAuthorRuntime;subjectId:string;busy:boolean;selected:CapsuleSourceItem[];onChange:(items:CapsuleSourceItem[])=>void;onlyOwn?:boolean};
type Room={roomId:string;title:string};
type Message={messageId:string;revision:number;subjectId:string;text:string|null;sharedSummaryId:string|null;sentAt?:string;createdAt?:string};
type MessagePage={messages:Message[];next:string|null};
type LeasedProps=Props&{lease:ChoiceViewLease};

// Selection retains exact references, never a room-wide publication permission.
export function CapsuleMessagePicker(props:Props){
 const view=useChoiceViewLease(props.runtime,props.subjectId);
 return view.lease?<CapsuleMessageChoices key={view.key} {...props} lease={view.lease}/>:null;
}
function CapsuleMessageChoices({runtime,subjectId,busy,selected,onChange,onlyOwn=false,lease}:LeasedProps){
 const [open,setOpen]=useState(false),[rooms,setRooms]=useState<Room[]>([]),[roomNext,setRoomNext]=useState<string|null>(null),[roomId,setRoomId]=useState(''),[roomsLoaded,setRoomsLoaded]=useState(false),[readingRooms,setReadingRooms]=useState(false),[roomError,setRoomError]=useState('');
 const roomRead=useRef(0),roomSelectId=useId();
 const current=useCallback((token:number)=>{if(token!==roomRead.current)return false;try{lease.assertCurrent();return true;}catch{return false;}},[lease]);
 const readRooms=useCallback(async(after?:string)=>{
  const token=++roomRead.current;if(!current(token))return;setReadingRooms(true);setRoomError('');
  try{const value:{rooms:Room[];next:string|null}=await runtime.api.call('/v2/chat/rooms/query',{limit:30,...(after?{after}:{})});if(!current(token))return;setRooms(old=>after?[...new Map([...old,...value.rooms].map(room=>[room.roomId,room])).values()]:value.rooms);setRoomNext(value.next);setRoomsLoaded(true);}
  catch{if(current(token)){setRooms([]);setRoomNext(null);setRoomsLoaded(false);setRoomError('对话暂时无法读取，已选片段仍保留。');}}
  finally{if(current(token))setReadingRooms(false);}
 },[runtime,current]);
 useEffect(()=>{const request=roomRead;return()=>{request.current++;};},[]);
 useEffect(()=>{if(!open||roomsLoaded||readingRooms||roomError)return;const timer=window.setTimeout(()=>void readRooms(),0);return()=>window.clearTimeout(timer);},[open,roomsLoaded,readingRooms,roomError,readRooms]);
 const chosen=selected.filter(item=>item.ref.kind==='selected-message');
 return <ReadingDetails mode="inline" className="capsule-message-picker" onOpenChange={isOpen=>setOpen(isOpen)}>
  <ReadingSummary>{onlyOwn?'选择我的交流内容':'加入对话片段'}{chosen.length>0?' · 已选 '+chosen.length+' 条':''}</ReadingSummary>
  <p className="source-reading-note">{onlyOwn?'选择你写下的原话，保留准确消息版本。':'选择要引用的原话。他人的文字仍需原作者许可。'}</p>
  {roomError&&<p className="message error" role="alert">{roomError}<Button type="button" variant="ghost" disabled={busy||readingRooms} onClick={()=>void readRooms()}>重新读取对话</Button></p>}
  {readingRooms&&!roomsLoaded&&<p><output>正在读取你的对话…</output></p>}
  {roomsLoaded&&!rooms.length&&!roomError&&<p className="source-reading-note">当前没有可选对话。</p>}
  {rooms.length>0&&<label className="message-room-choice" htmlFor={roomSelectId}>选择对话<select id={roomSelectId} value={roomId} disabled={busy} onChange={event=>setRoomId(event.target.value)}><option value="">选择一段对话</option>{rooms.map(room=><option key={room.roomId} value={room.roomId}>{room.title}</option>)}</select></label>}
  {roomNext&&<Button type="button" variant="ghost" disabled={busy||readingRooms} onClick={()=>void readRooms(roomNext)}>更多对话</Button>}
  {open&&roomId&&<CapsuleRoomMessages key={roomId} {...{runtime,subjectId,busy,selected,onChange,onlyOwn,lease,roomId}} roomTitle={rooms.find(room=>room.roomId===roomId)?.title??'所选对话'}/>}
  {chosen.length>0&&<ReadingDetails className="source-reference-details"><ReadingSummary>查看已选片段</ReadingSummary><p>已选内容会在保存前按当前权限核对。无法读取的文字不在这里保留副本。</p>{chosen.map(item=><div className="selected-source-reference" key={capsuleRefKey(item.ref)}><span>{item.label}<small>第 {item.ref.version} 版 · {item.ref.id}</small></span><Button type="button" variant="ghost" disabled={busy} onClick={()=>onChange(selected.filter(other=>capsuleRefKey(other.ref)!==capsuleRefKey(item.ref)))}>移除</Button></div>)}</ReadingDetails>}
 </ReadingDetails>;
}
function CapsuleRoomMessages({runtime,subjectId,busy,selected,onChange,onlyOwn,lease,roomId,roomTitle}:LeasedProps&{roomId:string;roomTitle:string}){
 const [messages,setMessages]=useState<Message[]>([]),[next,setNext]=useState<string|null>(null),[loaded,setLoaded]=useState(false),[readingMessages,setReadingMessages]=useState(false),[messageError,setMessageError]=useState('');
 const messageRead=useRef(0),messagePages=useRef(1),reading=useRef(0),nextPage=useRef(next),checkboxPrefix=useId();
 useLayoutEffect(()=>{nextPage.current=next;},[next]);
 const people=useMemberNames(runtime,subjectId,true,messages.map(message=>message.subjectId));
 const current=useCallback((token:number)=>{if(token!==messageRead.current)return false;try{lease.assertCurrent();return true;}catch{return false;}},[lease]);
 const readMessages=useCallback(async(more=false)=>{
  if(reading.current)return;
  const token=++messageRead.current;if(!current(token))return;reading.current=token;setReadingMessages(true);setMessageError('');
  try{
   if(more){const after=nextPage.current;if(!after)return;const page:MessagePage=await runtime.api.call('/v2/chat/rooms/'+roomId+'/history',{after,limit:30});if(!current(token))return;setMessages(old=>[...new Map([...old,...page.messages].map(message=>[message.messageId,message])).values()]);setNext(page.next);messagePages.current++;}
   else{let cursor='0',following:string|null=null;const items:Message[]=[];for(let page=0;page<messagePages.current;page++){const value:MessagePage=await runtime.api.call('/v2/chat/rooms/'+roomId+'/history',{after:cursor,limit:30});if(!current(token))return;items.push(...value.messages);following=value.next;if(!following)break;cursor=following;}setMessages([...new Map(items.map(message=>[message.messageId,message])).values()]);setNext(following);}
   setLoaded(true);
  }catch{if(current(token)){setMessages([]);setNext(null);setLoaded(false);setMessageError('这些消息当前不可读取。已选引用仍保留，保存前会重新核对。');}}
  finally{if(reading.current===token)reading.current=0;if(current(token))setReadingMessages(false);}
 },[runtime,roomId,current]);
 useEffect(()=>{
  const request=messageRead,inFlight=reading,initial=window.setTimeout(()=>void readMessages(),0),read=()=>{if(!document.hidden)void readMessages();};
  const timer=window.setInterval(read,15000);document.addEventListener('visibilitychange',read);
  return()=>{request.current++;inFlight.current=0;window.clearTimeout(initial);window.clearInterval(timer);document.removeEventListener('visibilitychange',read);};
 },[readMessages]);
 const visible=messages.filter(message=>message.text&&!message.sharedSummaryId&&(!onlyOwn||message.subjectId===subjectId));
 return <>
  {messageError&&<p className="message error" role="alert">{messageError}<Button type="button" variant="ghost" disabled={busy||readingMessages} onClick={()=>void readMessages()}>重新读取消息</Button></p>}
  {readingMessages&&!loaded&&<p><output>正在打开对话内容…</output></p>}
  <div className="source-message-list">{visible.map(message=>{
   const ref:CapsuleSourceRef={kind:'selected-message',id:message.messageId,version:message.revision},key=capsuleRefKey(ref),isSelected=selected.some(item=>capsuleRefKey(item.ref)===key),inputId=checkboxPrefix+'-'+key;
   return <label className={'source-message'+(isSelected?' is-selected':'')} key={key} htmlFor={inputId} aria-labelledby={inputId+'-author '+inputId+'-body'}><input id={inputId} type="checkbox" disabled={busy} checked={isSelected} onChange={event=>onChange(event.target.checked?[...selected,{ref,authorId:message.subjectId,label:'“'+roomTitle+'”中的消息'}]:selected.filter(item=>capsuleRefKey(item.ref)!==key))}/><div><span className="source-message-author"><MemberAvatar subjectId={message.subjectId}/><strong id={inputId+'-author'}>{memberName(message.subjectId,subjectId,people[message.subjectId]??undefined)}</strong>{(message.sentAt??message.createdAt)&&<time>{readableTime(message.sentAt??message.createdAt)}</time>}</span><span className="source-message-body" id={inputId+'-body'}>{message.text}</span><small>消息第 {message.revision} 版</small></div></label>;
  })}</div>
  {loaded&&!visible.length&&<p className="source-reading-note">{onlyOwn?'这一页没有你写下的可选原话。':'这一页没有可选原话。'}{next?'可以继续查看其他消息。':''}</p>}
  {next&&<Button type="button" variant="ghost" disabled={busy||readingMessages} onClick={()=>void readMessages(true)}>更多消息</Button>}
 </>;
}
