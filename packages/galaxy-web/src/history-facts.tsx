import React from 'react';
import {Button} from '@/components/ui/button';

const names:Record<string,string>={
  attempts:'尝试',interventions:'介入',results:'结果',actorId:'实际参与主体',reportedBy:'记录提供者',subjectId:'银河 ID',requesterId:'请求方',id:'对象标识',eventId:'来源事件',caseId:'案例标识',taskId:'任务标识',participationId:'参与标识',version:'对象版本',currentVisibleVersion:'当前可见版本',source:'来源',sourceRefs:'来源引用',sourceScope:'本次来源范围',recordedAt:'记录时间',observedAt:'观察时间',startedAt:'开始时间',endedAt:'结束时间',role:'承担角色',types:'介入方式',strategy:'尝试策略',description:'实际工作',summary:'说明',title:'标题',failureReason:'失败原因',reportedOutcome:'报告结果',status:'记录状态',environment:'环境',configuration:'配置',configurationRef:'配置引用',configurationVersion:'配置版本',model:'模型',modelVersion:'模型版本',tools:'工具',skills:'Skill',mcpRefs:'MCP 引用',parameters:'参数',promptRefs:'提示引用',affectsAttemptIds:'所涉及尝试',observedEffect:'观察到的影响',limitations:'适用限制',origin:'直接事实来源',deliverableRefs:'交付引用',target:'核对目标',method:'验证方法',scope:'验证范围',conditions:'验证条件',observation:'观察结论',evidenceRefs:'证据引用',relationship:'声明关系',provenance:'来源信息',referenceStatus:'引用当前状态',currentVersion:'来源当前版本',record:'具体记录',recordedRelationship:'系统可识别的关系',relationshipIndependentlyVerified:'关系是否独立核验',acceptance:'有限交付接收',acceptanceMeaning:'接收含义',resultRef:'结果引用',interventionRefs:'介入引用',scopeVersion:'范围版本',agreedScope:'约定范围',scopeAvailable:'范围正文当前可读',events:'当前可读事件',deliveries:'具体交付',deliveryId:'交付标识',at:'发生时间',event:'事件内容',kind:'类型',reason:'原因',supersededInVisibleHistory:'已被后续可见版本更正',capabilityVerified:'是否据此认证能力',taskOutcomeVerified:'是否据此验证整个任务',synthetic:'合成数据标记',workPerformedInferred:'是否据此推断已实际工作',rules:'规则',ruleId:'规则标识',ruleVersion:'规则版本',sourceHash:'当前可见来源摘要',checkedAt:'本次核对时间',recordedSourceState:'记录的来源状态',availability:'可用状态',proofId:'CI 证明标识',capsuleId:'Capsule 标识',applicationId:'实际应用标识',conclusion:'结论',state:'状态',rebuild:'按当前可见来源重建',authorization:'当前授权',integrity:'记录完整性',externalOwnershipVerified:'外部归属是否核验',toolsUsed:'实际工具',mcpServers:'MCP 服务',skillsUsed:'实际 Skill',
};
const values:Record<string,string>={failed:'未成功',partial:'部分完成',succeeded:'报告成功',inconclusive:'尚无定论',conflicting:'结论存在冲突',diagnosis:'诊断',advice:'建议',patch:'补丁',verification:'验证',review:'复核','tool-introduction':'引入工具','context-addition':'补充背景',takeover:'接管',requester:'请求方','verification-reporter':'验证记录提供者',current:'当前来源一致',superseded:'已有后续版本',revoked:'已撤销',expired:'已到期','dependency-unavailable':'所依赖来源当前不可用','target-version-changed':'所核对目标已有新版本','source-unavailable':'来源当前不可用',available:'当前可用',unrecorded:'尚未记录','not-provided':'尚未提供',passed:'范围内通过',reference:'仅引用或阅读',application:'实际应用记录'};
const label=(v:string)=>values[v]??v;
export function HistoryFields({value}:{value:any}):React.ReactElement {
  if(value===null||value===undefined)return <span className="muted">未提供或当前不可读</span>;
  if(Array.isArray(value))return value.length?<ul>{value.map((item,index)=><li key={index}><HistoryFields value={item}/></li>)}</ul>:<span className="muted">本次没有可见记录</span>;
  if(typeof value==='object')return <dl className="fact-details">{Object.entries(value).map(([key,item])=><React.Fragment key={key}><dt>{names[key]??key}</dt><dd style={{overflowWrap:'anywhere'}}><HistoryFields value={item}/></dd></React.Fragment>)}</dl>;
  return <span>{typeof value==='boolean'?(value?'是':'否'):typeof value==='string'?label(value):String(value)}</span>;
}
function Group({title,items}:{title:string;items:any[]}){return <section><h4>{title}（本次可见 {items.length} 项）</h4>{!items.length?<p className="muted">当前没有可读记录；不由此推断没有做过相关工作。</p>:items.map((v,index)=><details key={`${v.id??v.eventId??v.proofId??index}:${v.version??''}`}><summary>{v.summary??v.description??v.strategy??v.title??v.record?.summary??v.kind??`${title} ${index+1}`}{v.supersededInVisibleHistory?' · 已有后续版本':''}</summary><HistoryFields value={v}/></details>)}</section>;}
export function HistoryFacts({record,navigate}:{record:any;navigate?:(path:string)=>void}) {
  const tasks=record.taskIds??[],groups=record.kind==='task-history'?[['参与与交付',record.participation??[]]]:[
    ['尝试、失败与环境配置',record.attempts??[]],['每一方的实际介入',record.interventions??[]],['结果与适用限制',record.results??[]],
    ['证据与验证记录',record.verificationRecords??[]],['CI 来源证明',record.proofs??[]],['相关任务及各方交付',record.collaborations??[]],['Capsule 引用与实际复用',record.capsuleReuse?.items??[]],
  ];
  return <div className="history-facts"><p>主体角色：{record.subjectRoles?.map(label).join('、')||'当前记录未给出'}。这些事实不自动形成总分、能力认证或当前参与意愿。</p>
    <p><strong>来源：</strong>{record.caseId?`案例 ${record.caseId}`:`任务 ${record.taskId}`}；当前只展示本次允许读取的事实。</p>
    {record.synthetic&&<p className="message">合成演示或测试数据，不能当作真实试点。</p>}
    {!!record.matchReasons?.length&&<details><summary>为何出现在本次查询中</summary>{record.matchReasons.map((r:any,index:number)=><p key={index}>{r.kind==='visible-field-text'?`可见字段含关键词：${r.term}`:r.kind==='declared-task-capability'?`任务声明能力标识：${r.capabilityId}；不等于认证`:
      r.kind==='same-task'?`与当前任务相同：${r.taskId}`:r.kind==='different-task'?`属于其他任务；用于比较的当前任务：${r.taskId}`:r.kind==='environment-field-match'?`环境字段含 ${r.requestedEnvironment}；兼容性尚未验证`:r.kind==='environment-unknown'?`未提供可比较环境；目标环境：${r.requestedEnvironment}`:r.kind==='environment-different-or-unknown'?`环境不同或信息不足；目标环境：${r.requestedEnvironment}`:r.kind}</p>)}</details>}
    {groups.map(([title,items])=><Group key={title as string} title={title as string} items={items as any[]}/>)}
    {record.resolution&&<details><summary>问题解决状态与支持来源</summary><HistoryFields value={record.resolution}/><p>接收有限交付、通过某项检查和整个问题解决分别记录。</p></details>}
    {record.publication&&<details><summary>发布来源</summary><HistoryFields value={record.publication}/></details>}
    {record.events&&<Group title="可追溯的原始事件" items={record.events}/>}
    {navigate&&!!tasks.length&&<div className="button-row">{tasks.map((id:string)=><Button type="button" variant="outline" key={id} onClick={()=>navigate(`/app/tasks/${id}`)}>打开相关任务 {id.slice(0,8)}</Button>)}</div>}
    <details><summary>完整来源字段与准确版本</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:460,overflow:'auto'}}>{JSON.stringify(record,null,2)}</pre></details>
  </div>;
}
