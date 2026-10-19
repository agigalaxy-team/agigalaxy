import { ReadingDetails, ReadingSummary } from './reading-details';
import React, { useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { exactFactRef, getFactClient, latestFacts } from './fact-client.mjs';
import {exactReadableResult,isResultReference,readTaskResult,taskResultPath,taskResultReturn} from './task-result-navigation.mjs';
import {WorkResultReading} from './work-result-reading';
import { ciSourceMetadata } from '../../galaxy-official/src/shared/ci-observation-v2-schema.mjs';
import { githubReference } from '../../galaxy-official/src/shared/github-evidence-schema.mjs';
import { CiWorkspace } from './ci-workspace';
import {ConfigurationPicker} from './configuration-picker';
import {InterventionOpinions, ResolutionStatus} from './fact-presentation';
import {MemberAvatar,MemberLink,memberName,useMemberNames} from './conversation-ui';
import {Plus, X} from 'lucide-react';
import {useChoiceViewLease,type ChoiceViewLease} from './choice-retained-operations';
import {errorField,readOperationReceipt} from './task-operation-state';
import {readWorkCompose,requireWorkCompose,readWorkRecordLocators,recordText,isWorkRecordView,isWorkEvidence,readQueuedParticipation,workFormBlank as blank} from './work-fact-types';
import type {WorkFactAction,WorkFactActionKind,WorkFactClient,WorkFactPending,WorkFactReceipt,WorkFactRetry,WorkFacts,WorkResult,WorkForm,WorkTextField,WorkComposeValue,WorkComposeDraft,WorkRecordReading,WorkRecordView,WorkRecordLocator,WorkRecordType,WorkEditorTarget,WorkViewAuthority} from './work-fact-types';
import type {WorkProps,WorkRuntime} from './work-task-types';
import type {FactReference} from './work-fact-presentation-types';
import type {CapsuleSourceItem} from './capsule-authoring-types';
import './fact-workspace.css';
function requiredTarget(value:WorkEditorTarget|undefined){if(!value)throw Error('请重新选择原记录的准确版本。');return value;}
const attemptStates:Record<string,string>={running:'正在尝试',completed:'尝试已结束',inconclusive:'暂无结论',canceled:'已取消',abandoned:'已停止'};
const refsKey = (x: FactReference) => `${x.id}:${x.version}`;
const split = (s: string) =>
  s
    .split(/\n/)
    .map((x) => x.trim())
    .filter(Boolean);
const names: Record<string,string> = {
  diagnosis: '诊断',
  advice: '建议',
  'context-addition': '补充背景',
  'tool-introduction': '引入工具',
  patch: '补丁',
  review: '复核',
  takeover: '接管',
  verification: '验证',
  'scope-clarification': '范围澄清',
  'multi-node-collaboration': '多节点协作',
};
const outcomes: Record<string,string> = {
  succeeded: '达到所述结果',
  partial: '部分达到',
  failed: '未达到',
  inconclusive: '尚不明确',
  conflicting: '存在冲突',
};
const methods: Record<string,string> = {
  'participant-feedback': '参与者反馈',
  'requester-acceptance': '请求者接受反馈',
  'local-test': '实际本地测试',
  'unit-test': '单元测试',
  'integration-test': '集成测试',
  build: '构建',
  'ci-report': 'CI报告',
  'peer-review': '同行复核',
  'human-review': '人工评审',
  'production-validation': '实际生产验证',
};
function localNow() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function iso(s: string) {
  if (!s) throw new Error('请填写实际时间，未知时不要补造。');
  return new Date(s).toISOString();
}
const receiptMessages: Record<string, string> = {
  acknowledged: '上次提交已收到。正文仍按当前阅读权限打开。',
  absent: '尚未查到上次提交。原内容仍保留。',
  conflict: '上次提交的接收记录不一致，已停止继续发送。',
  none: '本机没有待确认的提交。',
  'result-unknown': '正在确认上次提交，原内容仍保留。',
};
const actionTitles:Record<string,string>={'attempt-start':'开始一次尝试','attempt-end':'这次尝试怎么样了','attempt-correct':'更正尝试记录',intervention:'写下做了什么','intervention-response':'回应这条工作记录','result-recorded':'补充结果',evidence:'添加来源',verification:'记录检查',deliver:'交给发起者', 'resolution-recorded':'说明解决情况',revoke:'撤回记录'};
const observationNames:Record<string,string>={current:'当前版本',superseded:'已有更正',revoked:'已撤回',unavailable:'当前不可读',unknown:'尚不明确',available:'当时可用',unreachable:'当时无法访问',removed:'已移除',passed:'所列检查通过',failed:'所列检查未通过',inconclusive:'尚无定论',comment:'反馈',accepted:'接受','partially-accepted':'部分接受',rejected:'不接受'};
function downloadRecord(value:unknown,name='galaxy-work-record.json'){
  const blob=new Blob([typeof value==='string'?value:JSON.stringify(value,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function WorkComposeCard({saved,busy,pending,sourceUnavailable,composeError,onResume,onDiscard}:{saved:WorkComposeDraft;busy:boolean;pending:boolean;sourceUnavailable:boolean;composeError:string;onResume:(draft:WorkComposeDraft)=>void;onDiscard:(draft:WorkComposeDraft)=>Promise<void>}){
 return <div className="work-compose-resume"><p>{saved.submission==='stopped-local'?'已停止继续发送，原稿仍保留。':saved.eventId||saved.operationId?'正在确认上次提交，原稿仍保留。':saved.value.kind==='deliver'?'有一份尚未发送的交付草稿。':'有一份尚未发送的工作草稿。'}</p><div className="button-row">
  {!saved.operationId&&!saved.eventId&&<><Button disabled={busy||pending||sourceUnavailable} onClick={()=>onResume(saved)}>继续编辑</Button><button className="text-action" disabled={busy} onClick={()=>void onDiscard(saved)}>放弃这份草稿</button></>}
  {(saved.submission==='stopped-local'||composeError)&&<button className="text-action" onClick={()=>downloadRecord(saved.value,'galaxy-work-draft.json')}>保存原稿</button>}
  {saved.submission==='stopped-local'&&<button className="text-action" disabled={busy} onClick={()=>void onDiscard(saved)}>另写新内容</button>}
 </div></div>;
}
function OriginalContent({item}:{item:{payloadJson:string}}){
 let value:unknown;try{value=JSON.parse(item.payloadJson);}catch{return <p>这份原内容需要在下载文件中核对。</p>;}
 if(!value||typeof value!=='object'||Array.isArray(value))return <p>这份原内容需要在下载文件中核对。</p>;
 const fields=[['title','标题'],['summary','内容'],['description','做过的事'],['strategy','方法'],['observedEffect','观察'],['limitations','限制'],['reason','原因'],['inputScopeSummary','使用的输入']],kind='kind' in value&&typeof value.kind==='string'?value.kind:'';
 const body=fields.flatMap(([key,label])=>{const field:unknown=Reflect.get(value,key);return typeof field==='string'&&field?[{key,label,text:field}]:[];});
 return <article className="original-work-content"><h4>{actionTitles[kind]??'工作背景'}</h4>{body.map(field=><div key={field.key}><small>{field.label}</small><p className="reading-prose">{field.text}</p></div>)}<button type="button" className="text-action" onClick={()=>downloadRecord(item.payloadJson,'galaxy-original-work.json')}>保存完整原文</button></article>;
}
function factError(error:unknown){
 const code=errorField(error,'code'),message=errorField(error,'message');
 if(/authority_changed|binding|身份或连接/.test(code||message))return '身份或连接已改变，请重新读取当前记录；原操作仍按原编号查询。';
 return /[\u3400-\u9fff]/.test(message)?message:'当前事实或来源暂时无法读取，请稍后重试；原操作回执可单独查询。';
}
function readWorkView(){const value=new URLSearchParams(location.search).get('record');return value&&['progress','results','evidence'].includes(value)?value:'progress';}

// Original receipt locators belong to the current local identity. They do not
// depend on a readable Task/Case, and they never stand in for a current body.
type RecoveryProps={runtime:WorkRuntime;subjectId?:string;taskId:string;connected:boolean};
export function FactReceiptRecovery(props:RecoveryProps){
 const view=useChoiceViewLease(props.runtime,props.subjectId);
 return props.connected&&props.subjectId&&view.lease?<ReceiptRecoverySession key={props.taskId+':'+view.key} {...props} subjectId={props.subjectId} lease={view.lease}/>:null;
}
function ReceiptRecoverySession({runtime,subjectId,taskId,lease}:RecoveryProps&{subjectId:string;lease:ChoiceViewLease}){
 const client=useMemo<WorkFactClient>(()=>getFactClient(runtime,subjectId),[runtime,subjectId]),generation=useRef(0),working=useRef(false);
 const [pending,setPending]=useState<WorkFactPending|null>(null),[receipt,setReceipt]=useState<WorkFactReceipt|null>(null),
  [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const capture=useCallback(()=>{const epoch=generation.current;const check=()=>{lease.assertCurrent();if(epoch!==generation.current)throw Error('身份或连接已改变，请重新查询原操作。');};check();return {check,isCurrent:()=>{try{check();return true;}catch{return false;}}};},[lease]);
 const query=useCallback(async()=>{
  if(working.current)return;const original=capture();working.current=true;setBusy(true);setError('');setReceipt(null);
  try{const result=await client.reconcile(taskId);original.check();setReceipt(result);if(result.state==='acknowledged'||result.state==='none')setPending(null);}
  catch(reason){if(original.isCurrent()){setPending(null);const code=errorField(reason,'code');setError(['fact_authority_changed','receipt_status_authority_changed'].includes(code)?'身份或连接已改变，请重新查询原操作。':code==='fact_operation_invalid'?'本机原操作与回执定位不一致，已停止展示；请保留原记录以便核对。':'暂未取得确定的原操作回执，请保留原任务链接并稍后查询。');}}
  finally{if(original.isCurrent()){working.current=false;setBusy(false);}}
 },[client,taskId,capture]);
 useEffect(()=>{
  const viewGeneration=generation;viewGeneration.current++;const original=capture();
  void client.pending(taskId).then(async value=>{original.check();setPending(value);if(value)await query();})
   .catch(()=>{if(original.isCurrent())setError('本机原操作暂未读取，请重新查询；这不表示服务未收到提交。');})
   .finally(()=>{if(original.isCurrent())setLoading(false);});
  const visible=()=>{if(!document.hidden)void query();},timer=window.setInterval(visible,20000);document.addEventListener('visibilitychange',visible);
  return()=>{viewGeneration.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[client,taskId,capture,query]);
 if(!pending&&(!receipt||receipt.state==='none')&&!error)return null;
 const locator=receipt?.operationId?receipt:pending;
 return <section className="message" aria-label="上次提交"><h2>上次提交</h2>
  {loading&&<p><output>正在确认…</output></p>}{error&&<p className="message error" role="alert">{error}</p>}
  {receipt&&<p><output>{receiptMessages[receipt.state??'']??receiptMessages['result-unknown']}</output></p>}
  {locator&&<ReadingDetails><ReadingSummary>查看原操作编号与载荷摘要</ReadingSummary><p>原操作：<code style={{overflowWrap:'anywhere'}}>{locator.operationId}</code></p><p>原载荷摘要：<code style={{overflowWrap:'anywhere'}}>{locator.payloadHash}</code></p></ReadingDetails>}
  {error&&<Button type="button" variant="outline" disabled={loading||busy} onClick={()=>void query()}>再试一次</Button>}
 </section>;
}
export function FactWorkspace(props:WorkProps){
 const view=useChoiceViewLease(props.runtime,props.subjectId);
 return props.connected&&props.task.schemaVersion===2&&props.subjectId&&view.lease?<FactSession key={JSON.stringify([props.task.taskId,props.task.caseId,view.key])} {...props} subjectId={props.subjectId} lease={view.lease}/>:null;
}
function FactSession({task,runtime,subjectId,connected,refresh,navigate,lease}:WorkProps&{subjectId:string;lease:ChoiceViewLease}) {
  const requester=task.requesterId===subjectId,own=useMemo(()=>(task.participations??[]).filter(p=>p.subjectId===subjectId&&['active','delivered','accepted','disputed'].includes(p.state)),[task.participations,subjectId]);
  const generation = useRef(0),active=useRef(true);
  const working=useRef(false),editor=useRef<HTMLDialogElement>(null);
  const [workView,setWorkViewState]=useState(readWorkView),[resultSelection,setResultSelection]=useState(()=>readTaskResult(location.search));
  const routeSearch=location.search;
  function setWorkView(value:string){setWorkViewState(value);const url=new URL(location.href);url.searchParams.set('record',value);for(const key of ['result','resultVersion','delivery'])url.searchParams.delete(key);window.history.replaceState(window.history.state,'',url.pathname+url.search+url.hash);setResultSelection(readTaskResult(url.search));window.dispatchEvent(new Event('galaxy:route-view-changed'));}
  useEffect(()=>{const read=()=>{setWorkViewState(readWorkView());setResultSelection(readTaskResult(location.search));};read();window.addEventListener('popstate',read);window.addEventListener('galaxy:route-view-changed',read);return()=>{window.removeEventListener('popstate',read);window.removeEventListener('galaxy:route-view-changed',read);};},[task.taskId,routeSearch]);
  const client = useMemo<WorkFactClient>(
    () => getFactClient(runtime, subjectId),
    [runtime, subjectId],
  );
  const [facts, setFacts] = useState<WorkFacts|null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState<WorkFactPending|null>(null);
  const [retryPreview, setRetryPreview] = useState<{value:WorkFactRetry;authority:WorkViewAuthority}|null>(null), [recoveryState, setRecoveryState] = useState<WorkFactReceipt|null>(null);
  const [action, setAction] = useState<WorkFactAction|null>(null),
    [form, setForm] = useState<WorkForm>(blank),
    [participationId, setParticipationId] = useState(()=>own[0]?.participationId??''),
    [viewers, setViewers] = useState<string[]>(()=>requester?[]:[task.requesterId]);
  useEffect(()=>{if(action)editor.current?.showModal();else editor.current?.close();},[action]);
  const [records, setRecords] = useState<WorkRecordReading[]>([]),
    [sourceError, setSourceError] = useState(''),
    [moreSources, setMoreSources] = useState(false),
    [recordId, setRecordId] = useState(''),
    [recordType, setRecordType] = useState<WorkRecordType>('evidence'),
    [recordSelected, setRecordSelected] = useState<string[]>([]),
    [related, setRelated] = useState<string[]>([]);
  const sourceLimit=useRef(100);
  const [configurationConditions,setConfigurationConditions]=useState<CapsuleSourceItem[]>([]),[configurationSources,setConfigurationSources]=useState<CapsuleSourceItem[]>([]);
  const [composeDraft,setComposeDraft]=useState<WorkComposeDraft|null>(null),[deliveryDrafts,setDeliveryDrafts]=useState<WorkComposeDraft[]>([]),[composeReady,setComposeReady]=useState(false),[composeError,setComposeError]=useState('');
  const deliveryHeads=useRef<Record<string,string|null>>({});
  const composeDrafts=[...(composeDraft?[composeDraft]:[]),...deliveryDrafts],hasSavedDraft=composeDrafts.length>0;
  const participant=own.find(p=>p.participationId===participationId)??null,inputId=useId();
  const captureView=useCallback(()=>{
    const epoch=generation.current,check=()=>{lease.assertCurrent();if(!active.current||epoch!==generation.current)throw Error('事实页身份或连接已改变，请重新读取当前记录。');};
    check();return {check,isCurrent:()=>{try{check();return true;}catch{return false;}}};
  },[lease]);
  const composeHead=useRef<string|null>(null),composeQueue=useRef<Promise<unknown>>(Promise.resolve()),composeWrites=useRef(0),composeBlocked=useRef(false),composeBaseline=useRef(''),actionRef=useRef(action);
  useLayoutEffect(()=>{actionRef.current=action;},[action]);
  const composeInput=useMemo<WorkComposeValue|null>(()=>action?{ui:'work-editor-v1',kind:action.kind,targetRef:action.target?{id:action.target.id,version:action.target.version,type:action.target.type??null}:null,participationId,participationScopeVersion:participant?.scopeVersion??null,form,viewers,related,recordSelected,configurationConditions,configurationSources}:null,[action,participationId,participant?.scopeVersion,form,viewers,related,recordSelected,configurationConditions,configurationSources]);
  function composeValue(){if(!composeInput)throw Error('请先打开原编写稿。');return composeInput;}
  const retainCompose=useCallback((saved:WorkComposeDraft,value:WorkComposeValue)=>{if(value.kind==='deliver')setDeliveryDrafts(current=>[...current.filter(item=>item.participationId!==value.participationId),saved]);else setComposeDraft(saved);},[]);
  const persistCompose=useCallback((value:WorkComposeValue)=>{
    const scope=captureView();composeBaseline.current=JSON.stringify(value);composeWrites.current++;
    const next=composeQueue.current.then(async()=>{
      scope.check();const saved=requireWorkCompose(value.kind==='deliver'?await runtime.saveParticipationComposeDraft(task.taskId,value.participationId,value,{expectedRevision:deliveryHeads.current[value.participationId]??null}):await client.saveComposeDraft(task.taskId,value,{expectedRevision:composeHead.current}));
      scope.check();if(value.kind==='deliver')deliveryHeads.current[value.participationId]=saved.revision;else composeHead.current=saved.revision;
      composeBlocked.current=false;retainCompose(saved,value);setComposeError('');return saved;
    });
    composeQueue.current=next.then(()=>undefined,()=>undefined);void next.finally(()=>{composeWrites.current--;}).catch(()=>{});return next;
  },[captureView,runtime,client,task.taskId,retainCompose]);
  const readCompose=useCallback(async(force=false)=>{
    const scope=captureView(),[raw,rawDeliveries]=await Promise.all([client.readComposeDraft(task.taskId),Promise.all(own.map(item=>runtime.readParticipationComposeDraft(task.taskId,item.participationId)))]);
    scope.check();const saved=readWorkCompose(raw),deliveries=rawDeliveries.map(readWorkCompose);
    if(force||!actionRef.current&&!composeWrites.current&&!composeBlocked.current){
      composeHead.current=saved?.revision??null;deliveryHeads.current=Object.fromEntries(own.map((item,index)=>[item.participationId,deliveries[index]?.revision??null]));
      setComposeDraft(saved);setDeliveryDrafts(deliveries.filter(item=>item!==null));setComposeReady(true);
    }return saved;
  },[captureView,client,runtime,task.taskId,own]);
  const hasComposeChanges=()=>JSON.stringify(composeValue())!==composeBaseline.current;
  useEffect(()=>{
    if(!composeReady||!composeInput||action?.pendingOperation||busy||pending||JSON.stringify(composeInput)===composeBaseline.current)return;
    const scope=captureView();void persistCompose(composeInput).catch(()=>{if(scope.isCurrent()){composeBlocked.current=true;setComposeError('本机草稿未能保存。本页输入仍在，可以保存一份文件，再读取另一页面的版本。');}});
  },[composeReady,composeInput,action?.pendingOperation,busy,pending,captureView,persistCompose]);
  function closeEditor(){if(busy)return;if(action&&!action.pendingOperation){const value=composeValue(),head=value.kind==='deliver'?deliveryHeads.current[value.participationId]:composeHead.current;if(head||composeWrites.current||composeBlocked.current||hasComposeChanges())retainCompose({value,revision:head??null,participationId:value.participationId},value);}setAction(null);}
  function resumeCompose(saved:WorkComposeDraft){
    const authority=captureView();
    const value=saved?.value;if(!value||value.ui!=='work-editor-v1'||saved.operationId||saved.eventId)return;
    let target;
    if(value.targetRef){const reference=value.targetRef;const candidates=['evidence','verification','revoke'].includes(value.kind)?records.filter(isWorkRecordView):[...attempts,...interventions,...results];target=candidates.find(item=>item.id===reference.id&&item.version===reference.version);if(!target){setComposeError('这份草稿关联的原记录已变化或暂不可读。输入仍保留，可以先保存一份文件。');return;}}
    const originalParticipation=own.find(item=>item.participationId===value.participationId);
    if(value.participationId&&(!originalParticipation||value.participationScopeVersion!=null&&value.participationScopeVersion!==originalParticipation.scopeVersion)){setComposeError('这份草稿原先的参与范围已变化或当前不可用，原输入仍保留。');return;}
    if(value.kind==='deliver'&&!results.some(item=>refsKey(item)===value.form?.resultChoice&&item.actorId===subjectId&&item.participationId===value.participationId&&item.participationScopeVersion===originalParticipation?.scopeVersion)){setComposeError('这份草稿关联的结果已变化或当前不可读，原输入仍保留。');return;}
    composeBaseline.current=JSON.stringify({...value,participationScopeVersion:originalParticipation?.scopeVersion??null,form:{...blank,...value.form}});
    setParticipationId(value.participationId??'');setForm({...blank,...value.form});setViewers(value.viewers??[]);setRelated(value.related??[]);setRecordSelected(value.recordSelected??[]);setConfigurationConditions(value.configurationConditions??[]);setConfigurationSources(value.configurationSources??[]);setAction({kind:value.kind,target,authority});setComposeError('');
  }
  async function discardCompose(saved:WorkComposeDraft){const scope=captureView();await composeQueue.current;scope.check();const value=saved.value,revision=saved.revision;if(revision){if(value.kind==='deliver')await runtime.clearParticipationComposeDraft(task.taskId,value.participationId,{revision});else await client.clearComposeDraft(task.taskId,{revision});}scope.check();composeBlocked.current=false;setComposeError('');await readCompose(true);}
  const discardSavedCompose=(saved:WorkComposeDraft)=>run(()=>discardCompose(saved));
  const attempts = latestFacts(facts?.attempts ?? []),
    interventions = latestFacts(facts?.interventions ?? []),
    results = latestFacts(facts?.results ?? []);
  const selectedResult=exactReadableResult(facts?.results??[],resultSelection.reference),resultDetail=workView==='results'&&resultSelection.selected;
  const sourceDelivery=task.participations?.flatMap(item=>item.deliveries??[]).find(item=>item.deliveryId===resultSelection.deliveryId),deliveredVersion=sourceDelivery?.resultRef?.id===selectedResult?.id&&sourceDelivery?.resultRef?.version===selectedResult?.version;
  const verificationTargets:[string,WorkEditorTarget[]][]=[['attempt',attempts],['intervention',interventions],['result',results]];
  const ownOrigins = [
    ...attempts.map(x => ({ ...x, kind: 'attempt' as const })),
    ...interventions.map(x => ({ ...x, kind: 'intervention' as const })),
  ].filter(
    x =>
      x.actorId === subjectId &&
      x.participationId === (participant?.participationId ?? null),
  );
  const eligibleResults = results.filter(
    x =>
      x.actorId === subjectId &&
      x.participationId === participant?.participationId &&
      x.participationScopeVersion === participant?.scopeVersion,
  );
  const evidence = records.filter(isWorkRecordView).filter(
      (r) =>
        r.type === 'evidence' && r.referenceStatus === 'current' && r.record,
    ),
    verifications = records.filter(isWorkRecordView).filter(
      (r) =>
        r.type === 'verification' &&
        r.referenceStatus === 'current' &&
        r.record,
    );
  const memberNames=useMemberNames(runtime,subjectId,connected,[task.requesterId,...(task.participations??[]).map(p=>p.subjectId),...attempts.map(i=>i.actorId),...interventions.flatMap(i=>[i.actorId,...(i.responses??[]).map(r=>r.actorId)]),...results.map(i=>i.actorId),...records.map(i=>i.record?.reportedBy)]);
  const person=(id:string|null|undefined)=>memberName(id??undefined,subjectId,id?memberNames[id]??undefined:undefined);
  const selectedEvidence = evidence.filter((x) =>
      recordSelected.includes(refsKey(x)),
    ),
    selectedVerifications = verifications.filter((x) =>
      recordSelected.includes(refsKey(x)),
    );
  const catalogKey = `task-record-refs:${task.taskId}`;
  async function remember(view: WorkRecordView) {
    const scope = captureView();
    const refs = readWorkRecordLocators(await runtime.getLocal(catalogKey));
    scope.check();
    const next = [
      ...refs.filter(x => !(x.id === view.id && x.type === view.type)),
      { id: view.id, type: view.type },
    ];
    await runtime.putLocal(catalogKey, next);
    scope.check();
    return view;
  }
  async function load(originalPending?:WorkFactPending|null) {
    if (!client || !connected) return;
    const scope = captureView();
    // A historical operation is independently discoverable when its current
    // Case body cannot be read. Never use current content as an ACK oracle.
    let waiting = originalPending===undefined?await client.pending(task.taskId):originalPending;
    scope.check();
    let effectiveTask=task;
    if(waiting){
      try{
        const resumed=await client.resumePending(task.taskId);
        scope.check();setRecoveryState(resumed);
        if(resumed.state==='acknowledged'||resumed.caseVersion){
          setNotice('上次工作记录已保存。');
          if(!task.caseId&&resumed.caseId){effectiveTask={...task,caseId:resumed.caseId};void refresh();}
        }
        waiting=await client.pending(task.taskId);scope.check();
      }catch(reason){scope.check();setError(factError(reason));}
    }
    setPending(waiting);
    await readCompose();scope.check();
    let f;
    try { f = await client.readCase(effectiveTask); }
    catch (reason) { scope.check(); setFacts(null); setRecords([]); throw reason; }
    scope.check();
    setFacts(f);
    let discovered:WorkRecordLocator[]=[];
    try{if(effectiveTask.caseId)discovered=(await client.discoverRecordRefs(effectiveTask)).refs;scope.check();setSourceError('');}
    catch{scope.check();setSourceError('部分来源暂时无法读取，连接恢复后会继续更新。');}
    const saved = readWorkRecordLocators(await runtime.getLocal(catalogKey)),
      all:WorkRecordLocator[] = [
        ...discovered,
        ...saved,
        ...(f?.results ?? []).flatMap(r =>
          r.deliverableRefs
            .filter(x => x.kind === 'evidence')
            .map(x => ({ id: x.id, type: 'evidence' as const })),
        ),
        ...(f?.resolutions ?? []).flatMap(r =>
          r.verificationRefs.map(x => ({
            id: x.id,
            type: 'verification' as const,
          })),
        ),
      ];
    scope.check();
    const allUnique = [
        ...new Map(all.map(x => [x.type + ':' + x.id, x])).values(),
      ],unique=allUnique.slice(0,sourceLimit.current),
      list:WorkRecordReading[] = [];
    for (const ref of unique) {
      scope.check();
      try {
        const record = await client.readRecord(ref);
        scope.check();
        list.push(record);
      } catch (e) {
        scope.check();
        list.push({
          ...ref,
          record: null,
          referenceStatus: 'unavailable',
          reason: errorField(e,'message'),
        });
      }
    }
    scope.check();
    setRecords(list);
    setMoreSources(allUnique.length>sourceLimit.current);
  }
  const loadLatest=useEffectEvent(load);
  useEffect(()=>{
    const viewGeneration=generation,viewActive=active;viewGeneration.current++;viewActive.current=true;const scope=captureView();
    void client.pending(task.taskId).then(waiting=>{scope.check();return loadLatest(waiting);}).catch((error:unknown)=>{if(scope.isCurrent())setError(factError(error));});
    const reload=()=>{if(document.visibilityState==='visible'&&!working.current)void loadLatest().catch(()=>{});};
    const timer=window.setInterval(reload,20000);document.addEventListener('visibilitychange',reload);
    return()=>{viewActive.current=false;viewGeneration.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',reload);};
  },[captureView,client,task.taskId]);
  useEffect(() => {
    const operation = action?.pendingOperation;
    if (!operation || !connected || operation.taskId !== task.taskId) return;
    const participant = task.participations?.find(item => item.participationId === operation.participationId);
    if (!participant?.deliveries?.some(item => item.deliveryId === operation.eventId)) return;
    let current = true;
    const scope = captureView();
    runtime.api.call('/v2/tasks/receipt', { taskId: operation.taskId, eventId: operation.eventId, payloadHash: operation.payloadHash }).then((value: unknown) => {
      const receipt=readOperationReceipt(value);
      if (current && scope.isCurrent() && receipt.state === 'acknowledged' && receipt.taskId === operation.taskId
        && receipt.eventId === operation.eventId && receipt.payloadHash === operation.payloadHash) {
        setAction(draft => draft === action ? null : draft);
        setNotice('这份交付已收到。');
      }
    }).catch(() => { /* Preserve the submitted draft until its exact receipt is available. */ });
    return () => { current = false; };
  }, [task, action, runtime, connected, captureView]);
  async function run(fn: (check: () => void) => Promise<void>) {
    if (working.current) return;
    let scope;
    try { scope = captureView(); } catch { return; }
    const originalAction = action, originalPreview = retryPreview;
    setBusy(true);
    working.current=true;
    setError('');
    // Preserve an acknowledged historical result when a later body read fails.
    try {
      await fn(scope.check);
      scope.check();
    } catch (e) {
      const code=errorField(e,'code'),resultUnknown=typeof e==='object'&&e!==null&&'resultUnknown' in e&&e.resultUnknown===true;
      if (scope.isCurrent()) {
        setError(resultUnknown ? `${factError(e)} 原操作结果未知，请先查询。` : factError(e));
        if (resultUnknown || ['fact_authority_changed', 'receipt_status_authority_changed'].includes(code))
          setAction(current => current === originalAction ? null : current);
        if (['fact_reauthorization_review_required', 'consent_reauthorization_required', 'consent_required'].includes(code))
          setError('原操作尚未找到回执，原授权已不可继续。请预览准确原载荷和接收方，再明确确认新的私有授权。');
        if (code === 'fact_retry_preview_changed' || code === 'fact_authority_changed' || code === 'receipt_status_authority_changed')
          setRetryPreview(current => current === originalPreview ? null : current);
      }
    } finally {
      if (scope.isCurrent()) {
        try {
          const waiting = await client.pending(task.taskId);
          scope.check();
          setPending(waiting);
          await readCompose();
        } catch { /* A stale read must not update the new scope. */ }
        if (scope.isCurrent()) { setBusy(false); working.current=false; }
      }
    }
  }
  function presentReceipt(result: WorkFactReceipt) {
    setRecoveryState(result);
    setNotice(receiptMessages[result.state??''] ?? receiptMessages['result-unknown']);
    if (result.state !== 'absent') setRetryPreview(null);
  }
  async function recover(retry = false) {
    const scope = captureView();
    let result = retry ? await client.resumePending(task.taskId) : await client.reconcile(task.taskId);
    scope.check();
    if (!result.state) { result = await client.reconcile(task.taskId); scope.check(); }
    presentReceipt(result);
    if(result.state==='acknowledged'||result.caseVersion){await refresh();scope.check();await load();}
  }
  async function previewOriginalRetry() {
    const scope = captureView();
    const preview = await client.prepareRetry(task.taskId);
    scope.check();
    if ('previewId' in preview) { setRetryPreview({ value: preview, authority: scope }); setNotice('请确认下面这份原内容的阅读范围。'); }
    else presentReceipt(preview);
  }
  async function confirmOriginalRetry() {
    const selected = retryPreview;if(!selected)return;const scope = captureView();
    selected.authority.check();
    let result = await client.confirmRetry(selected.value, { confirmed: true });
    scope.check();
    if (!result.state) { result = await client.reconcile(task.taskId); scope.check(); }
    setRetryPreview(current => current === selected ? null : current);
    presentReceipt(result);
  }
  function choose(kind: WorkFactActionKind, target?: WorkEditorTarget, values:Partial<WorkForm>={}) {
    if(hasSavedDraft||!composeReady||pending||(task.caseId&&!facts))return;
    const ci = /^github-actions:([^/]+)\/([^:]+):run:(\d+):attempt:(\d+)$/.exec(
      target?.record?.source?.externalStableId ?? '',
    );
    setAction({ kind, target, authority: captureView() });
    setNotice('');
    setConfigurationConditions([]);
    setConfigurationSources([...(target?.sourceRefs??[]),...(target?.deliverableRefs??[])].filter(x=>x.kind==='configuration').map(ref=>({ref:{kind:'configuration' as const,id:ref.id,version:ref.version},label:'原版本明确配置来源'})));
    const delivering=kind==='deliver'?eligibleResults.find(item=>refsKey(item)===(values.resultChoice??''))??eligibleResults[0]:null;
    const nextRelated=delivering?.origin.kind==='intervention'?[refsKey(delivering.origin)]:target?.affectsAttemptIds??[];
    const nextRecords=delivering?delivering.deliverableRefs.filter(ref=>ref.kind==='evidence').map(refsKey):(target?.record?.evidenceRefs??[]).map(refsKey);
    setRelated(nextRelated);
    setRecordSelected(nextRecords);
    if (target?.record) setParticipationId(target.record.participationId ?? '');
    const nextForm={
      ...blank,
      observedAt: localNow(),
      ...(target && !target.record
        ? {
            summary: target.summary ?? '',
            description: target.description ?? '',
            observedEffect: target.observedEffect ?? '',
            limitations: Array.isArray(target.limitations)?target.limitations.join('\n'):target.limitations??'',
            failureReason: target.failureReason ?? '',
            outcome:
              target.reportedOutcome === 'unrecorded'
                ? 'inconclusive'
                : (target.reportedOutcome ?? 'inconclusive'),
            status:
              target.status === 'running'
                ? 'completed'
                : (target.status ?? 'completed'),
            type: target.types?.[0] ?? 'diagnosis',
          }
        : {}),
      ...(kind === 'intervention-response' ? { status: '' } : {}),
      ...(target?.strategy ? { strategy: target.strategy } : {}),
      ...(target?.record
        ? {
            summary: target.record.summary??'',
            reason: '',
            originSystem: target.record.source?.originSystem ?? '',
            externalStableId: target.record.source?.externalStableId ?? '',
            contentVersion: target.record.source?.contentVersion ?? '',
            issuer: target.record.source?.issuer ?? '',
            uri: target.record.source?.uri ?? '',
            evidenceType: target.record.evidenceType ?? 'self-assertion',
            sourceState: target.record.reportedSourceState ?? 'unknown',
            ...(ci
              ? {
                  ciOwner: ci[1],
                  ciRepository: ci[2],
                  ciRunId: ci[3],
                  ciAttempt: ci[4],
                  ciCommit: target.record.source?.contentVersion??'',
                }
              : {}),
            method: target.record.method ?? 'participant-feedback',
            scope: target.record.scope ?? '',
            conditions: recordText(target.record.conditions?.environment),
            command: recordText(target.record.conditions?.commandOrMethod),
            observation: target.record.observation ?? 'comment',
            relationship: target.record.relationship ?? 'unknown',
            originalAt: target.record.source?.originalAt
              ? new Date(
                  Date.parse(target.record.source.originalAt) -
                    new Date().getTimezoneOffset() * 60000,
                )
                  .toISOString()
                  .slice(0, 16)
              : '',
          }
        : {}),
      ...(kind === 'result-recorded'
        ? {
            sourceChoice: target?.origin
              ? refsKey(target.origin)
              : ownOrigins[0]
                ? refsKey(ownOrigins[0])
                : '',
          }
        : {}),
      ...(kind === 'deliver'
        ? {
            resultChoice: delivering ? refsKey(delivering) : '',summary:delivering?.summary??'',
          }
        : {}),
      ...(kind === 'verification'
        ? {
            sourceChoice: target?.record?.target
              ? target.record.target.type + ':' + refsKey(target.record.target)
              : results[0]
                ? 'result:' + refsKey(results[0])
                : '',
          }
        : {}),
      ...values,
    };
    setForm(nextForm);
    const nextParticipationId=target?.record?target.record.participationId??'':participationId;
    composeBaseline.current=JSON.stringify({ui:'work-editor-v1',kind,targetRef:target?{id:target.id,version:target.version,type:target.type??null}:null,participationId:nextParticipationId,participationScopeVersion:own.find(item=>item.participationId===nextParticipationId)?.scopeVersion??null,form:nextForm,viewers,related:nextRelated,recordSelected:nextRecords,configurationConditions:[],configurationSources:[...(target?.sourceRefs??[]),...(target?.deliverableRefs??[])].filter(x=>x.kind==='configuration').map(ref=>({ref,label:'原版本明确配置来源'}))});
  }
  function draft(kind: WorkFactActionKind) {
    const fields: Record<string,unknown> = { kind };
    const target = action?.target;
    if (kind === 'attempt-start')
      Object.assign(fields, {
        role: participant?.role ?? 'requester',
        strategy: form.strategy,
        environment: {
          name: form.environment || 'unknown',
          version: form.environmentVersion || 'unknown',
        },
        inputScopeSummary: form.inputScope,
        permissionScope: split(form.permissionScope),
        configurationRef:configurationConditions[0]?exactFactRef(configurationConditions[0].ref):null,
      });
    if (['attempt-end', 'attempt-correct'].includes(kind))
      Object.assign(fields, {
        attemptRef: exactFactRef(requiredTarget(target)),
        taskScopeVersion: requiredTarget(target).scopeVersion,
        status: form.status,
        summary: form.summary,
        reportedOutcome: form.outcome,
        failureReason: form.failureReason,
        ...(kind === 'attempt-correct' ? { reason: form.reason } : {}),
      });
    if (kind === 'intervention')
      Object.assign(fields, {
        types: [form.type],
        affectsAttemptIds: related,
        description: form.description,
        sourceRefs: [...configurationSources.map(x=>x.ref),...selectedEvidence.map((r) => ({
          kind: 'evidence',
          ...exactFactRef(r),
        }))],
        observedEffect: form.observedEffect,
        ...(target ? { supersedes: exactFactRef(requiredTarget(target)) } : {}),
      });
    if (kind === 'intervention-response')
      Object.assign(fields, {
        interventionRef: exactFactRef(requiredTarget(target)),
        state: form.status,
        summary: form.summary,
      });
    if (kind === 'result-recorded') {
      const origin = ownOrigins.find(
        x => refsKey(x) === form.sourceChoice,
      );
      if (!origin) throw new Error('请选择本人真实来源及精确版本。');
      Object.assign(fields, {
        origin: { kind: origin.kind, ...exactFactRef(origin) },
        scopeVersion: origin.scopeVersion,
        deliverableRefs: [...configurationSources.map(x=>x.ref),...selectedEvidence.map((r) => ({
          kind: 'evidence',
          ...exactFactRef(r),
        }))],
        reportedOutcome: form.outcome,
        summary: form.summary,
        limitations: form.limitations,
        supersedes: target ? exactFactRef(requiredTarget(target)) : null,
      });
    }
    if (kind === 'resolution-recorded')
      Object.assign(fields, {
        status: form.resolution,
        summary: form.summary,
        satisfiedGoals: split(form.satisfied),
        remainingGoals: split(form.remaining),
        resultRefs: results
          .filter(x => related.includes(refsKey(x)))
          .map(exactFactRef),
        verificationRefs: selectedVerifications.map(exactFactRef),
        supersedesResolutionId: facts?.resolutions.at(-1)?.id ?? null,
      });
    return fields;
  }
  async function save() {
    if (!action||action.pendingOperation) return;
    action.authority?.check();
    const scope = captureView();
    const kind = action.kind;
    const savedDraft=await persistCompose(composeValue());
    scope.check();
    const composeRevision=savedDraft.revision??undefined;
    let receipt:WorkFactReceipt;
    if (kind === 'deliver') {
      const result = eligibleResults.find(
        x => refsKey(x) === form.resultChoice,
      );
      if (!participant || !result)
        throw new Error('请选择这次参与范围内的本人结果。');
      const delivery = {
          kind: 'deliver',
          expectedParticipationVersion: participant.version,
          resultRef: exactFactRef(result),
          interventionRefs: interventions
            .filter(x => related.includes(refsKey(x)))
            .map(exactFactRef),
          evidenceRefs: selectedEvidence.map(exactFactRef),
          summary: form.summary,
        };
      try {
        receipt = await runtime.participationEvent(
          task.taskId, participant.participationId, delivery,
          { viewers: [task.requesterId], confirmed: true, composeRevision },
        );
        scope.check();
      } catch (error) {
        scope.check();
        // Retain this confirmed draft until the exact operation is acknowledged.
        // Disable a fresh submission while its original receipt is unresolved.
        try {
          const queued=readQueuedParticipation(await runtime.getLocal(`task-event:${task.taskId}`));scope.check();const saved=queued?.payload;
          if(queued&&saved?.kind==='deliver'&&queued.taskId===task.taskId&&queued.path===`/v2/participations/${participant.participationId}/events`
            &&queued.eventId===saved.eventId&&saved.expectedParticipationVersion===delivery.expectedParticipationVersion
            &&saved.summary===delivery.summary&&JSON.stringify(saved.resultRef)===JSON.stringify(delivery.resultRef)
            &&JSON.stringify(saved.interventionRefs)===JSON.stringify(delivery.interventionRefs)
            &&JSON.stringify(saved.evidenceRefs)===JSON.stringify(delivery.evidenceRefs)){
            setAction(current => current === action ? { ...current, pendingOperation: { taskId: task.taskId, eventId: queued.eventId, payloadHash: queued.payloadHash, participationId: participant.participationId } } : current);
            setNotice('交付内容已保留，正在确认是否收到。');
          }
        } catch { /* Keep the draft if its saved operation cannot be established. */ }
        throw error;
      }
    } else if (['evidence', 'verification', 'revoke'].includes(kind)) {
      let fields: Record<string,unknown> = {
        kind,
        id: action.target?.id,
        expectedVersion: action.target?.currentVersion ?? 0,
        synthetic: form.synthetic,
        observedAt: iso(form.observedAt),
      };
      if (action.target) fields.reason = form.reason;
      if (kind === 'evidence')
        Object.assign(fields, {
          evidenceType: form.evidenceType,
          source: {
            ...(form.evidenceType === 'ci-result'
              ? ciSourceMetadata(
                  githubReference.parse({
                    provider: 'github-actions',
                    owner: form.ciOwner,
                    repository: form.ciRepository,
                    runId: Number(form.ciRunId),
                    attempt: Number(form.ciAttempt),
                    commit: form.ciCommit,
                  }),
                )
              : {
                  originSystem: form.originSystem,
                  externalStableId: form.externalStableId,
                  contentVersion: form.contentVersion,
                }),
            issuer: form.issuer,
            originalAt: iso(form.originalAt),
            ...(form.uri ? { uri: form.uri } : {}),
          },
          reportedSourceState: form.sourceState,
          summary: form.summary,
        });
      if (kind === 'verification') {
        const [type, id, version] = form.sourceChoice.split(':');
        const target = [...attempts, ...interventions, ...results].find(
          x => x.id === id && x.version === Number(version),
        );
        if (!target) throw new Error('请选择当前可读的真实检查目标。');
        Object.assign(fields, {
          target: { type, id, version: Number(version) },
          scopeVersion: target.scopeVersion,
          method: form.method,
          scope: form.scope,
          conditions: {
            ...action.target?.record?.conditions,
            environment: form.conditions,
            commandOrMethod: form.command,
          },
          observation: form.observation,
          summary: form.summary,
          evidenceRefs: selectedEvidence.map(exactFactRef),
          relationship: form.relationship,
        });
      }
      if (kind === 'revoke') {
        const target=requiredTarget(action.target);if(!target.type||!target.currentVersion)throw Error('原记录位置与版本不完整，请重新读取。');
        fields = {
          kind,
          id: target.id,
          objectType: target.type,
          expectedVersion: target.currentVersion,
          synthetic: target.synthetic===true,
          reason: form.reason,
        };
      }
      receipt = await client.submitRecord(task, facts, participant, fields, {
        viewers,
        confirmed: true,
        composeRevision,
      });
      scope.check();
      setAction(null);
      setNotice('原操作已取得写入回执。当前正文与来源仍按现有权限读取。');
      if(!receipt.type||!receipt.id)throw Error('原记录回执缺少准确位置，请查询原操作。');
      const record = await client.readRecord({ type: receipt.type, id: receipt.id });
      scope.check();
      await remember(record);
      scope.check();
    } else
      receipt = await client.submitFact(task, facts, participant, draft(kind), {
        viewers,
        confirmed: true,
        caseSummary: form.caseSummary,
        synthetic: form.synthetic,
        composeRevision,
      });
    scope.check();
    setAction(null);
    await readCompose(true);scope.check();
    setNotice(action.kind==='deliver'?'结果已分享给发起者。':'这条工作记录已保存。');
    await refresh();
    scope.check();
    if (task.caseId) await load();
    else if (receipt.caseId) {
      const current = await client.readCase({ ...task, caseId: receipt.caseId });
      scope.check();
      setFacts(current);
    }
    if(kind==='result-recorded')navigate(taskResultPath(task.taskId,isResultReference(receipt.objectRef)?receipt.objectRef:null));
  }
  async function sendResult(item:WorkResult){
    if(!participant||hasSavedDraft||!composeReady||pending)return;
    const scope=captureView(),current=await client.readCase(task);scope.check();
    const result=exactReadableResult(current?.results??[],item),latest=latestFacts(current?.results??[]).find(value=>value.id===item.id);
    if(!result||latest?.version!==item.version||result.actorId!==subjectId||result.participationId!==participant.participationId||result.participationScopeVersion!==participant.scopeVersion)throw Error('这份结果已有变化或目前不可读取，请重新打开后再分享。');
    const interventionRefs=result.origin.kind==='intervention'?[exactFactRef(result.origin)]:[],evidenceRefs=result.deliverableRefs.filter(ref=>ref.kind==='evidence').map(exactFactRef);
    const value:WorkComposeValue={ui:'work-editor-v1',kind:'deliver',targetRef:null,participationId:participant.participationId,participationScopeVersion:participant.scopeVersion,form:{...blank,summary:result.summary,resultChoice:refsKey(result)},viewers:[task.requesterId],related:interventionRefs.map(refsKey),recordSelected:evidenceRefs.map(refsKey),configurationConditions:[],configurationSources:[]};
    const saved=await persistCompose(value);scope.check();
    await runtime.participationEvent(task.taskId,participant.participationId,{kind:'deliver',expectedParticipationVersion:participant.version,resultRef:exactFactRef(result),interventionRefs,evidenceRefs,summary:result.summary},{viewers:[task.requesterId],confirmed:true,composeRevision:saved.revision??undefined});
    scope.check();await readCompose(true);scope.check();await refresh();scope.check();
    setNotice('结果已分享给发起者。');navigate('/app/tasks/'+task.taskId+'?section=collaboration&view=people');
  }
  function resultActions(item:WorkResult){
    if(item.actorId!==subjectId||item.participationId!==(participant?.participationId??null))return null;
    const latest=results.find(result=>result.id===item.id),delivered=participant?.deliveries?.some(delivery=>delivery.resultRef?.id===item.id&&delivery.resultRef.version===item.version),canShare=participant&&eligibleResults.some(result=>refsKey(result)===refsKey(item));
    if(latest?.version!==item.version)return null;
    return <footer className="result-actions">{canShare&&!delivered?<><Button disabled={busy||!!pending||hasSavedDraft||!composeReady} onClick={()=>void run(()=>sendResult(item))}>交给发起者</Button><button className="text-action" disabled={busy||!!pending||hasSavedDraft||!composeReady} onClick={()=>choose('deliver',undefined,{resultChoice:refsKey(item)})}>补充说明或资料后再分享</button><p className="permission-line">将这份结果和已附来源分享给发起者。</p></>:delivered?<p className="muted">这份结果已分享给发起者。</p>:null}<button className="text-action" disabled={busy||!!pending||hasSavedDraft||!composeReady} onClick={()=>choose('result-recorded',item)}>更正结果</button></footer>;
  }
  const field = (
    title: string,
    key: WorkTextField,
    required = true,
    maxLength = 1200,
  ) => (
    <label htmlFor={inputId+'-'+key}>
      {title}
      {maxLength<=300?<Input id={inputId+'-'+key}
        aria-label={title}
        required={required}
        maxLength={maxLength}
        value={form[key]}
        onChange={(e)=>setForm({...form,[key]:e.target.value})}
      />:<Textarea id={inputId+'-'+key}
        aria-label={title}
        required={required}
        maxLength={maxLength}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />}
    </label>
  );
  const chooseRecords = (
    items: WorkEditorTarget[],
    selected: string[],
    set: (x: string[]) => void,
    title: string,
  ) => items.length ? (
    <fieldset>
      <legend>{title}</legend>
      {items.map(item => (
        <label key={refsKey(item)}>
          <input
            type="checkbox"
            checked={selected.includes(refsKey(item))}
            onChange={(e) =>
              set(
                e.target.checked
                  ? [...selected, refsKey(item)]
                  : selected.filter((x) => x !== refsKey(item)),
              )
            }
          />
          {item.summary ?? item.description ?? item.record?.summary ?? item.id}{' '}
          · {person(item.actorId ?? item.record?.reportedBy)} · 版本 {item.version}
        </label>
      ))}
    </fieldset>
  ) : null;
  if (!connected || task.schemaVersion !== 2) return null;
  return (
    <section className={'work-facts'+(resultDetail?' is-result-detail':'')}>
      <header className="work-facts-heading">{resultDetail?<><button className="text-action" onClick={()=>navigate(taskResultReturn(task.taskId,resultSelection.deliveryId))}>{resultSelection.deliveryId?'返回原交付':'返回结果列表'}</button><h1 className="small">工作结果</h1></>:<h2>工作记录</h2>}</header>
      {!action&&composeDrafts.map(saved=><WorkComposeCard key={saved.revision??saved.value.kind} saved={saved} busy={busy} pending={!!pending} sourceUnavailable={!!task.caseId&&!facts} composeError={composeError} onResume={resumeCompose} onDiscard={discardSavedCompose}/>)}
      {composeError&&!action&&<p role="alert" className="message error">{composeError}</p>}
      {error && (
        <div className="message error" role="alert">
          {error} {!pending&&<button className="text-action" disabled={busy} onClick={()=>void run(()=>load())}>再试一次</button>}
        </div>
      )}
      {notice && (
        <div className="message"><output>{notice}</output></div>
      )}
      {!resultDetail&&<nav className="work-facts-tabs" aria-label="工作记录分类">{[['progress','做过的事'],['results','结果'],['evidence','来源与检查']].map(([id,title])=><button key={id} aria-current={workView===id?'page':undefined} onClick={()=>setWorkView(id)}>{title}</button>)}</nav>}
      {pending && (
        <div className="message">
          <p>{['authorization-expired','original-binding-changed','original-binding-unavailable','original-signature-expired','authorization-review-required'].includes(recoveryState?.reason??'')?'上次提交需要重新确认阅读范围，原内容已保留。':pending.localRetryStopped?'已停止继续发送，仍会确认上次提交是否收到。':'正在确认上次提交，原内容已保留。'}</p>
          {recoveryState?.state==='absent'&&recoveryState.operationId===pending.operationId&&!pending.localRetryStopped&&['authorization-expired','original-binding-changed','original-binding-unavailable','original-signature-expired','authorization-review-required'].includes(recoveryState?.reason??'')&&<Button variant="outline" disabled={busy||!!retryPreview} onClick={()=>void run(previewOriginalRetry)}>查看原内容与阅读范围</Button>}
          {error&&<Button variant="outline" disabled={busy} onClick={()=>void run(()=>recover())}>再试一次</Button>}
          {!pending.localRetryStopped&&<button className="text-action" disabled={busy} onClick={()=>void run(async()=>{const scope=captureView();await client.stopRetry(task.taskId,{confirmed:true});scope.check();await load();})}>停止继续发送</button>}
        </div>
      )}
      {retryPreview && <section className="message" aria-label="继续上次提交">
        <h3>继续发送这份原内容</h3>
        <p className="permission-line">仅本人{retryPreview.value.viewers.length?'和 '+retryPreview.value.viewers.map(person).join('、'):''}可读。</p>
        {retryPreview.value.items.map(item=><OriginalContent key={item.objectId} item={item}/>)}
        <ReadingDetails className="source-locator"><ReadingSummary>服务与原操作信息</ReadingSummary><dl><dt>服务</dt><dd>{retryPreview.value.endpoint}</dd><dt>原操作</dt><dd>{retryPreview.value.operationId}</dd><dt>内容校验值</dt><dd>{retryPreview.value.payloadHash}</dd></dl></ReadingDetails>
        <div className="button-row">
          <Button disabled={busy} onClick={() => run(confirmOriginalRetry)}>按此范围继续发送</Button>
          <Button variant="outline" disabled={busy} onClick={() => { setRetryPreview(null); }}>暂不发送</Button>
        </div>
      </section>}
      {!task.caseId && (
        <div className="message">
          还没有工作记录。
          {requester
            ? '可以从一次尝试或一条建议开始。'
            : own.length ? '可以记录自己在约定范围内做过的事。' : '确认参与范围后，可以记录自己的工作。'}
        </div>
      )}
      {facts && !facts.coverage.complete && (
        <p className="muted">
          部分工作内容当前不可读。
        </p>
      )}
      {!resultDetail&&(requester || !!own.length) && (
        <>
          {(own.length>1||(requester&&own.length>0))&&<label>
            这次的参与安排
            <select
              value={participationId}
              onChange={(e) => {
                setParticipationId(e.target.value);
                setAction(null);
              }}
            >
              {requester && <option value="">任务请求者的本人工作</option>}
              {own.map(p => (
                <option key={p.participationId} value={p.participationId}>
                  {p.role}：{p.agreedScope}（约定版本{p.scopeVersion}）
                </option>
              ))}
            </select>
          </label>}
          <div className="work-fact-actions">
            {workView==='progress'&&<><Button disabled={busy||!!pending||hasSavedDraft||!composeReady||!!task.caseId&&!facts||(!requester&&!participant)} onClick={()=>choose('intervention')}><Plus size={16}/>写下做了什么</Button><button type="button" className="text-action" disabled={busy||!!pending||hasSavedDraft||!composeReady||!!task.caseId&&!facts||(!requester&&!participant)} onClick={()=>choose('attempt-start')}>开始一次尝试</button></>}
            {workView==='results'&&!!ownOrigins.length&&<Button disabled={busy||!!pending||hasSavedDraft||!composeReady||!facts} onClick={()=>choose('result-recorded')}><Plus size={16}/>补充结果</Button>}
            {workView==='evidence'&&<><Button disabled={busy||!!pending||hasSavedDraft||!composeReady||!facts} onClick={()=>choose('evidence')}><Plus size={16}/>添加来源</Button><button className="text-action" disabled={busy||!!pending||hasSavedDraft||!composeReady||!facts||![...attempts,...interventions,...results].length} onClick={()=>choose('verification')}>记录一次检查</button></>}
          </div>
        </>
      )}
      {facts&&workView==='progress'&&<div className="work-reading-list">
        {attempts.map(item=><article className="work-entry" key={refsKey(item)}>
          <header><MemberAvatar subjectId={item.actorId}/><div><MemberLink subjectId={item.actorId} ownId={subjectId} name={memberNames[item.actorId]??undefined} navigate={navigate}/><span>{attemptStates[item.status]??'尝试'}</span></div></header>
          <p className="reading-prose work-entry-body">{item.strategy}</p>
          {item.summary?<div className="work-observation"><small>记录到的实际观察</small><p className="reading-prose">{item.summary}</p></div>:<p className="muted">这条尝试尚未记录实际观察。</p>}
          <ReadingDetails className="work-context"><ReadingSummary>输入与工作环境</ReadingSummary>{item.inputScopeSummary&&<p className="reading-prose">{item.inputScopeSummary}</p>}{typeof item.environment==='object'&&<p>{item.environment.name==='unknown'?'环境未提供':item.environment.name}{item.environment.version&&item.environment.version!=='unknown'?' · '+item.environment.version:''}</p>}{item.configurationCondition&&<p>{item.configurationCondition.record?item.configurationCondition.record.title+' · 第 '+item.configurationCondition.version+' 版':item.configurationCondition.sourceStatus==='not-recorded'?'当时未记录配置，具体条件仍未知。':item.configurationCondition.sourceStatus==='revoked'?'当时的配置已撤回，详情当前不可读。':'配置详情当前不可读。'}</p>}{!!item.permissionScope?.length&&<p>操作范围：{item.permissionScope.join('；')}</p>}</ReadingDetails>
          <footer>{item.actorId===subjectId&&item.participationId===(participant?.participationId??null)&&<><button className="text-action" disabled={busy||!!pending||hasSavedDraft||!composeReady} onClick={()=>choose(item.status==='running'?'attempt-end':'attempt-correct',item)}>{item.status==='running'?'写下尝试结果':'更正记录'}</button><button className="text-action" disabled={busy||!!pending||hasSavedDraft||!composeReady} onClick={()=>choose('result-recorded',undefined,{sourceChoice:refsKey(item)})}>补充结果</button></>}<ReadingDetails className="work-record-file"><ReadingSummary>记录信息</ReadingSummary><p>第 {item.version} 版</p><button className="text-action" onClick={()=>downloadRecord(item)}>保存记录文件</button></ReadingDetails></footer>
        </article>)}
        {interventions.map(item=><article className="work-entry" key={refsKey(item)}>
          <header><MemberAvatar subjectId={item.actorId}/><div><MemberLink subjectId={item.actorId} ownId={subjectId} name={memberNames[item.actorId]??undefined} navigate={navigate}/><span>{item.types.map((x:string)=>names[x]??x).join('、')} · 本人记录</span></div></header>
          <p className="reading-prose work-entry-body">{item.description}</p>
          {item.observedEffect&&<div className="work-observation"><small>观察到的作用</small><p className="reading-prose">{item.observedEffect}</p></div>}
          {((item.responses?.length??0)>0||item.responseCoverage?.complete===false)&&<InterventionOpinions intervention={item} subjectId={subjectId} names={memberNames}/>}
          <footer>{(requester||own.length>0)&&item.actorId!==subjectId&&<button className="text-action" disabled={busy||!!pending||hasSavedDraft||!composeReady} onClick={()=>choose('intervention-response',item)}>回应</button>}{item.actorId===subjectId&&item.participationId===(participant?.participationId??null)&&<><button className="text-action" disabled={busy||!!pending||hasSavedDraft||!composeReady} onClick={()=>choose('intervention',item)}>更正记录</button><button className="text-action" disabled={busy||!!pending||hasSavedDraft||!composeReady} onClick={()=>choose('result-recorded',undefined,{sourceChoice:refsKey(item)})}>补充结果</button></>}<ReadingDetails className="work-record-file"><ReadingSummary>记录信息</ReadingSummary><p>第 {item.version} 版</p>{item.actorId===subjectId&&<button className="text-action" disabled={busy||!!pending||hasSavedDraft||!composeReady} onClick={()=>choose('intervention-response',item)}>补充本人意见</button>}<button className="text-action" onClick={()=>downloadRecord(item)}>保存记录文件</button></ReadingDetails></footer>
        </article>)}
        {!attempts.length&&!interventions.length&&<p className="empty-state">还没有可读的工作内容。</p>}
      </div>}
      {resultDetail&&<div className="work-reading-list">{!resultSelection.reference?<p className="message">这份结果的地址不完整，请从原交付重新打开。</p>:!facts?<p><output>{error?'这份结果目前无法读取。':'正在读取这份结果…'}</output></p>:!selectedResult?<p className="message">这份结果目前不可读取。可以返回原处继续交流。</p>:<><p className="result-reading-context">{deliveredVersion?'正在查看交付时的结果。':sourceDelivery?'正在查看原交付之后的修订。':'正在查看这份工作结果。'}{results.some(item=>item.id===selectedResult.id&&item.version>selectedResult.version)&&<button className="text-action" onClick={()=>navigate(taskResultPath(task.taskId,results.find(item=>item.id===selectedResult.id)??null,resultSelection.deliveryId))}>查看后续修订</button>}</p><WorkResultReading item={selectedResult} {...{facts,client,subjectId,navigate}} names={memberNames} download={()=>downloadRecord(selectedResult)}>{resultActions(selectedResult)}</WorkResultReading></>}</div>}
      {facts&&workView==='results'&&!resultDetail&&<div className="work-reading-list">
        {results.map(item=>{const origin=(item.origin.kind==='intervention'?facts.interventions:facts.attempts)?.find(source=>source.id===item.origin.id&&source.version===item.origin.version);return <article className="work-entry" key={refsKey(item)}>
          <header><MemberAvatar subjectId={item.actorId}/><div><strong title={item.actorId}>{person(item.actorId)}</strong><span>{outcomes[item.reportedOutcome]??'结果'} · 本人记录</span></div></header>
          <p className="reading-prose work-entry-body">{item.summary}</p>
          {item.limitations&&<div className="work-observation"><small>适用范围与未完成的部分</small><p className="reading-prose">{item.limitations}</p></div>}
          <ReadingDetails className="work-context"><ReadingSummary>这份结果来自哪项工作</ReadingSummary><p className="reading-prose">{origin?.description??origin?.strategy??'该版本的来源正文当前不可读。'}</p><small>来源第 {item.origin.version} 版 · 结果第 {item.version} 版</small><button className="text-action" onClick={()=>downloadRecord(item)}>保存记录与来源编号</button></ReadingDetails>
          <button className="text-action" onClick={()=>navigate(taskResultPath(task.taskId,item))}>打开完整结果</button>{resultActions(item)}
        </article>;})}
        {!results.length&&<p className="empty-state">还没有可读的结果。{!ownOrigins.length&&'先在“做过的事”写下实际工作，再补充由此得到的结果。'}</p>}
        {(facts.resolution?.status&&facts.resolution.status!=='unrecorded'||requester)&&<section className="work-resolution"><h3>问题解决了吗</h3><ResolutionStatus resolution={facts.resolution} resolutions={facts.resolutions}/>{requester&&<button className="text-action" disabled={busy||!!pending||hasSavedDraft||!composeReady} onClick={()=>{setParticipationId('');choose('resolution-recorded');}}>说明解决情况</button>}</section>}
      </div>}
      {workView==='evidence'&&task.caseId && (
        <ReadingDetails mode="inline" className="room-settings">
          <ReadingSummary>读取获知的证据或检查记录</ReadingSummary>
          <form
            className="search-row"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async (check) => {
                const item = await client.readRecord({
                  type: recordType,
                  id: recordId,
                });
                check();
                if (item.record?.caseId !== task.caseId)
                  throw new Error('这份记录不属于当前工作，或你暂时无法读取。');
                await remember(item);
                check();
                setRecords((old) => [
                  ...old.filter((x) => x.id !== item.id),
                  item,
                ]);
              });
            }}
          >
            <Input
              required
              aria-label="证据或检查记录ID"
              value={recordId}
              onChange={(e) => setRecordId(e.target.value)}
            />
            <select
              value={recordType}
              aria-label="记录类型"
              onChange={(e) => {if(e.target.value==='evidence'||e.target.value==='verification')setRecordType(e.target.value);}}
            >
              <option value="evidence">来源</option>
              <option value="verification">检查</option>
            </select>
            <Button type="submit" disabled={busy}>
              打开记录
            </Button>
          </form>
        </ReadingDetails>
      )}
      {workView==='evidence'&&sourceError&&<p className="message"><output>{sourceError}</output> <button className="text-action" disabled={busy} onClick={()=>void run(()=>load())}>再试一次</button></p>}
      {workView==='evidence'&&<div className="work-reading-list">{records.map(item=><article className="work-entry" key={item.type+item.id}>
        <header><MemberAvatar subjectId={item.record?.reportedBy}/><div><strong>{person(item.record?.reportedBy)}</strong><span>{item.type==='evidence'?'来源':'检查或反馈'}{item.referenceStatus!=='current'?' · '+(observationNames[item.referenceStatus]??'状态待核对'):''}</span></div></header>
        <p className="reading-prose work-entry-body">{item.record?.summary??'这份记录的正文当前不可读。'}</p>
        {item.record&&<><p className="work-record-meta">{methods[item.record.method??'']??(item.type==='evidence'?item.record.source?.originSystem:'')} {observationNames[item.record.observation??item.record.reportedSourceState??'']??''}</p>{item.record.scope&&<p className="reading-prose">{item.record.scope}</p>}
          <ReadingDetails className="work-context"><ReadingSummary>{item.type==='evidence'?'来源详情':'检查条件'}</ReadingSummary>{item.record.source&&<dl><dt>来源</dt><dd>{item.record.source.originSystem}</dd><dt>发布者</dt><dd>{item.record.source.issuer}</dd><dt>内容版本</dt><dd>{item.record.source.contentVersion}</dd>{item.record.source.uri&&<><dt>原链接</dt><dd>{item.record.source.uri}</dd></>}</dl>}{item.record.conditions&&<><p className="reading-prose">{item.record.conditions.environment}</p><p className="reading-prose">{item.record.conditions.commandOrMethod}</p></>}<button className="text-action" onClick={()=>downloadRecord(item)}>保存完整记录</button></ReadingDetails>
          {isWorkRecordView(item)&&item.record.reportedBy===subjectId&&item.currentState==='active'&&<footer><button className="text-action" disabled={busy||!!pending||hasSavedDraft||!composeReady} onClick={()=>choose(item.type,item)}>更正记录</button><button className="text-action" disabled={busy||!!pending||hasSavedDraft||!composeReady} onClick={()=>choose('revoke',item)}>撤回</button></footer>}
        </>}
      </article>)}</div>}
      {workView==='evidence'&&moreSources&&<Button variant="ghost" disabled={busy} onClick={()=>void run(async()=>{sourceLimit.current+=100;await load();})}>更多来源</Button>}
      {workView==='evidence'&&facts && (
        <CiWorkspace
          runtime={runtime}
          connected={connected}
          subjectId={subjectId}
          caseId={facts.caseId}
          results={results}
          evidence={records.filter(isWorkEvidence)}
        />
      )}
      <dialog ref={editor} className="workspace-dialog work-record-dialog" onCancel={event=>{event.preventDefault();closeEditor();}}>{action && (
        <form
          className="workspace-form work-editor-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(save);
          }}
        >
          <header className="dialog-heading"><h3>{actionTitles[action.kind]??'记录工作'}</h3><button type="button" className="icon-button" disabled={busy} aria-label="关闭记录编辑" onClick={closeEditor}><X size={19}/></button></header>
          {error&&<p className="message error" role="alert">{error}</p>}
          {composeError&&<div className="message error" role="alert"><p>{composeError}</p><button type="button" className="text-action" onClick={()=>downloadRecord(composeValue(),'galaxy-work-draft.json')}>保存本页输入</button><button type="button" className="text-action" disabled={busy} onClick={()=>void run(async()=>{await composeQueue.current;const scope=captureView();setAction(null);composeBlocked.current=false;await readCompose(true);scope.check();setComposeError('');})}>放弃本页编辑，读取已保存稿</button></div>}
          <fieldset disabled={busy||!!action.pendingOperation} style={{ display: 'contents' }}>
          {!task.caseId && (
            <>

              <label>
                <input
                  type="checkbox"
                  checked={form.synthetic}
                  onChange={(e) =>
                    setForm({ ...form, synthetic: e.target.checked })
                  }
                />{' '}
                本次是合成或演示案例
              </label>
            </>
          )}
          {action.kind === 'attempt-start' && (
            <>
              {field('正在尝试的做法', 'strategy')}
              <p className="permission-line">这里只记录已经开始的尝试；尚未采用的建议可以留在讨论中。</p>
              {field('实际使用的环境；未知可留空', 'environment', false, 160)}
              {field('环境版本；未知可留空', 'environmentVersion', false, 80)}
              {field('实际使用哪些输入', 'inputScope')}
              {field('本人已获准的操作范围，每行一项', 'permissionScope')}
              <ConfigurationPicker {...{runtime,subjectId,busy,run}} single selected={configurationConditions} onChange={setConfigurationConditions}/>
              <a href="/app/configurations" target="_blank" rel="noopener">在独立页面登记配置版本</a>
            </>
          )}
          {['attempt-end', 'attempt-correct'].includes(action.kind) && (
            <>
              <label>
                尝试状态
                <select
                  required
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                >
                  {[
                    ['completed', '本段尝试已结束'],
                    ['abandoned', '已放弃'],
                    ['canceled', '已取消'],
                    ['inconclusive', '无法确定'],
                  ].map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {field('实际结果说明', 'summary')}
              {field('失败/中止原因；没有结论时明确填写未知', 'failureReason')}
            </>
          )}
          {action.kind === 'intervention' && (
            <>
              <label>
                做了哪方面的工作
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                >
                  {Object.entries(names).map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {field('做了什么', 'description')}
              {field('有什么作用', 'observedEffect')}
              {attempts.length>0&&<fieldset>
                <legend>关联已有尝试</legend>
                {attempts.map(x => (
                  <label key={x.id}>
                    <input
                      type="checkbox"
                      checked={related.includes(x.id)}
                      onChange={(e) =>
                        setRelated(
                          e.target.checked
                            ? [...related, x.id]
                            : related.filter((v) => v !== x.id),
                        )
                      }
                    />
                    {x.strategy} · {person(x.actorId)}
                  </label>
                ))}
              </fieldset>}
              {chooseRecords(
                evidence,
                recordSelected,
                setRecordSelected,
                '关联已有来源（可选）',
              )}
            </>
          )}
          {action.kind === 'intervention-response' && (
            <>
              <p>{action.target?.description}</p>
              <label>
                本人意见
                <select
                  required
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                >
                  <option value="">选择你的意见</option>
                  <option value="accepted">认可实际作用</option>
                  <option value="partial">部分认可</option>
                  <option value="disputed">有具体异议</option>
                </select>
              </label>
              {field('本人意见说明', 'summary')}
            </>
          )}
          {action.kind === 'result-recorded' && (
            <>
              <label>
                这次结果来自本人的哪项实际工作
                <select
                  required
                  value={form.sourceChoice}
                  onChange={(e) =>
                    setForm({ ...form, sourceChoice: e.target.value })
                  }
                >
                  <option value="">选择实际来源</option>
                  {ownOrigins.map(x => (
                    <option key={refsKey(x)} value={refsKey(x)}>
                      {x.description ?? x.strategy} · 第 {x.version} 版
                    </option>
                  ))}
                </select>
              </label>
              {field('取得的具体结果', 'summary')}
              {field('适用限制与尚未做到的事情', 'limitations')}
              {chooseRecords(
                evidence,
                recordSelected,
                setRecordSelected,
                '支持这份结果的来源（可选）',
              )}
            </>
          )}
          {['intervention','result-recorded'].includes(action.kind)&&<ConfigurationPicker {...{runtime,subjectId,busy,run}} selected={configurationSources} onChange={setConfigurationSources}/>}
          {['attempt-end', 'attempt-correct', 'result-recorded'].includes(
            action.kind,
          ) && (
            <label>
              得到的结果
              <select
                value={form.outcome}
                onChange={(e) => setForm({ ...form, outcome: e.target.value })}
              >
                {Object.entries(outcomes).map(([id, title]) => (
                  <option key={id} value={id}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {action.kind === 'deliver' && (
            <>
              <label>
                提交验收的本人结果
                <select
                  required
                  value={form.resultChoice}
                  onChange={(e) =>
                    setForm({ ...form, resultChoice: e.target.value })
                  }
                >
                  {eligibleResults.map(x => (
                    <option key={refsKey(x)} value={refsKey(x)}>
                      {x.summary} / 版本{x.version}
                    </option>
                  ))}
                </select>
              </label>
              {field('给发起者的说明', 'summary')}
              {chooseRecords(
                interventions,
                related,
                setRelated,
                '一同引用的工作（保留原作者）',
              )}
              {chooseRecords(
                evidence,
                recordSelected,
                setRecordSelected,
                '支持这次交付的来源（可选）',
              )}
            </>
          )}
          {action.kind === 'evidence' && (
            <>
              <label>
                证据类型
                <select
                  value={form.evidenceType}
                  onChange={(e) =>
                    setForm({ ...form, evidenceType: e.target.value })
                  }
                >
                  {[
                    ['self-assertion', '本人来源声明'],
                    ['test-result', '实际测试结果'],
                    ['git-commit', '代码提交'],
                    ['pull-request', 'Pull Request'],
                    ['ci-result', 'CI结果'],
                    ['build-result', '构建结果'],
                    ['organization-record', '组织记录'],
                    ['external-platform-record', '外部平台记录'],
                  ].map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {form.evidenceType === 'ci-result' ? (
                <>
                  <p>
                    记录实际 GitHub Actions
                    来源。这里只保存你的来源声明，后续选择对应结果后可申请观察公开
                    CI；不会把声明直接算成已验证。
                  </p>
                  {field('GitHub 仓库所有者', 'ciOwner', true, 100)}
                  {field('仓库名称', 'ciRepository', true, 100)}
                  {field('实际 Workflow run ID', 'ciRunId', true, 24)}
                  {field('本次 run attempt', 'ciAttempt', true, 10)}
                  {field(
                    '本次实际 40 位小写 Git commit SHA',
                    'ciCommit',
                    true,
                    40,
                  )}
                  {action.target && !form.ciOwner && (
                    <p>
                      旧来源未按此结构登记。不同来源身份需要新建记录，不能用纠正覆盖旧来源。
                    </p>
                  )}
                </>
              ) : (
                <>
                  {field('来源系统名称', 'originSystem', true, 120)}
                  {field(
                    '实际来源的稳定编号（例如提交ID或报告编号）',
                    'externalStableId',
                    true,
                    1000,
                  )}
                  {field('实际内容版本', 'contentVersion', true, 240)}
                </>
              )}
              {field(
                '来源发布者/签发者（按所知如实描述）',
                'issuer',
                true,
                1000,
              )}
              {field(
                '实际来源链接（可选，不由银河自动打开）',
                'uri',
                false,
                2048,
              )}
              <label htmlFor={inputId+'-original-at'}>
                来源原始发生时间
                <Input id={inputId+'-original-at'}
                  type="datetime-local"
                  required
                  value={form.originalAt}
                  onChange={(e) =>
                    setForm({ ...form, originalAt: e.target.value })
                  }
                />
              </label>
              <label>
                本人观察到的来源状态
                <select
                  value={form.sourceState}
                  onChange={(e) =>
                    setForm({ ...form, sourceState: e.target.value })
                  }
                >
                  {[
                    ['unknown', '未知'],
                    ['available', '当时可用'],
                    ['unreachable', '当时不可达'],
                    ['removed', '已移除'],
                  ].map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {field('来源说明与内容范围', 'summary', true, 4000)}
              <p>
                此处登记实际引用信息，不上传原始文件，不填写虚构的摘要哈希。来源声明和独立验证分别成立。
              </p>
            </>
          )}
          {action.kind === 'verification' && (
            <>
              <label>
                实际检查的目标版本
                <select
                  required
                  value={form.sourceChoice}
                  onChange={(e) =>
                    setForm({ ...form, sourceChoice: e.target.value })
                  }
                >
                  <option value="">选择检查目标</option>
                  {verificationTargets.flatMap(([kind, items]) =>
                    items
                      .filter(
                        (x) =>
                          !action.target?.record?.target ||
                          (kind === action.target.record.target.type &&
                            x.id === action.target.record.target.id),
                      )
                      .map((x) => (
                        <option
                          key={kind + refsKey(x)}
                          value={kind + ':' + refsKey(x)}
                        >
                          {x.summary ?? x.description ?? x.strategy} · 第 {x.version} 版
                        </option>
                      )),
                  )}
                </select>
              </label>
              <label>
                实际采用的方法
                <select
                  value={form.method}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      method: e.target.value,
                      observation: [
                        'participant-feedback',
                        'requester-acceptance',
                      ].includes(e.target.value)
                        ? 'comment'
                        : 'inconclusive',
                    })
                  }
                >
                  {Object.entries(methods)
                    .filter(
                      ([id]) => id !== 'requester-acceptance' || requester,
                    )
                    .map(([id, title]) => (
                      <option key={id} value={id}>
                        {title}
                      </option>
                    ))}
                </select>
              </label>
              {field('本次检查或反馈仅涵盖什么', 'scope', true, 4000)}
              {field('实际环境、仓库版本及前提条件', 'conditions', true, 2000)}
              {field(
                '实际命令或检查方法；反馈可写未执行测试',
                'command',
                true,
                2000,
              )}
              <label>
                实际观察
                <select
                  value={form.observation}
                  onChange={(e) =>
                    setForm({ ...form, observation: e.target.value })
                  }
                >
                  {(['participant-feedback', 'requester-acceptance'].includes(
                    form.method,
                  )
                    ? [
                        ['comment', '意见'],
                        ['accepted', '接受'],
                        ['partially-accepted', '部分接受'],
                        ['rejected', '不接受'],
                        ['inconclusive', '不明确'],
                      ]
                    : [
                        ['passed', '所列检查通过'],
                        ['failed', '所列检查未通过'],
                        ['inconclusive', '不明确'],
                      ]
                  ).map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {field('检查说明、结果与未覆盖之处', 'summary', true, 4000)}
              <label>
                你与目标作者的关系（本人声明）
                <select
                  value={form.relationship}
                  onChange={(e) =>
                    setForm({ ...form, relationship: e.target.value })
                  }
                >
                  {[
                    ['unknown', '未知/不作独立声明'],
                    ['same-controller', '同一控制方'],
                    ['counterparty', '协作相对方'],
                    ['independent', '本人声明独立'],
                  ].map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {chooseRecords(
                evidence,
                recordSelected,
                setRecordSelected,
                '实际检查使用的支持证据（测试/评审必须有来源，反馈可无）',
              )}
            </>
          )}
          {['evidence', 'verification'].includes(action.kind) && (
            <label htmlFor={inputId+'-observed-at'}>
              本人实际观察时间
              <Input id={inputId+'-observed-at'}
                type="datetime-local"
                required
                value={form.observedAt}
                onChange={(e) =>
                  setForm({ ...form, observedAt: e.target.value })
                }
              />
            </label>
          )}
          {action.kind === 'resolution-recorded' && (
            <>
              <label>
                整个问题的当前状态
                <select
                  value={form.resolution}
                  onChange={(e) =>
                    setForm({ ...form, resolution: e.target.value })
                  }
                >
                  {[
                    ['unresolved', '仍未解决'],
                    ['partially-resolved', '部分解决'],
                    ['resolved', '已解决'],
                    ['inconclusive', '暂不明确'],
                    ['regressed', '出现回归'],
                  ].map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {field('请求者的判断及适用范围', 'summary')}
              {field('已满足目标，每行一项', 'satisfied', false)}
              {field('仍未满足目标，每行一项', 'remaining', false)}
              {chooseRecords(
                results,
                related,
                setRelated,
                '本次明确依据的结果版本',
              )}
              {chooseRecords(
                verifications,
                recordSelected,
                setRecordSelected,
                '本次明确依据的检查版本（可以没有）',
              )}
            </>
          )}
          {action.target &&
            ['attempt-correct', 'evidence', 'verification', 'revoke'].includes(
              action.kind,
            ) &&
            field('为何纠正或撤回（保留原时点记录）', 'reason')}
          {action.kind === 'deliver' ? (
            <p className="muted">
              这份交付记录仅交给请求者。所引工作与证据分别沿用各作者原先授权，不扩大其他参与者权限。
            </p>
          ) : (
            <ReadingDetails mode="inline" className="work-scope-choice"><ReadingSummary>{viewers.length?person(subjectId)+"和 "+viewers.map(person).join("、")+"可读":"仅自己可读"} · 调整</ReadingSummary><fieldset>
              <legend>谁可以阅读这条记录？</legend>
              {[
                ...new Set([
                  task.requesterId,
                  ...(task.participations ?? []).map(p => p.subjectId),
                ]),
              ]
                .filter((id) => id !== subjectId)
                .map(id => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked={viewers.includes(id)}
                      onChange={(e) =>
                        setViewers(
                          e.target.checked
                            ? [...viewers, id]
                            : viewers.filter((x) => x !== id),
                        )
                      }
                    />
                    <span title={id}>{person(id)}</span>
                    {id === task.requesterId
                      ? '（发起者）'
                      : ''}
                  </label>
                ))}
            </fieldset></ReadingDetails>
          )}
          </fieldset>
          <div className="button-row">
            <Button type="submit" disabled={busy || !!pending || !!action.pendingOperation}>
              {action.kind === 'deliver' ? '交给发起者' : '保存记录'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={closeEditor}
            >
              稍后继续
            </Button>
          </div>
        </form>
      )}</dialog>
    </section>
  );
}
