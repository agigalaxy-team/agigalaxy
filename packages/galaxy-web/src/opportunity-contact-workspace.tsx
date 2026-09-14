import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {createProjectViewClient,projectViewScope,hasIndependentProject} from './project-view-client.mjs';

const purposeNames:Record<string,string>={conversation:'交流想法',reuse:'了解复用',collaboration:'共同协作',recruitment:'了解招募'};
const states:Record<string,string>={sent:'已发送，等待回应',accepted:'双方已接受交流',declined:'对方已拒绝',withdrawn:'已撤回邀请',expired:'邀请已到期',awaiting_distinct_control:'等待独立控制主体确认'};
type Props={runtime:any;connected:boolean;subjectId?:string|null;query:any;opportunity:any;navigate:(path:string)=>void};
export function OpportunityContactWorkspace(props:Props){return <OpportunityContactView key={projectViewScope(props.runtime,props.connected)+JSON.stringify(props.opportunity?.opportunityRef)} {...props}/>;}
function OpportunityContactView({runtime,connected,subjectId,query,opportunity,navigate}:Props){
 const owner=subjectId??(connected?runtime?.api?.snapshot()?.subjectId:null),scope=projectViewScope(runtime,connected);
 const client=useMemo(()=>runtime?createProjectViewClient(runtime,{connected,subjectId:owner}):null,[runtime,connected,owner,scope]);
 const [composing,setComposing]=useState(false),[purpose,setPurpose]=useState(''),[note,setNote]=useState(''),[roomTitle,setRoomTitle]=useState('银河交流');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[contact,setContact]=useState<any>(null),[unknown,setUnknown]=useState<any>(null),[recruit,setRecruit]=useState<any>(null);
 const [pendingLoaded,setPendingLoaded]=useState(false);
 const generation=useRef(0),refKey=JSON.stringify(opportunity?.opportunityRef);
 useEffect(()=>{generation.current++;setComposing(false);setContact(null);setUnknown(null);setRecruit(null);setError('');setNote('');setPurpose('');setBusy(false);return()=>{generation.current++;};},[scope,refKey]);
 useEffect(()=>{let active=true,reading=false;setPendingLoaded(false);
  const reload=()=>{if(!active||reading||busy||document.visibilityState!=='visible'||!client)return;reading=true;client.pendingContact(opportunity).then((value:any)=>{if(active){setUnknown(value);setPendingLoaded(true);}}).catch((e:any)=>{if(active)setError(typeof e?.message==='string'&&e.message.trim()?e.message:'操作暂未完成，请稍后重试。');}).finally(()=>{reading=false;});};
  reload();const timer=window.setInterval(reload,20000);document.addEventListener('visibilitychange',reload);
  return()=>{active=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',reload);};
 },[client,refKey]);
 const purposes=(opportunity?.help?.purposes??[]).filter((x:string)=>query?.purposes?.includes(x));
 async function run(fn:(commit:(action:()=>void)=>void)=>Promise<void>){if(busy||!client)return;const g=generation.current;
  const commit=(action:()=>void)=>{if(g===generation.current){client.current();action();}};setBusy(true);setError('');
  try{await fn(commit);}catch(e:any){if(g===generation.current){setError(typeof e?.message==='string'&&e.message.trim()?e.message:'操作暂未完成，请稍后重试。');if(e.resultUnknown)setUnknown({operationId:e.operationId,contactId:e.objectId});}}
  finally{if(g===generation.current)setBusy(false);}}
 const refreshContact=(id:string,commit:(action:()=>void)=>void)=>client!.contact(id).then((value:any)=>commit(()=>setContact(value)));
 return <section className="task-body"><h3>你希望接下来怎么做</h3><p>查看资料、发出联系与实际加入分别进行。普通交流不需要先创建任务。</p>
  <div className="button-row">{hasIndependentProject(opportunity)&&<Button type="button" variant="outline" onClick={()=>navigate('/app/projects/'+opportunity.projectId)}>打开这个项目的固定链接</Button>}
   {opportunity.recruitmentId&&<Button type="button" variant="outline" disabled={busy} onClick={()=>run(async commit=>{const value=await client!.recruitment(opportunity.recruitmentId);commit(()=>setRecruit(value));})}>查看这项招募和关联任务</Button>}
   <Button type="button" disabled={!connected||!owner||!client||busy||!pendingLoaded||!purposes.length||opportunity.subjectId===owner||!!contact||!!unknown} onClick={()=>{setPurpose(purposes[0]);setComposing(true);}}>准备向此对象联系</Button></div>
  {!hasIndependentProject(opportunity)&&<p>这是原 Profile 声明中的项目，当前没有独立项目详情。上方原查询和声明来源仍是本次依据，不会为打开页面自动导入或登记。<Button type="button" variant="ghost" onClick={()=>navigate('/app/projects?section=projects')}>管理或自主登记自己的项目</Button></p>}
  {!connected&&<p>可以先阅读当前公开资料。要发送联系，请连接自己的银河身份；页面链接本身不授予资料或房间权限。</p>}
  {error&&<p className="message error" role="alert">{error}</p>}
  {recruit&&<article className="task-card"><h3>{recruit.document?.title??'这项招募的正文当前不可读取'}</h3><p>{recruit.document?.role}</p><p>{recruit.document?.summary}</p><p>参与条件：{recruit.document?.conditions||'发布者未补充条件'}</p>
   <p>当前状态：{({active:'招募中',paused:'已暂停',closed:'已关闭',expired:'已到期'} as Record<string,string>)[recruit.state]??recruit.state}；{recruit.acceptingContacts?'当前可按具体意愿联系':'当前不接收新的联系'}。招募声明不证明已经具备相应能力。</p>
   <p>联系人当前代表权：{recruit.representativeCurrentlyAuthorized?'有效':'当前未确认或已不可用'}；期限：{recruit.expiresAt?new Date(recruit.expiresAt).toLocaleString():'未取得'}。</p>
   {recruit.taskLinks?.map((link:any)=><Button type="button" key={link.taskId} variant="outline" onClick={()=>navigate('/app/tasks/'+link.taskId)}>打开已关联的实际任务 {link.taskId}</Button>)}
   {!recruit.taskLinks?.length&&<p>当前没有向你开放的关联任务。这不代表没有协作，也不会自动创建一项任务。</p>}</article>}
  {composing&&!contact&&!unknown&&<form className="workspace-form" onSubmit={e=>{e.preventDefault();run(async commit=>{const result=await client!.send(query,opportunity,{purpose,note,roomTitle});commit(()=>{setContact(result);setComposing(false);});await refreshContact(result.contactId,commit);});}}>
   <p>接收者：<code>{opportunity.subjectId}</code></p><p>将发送当前选定的目标和功能说明、联系目的、下面的正文。不会发送仓库、完整聊天或私人摘要。</p>
   <label>本次联系目的<select required value={purpose} onChange={e=>setPurpose(e.target.value)}>{purposes.map((x:string)=><option key={x} value={x}>{purposeNames[x]??x}</option>)}</select></label>
   <label>准备发送的说明<Textarea required maxLength={2000} value={note} onChange={e=>setNote(e.target.value)}/></label>
   <label>双方接受后的房间名称<Input required maxLength={120} value={roomTitle} onChange={e=>setRoomTitle(e.target.value)}/></label>
   <p>这只发出一项邀请，等待对方独立回应；尚未建房，也未成为项目成员或任务参与者。</p>
   <div className="button-row"><Button type="submit" disabled={busy}>发送这项联系</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>setComposing(false)}>取消草稿</Button></div>
  </form>}
  {contact&&<article className="task-card"><h3>实际联系与回应</h3><p>{states[contact.state]??contact.state}</p><code>{contact.contactId}</code>
   <div className="button-row"><Button type="button" variant="outline" disabled={busy} onClick={()=>run(commit=>refreshContact(contact.contactId,commit))}>刷新实际回应</Button>
    {contact.roomId&&<Button type="button" onClick={()=>navigate('/app/rooms/'+contact.roomId)}>进入双方已接受的普通房间</Button>}
    {contact.state==='sent'&&contact.initiatorId===owner&&<Button type="button" variant="outline" disabled={busy} onClick={()=>run(async commit=>{await client!.respond(contact,'withdraw');await refreshContact(contact.contactId,commit);})}>撤回尚未接受的邀请</Button>}</div>
   <p>关闭这块界面不会撤回邀请。若决定承担一项交付，应另行明确任务和参与范围。</p></article>}
  {unknown&&<article className="message"><h3>这次操作的回执尚未确认</h3><p>保留原操作 {unknown.operationId}。当前对象可读不等于原操作已确认，不会自动换ID重发。</p>
   <Button type="button" variant="outline" disabled={busy} onClick={()=>run(async commit=>{const result=await client!.reconcile(unknown.operationId);commit(()=>{if(result.current)setContact(result.current);});})}>查询原对象当前状态</Button>
   <Button type="button" variant="outline" disabled={busy} onClick={()=>run(async commit=>{const result=await client!.reconcile(unknown.operationId,true);commit(()=>{setUnknown(null);setContact(result);setComposing(false);});await refreshContact(result.contactId,commit);})}>重试原操作与原授权</Button></article>}
 </section>;
}
