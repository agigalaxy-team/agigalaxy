import React,{useCallback,useEffect,useId,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/textarea';
import {AccountSessionScope,useAccountSessionModel} from "../../accounts/account-session-scope";
import {LoadingFeedback,ReadFailure} from "../../../shared/feedback/interaction-feedback";
import {useReadTasks} from "../../../shared/reading/use-read-task";
import {createAccountChatGovernanceClient} from './account-chat-governance-client.mjs';
import type {GovernanceRuntime,TargetReference} from "../governance-workspace-types";
import type {ChatReport,ChatReportPage,ChatReportMessage,ChatReportSource,ChatReportDraft,ChatReportPending} from './account-chat-governance-types';
import './account-chat-governance.css';

type Props={runtime:GovernanceRuntime;target?:TargetReference;reportId?:string;navigate:(path:string)=>void};
const stateNames:Record<string,string>={received:'待处理',reviewing:'处理中',resolved:'已处理',appealed:'申诉中',withdrawn:'已撤回'};
const eventNames:Record<string,string>={report:'举报',supplement:'补充',appeal:'申诉','withdraw-report':'撤回举报',review:'开始处理',pause:'临时限制',resume:'解除限制',resolve:'处理结果'};
const categoryNames:Record<ChatReportDraft['category'],string>={advertising:'广告或骚扰推广',harassment:'骚扰',privacy:'隐私问题',misrepresentation:'冒用或虚假陈述',other:'其他问题'};
const scopeNames:Record<string,string>={'sending-paused':'暂停发送消息','invitations-paused':'暂停邀请'};
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{hour12:false});
const empty:ChatReportDraft={summary:'',category:'other',action:'',selections:[]};
const errorText=(error:unknown)=>{
 const code=error&&typeof error==='object'&&'code'in error?String(error.code):error instanceof Error?error.message:'';
 return({official_account_session_expired:'登录已到期，请重新登录后继续。',official_account_changed:'当前账户已改变，请回原账户继续。',chat_report_source_changed:'选中的消息已有变更，请重新选择这条消息。',chat_report_source_unavailable:'部分选中消息当前不可读取，请移除后继续。',chat_report_target_changed:'对话成员或设置已有变更，请刷新后继续。',chat_report_attachment_unavailable:'选中的附件已不可读取，请移除后继续。',chat_report_version_changed:'处理记录已有更新，原输入已保留，请刷新后继续。',chat_report_open_limit:'这段对话已有待处理举报，可以在原记录中补充。',chat_report_material_limit:'本案材料已达上限，可以继续提交文字说明。',chat_report_event_limit:'这条记录的补充已达上限。',chat_report_unavailable:'这条记录当前不可读取。',chat_access_denied:'你目前无法读取这段对话。',chat_report_state:'处理状态已有变化，请刷新后继续。',chat_report_materials_expired:'这条记录的材料保存期已结束。',chat_report_operation_conflict:'上次发送的记录与本次内容不一致，请回原记录继续。'} as Record<string,string>)[code]??'暂时无法完成，请稍后重试。原输入仍保留。';
};
function draftValue(value:unknown,fallback:ChatReportDraft):ChatReportDraft{
 if(!value||typeof value!=='object')return fallback;
 const item=value as Partial<ChatReportDraft>;
 return{summary:typeof item.summary==='string'?item.summary:fallback.summary,category:item.category&&item.category in categoryNames?item.category:fallback.category,
  action:['supplement','appeal','withdraw-report',''].includes(item.action??'')?item.action??'':'',
  selections:Array.isArray(item.selections)?item.selections.filter(selection=>selection&&typeof selection.messageId==='string'&&Number.isInteger(selection.revision)&&Array.isArray(selection.attachmentIds)):fallback.selections};
}

