'use client';

import {useEffect,useLayoutEffect,useRef,useState,useTransition} from 'react';
import {useAuth} from '@payloadcms/ui';
import {operatorBusinessAuthorization} from "../../lib/access";
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useOperationsRead} from "../../lib/use-operations-read";
import type {AuditFilters,AuditMetadata} from "../../lib/audit-view-model";
import {auditActionLabel,auditActorLabel,auditActorRole,auditAvailableActions,auditDecision,auditExecution,auditFilterHref,auditHref,auditInitiator,auditIsReception,auditKind,auditMetadata,auditNextHref,auditObjects,auditObjectRecordsHref,auditOutcome,auditPageHref,auditPreviousHref,auditReadPath,auditRelations,auditShortId,auditTime} from "../../lib/audit-view-model";
import type {AuditEvent,AuditPage} from "../business-types";
import {ReadStatus} from "../OperationControls";
import {AdminIcon} from "../AdminIcons";
import {AdminTabs} from "../AdminTabs";
import {Pagination} from "../Pagination";
import './audit.css';

const kindItems=[{id:'all',label:'全部记录'},{id:'business',label:'业务操作'},{id:'reads',label:'查询记录'}];
type FilterDraft={query:string;action:string;day:string};
const filterDraft=(filters:AuditFilters):FilterDraft=>({query:filters.query,action:filters.action,day:filters.day});
const filterKey=(draft:FilterDraft)=>JSON.stringify([draft.query,draft.action,draft.day]);
const readEnd=(value:AuditPage)=>typeof value.readExpiresAt==='number'?value.readExpiresAt*1000:value.checkedAt*1000+30000;

type AuditPositionOwner={operatorId:string;loginGeneration:string;authorizationVersion:string};
type AuditPositions={owner:AuditPositionOwner;source:string;rows:string;list:number;details:Map<string,number>};
// Reading positions belong to one document, login and committed audit source.
// Retain only offsets and immutable row locators, never an audit response.
const documentPositions=new WeakMap<Document,AuditPositions>();
function currentPositionOwner(user:unknown,owner:AuditPositionOwner):AuditPositionOwner|null{
  if(!owner.loginGeneration||!owner.authorizationVersion||!user||typeof user!=='object')return null;
  const row=user as Record<string,unknown>;
  const authenticated=row._strategy==='galaxy-operations-session'||row._strategy===undefined&&row.verifiedOperator===true;
  if(!authenticated||row.collection!=='operators'||row.externalId!==owner.operatorId)return null;
  const authority=operatorBusinessAuthorization(user);
  if(authority&&(authority.version!==owner.authorizationVersion||!authority.permissions.includes('audit.read')))return null;
  return owner;
}
function samePositionOwner(left:AuditPositionOwner,right:AuditPositionOwner){
  return left.operatorId===right.operatorId&&left.loginGeneration===right.loginGeneration&&left.authorizationVersion===right.authorizationVersion;
}


