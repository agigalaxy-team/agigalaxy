import type {ChatMessage} from './chat-workspace-types';

export function chatDay(value:string):string {
 const date=new Date(value);
 return Number.isFinite(date.getTime())?date.toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric'}):'';
}
export function continuesChatMessage(previous:ChatMessage|undefined,current:ChatMessage):boolean {
 const elapsed=Date.parse(current.sentAt)-Date.parse(previous?.sentAt??'');
 return !!previous&&previous.subjectId===current.subjectId&&previous.actorKind===current.actorKind&&chatDay(previous.sentAt)===chatDay(current.sentAt)&&elapsed>=0&&elapsed<300000;
}
