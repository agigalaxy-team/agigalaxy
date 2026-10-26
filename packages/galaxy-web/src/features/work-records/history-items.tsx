import React from 'react';
import {ReadingDetails,ReadingSummary} from "../../shared/reading/reading-details";
import {Button} from '@/components/ui/button';
import {MemberAvatar,MemberLink,memberName} from "../../shared/people/conversation-ui";
import {groupHistoryVersions} from "./history-versions.mjs";
import type {HistoryFactItem,HistoryParticipation,HistoryFactsRecord} from './history-types';
import {label,humanTime,historyRoleLabel,Context} from './history-fields';

export const HistoryPeople=React.createContext<{subjectId?:string;names:Record<string,string|null>;navigate?:(path:string)=>void}>({names:{}});
function Author({id}:{id?:string}){
 const people=React.useContext(HistoryPeople);
 return id?<span className="history-fact-author">{people.navigate?<MemberLink subjectId={id} name={people.names[id]??undefined} ownId={people.subjectId} navigate={people.navigate} avatar/>:<><MemberAvatar subjectId={id}/><strong>{memberName(id,people.subjectId,people.names[id]??undefined)}</strong></>}</span>:null;
}
export function Item({value,kind,children}:{value:HistoryFactItem;kind:string;children?:React.ReactNode}){
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
export function Participation({items,navigate}:{items:HistoryParticipation[];navigate?:(path:string)=>void}){
 return <>{items.map((item,index)=><article className="history-fact-item" key={item.participationId??item.taskId??index}>
  <Author id={item.subjectId??item.requesterId}/><h4>{item.title??item.request?.title??(item.role?historyRoleLabel(item.role):'共同参与')}</h4>
  {item.agreedScope&&<p>{typeof item.agreedScope==='string'?item.agreedScope:item.agreedScope.summary??item.agreedScope.description}</p>}
  {item.participation&&<Participation items={item.participation} navigate={navigate}/>}
  {item.deliveries?.map((delivery,i)=><div key={delivery.deliveryId??i}><p>{delivery.summary??'这项交付的正文当前不可读取。'}</p>{delivery.acceptance&&<p className="fact-note">请求方已接收这项交付。{humanTime(delivery.acceptance.at)}</p>}</div>)}
  {item.taskId&&navigate&&<Button type="button" variant="link" onClick={()=>navigate('/app/tasks/'+item.taskId)}>打开这项工作</Button>}
 </article>)}</>;
}
export function FactVersions<T extends HistoryFactItem>({items,kind,extra}:{items:T[];kind:string;extra?:(item:T)=>React.ReactNode}){
 return <>{groupHistoryVersions(items).map(({latest,previous},index)=><div className="history-fact-series" key={latest.id??index}>
  <Item value={latest} kind={kind}>{extra?.(latest)}</Item>
  {previous.length>0&&<ReadingDetails className="history-revisions"><ReadingSummary>此前 {previous.length} 次记录</ReadingSummary><ol>{previous.map((item,i)=><li key={item.version??i}><Item value={item} kind={kind}>{extra?.(item)}</Item></li>)}</ol></ReadingDetails>}
 </div>)}</>;
}
export function StructuredDownload({record}:{record:HistoryFactsRecord}){
 return <button className="history-source-download" type="button" onClick={()=>{const blob=new Blob([JSON.stringify(record,null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='galaxy-history-'+String(record.key??'record').replace(/[^a-z0-9-]/gi,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>下载当前可见的完整记录</button>;
}
