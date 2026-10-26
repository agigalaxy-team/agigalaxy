import {ReadingDetails,ReadingSummary} from "../../shared/reading/reading-details";
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FileText, MessageCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MemberAvatar, memberName, readableTime } from "../../shared/people/conversation-ui";
import {createGovernanceDraftState} from './governance-draft-state';
import type {GovernanceDraftRuntime} from './governance-draft-state';
import './governance-workspace.css';

export const governanceLabels: Record<string,string> = {
  received:'等待处理', reviewing:'处理中', resolved:'已处理', appealed:'申诉中', withdrawn:'已撤回',
  report:'举报说明', review:'开始处理', pause:'暂停相关操作', resume:'恢复相关操作',
  resolve:'作出处理决定', supplement:'补充说明', appeal:'提出申诉', 'withdraw-report':'撤回举报',
  'invite-verifier':'邀请复核', 'accept-verifier':'接受邀请', 'decline-verifier':'谢绝邀请',
  'withdraw-verifier':'退出复核', 'verification-response':'提交复核意见', correct:'更正我的说明',
  invited:'等待你的回应', accepted:'已接受复核邀请', declined:'已谢绝邀请', 'stopped-local':'已停止发送',
  supported:'所述范围得到支持', unsupported:'所述范围不支持', inconclusive:'材料不足，暂不能判断',
  dismissed:'举报不成立', upheld:'举报成立',
  'discovery-hidden':'停止对外展示', 'new-participation-paused':'暂停新参与',
  'sending-paused':'暂停发送与编辑', 'invitations-paused':'暂停邀请',
};
export const categoryLabels: Record<string,string> = {
  other:'其他问题', advertising:'无关广告', harassment:'骚扰', privacy:'泄露隐私', misrepresentation:'冒用或虚假陈述',
};
export function governanceError(e:unknown) {
  const message=e instanceof Error?e.message:typeof e==='object'&&e!==null&&'message' in e&&typeof e.message==='string'?e.message:'';
  const key=typeof e==='object'&&e!==null&&'code' in e&&typeof e.code==='string'?e.code:message;
  const known:Record<string,string>={
    not_found:'这份内容现在无法读取，可能已撤回或不再向你开放。',
    verifier_source_unavailable:'原材料现在无法读取，暂时不能提交复核意见。',
    moderation_role_denied:'你目前不能执行这项操作。',
    moderation_conflict:'处理记录已变化，请根据当前内容重新预览。',
    moderation_transition_denied:'当前处理阶段已变化，请重新选择。',
    target_governance_conflict:'处理记录已变化，请根据当前内容重新预览。',
    target_governance_version_changed:'处理记录已变化，请根据当前内容重新预览。',
    target_version_changed:'原内容已变化，请重新查看后预览。',
    target_version_or_source_unavailable:'原内容已变化或无法读取，暂时不能作出这项处理。',
    target_report_material_unavailable:'举报说明当前无法读取，暂时不能继续处理。',
    target_report_limit:'这条内容已有尚未结束的举报，可以在原记录补充说明。',
    target_governance_state:'当前处理阶段不适用这项操作。',
    consent_reauthorization_required:'连接已变化，请确认原来的内容与接收人后继续。',
  };
  return known[key]??(/[\u3400-\u9fff]/.test(message)?message:'暂时无法完成，已输入的内容仍保留。');
}
export const fullTime=(value:string|number|null|undefined)=>value?new Date(typeof value==='number'&&value<1e12?value*1000:value).toLocaleString('zh-CN'):'';
type SourceView={kind:string;title:string;summary?:string;path?:string}|null;
type Statement={eventId?:string;id?:string;authorId?:string;actorId?:string;kind:string;at?:string|number;createdAt?:string|number;summary?:string;scope?:string;conclusion?:string;verdict?:string;rule?:string};
type StatementPayload={kind?:string;summary?:string;scope?:string;category?:string;conclusion?:string;reason?:string;verdict?:string;rule?:string;until?:number;scopes?:string[];restriction?:{until?:number;scopes:string[]}|null;expiresAt?:number;reportId?:string;id?:string;expectedVersion?:number};
type StatementPreview={payload:StatementPayload;recovery?:boolean;title?:string;viewers?:string[];expiresAt?:number;endpoint?:string}|null;
export function GovernancePeople({ids,subjectId,names}:{ids:string[];subjectId?:string;names:Record<string,string|null>}) {
  return <div className="governance-people">{[...new Set(ids)].map(id=><span key={id} className="governance-person"><MemberAvatar subjectId={id} own={id===subjectId}/><span>{memberName(id,subjectId,names[id]??undefined)}</span></span>)}</div>;
}
export function GovernanceSource({source,navigate}:{source:SourceView;navigate:(path:string)=>void}) {
  if(!source)return <p className="muted">原内容当前无法读取。</p>;
  const Icon=source.kind==='room'?MessageCircle:FileText;
  return <div className="governance-source"><Icon size={22} aria-hidden="true"/><div><p className="eyebrow">{source.kind==='room'?'相关对话':source.kind==='task'?'相关求助':'相关工作'}</p><h2>{source.title}</h2>{source.summary&&<p className="reading-prose">{source.summary}</p>}{source.path&&<a href={source.path} className="text-link" onClick={e=>{e.preventDefault();if(source.path)navigate(source.path);}}>打开原内容 </a>}</div></div>;
}
export function GovernanceEvents({events,subjectId,names}:{events:Statement[];subjectId?:string;names:Record<string,string|null>}) {
  const list=(shown:Statement[])=><ol>{shown.map((event,index)=><li key={event.eventId??event.id??index}>
      <MemberAvatar subjectId={event.authorId??event.actorId}/><article><div className="governance-event-heading"><strong>{memberName(event.authorId??event.actorId,subjectId,names[event.authorId??event.actorId??'']??undefined)}</strong><span>{governanceLabels[event.kind]??'说明'}</span><time>{readableTime(event.at??event.createdAt)}</time></div>
      {event.summary&&event.summary!==event.scope&&<p className="reading-prose">{event.summary}</p>}{event.scope&&<p>复核范围：{event.scope}</p>}{event.conclusion&&<p><strong>{governanceLabels[event.conclusion]??event.conclusion}</strong></p>}{event.verdict&&<p><strong>{governanceLabels[event.verdict]??event.verdict}</strong></p>}{event.rule&&<p className="muted">依据：{event.rule}</p>}
    </article></li>)}</ol>;
  return <section className="governance-history" aria-label="处理说明">
    <h2>处理说明</h2>{!events.length?<p className="muted">暂时没有向你开放的说明。</p>:list(events.slice(-2))}
    {events.length>2&&<ReadingDetails><ReadingSummary>此前的处理说明</ReadingSummary><div className="governance-history">{list(events.slice(0,-2))}</div></ReadingDetails>}
  </section>;
}
export function GovernancePreview({value,names,subjectId,busy,error,onConfirm,onClose}:{value:StatementPreview;names:Record<string,string|null>;subjectId?:string;busy:boolean;error?:string;onConfirm:()=>void;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(value)dialog.current?.showModal();else dialog.current?.close();},[value]);
  if(!value)return null;
  const payload=value.payload,kind=payload.kind??'report',until=payload.until??payload.restriction?.until;
  return <dialog ref={dialog} className="governance-dialog" aria-labelledby="governance-preview-title" onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
    <button className="dialog-close" aria-label="关闭预览" disabled={busy} onClick={onClose}><X size={20}/></button>
    <p className="eyebrow">{value.recovery?'继续上次的内容':'发送前确认'}</p><h2 id="governance-preview-title">{governanceLabels[kind]??'提交说明'}</h2>
    {value.title&&<p className="muted">{value.title}</p>}
    {error&&<p role="alert" className="message error">{error}</p>}
    {payload.summary!==payload.scope&&<p className="reading-prose governance-preview-copy">{payload.summary}</p>}
    {payload.category&&<p className="muted">问题类型：{categoryLabels[payload.category]??payload.category}</p>}
    {payload.scope&&<p><strong>复核范围</strong><br/>{payload.scope}</p>}{payload.conclusion&&<p><strong>复核意见</strong><br/>{governanceLabels[payload.conclusion]}</p>}
    {payload.reason&&<p><strong>更正原因</strong><br/>{payload.reason}</p>}{payload.verdict&&<p><strong>处理决定</strong><br/>{governanceLabels[payload.verdict]}</p>}{payload.rule&&<p>依据：{payload.rule}</p>}
    {!!(payload.scopes??payload.restriction?.scopes)?.length&&<p>影响：{(payload.scopes??payload.restriction?.scopes??[]).map(s=>governanceLabels[s]??s).join('、')}{until&&'，至 '+fullTime(until)}</p>}
    {payload.expiresAt&&kind==='invite-verifier'&&<p>邀请有效至 {fullTime(payload.expiresAt)}</p>}
    <section className="governance-recipients"><h3>{value.viewers?.length?'这份说明发送给':'这份说明仅本人可见'}</h3><GovernancePeople ids={value.viewers??[]} subjectId={subjectId} names={names}/>{!value.recovery&&value.expiresAt&&payload.kind!=='invite-verifier'&&<p className="muted">接收人可读至 {fullTime(value.expiresAt)}</p>}</section>
    {value.recovery&&<p className="muted">原内容和接收人保持不变。{value.expiresAt?'本次许可至 '+fullTime(value.expiresAt)+'。':''}</p>}
    <ReadingDetails className="governance-technical"><ReadingSummary>记录详情</ReadingSummary><dl><dt>服务</dt><dd>{value.endpoint}</dd><dt>原记录</dt><dd>{payload.reportId??payload.id}</dd>{payload.expectedVersion&&<><dt>基于版本</dt><dd>{payload.expectedVersion}</dd></>}</dl><button className="text-link" onClick={()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='galaxy-statement.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>保存完整记录文件</button></ReadingDetails>
    <div className="button-row"><Button disabled={busy} onClick={onConfirm}>{busy?'请稍候…':value.recovery?'确认并继续':'确认发送'}</Button><Button variant="outline" disabled={busy} onClick={onClose}>返回修改</Button></div>
  </dialog>;
}

/** Only the author's input and body-free operation locator live in this store. */
export function useGovernanceDraft<T extends object,A extends object=Record<string,unknown>>(runtime:GovernanceDraftRuntime,subjectId:string|undefined,connected:boolean,key:string,initial:T) {
  const [owner,setOwner]=useState(()=>({runtime,subjectId,connected,key,store:createGovernanceDraftState<T,A>(runtime,subjectId,connected,key,initial,governanceError)}));
  if(owner.runtime!==runtime||owner.subjectId!==subjectId||owner.connected!==connected||owner.key!==key)
    setOwner({runtime,subjectId,connected,key,store:createGovernanceDraftState<T,A>(runtime,subjectId,connected,key,initial,governanceError)});
  const store=owner.store;
  const view=useSyncExternalStore(store.subscribe,store.read,store.read);
  useEffect(()=>{void store.start();return store.close;},[store]);
  return {...view,change:store.change,snapshot:store.snapshot,attach:store.attach,settle:store.settle};
}
