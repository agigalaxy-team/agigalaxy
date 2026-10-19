import React from 'react';
import {ArrowRight, MessageCircle} from 'lucide-react';
import {MemberAvatar, readableTime} from './conversation-ui';
import type {ChatDirectoryRoom, ChatMessage} from './chat-workspace-types';

export function chatDay(value:string):string {
 const date=new Date(value);
 return Number.isFinite(date.getTime())?date.toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric'}):'';
}
export function continuesChatMessage(previous:ChatMessage|undefined,current:ChatMessage):boolean {
 const elapsed=Date.parse(current.sentAt)-Date.parse(previous?.sentAt??'');
 return !!previous&&previous.subjectId===current.subjectId&&previous.actorKind===current.actorKind&&chatDay(previous.sentAt)===chatDay(current.sentAt)&&elapsed>=0&&elapsed<300000;
}
export function ConversationBlank({title,children}:{title:string;children?:React.ReactNode}) {
 return <div className="conversation-blank">
  <svg viewBox="0 0 220 155" aria-hidden="true"><rect x="28" y="28" width="126" height="74" rx="22" fill="#e0edf3"/><path d="m51 101-13 22 38-22" fill="#e0edf3"/><rect x="98" y="70" width="101" height="55" rx="19" fill="#f4dcc7"/><path d="m171 123 16 17-35-17" fill="#f4dcc7"/><path d="M51 56h68M51 74h42M119 94h55M119 109h34" stroke="#63747c" strokeWidth="4" strokeLinecap="round"/><circle cx="181" cy="31" r="8" fill="#d87942"/></svg>
  <h2>{title}</h2>{children}
 </div>;
}
export function ChatDirectoryEntry({item,ownId,name,label,preview,current=false,navigate}:{item:ChatDirectoryRoom;ownId:string;name:(id?:string)=>string;label:string;preview:string;current?:boolean;navigate:(path:string)=>void}) {
 const other=item.members.find(member=>member.subjectId!==ownId)?.subjectId;
 const path='/app/rooms/'+item.roomId;
 return <a className={'chat-directory-entry'+(current?' current':'')} href={path} aria-current={current?'page':undefined} onClick={event=>{
  if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  event.preventDefault();navigate(path);
 }}>
  <MemberAvatar subjectId={other??item.roomId} name={other?name(other):undefined}/>
  <div><div className="conversation-row-heading"><h2>{label}</h2><time dateTime={item.lastActivityAt}>{readableTime(item.lastActivityAt)}</time></div><p className="conversation-last-message">{preview}</p>{item.members.length>2&&<span className="conversation-members">{item.members.length} 位成员{item.kind==='ai-subzone'?' · AI 对话':''}</span>}</div>
  {!!item.unreadHumanCount&&<span className="conversation-unread" aria-label={item.unreadHumanCount+' 条未读消息'}>{item.unreadHumanCount>99?'99+':item.unreadHumanCount}</span>}
 </a>;
}
export function ChatExampleLink({navigate}:{navigate:(path:string)=>void}) {
 const path='/app/examples/messages/reading-room';
 return <a className="conversation-example-link" href={path} onClick={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate(path);}}><MessageCircle size={18}/><span><strong>看看一段完整的交流</strong><small>可浏览的示例 · 不会发送给他人</small></span><ArrowRight size={16}/></a>;
}
