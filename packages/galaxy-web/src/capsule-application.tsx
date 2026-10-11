import React, { useCallback, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {applicationResults,exactApplicationOrigin,matchingPriorApplications,originConfigurationRefs,applicationEnvironment} from './capsule-application-model.mjs';
import {memberName,useMemberNames} from './conversation-ui';
import {useChoiceViewLease,type ChoiceViewLease} from './choice-retained-operations';
import {capsuleUseV2Schema} from '../../galaxy-official/src/shared/capsule-v2-schema.mjs';
import type {CapsuleAuthorRuntime,CapsuleCaseHistory,CapsuleConfigurationView,CapsuleDetail,CapsuleOriginLocator,CapsuleOriginWork,CapsuleRead,CapsuleRun,CapsuleUse,CapsuleUses,CapsuleUseView,CapsuleVerificationView} from './capsule-authoring-types';

type ExactRef={id:string;version:number};
type ApplicationRead=CapsuleCaseHistory|CapsuleRead|CapsuleUseView|CapsuleVerificationView;
type Props={
 runtime:CapsuleAuthorRuntime|null;detail:CapsuleDetail;history:CapsuleCaseHistory[];historyLoaded:boolean;historyNext:string|null;
 loadHistory:(after?:string)=>Promise<unknown>;loadConfiguration:(ref:ExactRef)=>Promise<CapsuleConfigurationView>;
 readCurrent:(kind:string,input:unknown)=>Promise<ApplicationRead>;uses:CapsuleUses;subjectId?:string;busy:boolean;run:CapsuleRun;
 propose:(kind:'use',payload:CapsuleUse,scope:{visibility:'Private'|'Public';viewers:string[]})=>Promise<void>;
 navigate:(path:string)=>void;helpOrigin?:CapsuleOriginLocator|null;originWork:CapsuleOriginWork|null;readOrigin:()=>Promise<CapsuleOriginWork>;
};
const ref = (x: ExactRef) => ({ id: x.id, version: x.version }), key = (x: ExactRef) => `${x.id}:${x.version}`;
function currentCase(value:ApplicationRead):CapsuleCaseHistory{
 if('kind' in value&&'caseId' in value&&!('eventId' in value))return value;
 throw Error('原工作当前不可读取，请重新核对。');
}
function currentCapsule(value:ApplicationRead):CapsuleRead{
 if('newApplicationAllowed' in value&&'version' in value&&typeof value.version!=='number')return value;
 throw Error('原方法版本当前不可读取，请重新核对。');
}
function currentUse(value:ApplicationRead):CapsuleUseView{
 if('eventId' in value)return value;
 throw Error('原应用当前不可读取，请重新核对。');
}
function currentVerification(value:ApplicationRead):CapsuleVerificationView{
 if('referenceStatus' in value)return value;
 throw Error('原检查当前不可读取，请重新核对。');
}
export function CapsuleApplication(props:Props){
 const view=useChoiceViewLease(props.runtime,props.subjectId);
 return view.lease&&props.runtime&&props.subjectId?<ApplicationForm key={view.key} {...props} runtime={props.runtime} subjectId={props.subjectId} lease={view.lease}/>:null;
}
function ApplicationForm({runtime,detail,history,historyLoaded,historyNext,loadHistory,loadConfiguration,readCurrent,uses,subjectId,busy,run,propose,navigate,helpOrigin,originWork,readOrigin,lease}:Omit<Props,'runtime'|'subjectId'>&{runtime:CapsuleAuthorRuntime;subjectId:string;lease:ChoiceViewLease}){
 const epoch=useRef(0),inputId=useId();
 useEffect(()=>{const viewEpoch=epoch;viewEpoch.current++;return()=>{viewEpoch.current++;};},[]);
 const check=useCallback((token:number)=>{lease.assertCurrent();if(epoch.current!==token)throw Error('方法使用页面已关闭或身份已变化。');},[lease]);
 const ensureHistory=useEffectEvent(async()=>{if(!historyLoaded)await run(async()=>{await loadHistory();});});
 useEffect(()=>{void ensureHistory();},[]);
 const [kind,setKind]=useState<CapsuleUse['kind']>('reference'),[caseId,setCaseId]=useState(''),[resultKey,setResultKey]=useState(''),
  [note,setNote]=useState(''),[difference,setDifference]=useState(''),[parts,setParts]=useState(''),
  [selected,setSelected]=useState<string[]>([]),[priorId,setPriorId]=useState(''),[visibility,setVisibility]=useState<'Private'|'Public'>('Private'),
  [viewers,setViewers]=useState<string[]>([]),[configurationKey,setConfigurationKey]=useState(''),
  [configurationRead,setConfigurationRead]=useState<{choice:string;value:CapsuleConfigurationView|null;error:string}|null>(null);
 const originalFacts:CapsuleCaseHistory|null=originWork?.facts&&originWork.task.caseId?{...history.find(c=>c.caseId===originWork.task.caseId),...originWork.facts,caseId:originWork.task.caseId,title:originWork.task.request.title,requesterId:originWork.task.requesterId,taskIds:[originWork.task.taskId]}:null;
 const availableHistory=originalFacts?[originalFacts,...history.filter(c=>c.caseId!==originalFacts.caseId)]:history;
 const source=availableHistory.find(c=>c.caseId===caseId),results=applicationResults(source,subjectId),result=results.find(r=>key(r)===resultKey),
  origin=exactApplicationOrigin(source,result,subjectId),configurations=originConfigurationRefs(origin),configurationRef=configurations.find(c=>key(c)===configurationKey),
  checks=(source?.verificationRecords??[]).filter(v=>v.type==='verification'&&v.referenceStatus==='current'&&v.record?.target?.type==='result'&&v.record.target.id===result?.id&&v.record.target.version===result?.version),
  prior=matchingPriorApplications(uses.items,{detail,history:source,result,origin,subjectId}),
  people=[...new Set([source?.requesterId,...(source?.collaborations??[]).flatMap(t=>[t.requesterId,...(t.participation??[]).map(p=>p.subjectId)])].filter((id):id is string=>typeof id==='string'&&id!==subjectId))];
 const displayNames=useMemberNames(runtime,subjectId,true,people);
 const configurationChoice=configurationRef?JSON.stringify([caseId,resultKey,origin?.kind,origin?.ref.id,origin?.ref.version,configurationRef.id,configurationRef.version]):'';
 const readConfiguration=useEffectEvent((choice:string,active:()=>boolean)=>{
  if(!configurationRef)return;
  const token=epoch.current;
  try{check(token);}catch{return;}
  void loadConfiguration(configurationRef).then(value=>{check(token);applicationEnvironment(origin,configurationRef,value);if(active())setConfigurationRead({choice,value,error:''});})
   .catch((error:unknown)=>{if(active()){try{check(token);}catch{return;}setConfigurationRead({choice,value:null,error:error instanceof Error?error.message:'选定配置当前不可读取。'});}});
 });
 useEffect(()=>{let active=true;if(configurationChoice)readConfiguration(configurationChoice,()=>active);return()=>{active=false;};},[configurationChoice]);
 const configuration=configurationRead?.choice===configurationChoice?configurationRead.value:null,
  configurationError=configurationRead?.choice===configurationChoice?configurationRead.error:'',
  currentConfiguration=configurationRef&&configuration?.id===configurationRef.id&&configuration.version===configurationRef.version?configuration:null,
  environment=origin?configurationRef&&!currentConfiguration?null:applicationEnvironment(origin,configurationRef,currentConfiguration):null;
 async function prepare(){
  const token=epoch.current;check(token);
  if(!source)throw Error('请选择本人已有的真实工作记录。');
  if(!detail.versionId||!detail.authorId)throw Error('原方法准确版本和作者尚未读到，请重新核对。');
  let selectedTaskId=source.taskIds?.length===1?source.taskIds[0]:null;
  if(helpOrigin&&originalFacts?.caseId===caseId){const current=await readOrigin();check(token);if(current.task.caseId!==caseId||!current.facts)throw Error('原任务关联的工作已变化或当前不可读，请重新核对后选择。');selectedTaskId=current.task.taskId;}
  await readCurrent('case',{caseId,...(selectedTaskId?{taskId:selectedTaskId}:{})});check(token);
  const capsule=currentCapsule(await readCurrent('capsule',{capsuleId:detail.capsuleId,versionId:detail.versionId}));check(token);
  if(!capsule.version||capsule.authorId!==detail.authorId||kind!=='reference'&&!capsule.newApplicationAllowed)throw Error('此方法版本或其当前来源支持条件不可用于本次操作，请重新读取，不能自动替换版本。');
  const common={schemaVersion:2,id:crypto.randomUUID(),capsuleId:detail.capsuleId,versionId:detail.versionId,caseId,attribution:detail.authorId,note};
  let payload:CapsuleUse;
  if(kind==='reference')payload=capsuleUseV2Schema.parse({...common,kind,...(selectedTaskId?{taskId:selectedTaskId}:{})});
  else{
   if(!result||!origin)throw Error('请选择本人真实尝试或介入对应的精确结果；原来源也须当前可读取。');
   if(configurationKey&&!configurationRef)throw Error('所选配置已不在原介入来源中，请重新读取。');
   const facts=currentCase(await readCurrent('case',{caseId,...(result.taskId?{taskId:result.taskId}:{})}));check(token);
   const currentResult=applicationResults(facts,subjectId).find(r=>key(r)===resultKey),currentOrigin=exactApplicationOrigin(facts,currentResult,subjectId);
   if(!currentResult||!currentOrigin||currentOrigin.kind!==origin.kind||key(currentOrigin.ref)!==key(origin.ref))throw Error('原结果或工作来源已变化，请刷新工作记录；不会替换成后续版本。');
   const freshConfiguration=configurationRef?await loadConfiguration(configurationRef):null;check(token);
   const applied={...common,originRef:origin.ref,resultRef:ref(result),...(configurationRef?{configurationRef}:{}),environment:applicationEnvironment(currentOrigin,configurationRef,freshConfiguration),environmentDifference:difference,adoptedParts:parts.split('\n').map(s=>s.trim()).filter(Boolean),outcome:result.reportedOutcome,...(result.taskId?{taskId:result.taskId}:{}),...(result.participationId?{participationId:result.participationId}:{})};
   if(kind==='reverify'){
    const freshPrior=currentUse(await readCurrent('use',{eventId:priorId,capsuleId:detail.capsuleId,versionId:detail.versionId,caseId}));check(token);
    const previous=matchingPriorApplications([freshPrior],{detail,history:source,result:currentResult,origin:currentOrigin,subjectId})[0],
     previousConfiguration=previous?.record&&previous.record.kind!=='reference'?previous.record.configurationRef:undefined;
    if(!previous||key(previousConfiguration??{id:'',version:0})!==key(configurationRef??{id:'',version:0}))throw Error('请选择相同方法版本、原工作来源、结果和配置版本的原应用；不能替换成后续版本。');
    const verificationRefs=checks.filter(v=>selected.includes(key(v))).map(ref);
    for(const reference of verificationRefs){const value=currentVerification(await readCurrent('verification',reference));check(token);if(value.referenceStatus!=='current'||value.record?.target?.type!=='result'||key(value.record.target)!==key(currentResult))throw Error('所选检查已变化或不再指向原结果版本，请刷新后重新选择。');}
    payload=capsuleUseV2Schema.parse({...applied,kind,priorUseId:priorId,verificationRefs});
   }else payload=capsuleUseV2Schema.parse({...applied,kind});
  }
  check(token);await propose('use',payload,{visibility,viewers:visibility==='Private'?viewers:[]});
 }
  return (
    <section className="method-application">
      <fieldset disabled={busy} style={{minWidth:0}}>
        {helpOrigin&&<div className="browse-note"><p>原任务：{originWork?.task.request.title??'等待核对当前可读记录'}。选择它作为目标只准备本次引用或应用，不会补造尝试或结果。</p><Button type="button" onClick={()=>run(async()=>{const token=epoch.current;check(token);const current=await readOrigin();check(token);if(!current.task.caseId||!current.facts)throw new Error('原任务还没有可选的实际工作事实，请返回原任务继续处理。');setCaseId(current.task.caseId);setResultKey('');setSelected([]);setViewers([]);setPriorId('');setConfigurationKey('');})}>选择原工作作为目标</Button></div>}
        <div className="button-row">
          {!historyLoaded&&<p><output>正在读取我的工作…</output></p>}
          {historyNext && (
            <Button
              type="button"
              onClick={() => run(async() => {await loadHistory(historyNext??undefined);})}
            >
              更多工作记录
            </Button>
          )}
        </div>
        {historyLoaded && !availableHistory.length && (
          <p className="empty-state">
            还没有可选择的工作记录。可以先在求助中记下已经做过的事。
          </p>
        )}
        <form
          className="workspace-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(prepare);
          }}
        >
          <label>
            这次怎样使用？
            <select
              value={kind}
              onChange={(e) => {
                const value=e.target.value;if(value==='reference'||value==='apply'||value==='reverify')setKind(value);
                setPriorId('');
                setSelected([]);
                setConfigurationKey('');
              }}
            >
              <option value="reference">加入工作参考</option>
              <option value="apply" disabled={!detail.newApplicationAllowed}>
                记录实际应用
              </option>
              <option value="reverify" disabled={!detail.newApplicationAllowed}>
                补充一次再验证
              </option>
            </select>
          </label>
          <label>
            用于哪项工作？
            <select
              required
              value={caseId}
              onChange={(e) => {
                setCaseId(e.target.value);
                setResultKey('');
                setSelected([]);
                setViewers([]);
                setPriorId('');
                setConfigurationKey('');
              }}
            >
              <option value="">选择一项已有工作</option>
              {availableHistory.map(c => (
                <option
                  key={c.caseId}
                  value={c.caseId}
                  disabled={
                    kind !== 'reference' &&
                    c.caseId === detail.version?.sourceResolution.caseId
                  }
                >
                  {c.title ?? '已获准的工作'}
                  {c.synthetic ? '（合成演示）' : ''}
                  {c.caseId === detail.version?.sourceResolution.caseId
                    ? '（源工作，不算新应用）'
                    : ''}
                </option>
              ))}
            </select>
          </label>
          {kind !== 'reference' && (
            <>
              <label>
                这次采用后得到的结果
                <select
                  required
                  value={resultKey}
                  onChange={(e) => {
                    setResultKey(e.target.value);
                    setSelected([]);
                    setPriorId('');
                    setConfigurationKey('');
                  }}
                >
                  <option value="">选择已经记录的结果</option>
                  {results.map(r => (
                    <option key={key(r)} value={key(r)}>
                      {r.summary} · {r.origin?.kind==='intervention'?'介入':'尝试'} · v{r.version} · {r.reportedOutcome}
                    </option>
                  ))}
                </select>
              </label>
              {result && (
                <p className="message">
                  原记录报告：{result.reportedOutcome}；环境：
                  {environment?.name==='unknown'?'未知':environment?.name??'等待核对'} /{' '}
                  {environment?.version==='unknown'?'未知':environment?.version??'等待核对'}
                  。{origin?.kind==='intervention'&&!configurationRef?'这项介入未选定原记录中的配置，不能推断与方法环境相同。':''}本表保留原来源与结果的准确版本。
                </p>
              )}
              {origin?.kind==='intervention'&&configurations.length>0&&<label>原介入已引用的配置（可选）<select value={configurationKey} disabled={kind==='reverify'} onChange={e=>setConfigurationKey(e.target.value)}><option value="">保持环境未知，不推断兼容</option>{configurations.map(c=><option key={key(c)} value={key(c)}>原配置 {c.id.slice(0,8)} · v{c.version}</option>)}</select>{kind==='reverify'&&<span className="muted">再验证沿用所选原应用的配置引用。</span>}</label>}
              {configurationError&&<p className="message error" role="alert">{configurationError}</p>}
              <label htmlFor={inputId+'-difference'}>
                与方法原环境的实际差异
                <Textarea
                  required
                  maxLength={1600}
                  value={difference}
                  onChange={(e) => setDifference(e.target.value)}
                  id={inputId+'-difference'}
                  placeholder="有哪些条件相同、不同或尚不明确？"
                />
              </label>
              <label htmlFor={inputId+'-parts'}>
                具体采用了哪些部分（每行一项）
                <Textarea
                  required
                  value={parts}
                  onChange={(e) => setParts(e.target.value)}
                  id={inputId+'-parts'}
                  placeholder="说明实际使用的步骤，而不是只写已经阅读"
                />
              </label>
              {kind === 'reverify' && (
                <>
                  <label>
                    已有的实际应用
                    <select
                      required
                      value={priorId}
                      onChange={(e) => {setPriorId(e.target.value);const p=prior.find(p=>p.eventId===e.target.value);setConfigurationKey(p?.record&&p.record.kind!=='reference'&&p.record.configurationRef?key(p.record.configurationRef):'');}}
                    >
                      <option value="">选择先前应用</option>
                      {prior.map(u => (
                        <option value={u.eventId} key={u.eventId}>
                          {u.record?.note} · {u.recordedAt}
                        </option>
                      ))}
                    </select>
                  </label>
                  <fieldset>
                    <legend>对所选结果精确版本的当前检查</legend>
                    {checks.map(v => (
                      <label key={key(v)}>
                        <input
                          type="checkbox"
                          checked={selected.includes(key(v))}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, key(v)]
                                : selected.filter((x) => x !== key(v)),
                            )
                          }
                        />
                        {v.record?.summary} · {v.record?.method} ·{' '}
                        {v.record?.observation} · v{v.version}
                      </label>
                    ))}
                    {!checks.length && (
                      <p>
                        没有当前可引用的检查。可以返回原任务记录实际验证，不必安排无关全量复测。
                      </p>
                    )}
                  </fieldset>
                </>
              )}
            </>
          )}
          <label htmlFor={inputId+'-note'}>
            这一次的说明
            <Textarea
              required
              maxLength={1600}
              id={inputId+'-note'}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <label>
            谁可以看到这条记录？
            <select
              value={visibility}
              onChange={(e) => {if(e.target.value==='Private'||e.target.value==='Public')setVisibility(e.target.value);}}
            >
              <option value="Private">本人和选定协作者</option>
              <option value="Public">公开这条选定记录</option>
            </select>
          </label>
          {visibility === 'Private' && (
            <fieldset>
              <legend>分享给协作者</legend>
              {people.map((id) => (
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
                  <span title={id}>{memberName(id,subjectId,displayNames[id]??undefined)}</span>
                </label>
              ))}
            </fieldset>
          )}
          <Button type="submit" disabled={!!configurationRef&&!currentConfiguration||kind==='reverify'&&(!priorId||!selected.length)}>预览这一条记录</Button>
        </form>
        {(source?.taskIds ?? []).map((id: string) => (
          <Button
            type="button"
            variant="link"
            key={id}
            onClick={() => navigate(`/app/tasks/${id}`)}
          >
            返回原任务，继续执行或补充事实
          </Button>
        ))}
      </fieldset>
    </section>
  );
}
