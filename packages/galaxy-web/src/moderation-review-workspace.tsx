import React,{useCallback,useEffect,useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {createModerationReviewClient} from './moderation-review-client.mjs';
import {PageLoading} from './site-shell';
import {memberName,useMemberNames} from './conversation-ui';
import {useChoiceViewLease} from './choice-retained-operations';
import type {ChoiceViewLease} from './choice-retained-operations';
import type {ReviewClient,ReviewDraft,ReviewInput,ReviewListItem,ReviewLocator,ReviewPending,ReviewPreview,ReviewProjection,ReviewSource,ReviewStopped,ReviewSummary,SourceView,WorkspaceProps} from './governance-workspace-types';
import {fullTime,governanceError,governanceLabels as labels,GovernanceEvents,GovernancePreview,GovernanceSource,useGovernanceDraft} from './governance-presentation';

const emptyDraft:ReviewDraft={action:'',summary:'',scope:'',verifier:'',conclusion:'inconclusive',corrects:'',reason:'',verdict:'dismissed'};
const quickKinds=['accept-verifier','decline-verifier','withdraw-verifier'];
function sourceOf(record:{source?:ReviewSource|null}|null):SourceView|null{
 const p=record?.source?.targetEvent;if(!p)return null;
 return{kind:'case',title:'title' in p?p.title:'这次复核的工作记录',summary:'summary' in p?p.summary:'description' in p?p.description:'strategy' in p?p.strategy:'',
  ...('taskId' in p&&p.taskId?{path:'/app/tasks/'+p.taskId}:{})};
}
type ReviewWorkspaceProps=WorkspaceProps&{caseId?:string};
type ReviewSessionProps=ReviewWorkspaceProps&{lease:ChoiceViewLease|null};
export function ModerationReviewWorkspace(props:ReviewWorkspaceProps){
 const view=useChoiceViewLease(props.runtime,props.subjectId);
 return <ModerationReviewSession key={JSON.stringify([view.key,props.runtime.api.endpoint,props.subjectId,props.connected,props.reportId,props.caseId])} {...props} connected={props.connected&&!!view.lease} lease={view.lease}/>;
}
function ModerationReviewSession({runtime,subjectId,connected,reportId,caseId,navigate,lease}:ReviewSessionProps){
 const client:ReviewClient|null=useMemo(()=>connected&&subjectId&&lease?createModerationReviewClient({runtime,subjectId}):null,[runtime,subjectId,connected,lease]);
 const draft=useGovernanceDraft<ReviewDraft,ReviewLocator>(runtime,subjectId,connected,'review-input:'+runtime.api.endpoint+':'+(reportId??caseId??'directory'),emptyDraft),fields=draft.value;
 const verifierId=useId(),scopeId=useId(),reasonId=useId();
 const [stopped,setStopped]=useState<ReviewStopped[]>([]),[items,setItems]=useState<ReviewListItem[]>([]),[next,setNext]=useState<string|null>(null),[record,setRecord]=useState<ReviewProjection|null>(null),[pending,setPending]=useState<ReviewPending|null>(null),[blocked,setBlocked]=useState('');
 const [contacts,setContacts]=useState<string[]>([]),[contactNext,setContactNext]=useState<string|null>(null),[contactsLoaded,setContactsLoaded]=useState(false),[contactsError,setContactsError]=useState('');
 const [preview,setPreview]=useState<ReviewPreview|null>(null),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[readError,setReadError]=useState(''),[notice,setNotice]=useState('');
 const epoch=useRef(0),sequence=useRef(0),contactSequence=useRef(0),working=useRef(false),reading=useRef(false),pageCount=useRef(1),draftNow=useRef(draft);
 useLayoutEffect(()=>{draftNow.current=draft;},[draft]);
 const current=useCallback((gen:number)=>{if(gen!==epoch.current||!lease)return false;try{lease.assertCurrent();return true;}catch{return false;}},[lease]);
 const own=record?.verifierParticipation.own,source=sourceOf(record);
 const names=useMemberNames(runtime,subjectId,connected,[record?.reporterId,...(record?.participantIds??[]),...(record?.events??[]).map(e=>e.actorId),...contacts,fields.verifier,...(preview?.viewers??[])]);
 const choices=record?[...(record.canSubmitVerification?['verification-response']:[]),...(record.canSupplement?['supplement']:[]),...(record.canCorrectEventIds.length?['correct']:[]),...(record.canAppeal&&record.state==='resolved'?['appeal']:[]),...(record.canInviteVerifier?['invite-verifier']:[]),...(record.canModerate?[record.paused?'resume':'pause',...record.state==='resolved'?[]:['resolve']]:[])]:[];
 const draftStopped=!!draft.attempt&&stopped.some(p=>p.eventId===draft.attempt?.eventId);
 const formVisible=!draftStopped&&!!fields.action&&choices.includes(fields.action);
 const refresh=useCallback(async(recover=true)=>{
  if(!client)return;const gen=epoch.current,ticket=++sequence.current,valid=()=>current(gen)&&ticket===sequence.current;
  if(!valid())return;let recoveryError:unknown=null,reason='';
  if(reportId&&recover)try{const r=await client.resumePending(reportId);if(!valid())return;reason=r.reason??'';}catch(e){recoveryError=e;}
  if(!valid())return;
  if(reportId){
   const result=await Promise.allSettled([client.get(reportId),client.pending(reportId),client.stopped(reportId)]);if(!valid())return;
   if(result[0].status==='fulfilled'){setReadError('');setRecord(result[0].value);}else{setRecord(null);setPreview(null);setReadError(governanceError(result[0].reason));}
   if(result[1].status==='fulfilled')setPending(result[1].value);if(result[2].status==='fulfilled')setStopped(result[2].value);if(recover)setBlocked(reason);
  }else{
   let after:string|undefined;const rows:ReviewSummary[]=[];
   for(let page=0;page<pageCount.current;page++){
    const r=await client.query({...caseId?{caseId}:{},...after?{after}:{}});if(!valid())return;
    rows.push(...r.items);after=r.nextAfter??undefined;if(!after)break;
   }
   const views=await Promise.all(rows.map(async(row):Promise<ReviewListItem>=>{
    const unavailable:ReviewListItem={...row,report:null,source:null,events:[],unavailable:true};
    if(!valid())return unavailable;try{return await client.get(row.reportId);}catch{return unavailable;}
   }));
   if(!valid())return;setReadError('');setItems(views);setNext(after??null);
  }
  if(reportId&&draftNow.current.ready)try{await draftNow.current.settle(locator=>client.receipt(locator));}catch(e){if(valid())setError(governanceError(e));}
  if(valid()){setLoaded(true);if(recoveryError)setError(governanceError(recoveryError));}
 },[client,reportId,caseId,current]);
 useEffect(()=>{
  const lifecycle=epoch,requests=sequence,gen=++lifecycle.current;
  const read=()=>{if(!current(gen)||document.hidden||working.current||reading.current)return;reading.current=true;void refresh().catch(e=>{if(current(gen)){setReadError(governanceError(e));setRecord(null);setItems([]);setPreview(null);setLoaded(true);}}).finally(()=>{if(current(gen))reading.current=false;});};
  const initial=setTimeout(read,0),timer=setInterval(read,20000);document.addEventListener('visibilitychange',read);
  return()=>{lifecycle.current++;requests.current++;clearTimeout(initial);clearInterval(timer);document.removeEventListener('visibilitychange',read);};
 },[refresh,current]);
 const {ready:draftReady,settle:settleDraft}=draft;
 useEffect(()=>{if(!client||!draftReady||!reportId)return;const gen=epoch.current;void settleDraft(locator=>client.receipt(locator)).catch(e=>{if(current(gen))setError(governanceError(e));});},[client,draftReady,reportId,settleDraft,current]);
 async function run(fn:(active:ReviewClient,gen:number)=>Promise<void>){
  const gen=epoch.current;if(!client||working.current||!current(gen))return;
  working.current=true;sequence.current++;setBusy(true);setError('');setNotice('');
  try{await fn(client,gen);}catch(e){if(current(gen))setError(governanceError(e));}
  finally{
   if(current(gen)){try{await refresh(false);}catch(e){if(current(gen))setError(governanceError(e));}}
   working.current=false;if(current(gen))setBusy(false);
  }
 }
 const loadContacts=useCallback(async(after?:string)=>{
  const gen=epoch.current,ticket=++contactSequence.current,valid=()=>current(gen)&&ticket===contactSequence.current;if(!valid())return;
  try{
   setContactsError('');const r:{items:{initiatorId:string;recipientId:string}[];nextAfter?:string|null}=await runtime.api.call('/v2/contacts/query',{direction:'both',limit:50,...after?{after}:{}});
   if(!valid())return;const ids=r.items.map(item=>item.initiatorId===subjectId?item.recipientId:item.initiatorId);
   setContacts(old=>[...new Set(after?[...old,...ids]:ids)]);setContactNext(r.nextAfter??null);setContactsLoaded(true);
  }catch{if(valid()){setContactsError('联系人暂时无法读取。');setContactsLoaded(true);}}
 },[runtime,subjectId,current]);
 useEffect(()=>{if(fields.action!=='invite-verifier'||contactsLoaded)return;const timer=setTimeout(()=>void loadContacts(),0);return()=>clearTimeout(timer);},[fields.action,contactsLoaded,loadContacts]);
 function change(patch:Partial<ReviewDraft>){setPreview(null);draft.change(patch);}
 async function prepare(event?:React.SubmitEvent<HTMLFormElement>,quick?:string){event?.preventDefault();await run(async(active,gen)=>{
  if(!reportId)return;const saved=await draft.snapshot();if(!current(gen))return;
  const kind=quick??fields.action,input:ReviewInput={reportId,kind,summary:quick?labels[quick]+'。':fields.summary.trim(),
   ...kind==='invite-verifier'?{summary:fields.summary.trim()||fields.scope.trim(),verifierId:fields.verifier.trim(),scope:fields.scope,expiresAt:Math.floor(Date.now()/1000)+3600}:{},
   ...kind==='verification-response'?{conclusion:fields.conclusion,references:[]}:{},
   ...kind==='correct'?{correctsEventId:fields.corrects,reason:fields.reason}:{},
   ...kind==='resolve'?{verdict:fields.verdict}:{}};
  const p=await active.prepare(input);if(!current(gen))return;
  if(quick){await active.execute(p,{confirmed:true});if(current(gen))setNotice(labels[quick]+'。');return;}
  setPreview({original:p,payload:p.payload,viewers:p.viewers,endpoint:p.endpoint,expiresAt:p.expiresAt,title:source?.title,revision:saved.revision});
 });}
 async function confirm(){if(!preview)return;const p=preview,gen=epoch.current;await run(async(active)=>{
  if(p.recovery)await active.reauthorize(p.original,{confirmed:true});
  else{
   await draft.attach({reportId:p.original.reportId,eventId:p.original.eventId,payloadHash:p.original.payloadHash},p.revision);
   if(!current(gen))return;await active.execute(p.original,{confirmed:true});
  }
  await draft.settle(locator=>active.receipt(locator));if(gen!==epoch.current||!current(gen))return;
  setPreview(null);setNotice(quickKinds.includes(p.payload.kind)?labels[p.payload.kind]+'。':'说明已发送。');
 });}
 async function recover(stoppedRow?:ReviewStopped){await run(async(active,gen)=>{
  if(!reportId)return;const r=stoppedRow?await active.continueStopped({reportId,eventId:stoppedRow.eventId,payloadHash:stoppedRow.payloadHash},{confirmed:true}):await active.resumePending(reportId);
  if(!current(gen))return;if(r.state==='acknowledged'){setNotice('上次的内容已发送。');return;}
  const p=await active.reviewAuthorization(reportId);if(!current(gen))return;
  if(p.state==='reauthorization-required')setPreview({...p,original:p,recovery:true,title:source?.title});
 });}
 const reportEvents=record?[...(record.report?[{...record.report,kind:'report',actorId:record.reporterId}]:[]),...record.events]:[];
 return <section className="governance-workspace">
  <a href={reportId?'/app/reviews'+(caseId?'?caseId='+caseId:''):'/app/account'} className="governance-back" onClick={e=>{e.preventDefault();navigate(reportId?'/app/reviews'+(caseId?'?caseId='+caseId:''):'/app/account');}}><ArrowLeft size={16}/>{reportId?'全部复核记录':'个人中心'}</a>
  <header><h1>{reportId?'这次复核':'复核与处理'}</h1>{record&&<p className="governance-state"><strong>{labels[record.state]??'处理中'}</strong>{record.paused&&' · 相关协作暂停中'}</p>}</header>
  {!connected?<div className="governance-empty"><p>连接身份后查看邀请和与你相关的记录。</p><Button onClick={()=>navigate('/app/settings/identity')}>连接身份</Button></div>:<>
   {(error||readError)&&<div className="message error" role="alert">{error||readError} <button className="text-link" disabled={busy} onClick={()=>run(()=>refresh())}>再试一次</button></div>}{notice&&<p className="message"><output>{notice}</output></p>}
   {!loaded&&<PageLoading label="正在读取…"/>}
   {!reportId&&loaded&&<><div className="governance-list">{items.map(item=><a key={item.reportId} href={'/app/reviews/'+item.reportId+(caseId?'?caseId='+caseId:'')} onClick={e=>{e.preventDefault();navigate('/app/reviews/'+item.reportId+(caseId?'?caseId='+caseId:''));}}><div><h2>{item.verifierParticipation?.own?.status==='invited'?'邀请你复核':sourceOf(item)?.title??'相关处理记录'}</h2><p className="governance-excerpt">{item.report?.summary??item.verifierParticipation?.own?.scope??(item.unavailable?'内容当前无法读取':'说明当前未向你开放')}</p><p className="governance-state">{item.paused?'相关协作暂停中':labels[item.state]??'查看记录'}</p></div><ArrowRight size={18}/></a>)}</div>{!items.length&&!error&&!readError&&<p className="governance-empty">目前没有与你相关的复核或处理记录。</p>}{next&&<Button variant="ghost" disabled={busy} onClick={()=>run(async()=>{pageCount.current++;await refresh(false);})}>更多记录</Button>}</>}
   {record&&<>
    <GovernanceSource source={source} navigate={navigate}/>
    {record.source?.targetEvent&&<ReviewSourceDetails source={record.source}/>}
    {own&&<section className="governance-invitation"><h2>{labels[own.status]??'复核参与情况'}</h2>{own.scope&&<p className="reading-prose">{own.scope}</p>}{own.status==='invited'&&<p className="muted">请在 {fullTime(own.expiresAt)} 前回应。</p>}
     <div className="button-row">{record.canAcceptVerifier&&<Button disabled={busy||!!pending||!draft.ready} onClick={()=>prepare(undefined,'accept-verifier')}>接受邀请</Button>}{record.canDeclineVerifier&&<Button disabled={busy||!!pending||!draft.ready} variant="outline" onClick={()=>prepare(undefined,'decline-verifier')}>谢绝邀请</Button>}{record.canWithdrawVerifier&&<button className="text-link" disabled={busy||!!pending||!draft.ready} onClick={()=>prepare(undefined,'withdraw-verifier')}>退出复核</button>}</div>
    </section>}
    {record.report?.summary&&<section><h2>发起者的说明</h2><p className="reading-prose">{record.report.summary}</p></section>}
    <GovernanceEvents events={record.events??[]} subjectId={subjectId} names={names}/>
    {!pending&&!formVisible&&choices.length>0&&<div className="governance-actions">{choices.map(kind=><Button key={kind} variant={kind==='verification-response'||kind==='supplement'?'default':'outline'} disabled={busy||!draft.ready} onClick={()=>change({action:kind,summary:'',scope:'',reason:'',corrects:''})}>{labels[kind]}</Button>)}</div>}
    {!pending&&formVisible&&<section className="governance-compose"><h2>{labels[fields.action]}</h2><form onSubmit={e=>prepare(e)}>
     {fields.action==='invite-verifier'&&<><label>邀请谁<select required={!fields.verifier} disabled={busy} value={fields.verifier} onChange={e=>change({verifier:e.target.value})}><option value="">选择已联系的人</option>{contacts.map(id=><option key={id} value={id}>{memberName(id,subjectId,names[id]??undefined)}</option>)}</select></label>{contactNext&&<button type="button" className="text-link" disabled={busy} onClick={()=>loadContacts(contactNext)}>更多联系人</button>}{contactsError&&<p>{contactsError} <button type="button" className="text-link" onClick={()=>loadContacts()}>再试一次</button></p>}{!contacts.length&&contactsLoaded&&!contactsError&&<p className="muted">还没有联系人，可以先与对方建立交流。</p>}<details className="governance-technical"><summary>通过已知银河 ID 邀请</summary><label htmlFor={verifierId}>银河 ID<Input id={verifierId} value={fields.verifier} pattern="GUID[0-9A-Z]{28}" disabled={busy} onChange={e=>change({verifier:e.target.value})}/></label></details><label htmlFor={scopeId}>请对方复核什么<Textarea id={scopeId} required value={fields.scope} maxLength={1200} disabled={busy} onChange={e=>change({scope:e.target.value})}/></label><p className="muted">邀请发送后，对方可以在一小时内回应。</p></>}
     {fields.action==='verification-response'&&<label>你的判断<select value={fields.conclusion} disabled={busy} onChange={e=>change({conclusion:e.target.value==='supported'?'supported':e.target.value==='unsupported'?'unsupported':'inconclusive'})}>{['inconclusive','supported','unsupported'].map(value=><option key={value} value={value}>{labels[value]}</option>)}</select></label>}
     {fields.action==='correct'&&<><label>更正哪条说明<select required value={fields.corrects} disabled={busy} onChange={e=>change({corrects:e.target.value})}><option value="">选择我的原说明</option>{record.canCorrectEventIds.map(id=><option value={id} key={id}>{reportEvents.find(event=>event.id===id)?.summary??'原说明当前无法读取'}</option>)}</select></label><label htmlFor={reasonId}>为什么更正<Textarea id={reasonId} required value={fields.reason} maxLength={1200} disabled={busy} onChange={e=>change({reason:e.target.value})}/></label></>}
     {fields.action==='resolve'&&<label>处理决定<select value={fields.verdict} disabled={busy} onChange={e=>change({verdict:e.target.value==='upheld'?'upheld':'dismissed'})}><option value="dismissed">举报不成立</option><option value="upheld">举报成立</option></select></label>}
     {fields.action==='invite-verifier'?<details className="governance-technical" open={!!fields.summary||undefined}><summary>补充的话（可选）</summary><Textarea aria-label="补充的话" value={fields.summary} maxLength={1200} disabled={busy||!draft.ready} onChange={e=>change({summary:e.target.value})}/></details>:<label>{fields.action==='verification-response'?'意见与依据':'你的说明'}<Textarea required value={fields.summary} maxLength={1200} disabled={busy||!draft.ready} onChange={e=>change({summary:e.target.value})}/></label>}
     {draft.status&&<p className="governance-draft-status"><output>{draft.status}</output></p>}
     <div className="button-row"><Button type="submit" disabled={busy||!draft.ready||!(fields.action==='invite-verifier'?fields.scope:fields.summary).trim()}>预览说明</Button><Button variant="ghost" type="button" disabled={busy} onClick={()=>change({action:''})}>收起</Button></div>
    </form></section>}
    <details className="governance-technical"><summary>记录详情</summary><dl><dt>记录编号</dt><dd>{record.reportId}</dd><dt>记录版本</dt><dd>{record.version}</dd>{record.source&&<><dt>提出时版本</dt><dd>{record.source.reportedVersion}</dd><dt>当前来源版本</dt><dd>{record.source.currentVersion}</dd></>}</dl>{record.events?.some(e=>e.kind==='verification-response')&&<p>复核意见由参与者提供，不代表平台的专业认证。</p>}</details>
   </>}
   {stopped.length>0&&<details className="governance-technical" open={draftStopped||undefined}><summary>之前停止的发送</summary>{stopped.map(p=><div key={p.eventId}><p>{labels[p.kind]??'上次的说明'} · 已停止继续发送</p>{p.canContinue&&<Button variant="outline" disabled={busy||!!pending} onClick={()=>recover(p)}>继续这条原说明</Button>}</div>)}{draftStopped&&<button className="text-link" disabled={busy} onClick={()=>change({...emptyDraft})}>另写一条说明</button>}</details>}
   {pending&&<div className="governance-pending"><p>{pending.phase==='stopped-local'?'已停止继续发送，系统仍会确认此前的发送结果。':blocked?'上次的内容仍保留，需要确认后继续。':'正在继续发送上次的内容…'}</p>{pending.phase!=='stopped-local'&&<div className="button-row">{blocked&&<Button disabled={busy} onClick={()=>recover()}>查看并继续</Button>}<button className="text-link" disabled={busy} onClick={()=>run(async active=>{if(reportId)await active.stop(reportId,{confirmed:true});})}>停止继续发送</button></div>}</div>}
   <GovernancePreview value={preview} names={names} subjectId={subjectId} busy={busy} error={error} onConfirm={()=>void confirm()} onClose={()=>setPreview(null)}/>
  </>}
 </section>;
}
function ReviewSourceDetails({source}:{source:ReviewSource}){
 const p=source.targetEvent;if(!p)return null;
 const text=(value:unknown)=>typeof value==='string'?value:undefined;
 const observation='observation' in p?p.observation:'observedEffect' in p?p.observedEffect:undefined;
 const conditions='conditions' in p&&typeof p.conditions==='object'&&p.conditions!==null&&'environment' in p.conditions?p.conditions.environment:undefined;
 const environment='environment' in p?p.environment:conditions;
 const candidates:[string,string|undefined][]=[['实际观察',text(observation)],['适用限制',text('limitations' in p?p.limitations:undefined)],['使用条件',text(environment)]];
 const fields=candidates.filter((entry):entry is [string,string]=>typeof entry[1]==='string'&&entry[1].length>0);
 return fields.length?<section className="governance-source-notes">{fields.map(([label,value])=><div key={label}><h3>{label}</h3><p className="reading-prose">{value}</p></div>)}</section>:null;
}
