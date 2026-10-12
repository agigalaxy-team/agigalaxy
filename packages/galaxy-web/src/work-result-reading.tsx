import React,{useEffect,useState} from 'react';
import {MemberLink} from './conversation-ui';
import type {WorkFacts,WorkResult,WorkFactClient,WorkSourceRef,WorkRecordView} from './work-fact-types';

const outcomes:Record<string,string>={succeeded:'达到所述结果',partial:'部分达到',failed:'未达到',inconclusive:'尚不明确',conflicting:'存在冲突'};
const sourceNames:Record<string,string>={attempt:'尝试过程',intervention:'相关工作',result:'相关结果',evidence:'所附来源',configuration:'使用条件','selected-message':'对话原话','outcome-material':'成果材料'};
const safeLink=(value:unknown)=>{if(typeof value!=='string')return null;try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}};
function EvidenceReading({source,client,revision}:{source:WorkSourceRef;client:WorkFactClient;revision:WorkFacts}){
 const [state,setState]=useState<{revision:WorkFacts;value:WorkRecordView|null;error:boolean}|null>(null);
 useEffect(()=>{let current=true;void client.readRecord({type:'evidence',id:source.id,version:source.version}).then(value=>{if(current)setState({revision,value,error:false});}).catch(()=>{if(current)setState({revision,value:null,error:true});});return()=>{current=false;};},[client,source.id,source.version,revision]);
 const reading=state?.revision===revision?state:null,record=reading?.value?.record,link=safeLink(record?.source?.uri);
 return <div className="result-source-body">{!reading?<p><output>正在读取来源…</output></p>:reading.error||!record?<p>这份来源目前无法读取，请稍后重新打开。</p>:<><p className="reading-prose">{record.summary}</p>{record.source?.issuer&&<p className="muted">提供者：{record.source.issuer}</p>}{link&&<a className="text-action" href={link} target="_blank" rel="noopener noreferrer">打开原始来源 ↗</a>}</>}</div>;
}
function ResultSource({source,facts,client,navigate}:{source:WorkSourceRef;facts:WorkFacts;client:WorkFactClient;navigate:(path:string)=>void}){
 const [open,setOpen]=useState(false),fact=(source.kind==='attempt'?facts.attempts:source.kind==='intervention'?facts.interventions:source.kind==='result'?facts.results:[]).find(item=>item.id===source.id&&item.version===source.version);
 const returnTo=location.pathname+location.search+location.hash;
 return <details className="work-context result-source" onToggle={event=>setOpen(event.currentTarget.open)}><summary>{sourceNames[source.kind]??'所附来源'} · 第 {source.version} 版</summary>
  {open&&source.kind==='evidence'?<EvidenceReading source={source} client={client} revision={facts}/>:fact?<p className="reading-prose">{fact.description??fact.strategy??fact.summary}</p>:source.kind==='configuration'?<button className="text-action" onClick={()=>navigate('/app/configurations?configurationId='+source.id+'&version='+source.version+'&returnTo='+encodeURIComponent(returnTo))}>打开这次使用的配置</button>:source.kind!=='evidence'?<p className="muted">这份来源的正文可在原材料中核对。</p>:null}
  <details className="source-locator"><summary>来源记录信息</summary><p>{source.id} · 第 {source.version} 版</p></details>
 </details>;
}
export function WorkResultReading({item,facts,client,subjectId,names,navigate,download,children}:{item:WorkResult;facts:WorkFacts;client:WorkFactClient;subjectId:string;names:Record<string,string|null>;navigate:(path:string)=>void;download:()=>void;children?:React.ReactNode}){
 const origin=(item.origin.kind==='intervention'?facts.interventions:facts.attempts).find(source=>source.id===item.origin.id&&source.version===item.origin.version);
 return <article className="work-entry result-reading" aria-label="结果正文">
  <header><MemberLink subjectId={item.actorId} ownId={subjectId} name={names[item.actorId]??undefined} navigate={navigate} avatar/><span>这段工作的结果：{outcomes[item.reportedOutcome]??'尚无判断'} · 本人记录</span></header>
  <p className="reading-prose work-entry-body">{item.summary}</p>
  {item.limitations&&<section className="work-observation"><h3>适用范围与未完成的部分</h3><p className="reading-prose">{item.limitations}</p></section>}
  {children}
  <section className="result-origin"><h3>这份结果来自哪项工作</h3><p className="reading-prose">{origin?.description??origin?.strategy??'该版本的来源正文当前不可读。'}</p>{origin?.observedEffect&&<p className="reading-prose">{origin.observedEffect}</p>}</section>
  {!!item.deliverableRefs.length&&<section className="result-sources"><h3>随结果附上的资料</h3>{item.deliverableRefs.map(source=><ResultSource key={source.kind+':'+source.id+':'+source.version} {...{source,facts,client,navigate}}/>)}</section>}
  <details className="work-context"><summary>记录与版本信息</summary><p>工作来源第 {item.origin.version} 版 · 结果第 {item.version} 版</p><button className="text-action" onClick={download}>保存记录与来源编号</button></details>
 </article>;
}
