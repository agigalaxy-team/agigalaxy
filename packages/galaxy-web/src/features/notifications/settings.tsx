import { ReadingDetails, ReadingSummary } from "../../shared/reading/reading-details";
import React,{useCallback,useEffect,useId,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Bell,BriefcaseBusiness,MessageSquare,X} from 'lucide-react';
import {z} from 'zod/v4';
import {inboxOptionsSchema} from '../../../../galaxy-official/src/shared/notification-inbox-schema.mjs';
import type {createWebRuntime} from '../../runtime.mjs';
import {createConversationDirectory} from "../chat/conversation-directory";
import {MemberAvatar,memberName,useMemberNames} from "../../shared/people/conversation-ui";
import {useGovernanceDraft} from "../governance/governance-presentation";
import {applyNotificationChanges,hasNotificationChanges,notificationSettingsSatisfied,saveNotificationSelection} from './settings-model.mjs';
import './settings.css';

type Runtime=Awaited<ReturnType<typeof createWebRuntime>>;
type Client=Runtime['notifications'];
const optionsSchema=z.object({revision:z.number(),settings:inboxOptionsSchema,externalDelivery:z.literal('disabled')});
type Options=z.infer<typeof optionsSchema>;
type Changes={rooms?:boolean;tasks?:boolean;mutedRooms?:Record<string,boolean>;blockedPeople?:Record<string,boolean>;roomBlocks?:Record<string,boolean>};
type InputValue={changes:Changes;query:string;manual:string};
type Attempt={kind:'notification-settings';expectedRevision:number;changes:Changes;settings:Options['settings']};
const initial:InputValue={changes:{},query:'',manual:''};
type Props={runtime:Runtime;subjectId:string;client:Client;open:boolean;onClose:()=>void;onResume:()=>void;onSaved:(value:Options,message:string)=>void};
function readable(reason:unknown){if(typeof reason==='object'&&reason!==null&&'code' in reason&&reason.code==='inbox_options_conflict')return '通知设置已在别处改变。下面已读取当前设置，你的选择仍保留；查看后可继续保存。';return reason instanceof Error&&/[\u3400-\u9fff]/.test(reason.message)?reason.message:'暂时未能保存通知设置，你的选择仍保留。页面会继续核对是否已生效。';}
export function NotificationSettings({runtime,subjectId,client,open,onClose,onResume,onSaved}:Props){
 const draft=useGovernanceDraft<InputValue,Attempt>(runtime,subjectId,true,'notification-settings-input:v1:'+runtime.api.endpoint,initial),form={...initial,...draft.value};
 const {ready:draftReady,settle:settleDraft}=draft;
 const [lease]=useState(()=>runtime.receiptStatus.captureLease()),fieldId=useId();
 const directory=useMemo(()=>createConversationDirectory(runtime,subjectId),[runtime,subjectId]);
 const directoryState=useSyncExternalStore(directory.subscribe,directory.read,directory.read),{rooms,cursors,loaded,loading}=directoryState,people=Object.keys(directoryState.people);
 useEffect(()=>{directory.start();return directory.close;},[directory]);
 const dialog=useRef<HTMLDialogElement>(null),heading=useRef<HTMLHeadingElement>(null),active=useRef(true),working=useRef(false);
 const [current,setCurrent]=useState<Options|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[readError,setReadError]=useState(''),[shown,setShown]=useState(8);
 const valid=useCallback(()=>{lease.assertCurrent();return active.current;},[lease]);
 const settings=current?applyNotificationChanges(current.settings,form.changes):null,changed=hasNotificationChanges(form.changes);
 const ids=[...people,...(settings?.blockedSubjectIds??[]),...(settings?.roomBlocks??[]).map(item=>item.subjectId),form.manual];
 const names=useMemberNames(runtime,subjectId,true,ids),name=(id:string)=>memberName(id,subjectId,names[id]??undefined);
 const resumed=useRef(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 useEffect(()=>{if(!draft.ready||resumed.current)return;resumed.current=true;if(changed)onResume();},[draft.ready,changed,onResume]);
 useEffect(()=>{if(open){dialog.current?.showModal();heading.current?.focus({preventScroll:true});if(dialog.current)dialog.current.scrollTop=0;}else dialog.current?.close();},[open]);
 const refresh=useCallback(async()=>{
  if(!valid())return;const value=await client.options({},undefined);if(!valid())return;setCurrent(value);
  if(draftReady)await settleDraft(attempt=>Promise.resolve({state:notificationSettingsSatisfied(value,attempt)?'acknowledged':'unknown'}));
  return value;
 },[client,draftReady,settleDraft,valid]);
 useEffect(()=>{if(!open&&!draft.attempt)return;let live=true;
  const update=async()=>{if(!live||working.current||document.hidden)return;try{await refresh();if(live)setReadError('');}catch{if(live)setReadError('当前设置暂未读到，已有输入仍保留。');}};
  void update();const timer=setInterval(()=>void update(),12000),visible=()=>{if(!document.hidden)void update();};
  document.addEventListener('visibilitychange',visible);return()=>{live=false;clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[open,draft.attempt,refresh]);
 useEffect(()=>{if(open&&!loaded)void directory.loadInitial();},[open,loaded,directory]);
 const load=directory.load;
 function edit(changes:Changes){if(!draft.ready||working.current||!valid())return;draft.change({changes:{...form.changes,...changes}});setError('');}
 function listChange(field:'mutedRooms'|'blockedPeople'|'roomBlocks',id:string,value:boolean){edit({[field]:{...form.changes[field],[id]:value}});}
 function personChoice(id:string,value:boolean){if(id===subjectId||!/^GUID[A-Z0-9]{28}$/.test(id))return;listChange('blockedPeople',id,value);}
 async function save(event:React.SubmitEvent<HTMLFormElement>){
  event.preventDefault();if(working.current||!draft.ready||!changed||!valid())return;working.current=true;setBusy(true);setError('');
  try{const snapshot=await draft.snapshot();if(!valid())return;
   const latest=await client.options({},undefined);if(!valid())return;setCurrent(latest);
   const attempt:Attempt={kind:'notification-settings',expectedRevision:latest.revision,changes:snapshot.value.changes,settings:applyNotificationChanges(latest.settings,snapshot.value.changes)};
   await draft.attach(attempt,snapshot.revision);if(!valid())return;
   const result=await saveNotificationSelection(client,attempt,{check:valid});if(!valid())return;
   await draft.settle(saved=>Promise.resolve({state:notificationSettingsSatisfied(result,saved)?'acknowledged':'unknown'}));if(!valid())return;
   if(!result)throw Error('当前设置暂未读到，已有选择仍保留。');
   setCurrent(result);onSaved(result,'所选通知设置已生效。');onClose();
  }catch(reason){if(active.current){if(typeof reason==='object'&&reason!==null&&'current' in reason){const parsed=optionsSchema.safeParse(reason.current);if(parsed.success)setCurrent(parsed.data);}setError(readable(reason));}}
  finally{working.current=false;if(active.current)setBusy(false);}
 }
 const candidates=people.filter(id=>id!==subjectId&&!settings?.blockedSubjectIds.includes(id)&&(!form.query.trim()||name(id).toLocaleLowerCase().includes(form.query.trim().toLocaleLowerCase())));
 const title=(id:string)=>rooms[id]||'暂时无法读取的对话 · '+id.slice(-6);
 return <dialog ref={dialog} className="conversation-panel notification-settings-dialog" onClose={onClose} onCancel={event=>{event.preventDefault();if(!busy)onClose();}} aria-labelledby="notification-settings-title">
  <header><span className="notification-settings-symbol"><Bell size={25} aria-hidden="true"/></span><div><p className="notification-settings-eyebrow">按自己的节奏接收进展</p><h2 ref={heading} id="notification-settings-title" tabIndex={-1}>通知设置</h2></div><button className="icon-button" aria-label="关闭设置" disabled={busy} onClick={onClose}><X size={20}/></button></header>
  <div className="notification-settings"><p className="muted">选择哪些进展出现在通知中。屏蔽成员同时影响后续联系。</p>
   {(readError||directoryState.error)&&<output className="message">{readError||directoryState.error}</output>}{error&&<p className="message error" role="alert">{error}</p>}
   {!current||!settings?<output>正在读取当前设置…</output>:<form className="notification-settings-form" onSubmit={event=>void save(event)}>
    <fieldset disabled={busy||!draft.ready}><legend>接收哪些通知</legend>
     <label className="notification-setting-toggle" aria-label="对话进展：新消息和对话邀请" htmlFor={fieldId+"-rooms"}><MessageSquare className="notification-toggle-icon" size={24} aria-hidden="true"/><span><strong>对话进展</strong><small>新消息和对话邀请</small></span><input id={fieldId+"-rooms"} type="checkbox" checked={settings.rooms} onChange={e=>edit({rooms:e.target.checked})}/></label>
     <label className="notification-setting-toggle" aria-label="求助与工作：参与、交付及相关回应" htmlFor={fieldId+"-tasks"}><BriefcaseBusiness className="notification-toggle-icon" size={24} aria-hidden="true"/><span><strong>求助与工作</strong><small>参与、交付及相关回应</small></span><input id={fieldId+"-tasks"} type="checkbox" checked={settings.tasks} onChange={e=>edit({tasks:e.target.checked})}/></label>
    </fieldset>
    {!!settings.mutedRoomIds.length&&<fieldset disabled={busy||!draft.ready}><legend>已静音的对话</legend><ul className="notification-selection-list">{settings.mutedRoomIds.map((id:string)=><li key={id}><span>{title(id)}</span><button type="button" className="text-link" onClick={()=>listChange('mutedRooms',id,false)}>恢复通知</button></li>)}</ul></fieldset>}
    <fieldset disabled={busy||!draft.ready}><legend>屏蔽成员</legend><p className="muted">屏蔽后，不再接收对方后续联系和相关通知。已公开的资料仍按原分享范围开放。</p>
     {!!settings.blockedSubjectIds.length&&<ul className="notification-selection-list">{settings.blockedSubjectIds.map((id:string)=><li key={id}><span className="notification-person"><MemberAvatar subjectId={id}/>{name(id)}</span><button type="button" className="text-link" onClick={()=>personChoice(id,false)}>解除屏蔽</button></li>)}</ul>}
     <label className="notification-search" htmlFor={fieldId+"-query"}>从联系人或共同对话中选择<Input id={fieldId+"-query"} value={form.query} onChange={e=>{draft.change({query:e.target.value});setShown(8);}} placeholder="按姓名查找"/></label>
     <ul className="notification-selection-list">{candidates.slice(0,shown).map(id=><li key={id}><span className="notification-person"><MemberAvatar subjectId={id}/>{name(id)}</span><button type="button" className="text-link" onClick={()=>personChoice(id,true)}>屏蔽</button></li>)}</ul>
     {loading&&<output className="muted">正在读取联系人…</output>}{loaded&&!loading&&!candidates.length&&<p className="muted">{form.query?(settings.blockedSubjectIds.some((id:string)=>name(id).includes(form.query.trim()))?'该成员已在上方的屏蔽选择中。':'没有找到对应姓名。'):'当前没有其他可选择的联系人。'}</p>}
     <div className="button-row">{candidates.length>shown&&<button type="button" className="text-link" onClick={()=>setShown(n=>n+12)}>显示更多</button>}{cursors.contacts&&<button type="button" className="text-link" disabled={loading} onClick={()=>void load('contacts',cursors.contacts!)}>更多联系人</button>}{cursors.rooms&&<button type="button" className="text-link" disabled={loading} onClick={()=>void load('rooms',cursors.rooms!)}>更早对话中的人</button>}</div>
     <ReadingDetails mode="inline" className="notification-manual"><ReadingSummary>通过银河 ID 指定成员</ReadingSummary><label htmlFor={fieldId+"-manual"}>对方的银河 ID<Input id={fieldId+"-manual"} value={form.manual} onChange={e=>draft.change({manual:e.target.value.trim()})}/></label><Button type="button" variant="outline" disabled={!/^GUID[A-Z0-9]{28}$/.test(form.manual)||form.manual===subjectId||settings.blockedSubjectIds.includes(form.manual)} onClick={()=>{personChoice(form.manual,true);draft.change({manual:''});}}>加入屏蔽选择</Button></ReadingDetails>
    </fieldset>
    {!!settings.roomBlocks.length&&<fieldset disabled={busy||!draft.ready}><legend>仅在特定对话中屏蔽</legend><ul className="notification-selection-list">{settings.roomBlocks.map(item=><li key={JSON.stringify(item)}><span>{name(item.subjectId)}<small>{title(item.roomId)}</small></span><button type="button" className="text-link" onClick={()=>listChange('roomBlocks',JSON.stringify([item.roomId,item.subjectId]),false)}>解除屏蔽</button></li>)}</ul></fieldset>}
    {changed&&<output className="notification-draft-note">{draft.status==='正在保存…'?'正在保留本机输入…':draft.status||'这些选择尚未保存，关闭后可以继续。'}</output>}
    <div className="notification-settings-footer"><Button type="submit" disabled={busy||!draft.ready||!changed}>{busy?'正在保存…':'保存设置'}</Button>{changed&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>{draft.change(initial);setError('');}}>放弃本次修改</Button>}</div>
   </form>}
  </div>
 </dialog>;
}
