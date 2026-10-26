'use client';
import {AutonomyObjectContext} from "../autonomy/AutonomyObjectContext";

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {FormEvent,ReactNode} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useOperationsRead} from "../../lib/use-operations-read";
import {useDetailReturnFocus} from "../../lib/use-detail-return-focus";
import {operationsRequest} from "../../lib/operations-client";
import {fileAccessBody,fileAccessReceipt,fileAccessStopped,fileBytes,fileErrorText,fileHistory,fileKey,fileScanNames,fileStateNames,fileStates,fileStatus,fileTime,fileTitle,filesHref,filesLocation,filesQuery,nextFilesPage,previousFilesPage} from "../../lib/files/files-view-model";
import type {FileAccessDraft,FileAccessReceipt,FileRecord,FilesLocation,FilesPage,FilesSummary,FilesView} from "../../lib/files/files-view-model";
import type {ManagedFile} from "../operations-business-types";
import {AccountReference,CommandFeedback,ReadStatus} from "../OperationControls";
import {useOperationCommand} from "../../lib/use-operation-command";
import {AdminIcon} from "../AdminIcons";
import type {AdminIconName} from "../AdminIcons";
import {AdminTabs} from "../AdminTabs";
import {FileCleanup} from './FileCleanup';
import './files.css';

const fileErrors={
 operations_file_changed:'处理状态已有更新，说明已保留，请按当前记录继续。',
 operations_file_retry_limit:'这份文件当前的人工重试次数已用完。',
 operations_file_retry_unavailable:'当前状态不允许重新安排处理。',
 operations_file_cleanup_plan_required:'清除需要已批准的具体计划，当前不能重试。',
 operations_file_plan_required:'清除需要已批准的具体计划，当前不能重试。',
 attachment_service_unavailable:'文件处理服务暂时不可用。',
 operations_file_access_changed:'访问状态已有更新，你的说明已保留，请按当前记录继续。',
 operations_file_access_until:'请选择未来的停止访问截止时间。',
 operations_file_access_unavailable:'这份文件当前不能停止访问，请查看文件状态。',
 operations_file_access_restore_unavailable:'当前来源、扫描或到期状态不允许恢复访问。',
 invalid_operations_file_access:'请填写明确的截止时间和处理说明。',
};
const sourceNames={chat:'私聊附件',forum:'社区附件'} as const;
const lease=<T extends {readExpiresAt:number},>(value:T|null,now:number)=>value&&value.readExpiresAt*1000>now?value:null;
const count=(value:number|undefined)=>typeof value==='number'?value.toLocaleString('zh-CN'):'未确认';
type RetryResult={file:FileRecord;state:'scheduled';processingComplete:false};
type FileIntent={kind:'scan';key:string;reason:string}|{kind:'access';key:string;reason:string;until:string;action:'stop'|'restore'};

