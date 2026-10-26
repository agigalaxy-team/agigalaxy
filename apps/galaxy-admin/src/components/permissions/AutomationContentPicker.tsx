'use client';

import {useEffect,useId,useRef,useState} from 'react';
import Link from 'next/link';
import {useOperationsRead} from "../../lib/use-operations-read";
import {automationContentLabel,preparedContentHref} from "../../lib/workbench/authorized-preparation-model";
import type {PublicContentItem,PublicContentPage} from "../content-governance/public-content-types";
import {ReadStatus} from "../OperationControls";
import "../workbench/authorized-preparation.css";

type Selection=Pick<PublicContentItem,'id'|'kind'>;
type Known={target:Selection;label:string;readExpiresAt:number};
type Search={query:string;kind:''|'post'|'reply';after:string;scope:string;batch:number};
type Props={selected:readonly string[];onChange:(ids:string[],picked?:Selection)=>void;canRead:boolean;disabled?:boolean;maxSelected?:number;allowedIds?:readonly string[];label?:string};

export function AutomationContentPicker({selected,onChange,canRead,disabled=false,maxSelected=100,allowedIds,label='查找公开内容'}:Props){
  const [input,setInput]=useState(''),[kind,setKind]=useState<''|'post'|'reply'>(''),[search,setSearch]=useState<Search|null>(null);
  const [walking,setWalking]=useState(false),[paused,setPaused]=useState(false),[stalled,setStalled]=useState(false),[known,setKnown]=useState<Record<string,Known>>({}),[,tick]=useState(0);
  const inputRef=useRef<HTMLInputElement>(null),fieldId=useId(),visited=useRef(new Set<string>());
  const scope=String(canRead)+'|'+(allowedIds?[...allowedIds].sort().join(','):'*'),previousScope=useRef(scope);
  const activeSearch=canRead&&!disabled&&!paused&&search?.scope===scope?search:null;
  const targetId=activeSearch&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(activeSearch.query)?activeSearch.query.toLowerCase():null;
  const path=activeSearch?'/v1/operations/community/content?'+new URLSearchParams({days:'all',limit:'20',...(targetId?{targetId}:{query:activeSearch.query}),...(activeSearch.kind?{kind:activeSearch.kind}:{}),...(activeSearch.after?{after:activeSearch.after}:{})}):null;
  const page=useOperationsRead<PublicContentPage>({path,failureMessage:'公开内容暂时无法查找。',clearOnOffline:true});
  const selectedKey=selected.join(','),now=Math.floor(Date.now()/1000);
  const names=Object.fromEntries(Object.entries(known).filter(([id,value])=>canRead&&value.readExpiresAt>now&&(!allowedIds||allowedIds.includes(id))));
  const visible=activeSearch&&page.verified?(page.value?.items??[]).filter(item=>item.sourceState==='available'&&(!allowedIds||allowedIds.includes(item.id))):[];

  useEffect(()=>{
    if(previousScope.current===scope)return;
    previousScope.current=scope;visited.current.clear();setSearch(null);setWalking(false);setPaused(false);setStalled(false);setKnown({});
  },[scope]);
  useEffect(()=>{
    if(!page.ready)return;
    if(page.error&&!page.verified||!navigator.onLine)setKnown({});
    if(page.error)setWalking(false);
  },[page.ready,page.verified,page.error]);
  useEffect(()=>{
    if(!activeSearch||!walking||!page.verified||!page.value||page.loading||page.refreshing||page.error)return;
    const cursor=activeSearch.after,next=page.value.nextAfter;
    if(visited.current.has(cursor)){setWalking(false);setStalled(true);return;}
    visited.current.add(cursor);
    if(visible.length||!next){setWalking(false);return;}
    if(next===cursor||visited.current.has(next)){setWalking(false);setStalled(true);return;}
    // A bounded server batch may have no eligible match. Continue the same
    // explicit search rather than reporting an unfinished scan as no results.
    setSearch(current=>current===activeSearch?{...current,after:next,batch:current.batch+1}:current);
  },[activeSearch,walking,page.verified,page.value,page.loading,page.refreshing,page.error,visible.length]);
  useEffect(()=>{
    if(!activeSearch||!page.verified||!page.value)return;
    const readExpiresAt=page.value.checkedAt+30,items=page.value.items.filter(item=>selected.includes(item.id)&&item.sourceState==='available'&&(!allowedIds||allowedIds.includes(item.id)));
    if(items.length)setKnown(previous=>({...previous,...Object.fromEntries(items.map(item=>[item.id,{target:{kind:item.kind,id:item.id},label:automationContentLabel(item),readExpiresAt}]))}));
  },[activeSearch,page.verified,page.value,selectedKey,scope]);
  useEffect(()=>{
    const expiry=Math.min(...Object.values(known).map(value=>value.readExpiresAt));if(!Number.isFinite(expiry))return;
    const timer=setTimeout(()=>{const current=Math.floor(Date.now()/1000);setKnown(previous=>Object.fromEntries(Object.entries(previous).filter(([,value])=>value.readExpiresAt>current)));tick(value=>value+1);},Math.max(0,expiry*1000-Date.now())+1);return()=>clearTimeout(timer);
  },[known]);

  function resetSearch(){setSearch(null);setWalking(false);setPaused(false);setStalled(false);visited.current.clear();}
  function find(){
    if(!page.ready||!canRead||disabled||walking)return;
    const query=(inputRef.current?.value??input).trim(),same=activeSearch?.query===query&&activeSearch.kind===kind&&activeSearch.after==='';
    visited.current.clear();setPaused(false);setStalled(false);setWalking(true);
    if(same)void page.read();else setSearch({query,kind,after:'',scope,batch:1});
  }
  function nextBatch(){
    const next=page.value?.nextAfter;if(!activeSearch||!page.verified||!next||disabled)return;
    if(next===activeSearch.after||visited.current.has(next)){setStalled(true);return;}
    setWalking(true);setStalled(false);setSearch({...activeSearch,after:next,batch:activeSearch.batch+1});
  }
  function choose(item:PublicContentItem){
    if(!activeSearch||disabled||!canRead||!page.verified||!page.value||!navigator.onLine||item.sourceState!=='available'||allowedIds&&!allowedIds.includes(item.id)||selected.includes(item.id)||maxSelected!==1&&selected.length>=maxSelected)return;
    const readExpiresAt=page.value.checkedAt+30;
    setKnown(previous=>({...previous,[item.id]:{target:{kind:item.kind,id:item.id},label:automationContentLabel(item),readExpiresAt}}));
    onChange(maxSelected===1?[item.id]:[...selected,item.id],{kind:item.kind,id:item.id});
  }
  return <div className="galaxy-automation-content-picker">
    {!canRead?<p>当前没有公开内容读取权限，不能选择新的对象。</p>:<>
      <div className="galaxy-automation-content-search">
        <label htmlFor={fieldId}>{label}<input ref={inputRef} id={fieldId} type="search" maxLength={160} value={input} disabled={disabled||!page.ready} placeholder="标题、正文、作者或完整内容编号" onChange={event=>{setInput(event.target.value);resetSearch();}} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();find();}}}/></label>
        <label>内容类型<select aria-label="选择公开内容类型" value={kind} disabled={disabled||!page.ready} onChange={event=>{setKind(event.target.value as ''|'post'|'reply');resetSearch();}}><option value="">帖子和回复</option><option value="post">帖子</option><option value="reply">回复</option></select></label>
        <button type="button" disabled={disabled||!page.ready||walking} onClick={find}>查找内容</button>
      </div>
      {targetId&&<p className="wb-preparation-muted">按完整内容编号定位</p>}
      {activeSearch&&<ReadStatus loading={page.loading} error={page.error} retry={page.read}/>}
      {walking&&activeSearch&&<p role="status">正在查找第 {activeSearch.batch} 批内容… <button type="button" onClick={()=>{setPaused(true);setWalking(false);}}>停止查找</button></p>}
      {paused&&search?.scope===scope&&<p>查找已暂停，尚未查完。<button type="button" disabled={disabled||!page.ready} onClick={()=>{setPaused(false);setWalking(true);}}>继续查找</button></p>}
      {activeSearch&&page.verified&&<>
        <ul className="galaxy-automation-content-results">{visible.map(item=><li key={item.kind+':'+item.id}><div><strong>{automationContentLabel(item)}</strong><span>{item.kind==='post'?'帖子':'回复'} · {item.visibility.hidden?'当前已下架':'当前可见'}</span></div><button type="button" disabled={disabled||selected.includes(item.id)||maxSelected!==1&&selected.length>=maxSelected} onClick={()=>choose(item)}>{selected.includes(item.id)?'已选择':'选择'}</button></li>)}</ul>
        {!visible.length&&!walking&&!page.error&&!page.value?.nextAfter&&!page.value?.scanTruncated&&<p>已查完，没有更多符合条件的公开内容。</p>}
        {!walking&&(stalled||page.value?.scanTruncated)&&<p>查找尚未完成。{stalled?'本次读取未能继续，可重新查找或缩小条件。':'可继续查找或缩小条件。'}</p>}
        {page.value?.nextAfter&&!walking&&!stalled&&<button type="button" disabled={disabled||page.loading||page.refreshing} onClick={nextBatch}>下一批内容</button>}
      </>}
    </>}
    {!!selected.length&&<div className="galaxy-automation-content-selected"><strong>已选 {selected.length} 项</strong><ul>{selected.map((id,index)=><li key={id}>{names[id]?<Link href={preparedContentHref(names[id].target)} prefetch={false}>{names[id].label}</Link>:<span>已选公开内容 {index+1}（名称待核对）</span>}<button type="button" disabled={disabled} onClick={()=>onChange(selected.filter(value=>value!==id))}>移除</button></li>)}</ul></div>}
  </div>;
}
