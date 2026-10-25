import { ReadingDetails, ReadingSummary } from "../../reading-details";
import React from 'react';
import {TaskCurrentSourceItem} from "../../task-material-view";
import {Button} from '@/components/ui/button';
import {InterventionOpinions, ResolutionStatus} from "./presentation";
import {MemberAvatar,MemberLink,memberName,useMemberNames} from "../../conversation-ui";
import "./history-people.css";
import {historyObject,type HistoryFactItem,type HistoryParticipation,type HistoryFactsRecord,type HistoryPeopleRuntime} from "./history-types";
import {groupHistoryVersions} from "../../history-versions.mjs";
import {historyMethodPath} from "../../person-recognition-view.mjs";

const HistoryPeople=React.createContext<{subjectId?:string;names:Record<string,string|null>;navigate?:(path:string)=>void}>({names:{}});
function Author({id}:{id?:string}){
 const people=React.useContext(HistoryPeople);
 return id?<span className="history-fact-author">{people.navigate?<MemberLink subjectId={id} name={people.names[id]??undefined} ownId={people.subjectId} navigate={people.navigate} avatar/>:<><MemberAvatar subjectId={id}/><strong>{memberName(id,people.subjectId,people.names[id]??undefined)}</strong></>}</span>:null;
}
function authors(value:unknown):string[]{
 if(!value||typeof value!=='object')return[];
 return Object.entries(value).flatMap(([key,item])=>['actorId','reportedBy','subjectId','requesterId','decisionActor'].includes(key)&&typeof item==='string'?[item]:typeof item==='object'?authors(item):[]);
}

