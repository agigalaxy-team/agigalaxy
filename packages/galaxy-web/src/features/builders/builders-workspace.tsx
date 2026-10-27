import {ReadingDetails,ReadingSummary} from "../../shared/reading/reading-details";
import React,{useEffect,useEffectEvent,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {createBuildersWebClient} from './builders-client.mjs';
import {BuilderDeclarationView,BuilderSupportView,WorkerPackView,BuilderEventPreview,BuilderNotices,BuilderScopeReportView,builderTestNames,builderActionName,builderKinds} from './builder-details';
import {BuilderAuthoring,builderFormError} from './builder-authoring';
import {useMemberNames} from "../../shared/people/conversation-ui";
import type {BuilderRuntime,BuilderFormKind,BuilderType,BuilderLocator} from './builder-authoring-state';
import type {BuilderDirectoryClient,BuilderDirectoryRow,BuilderDirectoryRead,BuilderManagement,BuilderLocal,BuilderPending,BuilderAuthorization,BuilderStoppedResult,BuilderStopPreview} from './builder-workspace-state';
import {builderDirectoryKind,builderDirectoryType,builderReadingUnavailable} from './builder-workspace-state';
import {nativeQueryScope} from '../../application/query-scope';
import {useServiceReadClient} from '../../shared/runtime/use-service-query';
const builderReads=['query','read','owned','manage'] as const;
type Props={runtime:BuilderRuntime|null;subjectId?:string;connected:boolean;navigate?:(path:string)=>void};
const labels:Record<string,string>={registered:'已登记',unverified:'未核实',delisted:'已下架',unknown:'未核实','not-applicable':'不适用',reachable:'本次可达',unreachable:'本次未达',approved:'已批准','recent-owner-heartbeat':'作者近期报告在线','node-authorized-owner':'节点已批准当前声明','reported-pass':'该范围报告通过','reported-fail':'该范围报告失败','not-tested':'未测试',current:'当前可读','not-declared':'尚未声明',unavailable:'当前不可用','stale-declaration':'只适用旧声明','stale-support':'只适用旧支持范围',expired:'已到期',superseded:'已被后续报告替代','assessor-removed':'评估者已不在配置范围'};
export function BuildersWorkspace(props:Props){
  const connection=props.runtime?.api.snapshot();
  if(!props.runtime)return <section className="help-intro"><h2>建设者</h2><p>服务配置加载后，可浏览 Agent、工具接入和社区登记。</p></section>;
  return <BuildersWorkspaceSession key={JSON.stringify([props.runtime?.api.endpoint,props.subjectId,props.connected,connection?.bindingId,connection?.generation])} {...props} runtime={props.runtime}/>;
}
function BuildersWorkspaceSession({runtime,subjectId,connected:identityConnected,navigate}:Omit<Props,'runtime'>&{runtime:BuilderRuntime}){
  const connection=runtime?.api.snapshot();
  const connected=!!(identityConnected&&subjectId&&(connection?.scopes?.includes('builders')||connection?.scopes?.includes('*')));
  const originalClient:BuilderDirectoryClient|null=useMemo(()=>runtime?createBuildersWebClient(runtime,{subjectId}):null,[runtime,subjectId]);
  const eventRefresh=useRef<(reset:boolean)=>void>(()=>{}),eventDirty=useRef(false);
  const client=useServiceReadClient(originalClient,nativeQueryScope(runtime,subjectId),'builders',builderReads,reset=>eventRefresh.current(reset));
  const [editor,setEditor]=useState(()=>!!new URLSearchParams(location.search).get('compose')),[loaded,setLoaded]=useState(false);
  const [items,setItems]=useState<BuilderDirectoryRow[]>([]),[after,setAfter]=useState<string|null>(null),[owned,setOwned]=useState(false);
  const [query,setQuery]=useState(''),[type,setType]=useState<BuilderType|''>(''),[selected,setSelected]=useState<BuilderDirectoryRead|null>(null),[management,setManagement]=useState<BuilderManagement|null>(null);
  const [kind,setKind]=useState(()=>builderDirectoryKind(new URLSearchParams(location.search).get('compose')));
  const [authorization,setAuthorization]=useState<BuilderAuthorization|null>(null),[pending,setPending]=useState<BuilderPending|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [stopped,setStopped]=useState<BuilderLocator[]>([]),[stoppedResults,setStoppedResults]=useState<Record<string,BuilderStoppedResult>>({}),[stopPreview,setStopPreview]=useState<BuilderStopPreview|null>(null);
  const epoch=useRef(0),running=useRef(false),recoveryReading=useRef(false),uiState=useRef<{editor:boolean;builderId?:string}>({editor}),heading=useRef<HTMLHeadingElement>(null);
  useLayoutEffect(()=>{uiState.current={editor,builderId:selected?.entry.builderId};},[editor,selected?.entry.builderId]);
  useEffect(()=>{heading.current?.scrollIntoView({block:'start'});heading.current?.focus({preventScroll:true});},[editor,selected?.entry?.builderId]);
  const names=useMemberNames(runtime,subjectId,connected,authorization?.viewers??[]);
  const applyLocal=(local:BuilderLocal)=>{setPending(local.pending);setStopped((local.stoppedOperations??[]).filter(item=>item.endpoint===runtime?.api.endpoint&&item.ownerId===subjectId));};
  const run=async(fn:(valid:()=>boolean)=>Promise<void>)=>{if(!client||running.current)return;const token=epoch.current,valid=()=>token===epoch.current;running.current=true;setBusy(true);setError('');setNotice('');
    try{await fn(valid);}catch(e){if(valid())setError(builderFormError(e));}finally{running.current=false;if(valid())setBusy(false);if(valid()&&eventDirty.current){eventDirty.current=false;queueMicrotask(()=>eventRefresh.current(false));}}}
  const refreshLocal=async(valid:()=>boolean)=>{if(connected&&client){const local=await client.local();if(valid())applyLocal(local);}};
  const refreshFromEditor=async()=>{const token=epoch.current;await refreshLocal(()=>epoch.current===token);};
  const open=async(builderId:string,valid:()=>boolean,recover=false)=>{
    if(!valid()||!client)return;
    setSelected(null);setManagement(null);setAuthorization(null);
    if(recover&&connected){const m=await client.manage(builderId);if(!valid())return;setManagement(m);
      if(m.declarationState!=='readable'){setNotice('可重新声明，或发布下架／纠正／安全公告；不恢复旧正文。');return;}}
    let value:BuilderDirectoryRead;try{value=await client.read(builderId,connected);}catch(reason){
      if(connected&&valid()){try{const m=await client.manage(builderId);if(valid()&&m.declarationState!=='readable'){setManagement(m);setNotice('原登记当前不可读，可以重新声明资料或发布适用的维护公告。');return;}}catch{}}
      throw reason;
    }if(!valid())return;
    if(connected&&!recover&&value.entry.ownerId===subjectId){const m=await client.manage(builderId);if(!valid())return;setManagement(m);}
    if(valid()){const url=new URL(location.href);url.searchParams.set('builderId',builderId);window.history.replaceState(window.history.state,'',url.pathname+url.search);setSelected(value);}
  }
  const list=async(mine:boolean,next?:string)=>{await run(async valid=>{const input={...(type?{type}:{}),...(next?{after:next}:{}),limit:8};
    if(!client)return;const page=mine?await client.owned(input):await client.query({...input,query},connected);
    if(valid()){setItems(old=>next?[...old,...page.items]:page.items);setAfter(page.nextAfter);setOwned(mine);setLoaded(true);}await refreshLocal(valid);});}
  const reloadLocal=useEffectEvent(async(token:number)=>{if(document.visibilityState!=='visible'||running.current||recoveryReading.current||!connected||!client)return;recoveryReading.current=true;
      try{const local=await client.local();if(epoch.current!==token)return;applyLocal(local);
        if(local.pending){const result=await client.resumePending();if(epoch.current!==token)return;applyLocal(await client.local());if(result.state==='acknowledged'){setNotice('原资料已保存。');if(!uiState.current.editor&&uiState.current.builderId===result.builderId)await open(result.builderId,()=>epoch.current===token);}else if(result.reason==='business-declined')setNotice('服务未接受上次资料，已停止自动发送。原输入仍保留。');}}
      catch(reason){if(epoch.current===token)setNotice(builderFormError(reason));}finally{recoveryReading.current=false;}});
  const initialize=useEffectEvent(async(token:number)=>{const initialId=new URLSearchParams(location.search).get('builderId');await list(false);if(initialId&&/^[0-9a-f-]{36}$/.test(initialId)&&epoch.current===token)await run(valid=>open(initialId,valid));await reloadLocal(token);});
  eventRefresh.current=reset=>{const {builderId:id,editor:editing}=uiState.current;if(reset){setSelected(null);setManagement(null);setItems([]);}if(running.current){eventDirty.current=true;return;}if(document.hidden)return;void (async()=>{await list(owned);if(id&&!editing)await run(valid=>open(id,valid));})();};
  useEffect(()=>{epoch.current++;
    const token=epoch.current,reload=()=>reloadLocal(token);void initialize(token);
    const timer=window.setInterval(reload,12000);document.addEventListener('visibilitychange',reload);
    return()=>{epoch.current=token+1;window.clearInterval(timer);document.removeEventListener('visibilitychange',reload);};},[client,connected]);
  const displayedId=new URLSearchParams(location.search).get('builderId');
  useEffect(()=>{if(!client||!displayedId||editor)return;const token=epoch.current;let reading=false,live=true;
    const update=async()=>{if(!live||reading||running.current||document.hidden)return;reading=true;try{const value=await client.read(displayedId,connected);if(live&&epoch.current===token)setSelected(value);}catch(reason){
      if(live&&epoch.current===token){if(builderReadingUnavailable(reason)){setSelected(null);setNotice('这份项目资料当前不再向你开放。');try{const owned=await client.manage(displayedId);if(live&&epoch.current===token)setManagement(owned);}catch{if(live&&epoch.current===token)setManagement(null);}}else setNotice('当前资料暂未更新，系统会继续读取。');}
    }finally{reading=false;}};
    const timer=window.setInterval(update,20000);document.addEventListener('visibilitychange',update);return()=>{live=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',update);};
  },[client,displayedId,editor,connected]);
  function compose(next:BuilderFormKind,fresh=false){const url=new URL(location.href);if(fresh){url.searchParams.delete('builderId');setSelected(null);setManagement(null);}url.searchParams.set('compose',next);window.history.replaceState(window.history.state,'',url.pathname+url.search);setKind(next);setEditor(true);setError('');setNotice('');}
  function closeEditor(){const url=new URL(location.href);url.searchParams.delete('compose');window.history.replaceState(window.history.state,'',url.pathname+url.search);setEditor(false);}
  async function saved(builderId:string){const ownerRead=!!management||!selected;closeEditor();const url=new URL(location.href);url.searchParams.set('builderId',builderId);window.history.replaceState(window.history.state,'',url.pathname+url.search);await run(async valid=>{
    try{await open(builderId,valid,ownerRead);}catch{if(valid())setError('资料已经保存，但当前正文暂时无法读取。原保存记录会继续保留。');}
    try{await refreshLocal(valid);}finally{if(valid())setNotice('资料已保存。');}
  });}
  async function continuePending(){await run(async valid=>{if(!client)return;const review=await client.reviewAuthorization();if(!valid())return;
    if(review.state==='reauthorization-required'){setAuthorization(review);return;}
    const result=review.state==='acknowledged'?review:await client.resumePending({explicitRetry:true});if(!valid())return;await refreshLocal(valid);
    if(result.state==='acknowledged'){setNotice('原资料已保存。');if(!uiState.current.editor)await open(result.builderId,valid);}else setNotice('原内容仍保留，系统会继续核对接收结果。');
  });}
  const download=(value:unknown)=>{const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='galaxy-worker-pack-reference.json';a.click();URL.revokeObjectURL(url);};
  if(!client)return <section className="help-intro"><h2>建设者</h2><p>服务配置加载后，可浏览 Agent、工具接入和社区登记。</p></section>;
  const entry=selected?.entry,extensions=selected?.extensions,packEventId=selected?.extensions.pack.eventId;
  const returnToList=()=>{const url=new URL(location.href);url.searchParams.delete('builderId');url.searchParams.delete('compose');window.history.replaceState(window.history.state,'',url.pathname+url.search);setSelected(null);setManagement(null);setEditor(false);setAuthorization(null);void list(owned);};
  return <section className="directory-page professional-page">
    <header className="directory-heading"><div><p className="eyebrow">由作者提供，按实际范围阅读</p><h1 ref={heading} tabIndex={-1} style={{scrollMarginTop:110,outline:'none'}} className="small">{editor?'编写建设者资料':selected?selected.entry.declaration.name:'建设者'}</h1><p className="lead">{editor?'说明项目可以做什么、使用条件与版本，阅读预览后保存。':selected?'了解可做的事、使用条件和当前测试范围。':'发现 Agent、接入工具和社区提供的能力。'}</p></div>{connected&&!editor&&<Button variant="outline" onClick={()=>compose('declare',true)}>登记自己的项目</Button>}</header>
    {error&&<p className="message error" role="alert">{error}</p>}{notice&&<output className="message">{notice}</output>}
    {!editor&&!selected&&<>
      <form className="directory-search" onSubmit={e=>{e.preventDefault();void list(false);}}>
        <label className="search-field">名称或适用范围<input value={query} onChange={e=>setQuery(e.target.value)} maxLength={200} placeholder="搜索 Agent、工具或支持范围"/></label>
        <label>类型<select value={type} onChange={e=>setType(builderDirectoryType(e.target.value))}><option value="">全部</option><option value="worker">Agent / Worker</option><option value="bridge">外部来源适配</option><option value="hub">社区 / Hub</option></select></label>
        <Button type="submit" disabled={busy}>搜索</Button>
      </form>
      <nav className="scope-tabs" aria-label="建设者目录范围"><button aria-current={!owned?'page':undefined} disabled={busy} onClick={()=>list(false)}>当前可读</button><button aria-current={owned?'page':undefined} disabled={busy||!connected} onClick={()=>list(true)}>我的登记</button></nav>
      <div className="directory-list">{items.map(row=><article className="directory-row" key={row.builderId}><div><p className="record-meta">{builderKinds[row.type]??row.type} · {row.version??'修订 '+row.revision}</p><h2><button className="text-link" disabled={busy} onClick={()=>run(valid=>open(row.builderId,valid,owned))}>{row.name??'当前不可读的登记'}</button></h2>{row.scope&&<p>{row.scope}</p>}</div><Button variant="ghost" disabled={busy} onClick={()=>run(valid=>open(row.builderId,valid,owned))}>查看资料</Button></article>)}</div>
      {after&&<Button variant="outline" disabled={busy} onClick={()=>list(owned,after)}>更多登记</Button>}
      {!items.length&&<p className="empty-state">{busy?'正在读取登记…':loaded?'当前范围没有可读登记。可以换一个搜索词或类型。':'正在读取登记…'}</p>}
      {!connected&&<p className="browse-note">{identityConnected?'当前按公开范围浏览。设备取得建设者权限后，可以管理自己的登记。':'连接身份后可以管理自己的登记。'}{navigate&&<button className="text-link" onClick={()=>navigate('/app/settings/identity')}>{identityConnected?'查看当前设备权限':'连接我的身份'}</button>}</p>}
    </>}
    {!editor&&selected&&entry&&extensions&&<article className="professional-detail">
      <button className="back-link" onClick={returnToList}> 返回目录</button>
      <div className="professional-status"><span>登记：{labels[entry.registration.state]??entry.registration.state}</span><span>端点观察：{labels[entry.reachability.state]??entry.reachability.state}</span><span>节点批准：{labels[entry.nodeControl.state]??entry.nodeControl.state}</span></div>
      {entry.securityIssue&&<p className="message">作者已发布尚未解决的安全问题，请先阅读维护说明。</p>}
      <BuilderNotices items={entry.notices}/>
      <BuilderDeclarationView value={entry.declaration}/>{entry.type==='hub'&&navigate&&<Button variant="outline" onClick={()=>navigate('/app/hubs?'+new URLSearchParams(management?{builderId:entry.builderId,mode:'charter'}:{hubId:entry.builderId}))}>{management?'管理社区章程':'查看社区'}</Button>}
      <section className="professional-section"><header className="section-heading"><h2>支持范围</h2><span>{labels[extensions.support.state]??extensions.support.state}</span></header>
        {extensions.support.record?<BuilderSupportView value={extensions.support.record}/>:<p>当前没有可读的支持清单。</p>}
        {!!extensions.support.testedScopes?.length&&<><h3>已有范围测试</h3><ul className="plain-record-list">{extensions.support.testedScopes.map(item=><li key={item.action}><strong>{builderActionName(item.action)}</strong> · {labels[item.state]??item.state}{item.observations.map(o=><p key={o.reportId}>{builderTestNames[o.testClass]??o.testClass}：{o.detail}</p>)}</li>)}</ul></>}
      </section>
      {extensions.reports?.length>0&&<section className="professional-section"><h2>完整范围报告</h2>{extensions.reports.slice().reverse().map(report=><ReadingDetails key={report.id} className="builder-report-reading"><ReadingSummary>{builderTestNames[report.run.testClass]??report.run.testClass} · {labels[report.validity]??'当前适用条件待核对'} · {new Date(report.observedAt*1000).toLocaleDateString('zh-CN')}</ReadingSummary><BuilderScopeReportView value={report}/></ReadingDetails>)}</section>}
      {entry.type==='worker'&&<section className="professional-section"><header className="section-heading"><h2>可使用的 Pack</h2><span>{labels[extensions.pack.state]??extensions.pack.state}</span></header>
        {extensions.pack.record?<><WorkerPackView value={extensions.pack.record}/><div className="button-row">
          {navigate&&packEventId&&<Button onClick={()=>navigate('/app/worker-packs?'+new URLSearchParams({builderId:entry.builderId,manifestId:packEventId}))}>查看这个版本的实际使用</Button>}
          <Button variant="outline" disabled={busy||extensions.delisted||extensions.securityIssue||!packEventId} onClick={()=>run(async valid=>{if(!packEventId)throw Error('当前清单没有准确版本位置，请重新读取。');const value=await client.exportPack(entry.builderId,packEventId,connected);if(valid()){download(value);setNotice('已下载选定版本清单。请按作者说明，在自己的宿主中安装和使用。');}})}>下载版本清单</Button>
        </div></>:<p>当前没有可读的 Pack 清单。</p>}
      </section>}
      <p className="browse-note">报告仅适用于标明的版本和测试范围。{entry.type==='worker'&&'下载清单不会启动 Agent。'}</p>
      {connected&&<div className="button-row">{management&&<Button variant="outline" onClick={()=>compose('declare')}>更新我的资料</Button>}{extensions.canSubmitReport&&extensions.support.record&&<Button variant="ghost" onClick={()=>compose('scope-report')}>提交范围实测报告</Button>}</div>}
      <ReadingDetails className="technical-details"><ReadingSummary>精确版本、来源与原始报告</ReadingSummary><pre>{JSON.stringify({entry,support:extensions.support,reports:extensions.reports,pack:extensions.pack},null,2)}</pre></ReadingDetails>
    </article>}
    {!editor&&management?.declarationState==='unavailable'&&<section className="browse-note"><h2>原登记当前不可读</h2><p>可以重新声明资料，或针对这个登记发布维护公告。</p><Button onClick={()=>compose('declare')}>管理我的登记</Button></section>}
    {connected&&subjectId&&editor&&(!new URLSearchParams(location.search).get('builderId')||selected||management)?<BuilderAuthoring key={selected?.entry?.builderId??management?.builderId??'new'} runtime={runtime} client={client} subjectId={subjectId} selected={selected} management={management} kind={kind} pending={pending} onKind={next=>{setKind(builderDirectoryKind(next));const url=new URL(location.href);url.searchParams.set('compose',next);window.history.replaceState(window.history.state,'',url.pathname+url.search);}} onClose={closeEditor} onSaved={saved} onPending={refreshFromEditor}/>:editor&&<output>正在读取原项目资料…</output>}
    {pending&&<aside className="operation-status"><p>{pending.businessFailure?'服务未接受上次资料，已停止自动发送。原内容仍保留。':pending.blockedReason?'原内容仍保留，请核对后继续。':'正在自动核对上一次资料的接收结果。'}</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={continuePending}>继续上次资料</Button><Button variant="ghost" disabled={busy} onClick={()=>setStopPreview({builderId:pending.event.builderId,eventId:pending.event.id,payloadHash:pending.payloadHash})}>停止这次发送</Button></div></aside>}
    {authorization&&<section className="professional-preview" aria-label="继续原资料的授权"><h2>核对原资料后继续</h2><BuilderEventPreview value={{...authorization,draftRevision:null}} names={names} subjectId={subjectId}/><p>原资料与接收人保持不变。{authorization.originalExpiresAt===authorization.expiresAt?'沿用原许可截止时间：':'原许可已到期，本次许可截止时间：'}{new Date(authorization.expiresAt*1000).toLocaleString('zh-CN')}。</p><div className="button-row"><Button disabled={busy} onClick={()=>run(async valid=>{const result=await client.reauthorize(authorization,{confirmed:true});if(!valid())return;setAuthorization(null);await refreshLocal(valid);if(result.state==='acknowledged'){setNotice('原资料已保存。');if(!uiState.current.editor)await open(result.builderId,valid);}})}>保存原资料并继续</Button><Button variant="ghost" disabled={busy} onClick={()=>setAuthorization(null)}>稍后继续</Button></div></section>}
    {stopPreview&&<section className="message" aria-label="停止原资料重试"><h3>停止这次资料的发送</h3><p>本机会移除发送包中的原文和签名，保留原操作位置供查询。自己填写的表单仍留在本机；已发出的请求仍可能被接收。</p><div className="button-row"><Button disabled={busy} onClick={()=>run(async valid=>{const reviewed=stopPreview,local=await client.local();if(!valid())return;if(local.pending?.event?.id!==reviewed.eventId||local.pending?.event?.builderId!==reviewed.builderId||local.pending?.payloadHash!==reviewed.payloadHash)throw Error('待处理操作已变化，请重新打开。');const result=await client.discard();if(!valid())return;setStopPreview(null);setAuthorization(null);setStoppedResults(old=>({...old,[reviewed.eventId]:{state:result.remoteState}}));await refreshLocal(valid);if(valid())setNotice('已停止这次资料的发送。');})}>停止发送</Button><Button variant="ghost" disabled={busy} onClick={()=>setStopPreview(null)}>继续保留</Button></div></section>}
    {stopped.length>0&&<ReadingDetails className="technical-details"><ReadingSummary>已停止提交的记录（{stopped.length}）</ReadingSummary>{stopped.map(item=><article key={item.eventId}><p>{stoppedResults[item.eventId]?.state==='acknowledged'?'原资料已接收':stoppedResults[item.eventId]?.state==='absent'?'目前未找到原资料':'原资料状态待核对'}</p><p>{stoppedResults[item.eventId]?.error}</p><code>{item.eventId}</code><Button variant="ghost" disabled={busy} onClick={()=>run(async valid=>{try{const receipt=await client.queryStopped(item);if(valid())setStoppedResults(old=>({...old,[item.eventId]:{state:receipt.state}}));}catch(reason){if(valid())setStoppedResults(old=>({...old,[item.eventId]:{state:'unknown',error:builderFormError(reason)}}));}})}>查询原提交</Button></article>)}</ReadingDetails>}
  </section>;
}
