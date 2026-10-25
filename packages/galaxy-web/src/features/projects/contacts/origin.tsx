import React,{useEffect,useState} from "react";
import {Button} from "@/components/ui/button";
import {object} from "../contracts";
import type {ContactView,ProjectRuntime,ProjectLease} from "../contracts";

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const member=(contact:ContactView,subjectId:string)=>contact&&[contact.initiatorId,contact.recipientId].includes(subjectId)&&uuid(contact.contactId);
const originProject=(contact:ContactView)=>{
 const send=contact.events.find(event=>event.kind==='send'&&!event.contentUnavailable),ref=send?.kind==='send'&&!send.contentUnavailable?send.opportunityRef:null;
 return ref&&'sourceKind' in ref&&['project','recruitment'].includes(ref.sourceKind)&&uuid(ref.projectId)?ref.projectId:null;
};
function scope(runtime:ProjectRuntime|null|undefined,subjectId:string|null|undefined,connected:boolean){const connection=runtime?.api?.snapshot();return JSON.stringify([runtime?.api?.endpoint,subjectId,connected,connection?.subjectId,connection?.bindingId,connection?.generation]);}
type Common={runtime:ProjectRuntime|null|undefined;subjectId?:string|null;connected:boolean;navigate:(path:string)=>void};

// These are local source locators, never cached Contact notes or permissions.
// Every consumer also reads the actual Contact as the current signed subject.
async function projectLocator(runtime:ProjectRuntime,subjectId:string,contact:ContactView,lease:ProjectLease){
 lease.assertCurrent();if(!member(contact,subjectId))throw new Error('当前身份不能核对这项联系来源。');
 const key='contact-origin:'+contact.contactId,endpoint=runtime.api.endpoint,current=originProject(contact);
 if(current){try{await runtime.putLocal(key,{version:1,endpoint,subjectId,contactId:contact.contactId,projectId:current},subjectId);}catch{lease.assertCurrent();}lease.assertCurrent();return current;}
 let saved:unknown;try{saved=await runtime.getLocal(key,subjectId);}catch{lease.assertCurrent();return null;}lease.assertCurrent();
 return object(saved)&&saved.version===1&&saved.endpoint===endpoint&&saved.subjectId===subjectId&&saved.contactId===contact.contactId&&uuid(saved.projectId)
  &&Object.keys(saved).sort().join(',')==='contactId,endpoint,projectId,subjectId,version'?saved.projectId:null;
}

export function ContactSourceLinks({runtime,subjectId,connected,navigate,contact}:{contact:ContactView}&Common){
 const [source,setSource]=useState<{contact:ContactView;scope:string;projectId:string|null}|null>(null),currentScope=scope(runtime,subjectId,connected);
 useEffect(()=>{let active=true;if(!runtime||!connected||!subjectId||!member(contact,subjectId))return;
  void(async()=>{const lease=runtime.receiptStatus.captureLease();if(lease.subjectId!==subjectId||runtime.api.snapshot()?.subjectId!==subjectId)return;
   const value=await projectLocator(runtime,subjectId,contact,lease);if(active)setSource({contact,scope:currentScope,projectId:value});})().catch(()=>{});
  return()=>{active=false;};
 },[runtime,currentScope,contact,connected,subjectId]);
 const projectId=source?.contact===contact&&source.scope===currentScope?source.projectId:null;
 if(!projectId)return null;
 const roomId=contact.state==='accepted'&&uuid(contact.roomId)?contact.roomId:null;
 return <Button type="button" variant="outline" onClick={()=>navigate('/app/projects/'+projectId+'?fromContact='+contact.contactId+(roomId?'&fromRoom='+roomId:''))}>打开原项目</Button>;
}

type Props=Common&{roomId?:string;contactId?:string;projectId?:string};
export function ContactOriginWorkspace(props:Props){return <ContactOriginView key={scope(props.runtime,props.subjectId,props.connected)+JSON.stringify([props.roomId,props.contactId,props.projectId])} {...props}/>;}
function ContactOriginView({runtime,subjectId,connected,navigate,roomId,contactId,projectId}:Props){
 const [origin,setOrigin]=useState<{contactId:string;roomId:string;projectId:string|null}|null>(null),[unavailable,setUnavailable]=useState(false);
 useEffect(()=>{let active=true,request=0;
  const id=contactId??roomId;if(!runtime||!connected||!subjectId||!uuid(id)||!uuid(roomId))return;
  const read=async()=>{const current=++request;try{const lease=runtime.receiptStatus.captureLease();if(lease.subjectId!==subjectId||runtime.api.snapshot()?.subjectId!==subjectId)return;
   const contact:ContactView=await runtime.api.call('/v2/contacts/'+id,undefined,{method:'GET',authenticated:true});lease.assertCurrent();
   if(!member(contact,subjectId)||contact.contactId!==id||contact.state!=='accepted'||contact.roomId!==roomId)throw new Error('contact_origin_unavailable');
   const source=await projectLocator(runtime,subjectId,contact,lease);if(projectId&&source!==projectId)throw new Error('contact_origin_unavailable');
   if(active&&current===request){setOrigin({contactId:id,roomId,projectId:source});setUnavailable(false);}
  }catch{if(active&&current===request){setOrigin(null);setUnavailable(true);}}};
  void read();const visible=()=>{if(document.visibilityState==='visible')void read();};document.addEventListener('visibilitychange',visible);
  return()=>{active=false;document.removeEventListener('visibilitychange',visible);};
 },[runtime,subjectId,connected,roomId,contactId,projectId]);
 if(!origin)return projectId&&contactId&&roomId&&unavailable?<p className="muted">当前身份未能核对原联系与房间来源。页面链接本身不授予资料或房间权限。</p>:null;
 return <section className="contact-origin-links" aria-label="原联系与项目"><p>从这里回到最初的联系和项目。</p><div className="button-row">
  <Button type="button" variant="outline" onClick={()=>navigate('/app/projects?section=contacts&contactId='+origin.contactId+'&fromRoom='+origin.roomId)}>返回原联系</Button>
  {projectId?<Button type="button" variant="outline" onClick={()=>navigate('/app/rooms/'+origin.roomId)}>返回原聊天</Button>:
   origin.projectId?<Button type="button" variant="outline" onClick={()=>navigate('/app/projects/'+origin.projectId+'?fromContact='+origin.contactId+'&fromRoom='+origin.roomId)}>打开原项目</Button>:<p className="record-meta">暂未找到可返回的原项目。</p>}
 </div></section>;
}
