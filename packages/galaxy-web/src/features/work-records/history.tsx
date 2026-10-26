import {HistoryFields,historyRoleLabel,label,Context,humanTime} from './history-fields';
import {HistoryPeople,FactVersions,Participation,StructuredDownload,Item} from './history-items';
export {HistoryFields,historyRoleLabel};
import { ReadingDetails, ReadingSummary } from "../../shared/reading/reading-details";
import React from 'react';
import {TaskCurrentSourceItem} from "../tasks/materials/task-material-view";
import {Button} from '@/components/ui/button';
import {InterventionOpinions, ResolutionStatus} from "./presentation";
import {useMemberNames} from "../../shared/people/conversation-ui";
import "./history-people.css";
import {type HistoryFactsRecord,type HistoryPeopleRuntime} from "./history-types";
import {historyMethodPath} from "../profiles/person-recognition-view.mjs";

function authors(value:unknown):string[]{
 if(!value||typeof value!=='object')return[];
 return Object.entries(value).flatMap(([key,item])=>['actorId','reportedBy','subjectId','requesterId','decisionActor'].includes(key)&&typeof item==='string'?[item]:typeof item==='object'?authors(item):[]);
}

type HistoryFactsProps={record:HistoryFactsRecord;navigate?:(path:string)=>void;runtime?:HistoryPeopleRuntime;connected?:boolean;subjectId?:string};
export function HistoryFacts(props:HistoryFactsProps){
 return <TaskCurrentSourceItem runtime={props.runtime} item={props.record}>{record=><HistoryFactsBody {...props} record={record}/>}</TaskCurrentSourceItem>;
}
function HistoryFactsBody({record,navigate,runtime,connected=false,subjectId}:HistoryFactsProps){
 const readingKey=record.key?'galaxy-history-reading:'+JSON.stringify([runtime?.api.endpoint,subjectId??null,record.key]):null;
 const [tab,setTab]=React.useState(()=>{try{const saved=readingKey&&sessionStorage.getItem(readingKey);return saved==='results'||saved==='sources'?saved:'process';}catch{return 'process';}});
 function selectTab(next:string){setTab(next);try{if(readingKey)sessionStorage.setItem(readingKey,next);}catch{}}
 const people=useMemberNames(runtime??null,subjectId,connected,authors(record));
 const attempts=record.attempts??[],interventions=record.interventions??[],results=record.results??[],verification=record.verificationRecords??[],reuse=record.capsuleReuse?.items??[];
 const participation=record.kind==='task-history'?(record.participation??[]):(record.collaborations??[]);
 const hasProcess=attempts.length||interventions.length||participation.length;
 const hasResults=results.length||verification.length||reuse.length||record.proofs?.length||(record.resolution&&record.resolution.status!=='unrecorded');
 return <HistoryPeople.Provider value={{subjectId,names:people,navigate}}><div className="history-facts">
  {record.synthetic&&<p className="message">这是一份合成示例。</p>}
  {!!record.subjectRoles?.length&&<p className="history-meta">在这件事中：{record.subjectRoles.map(historyRoleLabel).join('、')}</p>}
  <nav className="history-fact-tabs" aria-label="经历详情">{[['process','过程与参与'],['results','结果与核查'],['sources','来源与记录']].map(([id,title])=><button type="button" key={id} aria-pressed={tab===id} onClick={()=>selectTab(id)}>{title}</button>)}</nav>
  {tab==='process'&&<div>
   {!!attempts.length&&<section className="history-fact-section"><h3>尝试过程</h3><div className="history-timeline"><FactVersions items={attempts} kind="尝试"/></div></section>}
   {!!interventions.length&&<section className="history-fact-section"><h3>各方做了什么</h3><div className="history-timeline"><FactVersions items={interventions} kind="参与" extra={value=><ReadingDetails><ReadingSummary>相关方的意见</ReadingSummary><InterventionOpinions intervention={{...value,confirmation:value.confirmation??''}} subjectId={subjectId} names={people}/></ReadingDetails>}/></div></section>}
   {!!participation.length&&<section className="history-fact-section"><h3>参与和交付</h3><Participation items={participation} navigate={navigate}/></section>}
   {!hasProcess&&<p className="history-empty">这份资料还没有可查看的过程记录。</p>}
  </div>}
  {tab==='results'&&<div>
   {!!results.length&&<section className="history-fact-section"><h3>实际结果</h3><FactVersions items={results} kind="结果"/></section>}
   {record.resolution&&record.resolution.status!=='unrecorded'&&<section className="history-fact-section"><h3>问题目前怎样</h3><ResolutionStatus resolution={record.resolution} resolutions={record.resolutions}/></section>}
   {!!verification.length&&<section className="history-fact-section"><h3>做过的核查</h3><FactVersions items={verification} kind="核查"/></section>}
   {!!record.proofs?.length&&<section className="history-fact-section"><h3>自动检查的证据</h3><p className="muted">这些证据对应具体的自动检查范围。</p>{record.proofs.map((proof,index)=><article key={proof.proofId??index} className="history-fact-item"><h4>{label(proof.status??'尚未说明检查状态')}</h4><Context value={proof}/></article>)}</section>}
   {!!reuse.length&&<section className="history-fact-section"><h3>参考与实际应用的方法</h3>{reuse.map((value,index)=>{const methodPath=historyMethodPath(value),body=value.record??value,kind=body.kind??value.kind;return <Item key={value.eventId??value.id??index} value={value} kind={kind==='reference'?'曾引用的方法':'实际应用方法'}><p className="fact-note">{kind==='reference'?'加入了参考，尚未记录实际采用后的结果。':value.applicationStatus?label(value.applicationStatus):'以本项所记录的结果和条件为准。'}</p>{methodPath&&navigate&&<Button type="button" variant="link" onClick={()=>navigate(methodPath)}>阅读当时使用的方法版本</Button>}</Item>;})}</section>}
   {!hasResults&&<p className="history-empty">还没有可查看的结果或核查记录。</p>}
  </div>}
  {tab==='sources'&&<div className="history-source-notes">
   <h3>这份经历从哪里来</h3><p>内容来自当前允许阅读的工作和参与记录。本人报告、相关方意见与独立核查保留各自含义。</p>
   {record.publication?.recordedAt&&<p>最初记录于 {humanTime(record.publication.recordedAt)}。</p>}
   {!!record.matchReasons?.length&&<section><h4>与你的查找相关</h4><ul>{record.matchReasons.map((reason,index)=><li key={index}>{reason.kind==='visible-field-text'?'包含“'+reason.term+'”':reason.kind==='declared-task-capability'?'任务声明涉及 '+reason.capabilityId:reason.kind==='same-task'?'来自当前工作':reason.kind==='different-task'?'另一项可供参考的工作':reason.kind==='environment-field-match'?'记录的环境包含 '+reason.requestedEnvironment+'；兼容性仍需按具体条件判断':reason.kind.startsWith('environment-')?'缺少与 '+reason.requestedEnvironment+' 足够可比较的环境信息':'按当前条件匹配到的可读记录'}</li>)}</ul></section>}
   {!!record.events?.length&&<section className="history-fact-section"><h3>记录沿革</h3><div className="history-timeline">{record.events.map((value,index)=><Item key={value.eventId??index} value={value} kind="工作记录"/>)}</div></section>}
   {!!record.taskIds?.length&&navigate&&<section><h3>相关工作</h3>{record.taskIds.map((id:string,index:number)=><Button key={id} type="button" variant="outline" onClick={()=>navigate('/app/tasks/'+id)}>{record.taskIds?.length===1?'打开相关工作':'相关工作 '+(index+1)}</Button>)}</section>}
   <section className="history-fact-section"><h3>用于进一步核对</h3><p>下载包含本次可见字段、准确版本和来源引用，可交给自己的 Agent 分析。资料开放范围不会随下载扩大。</p><StructuredDownload record={record}/></section>
  </div>}
 </div></HistoryPeople.Provider>;
}