function Metric({label,value,icon,note}:{label:string;value:string;icon:AdminIconName;note?:string}){
 return <div className="galaxy-files-metric"><span className="galaxy-files-metric-icon"><AdminIcon name={icon} size={23}/></span><div><span>{label}</span><strong>{value}</strong>{note&&<span>{note}</span>}</div></div>;
}
function FileState({file,includeAccess=true}:{file:FileRecord;includeAccess?:boolean}){
 const status=fileStatus(includeAccess?file:{...file,access:undefined});return <span className="galaxy-files-state" data-tone={status.tone}>{status.label}</span>;
}
function Fact({label,children}:{label:string;children:ReactNode}){
 return <div><dt>{label}</dt><dd>{children}</dd></div>;
}
function Owner({file,full=false}:{file:Pick<ManagedFile,'ownerAccountId'|'originSubjectId'>;full?:boolean}){
 if(file.ownerAccountId)return <><AccountReference id={file.ownerAccountId} label={'账户 '+file.ownerAccountId.slice(0,8)}/>{full&&<code>{file.ownerAccountId}</code>}</>;
 return file.originSubjectId?<><span>原主体</span><code>{full?file.originSubjectId:file.originSubjectId.slice(0,16)}</code></>:<span className="galaxy-files-muted">未记录</span>;
}
function Rules({summary,kind}:{summary:FilesSummary|null;kind:FilesLocation['kind']}){
 if(!summary)return <div className="galaxy-files-empty"><AdminIcon name="settings" size={29}/><h3>规则暂未取得</h3><p>重新读取后可查看当前规则。</p></div>;
 const existing=summary.policy.existing;
 return <div className="galaxy-files-rules"><h3>中转规则</h3><p>新中转规则尚未设置。</p><dl className="galaxy-files-facts"><Fact label="中转期限">未确定</Fact><Fact label="中转容量">未确定</Fact></dl>
  {(kind==='chat'||kind==='all')&&<section className="galaxy-files-section"><h3>现有私聊附件</h3><dl className="galaxy-files-facts"><Fact label="保留期限">{existing.chat.retentionDays.toLocaleString('zh-CN')} 天</Fact><Fact label="起算时间">首次开始上传</Fact><Fact label="单文件上限">{fileBytes(existing.chat.maxFileBytes)}</Fact><Fact label="主体额度">{fileBytes(existing.chat.maxSubjectBytes)}</Fact><Fact label="共用额度">{fileBytes(existing.chat.maxGlobalBytes)}</Fact><Fact label="处理服务">{existing.chat.processingAvailable?'可用':'暂不可用'}</Fact></dl></section>}
  {(kind==='forum'||kind==='all')&&<section className="galaxy-files-section"><h3>现有社区附件</h3><dl className="galaxy-files-facts"><Fact label="保留方式">随内容来源处理</Fact><Fact label="单文件上限">{fileBytes(existing.forum.maxFileBytes)}</Fact><Fact label="主体额度">{fileBytes(existing.forum.maxSubjectBytes)}</Fact><Fact label="共用额度">{fileBytes(existing.forum.maxGlobalBytes)}</Fact><Fact label="处理服务">{existing.forum.processingAvailable?'可用':'暂不可用'}</Fact></dl></section>}
  <section className="galaxy-files-section"><h3>清除处理</h3><p>运营清理由具体计划列明文件，经人工确认后逐项执行。本人删除与已证实的上传安全回收继续按原规则处理。</p><dl className="galaxy-files-facts"><Fact label="处理记录">在清理计划中查看</Fact><Fact label="物理空间释放">未确认</Fact></dl></section>
 </div>;
}

