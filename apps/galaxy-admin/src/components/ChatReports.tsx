'use client';
import {AutonomyObjectContext} from './AutonomyObjectContext';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {FormEvent} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {AdminTabs} from './AdminTabs';
import {HistoryOperator} from './HistoryOperator';
import {AdminIcon} from './AdminIcons';
import {CommandFeedback,ReadStatus,useOperationCommand} from './OperationControls';
import {recoverChatCommand,validateChatOperation,chatRecoveryPendingMessage} from '../lib/chat-command-recovery';
import type {ChatRecovered} from '../lib/chat-command-recovery';
import {useOperationsRead} from '../lib/use-operations-read';
import {OperationsRequestError,operationsFailure} from '../lib/operations-client';
import {timeLabel} from './business-types';
import type {ChatReportFilters,ChatScope,MessageVisibilityAction,ReportDetail,ReportEvent,ReportMaterial,ReportPage} from './chat-report-types';
import {chatReportHref,chatReportReadPath,chatReportUuid,materialAuthorLabel,messageVisibilityLabels,reportCategories,reportEventNames,reportMaterialKey,reportStates,scopeLabels} from './chat-report-types';
import './private-chat.css';

type Props={filters:ChatReportFilters;csrfToken:string;canManage:boolean};
type CaseDraft={action:'review'|'pause'|'resume'|'resolve';summary:string;rule:string;verdict:'upheld'|'dismissed';withRestriction:boolean;scopes:ChatScope[];days:string};
const emptyDraft:CaseDraft={action:'review',summary:'',rule:'',verdict:'dismissed',withRestriction:false,scopes:[],days:'1'};
const errors:Record<string,string>={
 chat_report_version_changed:'案件已有新记录，已重新读取；填写内容已保留。',chat_report_target_changed:'对话状态已变化，已重新读取；填写内容已保留。',
 chat_report_moderation_denied:'当前管理身份不能处理这份案件。',chat_report_state:'案件状态已变化，请按当前记录继续。',
 chat_report_restriction_invalid:'请选择有效的限制内容和期限。',chat_report_operation_conflict:'原操作内容不一致，请查看当前记录。',
 chat_report_materials_expired:'案件材料已到保存期限。',chat_report_unavailable:'这份案件当前不可读取。',
 chat_report_message_not_selected:'这条消息未选入当前案件。',chat_report_message_version_changed:'消息处置版本已有更新，说明已保留。',chat_report_source_changed:'消息版本已变化，请按当前获准材料继续。',chat_report_source_unavailable:'消息来源当前不可恢复。',chat_report_message_state:'消息处置状态已变化，请按当前记录继续。',chat_report_event_limit:'本案处理记录已达到当前上限。',
 operations_login_required:'管理登录已到期，请重新登录。'
};
type DownloadContext={resource:ReportDetail|null;path:string|null;reportId:string;csrfToken:string};
type DownloadFlight={reportId:string;path:string;csrfToken:string;readExpiresAt:number;material:Pick<ReportMaterial,'eventId'|'messageId'|'revision'|'sourceExpiresAt'>;attachment:ReportMaterial['attachments'][number]};
function downloadReadable(flight:DownloadFlight,context:DownloadContext){
 const detail=context.resource,now=Date.now();
 return context.path===flight.path&&context.reportId===flight.reportId&&context.csrfToken===flight.csrfToken&&detail?.reportId===flight.reportId&&
  !detail.materialsExpired&&detail.readExpiresAt*1000>now&&flight.readExpiresAt*1000>now&&
  detail.materials.some(material=>material.state==='available'&&material.eventId===flight.material.eventId&&material.messageId===flight.material.messageId&&
   material.revision===flight.material.revision&&material.sourceExpiresAt===flight.material.sourceExpiresAt&&material.attachments.some(file=>
    file.attachmentId===flight.attachment.attachmentId&&file.contentAvailable&&file.name===flight.attachment.name&&file.mediaType===flight.attachment.mediaType&&file.size===flight.attachment.size&&file.state===flight.attachment.state));
}
function State({value}:{value:keyof typeof reportStates}){return <span className="galaxy-private-state" data-state={value}>{reportStates[value]}</span>;}
function Account({id,label}:{id:string;label?:string}){
 return chatReportUuid.test(id)?<Link href={'/admin/operations/users?account='+encodeURIComponent(id)} prefetch={false}>{label||'账户 '+id.slice(0,8)}</Link>:<code>{id}</code>;
}
function Author({material}:{material:ReportMaterial}){
 if(material.state!=='available')return <span className="galaxy-private-author">发送者当前不可读取</span>;
 const id=material.authorAccountId||(material.authorRef.startsWith('account:')?material.authorRef.slice(8):'');
 return <span className="galaxy-private-author">{id&&chatReportUuid.test(id)?<Account id={id} label={materialAuthorLabel(material)}/>:<span>{materialAuthorLabel(material)}</span>}{material.authorUid&&material.authorDisplayName&&<small>UID {material.authorUid}</small>}</span>;
}
function EventActor({event}:{event:ReportEvent}){
 return <span>{event.actorKind==='business-operator'?<>运营管理身份{event.operatorId&&<> · <HistoryOperator id={event.operatorId} name={event.operatorDisplayName}/></>}</>:event.accountId?<Account id={event.accountId}/>:event.actorKind==='official-account'?'当事账户':'来源未记录'}</span>;
}
function History({events}:{events:ReportEvent[]}){
 return events.length?<ol className="galaxy-private-history">{[...events].reverse().map(event=><li key={event.eventId}>
  <div><strong>{reportEventNames[event.kind]??'案件事件'}</strong><time dateTime={event.at}>{timeLabel(event.at)}</time></div>
  <p>{event.summary??'这条记录的内容当前不可读取。'}</p>
  {event.decision?.message?<dl><dt>消息</dt><dd><code>{event.decision.message.messageId}</code> · 版本 {event.decision.message.revision}</dd><dt>本次动作</dt><dd>{messageVisibilityLabels[event.decision.message.action]}</dd><dt>本案屏蔽</dt><dd>{event.decision.message.hidden?'生效':'已解除'}</dd></dl>:event.decision&&<dl><dt>处理结果</dt><dd>{event.decision.verdict==='upheld'?'举报成立':event.decision.verdict==='dismissed'?'举报不成立':'临时限制'}</dd>{event.decision.rule&&<><dt>适用规则</dt><dd>{event.decision.rule}</dd></>}{!!event.decision.scopes?.length&&<><dt>限制范围</dt><dd>{(event.decision.scopes??[]).map(scope=>scopeLabels[scope]).join('、')}</dd></>}{event.decision.until&&<><dt>限制期限</dt><dd>{timeLabel(new Date(event.decision.until*1000).toISOString())}</dd></>}</dl>}
  <footer><EventActor event={event}/><span>版本 {event.version}</span></footer>
 </li>)}</ol>:<p className="galaxy-private-empty">暂无可读取的案件事件。</p>;
}
export function ChatReports({filters:location,csrfToken,canManage}:Props){
 const [pendingFilters,setPendingFilters]=useState<ChatReportFilters|null>(null),filters=pendingFilters??location;
 const router=useRouter(),directoryPath=chatReportReadPath(filters);
 const directory=useOperationsRead<ReportPage>({path:directoryPath,failureMessage:'案件列表暂时无法取得。',clearOnOffline:true});
 const reportId=filters.report,path=reportId?'/v1/operations/chat-reports/'+reportId:null;
 const [reading,setReading]=useState<{path:string|null;value:ReportDetail|null;loading:boolean;error:string}>({path:null,value:null,loading:false,error:''});
 const detail=reading.path===path&&reading.value&&reading.value.readExpiresAt*1000>Date.now()?reading.value:null;
 const loading=reading.path===path?reading.loading:!!path,error=reading.path===path?reading.error:'';
 const [drafts,setDrafts]=useState<Record<string,CaseDraft>>({}),[chosen,setChosen]=useState<Record<string,{room:string;message:string}>>({});
 const [messageDrafts,setMessageDrafts]=useState<Record<string,{action:MessageVisibilityAction;summary:string}>>({});
 const messageOperationKey=useRef(''),caseOperationReport=useRef('');
 const draft=drafts[reportId]??emptyDraft;
 const updateDraft=(change:Partial<CaseDraft>)=>setDrafts(previous=>({...previous,[reportId]:{...(previous[reportId]??emptyDraft),...change}}));
 const activeRead=useRef<AbortController|null>(null),readGeneration=useRef(0),alive=useRef(false);
 const activeDownload=useRef<AbortController|null>(null),downloadFlight=useRef<DownloadFlight|null>(null),downloadGeneration=useRef(0);
 const [download,setDownload]=useState(''),[downloadError,setDownloadError]=useState('');
 const latest=useRef<DownloadContext>({resource:detail,path,reportId,csrfToken});latest.current={resource:detail,path,reportId,csrfToken};
 const cancelDownload=useCallback((clear=true)=>{downloadGeneration.current++;activeDownload.current?.abort();activeDownload.current=null;downloadFlight.current=null;if(clear&&alive.current)setDownload('');},[]);
 const clearDetail=useCallback((message='')=>{readGeneration.current++;activeRead.current?.abort();activeRead.current=null;cancelDownload();latest.current={...latest.current,resource:null};setReading({path,value:null,loading:false,error:message});},[path,cancelDownload]);
 const read=useCallback(async()=>{
  if(!path||!alive.current)return;
  activeRead.current?.abort();const controller=new AbortController(),generation=++readGeneration.current;activeRead.current=controller;
  setReading(previous=>({path,value:previous.path===path?previous.value:null,loading:true,error:''}));
  try{
   const response=await fetch(path,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])});
   if(!alive.current||controller.signal.aborted||generation!==readGeneration.current||latest.current.path!==path)return;
   if(!response.ok){
    // Known read failure invalidates an in-flight download before error-body
    // parsing or React's next commit can yield to its buffered Blob.
    cancelDownload();latest.current={...latest.current,resource:null};setReading({path,value:null,loading:true,error:''});
    const failure=await response.json().catch(()=>null),code=typeof failure?.error==='string'?failure.error:typeof failure?.error?.code==='string'?failure.error.code:'operations_unavailable';
    throw new OperationsRequestError(response.status,code);
   }
   const value:ReportDetail=await response.json();
   if(!alive.current||controller.signal.aborted||generation!==readGeneration.current||latest.current.path!==path)return;
   if(value.reportId!==reportId||!Number.isFinite(value.readExpiresAt))throw Error('invalid_case_response');
   if(downloadFlight.current&&!downloadReadable(downloadFlight.current,{...latest.current,resource:value}))cancelDownload();
   latest.current={...latest.current,resource:value};
   setReading({path,value,loading:false,error:''});
  }catch(failure){
   if(!alive.current||controller.signal.aborted||generation!==readGeneration.current||latest.current.path!==path)return;
   cancelDownload();latest.current={...latest.current,resource:null};
   setReading({path,value:null,loading:false,error:operationsFailure(failure,'这份案件暂时无法取得。')});
  }finally{if(activeRead.current===controller)activeRead.current=null;}
 },[path,reportId,cancelDownload]);
 useLayoutEffect(()=>{
  alive.current=true;cancelDownload();setDownloadError('');readGeneration.current++;activeRead.current?.abort();
  return()=>{alive.current=false;readGeneration.current++;activeRead.current?.abort();cancelDownload(false);};
 },[path,csrfToken,cancelDownload]);
 useLayoutEffect(()=>{if(downloadFlight.current&&!downloadReadable(downloadFlight.current,latest.current))cancelDownload();},[detail,path,reportId,csrfToken,cancelDownload]);
 useEffect(()=>{
  if(!path)return;
  const offline=()=>clearDetail('网络已断开，恢复后继续读取。');
  const visible=()=>{if(document.visibilityState==='visible'&&navigator.onLine)void read();else if(document.visibilityState!=='visible')clearDetail();};
  if(!navigator.onLine)offline();else if(document.visibilityState==='visible')void read();
  window.addEventListener('offline',offline);window.addEventListener('online',visible);window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
  return()=>{window.removeEventListener('offline',offline);window.removeEventListener('online',visible);window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);};
 },[path,read,clearDetail,csrfToken]);
 useEffect(()=>{
  if(!detail)return;const timer=setTimeout(()=>{clearDetail();if(navigator.onLine&&document.visibilityState==='visible')void read();},Math.max(0,detail.readExpiresAt*1000-Date.now()));
  return()=>clearTimeout(timer);
 },[detail,read,clearDetail]);
 useEffect(()=>{
  if(!directory.value)return;const timer=setTimeout(()=>{directory.clear();if(navigator.onLine&&document.visibilityState==='visible')void directory.read();},Math.max(0,directory.value.readExpiresAt*1000-Date.now()));
  return()=>clearTimeout(timer);
 },[directory.value,directory.clear,directory.read]);
 const committed=useCallback(async(value:ReportDetail|ChatRecovered)=>{
  setDrafts(previous=>{const next={...previous};delete next[value.reportId];return next;});
  if(latest.current.reportId===value.reportId)await read();
  void directory.read();
 },[read,directory.read]);
 const conflict=useCallback(()=>{void read();void directory.read();},[read,directory.read]);
 const command=useOperationCommand<ReportDetail|ChatRecovered>({csrfToken,canWrite:canManage,canRecover:directory.verified,recover:recoverChatCommand,validateResult:validateChatOperation,recoveryPendingMessage:chatRecoveryPendingMessage,onCommitted:committed,onConflict:conflict,errorMessages:errors});
 const materials=useMemo(()=>[...(detail?.materials??[])].sort((a,b)=>a.sentAt.localeCompare(b.sentAt)||a.messageId.localeCompare(b.messageId)||a.revision-b.revision),[detail]);
 const rooms=[...new Set(materials.map(item=>item.roomId))],room=rooms.includes(chosen[reportId]?.room??'')?chosen[reportId].room:rooms[0]??'';
 const roomMaterials=materials.filter(item=>item.roomId===room),authors=[...new Set(roomMaterials.map(item=>item.authorRef))];
 const pickedKey=chosen[reportId]?.message??'',picked=materials.find(item=>reportMaterialKey(item)===pickedKey)??roomMaterials[0]??null;
 const moderation=picked?.moderation,messageKey=picked?reportId+':'+picked.messageId+':'+picked.revision:'';
 const allowedMessageActions:MessageVisibilityAction[]=canManage&&detail?(['keep','restore','hide'] as const).filter(action=>action==='hide'?moderation?.canHide:action==='restore'?moderation?.canRestore:moderation?.canKeep):[];
 const messageDraft=messageDrafts[messageKey]??{action:allowedMessageActions[0]??'keep',summary:''};
 const messageAction=allowedMessageActions.includes(messageDraft.action)?messageDraft.action:allowedMessageActions[0];
 const messageCommitted=useCallback(async(value:ReportDetail|ChatRecovered)=>{
  setMessageDrafts(previous=>{const next={...previous};delete next[messageOperationKey.current];return next;});
  if(latest.current.reportId===value.reportId)await read();void directory.read();
 },[read,directory.read]);
 const messageCommand=useOperationCommand<ReportDetail|ChatRecovered>({csrfToken,canWrite:canManage,canRecover:directory.verified,recover:recoverChatCommand,validateResult:validateChatOperation,recoveryPendingMessage:chatRecoveryPendingMessage,onCommitted:messageCommitted,onConflict:conflict,errorMessages:errors});
 const locked=command.locked||messageCommand.locked;
 useEffect(()=>{if(!locked)setPendingFilters(null);},[locked]);
 const scroll=useRef<HTMLDivElement>(null),side=useRef<HTMLElement>(null),list=useRef<HTMLDivElement>(null),positions=useRef(new Map<string,number>());
 const messageElements=useRef(new Map<string,HTMLElement>()),viewKey=reportId+':'+filters.view+':'+room;
 const [focusTarget,setFocusTarget]=useState<{reportId:string;key:string}|null>(null);
 useLayoutEffect(()=>{if(detail&&scroll.current)scroll.current.scrollTop=positions.current.get('main:'+viewKey)??0;},[viewKey,!!detail]);
 useLayoutEffect(()=>{if(directory.value&&list.current)list.current.scrollTop=positions.current.get('list:'+directoryPath)??0;},[directoryPath,!!directory.value]);
 useLayoutEffect(()=>{if(side.current&&detail)side.current.scrollTop=positions.current.get('side:'+reportId)??0;},[reportId,!!detail]);
 const navigate=(change:Partial<ChatReportFilters>,replace=false)=>{
  if(locked)return;const href=chatReportHref(filters,change);
  if(replace)router.replace(href,{scroll:false});else router.push(href,{scroll:false});
 };
 const focusMessage=(material:ReportMaterial)=>{
  setFocusTarget({reportId,key:reportMaterialKey(material)});
  setChosen(previous=>({...previous,[reportId]:{room:material.roomId,message:reportMaterialKey(material)}}));
  if(filters.view!=='conversation')navigate({view:'conversation'},true);
 };
 useEffect(()=>{
  const container=scroll.current,element=focusTarget?messageElements.current.get(focusTarget.key):null;
  if(!focusTarget||focusTarget.reportId!==reportId||!detail||!container||!element||filters.view!=='conversation')return;
  container.scrollTop=Math.max(0,container.scrollTop+element.getBoundingClientRect().top-container.getBoundingClientRect().top-20);
  setFocusTarget(null);
 },[focusTarget,reportId,room,filters.view,!!detail]);
 async function submitCase(event:FormEvent){
  event.preventDefault();if(!detail?.canModerate||!canManage||locked||!draft.summary.trim())return;
  const body:Record<string,unknown>={reportId:detail.reportId,expectedVersion:detail.version,kind:draft.action,summary:draft.summary};
  if(draft.action==='pause'||draft.action==='resolve'){
   if(!detail.currentTarget)return;body.targetVersion=detail.currentTarget.version;body.rule=draft.rule;
   const restriction={scopes:draft.scopes,until:Math.floor(Date.now()/1000)+Number(draft.action==='pause'&&draft.days==='30'?'7':draft.days)*86400};
   if(draft.action==='pause'){body.scopes=restriction.scopes;body.until=restriction.until;}
   else{body.verdict=draft.verdict;body.restriction=draft.verdict==='upheld'&&draft.withRestriction?restriction:null;}
  }
  caseOperationReport.current=detail.reportId;
  setPendingFilters({...filters,report:detail.reportId});
  await command.submit('/v1/operations/chat-reports/'+detail.reportId+'/event',body,'案件处理已记录。');
 }
 async function submitMessage(event:FormEvent){
  event.preventDefault();if(!detail||!canManage||!picked||!moderation||!messageAction||locked||!messageDraft.summary.trim())return;
  messageOperationKey.current=messageKey;cancelDownload();
  setPendingFilters({...filters,report:detail.reportId});
  await messageCommand.submit('/v1/operations/chat-reports/'+detail.reportId+'/messages/'+picked.messageId+'/visibility',
   {expectedVersion:detail.version,expectedRevision:moderation.revision,messageRevision:picked.revision,action:messageAction,summary:messageDraft.summary},'消息处置已记录。');
 }
 async function downloadMaterial(material:ReportMaterial,file:ReportMaterial['attachments'][number]){
  if(!detail||!path||activeDownload.current||!file.name||!navigator.onLine||document.visibilityState!=='visible')return;
  const flight:DownloadFlight={reportId:detail.reportId,path,csrfToken,readExpiresAt:detail.readExpiresAt,material:{eventId:material.eventId,messageId:material.messageId,revision:material.revision,sourceExpiresAt:material.sourceExpiresAt},attachment:file};
  if(!downloadReadable(flight,latest.current))return;
  const controller=new AbortController(),generation=++downloadGeneration.current;activeDownload.current=controller;downloadFlight.current=flight;setDownload(file.attachmentId);setDownloadError('');
  try{
   const response=await fetch(path+'/attachments/'+file.attachmentId+'/content',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json','X-Galaxy-Operator-CSRF':flight.csrfToken},body:'{}',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
   if(!response.ok)throw Error('download_failed');const blob=await response.blob();
   if(!alive.current||controller.signal.aborted||downloadGeneration.current!==generation)return;
   if(!navigator.onLine||document.visibilityState!=='visible'||!downloadReadable(flight,latest.current)){cancelDownload();return;}
   const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=file.name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }catch{if(alive.current&&!controller.signal.aborted&&downloadGeneration.current===generation){setDownloadError('附件当前无法下载，已重新读取材料。');void read();}}
  finally{if(downloadGeneration.current===generation){activeDownload.current=null;downloadFlight.current=null;if(alive.current)setDownload('');}}
 }
 const terminal=detail?.state==='resolved'||detail?.state==='withdrawn',needsScope=draft.action==='pause'||draft.action==='resolve'&&draft.verdict==='upheld'&&draft.withRestriction;
 const trail=filters.trail?filters.trail.split(','):[],items=directory.value?.items??[];
 const reviewEnabled=detail?.canModerate&&canManage&&!detail.materialsExpired&&(!terminal||!!detail.ownRestriction);
 return <section className="galaxy-private-chat">
  <header className="galaxy-private-page-header"><div><h1>私聊案件</h1><p>选入对话与消息</p></div><button className="galaxy-private-secondary" type="button" disabled={loading||directory.loading||locked} onClick={()=>{void directory.read();if(path)void read();}}><AdminIcon name="refresh" size={15}/>刷新记录</button></header>
  <div className="galaxy-private-command">{(caseOperationReport.current===reportId||command.pending)&&<>{!!command.pending&&caseOperationReport.current!==reportId&&<p>正在确认案件 {caseOperationReport.current.slice(0,8)} 的原操作。</p>}<CommandFeedback command={command}/></>}{(messageOperationKey.current.startsWith(reportId+':')||messageCommand.pending)&&<>{!!messageCommand.pending&&!messageOperationKey.current.startsWith(reportId+':')&&<p>正在确认案件 {messageOperationKey.current.slice(0,8)} 的原消息处置。</p>}<CommandFeedback command={messageCommand}/></>}</div>
  <div className="galaxy-private-workspace">
   <section className="galaxy-private-reader" aria-label="当前案件">
    <div className="galaxy-private-read-status"><ReadStatus loading={loading} error={error} retry={read}/></div>
    {detail?<><header className="galaxy-private-object-header"><div><span className="galaxy-private-eyebrow">案件 {detail.reportId.slice(0,8)}</span><State value={detail.state}/></div><h2>{reportCategories[detail.category]}举报</h2><dl><dt>提交时间</dt><dd><time dateTime={detail.createdAt}>{timeLabel(detail.createdAt)}</time></dd><dt>举报账户</dt><dd>{detail.reporterAccountId?<Account id={detail.reporterAccountId}/>: '当前不可读取'}</dd><dt>选入材料</dt><dd>{materials.length} 份{rooms.length>1?' · '+rooms.length+' 个对话':''}</dd></dl></header><AutonomyObjectContext targetType="chat-report" targetId={detail.reportId} csrfToken={csrfToken} onChanged={read}/>
     <AdminTabs items={[{id:'conversation',label:'对话材料',panelId:'galaxy-private-panel'},{id:'history',label:'处理记录',panelId:'galaxy-private-panel'}].map(item=>({...item,disabled:locked}))} active={filters.view} onChange={value=>navigate({view:value as ChatReportFilters['view']},true)} ariaLabel="私聊案件详情"/>
     {filters.view==='conversation'&&rooms.length>1&&<div className="galaxy-private-room-choice"><label>选入对话<select value={room} disabled={locked} onChange={event=>setChosen(previous=>({...previous,[reportId]:{room:event.target.value,message:''}}))}>{rooms.map((id,index)=><option key={id} value={id}>对话 {index+1} · {id.slice(0,8)}</option>)}</select></label></div>}
     <div className="galaxy-private-conversation-scroll" id="galaxy-private-panel" role="tabpanel" aria-label={filters.view==='history'?'处理记录':'对话材料'} ref={scroll} onScroll={event=>{if(detail)positions.current.set('main:'+viewKey,event.currentTarget.scrollTop);}}>
      {filters.view==='history'?<History events={detail.events}/>:<>
       {room&&<div className="galaxy-private-room-heading"><AdminIcon name="messages" size={17}/><span>对话 <code>{room}</code></span><small>{roomMaterials.length} 份选入材料</small>{filters.room!==room&&<button className="galaxy-private-text-button" type="button" disabled={locked} onClick={()=>navigate({room,after:'',trail:''})}>只看本对话案件</button>}</div>}
       {roomMaterials.map(material=><article className="galaxy-private-message" data-selected={picked&&reportMaterialKey(picked)===reportMaterialKey(material)} data-side={authors.indexOf(material.authorRef)%2?'alternate':'primary'} key={reportMaterialKey(material)} ref={element=>{const key=reportMaterialKey(material);if(element)messageElements.current.set(key,element);else messageElements.current.delete(key);}}>
        <header><span className="galaxy-private-avatar" aria-hidden="true">{material.state==='available'?materialAuthorLabel(material).slice(0,1):'·'}</span><Author material={material}/><time dateTime={material.sentAt}>{timeLabel(material.sentAt)}</time></header>
        <div className="galaxy-private-message-body">{material.state==='available'?<>
         {material.text&&<p>{material.text}</p>}
         {material.attachments.length>0&&<ul className="galaxy-private-attachments">{material.attachments.map(file=><li key={file.attachmentId}><AdminIcon name="file" size={17}/>{file.contentAvailable&&file.name?<button type="button" disabled={!!download} onClick={()=>void downloadMaterial(material,file)}>{download===file.attachmentId?'正在下载…':file.name}</button>:<span>附件当前不可读取</span>}{file.contentAvailable&&typeof file.size==='number'&&<small>{file.size>=1048576?(file.size/1048576).toFixed(1)+' MB':Math.ceil(file.size/1024)+' KB'}</small>}</li>)}</ul>}
         {!material.text&&!material.attachments.length&&<p className="galaxy-private-muted">这份材料没有可展示的正文或附件。</p>}
        </>:<p className="galaxy-private-muted">这条消息当前不可读取。</p>}</div>
        <footer><span>消息版本 {material.revision}{material.moderation&&<> · <span className="galaxy-private-visibility" data-hidden={material.moderation.hidden}>{material.moderation.hidden?'网站已屏蔽':'无生效运营屏蔽'}</span></>}</span><button type="button" className="galaxy-private-text-button" disabled={locked} onClick={()=>focusMessage(material)} aria-pressed={!!picked&&reportMaterialKey(picked)===reportMaterialKey(material)}>选择此消息</button></footer>
       </article>)}
       {!roomMaterials.length&&<div className="galaxy-private-empty"><AdminIcon name="messages" size={28}/><h3>{detail.materialsExpired?'材料已到保存期限':'没有可查看的选入消息'}</h3></div>}
      </>}
     </div>
     {filters.view==='conversation'&&picked&&<section className="galaxy-private-message-handling" aria-label="选中消息的处置"><header><h3>选中消息</h3><span>{picked.state==='available'?materialAuthorLabel(picked):'当前不可读取'} · 版本 {picked.revision}</span></header>
      <div className="galaxy-private-message-control"><div className="galaxy-private-message-facts"><p>{moderation?moderation.hidden?'网站后续展示已屏蔽':'无生效的运营屏蔽':'尚无可读取的消息处置状态'}</p>{moderation&&<small>{moderation.ownHidden?'本案屏蔽生效':moderation.hidden?'仍有其他来源的屏蔽':'本案没有生效屏蔽'}</small>}
       {moderation?.initialDecision&&<p className="galaxy-private-message-decision">原决定：{messageVisibilityLabels[moderation.initialDecision.action]} · {timeLabel(moderation.initialDecision.at)}<br/>管理身份 <HistoryOperator id={moderation.initialDecision.operatorId} name={moderation.initialDecision.operatorDisplayName}/> · 消息版本 {moderation.initialDecision.sourceRevision}</p>}
       {moderation?.currentDecision&&moderation.currentDecision.eventId!==moderation.initialDecision?.eventId&&<p className="galaxy-private-message-decision">当前决定：{messageVisibilityLabels[moderation.currentDecision.action]} · {timeLabel(moderation.currentDecision.at)}</p>}
      </div>{allowedMessageActions.length>0?<form onSubmit={submitMessage}><fieldset disabled={locked||loading}><label>本次动作<select value={messageAction} onChange={event=>setMessageDrafts(previous=>({...previous,[messageKey]:{...messageDraft,action:event.target.value as MessageVisibilityAction}}))}>{allowedMessageActions.map(action=><option key={action} value={action}>{messageVisibilityLabels[action]}</option>)}</select></label><label className="galaxy-private-message-note">处理说明<textarea value={messageDraft.summary} maxLength={1600} rows={2} required onChange={event=>setMessageDrafts(previous=>({...previous,[messageKey]:{...messageDraft,summary:event.target.value}}))}/></label><button type="submit" className="galaxy-private-primary" disabled={!messageDraft.summary.trim()||!messageAction}>{messageAction==='hide'?'屏蔽这条消息':messageAction==='restore'?'解除本案屏蔽':'记录维持决定'}</button></fieldset>{messageAction==='restore'&&<p className="galaxy-private-message-impact">只解除本案屏蔽；其他案件、来源失效和访问权限继续生效。</p>}</form>:<p className="galaxy-private-muted">{!canManage?'当前没有这项处置权限。':picked.state!=='available'?'当前来源或版本不符合消息处置条件。':'当前没有可用的消息处置操作。'}</p>}</div>
     </section>}
    </>:!loading&&!error&&<div className="galaxy-private-empty"><AdminIcon name="messages" size={34}/><h2>{reportId?'这份案件当前没有可读取的材料':'选择一份案件'}</h2><p>查看选入对话、证据与处理记录。</p></div>}
   </section>
   <aside className="galaxy-private-sidebar" aria-label="案件列表、证据与处理" ref={side} onScroll={event=>{if(detail)positions.current.set('side:'+reportId,event.currentTarget.scrollTop);}}>
    <section className="galaxy-private-directory">
     <header><h2>案件列表</h2><span>{directory.value?'本页 '+items.length+' 份':'数量未知'}</span></header>
     <form className="galaxy-private-filters" key={filters.state+':'+filters.room} onSubmit={event=>{event.preventDefault();const data=new FormData(event.currentTarget);navigate({state:String(data.get('state')??'') as ChatReportFilters['state'],after:'',trail:''});}}><fieldset disabled={locked}><label><span>处理状态</span><select name="state" defaultValue={filters.state}><option value="">全部状态</option>{Object.entries(reportStates).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label><button type="submit">筛选</button></fieldset></form>
     {filters.room&&<p className="galaxy-private-scope">当前对话 <code>{filters.room}</code><button type="button" disabled={locked} onClick={()=>navigate({room:'',after:'',trail:''})}>查看全部对话</button></p>}
     <div className="galaxy-private-read-status"><ReadStatus loading={directory.loading} error={directory.error} retry={directory.read}/></div>
     <div className="galaxy-private-case-list" ref={list} onScroll={event=>{if(directory.value)positions.current.set('list:'+directoryPath,event.currentTarget.scrollTop);}}>
      {items.map(item=><button key={item.reportId} type="button" disabled={locked} className="galaxy-private-case-row" aria-pressed={item.reportId===reportId} onClick={()=>navigate({report:item.reportId})}><div><strong>{reportCategories[item.category]}举报</strong><State value={item.state}/></div><div><code>{item.reportId.slice(0,8)}</code><time dateTime={item.updatedAt}>{timeLabel(item.updatedAt)}</time></div></button>)}
      {directory.value&&!items.length&&<p className="galaxy-private-empty">没有符合当前条件的案件。</p>}
     </div>
     <footer className="galaxy-private-pagination"><button type="button" disabled={!filters.after||locked} onClick={()=>navigate({after:trail.at(-1)==='start'?'':trail.at(-1)??'',trail:trail.slice(0,-1).join(',')})}>{trail.length?'上一批':'首批'}</button><button type="button" disabled={!directory.value?.nextAfter||locked} onClick={()=>navigate({after:directory.value?.nextAfter??'',trail:[...trail,filters.after||'start'].join(',')})}>下一批</button></footer>
    </section>
    {detail&&<><section className="galaxy-private-evidence"><header><h2>选入证据</h2><span>{materials.length} 份</span></header>{directory.value&&!items.some(item=>item.reportId===reportId)&&<p className="galaxy-private-scope">当前案件不在本批列表中。</p>}
     <ol>{materials.map((material,index)=><li key={reportMaterialKey(material)}><button className="galaxy-private-evidence-row" type="button" disabled={locked} aria-pressed={!!picked&&reportMaterialKey(picked)===reportMaterialKey(material)} onClick={()=>focusMessage(material)}><span>{index+1}</span><div><strong>{material.state==='available'?materialAuthorLabel(material):'当前不可读取'}</strong><p>{material.state==='available'?(material.text|| (material.attachments.length?'已选附件':'无文字材料')).slice(0,75):'来源已失效或当前没有读取资格。'}</p><time dateTime={material.sentAt}>{timeLabel(material.sentAt)}</time></div></button></li>)}</ol>
    </section>
    <section className="galaxy-private-handling"><header><h2>案件处理</h2><span>版本 {detail.version}</span></header>
     <dl className="galaxy-private-facts"><dt>当前状态</dt><dd><State value={detail.state}/></dd><dt>本案对话限制</dt><dd>{detail.ownRestriction?<>{detail.ownRestriction.scopes.map(scope=>scopeLabels[scope]).join('、')}<br/>至 {timeLabel(detail.ownRestriction.until)}</>:'无生效限制'}</dd></dl>
     {reviewEnabled?<form onSubmit={submitCase}><fieldset disabled={locked||loading}><label>处理操作<select value={draft.action} onChange={event=>updateDraft({action:event.target.value as CaseDraft['action']})}><option value="review" disabled={terminal}>记录处理进展</option><option value="pause" disabled={terminal||!detail.currentTarget}>临时限制对话参与</option><option value="resume" disabled={!detail.ownRestriction}>解除本案对话限制</option><option value="resolve" disabled={terminal||!detail.currentTarget}>记录处理结果</option></select></label>
      {(draft.action==='pause'||draft.action==='resolve')&&<label>适用规则<input value={draft.rule} onChange={event=>updateDraft({rule:event.target.value})} maxLength={120} required/></label>}
      {draft.action==='resolve'&&<><label>处理结果<select value={draft.verdict} onChange={event=>updateDraft({verdict:event.target.value as CaseDraft['verdict']})}><option value="dismissed">举报不成立</option><option value="upheld">举报成立</option></select></label>{draft.verdict==='upheld'&&<label className="galaxy-private-checkbox"><input type="checkbox" checked={draft.withRestriction} onChange={event=>updateDraft({withRestriction:event.target.checked})}/>同时限制此对话参与</label>}</>}
      {needsScope&&<><div className="galaxy-private-scopes">{Object.entries(scopeLabels).map(([scope,label])=><label className="galaxy-private-checkbox" key={scope}><input type="checkbox" checked={draft.scopes.includes(scope as ChatScope)} onChange={event=>updateDraft({scopes:event.target.checked?[...draft.scopes,scope as ChatScope]:draft.scopes.filter(value=>value!==scope)})}/>{label}</label>)}</div><label>持续时间<select value={draft.action==='pause'&&draft.days==='30'?'7':draft.days} onChange={event=>updateDraft({days:event.target.value})}><option value="1">1 天</option><option value="7">7 天</option>{draft.action==='resolve'&&<option value="30">30 天</option>}</select></label></>}
      <label>处理说明<textarea value={draft.summary} onChange={event=>updateDraft({summary:event.target.value})} maxLength={1600} rows={4} required/></label>
      {draft.action==='resolve'&&detail.ownRestriction&&(!draft.withRestriction||draft.verdict==='dismissed')&&<p className="galaxy-private-impact">本次结案将解除本案的现有对话限制。</p>}
      <button className="galaxy-private-primary" type="submit" disabled={!draft.summary.trim()||needsScope&&!draft.scopes.length||draft.action==='review'&&terminal||draft.action==='resume'&&!detail.ownRestriction||(draft.action==='pause'||draft.action==='resolve')&&(!detail.currentTarget||terminal)}>保存处理记录</button>
     </fieldset></form>:<p className="galaxy-private-muted">{detail.materialsExpired?'案件材料已到保存期限。':!canManage?'当前没有这项处置权限。':terminal&&!detail.ownRestriction?(detail.state==='withdrawn'?'举报已撤回，对话参与没有本案生效限制。':'处理结果已记录，对话参与没有本案生效限制。'):'当前没有可用的案件处理权限。'}</p>}
    </section>
    <section className="galaxy-private-recent"><header><h2>最近处理</h2><button type="button" className="galaxy-private-text-button" disabled={locked} onClick={()=>navigate({view:'history'},true)}>完整记录</button></header>{detail.events.length?<History events={detail.events.slice(-3)}/>:<p className="galaxy-private-empty">暂无处理记录。</p>}</section></>}
   </aside>
  </div>
  {downloadError&&<p className="galaxy-private-download-error" role="alert">{downloadError}</p>}
 </section>;
}


