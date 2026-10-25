import {chatParticipantRefSchema} from '../../galaxy-official/src/shared/chat-schema.mjs';
import {ReadingDetails,ReadingSummary} from './reading-details';
import React,{useCallback,useEffect,useId,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {createWebRuntime} from './runtime.mjs';
import {createConversationDirectory} from './conversation-directory';
import {UserRoundPlus} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {MemberAvatar,useMemberNames} from './conversation-ui';
import {chatMemberName as memberName} from './chat-member-ui';
import {useGovernanceDraft} from './governance-presentation';
import './conversation-invite.css';

type Runtime=Awaited<ReturnType<typeof createWebRuntime>>;
type Room={roomId:string;members?:{subjectId:string}[]};
type Decision={decisionId:string;action:string;state:string;effectiveState?:string;payload?:{targetSubjectId?:string}};
type InviteAttempt={kind:'invite';decisionId:string;person:string};
type Props={runtime:Runtime;subjectId:string;room:Room;decisions:Decision[];disabled:boolean;externalError?:string;onInvite:(subjectId:string,decisionId:string)=>Promise<Decision|undefined>};
const initial={person:'',query:''};
export function ConversationInvite({runtime,subjectId,room,decisions,disabled,externalError,onInvite}:Props){
 const [lease]=useState(()=>runtime.receiptStatus.captureLease()),fieldId=useId();
 const directory=useMemo(()=>createConversationDirectory(runtime,subjectId),[runtime,subjectId]);
 const {people,names:accountNames,profiles,cursors,loading,loaded,error:readError}=useSyncExternalStore(directory.subscribe,directory.read,directory.read);
 useEffect(()=>{directory.start();return directory.close;},[directory]);
 const draft=useGovernanceDraft<typeof initial,InviteAttempt>(runtime,subjectId,true,'chat-invite-input:v1:'+JSON.stringify([runtime.api.endpoint,subjectId,room.roomId]),initial);
 const form={...initial,...draft.value},{ready:draftReady,attempt:draftAttempt,settle:settleDraft}=draft;
 const [opened,setOpen]=useState<boolean|null>(null),open=opened??(draft.ready&&!!form.person);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[sending,setSending]=useState(false);
 const mounted=useRef(true),working=useRef(false);
 const memberIds=new Set<string>((room.members??[]).map(member=>member.subjectId));
 const waitingIds=new Set<string>(decisions.filter(item=>item.action==='invite'&&['pending','approved'].includes(item.effectiveState??item.state)).map(item=>item.payload?.targetSubjectId).filter((id):id is string=>!!id));
 const names=useMemberNames(runtime,subjectId,true,[...Object.keys(people),form.person]);
 const name=(id:string)=>memberName(id,subjectId,accountNames[id]??names[id]??undefined);
 const accountMode=subjectId.startsWith('account:');
 useEffect(()=>{if(!accountMode||!open)return;const timer=window.setTimeout(()=>void directory.search(form.query),200);return()=>window.clearTimeout(timer);},[accountMode,directory,form.query,open]);
 const current=useCallback(()=>{try{lease.assertCurrent();return mounted.current;}catch{return false;}},[lease]);
 const load=directory.load;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{if(open&&!loaded)void directory.loadInitial();},[open,loaded,directory]);
 useEffect(()=>{
  if(draftReady)void settleDraft(locator=>Promise.resolve({state:locator.kind==='invite'&&decisions.some(item=>item.decisionId===locator.decisionId&&item.action==='invite'&&item.payload?.targetSubjectId===locator.person)?'acknowledged':'unknown'}))
   .catch(()=>{if(current())setError('暂时无法确认上次邀请，你的选择仍保留。');});
 },[draftReady,draftAttempt,settleDraft,decisions,current]);
 function choose(id:string){if(!draft.ready||!current())return;draft.change({person:id});setError('');setNotice('');}
 const eligible=Object.keys(people).filter(id=>!memberIds.has(id)&&!waitingIds.has(id));
 const shown=eligible.filter(id=>!form.query.trim()||name(id).toLocaleLowerCase().includes(form.query.trim().toLocaleLowerCase()));
 const validPerson=chatParticipantRefSchema.safeParse(form.person).success&&form.person!==subjectId&&!memberIds.has(form.person)&&!waitingIds.has(form.person);
 async function invite(event:React.SubmitEvent<HTMLFormElement>){
  event.preventDefault();if(working.current||disabled||!validPerson||!draft.ready||!current())return;
  working.current=true;setSending(true);setError('');setNotice('');
  try{
   const saved=await draft.snapshot();if(!current())return;const person=saved.value.person,decisionId=crypto.randomUUID();
   if(!chatParticipantRefSchema.safeParse(person).success||person===subjectId||memberIds.has(person)||waitingIds.has(person))throw Error('请选择尚未加入或受邀加入这段对话的人。');
   await draft.attach({kind:'invite',decisionId,person},saved.revision);if(!current())return;
   const result=await onInvite(person,decisionId);if(!current())return;
   if(!result?.decisionId){setError('邀请尚未完成，你的选择已保留。');return;}
   if(result.decisionId!==decisionId||result.payload?.targetSubjectId!==person)throw Error('暂时无法确认这次邀请，原选择仍保留。');
   await draft.settle(locator=>Promise.resolve({state:locator?.decisionId===decisionId&&locator.person===person?'acknowledged':'unknown'}));if(!current())return;
   setNotice(result.state==='approved'?'已向'+name(person)+'发出邀请。':'已提出邀请'+name(person)+'加入。');setOpen(false);
  }catch(reason){if(current())setError(reason instanceof Error&&/[\u3400-\u9fff]/.test(reason.message)?reason.message:'邀请暂未完成，你的选择已保留。');}
  finally{working.current=false;if(current())setSending(false);}
 }
 return <div className="conversation-invite">
  {notice&&<output className="invite-feedback">{notice}</output>}
  <ReadingDetails className="conversation-invite" open={open} onOpenChange={value=>{if(value)setOpen(true);else if(opened===true)setOpen(false);}}>
   <ReadingSummary><UserRoundPlus size={16}/>邀请成员</ReadingSummary>
   {open&&<form className="conversation-invite-form" onSubmit={event=>void invite(event)}>
    <label htmlFor={fieldId+"-query"}>查找联系人<Input id={fieldId+"-query"} value={form.query} maxLength={120} disabled={!draft.ready||sending} onChange={event=>draft.change({query:event.target.value})} placeholder="按姓名查找"/></label>
    <div className="invite-person-list" role="radiogroup" aria-label="选择要邀请的人">{shown.map(id=><label className={'invite-person'+(form.person===id?' selected':'')} key={id}><input type="radio" name={'invite-'+room.roomId} value={id} checked={form.person===id} disabled={sending||!draft.ready} onChange={()=>choose(id)}/><MemberAvatar subjectId={id} profile={profiles[id]}/><span><strong>{name(id)}</strong><small>{people[id]}</small></span></label>)}</div>
    {loading&&<output>正在读取联系人…</output>}
    {loaded&&!shown.length&&!loading&&<p className="muted">{form.query?'当前列表中没有匹配的姓名。':'还没有其他可邀请的联系人。'}</p>}
    {readError&&<output>{readError}<button type="button" className="text-link" disabled={loading} onClick={()=>void directory.loadInitial()}>重新读取</button></output>}
    <div className="invite-more">{cursors.contacts&&<button type="button" className="text-link" disabled={loading} onClick={()=>void load('contacts',cursors.contacts!)}>更多联系人</button>}{cursors.rooms&&<button type="button" className="text-link" disabled={loading} onClick={()=>void load('rooms',cursors.rooms!)}>更早对话中的人</button>}</div>
    {!accountMode&&<ReadingDetails className="invite-known-person" mode="inline"><ReadingSummary>使用对方给我的银河 ID</ReadingSummary><label htmlFor={fieldId+"-manual"}>对方的银河 ID<Input id={fieldId+"-manual"} value={eligible.includes(form.person)?'':form.person} maxLength={32} disabled={sending||!draft.ready} onChange={event=>choose(event.target.value.trim())} placeholder="粘贴完整银河 ID"/></label></ReadingDetails>}
    {form.person&&<p className="invite-selection">{validPerson?<>邀请 <strong>{name(form.person)}</strong> 加入</>:memberIds.has(form.person)?'对方已经在这段对话中。':waitingIds.has(form.person)?'邀请已发出，可以在成员请求中查看。':form.person===subjectId?'你已经在这段对话中。':accountMode?'请选择要邀请的账户。':'请输入完整的银河 ID。'}</p>}
    <p className="invite-impact">对方接受后，可以阅读这段对话中仍保留的消息。</p>
    {(error||(!draft.ready&&draft.status))&&<p className="message error" role="alert">{error?(externalError||error):draft.status}</p>}
    <div className="button-row"><Button type="submit" disabled={disabled||sending||!draft.ready||!validPerson}>{sending?'正在邀请…':'邀请加入'}</Button><Button type="button" variant="ghost" disabled={sending} onClick={()=>setOpen(false)}>稍后再邀请</Button></div>
   </form>}
  </ReadingDetails>
 </div>;
}