export function Files({location:requestedLocation,csrfToken,canManage}:{location:FilesLocation;csrfToken:string;canManage:boolean}){
 const [pinned,setPinned]=useState<FilesLocation|null>(null),location=pinned??requestedLocation;
 const router=useRouter(),query=filesQuery(location),summaryQuery=filesQuery(location,{summary:true});
 const page=useOperationsRead<FilesPage>({path:'/v1/operations/files?'+query,failureMessage:'文件处理记录暂时无法取得。',clearOnOffline:true});
 const summary=useOperationsRead<FilesSummary>({path:'/v1/operations/files/summary'+(summaryQuery?'?'+summaryQuery:''),failureMessage:'文件汇总暂时无法取得。',clearOnOffline:true});
 const current=useOperationsRead<ManagedFile>({path:location.selected&&location.fileKind?'/v1/operations/files/'+location.fileKind+'/'+location.selected:null,failureMessage:'这份文件的状态暂时无法取得。',clearOnOffline:true});
 const [clock,setClock]=useState(()=>Date.now()),[drafts,setDrafts]=useState<Record<string,string>>({}),[accessDrafts,setAccessDrafts]=useState<Record<string,FileAccessDraft>>({}),[accessError,setAccessError]=useState(''),[cleanupLocked,setCleanupLocked]=useState(false);
 const intent=useRef<FileIntent|null>(null),listScroll=useRef<HTMLDivElement|null>(null),detailScroll=useRef<HTMLDivElement|null>(null);
 const listPositions=useRef<Record<string,number>>({}),detailPositions=useRef<Record<string,number>>({});
 const lastDirectory=useRef<FilesLocation>({...location,view:location.issue?'exceptions':'records'});
 const directory=lease(page.value,clock),totals=lease(summary.value,clock),detail=lease(current.value,clock);
 const selectedKey=location.selected&&location.fileKind?location.fileKind+':'+location.selected:'',reason=drafts[selectedKey]??'';
 const detailFocus=useDetailReturnFocus({selectedKey,scopeKey:location.view+':'+query,readableKeys:(location.view==='records'||location.view==='exceptions')&&page.verified&&directory?directory.items.map(fileKey):null});
 const committed=useCallback(async()=>{
  const done=intent.current;
  if(done?.kind==='scan')setDrafts(previous=>previous[done.key]===done.reason?{...previous,[done.key]:''}:previous);
  if(done?.kind==='access')setAccessDrafts(previous=>{const key=done.key+':'+done.action,value=previous[key];return value?.reason===done.reason&&value.until===done.until?{...previous,[key]:{reason:'',until:''}}:previous;});
  await Promise.all([current.read(),page.read(),summary.read()]);
 },[current.read,page.read,summary.read]);
 const conflict=useCallback(()=>{void current.read();void page.read();void summary.read();},[current.read,page.read,summary.read]);
 const recover=useCallback(async(original:{path:string;body:Record<string,unknown>},{signal}:{signal:AbortSignal})=>{
  const target=/^\/v1\/operations\/files\/(chat|forum)\/([0-9a-f-]{36})\/access$/.exec(original.path);
  if(!target)return {state:'not-recorded'} as const;
  const operationId=original.body.operationId,action=original.body.action;
  if(typeof operationId!=='string'||!['stop','restore'].includes(String(action)))throw Error('Original file operation unavailable');
  const value=await operationsRequest<unknown>('/v1/operations/files/access/operations/'+encodeURIComponent(operationId),{signal});
  const receipt=fileAccessReceipt(value,{operationId,kind:target[1] as FileRecord['kind'],id:target[2],action:action as 'stop'|'restore'});
  if(!receipt)throw Error('Original file operation result unavailable');
  return receipt.state==='recorded'?{state:'recorded' as const,value:receipt}:{state:'not-recorded' as const};
 },[]);
 const canScan=canManage&&!!detail?.processingAvailable,canAccess=!!detail?.access&&(detail.access.canStop||detail.access.canRestore),unresolvedAccess=intent.current?.kind==='access'&&!!pinned;
 const command=useOperationCommand<RetryResult|FileAccessReceipt>({csrfToken,canWrite:!!detail&&current.verified&&!current.loading&&(canScan||canAccess||unresolvedAccess),onCommitted:committed,onConflict:conflict,errorMessages:fileErrors,recover});
 useEffect(()=>{if(!command.locked&&pinned)setPinned(null);},[command.locked,pinned]);
 const stopped=!!detail&&fileAccessStopped(detail,clock),accessAction: 'stop'|'restore'=command.locked&&intent.current?.kind==='access'?intent.current.action:stopped?'restore':'stop',accessKey=selectedKey+':'+accessAction,accessDraft=accessDrafts[accessKey]??{reason:'',until:''};
 const locked=command.locked||cleanupLocked;
 const cleanupNavigate=useCallback((patch:Partial<FilesLocation>)=>{router.push(filesHref(location,patch),{scroll:false});},[router,location]);
 const cleanupChanged=useCallback(()=>{void page.read();void summary.read();void current.read();},[page.read,summary.read,current.read]);
 useEffect(()=>{
  setClock(Date.now());
  const ends=[page.value?.readExpiresAt,summary.value?.readExpiresAt,current.value?.readExpiresAt,...(page.value?.items??[]).flatMap(file=>[file.expiresAt?Date.parse(file.expiresAt)/1000:undefined,file.access?.until]),current.value?.expiresAt?Date.parse(current.value.expiresAt)/1000:undefined,current.value?.access?.until].filter((value):value is number=>typeof value==='number'&&Number.isFinite(value)&&value*1000>Date.now());
  if(!ends.length)return;
  const timer=setTimeout(()=>setClock(Date.now()),Math.max(1,Math.min(...ends)*1000-Date.now()));
  return()=>clearTimeout(timer);
 },[page.value,summary.value,current.value]);
 useEffect(()=>{if(location.view==='records'||location.view==='exceptions')lastDirectory.current=location;},[location]);
 useLayoutEffect(()=>{if(directory&&listScroll.current)listScroll.current.scrollTop=listPositions.current[query]??0;},[query,directory?.checkedAt]);
 useLayoutEffect(()=>{if(detail&&detailScroll.current)detailScroll.current.scrollTop=detailPositions.current[fileKey(detail)]??0;},[selectedKey,detail?.checkedAt]);
 useEffect(()=>{
  if(!detail||current.loading||!['pending','running'].includes(detail.scan.state))return;
  const timer=setTimeout(()=>{if(navigator.onLine&&document.visibilityState==='visible'){void current.read();void page.read();void summary.read();}},5000);
  return()=>clearTimeout(timer);
 },[detail,current.loading,current.read,page.read,summary.read]);
 function navigate(patch:Partial<FilesLocation>){
  if(locked)return;
  setAccessError('');
  router.push(filesHref(location,patch),{scroll:false});
 }
 function closeDetail(){if(locked)return;detailFocus.prepareReturn();navigate({selected:'',fileKind:''});}
 function changeView(view:FilesView){
  if(view===location.view)return;
  if(view==='rules'||view==='cleanup'){navigate({view});return;}
  if((location.view==='rules'||location.view==='cleanup')&&lastDirectory.current.view===view){navigate({...lastDirectory.current,selected:location.selected,fileKind:location.fileKind});return;}
  navigate({view,issue:view==='exceptions'?'any':'',after:'',trail:[]});
 }
 function filter(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(command.locked)return;
  const form=new FormData(event.currentTarget),next=filesLocation({kind:form.get('kind'),state:form.get('state'),processing:form.get('processing'),issue:form.get('issue'),view:location.view,id:location.selected,fileKind:location.fileKind});
  router.push(filesHref({...next,after:'',trail:[]}),{scroll:false});
 }
 async function refresh(){
  if(command.locked)return;
  await Promise.all([page.read(),summary.read(),current.read()]);
 }
 async function retryScan(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(!detail||!detail.canRetryScan||detail.expiresAt&&Date.parse(detail.expiresAt)<=Date.now()||!current.verified||current.loading||command.locked)return;
  const note=reason.trim();if(note.length<3||note.length>1600)return;
  intent.current={kind:'scan',key:fileKey(detail),reason};setPinned({...location});
  await command.submit('/v1/operations/files/'+detail.kind+'/'+detail.id+'/retry',{kind:'scan',expectedVersion:detail.processingVersion,reason:note},'已安排重新扫描，等待处理。');
 }
 async function changeAccess(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(!detail||!current.verified||current.loading||command.locked||!detail.access||(accessAction==='stop'?!detail.access.canStop:!detail.access.canRestore))return;
  const body=fileAccessBody(detail,accessAction,accessDraft);if(!body){setAccessError(accessAction==='stop'?'请填写未来的截止时间及至少3字的停止访问说明。':'请填写至少3字的恢复访问说明。');return;}
  setAccessError('');intent.current={kind:'access',key:fileKey(detail),action:accessAction,reason:accessDraft.reason,until:accessDraft.until};setPinned({...location});
  await command.submit('/v1/operations/files/'+detail.kind+'/'+detail.id+'/access',body,accessAction==='stop'?'已停止这份文件的访问。':'已解除这份文件的运营停止访问。');
 }
 function editAccess(patch:Partial<FileAccessDraft>){if(command.locked)return;setAccessDrafts(previous=>({...previous,[accessKey]:{...accessDraft,...patch}}));setAccessError('');}
 const pageCount=directory?.items.length,selectedOnPage=directory?.items.some(item=>fileKey(item)===selectedKey);
 const next=directory?.nextAfter?nextFilesPage(location,directory.nextAfter):null;
 const relevantCommand=intent.current?.key===selectedKey;
 return <section className="galaxy-files" aria-label="文件处理">
  <header className="galaxy-files-header"><div><h1>文件处理</h1><p>{location.kind==='chat'?'私聊附件':location.kind==='forum'?'社区附件':'各来源文件记录'}</p></div>{location.view!=='cleanup'&&<button className="galaxy-files-refresh" type="button" disabled={locked||page.loading||summary.loading||current.loading} onClick={()=>void refresh()}><AdminIcon name="refresh" size={15}/>刷新</button>}</header>
  <AdminTabs items={[{id:'records',label:'文件记录',disabled:locked},{id:'exceptions',label:'异常处理',disabled:locked},{id:'rules',label:'中转规则',disabled:locked},{id:'cleanup',label:'清理计划',disabled:locked}]} active={location.view} onChange={value=>changeView(value as FilesView)} ariaLabel="文件处理页面"/>
  {location.view==='cleanup'?<FileCleanup location={location} csrfToken={csrfToken} navigate={cleanupNavigate} onLock={setCleanupLocked} onChanged={cleanupChanged}/>:<>
  <div className="galaxy-files-summary" aria-label="当前筛选汇总">
   <Metric label="实际存储占用" value={fileBytes(totals?.totals.actualStoredBytes)} icon="file" note={totals?'额度占用 '+fileBytes(totals.totals.reservedBytes):undefined}/>
   <Metric label="附件状态可用" value={count(totals?.totals.readyFiles)} icon="check"/>
   <Metric label="待扫描" value={count(totals?.totals.pendingScan)} icon="search"/>
   <Metric label="清除结果未确认" value={count(totals?.totals.cleanupResultUnknown)} icon="warning"/>
  </div>
  <div className="galaxy-files-summary-note"><span>当前筛选范围 · 额度占用包含预占和待清除记录</span>{totals&&<span>更新于 {fileTime(new Date(totals.checkedAt*1000).toISOString())}</span>}</div>
  <div className="galaxy-files-status"><ReadStatus loading={summary.loading} error={summary.error} retry={summary.read}/></div>
  <div className="galaxy-files-workspace">
   <section className="galaxy-files-directory" aria-label={location.view==='rules'?'中转规则':'文件记录'}>
    <header className="galaxy-files-directory-heading"><h2>{location.view==='rules'?'当前规则':location.view==='exceptions'?'异常记录':'文件记录'}</h2>{location.view!=='rules'&&directory&&<span>本页 {pageCount} 条</span>}</header>
    {location.view==='rules'?<Rules summary={totals} kind={location.kind}/>:<>
     <form className="galaxy-files-filters" key={[location.kind,location.state,location.processing,location.issue,location.view].join(':')} onSubmit={filter}><fieldset disabled={command.locked}>
      <label>来源<select name="kind" defaultValue={location.kind}><option value="chat">私聊附件</option><option value="forum">社区附件</option><option value="all">全部来源</option></select></label>
      <label>文件状态<select name="state" defaultValue={location.state}><option value="">全部状态</option>{fileStates.map(state=><option key={state} value={state}>{fileStateNames[state]}</option>)}</select></label>
      {location.view==='exceptions'?<label>异常类型<select name="issue" defaultValue={location.issue||'any'}><option value="any">全部异常</option><option value="scan">扫描异常</option><option value="cleanup">清除结果未确认</option></select></label>:<label>处理任务<select name="processing" defaultValue={location.processing}><option value="">全部任务</option><option value="scan">待扫描</option><option value="cleanup">待清除</option></select></label>}
      {location.view==='exceptions'&&location.processing&&<input type="hidden" name="processing" value={location.processing}/>}
      <button type="submit">筛选</button>
     </fieldset></form>
     <div className="galaxy-files-status"><ReadStatus loading={page.loading} error={page.error} retry={page.read}/></div>
     <div ref={listScroll} className="galaxy-files-table-scroll" onScroll={event=>{if(directory)listPositions.current[query]=event.currentTarget.scrollTop;}}>
      {directory?.items.length?<table className="galaxy-files-table"><thead><tr><th>文件记录</th><th>大小</th><th>来源</th><th>上传者</th><th>状态</th><th>到期时间</th></tr></thead><tbody>{directory.items.map(file=><tr key={fileKey(file)} data-selected={fileKey(file)===selectedKey} onClick={()=>navigate({selected:file.id,fileKind:file.kind})}>
        <td><button ref={button=>detailFocus.register(fileKey(file),button)} className="galaxy-files-record" type="button" disabled={command.locked} aria-pressed={fileKey(file)===selectedKey} onClick={event=>{event.stopPropagation();navigate({selected:file.id,fileKind:file.kind});}}><span className="galaxy-files-file-icon"><AdminIcon name="file" size={19}/></span><span><strong>{fileTitle(file)}</strong><small>{file.id.slice(0,8)}</small></span></button></td>
       <td data-column="size">{fileBytes(file.size)}</td><td data-column="source" className="galaxy-files-source">{sourceNames[file.kind]}</td><td data-column="owner" className="galaxy-files-owner" onClick={event=>event.stopPropagation()}><Owner file={file}/></td><td data-column="state"><FileState file={file}/></td><td data-column="expiry">{fileTime(file.expiresAt)}</td>
      </tr>)}</tbody></table>:<div className="galaxy-files-empty"><AdminIcon name={location.view==='exceptions'?'check':'file'} size={30}/><h3>{directory?'没有相符的文件记录':page.error?'记录暂不可读取':'正在核对文件记录'}</h3>{directory&&<p>可调整当前筛选继续查看。</p>}</div>}
     </div>
     <footer className="galaxy-files-pagination"><div>{location.after&&<button type="button" disabled={command.locked} onClick={()=>navigate(previousFilesPage(location))}>{location.trail.length?'上一批':'返回首批'}</button>}{next&&'after' in next&&<button type="button" disabled={command.locked} onClick={()=>navigate(next)}>下一批</button>}</div><span>{directory?(directory.nextAfter?'还有更多记录':'本批已读完'):''}</span></footer>
    </>}
   </section>
   <aside className="galaxy-files-detail" aria-label="所选文件详情">
     <header className="galaxy-files-detail-header"><h2>文件信息</h2>{selectedKey&&<button type="button" aria-label="关闭文件详情" disabled={command.locked} onClick={closeDetail}><AdminIcon name="close" size={17}/></button>}</header>
    <div className="galaxy-files-status"><ReadStatus loading={current.loading} error={current.error} retry={current.read}/></div>
    <div ref={detailScroll} className="galaxy-files-detail-scroll" onScroll={event=>{if(detail)detailPositions.current[fileKey(detail)]=event.currentTarget.scrollTop;}}>
     {detail?<>
      <div className="galaxy-files-object"><span className="galaxy-files-file-icon"><AdminIcon name="file" size={25}/></span><div><h3>{fileTitle(detail)}</h3><p><span>{fileBytes(detail.size)}</span><span>{sourceNames[detail.kind]}</span></p><code>{detail.id}</code></div></div>
      {directory&&!selectedOnPage&&<p className="galaxy-files-muted galaxy-files-selected-note">所选记录不在当前这一批。</p>}<AutonomyObjectContext targetType={detail.kind==='chat'?'file-chat':'file-forum'} targetId={detail.id} csrfToken={csrfToken} onChanged={current.read}/>
      <div className="galaxy-files-scan" data-tone={detail.scan.state==='clean'?'positive':detail.scan.state==='blocked'||detail.scan.state==='failed'?'negative':'neutral'}><AdminIcon name={detail.scan.state==='clean'?'check':detail.scan.state==='blocked'||detail.scan.state==='failed'?'warning':'clock'} size={17}/>{fileScanNames[detail.scan.state]}</div>
      <dl className="galaxy-files-facts">
       <Fact label="文件状态"><FileState file={detail} includeAccess={false}/></Fact><Fact label="运营访问">{detail.access?(stopped?'停止访问至 '+fileTime(new Date(detail.access.until!*1000).toISOString()):'未停止访问'):'当前状态未取得'}</Fact><Fact label="上传者"><Owner file={detail} full/></Fact>
       <Fact label="创建记录">{fileTime(detail.createdAt)}</Fact><Fact label="开始上传">{fileTime(detail.uploadedAt)}</Fact><Fact label="到期时间">{fileTime(detail.expiresAt)}</Fact>
       <Fact label="额度占用">{fileBytes(detail.accounting.reservedBytes)}</Fact><Fact label="对象移除">{detail.cleanup.objectRemoved?fileTime(detail.removedAt):'尚无移除记录'}</Fact>
       {detail.revokedAt&&<Fact label="撤销时间">{fileTime(detail.revokedAt)}</Fact>}
       <Fact label="清除状态">{detail.cleanup.state==='removed'?'对象移除已记录':detail.cleanup.state==='result-unknown'?'结果未确认':detail.cleanup.state==='pending'?'待清除':'未申请清除'}</Fact>
      </dl>
      {detail.lastError&&<p className="galaxy-files-reason">{fileErrorText(detail.lastError)}</p>}
      {detail.access&&<section className="galaxy-files-section galaxy-files-access"><h3>访问处理</h3>
       {stopped?<p className="galaxy-files-access-state">停止访问至 {fileTime(new Date(detail.access.until!*1000).toISOString())}</p>:<p>未设置有效的运营停止访问。</p>}
       {detail.access.reason&&<p className="galaxy-files-access-reason">{detail.access.reason}</p>}
       {detail.access.changedAt&&<p className="galaxy-files-muted">{fileTime(detail.access.changedAt)} · {detail.access.operatorDisplayName||'管理账户'}</p>}
       {stopped&&detail.access.restoreBlockedReason&&<p className="galaxy-files-reason">{detail.access.restoreBlockedReason==='source-unavailable'?'当前内容来源不可用，暂不能恢复访问。':'文件的扫描、撤回或到期状态不允许恢复访问。'}</p>}
       {(detail.access.canStop||detail.access.canRestore)&&<form className="galaxy-files-action galaxy-files-access-action" onSubmit={changeAccess}><fieldset disabled={command.locked||current.loading||!current.verified}>
        {accessAction==='stop'&&<label>停止访问至（上海时间）<input type="datetime-local" aria-label="停止访问截止时间" required step={60} value={accessDraft.until} onChange={event=>editAccess({until:event.target.value})}/></label>}
        <label>{accessAction==='stop'?'停止访问说明':'恢复访问说明'}<textarea aria-label={accessAction==='stop'?'停止访问说明':'恢复访问说明'} rows={2} minLength={3} maxLength={1600} required value={accessDraft.reason} onChange={event=>editAccess({reason:event.target.value})}/></label>
        <button type="submit" disabled={accessAction==='stop'?!detail.access.canStop:!detail.access.canRestore}>{accessAction==='stop'?'停止访问':'解除停止访问'}</button>
        <p>{accessAction==='stop'?'只停止访问；原文件、扫描和到期规则保持。':'仅解除运营覆盖，仍须符合当前来源、扫描与到期条件。'}</p>
       </fieldset></form>}
       {accessError&&<p className="galaxy-error" role="alert">{accessError}</p>}
      </section>}
      <section className="galaxy-files-section"><div className="galaxy-files-section-heading"><h3>处理记录</h3><Link href={'/admin/operations/audit?resource='+encodeURIComponent(detail.id)} prefetch={false} aria-disabled={command.locked||undefined} onClick={event=>{if(command.locked)event.preventDefault();}}>相关业务审计</Link></div>
       {detail.history.items.length?<ol className="galaxy-files-history">{fileHistory(detail).map((event,index)=><li key={event.kind+':'+(event.operationId??event.at??'')+':'+index}><time>{fileTime(event.at)}</time><div><strong>{event.label}</strong>{event.kind==='access-stop'&&typeof event.until==='number'&&<span>至 {fileTime(new Date(event.until*1000).toISOString())}</span>}{event.reason&&<span>{event.reason}</span>}{event.operatorId&&<span>操作者 {event.operatorId.startsWith('executor:')?'自动执行':event.operatorDisplayName??'管理账户'}</span>}</div></li>)}</ol>:<p className="galaxy-files-muted">暂无已记录的处理阶段。</p>}
       {detail.history.truncated&&<p className="galaxy-files-muted">更早操作可在相关业务审计中查看。</p>}
      </section>
     </>:<div className="galaxy-files-empty"><AdminIcon name="file" size={31}/><h3>{selectedKey?'所选文件暂不可读取':'选择一份文件'}</h3><p>{selectedKey?'重新取得当前状态后可继续。':'查看文件状态与已记录的处理过程。'}</p></div>}
    </div>
    {relevantCommand&&<div className="galaxy-files-command"><CommandFeedback command={command}/></div>}
    {detail&&canManage&&detail.canRetryScan&&detail.processingAvailable&&(!detail.expiresAt||Date.parse(detail.expiresAt)>clock)&&<form className="galaxy-files-action" onSubmit={retryScan}><fieldset disabled={command.locked||current.loading||!current.verified}><label>重试说明<textarea rows={2} minLength={3} maxLength={1600} required value={reason} onChange={event=>setDrafts(previous=>({...previous,[selectedKey]:event.target.value}))}/></label><button type="submit"><AdminIcon name="refresh" size={15}/>重新安排扫描</button><p>当前还可安排 {detail.retriesRemaining} 次。</p></fieldset></form>}
    {detail&&(detail.cleanup.state==='pending'||detail.cleanup.state==='result-unknown')&&<div className="galaxy-files-action"><button type="button" disabled={command.locked} onClick={()=>changeView('cleanup')}>查看具体清理计划</button></div>}
   </aside>
  </div></>}
 </section>;
}
