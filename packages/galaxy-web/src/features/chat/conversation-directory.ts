import type {createWebRuntime} from "../../runtime.mjs";
import type {MemberAvatarProfile} from "../../shared/people/conversation-ui";
import {accountAvatarKey} from "../../../../galaxy-official/src/shared/account-profile-presentation.mjs";

export type ConversationDirectoryRuntime=Pick<Awaited<ReturnType<typeof createWebRuntime>>,'api'|'receiptStatus'>;
type Kind='contacts'|'rooms';
type Contact={state:string;initiatorId:string;recipientId:string};
type Room={roomId:string;title:string;members:{subjectId:string;displayName?:string|null}[]};
type Directory={people:Record<string,string>;names:Record<string,string>;profiles:Record<string,MemberAvatarProfile>;rooms:Record<string,string>;cursors:Record<Kind,string|null>;loading:boolean;loaded:boolean;error:string};

/** Read account recipients and current room members under the captured lease. */
export function createConversationDirectory(runtime:ConversationDirectoryRuntime,subjectId:string){
 const lease=runtime.receiptStatus.captureLease(),listeners=new Set<()=>void>(),reading=new Set<Kind>();
 let active=false,generation=0,query='';const accountMode=subjectId.startsWith('account:');
 let view:Directory={people:{},names:{},profiles:{},rooms:{},cursors:{contacts:null,rooms:null},loading:false,loaded:false,error:''};
 const remember=(profiles:Record<string,MemberAvatarProfile>,item:{actorRef?:string;accountId?:string;avatarKey?:string|null;subjectType?:string|null})=>{
  if(item.accountId&&item.actorRef==='account:'+item.accountId)profiles[item.actorRef]={accountId:item.accountId,avatarKey:accountAvatarKey(item.avatarKey),subjectType:item.subjectType==='person'||item.subjectType==='organization'||item.subjectType==='agent'?item.subjectType:null};
 };
 const publish=(patch:Partial<Directory>)=>{view={...view,...patch};for(const listener of listeners)listener();};
 const valid=(token:number)=>{try{lease.assertCurrent();return active&&generation===token;}catch{return false;}};
 async function load(kind:Kind,after?:string){
  const token=generation;if(reading.has(kind)||!valid(token))return;reading.add(kind);publish({loading:true});
  try{
   const page:{items?:(Contact&{actorRef?:string;accountId?:string;displayName?:string|null;avatarKey?:string|null;subjectType?:string|null})[];rooms?:Room[];nextAfter?:string|null;next?:string|null}=await runtime.api.call(kind==='contacts'?accountMode?'/v2/chat/accounts/query':'/v2/contacts/query':'/v2/chat/rooms/query',{...(kind==='contacts'?accountMode?{query,limit:20}:{direction:'both',limit:50}:{}),...(after?{after}:{})});
   if(!valid(token))return;
   const people={...view.people},names={...view.names},profiles={...view.profiles},rooms={...view.rooms};
   if(kind==='contacts'&&accountMode){for(const item of page.items??[])if(item.actorRef&&item.actorRef!==subjectId){people[item.actorRef]='银河账户';remember(profiles,item);if(item.displayName)names[item.actorRef]=item.displayName;}}
    else if(kind==='contacts'){for(const item of page.items??[])if(item.state==='accepted'){const id=item.initiatorId===subjectId?item.recipientId:item.initiatorId;if(id&&id!==subjectId)people[id]='联系人';}}
   else{for(const room of page.rooms??[]){rooms[room.roomId]=room.title;for(const member of room.members??[])if(member.subjectId!==subjectId){if(!people[member.subjectId])people[member.subjectId]='共同对话';if(member.displayName)names[member.subjectId]=member.displayName;}}}
   publish({people,names,profiles,rooms,cursors:{...view.cursors,[kind]:kind==='contacts'?page.nextAfter??null:page.next??null}});
  }catch{if(valid(token))publish({error:'部分联系人或对话暂未读到，已有选择仍保留。'});}
  finally{if(token===generation){reading.delete(kind);if(valid(token))publish({loading:reading.size>0,loaded:true});}}
 }
 return{read:()=>view,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
  start:()=>{active=true;generation++;},close:()=>{active=false;generation++;reading.clear();},load,
  search:(value:string)=>{if(!accountMode||value===query)return Promise.resolve();query=value;generation++;reading.clear();publish({people:Object.fromEntries(Object.entries(view.people).filter(([,label])=>label==='已选择的账户')),cursors:{...view.cursors,contacts:null},error:''});return load('contacts');},
   knownAccount:async(accountId:string)=>{const token=generation;if(!accountMode)return;try{const page=await runtime.api.call('/v2/chat/accounts/query',{accountId});if(!valid(token))return;const people={...view.people},names={...view.names},profiles={...view.profiles};for(const item of page.items??[])if(item.actorRef&&item.actorRef!==subjectId){people[item.actorRef]='已选择的账户';remember(profiles,item);if(item.displayName)names[item.actorRef]=item.displayName;}publish({people,names,profiles});}catch{if(valid(token))publish({error:'暂时无法读取这个账户。'});}},
   loadInitial:()=>{publish({error:''});return Promise.all([load('contacts'),load('rooms')]);}};
}