const names:Record<string,string>={applicationStatus:'应用结果当前状态',sourceStatus:'来源当前状态',capsuleSourceStatus:'方法来源当前状态',
  responseCoverage:'回应读取范围',mode:'读取方式',complete:'当前范围完整',
  responses:'各方意见',confirmation:'其他相关方确认状态',claimState:'工作声明来源',self:'作者本人',priorResolutionId:'先前决定标识',currentSupport:'当前支持来源状态',currentDecisionAvailable:'当前决定仍可成立',reconfirmationRequired:'是否需要重新确认',resolutions:'按当时范围记录的决定',decisionActor:'决定记录者',satisfiedGoals:'当时已满足目标',remainingGoals:'尚待完成目标',resultRefs:'引用结果及准确版本',verificationRefs:'引用验证及准确版本',supersedesResolutionId:'被更新的先前决定',
  attempts:'尝试',interventions:'介入',results:'结果',actorId:'实际参与主体',reportedBy:'记录提供者',subjectId:'银河 ID',requesterId:'请求方',id:'对象标识',eventId:'来源事件',caseId:'案例标识',taskId:'任务标识',participationId:'参与标识',version:'对象版本',currentVisibleVersion:'当前可见版本',source:'来源',sourceRefs:'来源引用',sourceScope:'本次来源范围',recordedAt:'记录时间',observedAt:'观察时间',startedAt:'开始时间',endedAt:'结束时间',role:'承担角色',types:'介入方式',strategy:'尝试策略',description:'实际工作',summary:'说明',title:'标题',failureReason:'失败原因',reportedOutcome:'报告结果',status:'记录状态',environment:'环境',configuration:'配置',configurationRef:'配置引用',configurationVersion:'配置版本',model:'模型',modelVersion:'模型版本',tools:'工具',skills:'Skill',mcpRefs:'MCP 引用',parameters:'参数',promptRefs:'提示引用',affectsAttemptIds:'所涉及尝试',observedEffect:'观察到的影响',limitations:'适用限制',origin:'直接事实来源',originRef:'原工作与准确版本',environmentSource:'环境说明来源',attemptRef:'原尝试引用',priorUseId:'先前实际应用',versionId:'方法版本标识',adoptedParts:'实际采用部分',environmentDifference:'与原环境的差异',deliverableRefs:'交付引用',target:'核对目标',method:'验证方法',scope:'验证范围',conditions:'验证条件',observation:'观察结论',evidenceRefs:'证据引用',relationship:'声明关系',provenance:'来源信息',referenceStatus:'引用当前状态',currentVersion:'来源当前版本',record:'具体记录',recordedRelationship:'系统可识别的关系',relationshipIndependentlyVerified:'关系是否独立核验',acceptance:'有限交付接收',acceptanceMeaning:'接收含义',resultRef:'结果引用',interventionRefs:'介入引用',scopeVersion:'范围版本',agreedScope:'约定范围',scopeAvailable:'范围正文当前可读',events:'当前可读事件',deliveries:'具体交付',deliveryId:'交付标识',at:'发生时间',event:'事件内容',kind:'类型',reason:'原因',supersededInVisibleHistory:'已被后续可见版本更正',capabilityVerified:'是否据此认证能力',taskOutcomeVerified:'是否据此验证整个任务',synthetic:'合成数据标记',workPerformedInferred:'是否据此推断已实际工作',rules:'规则',ruleId:'规则标识',ruleVersion:'规则版本',sourceHash:'当前可见来源摘要',checkedAt:'本次核对时间',recordedSourceState:'记录的来源状态',availability:'可用状态',proofId:'CI 证明标识',capsuleId:'Capsule 标识',applicationId:'实际应用标识',conclusion:'结论',state:'状态',rebuild:'按当前可见来源重建',authorization:'当前授权',integrity:'记录完整性',externalOwnershipVerified:'外部归属是否核验',toolsUsed:'实际工具',mcpServers:'MCP 服务',skillsUsed:'实际 Skill',
};
const values:Record<string,string>={failed:'未成功',partial:'部分完成',succeeded:'报告成功',inconclusive:'尚无定论',conflicting:'结论存在冲突',diagnosis:'诊断',advice:'建议',patch:'补丁',verification:'验证',review:'复核','tool-introduction':'引入工具','context-addition':'补充背景',takeover:'接管',requester:'请求方','verification-reporter':'验证记录提供者',current:'当前来源一致',superseded:'已有后续版本',revoked:'已撤销',expired:'已到期','dependency-unavailable':'所依赖来源当前不可用','target-version-changed':'所核对目标已有新版本','source-unavailable':'来源当前不可用',available:'当前可用',unrecorded:'尚未记录','not-provided':'尚未提供',passed:'范围内通过',reference:'仅引用或阅读',application:'实际应用记录',apply:'实际应用',reverify:'原应用的再验证',intervention:'实际介入',attempt:'尝试','unknown-origin-conditions':'原工作条件未知，不推断兼容','selected-origin-configuration; subject-reported':'原介入已引用的选定配置（本人报告）','recorded-attempt; subject-reported':'原尝试记录的条件（本人报告）'};
const currentFactValues:Record<string,string>={'source-currentness-unavailable':'来源结果的当前支持状态未知（不推断失效或失败）','application-currentness-unavailable':'历史应用结果的当前支持状态未知（原报告保留，不计当前有效成功）',self:'作者本人意见（不计作其他相关方确认）',participant:'其他参与者',accepted:'已接受','self-declared':'作者自述',unconfirmed:'尚无其他相关方确认',confirmed:'其他相关方已确认','partially-confirmed':'其他相关方部分确认',disputed:'有异议',resolved:'已解决（请求者记录）',unresolved:'尚未解决','partially-resolved':'部分解决',regressed:'出现回退','referenced-result-superseded':'引用的结果已更正，需要重新确认','referenced-result-currentness-unavailable':'结果当前版本资料不完整，需要重新确认'};
const label=(v:string)=>v==='currently-authorized-latest-per-actor'?'按当前授权读取各方最新意见':currentFactValues[v]??values[v]??v;
export function HistoryFields({value}:{value:unknown}):React.ReactElement {
  if(value===null||value===undefined)return <span className="muted">未提供或当前不可读</span>;
  if(Array.isArray(value))return value.length?<ul>{value.map((item,index)=><li key={index}><HistoryFields value={item}/></li>)}</ul>:<span className="muted">本次没有可见记录</span>;
  const object=historyObject(value);
  if(object)return <dl className="fact-details">{Object.entries(object).map(([key,item])=><React.Fragment key={key}><dt>{names[key]??key}</dt><dd style={{overflowWrap:'anywhere'}}>{key==='confirmation'&&historyObject(object.responseCoverage)?.complete===false?<span>当前回应范围不可确认</span>:key==='state'&&object.interventionRef?<span>{({accepted:'认可这项介入',partial:'部分认可',disputed:'有异议'} as Record<string,string>)[String(item)]??'意见状态未提供'}</span>:<HistoryFields value={item}/>}</dd></React.Fragment>)}</dl>;
  return <span>{typeof value==='boolean'?(value?'是':'否'):typeof value==='string'?label(value):typeof value==='number'||typeof value==='bigint'?String(value):'当前格式暂不可显示'}</span>;
}
export const historyRoleLabel=(value:string)=>({'capsule-applicant':'实际应用方法','reporter; executor-unknown':'提供记录，执行者未说明',helper:'协助',worker:'参与工作',contributor:'贡献者',contribution:'参与',implementation:'实施',context:'补充背景',tool:'引入工具','main-responsible':'主要负责人',provider:'提供帮助',owner:'发起人'} as Record<string,string>)[value]??label(value);
const humanTime=(value:unknown)=>{if(typeof value!=='number'&&typeof value!=='string')return null;const date=new Date(typeof value==='number'?value*1000:value);return value&&Number.isFinite(date.getTime())?date.toLocaleString():null;};
const textValue=(value:unknown):string=>{if(typeof value==='string')return label(value);if(typeof value==='number')return String(value);if(typeof value==='boolean')return value?'是':'否';if(Array.isArray(value))return value.map(textValue).filter(Boolean).join('、');const object=historyObject(value);return object?textValue(object.title??object.summary??object.description??object.name??''):'';};
function Context({value:input}:{value:unknown}){
 const value=historyObject(input);if(!value)return input?<p>{textValue(input)}</p>:null;
 const allowed=['environment','configuration','model','modelVersion','version','tools','toolsUsed','skills','skillsUsed','mcpServers','mcpRefs','parameters','promptRefs','scope','conditions','limitations','environmentDifference','adoptedParts','agreedScope','method','target','provenance','sourceStatus','referenceStatus','applicationStatus','currentSupport'];
 const entries=allowed.filter(key=>value[key]!==undefined&&value[key]!==null&&(!Array.isArray(value[key])||value[key].length>0));
 return entries.length?<dl className="history-fact-context">{entries.map(key=><div key={key}><dt>{names[key]??key}</dt><dd>{typeof value[key]==='object'?<HistoryFields value={value[key]}/>:textValue(value[key])}</dd></div>)}</dl>:null;
}
function Item({value,kind,children}:{value:HistoryFactItem;kind:string;children?:React.ReactNode}){
 const v=value.record??value.payload??value;
 const title=v.title??v.strategy??v.description??v.summary??(v.kind?label(v.kind):kind);
 const lines=[v.description,v.summary,v.observation,v.observedEffect,v.failureReason,typeof v.note==='string'?v.note:undefined].filter((line,index,array)=>typeof line==='string'&&line!==title&&array.indexOf(line)===index);
 const reported=v.reportedOutcome??v.conclusion??(typeof v.outcome==='string'?v.outcome:undefined);
 const at=humanTime(v.observedAt??v.endedAt??v.startedAt??value.recordedAt??value.at);
 const hasContext=['environment','configuration','model','tools','toolsUsed','scope','conditions','limitations','environmentDifference','adoptedParts','agreedScope','method','target','provenance','sourceStatus','referenceStatus','applicationStatus'].some(key=>v[key]!==undefined);
 return <article className="history-fact-item"><Author id={v.actorId??v.reportedBy??value.actorId??value.reportedBy}/><h4>{title}</h4><div className="fact-byline">{at&&<time>{at}</time>}{v.role&&<span> · {historyRoleLabel(v.role)}</span>}{v.types&&v.types.length>0&&<span> · {v.types.map(historyRoleLabel).join('、')}</span>}{value.supersededInVisibleHistory&&<span> · 已有后续修订</span>}</div>
  {lines.map((line,index)=><p key={index}>{line}</p>)}
  {reported&&<p className="fact-note">{v.reportedOutcome?'记录者报告：':'本项结论：'}{label(reported)}</p>}
  {hasContext&&<ReadingDetails><ReadingSummary>{kind==='尝试'?'使用条件与环境':'范围与具体条件'}</ReadingSummary><Context value={v}/></ReadingDetails>}
  {children}
 </article>;
}
function Participation({items,navigate}:{items:HistoryParticipation[];navigate?:(path:string)=>void}){
 return <>{items.map((item,index)=><article className="history-fact-item" key={item.participationId??item.taskId??index}>
  <Author id={item.subjectId??item.requesterId}/><h4>{item.title??item.request?.title??(item.role?historyRoleLabel(item.role):'共同参与')}</h4>
  {item.agreedScope&&<p>{typeof item.agreedScope==='string'?item.agreedScope:item.agreedScope.summary??item.agreedScope.description}</p>}
  {item.participation&&<Participation items={item.participation} navigate={navigate}/>}
  {item.deliveries?.map((delivery,i)=><div key={delivery.deliveryId??i}><p>{delivery.summary??'这项交付的正文当前不可读取。'}</p>{delivery.acceptance&&<p className="fact-note">请求方已接收这项交付。{humanTime(delivery.acceptance.at)}</p>}</div>)}
  {item.taskId&&navigate&&<Button type="button" variant="link" onClick={()=>navigate('/app/tasks/'+item.taskId)}>打开这项工作</Button>}
 </article>)}</>;
}
function FactVersions<T extends HistoryFactItem>({items,kind,extra}:{items:T[];kind:string;extra?:(item:T)=>React.ReactNode}){
 return <>{groupHistoryVersions(items).map(({latest,previous},index)=><div className="history-fact-series" key={latest.id??index}>
  <Item value={latest} kind={kind}>{extra?.(latest)}</Item>
  {previous.length>0&&<ReadingDetails className="history-revisions"><ReadingSummary>此前 {previous.length} 次记录</ReadingSummary><ol>{previous.map((item,i)=><li key={item.version??i}><Item value={item} kind={kind}>{extra?.(item)}</Item></li>)}</ol></ReadingDetails>}
 </div>)}</>;
}
function StructuredDownload({record}:{record:HistoryFactsRecord}){
 return <button className="history-source-download" type="button" onClick={()=>{const blob=new Blob([JSON.stringify(record,null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='galaxy-history-'+String(record.key??'record').replace(/[^a-z0-9-]/gi,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>下载当前可见的完整记录</button>;
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
