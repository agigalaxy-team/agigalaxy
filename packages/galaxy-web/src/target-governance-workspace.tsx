import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { createTargetGovernanceClientV2 } from '../../galaxy-official/src/target-governance-client-v2.mjs';
import { targetModerationSchemaV2, targetReportSchemaV2 } from '../../galaxy-official/src/shared/target-governance-v2-schema.mjs';
import { PageLoading } from './site-shell';
import { memberName, useMemberNames } from './conversation-ui';
import { useChoiceViewLease } from './choice-retained-operations';
import type { ChoiceViewLease } from './choice-retained-operations';
import type { SourceView, TargetClient, TargetConfig, TargetDraft, TargetEvent, TargetEventProjection, TargetInfo, TargetLocator, TargetPayload, TargetPending, TargetPreview, TargetProjection, TargetReference, TargetReport, TargetScope, TargetSimpleKind, TargetStopped, WorkspaceProps } from './governance-workspace-types';
import { categoryLabels, fullTime, governanceError, governanceLabels as labels, GovernanceEvents, GovernancePeople, GovernancePreview, GovernanceSource, useGovernanceDraft } from './governance-presentation';

const emptyDraft:TargetDraft={action:'',summary:'',category:'other',viewers:[],audienceChosen:false,rule:'',scopes:[],hours:24,verdict:'dismissed'};
type TargetWorkspaceProps=WorkspaceProps&{target?:TargetReference};
type TargetSessionProps=TargetWorkspaceProps&{lease:ChoiceViewLease|null};
type TargetRead={record:TargetProjection;items?:never;next?:never}|{record?:never;items:TargetProjection[];next:string|null};
const simpleKind=(kind:string):kind is TargetSimpleKind=>['supplement','appeal','withdraw-report','resume','review'].includes(kind);
const isTargetEvent=(payload:unknown):payload is TargetEvent=>targetModerationSchemaV2.safeParse(payload).success;
const targetPayload=(payload:unknown):TargetPayload=>isTargetEvent(payload)?payload:targetReportSchemaV2.parse(payload);
export function TargetGovernanceWorkspace(props:TargetWorkspaceProps){
 const view=useChoiceViewLease(props.runtime,props.subjectId);
 return <TargetGovernanceSession key={JSON.stringify([view.key,props.runtime.api.endpoint,props.subjectId,props.connected,props.reportId,props.target?.type,props.target?.id])} {...props} connected={props.connected&&!!view.lease} lease={view.lease}/>;
}
function TargetGovernanceSession({runtime,subjectId,connected,target,reportId,navigate,lease}:TargetSessionProps){
 const client:TargetClient|null=useMemo(()=>connected&&subjectId&&lease?createTargetGovernanceClientV2({api:runtime.api,getLocal:runtime.getLocal,putLocal:runtime.putLocal,subjectId,receiptStatus:runtime.receiptStatus}):null,[runtime,subjectId,connected,lease]);
 const draft=useGovernanceDraft<TargetDraft,TargetLocator>(runtime,subjectId,connected,'governance-input:'+runtime.api.endpoint+':'+(reportId??JSON.stringify(target??'directory')),emptyDraft);
 const fields=draft.value,ruleId=useId();
 const [config,setConfig]=useState<TargetConfig|null>(null),[currentTarget,setCurrentTarget]=useState<TargetInfo|null>(null),[source,setSource]=useState<SourceView|null>(null),[items,setItems]=useState<TargetProjection[]>([]),[next,setNext]=useState<string|null>(null),[record,setRecord]=useState<TargetProjection|null>(null);
 const [stopped,setStopped]=useState<TargetStopped[]>([]),[pending,setPending]=useState<TargetPending[]>([]),[blocked,setBlocked]=useState<Record<string,string>>({}),[preview,setPreview]=useState<TargetPreview|null>(null);
 const [busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[readError,setReadError]=useState(''),[notice,setNotice]=useState('');
 const epoch=useRef(0),sequence=useRef(0),working=useRef(false),reading=useRef(false),pageCount=useRef(1),draftNow=useRef(draft);
 useLayoutEffect(()=>{draftNow.current=draft;},[draft]);
 const current=useCallback((gen:number)=>{if(gen!==epoch.current||!lease)return false;try{lease.assertCurrent();return true;}catch{return false;}},[lease]);
 const targetId=target?.id,targetType=target?.type;
 const activeTarget=record?.target??target;
 const decision=['review','pause','resolve','resume'].includes(fields.action);
 const required=record&&decision?record.requiredDecisionViewers.filter(id=>id!==subjectId):[];
 const defaultViewers=(config?.moderatorIds??[]).filter(id=>id!==subjectId);
 const viewers=fields.audienceChosen?fields.viewers:defaultViewers;
 const availableViewers=[...new Set([...defaultViewers,...(record?[record.reporterId,...record.requiredDecisionViewers]:[]),...required,...viewers])].filter(id=>id!==subjectId);
 const names=useMemberNames(runtime,subjectId,connected,[...availableViewers,...(record?.events??[]).map(e=>e.authorId),...(preview?.viewers??[]),...(source?.memberIds??[])]);
 const choices=record?[...(record.canRespond&&record.state!=='withdrawn'?['supplement']:[]),...(record.canAppeal?['appeal']:[]),...(record.canWithdraw?['withdraw-report']:[]),
  ...(record.canModerate?[...(['received','appealed'].includes(record.state)?['review']:[]),...(!['resolved','withdrawn'].includes(record.state)?['pause','resolve']:[]),...(record.ownRestriction?['resume']:[])]:[])]:[];
 const stoppedHere=stopped.filter(p=>reportId?p.reportId===reportId:target?p.target?.id===target.id:true);
 const draftStopped=!!draft.attempt&&stoppedHere.some(p=>p.operationId===draft.attempt?.operationId);
 const formVisible=!draftStopped&&(!reportId?!!target:!!fields.action&&choices.includes(fields.action));
 const scopeOptions:TargetScope[]=activeTarget?.type==='task'?['discovery-hidden','new-participation-paused']:['sending-paused','invitations-paused'];
 const sourceView=useCallback(async(t:TargetReference|undefined,gen:number):Promise<SourceView|null>=>{
  if(!t||!current(gen))return null;
  try{if(t.type==='task'){
    const r:{request:{title:string;summary:string}}=await runtime.api.call('/v2/tasks/'+t.id,null,{method:'GET',authenticated:true});
    return current(gen)?{kind:'task',title:r.request.title,summary:r.request.summary,path:'/app/tasks/'+t.id}:null;
   }
   const r:{title:string;members:{subjectId:string}[]}=await runtime.api.call('/v2/chat/rooms/'+t.id+'/read',{});
   return current(gen)?{kind:'room',title:r.title||'相关对话',memberIds:r.members.map(m=>m.subjectId),path:'/app/rooms/'+t.id}:null;
  }catch{return null;}
 },[runtime,current]);
 const refresh=useCallback(async(recover=true)=>{
  if(!client)return;const gen=epoch.current,ticket=++sequence.current,valid=()=>current(gen)&&ticket===sequence.current;
  if(!valid())return;
  let recoveryError:unknown=null;const reasons:Record<string,string>={};
  if(recover){try{const operations=await client.pending();if(!valid())return;for(const p of operations){const r=await client.resumePending(p.operationId);if(!valid())return;if(r.reason)reasons[p.operationId]=r.reason;}}catch(e){recoveryError=e;}}
  if(!valid())return;
  const read=async():Promise<TargetRead>=>{
   if(reportId)return{record:await client.get(reportId)};
   let after:string|undefined;const rows:TargetProjection[]=[];
   for(let page=0;page<pageCount.current;page++){
    const r=await client.query({...targetId&&targetType?{target:{type:targetType,id:targetId}}:{},...after?{after}:{}});
    if(!valid())return{items:[],next:null};rows.push(...r.items);after=r.next??undefined;if(!after)break;
   }
   return{items:rows,next:after??null};
  };
  const results=await Promise.allSettled([client.config(),read(),client.pending(),targetId&&targetType?client.target({type:targetType,id:targetId}):Promise.resolve(null),client.stopped()]);
  if(!valid())return;
  if(results[0].status==='fulfilled')setConfig(results[0].value);
  if(results[2].status==='fulfilled')setPending(results[2].value.filter(p=>p.state!=='stopped-local'));
  if(results[4].status==='fulfilled')setStopped(results[4].value);
  if(recover)setBlocked(reasons);
  setCurrentTarget(results[3].status==='fulfilled'?results[3].value:null);
  const view=results[1];
  if(view.status==='rejected'){setRecord(null);setItems([]);setSource(null);setPreview(null);setReadError(governanceError(view.reason));}
  else{
   setReadError('');const data=view.value;setRecord(data.record??null);setItems(data.items??[]);setNext(data.next??null);
   const s=await sourceView(data.record?.target??(targetId&&targetType?{id:targetId,type:targetType}:undefined),gen);
   if(!valid())return;setSource(s);
  }
  if(draftNow.current.ready)try{await draftNow.current.settle(locator=>client.receipt(locator));}catch(e){if(valid())setError(governanceError(e));}
  if(valid()){setLoaded(true);if(recoveryError)setError(governanceError(recoveryError));}
 },[client,reportId,targetId,targetType,current,sourceView]);
 useEffect(()=>{
  const lifecycle=epoch,requests=sequence,gen=++lifecycle.current;
  const read=()=>{if(!current(gen)||document.hidden||working.current||reading.current)return;reading.current=true;void refresh().catch(e=>{if(current(gen)){setReadError(governanceError(e));setRecord(null);setItems([]);setSource(null);setPreview(null);setLoaded(true);}}).finally(()=>{if(current(gen))reading.current=false;});};
  const initial=setTimeout(read,0),timer=setInterval(read,20000);document.addEventListener('visibilitychange',read);
  return()=>{lifecycle.current++;requests.current++;clearTimeout(initial);clearInterval(timer);document.removeEventListener('visibilitychange',read);};
 },[refresh,current]);
 const {ready:draftReady,settle:settleDraft}=draft;
 useEffect(()=>{if(!client||!draftReady)return;const gen=epoch.current;void settleDraft(locator=>client.receipt(locator)).catch(e=>{if(current(gen))setError(governanceError(e));});},[client,draftReady,settleDraft,current]);
 async function run(fn:(active:TargetClient,gen:number)=>Promise<void>){
  const gen=epoch.current;if(!client||working.current||!current(gen))return;
  working.current=true;sequence.current++;setBusy(true);setError('');setNotice('');
  try{await fn(client,gen);}catch(e){if(current(gen))setError(governanceError(e));}
  finally{
   if(current(gen)){try{await refresh(false);}catch(e){if(current(gen))setError(governanceError(e));}}
   working.current=false;if(current(gen))setBusy(false);
  }
 }
 function change(patch:Partial<TargetDraft>){setPreview(null);draft.change(patch);}
 async function prepare(event:React.SubmitEvent<HTMLFormElement>){event.preventDefault();await run(async(active,gen)=>{
  const saved=await draft.snapshot();if(!current(gen))return;
  const base:Pick<TargetReport,'schemaVersion'|'id'|'summary'>={schemaVersion:2,id:crypto.randomUUID(),summary:fields.summary.trim()},recipients=[...viewers];
  let payload:TargetPayload;
  if(reportId){
   const fresh=await active.get(reportId);if(!current(gen))return;
   if(decision)recipients.push(...fresh.requiredDecisionViewers);
   const event={...base,reportId:fresh.reportId,expectedVersion:fresh.version};
   if(fields.action==='pause'||fields.action==='resolve'){
    if(!fresh.currentTarget)throw Error('target_version_or_source_unavailable');
    const targetVersion=fresh.currentTarget.version,until=Math.floor(Date.now()/1000)+fields.hours*3600;
    payload=fields.action==='pause'?{...event,kind:'pause',targetVersion,scopes:fields.scopes,until,rule:fields.rule}:
     {...event,kind:'resolve',targetVersion,verdict:fields.verdict,rule:fields.rule,restriction:fields.verdict==='upheld'&&fields.scopes.length?{scopes:fields.scopes,until}:null};
   }else if(simpleKind(fields.action))payload={...event,kind:fields.action};
   else throw Error('target_governance_state');
  }else{
   if(!target)return;const fresh=await active.target(target);if(!current(gen))return;
   payload=targetReportSchemaV2.parse({...base,target:fresh.target,category:fields.category});
  }
  const p=await active.prepare(reportId?'event':'report',payload,{viewers:[...new Set(recipients)].filter(id=>id!==subjectId)});if(!current(gen))return;
  setPreview({original:p,payload:targetPayload(p.payload),viewers:p.viewers,endpoint:p.endpoint,expiresAt:p.expiresAt,title:source?.title,revision:saved.revision});
 });}
 async function confirm(){if(!preview)return;const p=preview,gen=epoch.current;await run(async(active)=>{
  if(p.recovery){await active.reauthorize(p.original,{confirmed:true});}
  else{
   await draft.attach({operationId:p.payload.id,payloadHash:p.original.payloadHash,type:reportId?'event':'report',reportId:reportId??p.payload.id},p.revision);
   if(!current(gen))return;await active.execute(p.original,{confirmed:true});
  }
  await draft.settle(locator=>active.receipt(locator));if(gen!==epoch.current||!current(gen))return;
  setPreview(null);setNotice('已发送。');if(!reportId)navigate('/app/governance/'+('reportId' in p.payload?p.payload.reportId:p.payload.id));
 });}
 async function recover(p:Pick<TargetPending,'operationId'|'payloadHash'>,fromStopped=false){await run(async(active,gen)=>{
  const result=fromStopped?await active.continueStopped({operationId:p.operationId,payloadHash:p.payloadHash},{confirmed:true}):await active.resumePending(p.operationId);
  if(!current(gen))return;if(result.state==='acknowledged'){setNotice('上次的内容已发送。');return;}
  const value=await active.reviewAuthorization(p.operationId);if(!current(gen))return;
  if(value.state==='reauthorization-required')setPreview({...value,original:value,recovery:true,title:source?.title});
 });}
 const pendingHere=pending.filter(p=>!reportId&&!target?true:p.payload?(reportId?'reportId' in p.payload&&p.payload.reportId===reportId:p.type==='report'&&'target' in p.payload&&p.payload.target.id===target?.id):p.state==='stopped-local');
 const pendingElsewhere=pending.some(p=>p.state!=='stopped-local'&&!pendingHere.includes(p));
 const back=activeTarget?(activeTarget.type==='task'?'/app/tasks/':'/app/rooms/')+activeTarget.id:'/app/account';
 const reportSummary=record?.events.find(event=>(event.kind??'report')==='report')?.summary;
 const recordEvents=record?.events.filter((event):event is TargetEventProjection=>typeof event.kind==='string')??[];
 return <section className="governance-workspace">
  <a href={back} className="governance-back" onClick={e=>{e.preventDefault();navigate(back);}}><ArrowLeft size={16}/>{activeTarget?'回到原内容':'个人中心'}</a>
  <header><h1>{reportId?'举报详情':target?'举报这条内容':'举报与处理'}</h1>{record&&<p className="governance-state"><strong>{labels[record.state]??'查看处理情况'}</strong>{record.handling==='awaiting-authorized-independent-handler'&&' · 暂无处理者回应'}</p>}</header>
  {!connected?<div className="governance-empty"><p>连接身份后查看与你相关的记录。</p><Button onClick={()=>navigate('/app/settings/identity')}>连接身份</Button></div>:<>
   {(error||readError)&&<div className="message error" role="alert">{error||readError} <button className="text-link" disabled={busy} onClick={()=>run(()=>refresh())}>再试一次</button></div>}{notice&&<p className="message"><output>{notice}</output></p>}
   {!loaded&&<PageLoading label="正在读取…"/>}
   {(target||record)&&loaded&&<GovernanceSource source={source} navigate={navigate}/>}
   {record?.ownRestriction&&<p className="governance-state">当前影响：{record.ownRestriction.scopes.map(s=>labels[s]).join('、')}，至 {fullTime(record.ownRestriction.until)}。</p>}
   {reportSummary&&<section><h2>举报说明</h2><p className="reading-prose">{reportSummary}</p></section>}
   {record&&<GovernanceEvents events={recordEvents} subjectId={subjectId} names={names}/>}
   {!reportId&&loaded&&items.length>0&&<section><h2>{target?'已有的相关记录':'与你相关的记录'}</h2><div className="governance-list">{items.map(item=><a key={item.reportId} href={'/app/governance/'+item.reportId} onClick={e=>{e.preventDefault();navigate('/app/governance/'+item.reportId);}}><div><h2>{labels[item.state]??'举报记录'}</h2><p className="governance-excerpt">{item.events?.at(-1)?.summary??'说明当前未向你开放'}</p></div><ArrowRight size={18}/></a>)}</div>{next&&<Button variant="ghost" disabled={busy} onClick={()=>run(async()=>{pageCount.current++;await refresh(false);})}>更多记录</Button>}</section>}
   {!target&&!reportId&&loaded&&!items.length&&!error&&!readError&&<p className="governance-empty">还没有与你相关的举报记录。</p>}
   {pendingHere.map(p=><div className="governance-pending" key={p.operationId}><p>{p.state==='stopped-local'?'已停止继续发送。系统仍会确认之前的发送结果。':blocked[p.operationId]?'上次的内容仍保留，需要确认后继续。':'正在继续发送上次的内容…'}</p><div className="button-row">{blocked[p.operationId]&&p.state!=='stopped-local'&&<Button disabled={busy} onClick={()=>recover(p)}>查看并继续</Button>}{p.state!=='stopped-local'&&<button className="text-link" disabled={busy} onClick={()=>run(async active=>{await active.stopLocalRetry(p.operationId,{confirmed:true});})}>停止继续发送</button>}</div></div>)}
   {stoppedHere.length>0&&<details className="governance-technical" open={draftStopped||undefined}><summary>之前停止的发送</summary>{stoppedHere.map(p=><div key={p.operationId}><p>{p.type==='report'?'上次的举报说明':'上次的处理说明'} · 已停止继续发送</p>{p.canContinue?<Button variant="outline" disabled={busy||pending.length>0} onClick={()=>recover(p,true)}>继续这条原说明</Button>:<p>这台设备只保留了原记录的定位，不能重新发送原文。</p>}</div>)}{draftStopped&&<button className="text-link" disabled={busy} onClick={()=>change({...emptyDraft,action:reportId?'supplement':''})}>另写一条说明</button>}</details>}
   {pendingElsewhere&&<p className="governance-pending">另一条说明还在发送中，完成后可以继续。</p>}
   {record&&!formVisible&&choices.length>0&&!pendingHere.some(p=>p.state!=='stopped-local')&&<div className="governance-actions">{choices.map(kind=><Button key={kind} variant={kind==='supplement'?'default':'outline'} disabled={busy||!draft.ready||pendingElsewhere} onClick={()=>change({action:kind,summary:'',rule:'',scopes:[]})}>{labels[kind]}</Button>)}</div>}
   {formVisible&&!pendingHere.some(p=>p.state!=='stopped-local')&&<section className="governance-compose"><h2>{reportId?labels[fields.action]:'说明遇到的问题'}</h2><form onSubmit={prepare}>
    {!reportId&&<label>问题类型<select value={fields.category} disabled={!draft.ready||busy} onChange={e=>change({category:targetReportSchemaV2.shape.category.parse(e.target.value)})}>{Object.entries(categoryLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>}
    <label>{fields.action==='withdraw-report'?'撤回说明':'你的说明'}<Textarea required disabled={!draft.ready||busy} value={fields.summary} maxLength={1600} placeholder="描述与你有关的具体问题。" onChange={e=>change({summary:e.target.value})}/></label>
    {reportId&&['pause','resolve'].includes(fields.action)&&<><label htmlFor={ruleId}>依据<Input id={ruleId} required maxLength={120} disabled={busy} value={fields.rule} onChange={e=>change({rule:e.target.value})}/></label>{fields.action==='resolve'&&<label>处理决定<select value={fields.verdict} disabled={busy} onChange={e=>change({verdict:e.target.value==='upheld'?'upheld':'dismissed'})}><option value="dismissed">举报不成立，解除本次限制</option><option value="upheld">举报成立</option></select></label>}
     {(fields.action==='pause'||fields.verdict==='upheld')&&<><fieldset><legend>需要暂停的操作</legend>{scopeOptions.map(scope=><label key={scope} className="governance-check"><input type="checkbox" disabled={busy} checked={fields.scopes.includes(scope)} onChange={e=>change({scopes:e.target.checked?[...fields.scopes,scope]:fields.scopes.filter(s=>s!==scope)})}/>{labels[scope]}</label>)}</fieldset><label>持续时间<select value={fields.hours} disabled={busy} onChange={e=>change({hours:Number(e.target.value)})}>{[1,6,24,72,168,...fields.action==='resolve'?[720]:[]].map(h=><option value={h} key={h}>{h<24?h+' 小时':h/24+' 天'}</option>)}</select></label></>}
    </>}
    <section><p><strong>{availableViewers.length?'发送给':'仅本人可见'}</strong></p>{availableViewers.length?<><GovernancePeople ids={[...new Set([...viewers,...required])]} subjectId={subjectId} names={names}/><details className="governance-technical"><summary>调整接收人</summary>{availableViewers.map(id=><label key={id} className="governance-check"><input type="checkbox" checked={required.includes(id)||viewers.includes(id)} disabled={busy||required.includes(id)} onChange={e=>change({audienceChosen:true,viewers:e.target.checked?[...viewers,id]:viewers.filter(x=>x!==id)})}/>{memberName(id,subjectId,names[id]??undefined)}{required.includes(id)&&'（相关当事人）'}</label>)}</details></>:<p className="muted">目前没有处理者可接收，提交后会保存为你的私人记录。</p>}</section>
    {draft.status&&<p className="governance-draft-status"><output>{draft.status}</output></p>}<div className="button-row"><Button type="submit" disabled={busy||!draft.ready||!fields.summary.trim()||pendingElsewhere||(!reportId&&!currentTarget)}>预览说明</Button>{reportId&&<Button variant="ghost" type="button" disabled={busy} onClick={()=>change({action:''})}>收起</Button>}</div>
   </form></section>}
   {record&&<details className="governance-technical"><summary>记录详情</summary><dl><dt>记录编号</dt><dd>{record.reportId}</dd><dt>原内容版本</dt><dd>{record.target.version}</dd><dt>当前版本</dt><dd>{record.currentTarget?.version??'不可读取'}</dd></dl></details>}
   {reportId&&<p><a href="/app/governance" className="text-link" onClick={e=>{e.preventDefault();navigate('/app/governance');}}>全部相关记录 →</a></p>}
   <GovernancePreview value={preview} names={names} subjectId={subjectId} busy={busy} error={error} onConfirm={()=>void confirm()} onClose={()=>setPreview(null)}/>
  </>}
 </section>;
}
