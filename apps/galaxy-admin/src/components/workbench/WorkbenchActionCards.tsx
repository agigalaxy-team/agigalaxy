'use client';

import Link from 'next/link';
import type {WorkbenchActionCard} from "../../lib/workbench/workbench-action-cards";
import {workbenchCardReason} from "../../lib/workbench/workbench-action-cards";
import {WorkbenchPromptReview} from './WorkbenchPromptReview';

export function WorkbenchActionCards({cards,verified,available=verified,busy,pendingCardId,pendingDismissCardId=null,dismissBusy=false,onConfirm,onDismiss,now,label='相关处理'}:{cards:WorkbenchActionCard[];available?:boolean;verified:boolean;busy:boolean;pendingCardId:string|null;pendingDismissCardId?:string|null;dismissBusy?:boolean;onConfirm:(card:WorkbenchActionCard)=>void;onDismiss?:(card:WorkbenchActionCard)=>void;now:number;label?:string}){
 if(!available||!cards.length)return null;
 return <div className="wb-action-cards" aria-label={label}>{cards.map(card=>{
  const strategyCard=['strategy-draft','strategy-rehearsal','strategy-publish'].includes(card.kind);
  const live=verified&&card.readExpiresAt>now,pending=pendingCardId===card.cardId||card.state==='processing'||card.state==='unknown';
  const dismissible=live&&!!onDismiss&&card.capability.canDismiss&&(!busy||pendingDismissCardId===card.cardId)&&!dismissBusy;
  return <section key={card.cardId} data-workbench-card={card.cardId} className="wb-action-card" aria-label={card.title}>
   <><header><h3>{card.title}</h3>{card.target.href?<Link href={card.target.href} prefetch={false}>{card.target.label}</Link>:<p className="wb-action-target">{card.target.label}</p>}</header>
    <ul className={strategyCard||['messaging-state','search-draft-save','search-apply','search-restore','notice-draft-create','notice-draft-save','notice-state','recommendation-policy-save','recommendation-theme-update'].includes(card.kind)?"wb-action-impact wb-strategy-impact":"wb-action-impact"}>{card.impact.map((line,index)=><li key={index}>{line}</li>)}</ul>
    {strategyCard&&<p><Link href="/admin/operations/strategy" prefetch={false}>在策略管理页查看完整配置</Link></p>}
    {!!card.basis.length&&<dl className="wb-action-basis">{card.basis.map((row,index)=><div key={index}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>}
    {card.review&&<WorkbenchPromptReview review={card.review}/>}
    {card.state==='completed'&&card.result?.state==='completed'&&card.result.receipt&&<p className="wb-prompt-receipt" role="status">原操作已保存岗位工作要求 v{card.result.receipt.promptVersion} · 配置 v{card.result.receipt.revision} · 委派 v{card.result.receipt.delegationVersion}</p>}
    {pending?<p className="wb-action-state" role="status">{card.state==='unknown'?'正在确认结果…':card.result?.summary||'正在处理…'}</p>:card.state==='completed'?<p className="wb-action-state" role="status">{card.result?.summary||'已完成'}</p>:card.state==='not-available'?<p className="wb-action-state" role="status">{['failed','cancelled'].includes(card.result?.state??'')&&card.result?.summary?card.result.summary:card.capability.canDismiss?'方案已失效，未执行': '操作不可用'}</p>:card.capability.canConfirm?<div className="wb-action-buttons"><button type="button" className="wb-action-confirm" disabled={busy||!live} onClick={()=>onConfirm(card)}>按此方案处理</button>{onDismiss&&card.capability.canDismiss&&<button type="button" className="wb-action-dismiss" disabled={!dismissible} onClick={()=>onDismiss(card)}>暂不处理</button>}</div>:<p className="wb-action-state">{workbenchCardReason(card.capability.reason)}</p>}
    {(pending||card.state==='not-available')&&card.capability.canDismiss&&onDismiss&&<div className="wb-action-buttons"><button type="button" className="wb-action-dismiss" disabled={!dismissible} onClick={()=>onDismiss(card)}>暂不处理</button></div>}
   {!live&&<p className="wb-action-state" role="status">正在更新这项操作的当前条件…</p>}</>
  </section>;
 })}</div>;
}
