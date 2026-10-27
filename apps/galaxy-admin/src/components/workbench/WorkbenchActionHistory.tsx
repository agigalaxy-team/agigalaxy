'use client';

import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {AdminIcon} from '../AdminIcons';
import type {WorkbenchActionCard} from "../../lib/workbench/workbench-action-cards";
import {useWorkbenchInteraction} from './WorkbenchInteraction';

type Props={domain:string;label:string;cards:WorkbenchActionCard[];verified:boolean;loading:boolean;error:string;denied:boolean;now:number;renderCard:(card:WorkbenchActionCard)=>ReactNode;feedback:ReactNode};
const pending=(card:WorkbenchActionCard,now:number)=>card.state==='processing'||card.state==='unknown'||card.state==='prepared'&&card.readExpiresAt>now&&card.capability.canConfirm;
function stateLabel(card:WorkbenchActionCard,now:number){
 if(card.result?.state==='cancelled')return '已取消';
 if(card.result?.state==='failed')return '未完成';
 if(card.state==='completed')return '已完成';
 if(card.state==='processing')return '处理中';
 if(card.state==='unknown')return '结果待核对';
 if(card.state==='prepared'&&card.readExpiresAt>now&&card.capability.canConfirm)return '待确认';
 return '当前不可执行';
}

export function WorkbenchActionHistory(props:Props){return <History key={props.domain} {...props}/>;}
function History({domain,label,cards,verified,loading,error,denied,now,renderCard,feedback}:Props){
 const {setSource,history}=useWorkbenchInteraction();
 const [filter,setFilter]=useState(history.current[domain]?.filter??'all'),[selectedId,setSelectedId]=useState<string|null>(history.current[domain]?.selectedId??null);
 const seen=useRef<Set<string>|null>(null);
 const pendingCount=cards.filter(card=>pending(card,now)).length;
 const ordered=[...cards].reverse().sort((a,b)=>Number(pending(b,now))-Number(pending(a,now)));
 const visible=filter==='pending'?ordered.filter(card=>pending(card,now)):ordered;
 const selected=visible.find(card=>card.cardId===selectedId)??visible[0];
 useEffect(()=>{history.current[domain]={...history.current[domain],filter,selectedId:selected?.cardId??null};},[history,domain,filter,selected?.cardId]);
 const index=useRef<HTMLDivElement>(null),detail=useRef<HTMLDivElement>(null),selection=useRef(selected?.cardId);
 useLayoutEffect(()=>{const saved=history.current[domain];if(index.current)index.current.scrollTop=saved?.listTop??0;if(detail.current)detail.current.scrollTop=saved?.selectedId===selected?.cardId?saved?.detailTop??0:0;},[domain,history]);
 useLayoutEffect(()=>{if(selection.current===selected?.cardId)return;selection.current=selected?.cardId;if(detail.current)detail.current.scrollTop=0;const saved=history.current[domain];if(saved)history.current[domain]={...saved,detailTop:0};},[selected?.cardId,domain,history]);
 const remember=(key:'listTop'|'detailTop',top:number)=>{history.current[domain]={...history.current[domain],filter,selectedId:selected?.cardId??null,[key]:top};};
 useEffect(()=>{
  if(!verified)return;
  const fresh=seen.current&&cards.find(card=>card.state==='prepared'&&card.capability.canConfirm&&!seen.current!.has(card.cardId));
  seen.current=new Set(cards.map(card=>card.cardId));
  if(fresh){setSelectedId(fresh.cardId);setSource('actions');}
 },[cards,verified,setSource]);
 if(!verified)return <div className="wb-actions-empty" role="status"><AdminIcon name={denied?'permissions':'history'} size={25}/><p>{denied?'当前未获准查看该岗位的操作':error|| (loading?'正在读取操作记录…':'操作记录暂未取得')}</p></div>;
 return <div className="wb-action-history">
  <div className="wb-actions-toolbar"><span className="wb-actions-domain"><AdminIcon name="sparkles" size={14}/>{label}</span><div aria-label="AI操作范围">{[['all','全部',cards.length],['pending','待处理',pendingCount]].map(([id,name,count])=><button key={id} type="button" aria-pressed={filter===id} onClick={()=>setFilter(String(id))}>{name}<span>{count}</span></button>)}</div></div>
  {visible.length?<div className="wb-action-workspace"><div ref={index} className="wb-action-index" role="group" aria-label="选择AI操作" onScroll={event=>remember('listTop',event.currentTarget.scrollTop)}>{visible.map(card=><button type="button" key={card.cardId} className={'wb-action-index-row'+(selected?.cardId===card.cardId?' is-selected':'')} aria-pressed={selected?.cardId===card.cardId} onClick={()=>setSelectedId(card.cardId)}><span className="wb-action-index-icon"><AdminIcon name={card.result?.state==='cancelled'?'close':card.state==='completed'?'check':pending(card,now)?'clock':'history'} size={16}/></span><span className="wb-action-index-title"><strong title={card.title}>{card.title}</strong><span title={card.target.label}>{card.target.label}</span></span><span className={'wb-action-index-state'+(pending(card,now)?' is-pending':'')}>{stateLabel(card,now)}</span></button>)}</div><div ref={detail} className="wb-action-detail" role="region" aria-label="所选AI操作详情" tabIndex={0} onScroll={event=>remember('detailTop',event.currentTarget.scrollTop)}>{selected&&renderCard(selected)}{feedback}</div></div>:<div className="wb-actions-empty" role="status"><AdminIcon name={filter==='pending'?'check':'history'} size={26}/><p>{filter==='pending'?'暂无待处理操作':'暂无AI操作记录'}</p></div>}
 </div>;
}
