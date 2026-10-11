import type {createWebRuntime} from './runtime.mjs';

export type ConversationDirectoryRuntime=Pick<Awaited<ReturnType<typeof createWebRuntime>>,'api'|'receiptStatus'>;
type Kind='contacts'|'rooms';
type Contact={state:string;initiatorId:string;recipientId:string};
type Room={roomId:string;title:string;members:{subjectId:string}[]};
type Directory={people:Record<string,string>;rooms:Record<string,string>;cursors:Record<Kind,string|null>;loading:boolean;loaded:boolean;error:string};

/** Read existing contacts and room members under the captured browser binding. */
export function createConversationDirectory(runtime:ConversationDirectoryRuntime,subjectId:string){
 const lease=runtime.receiptStatus.captureLease(),listeners=new Set<()=>void>(),reading=new Set<Kind>();
 let active=false,generation=0;
 let view:Directory={people:{},rooms:{},cursors:{contacts:null,rooms:null},loading:false,loaded:false,error:''};
 const publish=(patch:Partial<Directory>)=>{view={...view,...patch};for(const listener of listeners)listener();};
 const valid=(token:number)=>{try{lease.assertCurrent();return active&&generation===token;}catch{return false;}};
 async function load(kind:Kind,after?:string){
  const token=generation;if(reading.has(kind)||!valid(token))return;reading.add(kind);publish({loading:true});
  try{
   const page:{items?:Contact[];rooms?:Room[];nextAfter?:string|null;next?:string|null}=await runtime.api.call(kind==='contacts'?'/v2/contacts/query':'/v2/chat/rooms/query',{...(kind==='contacts'?{direction:'both',limit:50}:{}),...(after?{after}:{})});
   if(!valid(token))return;
   const people={...view.people},rooms={...view.rooms};
   if(kind==='contacts'){for(const item of page.items??[])if(item.state==='accepted'){const id=item.initiatorId===subjectId?item.recipientId:item.initiatorId;if(id&&id!==subjectId)people[id]='联系人';}}
   else{for(const room of page.rooms??[]){rooms[room.roomId]=room.title;for(const member of room.members??[])if(member.subjectId!==subjectId&&!people[member.subjectId])people[member.subjectId]='共同对话';}}
   publish({people,rooms,cursors:{...view.cursors,[kind]:kind==='contacts'?page.nextAfter??null:page.next??null}});
  }catch{if(valid(token))publish({error:'部分联系人或对话暂未读到，已有选择仍保留。'});}
  finally{if(token===generation){reading.delete(kind);if(valid(token))publish({loading:reading.size>0,loaded:true});}}
 }
 return{read:()=>view,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
  start:()=>{active=true;generation++;},close:()=>{active=false;generation++;reading.clear();},load,
  loadInitial:()=>{publish({error:''});return Promise.all([load('contacts'),load('rooms')]);}};
}