export function AccountChatGovernanceWorkspace(props:Props){
 return <AccountSessionScope endpoint={props.runtime.api.endpoint}><AccountChatGovernanceGate {...props}/></AccountSessionScope>;
}
function AccountChatGovernanceGate(props:Props){
 const model=useAccountSessionModel(),retained=useRef(model.session?.account.id??null);
 if(model.phase==='signed-in')retained.current=model.session?.account.id??null;
 if(model.phase==='signed-out')retained.current=null;
 const owner=retained.current;
 if(!owner)return <section className="governance-workspace"><h1>私聊举报</h1>{model.phase==='loading'?<LoadingFeedback label="正在读取账户…"/>:<><p>登录后查看或提交举报。</p>{model.error&&<ReadFailure message={model.error} onRetry={()=>void model.refresh()}/>}<Button disabled={!model.client} onClick={()=>{if(model.client)location.assign(model.client.loginUrl('login',location.pathname+location.search));}}>登录</Button></>}</section>;
 return <AccountChatGovernanceSession key={props.runtime.api.endpoint+':'+owner+':'+(props.reportId??props.target?.id??'all')} {...props} owner={owner}/>;
}
function AccountChatGovernanceSession({runtime,target,reportId,navigate,owner}:Props&{owner:string}){
 const summaryId=useId();
 const model=useAccountSessionModel(),session=model.session,available=model.phase==='signed-in'&&session?.account.id===owner&&navigator.onLine!==false;
 const client=React.useMemo(()=>model.client&&session?.account.id===owner?createAccountChatGovernanceClient({client:model.client,session,runtime}):null,[model.client,session,runtime,owner]);
 const transport=useRef(client);transport.current=client;
 const active=useRef({available,owner});active.current={available,owner};
 const tasks=useReadTasks(JSON.stringify([runtime.api.endpoint,owner,session?.csrfToken]));
 const roomId=target?.type==='room'?target.id:undefined,locator=reportId?'case:'+reportId:'room:'+(roomId??'all');
 const parameters=new URLSearchParams(location.search),initialMessage=parameters.get('messageId'),initialRevision=Number(parameters.get('messageRevision'));
 const requestedRoom=parameters.get('roomId'),roomFilter=roomId??(requestedRoom&&/^[0-9a-f-]{36}$/.test(requestedRoom)?requestedRoom:undefined);
 const initial:ChatReportDraft={...empty,selections:initialMessage&&/^[0-9a-f-]{36}$/.test(initialMessage)&&Number.isInteger(initialRevision)&&initialRevision>0?[{messageId:initialMessage,revision:initialRevision,attachmentIds:[]}]:[]};
 const [draft,setDraft]=useState<ChatReportDraft>(initial),draftRef=useRef(draft);draftRef.current=draft;
 const [ready,setReady]=useState(false),[draftError,setDraftError]=useState(''),[record,setRecord]=useState<ChatReport|null>(null),[items,setItems]=useState<ChatReport[]>([]),[next,setNext]=useState<string|null>(null);
 const [source,setSource]=useState<ChatReportSource|null>(null),[candidates,setCandidates]=useState<ChatReportMessage[]>([]),[chooser,setChooser]=useState(false),[earlier,setEarlier]=useState<string|null>(null);
 const [loading,setLoading]=useState(false),[sourceBusy,setSourceBusy]=useState(false),[candidateBusy,setCandidateBusy]=useState(false),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[readError,setReadError]=useState(''),[sourceError,setSourceError]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [pending,setPending]=useState<ChatReportPending[]>([]),working=useRef(false),alive=useRef(true),pages=useRef(1),sourceExpiry=useRef(0),candidateExpiry=useRef(0),recordExpiry=useRef(0);
 const activeRoom=record?.target.id??roomId,selectedIds=draft.selections.map(item=>item.messageId).sort().join(',');
 const pendingHere=pending.filter(operation=>reportId?operation.kind==='event'&&operation.payload.reportId===reportId:operation.kind==='report'&&operation.payload.roomId===roomId);
 const selectionLimit=record?.additionalMaterialCapacity??20;
 const valid=()=>alive.current&&active.current.available&&active.current.owner===owner;
 const change=useCallback((patch:Partial<ChatReportDraft>)=>{
  const updated={...draftRef.current,...patch};draftRef.current=updated;setDraft(updated);setError('');setNotice('');
  if(transport.current)void transport.current.saveDraft(locator,updated).then(()=>{if(alive.current)setDraftError('');}).catch(()=>{if(alive.current)setDraftError('暂时未能保存这份草稿，请保留此页。');});
 },[locator]);
 const refresh=useCallback((after?:string)=>tasks.run({lane:'case',key:reportId??after??'head'},async({signal})=>{
  const current=transport.current;if(!current)throw Error('official_account_session_expired');
  if(reportId)return{record:await current.call('get',{reportId},{signal}) as ChatReport,items:[] as ChatReport[],nextAfter:null};
  let cursor=after;const rows:ChatReport[]=[];let page:ChatReportPage|null=null;
  for(let count=0;count<(after?1:pages.current);count++){
   page=await current.call('query',{...(roomFilter?{roomId:roomFilter}:{}),...(cursor?{after:cursor}:{}),limit:20},{signal}) as ChatReportPage;
   rows.push(...page.items);if(!page.nextAfter)break;if(page.nextAfter===cursor)throw Error('chat_report_cursor_invalid');cursor=page.nextAfter;
  }
  return{record:null,items:rows,nextAfter:page?.nextAfter??null};
 },{onStart:()=>{setLoading(true);setReadError('');},onSuccess:result=>{recordExpiry.current=result.record?.readExpiresAt??Math.floor(Date.now()/1000)+60;setRecord(result.record);setItems(old=>after?[...new Map([...old,...result.items].map(item=>[item.reportId,item])).values()]:result.items);setNext(result.nextAfter);setLoaded(true);if(after)pages.current++;},onError:reason=>{setRecord(null);setItems([]);setNext(null);setReadError(errorText(reason));setLoaded(true);},onSettled:()=>setLoading(false)}),[tasks,reportId,roomFilter]);
 const refreshSource=useCallback(()=>{
  if(!activeRoom||!ready||!available)return;
  return tasks.run({lane:'source',key:activeRoom+':'+selectedIds},async({signal})=>{
   if(!transport.current)throw Error('official_account_session_expired');
   return await transport.current.call('source',{roomId:activeRoom,messageIds:selectedIds?selectedIds.split(','):[]},{signal}) as ChatReportSource;
  },{onStart:()=>{setSourceBusy(true);setSourceError('');},onSuccess:value=>{sourceExpiry.current=value.readExpiresAt;setSource(value);},onError:reason=>{setSource(null);setSourceError(errorText(reason));},onSettled:()=>setSourceBusy(false)});
 },[activeRoom,ready,available,selectedIds,tasks]);
 const sourceRead=useRef(refreshSource);sourceRead.current=refreshSource;
 useEffect(()=>{
  alive.current=true;return()=>{alive.current=false;};
 },[]);
 useEffect(()=>{if(!client)return;let current=true;
  void Promise.all([client.draft(locator),client.pending()]).then(([saved,operations])=>{if(!current)return;const value=draftValue(saved,initial);draftRef.current=value;setDraft(value);setPending(operations as ChatReportPending[]);setReady(true);}).catch(()=>{if(current){setDraftError('本机草稿暂时无法读取，输入不会自动发送。');setReady(true);}});
  return()=>{current=false;};
 // A refreshed network session uses the same account journal and never reloads
 // that account's in-progress inputs over a currently edited form.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[owner,locator,!!client]);
 useEffect(()=>{
  const clear=()=>{tasks.cancel();setRecord(null);setItems([]);setNext(null);setSource(null);setCandidates([]);setLoading(false);setSourceBusy(false);setCandidateBusy(false);setReadError(navigator.onLine===false?'暂时离线，联网后继续读取。':'当前连接无法核对，请稍后重试。');};
  const read=()=>{if(!available||document.hidden||working.current||navigator.onLine===false)return;void refresh();void sourceRead.current();};
  if(available)read();else clear();
  const timer=setInterval(read,20000),expire=setInterval(()=>{const now=Math.floor(Date.now()/1000);if(recordExpiry.current&&recordExpiry.current<=now){setRecord(null);setItems([]);}if(sourceExpiry.current&&sourceExpiry.current<=now)setSource(null);if(candidateExpiry.current&&candidateExpiry.current<=now)setCandidates([]);},1000);
  const visibility=()=>{if(document.hidden)clear();else read();};
  window.addEventListener('offline',clear);window.addEventListener('online',read);window.addEventListener('focus',read);document.addEventListener('visibilitychange',visibility);
  return()=>{tasks.cancel();clearInterval(timer);clearInterval(expire);window.removeEventListener('offline',clear);window.removeEventListener('online',read);window.removeEventListener('focus',read);document.removeEventListener('visibilitychange',visibility);};
 },[available,refresh,tasks]);
 useEffect(()=>{void refreshSource();return()=>tasks.cancel('source');},[refreshSource,tasks]);
 const chooseMessages=(before?:string)=>{
  if(!activeRoom||!model.client||!session||!available)return;setChooser(true);
  void tasks.run({lane:'candidates',key:activeRoom+':'+(before??'latest')},async({signal})=>{
   const result=await model.client!.call('/v2/chat/rooms/'+activeRoom+'/history',{latest:true,limit:20,...(before?{before}:{})},{session:session!,signal}) as {messages:(ChatReportMessage&{subjectId:string;state:string})[];previous:string|null;readExpiresAt:number};
   return{...result,messages:result.messages.filter(message=>message.state==='accepted').map(message=>({...message,authorRef:message.subjectId}))};
  },{onStart:()=>{setCandidateBusy(true);setSourceError('');},onSuccess:result=>{candidateExpiry.current=result.readExpiresAt;setCandidates(old=>before?[...new Map([...result.messages,...old].map(item=>[item.messageId,item])).values()]:result.messages);setEarlier(result.previous);},onError:reason=>{setCandidates([]);setSourceError(errorText(reason));},onSettled:()=>setCandidateBusy(false)});
 };
 const selectMessage=(message:ChatReportMessage,selected:boolean)=>{
  const previous=draftRef.current.selections.filter(item=>item.messageId!==message.messageId);
  change({selections:selected?[...previous,{messageId:message.messageId,revision:message.revision,attachmentIds:[]}]:previous});
 };
 async function send(kind:ChatReportDraft['action']|'report'='report'){
  const current=transport.current;if(!current||!available||working.current||!ready)return;
  if(kind==='report'&&!source)return;
  working.current=true;tasks.cancel();setLoading(false);setSourceBusy(false);setCandidateBusy(false);setBusy(true);setError('');setNotice('');
  try{
   const value=draftRef.current,summary=kind==='withdraw-report'?'撤回举报。':value.summary.trim(),operationId=crypto.randomUUID();
   const payload=kind==='report'?{operationId,roomId:activeRoom!,roomVersion:source!.roomVersion,category:value.category,summary,materials:value.selections}:
    {operationId,reportId:reportId!,expectedVersion:record!.version,kind,summary,...(kind==='supplement'||kind==='appeal'?{materials:value.selections}:{})};
   await current.saveDraft(locator,value);
   const result=await current.submit(kind==='report'?'report':'event',payload) as ChatReport;
   if(!valid())return;draftRef.current=empty;setDraft(empty);setSource(null);setCandidates([]);setChooser(false);setPending([]);setNotice(kind==='report'?'举报已提交。':'已提交。');
   if(kind==='report')navigate('/app/governance/'+result.reportId+'?accountChat=1'+(initialMessage?'&messageId='+encodeURIComponent(initialMessage):''));else{recordExpiry.current=result.readExpiresAt;setRecord(result);}
  }catch(reason){if(valid()){setError(errorText(reason));try{setPending(await current.pending() as ChatReportPending[]);}catch{setDraftError('暂时无法读取本机发送记录，请保留此页。');}}}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 async function continuePending(){
  if(!transport.current||working.current||!available)return;const current=transport.current;working.current=true;setBusy(true);setError('');
  try{for(const operation of pendingHere){const receipt=await current.resume(operation);if(!valid())return;if(operation.kind==='report'&&operation.payload.roomId===roomId&&receipt.state==='recorded'&&receipt.reportId){navigate('/app/governance/'+receipt.reportId+'?accountChat=1'+(initialMessage?'&messageId='+encodeURIComponent(initialMessage):''));return;}}const saved=await current.draft(locator);if(valid()){const value=draftValue(saved,empty);draftRef.current=value;setDraft(value);setPending(await current.pending() as ChatReportPending[]);void refresh();}}
  catch(reason){if(valid()){setError(errorText(reason));try{setPending(await current.pending() as ChatReportPending[]);}catch{setDraftError('暂时无法读取本机发送记录，请保留此页。');}}}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 const backRoom=activeRoom??roomFilter,back=backRoom?'/app/rooms/'+backRoom+(initialMessage?'?message='+encodeURIComponent(initialMessage):''):'/app/rooms';
 const composer=!!activeRoom&&(!reportId||!!draft.action),selectedById=new Map(source?.messages.map(message=>[message.messageId,message])??[]);
 const selectedValid=draft.selections.every(selection=>{const message=selectedById.get(selection.messageId);return message?.revision===selection.revision&&selection.attachmentIds.every(id=>message.attachments.some(file=>file.attachmentId===id&&file.state==='available'));});
 const authorName=(message:ChatReportMessage)=>{const known=source?.authors.find(author=>author.authorRef===message.authorRef);return message.authorDisplayName||message.authorUid||known?.authorDisplayName||known?.authorUid||(message.authorRef==='account:'+owner?'我':'对话成员');};
 const materialView=(message:ChatReportMessage,removable=false)=><article className="chat-report-message" key={(message.eventId??'')+message.messageId}><header><strong>{authorName(message)}</strong><time>{time(message.sentAt)}</time>{removable&&<button className="text-link" type="button" disabled={busy} onClick={()=>change({selections:draftRef.current.selections.filter(item=>item.messageId!==message.messageId)})}>移除消息</button>}</header><p>{message.state==='unavailable'?'原消息当前不可读取。':message.text||'附件消息'}</p>{message.attachments.length>0&&<ul>{message.attachments.map(file=><li key={file.attachmentId}>{removable?<label><input type="checkbox" disabled={busy||file.state!=='available'} checked={draft.selections.find(item=>item.messageId===message.messageId)?.attachmentIds.includes(file.attachmentId)??false} onChange={event=>change({selections:draftRef.current.selections.map(item=>item.messageId===message.messageId?{...item,attachmentIds:event.target.checked?[...item.attachmentIds,file.attachmentId]:item.attachmentIds.filter(id=>id!==file.attachmentId)}:item)})}/>{file.name||'附件'}</label>:<span>{file.name||'附件'}{file.state!=='available'?' · 当前不可读取':''}</span>}</li>)}</ul>}{!removable&&message.state==='available'&&message.sourcePath&&<a href={message.sourcePath} className="text-link" onClick={event=>{event.preventDefault();navigate(message.sourcePath!);}}>查看原消息</a>}</article>;
 return <section className="governance-workspace account-chat-governance"><a href={back} className="governance-back" onClick={event=>{event.preventDefault();navigate(back);}}>回到对话</a><header><h1>{reportId?'举报详情':roomId?'举报对话':'我的私聊举报'}</h1>{record&&<p className="governance-state">{stateNames[record.state]}</p>}</header>
  {!available&&<ReadFailure message={model.phase==='offline'?'暂时离线，输入保留在本机。':'当前账户连接暂时无法核对。'} onRetry={()=>void model.refresh()}/>}<LoadingFeedback active={loading} label="正在读取处理记录…" scopeKey={owner+':'+locator}/>{readError&&<ReadFailure message={readError} onRetry={available?()=>void refresh():undefined} retrying={loading}/>} {error&&<ReadFailure message={error} onRetry={available?()=>{void refresh();void refreshSource();}:undefined}/>} {notice&&<output className="message">{notice}</output>}
  {pendingHere.length>0&&<div className="message"><p>上次发送的结果还未确认。</p><Button disabled={!available||busy} onClick={()=>void continuePending()}>继续确认</Button></div>}
  {record?.ownRestriction&&<p className="governance-state">{record.ownRestriction.scopes.map(scope=>scopeNames[scope]??scope).join('、')}，至 {time(record.ownRestriction.until)}。</p>}
  {record?.events&&<ol className="chat-report-events">{record.events.map(event=><li key={event.eventId}><header><strong>{eventNames[event.kind]}</strong><time>{time(event.at)}</time></header>{event.summary&&<p>{event.summary}</p>}{event.decision&&<p className="muted">{event.decision.verdict==='upheld'?'举报成立 · ':event.decision.verdict==='dismissed'?'举报不成立 · ':''}{event.decision.rule}</p>}</li>)}</ol>}
  {!!record?.materials?.length&&<section><h2>随案材料</h2>{record.materials.map(message=>materialView(message))}</section>}
  {record?.materialsExpired&&<p>随案说明与材料的保存期已结束，处理状态保留。</p>}
  {record&&!draft.action&&<div className="button-row">{record.canRespond&&<Button disabled={busy||!available||!!pendingHere.length} onClick={()=>change({action:'supplement',summary:'',selections:[]})}>补充说明</Button>}{record.canAppeal&&<Button variant="outline" disabled={busy||!available||!!pendingHere.length} onClick={()=>change({action:'appeal',summary:'',selections:[]})}>提出申诉</Button>}{record.canWithdraw&&<Button variant="ghost" disabled={busy||!available||!!pendingHere.length} onClick={()=>void send('withdraw-report')}>撤回举报</Button>}</div>}
  {!reportId&&loaded&&items.length>0&&<section><h2>{roomId?'这段对话的处理记录':'相关处理记录'}</h2><ul className="chat-report-list">{items.map(item=><li key={item.reportId}><a href={'/app/governance/'+item.reportId+'?accountChat=1'} onClick={event=>{event.preventDefault();navigate('/app/governance/'+item.reportId+'?accountChat=1');}}><strong>{stateNames[item.state]}</strong><time>{time(item.updatedAt)}</time></a></li>)}</ul>{next&&<Button variant="ghost" disabled={loading||busy} onClick={()=>void refresh(next)}>更多记录</Button>}</section>}
  {!reportId&&!roomId&&loaded&&!loading&&!readError&&!items.length&&<p>还没有相关举报记录。</p>}
  {composer&&<form className="governance-compose" onSubmit={event=>{event.preventDefault();void send(reportId?draft.action:'report');}}><h2>{reportId?eventNames[draft.action]:'说明遇到的问题'}</h2>{!reportId&&<label>问题类型<select value={draft.category} disabled={busy||!ready} onChange={event=>change({category:event.target.value as ChatReportDraft['category']})}>{Object.entries(categoryNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>}<label htmlFor={summaryId}>你的说明<Textarea id={summaryId} required maxLength={1600} value={draft.summary} disabled={busy||!ready} onChange={event=>change({summary:event.target.value})}/></label>
   <section className="chat-report-selection"><header><h3>随案材料{draft.selections.length?' · '+draft.selections.length+' 条消息':''}</h3><Button variant="outline" type="button" disabled={busy||!available||!ready||draft.selections.length>=selectionLimit} onClick={()=>chooseMessages()}>选择消息</Button></header><LoadingFeedback active={sourceBusy} label="正在核对所选消息…" scopeKey={owner+':source'}/>{sourceError&&<ReadFailure message={sourceError} onRetry={available?()=>void refreshSource():undefined} retrying={sourceBusy}/>}{draft.selections.map(selection=>{const message=selectedById.get(selection.messageId);return message&&message.revision===selection.revision?materialView(message,true):<div className="chat-report-message" key={selection.messageId}><p>{message?'所选消息已被编辑，请重新选择。':'所选消息暂时不可读取。'}</p>{message&&<><p>{message.text||'附件消息'}</p><Button type="button" variant="outline" disabled={busy} onClick={()=>selectMessage(message,true)}>选择当前消息</Button></>}<button type="button" className="text-link" disabled={busy} onClick={()=>change({selections:draftRef.current.selections.filter(item=>item.messageId!==selection.messageId)})}>移除消息</button></div>;})}{!draft.selections.length&&<p className="muted">{selectionLimit?'未附消息。可只提交问题说明。':'本案材料已达上限，可继续补充文字说明。'}</p>}
   {chooser&&<section className="chat-report-picker" aria-label="选择随案消息"><header><h3>选择消息</h3><Button type="button" variant="ghost" onClick={()=>setChooser(false)}>完成选择</Button></header><LoadingFeedback active={candidateBusy} label="正在读取消息…" scopeKey={owner+':picker'}/>{earlier&&<button className="text-link" type="button" disabled={candidateBusy} onClick={()=>chooseMessages(earlier)}>更早消息</button>}{candidates.map(message=><label aria-label={authorName(message)} className="chat-report-pick" key={message.messageId}><input type="checkbox" disabled={busy||draft.selections.length>=selectionLimit&&!draft.selections.some(item=>item.messageId===message.messageId)} checked={draft.selections.some(item=>item.messageId===message.messageId)} onChange={event=>selectMessage(message,event.target.checked)}/><span><strong>{authorName(message)}</strong><time>{time(message.sentAt)}</time><span>{message.text||'附件消息'}</span></span></label>)}</section>}
   </section>{draftError&&<ReadFailure message={draftError}/>}<div className="button-row"><Button type="submit" disabled={busy||!ready||!available||!!pendingHere.length||!draft.summary.trim()||!reportId&&!source||!selectedValid||draft.selections.length>0&&(!source||sourceBusy)}>{busy?'正在提交…':reportId?'提交说明':'提交举报'}</Button>{reportId&&<Button variant="ghost" type="button" disabled={busy} onClick={()=>change({action:'',summary:'',selections:[]})}>返回处理记录</Button>}</div>
  </form>}
  {(roomId||reportId)&&<p><a href="/app/governance?accountChat=1" className="text-link" onClick={event=>{event.preventDefault();navigate('/app/governance?accountChat=1');}}>我的私聊举报</a></p>}
 </section>;
}
