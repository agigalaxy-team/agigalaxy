'use client';

import Link from 'next/link';
import type {WorkbenchActionCard} from "../../lib/workbench/workbench-action-cards";
import {workbenchCardReason} from "../../lib/workbench/workbench-action-cards";
import {WorkbenchPromptReview} from './WorkbenchPromptReview';

export function WorkbenchActionCards({cards,verified,available=verified,busy,pendingCardId,pendingDismissCardId=null,dismissBusy=false,onConfirm,onDismiss,now,label='相关处理',readOnly=false}:{cards:WorkbenchActionCard[];available?:boolean;verified:boolean;busy:boolean;pendingCardId:string|null;pendingDismissCardId?:string|null;dismissBusy?:boolean;onConfirm:(card:WorkbenchActionCard)=>void;onDismiss?:(card:WorkbenchActionCard)=>void;now:number;label?:string;readOnly?:boolean}){
 if(!available||!cards.length)return null;
 return <div className={'wb-action-cards'+(cards.length===3&&cards.every(card=>card.choice?.count===3&&card.choice.exclusive&&card.choice.groupId===cards[0].choice?.groupId)?' wb-action-cards--choices':'')} aria-label={label}>{cards.map(card=>{
  const live=verified&&(card.stored||card.readExpiresAt>now),pending=pendingCardId===card.cardId||card.state==='processing'||card.state==='unknown';
  const dismissible=live&&!!onDismiss&&card.capability.canDismiss&&(!busy||pendingDismissCardId===card.cardId)&&!dismissBusy;
  const view=card.presentation,notSelected=card.state==='not-selected'||card.result?.state==='not-selected'||card.capability.reason==='not-selected';
  return <section key={card.cardId} data-workbench-card={card.cardId} className="wb-action-card" aria-label={view?.summary||'处理方案'}>
   <><header><h3>{view?.summary||'业务内容暂时无法审阅'}</h3>{card.target.href&&<Link href={card.target.href} prefetch={false}>打开业务页面</Link>}</header>
    {view?.changes.length? <dl className="wb-action-basis">{view.changes.map((row,index)=><div key={index}><dt>{row.label}</dt><dd>{row.before!==null&&<>原：{row.before}<br/></>}{row.after!==null&&<>变更为：{row.after}</>}</dd></div>)}</dl>:null}
    {view?.details.length?<dl className="wb-action-basis">{view.details.map((row,index)=><div key={index}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>:null}
    {!!view?.warnings.length&&<ul className="wb-action-impact">{view.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul>}
    {card.review&&<WorkbenchPromptReview review={card.review}/>}
    {card.state==='completed'&&card.result?.state==='completed'&&card.result.receipt&&<p className="wb-prompt-receipt" role="status">原操作已保存岗位工作要求 v{card.result.receipt.promptVersion} · 配置 v{card.result.receipt.revision} · 委派 v{card.result.receipt.delegationVersion}</p>}
    {!view?.reviewable&&<p className="wb-action-state">完整业务内容暂时无法审阅，请在原业务页面处理。</p>}
    {notSelected?<p className="wb-action-state" role="status">未选用</p>:readOnly?<p className="wb-action-state" role="status">{pending?'正在处理':card.state==='prepared'?'等待在聊天中处理':card.state==='completed'?'已完成':card.result?.state==='cancelled'?'已取消':card.result?.state==='failed'?'未完成':'当前不可执行'}</p>:pending?<p className="wb-action-state" role="status">{card.state==='unknown'?'结果待确认':'正在处理…'}</p>:card.state==='completed'?<p className="wb-action-state" role="status">已完成</p>:card.state==='not-available'?<p className="wb-action-state" role="status">{card.result?.state==='cancelled'?'已取消':card.result?.state==='failed'?'未完成':'方案不可用'}</p>:card.capability.canConfirm?<div className="wb-action-buttons"><button type="button" className="wb-action-confirm" disabled={busy||!live} onClick={()=>onConfirm(card)}>按此方案处理</button>{onDismiss&&card.capability.canDismiss&&<button type="button" className="wb-action-dismiss" disabled={!dismissible} onClick={()=>onDismiss(card)}>暂不处理</button>}</div>:<p className="wb-action-state">{workbenchCardReason(card.capability.reason)}</p>}
    {!notSelected&&card.result?.summary&&['completed','not-available'].includes(card.state)&&<p className="wb-action-state" role="status">{card.result.summary}</p>}
    {!readOnly&&!notSelected&&(pending||card.state==='not-available')&&card.capability.canDismiss&&onDismiss&&<div className="wb-action-buttons"><button type="button" className="wb-action-dismiss" disabled={!dismissible} onClick={()=>onDismiss(card)}>暂不处理</button></div>}
   {!live&&<p className="wb-action-state" role="status">正在更新这项操作的当前条件…</p>}</>
  </section>;
 })}</div>;
}
