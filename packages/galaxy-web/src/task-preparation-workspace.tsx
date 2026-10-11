import {useCurrentTaskMaterialTree} from './task-material-view';
import React,{useState} from 'react';
import {Button} from '@/components/ui/button';
import {MemberAvatar,memberName,useMemberNames} from './conversation-ui';
import type {PreparationSource,PreparationProps} from './task-preparation-view-types';
import './task-help-continuation.css';

function contribution(source:PreparationSource,subjectId:string){
 const record=source.item.record??{};
 if(source.item.type==='opportunity')return source.item.summary??'';
 const texts=[
  ...(record.attempts??[]).filter(item=>item.actorId===subjectId).map(item=>item.summary||item.strategy),
  ...(record.interventions??[]).filter(item=>item.actorId===subjectId).map(item=>item.summary),
  ...(record.verificationRecords??[]).filter(item=>(item.reportedBy??item.record?.reportedBy)===subjectId).map(item=>item.summary??item.record?.summary),
 ].filter((text):text is string=>typeof text==='string'&&!!text.trim());
 return [...new Set(texts)].join('\n')||source.item.summary||'';
}
function CandidateSource({source,subjectId}:{source:PreparationSource;subjectId:string}){
 const text=contribution(source,subjectId),synthetic=source.item.record?.synthetic===true;
 return <section className="request-help-source">
  <p className="request-help-source-kind">{source.item.type==='opportunity'?'本人表达的交流意愿':'已有工作'}{synthetic?' · 合成示例':''}</p>
  <h4>{source.item.title}</h4>
  <p className="request-help-excerpt">{text}</p>
  <details className="request-help-reference"><summary>阅读这份来源</summary>{text&&<p className="request-help-full">{text}</p>}{source.item.summary&&source.item.summary!==text&&<><h5>这项工作的背景</h5><p className="request-help-full">{source.item.summary}</p></>}<p className="request-help-locator">来源 <code>{source.item.ref.id}</code> · 版本 <code>{source.item.ref.version}</code></p></details>
 </section>;
}
export function TaskPreparationWorkspace(props:PreparationProps){
 return <PreparationResults key={JSON.stringify(props.value?.input??null)} {...props}/>;
}
function PreparationResults({runtime,subjectId,connected,value:readValue,selected,busy,disabled=false,error,onChange,onRetry}:PreparationProps){
 const [shown,setShown]=useState(8);
 const value=useCurrentTaskMaterialTree(runtime,readValue);
 const candidates=value?.candidates??[],names=useMemberNames(runtime,subjectId,connected,[...selected,...candidates.map(item=>item.subjectId)]);
 const missing=selected.filter(id=>!candidates.some(candidate=>candidate.subjectId===id));
 const rows=candidates.filter((candidate,index)=>index<shown||selected.includes(candidate.subjectId)),failed=value?.pages.filter(page=>page.error)??[];
 const choose=(id:string)=>onChange(selected.includes(id)?selected.filter(value=>value!==id):[...selected,id]);
 return <section className="request-help-results" aria-label="相关帮助" aria-busy={busy}>
  {busy&&!value&&<p className="request-help-note"><output>正在查找相关的工作与人…</output></p>}
  {error&&<p className="request-source-error" role="alert">{error}</p>}
  {failed.map(page=><p className="request-source-error" key={page.type}>{page.type==='history'?'已有工作':'交流意愿'}暂时无法读取，其他结果仍可查看。</p>)}
  {value?.pages.some(page=>page.sourceState==='disabled')&&<p className="request-help-note">交流发现当前未开启，已有工作仍可查找。</p>}
  {value&&<p className="request-help-note">{selected.length?'已记下 '+selected.length+' 位，发布后可以继续了解或决定是否联系。':'先看看对方做过什么，也可以记下感兴趣的人。'}发布不会发送邀请。</p>}
  {!busy&&value&&!candidates.length&&!failed.length&&<p className="request-help-note">当前可读范围里还没找到相关的人。可以换个词，也可以直接发布求助等待回应。</p>}
  <div className="request-help-people">{rows.map(candidate=><article className="request-help-person" key={candidate.subjectId}>
   <label className="request-help-person-choice"><input type="checkbox" checked={selected.includes(candidate.subjectId)} disabled={disabled||(!selected.includes(candidate.subjectId)&&selected.length>=32)} onChange={()=>choose(candidate.subjectId)}/><MemberAvatar subjectId={candidate.subjectId}/><span><strong>{memberName(candidate.subjectId,subjectId,names[candidate.subjectId]??candidate.displayName)}</strong><small>{selected.includes(candidate.subjectId)?'已记下，发布后再看':'记下这个人'}</small></span></label>
   {candidate.sources[0]&&<CandidateSource source={candidate.sources[0]} subjectId={candidate.subjectId}/>}
   {candidate.sources.length>1&&<details className="request-help-other-sources"><summary>还有 {candidate.sources.length-1} 份来源</summary>{candidate.sources.slice(1).map(source=><CandidateSource key={source.item.type+':'+source.item.ref.id+':'+source.item.ref.version} source={source} subjectId={candidate.subjectId}/>)}</details>}
   {candidate.willingness&&<p className="request-help-note">对方表达过交流意愿，是否参加这次工作仍需本人回应。</p>}
  </article>)}</div>
  {rows.length<candidates.length&&<Button type="button" variant="ghost" disabled={disabled} onClick={()=>setShown(value=>value+8)}>查看更多相关的人</Button>}
  {!busy&&missing.length>0&&<div className="request-help-unavailable"><p>以下已记下的人的原来源已变化或暂时不可读，原选择仍保留。</p>{missing.map(id=><div key={id}><span>{memberName(id,subjectId,names[id]??undefined)}</span><button type="button" className="text-action" disabled={disabled} onClick={()=>choose(id)}>取消保留</button></div>)}</div>}
  {(error||failed.length>0)&&<Button type="button" variant="ghost" disabled={busy||disabled} onClick={onRetry}>再试一次</Button>}
  {value?.pages.some(page=>page.nextCursor)&&<p className="request-help-note">还有其他来源，发布后可以继续查找。</p>}
 </section>;
}