function Metadata({items,empty}:{items:AuditMetadata[];empty:string}){
  return items.length?<dl className="galaxy-audit-metadata-list">{items.map(item=><div key={item.key}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>:<p className="galaxy-audit-muted">{empty}</p>;
}
function Outcome({item}:{item:AuditEvent}){
  const outcome=auditOutcome(item);
  return <span className="galaxy-audit-outcome" data-tone={outcome.tone}>{outcome.label}</span>;
}
function OperatorIdentity({item}:{item:AuditEvent;compact?:boolean}){
  return <strong className="galaxy-audit-operator-name" title={item.operatorId||undefined}>{auditActorLabel(item)}</strong>;
}
function RecordDetails({item,items,filters,onPick}:{item:AuditEvent;items:AuditEvent[];filters:AuditFilters;onPick:(id:string,origin?:HTMLButtonElement)=>void}){
  const objects=auditObjects(item),relations=auditRelations(item,items),selection=auditMetadata(item.selection,item.action),result=auditMetadata(item.result,item.action),reception=auditIsReception(item);
  return <>
    <header className="galaxy-audit-detail-heading"><div><p>{reception?'受理时记录':'记录详情'}</p><h2 id="audit-record-title" tabIndex={-1}>{auditActionLabel(item.action)}</h2></div><Outcome item={item}/></header>
    <div className="galaxy-audit-record-caption"><time dateTime={item.createdAt}>{auditTime(item.createdAt,true)}</time><code title={item.id}>{item.id}</code></div>
    <dl className="galaxy-audit-facts">
      <div><dt>执行账户</dt><dd className="galaxy-audit-operator-identity"><OperatorIdentity item={item}/></dd></div>
      <div><dt>账户类型</dt><dd>{auditActorRole(item)}</dd></div>
      <div><dt>发起来源</dt><dd>{auditInitiator(item)}</dd></div>
      <div><dt>决定来源</dt><dd>{auditDecision(item)}</dd></div>
      {item.actorKind==='business-operator'&&item.attribution?.aiAccountName&&<div><dt>协助岗位</dt><dd>{item.attribution.aiAccountName}</dd></div>}
      <div><dt>执行通道</dt><dd>{auditExecution(item)}</dd></div>
      <div><dt>动作</dt><dd><code>{item.action}</code></dd></div>
    </dl>
    <section className="galaxy-audit-detail-section"><h3>关联对象</h3>{objects.length?<ul className="galaxy-audit-object-list">{objects.map(object=><li key={object.id}><div><strong>{object.label}</strong><code>{object.id}</code></div><div>{object.href&&<Link href={object.href}>{object.kind==='registered-user'?'查看处理记录':object.kind==='system-settings-operation'?'查看处理结果':object.kind==='system-settings'?'查看当前设置':'查看对象'}</Link>}<Link href={auditObjectRecordsHref(filters,object)}>该对象记录</Link></div></li>)}</ul>:<p className="galaxy-audit-muted">未记录具体业务对象。</p>}</section>
    <section className="galaxy-audit-detail-section"><h3>操作范围</h3><Metadata items={selection} empty="未记录可显示的范围元数据。"/></section>
    <section className="galaxy-audit-detail-section"><h3>{reception?'受理时结果':'处理结果'}</h3>{reception&&(objects.some(object=>object.kind==='registered-user')?<p className="galaxy-audit-muted">当前办理结果请查看该用户的处理记录。</p>:objects.some(object=>object.kind==='system-settings-operation')?<p className="galaxy-audit-muted">本次处理的当前结果可从关联设置查看。</p>:null)}<Metadata items={result} empty="未记录可显示的结果元数据。"/></section>
    <section className="galaxy-audit-detail-section"><h3>操作与请求</h3><dl className="galaxy-audit-facts">
      <div><dt>操作编号</dt><dd><code>{item.operationId||'未记录'}</code></dd></div>
      {item.attribution?.cardId&&<div><dt>确认操作卡</dt><dd><code>{item.attribution.cardId}</code></dd></div>}
      {item.attribution?.grantId&&<div><dt>自动执行授权</dt><dd><Link href={'/admin/operations/permissions?tab=automatic&id='+encodeURIComponent(item.attribution.grantId)}>查看原授权</Link>{item.attribution.grantVersion?' · v'+item.attribution.grantVersion:''}</dd></div>}
      {item.attribution?.strategyId&&<div><dt>策略依据</dt><dd><code>{item.attribution.strategyId}</code>{item.attribution.strategyVersionId&&<><br/><code>{item.attribution.strategyVersionId}</code></>}</dd></div>}
      <div><dt>请求编号</dt><dd><code>{item.httpRequestId||'未记录'}</code></dd></div>
      <div><dt>记录序号</dt><dd><code>{item.sequence}</code></dd></div>
    </dl></section>
    <section className="galaxy-audit-detail-section"><div className="galaxy-audit-section-heading"><h3>本页关联记录</h3><span>{relations.length} 条</span></div>{relations.length?<ol className="galaxy-audit-related">{relations.map(relation=><li key={relation.item.id}><button type="button" onClick={event=>onPick(relation.item.id,event.currentTarget)}><strong>{auditActionLabel(relation.item.action)}</strong><span>{relation.basis.join(' · ')}</span><time dateTime={relation.item.createdAt}>{auditTime(relation.item.createdAt,true)}</time></button></li>)}</ol>:<p className="galaxy-audit-muted">当前页没有同一操作、请求或对象的其他记录。</p>}</section>
  </>;
}

export function Audit({filters,positionOwner}:{filters:AuditFilters;positionOwner:AuditPositionOwner}){
  const {user}=useAuth(),owner=currentPositionOwner(user,positionOwner);
  const router=useRouter(),[navigating,startNavigation]=useTransition();
  const path=auditReadPath(filters);
  const page=useOperationsRead<AuditPage>({path,failureMessage:'审计记录暂时无法取得。',clearOnOffline:true});
  const [bridge,setBridge]=useState<{path:string;value:AuditPage}|null>(null);
  // Canonicalising the newly issued snapshot changes the URL, not the material.
  // Keep that same already-verified response only until its original read lease.
  const carried=bridge?.path===path&&page.ready&&!page.error&&typeof navigator!=='undefined'&&navigator.onLine&&readEnd(bridge.value)>Date.now()?bridge.value:null;
  const value=page.value??carried,pagination=value?.pagination,search=value?.search;
  const sourceKey=auditReadPath({...filters,snapshot:pagination?.snapshot??filters.snapshot}),positionKey=sourceKey;
  const [picked,setPicked]=useState<{source:string;id:string}|null>(null),[selections,setSelections]=useState<Record<string,string>>({}),[knownActions,setKnownActions]=useState<string[]>([]);
  const [draft,setDraft]=useState<FilterDraft>(()=>filterDraft(filters));
  const submitted=useRef<{key:string;draft:FilterDraft}|null>(null);
  const navigationSource=useRef<string|null>(null);
  const routeScopeKey=auditHref(filters,{snapshot:''});
  const listRef=useRef<HTMLDivElement>(null),detailRef=useRef<HTMLElement>(null);
  const recordFocus=useRef<{owner:AuditPositionOwner;source:string;id:string;origin:HTMLButtonElement}|null>(null);
  const activePositions=useRef<AuditPositions|null>(null),restoredList=useRef<AuditPositions|null>(null),restoredDetail=useRef<{positions:AuditPositions;id:string}|null>(null);
  const items=value?.items??[];
  const visible=items;
  const selectedId=picked?.source===sourceKey?picked.id:filters.selected||selections[sourceKey]||visible[0]?.id||'';
  const selected=items.find(item=>item.id===selectedId)??null;
  const actions=auditAvailableActions(value?.actions??knownActions);
  const previous=auditPreviousHref(filters);
  const filtered=!!(filters.query||filters.kind!=='all'||filters.action||filters.day);
  const checkedAt=value?.checkedAt;
  const checked=typeof checkedAt==='number'&&Number.isFinite(checkedAt)?new Date(checkedAt*1000).toISOString():null;
  const ready=search?.state==='ready'&&typeof pagination?.total==='number'&&typeof pagination.totalPages==='number';
  const outOfRange=ready&&pagination.total!>0&&pagination.page>pagination.totalPages!;
  const scanning=search?.state==='scanning',narrowRequired=search?.state==='narrow-required';
  const routeFilterKey=filterKey(filterDraft(filters));

  useEffect(()=>{setPicked(null);},[filters.selected,sourceKey]);
  useEffect(()=>{if(value?.actions)setKnownActions(auditAvailableActions(value.actions));},[value?.actions]);
  useEffect(()=>{if(selected)setSelections(previous=>previous[sourceKey]===selected.id?previous:{...previous,[sourceKey]:selected.id});},[selected?.id,sourceKey]);
  useLayoutEffect(()=>{
    let positions=documentPositions.get(document);
    if(!owner||page.error&&!value){
      documentPositions.delete(document);activePositions.current=null;restoredList.current=null;restoredDetail.current=null;return;
    }
    if(positions&&!samePositionOwner(positions.owner,owner)){
      documentPositions.delete(document);positions=undefined;
    }
    activePositions.current=null;
    // A temporarily unresolved snapshot is not a different committed source.
    // Compare its source only after the current read has been freshly verified.
    if(!page.verified||!value)return;
    if(positions&&positions.source!==positionKey){documentPositions.delete(document);positions=undefined;}
    const rows=JSON.stringify(items.map(item=>[item.id,String(item.sequence)]));
    if(!positions||positions.rows!==rows){
      positions={owner:{...owner},source:positionKey,rows,list:0,details:new Map()};
      documentPositions.set(document,positions);
    }
    activePositions.current=positions;
    if(listRef.current&&restoredList.current!==positions){listRef.current.scrollTop=positions.list;restoredList.current=positions;}
    if(selected&&detailRef.current&&(restoredDetail.current?.positions!==positions||restoredDetail.current.id!==selected.id)){
      detailRef.current.scrollTop=positions.details.get(selected.id)??0;restoredDetail.current={positions,id:selected.id};
    }
  },[owner?.operatorId,owner?.loginGeneration,owner?.authorizationVersion,positionKey,value,page.verified,page.error,selected?.id]);
  useLayoutEffect(()=>{
    const list=listRef.current,detail=detailRef.current;
    return()=>{
      const positions=activePositions.current;
      if(!positions||documentPositions.get(document)!==positions)return;
      if(list)positions.list=list.scrollTop;
      const record=restoredDetail.current;
      if(detail&&record?.positions===positions)positions.details.set(record.id,detail.scrollTop);
    };
  },[]);
  useLayoutEffect(()=>{
    const pending=recordFocus.current;if(!pending)return;
    if(!owner||page.error||!samePositionOwner(pending.owner,owner)||pending.source!==sourceKey){recordFocus.current=null;return;}
    // The leased canonical bridge can display a selected row before its new
    // read path has returned. Preserve that same intent until the fresh read.
    if(!page.verified){
      const doc=pending.origin.ownerDocument;
      const onFocus=(event:FocusEvent)=>{if(event.target!==pending.origin&&event.target!==doc.body)recordFocus.current=null;};
      const onPointer=(event:PointerEvent)=>{if(event.target instanceof Node&&!pending.origin.contains(event.target))recordFocus.current=null;};
      doc.addEventListener('focusin',onFocus,true);doc.addEventListener('pointerdown',onPointer,true);
      return()=>{doc.removeEventListener('focusin',onFocus,true);doc.removeEventListener('pointerdown',onPointer,true);};
    }
    recordFocus.current=null;
    if(pending.id!==selected?.id||pending.origin.isConnected)return;
    if(document.activeElement!==document.body&&document.activeElement!==pending.origin)return;
    detailRef.current?.querySelector<HTMLElement>('#audit-record-title')?.focus({preventScroll:true});
  },[owner?.operatorId,owner?.loginGeneration,owner?.authorizationVersion,sourceKey,selected?.id,page.verified,page.error]);
  useEffect(()=>{
    const pending=submitted.current;
    if(pending&&pending.key!==routeFilterKey)return;
    setDraft(current=>pending&&filterKey(current)!==filterKey(pending.draft)?current:filterDraft(filters));
    submitted.current=null;
  },[routeFilterKey]);
  useEffect(()=>{
    if(navigationSource.current!==routeScopeKey)navigationSource.current=null;
  },[routeScopeKey]);
  useEffect(()=>{
    // A user query may already be navigating while these server props still
    // describe the previous scope. Never canonicalise over that newer intent.
    if(submitted.current||navigationSource.current===routeScopeKey||!page.value?.pagination||filters.snapshot||filters.after)return;
    const next={...filters,snapshot:page.value.pagination.snapshot};
    setBridge({path:auditReadPath(next),value:page.value});
    startNavigation(()=>router.replace(auditHref(next),{scroll:false}));
  },[page.value,filters.snapshot,path,routeScopeKey]);
  useEffect(()=>{
    if(!bridge)return;
    const timer=setTimeout(()=>setBridge(current=>current===bridge?null:current),Math.max(0,readEnd(bridge.value)-Date.now()));
    return()=>clearTimeout(timer);
  },[bridge]);
  useEffect(()=>{if(page.error||page.value&&filters.snapshot)setBridge(null);},[page.error,page.value,filters.snapshot]);
  useEffect(()=>{
    if(!scanning||page.loading||page.refreshing||page.error||!pagination||filters.snapshot!==pagination.snapshot)return;
    const timer=setTimeout(()=>{if(navigator.onLine&&document.visibilityState==='visible')void page.read();},400);
    return()=>clearTimeout(timer);
  },[scanning,page.loading,page.refreshing,page.error,value,path,page.read]);

  function navigateTo(href:string,replace=false){
    // Snapshot responses belong to the committed scope. A newer user intent
    // owns navigation until that scope changes; its old response may not replace it.
    if(href!==auditHref(filters))navigationSource.current=routeScopeKey;
    startNavigation(()=>replace?router.replace(href,{scroll:false}):router.push(href,{scroll:false}));
  }
  function pick(id:string,origin?:HTMLButtonElement){
    recordFocus.current=owner&&origin&&document.activeElement===origin?{owner:{...owner},source:sourceKey,id,origin}:null;
    setPicked({source:sourceKey,id});
    navigateTo(auditHref(filters,{selected:id,snapshot:pagination?.snapshot??filters.snapshot}),true);
  }
  function navigate(updates:Partial<AuditFilters>){navigateTo(auditFilterHref(filters,updates));}
  function refresh(){
    navigationSource.current=null;
    setBridge(null);
    if(filters.snapshot||filters.after)startNavigation(()=>router.replace(auditHref(filters,{snapshot:'',after:'',trail:''}),{scroll:false}));
    else void page.read();
  }
  function apply(form:HTMLFormElement){
    const data=new FormData(form);
    const next={query:String(data.get('q')??'').trim(),action:String(data.get('action')??''),day:String(data.get('day')??'')};
    submitted.current=filterKey(next)===routeFilterKey?null:{key:filterKey(next),draft:{...draft}};
    navigate(next);
  }
  function pageLink(target:number){return auditPageHref(filters,target,pagination?.snapshot??filters.snapshot);}
  const busy=page.loading||navigating;
  const interactionDisabled=!page.ready;
  // Page changes share one audit snapshot; filters, source and login changes do not.
  const paginationFocusScope=owner&&!page.error?JSON.stringify([owner.operatorId,owner.loginGeneration,owner.authorizationVersion,auditReadPath({...filters,page:1,after:'',trail:'',snapshot:pagination?.snapshot??filters.snapshot})]):null;
  const number=(count:number)=>count.toLocaleString('zh-CN');

  return <section className="galaxy-audit" aria-labelledby="audit-title">
    <header className="galaxy-audit-header"><div><h1 id="audit-title">业务审计</h1><p>查阅业务操作、查询记录及其已记录结果</p></div><button type="button" className="galaxy-audit-refresh" onClick={refresh} disabled={busy||interactionDisabled}><AdminIcon name="refresh" size={15}/>刷新记录</button></header>
    {(filters.account||filters.resource)&&<div className="galaxy-audit-scope">{filters.account&&<span>当前账户 <Link href={'/admin/operations/users?account='+encodeURIComponent(filters.account)}><code>{auditShortId(filters.account)}</code></Link></span>}{filters.resource&&<span>当前对象 <code title={filters.resource}>{auditShortId(filters.resource)}</code></span>}<Link href={auditFilterHref(filters,{account:'',resource:''})}>全部对象记录</Link></div>}
    <div className="galaxy-audit-layout">
      <section className="galaxy-audit-directory" aria-label="审计记录列表" aria-busy={page.loading||navigating}>
        <AdminTabs items={kindItems.map(item=>({...item,disabled:interactionDisabled}))} active={filters.kind} onChange={kind=>navigate({kind:kind as AuditFilters['kind']})} ariaLabel="审计记录类型" className="galaxy-audit-kind-tabs"/>
        <form className="galaxy-audit-filters" onSubmit={event=>{event.preventDefault();apply(event.currentTarget);}}>
          <fieldset disabled={interactionDisabled}><label className="galaxy-audit-search">检索元数据<div><AdminIcon name="search" size={15}/><input type="search" name="q" value={draft.query} onChange={event=>setDraft(current=>({...current,query:event.target.value}))} maxLength={160} placeholder="编号、操作者、动作代码或状态代码"/></div></label>
            <label>记录日期（上海）<input type="date" name="day" value={draft.day} onChange={event=>setDraft(current=>({...current,day:event.target.value}))}/></label>
            <label>动作<select name="action" value={draft.action} onChange={event=>setDraft(current=>({...current,action:event.target.value}))}><option value="">全部动作</option>{draft.action&&!actions.includes(draft.action)&&<option value={draft.action}>当前动作条件</option>}{actions.map(action=><option key={action} value={action}>{auditActionLabel(action)}</option>)}</select></label>
            <button type="submit" disabled={navigating}>检索记录</button>
          </fieldset>
        </form>
        <div className="galaxy-audit-list-summary"><span>{ready?'共 '+number(pagination.total!)+' 条'+(items.length?' · 本页 '+number(items.length)+' 条':''):scanning?'正在检索记录':narrowRequired?'请缩小检索范围':value?'本页 '+items.length+' 条':page.error?'记录暂不可读取':page.loading||page.refreshing?'正在取得记录':'记录尚未取得'}</span>{checked&&<span>读取于 {auditTime(checked)}</span>}{filtered&&<button type="button" disabled={interactionDisabled} onClick={()=>{submitted.current=null;setDraft({query:'',action:'',day:''});navigate({query:'',kind:'all',action:'',day:''});}}>清除筛选</button>}</div>
        {(scanning||narrowRequired)&&<p className="galaxy-audit-scan-note" role="status">{scanning?'正在检索符合条件的记录，已检查 '+number(search!.inspected)+' / '+number(search!.candidates)+' 条。':'记录范围较大，请选择日期、动作或更具体的检索条件。'}</p>}
        {value?.scanLimited&&!search&&<p className="galaxy-audit-scan-note" role="status">仍有较早记录未检索，可继续检索。</p>}
        <div className="galaxy-audit-read-status"><ReadStatus loading={page.loading&&!value} error={page.error} retry={async()=>{if(value)return page.read();refresh();}}/></div>
        <div className="galaxy-audit-list-columns" aria-hidden="true"><span>记录时间</span><span>动作与对象</span><span>操作者</span><span>结果</span></div>
        <div className="galaxy-audit-list-scroll" ref={listRef} tabIndex={0} aria-label="可滚动的审计记录" onScroll={event=>{const positions=activePositions.current;if(page.verified&&positions?.source===positionKey)positions.list=event.currentTarget.scrollTop;}}>
          {value&&visible.length?<ol className="galaxy-audit-records">{visible.map(item=>{const objects=auditObjects(item),subject=objects.find(object=>object.kind!=='account')??objects[0];return <li key={item.id}><button type="button" className="galaxy-audit-record" aria-pressed={selectedId===item.id} aria-controls="audit-record-details" onClick={()=>pick(item.id)}>
            <time dateTime={item.createdAt}>{auditTime(item.createdAt)}</time>
            <span className="galaxy-audit-record-main"><strong>{auditActionLabel(item.action)}</strong><span>{subject?<>{subject.label} · <code title={subject.id}>{auditShortId(subject.id)}</code></>:auditKind(item)==='reads'?'查询范围见记录详情':'未记录具体对象'}</span></span>
            <span className="galaxy-audit-record-operator"><OperatorIdentity item={item} compact/><span>{auditActorRole(item)}</span></span><Outcome item={item}/>
          </button></li>;})}</ol>:value?<div className="galaxy-audit-empty"><AdminIcon name="history" size={27}/><p>{scanning?'正在查找符合条件的记录。':narrowRequired?'缩小范围后继续查阅记录。':outOfRange?'第 '+pagination!.page+' 页超出本次记录范围，共 '+pagination!.totalPages+' 页。':value.scanLimited?'本轮尚未找到匹配记录。':filtered?'当前检索范围内没有符合条件的记录。':'当前范围内没有审计记录。'}</p>{outOfRange&&<Link href={pageLink(pagination!.totalPages!)} scroll={false}>前往最后一页</Link>}</div>:!page.error&&<div className="galaxy-audit-empty"><AdminIcon name="history" size={27}/><p>记录载入后可在此查阅。</p></div>}
        </div>
        {filters.after&&!pagination?<nav className="galaxy-audit-pagination" aria-label="审计记录分页"><div>{previous&&<Link href={previous} scroll={false}>较新记录</Link>}<Link href={auditHref(filters,{after:'',trail:'',selected:''})} scroll={false}>最新记录</Link></div>{value?.nextAfter&&<Link href={auditNextHref(filters,value.nextAfter)} scroll={false}>{value.scanLimited?'继续检索较早记录':'更早记录'}</Link>}</nav>:<Pagination page={pagination?.page??filters.page} pageSize={filters.pageSize} total={ready?pagination.total:null} totalPages={ready?pagination.totalPages:null} hasPrevious={pagination?.hasPrevious??false} hasNext={pagination?.hasNext??false} loading={busy} disabled={interactionDisabled} showNavigation={ready&&pagination.totalPages!>0} showTotal={false} layout="stacked" ariaLabel="审计记录分页" focusScope={paginationFocusScope} focusReady={page.verified&&ready&&!page.error} pageHref={pageLink} onPage={target=>navigateTo(pageLink(target))} onPageSize={size=>navigate({pageSize:size as AuditFilters['pageSize']})}>
          <label>时间 <select aria-label="记录时间排序" disabled={interactionDisabled} value={filters.sort} onChange={event=>navigate({sort:event.target.value as AuditFilters['sort']})}><option value="newest">从新到旧</option><option value="oldest">从旧到新</option></select></label>
        </Pagination>}
      </section>
      <aside id="audit-record-details" className="galaxy-audit-detail" ref={detailRef} tabIndex={0} aria-label="选中审计记录详情" onScroll={event=>{const positions=activePositions.current;if(page.verified&&selected&&positions?.source===sourceKey)positions.details.set(selectedId,event.currentTarget.scrollTop);}}>
        {selected?<RecordDetails item={selected} items={items} filters={filters} onPick={pick}/>:<div className="galaxy-audit-empty"><AdminIcon name="logs" size={28}/><h2>{!value&&page.error?'审计记录暂不可读取':!value&&(page.loading||page.refreshing)?'正在读取记录':ready&&pagination?.total===0?'当前范围内没有记录':selectedId?'所选记录不在当前页':'选择一条记录'}</h2><p>{!value&&page.error?'请从左侧重新读取后查看记录详情。':!value&&(page.loading||page.refreshing)?'读取完成后可查看操作范围、结果与关联记录。':ready&&pagination?.total===0?'调整左侧筛选条件后继续查阅。':selectedId?'可从左侧选择当前页记录继续查阅。':'从左侧查看操作范围、结果与关联记录。'}</p></div>}
      </aside>
    </div>
  </section>;
}
