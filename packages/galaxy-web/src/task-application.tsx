import React,{useEffect,useEffectEvent,useId,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/textarea';
import {TaskTerms} from './task-budget-fields';
import {applicationFromDraft,budgetText,qualificationState,taskWriteError} from './task-bounty-client.mjs';
import {TaskAgentIdentityPrompt} from './task-agent-identity-prompt';
import {Check,MessageCircle} from 'lucide-react';
import type {TaskPageTask} from './task-page-view';
import type {WorkTask,WorkRequest,WorkApplication} from './work-task-types';
import type {TaskEntryRuntime,ApplicationDraft} from './task-entry-types';
import {blankApplication,meaningfulApplication,readApplicationDraft,sameApplication,qualificationSummaryView,taskEntryScope} from './task-entry-types';

const reasons:Record<string,string>={'insufficient-related-accepted-history':'缺少当前相关且已接受或经限定审核的实际经历','insufficient-current-reviewed-experience':'缺少当前有效的相关审核经历','insufficient-policy-matched-proof':'缺少符合本规则的 CI 证明','no-current-visible-accepted-delivery':'尚无当前可见的已接受交付','synthetic-excluded':'演示或合成资料不能授予实际资格','source-under-review':'这项来源处于待复核状态','qualification_source_unavailable':'原来源或授权当前不可用','source-unavailable':'原来源或授权当前不可用'};
export function QualificationSummary({value}:{value:unknown}){
 const reading=qualificationSummaryView(value);if(!reading)return null;
 return <div className="message"><strong>{qualificationState(reading)}</strong><p>这只是当前本任务的限定条件核对，选择和确认参与时会再次计算。</p>
 {reading.missing.map((row,index)=><p key={index}>{typeof row!=='string'&&row.condition==='relevant-reviewed-experience'?`相关且已接受或经限定审核的实际经历：当前可计入 ${row.available} 项，需要 ${row.required} 项。`:typeof row!=='string'&&row.condition==='policy-matched-ci-observations'?`符合本规则的 CI 证明：当前 ${row.available} 项，需要 ${row.required} 项。`:reasons[typeof row==='string'?row:row.code??'']??'仍有一项条件缺少充分依据；请检查相关经历、许可和当前版本。'}</p>)}
 {reading.calculation&&<p>依据本任务私有计算许可返回限定结论，未取得旧任务原文或第三方身份的阅读授权。</p>}
 {reading.sourceReasons.map((reason,index)=><p key={index}>{reasons[reason]??'一项所选材料当前不足以计入，请检查其状态或授权。'}</p>)}
 {reading.state!=='satisfied'&&<p>缺少资料不等于没有能力。可以继续开放协助，或提交经限定审核的外部工作／挑战资料。</p>}</div>;
}
export function ApplicationTerms({application,request}:{application:WorkApplication;request:WorkRequest}){
 const evidence=application.qualificationEvidence,states:Record<string,string>={pending:'等待回应',selected:'已提出参与安排',withdrawn:'申请者已撤回'};
 return <div><p>申请状态：{states[application.state]??application.state??'待核对'}</p>
 {request.collaboration==='basic-bounty'&&<><p>申请报价：{application.quote?budgetText(application.quote):'原申请未记录单独报价'}。</p><p className="muted">这里只读取原申请记录。</p></>}
 {request.qualification&&<p>所选依据：{(evidence?.assistanceIds??[]).length} 项原版协助、{(evidence&&'participationIds' in evidence?evidence.participationIds.length:0)} 项实际参与、{(evidence&&'externalReviewRefs' in evidence?evidence.externalReviewRefs.length:0)} 项精确版本外部审核、{(evidence?.proofIds??[]).length} 项 CI 证明；{evidence&&'calculationGrantId' in evidence&&evidence.calculationGrantId?'使用本任务限定计算许可。':'原文可见权限保留原状。'}</p>}</div>;
}
type Props={task:TaskPageTask;runtime:TaskEntryRuntime|null;subjectId?:string;connected:boolean;navigate:(path:string)=>void;refresh:()=>Promise<unknown>;onNeedIdentity?:()=>void};
export function TaskApplication(props:Props){
 if(props.task.schemaVersion!==2||props.task.requesterId===props.subjectId)return null;
 const scope=props.runtime?.taskDraftScope();
 return <TaskApplicationSession key={JSON.stringify([taskEntryScope(props.runtime,props.connected,props.subjectId,props.task.taskId),scope?.key])} {...props} task={props.task}/>;
}
function TaskApplicationSession({task,runtime,subjectId,connected,navigate,refresh,onNeedIdentity}:Omit<Props,'task'>&{task:WorkTask}){
 const key=`task-application-draft:${task.taskId}`,owner=subjectId??'visitor';
 const guard=useMemo(()=>runtime?.createTaskDraftClient()??null,[runtime]);
 const [draft,setDraft]=useState(blankApplication),[loaded,setLoaded]=useState(false),[guestDraft,setGuestDraft]=useState<ApplicationDraft|null>(null),[pending,setPending]=useState<unknown>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[saveState,setSaveState]=useState(''),[agentReady,setAgentReady]=useState(false);
 const epoch=useRef(0),working=useRef(false),saves=useRef<Promise<unknown>>(Promise.resolve()),draftRef=useRef(draft),guestSource=useRef<ApplicationDraft|null>(null),inputRevision=useRef(0),fieldId=useId();
 const [readAt,setReadAt]=useState(()=>Date.now()/1000);
 const current=(token=epoch.current)=>{if(token!==epoch.current||!guard||!runtime)return false;try{guard.check();return guard.ownerKey===owner;}catch{return false;}};
 const restore=useEffectEvent(()=>{
  if(!runtime)return;const token=epoch.current;
  return Promise.all([runtime.getLocal(key,owner),subjectId?runtime.getLocal(key,'visitor'):null,subjectId?runtime.getLocal(`task-event:${task.taskId}`,owner):null]).then(([saved,guest,operation])=>{
   if(!current(token))return;const useGuest=!meaningfulApplication(saved)&&meaningfulApplication(guest),selected=readApplicationDraft(useGuest?guest:saved);
   setDraft(selected);draftRef.current=selected;guestSource.current=useGuest?readApplicationDraft(guest):null;
   if(meaningfulApplication(saved)&&meaningfulApplication(guest)&&!sameApplication(saved,guest))setGuestDraft(readApplicationDraft(guest));
   setPending(operation);setLoaded(true);setSaveState('输入会保存在此浏览器。');
  }).catch((reason:unknown)=>{if(current(token))setError(taskWriteError(reason));});
 });
 useEffect(()=>{const scope=epoch;scope.current++;void restore();return()=>{scope.current++;};},[runtime,guard]);
 const readPending=useEffectEvent(()=>{
  if(!runtime||!subjectId||working.current||document.visibilityState!=='visible')return;const token=epoch.current;
  void runtime.getLocal(`task-event:${task.taskId}`,owner).then((value:unknown)=>{if(current(token)){setPending(value);setReadAt(Date.now()/1000);}}).catch(()=>{});
 });
 useEffect(()=>{const timer=window.setInterval(()=>readPending(),4000),visible=()=>readPending();document.addEventListener('visibilitychange',visible);return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);};},[]);
 const stopped=useEffectEvent((event:{scopeTaskId:string|null})=>{if(event.scopeTaskId===task.taskId&&current())setPending(null);});
 useEffect(()=>runtime?.onTaskOperationStopped((event:{scopeTaskId:string|null})=>stopped(event)),[runtime]);
 const writable=connected&&subjectId&&task.requesterId!==subjectId,open=task.enrollmentOpen??(task.state==='open'&&task.request.enrollmentExpiresAt>readAt),legacyTerms=task.request.collaboration==='basic-bounty'||!!task.request.qualification;
 const sent=task.contacts?.responses.applications.find(item=>item.subjectId===subjectId&&item.state!=='withdrawn');
 async function run(fn:(valid:()=>boolean)=>Promise<void>){
  if(working.current||!runtime)return;const token=epoch.current,valid=()=>current(token);working.current=true;setBusy(true);setError('');
  try{await fn(valid);}catch(reason){if(valid())setError(taskWriteError(reason));}
  finally{if(valid()){try{const operation=await runtime.getLocal(`task-event:${task.taskId}`,owner);if(valid())setPending(operation);}catch{}if(valid()){working.current=false;setBusy(false);}}}
 }
 function change(field:'proposal'|'scope',value:string){
  if(!runtime||working.current)return;const next={...draftRef.current,[field]:value},token=epoch.current,draftOwner=guestSource.current?'visitor':owner;
  inputRevision.current++;draftRef.current=next;setDraft(next);setSaveState('正在保存…');
  saves.current=saves.current.catch(()=>{}).then(async()=>{if(!current(token))throw Error('原参与草稿的身份或连接已变化。');await runtime.putLocal(key,next,draftOwner);if(!current(token))throw Error('原参与草稿的身份或连接已变化。');});
  void saves.current.then(()=>{if(current(token)&&draftRef.current===next)setSaveState('已保存到此浏览器。');}).catch((reason:unknown)=>{if(current(token)){setSaveState('尚未保存，文字仍在这里。');setError(taskWriteError(reason));}});
 }
 async function continueGuest(valid:()=>boolean){await saves.current;if(!valid()||!guestDraft)return;const next=readApplicationDraft(guestDraft);guestSource.current=guestDraft;inputRevision.current++;setGuestDraft(null);draftRef.current=next;setDraft(next);setSaveState('已接着使用登录前的草稿，身份原稿仍保留。');}
 async function submit(valid:()=>boolean){
  if(!runtime)throw Error('请先接续当前身份。');await saves.current;if(!valid())return;
  const submittedDraft={...draftRef.current},revision=inputRevision.current,draftOwner=guestSource.current?'visitor':owner;
  const event=applicationFromDraft({...submittedDraft,quoteMode:'task',selected:[]},task);if(event.kind!=='apply')throw Error('当前帮助意向暂时无法核对。');
  await runtime.taskEvent(task.taskId,event,{viewers:[task.requesterId],confirmed:true});if(!valid())return;
  await runtime.updateLocal(key,(stored:unknown)=>{if(!valid())throw Error('原参与草稿的身份或连接已变化。');return sameApplication(stored,submittedDraft)?null:stored;},draftOwner);
  if(!valid())return;if(inputRevision.current===revision){const next=blankApplication();setDraft(next);draftRef.current=next;}
  setNotice('帮助意向已送达，等待对方回应。');await refresh();if(valid())navigate(`/app/tasks/${task.taskId}?section=collaboration`);
 }
 if(legacyTerms)return <section className="application-page"><h2>原任务的参与条件</h2><TaskTerms request={task.request}/><p>这份历史求助保留原有条件。你可以继续讨论这件事，或发起一份新的开放求助。</p><div className="button-row"><Button onClick={()=>navigate(`/app/tasks/${task.taskId}?section=comments`)}>参与讨论</Button><Button variant="outline" onClick={()=>navigate('/app/publish')}>发起开放求助</Button></div></section>;
 return <section className="application-page" aria-busy={busy}><header><h2>我可以提供帮助</h2><p>告诉发起者你能做什么，这段话会直接发给对方。</p></header>
 {error&&<div className="message error" role="alert">{error}</div>}{notice&&<output className="message">{notice}</output>}
 {!open&&<p className="message">这份求助已停止接受新的参与意向，仍可继续讨论。</p>}
 {!!pending&&<output className="application-note">上次提交的内容已保留，正在确认结果。</output>}
 {sent&&<div className="application-sent"><Check size={22}/><div><h3>你的帮助意向已送达</h3><p>{sent.proposal}</p>{sent.scope&&<p>{sent.scope}</p>}<Button variant="outline" onClick={()=>navigate(`/app/tasks/${task.taskId}?section=collaboration`)}>查看回应</Button></div></div>}
 {guestDraft&&<div className="application-draft-choice"><h3>登录前还有一份不同的草稿</h3><p>当前显示这个身份已有的草稿。两份内容都已保留。</p><blockquote>{guestDraft.proposal}<br/>{guestDraft.scope}</blockquote><Button variant="outline" disabled={busy} onClick={()=>void run(continueGuest)}>接着写登录前的草稿</Button><Button variant="ghost" onClick={()=>setGuestDraft(null)}>继续当前草稿</Button></div>}
 {loaded&&!sent&&<form className="workspace-form application-compose" onSubmit={event=>{event.preventDefault();if(writable&&agentReady)void run(submit);}}>
  <fieldset disabled={busy||!!pending}>
   <label htmlFor={fieldId+'-proposal'}>你能提供怎样的帮助？<Textarea id={fieldId+'-proposal'} aria-label="你能提供怎样的帮助？" required maxLength={1500} value={draft.proposal} onChange={event=>change('proposal',event.target.value)} placeholder="可以是一个建议、一次复核，或一起完成某一部分。"/></label>
   <label id={fieldId+'-scope-row'} htmlFor={fieldId+'-scope'}>补充说明 <small>可选</small><Textarea id={fieldId+'-scope'} aria-label="补充说明" maxLength={1500} value={draft.scope} onChange={event=>change('scope',event.target.value)} placeholder="方便的时间，或需要对方提前了解的事情。"/></label>
  </fieldset>
  {connected&&<TaskAgentIdentityPrompt {...{runtime,subjectId,connected,navigate}} onReady={setAgentReady}/>}
  <footer className="request-form-footer"><span aria-live="polite">{saveState}</span>
   {!connected?<Button type="button" disabled={busy||!open||!!pending} onClick={()=>void run(async valid=>{await saves.current;if(valid()){if(onNeedIdentity)onNeedIdentity();else navigate('/app/settings/identity');}})}>接续已有身份</Button>:agentReady&&<Button type="submit" disabled={busy||!open||!!pending}>{busy?'正在发送…':'发送帮助意向'}</Button>}
  </footer>
 </form>}
 <div className="application-discussion"><MessageCircle size={18}/><p>也可以直接在这件事下面交流。</p><Button variant="ghost" disabled={busy} onClick={()=>void run(async valid=>{await saves.current;if(valid())navigate(`/app/tasks/${task.taskId}?section=comments`);})}>参与讨论</Button></div>
 </section>;
}
