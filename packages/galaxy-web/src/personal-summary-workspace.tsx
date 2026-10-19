import { ReadingDetails, ReadingSummary, ReadingSurface } from './reading-details';
import React,{useEffect,useEffectEvent,useId,useLayoutEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/textarea';
import {getSummaryRuntime} from './summary-runtime.mjs';
import {summaryContentSchema} from '../../galaxy-official/src/shared/personal-summary-schema.mjs';
import {PageLoading} from './site-shell';
import {useChoiceViewLease} from './choice-retained-operations';
import './profile-settings.css';
import './history-fact-people.css';
import {emptySummary as empty,summaryRefKey as refKey,summaryError as label,summaryDraftCleanupNotice,readSummaryIndex,summaryVersionReadable,readSummaryUnavailableSources,filterSummarySources} from './personal-summary-workspace-state';
import type {SummaryRuntime,SummaryRoom,SummaryMessage,SummaryLocation,SummaryBridge,SummaryStatus,SummaryIndex,SummaryLocalRecord,SummaryContent,SummaryShare,SummaryPending,SummaryPrevious,SummaryCloud,SummaryCloudVersion,SummaryRef,SummaryDraft} from './personal-summary-workspace-state';
import type {SummaryUnavailableSource} from './personal-summary-workspace-state';
type Props={runtime:SummaryRuntime|null;room?:SummaryRoom;subjectId?:string;connected:boolean;navigate:(path:string)=>void;messages?:SummaryMessage[];selectedSharedId?:string;onLocate?:(source:SummaryLocation)=>void};
type SessionProps=Omit<Props,'runtime'|'subjectId'>&{runtime:SummaryRuntime;subjectId:string};
type NotebookProps=SessionProps&{chosen:Pick<SummaryIndex,'summaryId'|'roomId'|'endpoint'>|null;setChosen:React.Dispatch<React.SetStateAction<Pick<SummaryIndex,'summaryId'|'roomId'|'endpoint'>|null>>};
export function PersonalSummaryWorkspace(props:Props){
 const scope=useChoiceViewLease(props.runtime,props.subjectId);
 if(!props.subjectId||!props.runtime)return <section className="summary-workspace"><h1 className="small">交流笔记</h1><p>使用自己的身份，保留对你有用的交流重点。</p><Button onClick={()=>props.navigate('/app/settings/identity')}>继续使用</Button></section>;
 return <PersonalSummarySession key={scope.key+':'+props.connected} {...props} runtime={props.runtime} subjectId={props.subjectId}/>;
}
function PersonalSummarySession(props:SessionProps){
 const [chosen,setChosen]=useState<Pick<SummaryIndex,'summaryId'|'roomId'|'endpoint'>|null>(null);
 const selection=props.room??chosen;
 return <PersonalSummaryNotebook key={JSON.stringify([selection?.roomId,chosen?.summaryId,selection?.endpoint,props.selectedSharedId])} {...props} chosen={chosen} setChosen={setChosen}/>;
}
function PersonalSummaryNotebook({runtime,room,subjectId,connected,navigate,messages=[],selectedSharedId,onLocate,chosen,setChosen}:NotebookProps){
 const [bridge,setBridge]=useState<SummaryBridge|null>(null),[status,setStatus]=useState<SummaryStatus|null>(null),[index,setIndex]=useState<SummaryIndex[]>([]),[record,setRecord]=useState<SummaryLocalRecord|null>(null);
 const [summaryId,setSummaryId]=useState(''),[content,setContent]=useState<SummaryContent>(empty),[note,setNote]=useState('');
 const [dirty,setDirty]=useState(false),[editorRevision,setEditorRevision]=useState(0),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [shares,setShares]=useState<SummaryShare[]>([]),[shareNext,setShareNext]=useState<string|null>(null),[pending,setPending]=useState<SummaryPending|null>(null);
 const [pendingReason,setPendingReason]=useState(''),[previous,setPrevious]=useState<SummaryPrevious[]|null>(null);
 const [fragments,setFragments]=useState<string[]>([]),[keys,setKeys]=useState<string[]>([]),[confirm,setConfirm]=useState<string|null>(null);
 const [includeExisting,setIncludeExisting]=useState(true),[scope,setScope]=useState('all'),[importText,setImportText]=useState('');
 const [editing,setEditing]=useState(false),[summaryTab,setSummaryTab]=useState(selectedSharedId?'shared':'personal');
 const [settingsOpen,setSettingsOpen]=useState(false),[shareOpen,setShareOpen]=useState(false),[importOpen,setImportOpen]=useState(false);
 const [cloudNotes,setCloudNotes]=useState<SummaryCloud[]|null>(null),[cloudNext,setCloudNext]=useState<string|null>(null),[draftBlocked,setDraftBlocked]=useState(false),[readRevision,setReadRevision]=useState(0),[draftConflict,setDraftConflict]=useState(false);
 const [unavailableSources,setUnavailableSources]=useState<SummaryUnavailableSource[]>([]);
 const sharesRef=useRef<SummaryShare[]>([]),shareCursor=useRef<string|null>(null),sharesExpanded=useRef(false);
 const epoch=useRef(0),working=useRef(false),editVersion=useRef(0),contentVersion=useRef(0),dirtyRef=useRef(false),blockedRef=useRef(false),contentRef=useRef(content),loadedDraft=useRef('');
 const sourceReadPending=useRef<{head:string|null;contentVersion:number}|null>(null);
 const draftHead=useRef<string|null>(null),draftQueue=useRef<Promise<unknown>>(Promise.resolve()),draftStopped=useRef(false),savingDraft=useRef(false);
 const activeRoom=room??chosen,roomId=activeRoom?.roomId,fieldId=useId();
 useLayoutEffect(()=>{sharesRef.current=shares;shareCursor.current=shareNext;dirtyRef.current=dirty;blockedRef.current=draftBlocked;contentRef.current=content;});
 useEffect(()=>{const current=epoch;return()=>{current.current++;};},[]);
 function currentBridge(){if(!bridge)throw Error('笔记正在读取，请稍后再试。');return bridge;}
 function editContent(value:SummaryContent){editVersion.current++;contentVersion.current++;setContent(value);setDirty(true);}
 function editNote(value:string){editVersion.current++;setNote(value);setDirty(true);}
 async function readCurrentShares(b:SummaryBridge){
  if(!roomId)return {items:[],nextAfter:null};
  const page=await b.shared.list({roomId}),known=new Set(page.items.map(value=>value.shareId)),ids=[...new Set([...sharesRef.current.map(value=>value.shareId),...(selectedSharedId?[selectedSharedId]:[])])].filter(id=>!known.has(id));
  const older=await Promise.allSettled(ids.map(shareId=>b.shared.get({roomId,shareId})));
  return {...page,items:[...page.items,...older.flatMap(result=>result.status==='fulfilled'?[result.value]:[])],nextAfter:sharesExpanded.current?shareCursor.current:page.nextAfter};
 }
 async function refresh(b=bridge,id=summaryId){
  if(!b)return;const lease=epoch.current;
  const [s,items,r]=await Promise.all([b.local.status(),readSummaryIndex(b),id?b.local.get({summaryId:id}):null]);if(lease!==epoch.current)return;
  setStatus(s);setIndex(items);setRecord(r);if(r&&!dirtyRef.current&&!blockedRef.current){setContent(r.content);setEditorRevision(r.localRevision);}
  if(roomId&&(dirtyRef.current||sourceReadPending.current)){
   const guard=runtime.receiptStatus.captureLease(),waiting=sourceReadPending.current;
   if(waiting){const draft=await b.readDraft(roomId);guard.assertCurrent();if(lease!==epoch.current)return;
    if(draft?.summaryId!==id||(draft.draftRevision??null)!==waiting.head){draftStopped.current=true;setDraftConflict(true);setError(label(Error('summary_draft_conflict')));}
    else if(contentVersion.current===waiting.contentVersion){setContent(draft.content);setDraftBlocked(draft.sourcesTemporarilyUnavailable===true);setUnavailableSources([]);if(!draft.sourcesTemporarilyUnavailable)sourceReadPending.current=null;}
   }else{const sources=await readSummaryUnavailableSources(b,roomId,contentRef.current);guard.assertCurrent();if(lease!==epoch.current)return;setUnavailableSources(sources);setContent(current=>filterSummarySources(current,sources,true));setDraftBlocked(sources.some(source=>source.temporary));}
  }
  if(roomId&&connected&&(!activeRoom?.endpoint||activeRoom.endpoint===runtime.api.endpoint)){
   const results=await Promise.allSettled([readCurrentShares(b),b.pending(roomId)]);if(lease!==epoch.current)return;
   if(results[1].status==='fulfilled'){
    const original=results[1].value;setPending(original);
    if(original){try{const resumed=await b.resumePending(roomId);if(lease!==epoch.current)return;setPendingReason(resumed?.reason??'');const currentPending=await b.pending(roomId);if(lease!==epoch.current)return;setPending(currentPending);if(!currentPending){const page=await readCurrentShares(b);if(lease===epoch.current){setShares(page.items);setShareNext(page.nextAfter);}return;}}catch(error){if(lease===epoch.current)setError(label(error));}}
   }else setError(label(results[1].reason));
   if(results[0].status==='fulfilled'){setShares(results[0].value.items);setShareNext(results[0].value.nextAfter);}else {setShares([]);setShareNext(null);setError(label(results[0].reason));}
  }
 }
 async function run(fn:()=>Promise<unknown>,refreshAfter=true){
  if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');const lease=epoch.current;
  try{await fn();if(refreshAfter&&lease===epoch.current)await refresh();}catch(e){if(lease===epoch.current)setError(label(e));}
  finally{if(lease===epoch.current){if(bridge&&roomId)try{const value=await bridge.pending(roomId);if(lease===epoch.current)setPending(value);}catch{}if(lease===epoch.current){setBusy(false);working.current=false;}}}
 }
 useEffect(()=>{
  let alive=true;const token=epoch.current;
  getSummaryRuntime(runtime,subjectId).then(async(b:SummaryBridge)=>{const [s,items]=await Promise.all([b.local.status(),readSummaryIndex(b)]);if(!alive||token!==epoch.current)return;setBridge(b);setStatus(s);setIndex(items);setError('');}).catch((e:unknown)=>{if(alive&&token===epoch.current)setError(label(e));});
  return()=>{alive=false;};
 },[runtime,subjectId,readRevision]);
 const acceptOpened=useEffectEvent(async(b:SummaryBridge,token:number,id:string,r:SummaryLocalRecord|null,draft:SummaryDraft|null)=>{
  if(!roomId||token!==epoch.current)return;
  draftHead.current=draft?.draftRevision??null;
  if(draft&&draft.summaryId!==id){draftStopped.current=true;setDraftConflict(true);}
  setSummaryId(id);setRecord(r);const useDraft=draft?.summaryId===id;setEditorRevision(useDraft?draft.baseRevision:r?.localRevision??0);setDraftBlocked(!!useDraft&&draft.sourcesTemporarilyUnavailable===true);
  sourceReadPending.current=useDraft&&draft.sourcesTemporarilyUnavailable?{head:draftHead.current,contentVersion:contentVersion.current}:null;
  setContent(useDraft?draft.content:r?.content??empty());setNote(useDraft?draft.note??'':'');setDirty(!!(useDraft&&draft.dirty));setEditing(!!(useDraft&&draft.dirty)||!r);loadedDraft.current=roomId+':'+id;setLoaded(true);setError(draft&&draft.summaryId!==id?'这段对话还有另一份未保存输入。先保存本页副本或读取原输入，原草稿仍保留。':useDraft&&draft.baseRevision!==(r?.localRevision??0)?'已有较新的笔记版本。原草稿仍保留，可以对照后继续编辑。':'');
  if(connected&&(!activeRoom?.endpoint||activeRoom.endpoint===runtime.api.endpoint)){
   const result=await Promise.allSettled([readCurrentShares(b),b.pending(roomId)]);if(token!==epoch.current)return;
   if(result[1].status==='fulfilled')setPending(result[1].value);else setError(label(result[1].reason));
   if(result[0].status==='fulfilled'){setShares(result[0].value.items);setShareNext(result[0].value.nextAfter);}else setError(label(result[0].reason));
  }
 });
 useEffect(()=>{if(!bridge||!roomId)return;let alive=true;const token=epoch.current;
  const id=chosen?.summaryId,opened=id?Promise.resolve(id):bridge.summaryIdForRoom(roomId);
  opened.then(async summaryId=>{const [record,draft]=await Promise.all([bridge.local.get({summaryId}),bridge.readDraft(roomId)]);return {summaryId,record,draft};})
   .then(value=>{if(alive&&token===epoch.current)return acceptOpened(bridge,token,value.summaryId,value.record,value.draft);})
   .catch((e:unknown)=>{if(alive&&token===epoch.current)setError(label(e));});return()=>{alive=false;};
 },[bridge,roomId,chosen?.summaryId]);
 const refreshCurrent=useEffectEvent(refresh);
 useEffect(()=>{
  if(!bridge||!connected)return;let alive=true;
  bridge.local.onBinding().then(()=>{if(alive)return refreshCurrent();}).catch((e:unknown)=>{if(alive)setError(label(e));});
  const timer=setInterval(()=>{if(alive&&!working.current&&!document.hidden)bridge.local.synchronize().then(()=>{if(alive)return refreshCurrent();}).catch((e:unknown)=>{if(alive)setError(label(e));});},15000);
  return()=>{alive=false;clearInterval(timer);};
 },[bridge,connected,roomId,summaryId]);
 function persistDraft(value:SummaryDraft|null){
  if(!roomId)return Promise.reject(Error('笔记位置暂时不可用。'));const b=currentBridge(),token=epoch.current;
  const task=draftQueue.current.then(async()=>{if(token!==epoch.current)throw Error('summary_binding_changed');if(draftStopped.current)throw Error('summary_draft_conflict');const saved=await b.saveDraft(roomId,value,{expectedRevision:draftHead.current});if(token===epoch.current)draftHead.current=saved?.draftRevision??null;return saved;});
  draftQueue.current=task.catch(()=>{});
  return task.catch((e:unknown)=>{if(token===epoch.current){draftStopped.current=true;setDraftConflict(true);setError(label(e));}throw e;});
 }
 const persistCurrent=useEffectEvent(()=>{if(bridge&&loaded&&roomId&&summaryId&&loadedDraft.current===roomId+':'+summaryId&&!draftBlocked&&!draftConflict&&!savingDraft.current)void persistDraft({summaryId,baseRevision:editorRevision,content,note,dirty}).catch(()=>{});});
 useEffect(()=>{persistCurrent();},[bridge,loaded,roomId,summaryId,content,note,dirty,editorRevision,draftBlocked,draftConflict,busy]);
 useEffect(()=>{
  if(!bridge||!connected||!roomId||!selectedSharedId)return;let alive=true;
  bridge.shared.get({roomId,shareId:selectedSharedId}).then(s=>{if(alive)setShares(old=>[s,...old.filter(v=>v.shareId!==s.shareId)]);}).catch((e:unknown)=>{if(alive)setError(label(e));});return()=>{alive=false;};
 },[bridge,connected,roomId,selectedSharedId]);
 async function locate(ref:SummaryRef){if(!roomId)return;const s=await currentBridge().sourceCheck({roomId,...ref});if(!s.available)throw Error('这条原消息当前不可用。');if(onLocate)onLocate({...ref,...s});else navigate('/app/rooms/'+roomId);}
 async function save(){
  if(!roomId)return;const b=currentBridge(),lease=epoch.current,inputRevision=editVersion.current;
  const nextContent=note.trim()?{...content,fragments:[...content.fragments,{id:crypto.randomUUID(),kind:'personal-note',text:note.trim(),sourceRefs:[]}]}:content;
  savingDraft.current=true;
  try{
   const originalDraft=await persistDraft({summaryId,baseRevision:editorRevision,content,note,dirty});if(lease!==epoch.current)return;
   const saved=await b.local.save({summaryId,roomId,endpoint:record?.endpoint??activeRoom?.endpoint??runtime.api.endpoint,expectedLocalRevision:editorRevision,content:summaryContentSchema.parse(nextContent)});if(lease!==epoch.current)return;
   setRecord(saved);
   if(inputRevision===editVersion.current){
    await draftQueue.current;
    try{await b.saveDraft(roomId,null,{expectedRevision:originalDraft?.draftRevision??null});}catch(e){if(lease===epoch.current){draftStopped.current=true;setDraftConflict(true);setNotice(summaryDraftCleanupNotice(e));}throw e;}
    if(lease!==epoch.current)return;draftHead.current=null;
    if(inputRevision===editVersion.current){setContent(saved.content);setNote('');setDirty(false);setEditing(false);}
   }
   setEditorRevision(saved.localRevision);
   setNotice(inputRevision===editVersion.current?'笔记已保存。':'原笔记已保存，后来输入的内容仍在草稿中。');
  }finally{savingDraft.current=false;}
 }
 async function reloadEditor(){if(!roomId)return;const b=currentBridge(),lease=epoch.current,inputRevision=editVersion.current;await draftQueue.current;const r=await b.local.get({summaryId});if(lease!==epoch.current||inputRevision!==editVersion.current)return;await b.saveDraft(roomId,null,{expectedRevision:draftHead.current});if(lease!==epoch.current)return;draftHead.current=null;draftStopped.current=false;setDraftConflict(false);if(inputRevision!==editVersion.current)throw Error('读取期间你又输入了内容，本页输入仍保留。');sourceReadPending.current=null;setRecord(r);setEditorRevision(r?.localRevision??0);setContent(r?.content??empty());setNote('');setDirty(false);setDraftBlocked(false);setUnavailableSources([]);}
 async function readSavedInput(){if(!roomId)return;const b=currentBridge(),token=epoch.current,inputRevision=editVersion.current;await draftQueue.current;const draft=await b.readDraft(roomId);if(token!==epoch.current)return;if(inputRevision!==editVersion.current)throw Error('读取期间你又输入了内容，本页输入仍保留。');draftHead.current=draft?.draftRevision??null;draftStopped.current=false;setDraftConflict(false);setDraftBlocked(draft?.sourcesTemporarilyUnavailable===true);setUnavailableSources([]);if(draft&&draft.summaryId!==summaryId){setChosen({summaryId:draft.summaryId,roomId,endpoint:runtime.api.endpoint});return;}if(draft&&draft.summaryId===summaryId){editVersion.current++;contentVersion.current++;sourceReadPending.current=draft.sourcesTemporarilyUnavailable?{head:draftHead.current,contentVersion:contentVersion.current}:null;setContent(draft.content);setNote(draft.note);setEditorRevision(draft.baseRevision);setDirty(draft.dirty);setEditing(true);}else await reloadEditor();setError('');}
 async function saveInputCopy(){if(!roomId)return;const b=currentBridge(),lease=epoch.current,guard=runtime.receiptStatus.captureLease(),input={summaryId,baseRevision:editorRevision,content,note,dirty},sources=await readSummaryUnavailableSources(b,roomId,input.content);guard.assertCurrent();if(lease!==epoch.current)return;const readable=filterSummarySources(input.content,sources),url=URL.createObjectURL(new Blob([JSON.stringify({...input,content:readable},null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='galaxy-private-note-input.json';link.click();URL.revokeObjectURL(url);setNotice(sources.length?'本页输入副本已保存，未包含当前不可读的来源片段。':'本页输入副本已保存。');}
 function toggleSettings(){if(!settingsOpen&&status){setIncludeExisting(status.preference.includeExisting!==false);setScope(status.preference.roomIds?(status.preference.roomIds.length===1&&status.preference.roomIds[0]===roomId?'room':'existing'):'all');}setSettingsOpen(value=>!value);}
 if(!bridge||!status)return <section className="summary-workspace"><h2>交流笔记</h2>{error?<div className="message error" role="alert"><p>{error}</p><Button onClick={()=>setReadRevision(value=>value+1)}>重试读取</Button></div>:<PageLoading label="正在打开笔记…"/>}</section>;
 const sourceBlocked=record?.sourceState==='unverified-offline'||draftBlocked;
 const visibleContent=filterSummarySources(content,unavailableSources);
 return <section className="summary-workspace purpose-summary" aria-busy={busy}>
  <header className="profile-heading"><div><h2>{room?'对话笔记':'交流笔记'}</h2><p>记下重点，需要时回到原文。</p></div>{status&&<Button variant="ghost" onClick={toggleSettings}>{settingsOpen?'返回笔记':'同步设置'}</Button>}</header>
  {error&&<div className="message error" role="alert">{error}</div>}{(draftConflict||draftBlocked)&&<div className="summary-draft-conflict button-row"><Button variant="outline" disabled={busy} onClick={()=>void run(saveInputCopy,false)}>保存本页输入副本</Button><Button variant="ghost" disabled={busy} onClick={()=>void run(readSavedInput,false)}>读取已保存输入</Button></div>}{notice&&<output className="privacy-notice">{notice}</output>}
  {!status&&!error&&<PageLoading label="正在打开笔记…"/>}
  {settingsOpen&&status?<section className="summary-sync-settings"><h3>在自己的设备间同步</h3><p>所选笔记会保存到当前服务的本人私有空间，不分享给对话成员。</p><fieldset><legend>包括哪些笔记</legend><label><input type="checkbox" checked={includeExisting} onChange={event=>setIncludeExisting(event.target.checked)}/>包括已有笔记</label><label>同步范围<select value={scope} onChange={event=>setScope(event.target.value)}><option value="all">我的全部对话笔记</option>{status.preference.roomIds&&<option value="existing">保留已选对话范围</option>}{roomId&&<option value="room">仅当前对话</option>}</select></label></fieldset><div className="button-row"><Button disabled={busy||!bridge} onClick={()=>run(async()=>{if(scope==='room'&&!roomId)throw Error('当前对话位置暂时不可用。');await bridge.local.choose({enabled:true,endpoint:runtime.api.endpoint,roomIds:scope==='room'&&roomId?[roomId]:scope==='existing'?status.preference.roomIds:null,includeExisting},{confirmed:true});if(connected)await bridge.local.synchronize({force:true});setNotice(connected?'已保存同步设置。':'已保存选择，连接后会继续同步。');})}>{['enabled','enabled-pending-binding'].includes(status.preference.state)?'保存同步范围':'开启私有同步'}</Button>{['enabled','enabled-pending-binding'].includes(status.preference.state)&&<Button variant="outline" disabled={busy||!bridge} onClick={()=>run(async()=>{await bridge.local.choose({enabled:false},{confirmed:true});if(connected)await bridge.local.synchronize({force:true});setNotice('已停止新上传。');})}>停止新上传</Button>}</div><p className="privacy-footnote">已有云副本在最后有效更新后 30 天到期，也可以单独删除。网页关闭后不会继续同步。</p>{connected&&status.preference.endpoint===runtime.api.endpoint&&<section className="summary-cloud-notes"><Button variant="outline" disabled={busy} onClick={()=>run(async()=>{const lease=epoch.current,page=await bridge.client.list({limit:20});if(lease===epoch.current){setCloudNotes(page.items);setCloudNext(page.nextAfter);}},false)}>找回其他设备的笔记</Button>{cloudNotes&&<><h4>已同步的笔记</h4>{!cloudNotes.length&&<p>当前没有可取回的云副本。</p>}{cloudNotes.map(item=><article key={item.summaryId}><p>{item.current?.content?.fragments?.[0]?.text??'这份笔记目前没有可读内容。'}</p>{item.current?.updatedAt&&<time>{new Date(item.current.updatedAt).toLocaleDateString()}</time>}<Button variant="ghost" disabled={busy||!item.current?.content||item.current?.sourcesTemporarilyUnavailable} onClick={()=>run(async()=>{const lease=epoch.current;if(!item.roomId)throw Error('这份笔记的对话位置暂时不可用。');await bridge.local.pull({summaryId:item.summaryId});if(lease!==epoch.current)return;setChosen({summaryId:item.summaryId,roomId:item.roomId,endpoint:runtime.api.endpoint});setSettingsOpen(false);setNotice('已打开这份笔记。');})}>打开这份笔记</Button></article>)}{cloudNext&&<Button variant="outline" disabled={busy} onClick={()=>run(async()=>{const lease=epoch.current,page=await bridge.client.list({after:cloudNext,limit:20});if(lease===epoch.current){setCloudNotes(old=>[...(old??[]),...page.items]);setCloudNext(page.nextAfter);}},false)}>更多笔记</Button>}</>}</section>}{roomId&&connected&&<ReadingDetails className="summary-share-history" onOpenChange={isOpen=>{if(isOpen&&!previous)void run(async()=>{const lease=epoch.current,items=await bridge.previousShares(roomId),values=await Promise.all(items.map(async(item)=>{try{const result=await bridge.reconcilePrevious(roomId,item.shareId);return {...item,receiptState:result.state};}catch{return item;}}));if(lease===epoch.current)setPrevious(values);},false);}}><ReadingSummary>这段对话的过往分享记录</ReadingSummary>{previous&&!previous.length&&<p>本机没有需要单独保留的旧分享。</p>}{previous?.map(item=><article key={item.shareId}><p>{({published:'当时已分享',retracted:'已撤回',expired:'已到期',absent:'未查到原分享',pending:'尚未完成'} as Record<string,string>)[item.receiptState??'']??'原分享的结果尚未确认'}</p><small>原分享编号 {item.shareId}</small></article>)}</ReadingDetails>}{record&&record.cloudRevision>0&&record.syncState!=='cloud-deleted'&&connected&&status.preference.endpoint===runtime.api.endpoint&&<Button variant="ghost" disabled={busy||record.endpoint!==runtime.api.endpoint} onClick={()=>setConfirm('delete-cloud')}>删除这份笔记的云副本</Button>}</section>:<>
  {!room&&!chosen&&<><ul className="summary-library">{index.map(item=><li key={item.summaryId}><button type="button" aria-label={'阅读笔记：'+(item.excerpt||'我的交流笔记')} onClick={()=>setChosen(item)}><div><h3>{item.excerpt||'我的交流笔记'}</h3><p>{new Date(item.updatedAt*1000).toLocaleDateString()}{item.syncState==='conflict'?' · 有不同设备的版本':item.syncState==='sources-changed'?' · 部分原文已变化':''}</p></div><span aria-hidden="true"></span></button></li>)}</ul>{status&&!index.length&&<div className="personal-empty"><h3>还没有交流笔记</h3><p>在对话中记下重点，也可以使用自己模型整理的内容。</p><Button variant="outline" onClick={()=>navigate('/app/rooms')}>去看看对话</Button></div>}</>}
  {!room&&chosen&&<button type="button" className="history-back" onClick={()=>setChosen(null)}> 返回全部笔记</button>}
  {roomId&&!loaded&&!error&&<PageLoading label="正在打开这份笔记…"/>}
  {roomId&&loaded&&<><nav className="history-fact-tabs" aria-label="笔记内容"><button type="button" aria-pressed={summaryTab==='personal'} onClick={()=>setSummaryTab('personal')}>我的笔记{dirty?' · 草稿':''}</button><button type="button" aria-pressed={summaryTab==='shared'} onClick={()=>setSummaryTab('shared')}>成员分享</button></nav>
   {summaryTab==='personal'?<>
    {sourceBlocked&&<p className="message">部分原文暂时不可读，相应片段先收起。你的原版本仍保留。</p>}
    {!editing?<><div className="summary-reading">{visibleContent.fragments.length?visibleContent.fragments.map((fragment)=><article key={fragment.id}><p>{fragment.text}</p>{fragment.sourceRefs.map((reference)=><Button key={refKey(reference)} variant="link" disabled={!connected||busy} onClick={()=>run(()=>locate(reference))}>回到原文</Button>)}</article>):<p className="muted">记下这次交流里对你有用的内容。</p>}</div><div className="button-row"><Button disabled={busy||sourceBlocked} onClick={()=>setEditing(true)}>{content.fragments.length?'编辑笔记':'开始记录'}</Button><Button variant="ghost" disabled={!connected} onClick={()=>navigate('/app/rooms/'+roomId)}>返回对话</Button>{record&&room&&<Button variant="outline" onClick={()=>setShareOpen(value=>!value)}>选择内容分享</Button>}</div></>:<form className="summary-editor" onSubmit={event=>{event.preventDefault();void run(save);}}>
     {visibleContent.fragments.map((fragment,index)=><div key={fragment.id}><label htmlFor={fieldId+'-fragment-'+fragment.id}>笔记 {index+1}<Textarea id={fieldId+'-fragment-'+fragment.id} maxLength={8000} value={fragment.text} disabled={sourceBlocked} onChange={event=>{editContent({...content,fragments:content.fragments.map((value)=>value.id===fragment.id?{...value,text:event.target.value}:value)});}}/></label><div className="button-row">{fragment.sourceRefs.map((reference)=><Button key={refKey(reference)} type="button" variant="ghost" disabled={!connected||busy} onClick={()=>run(()=>locate(reference))}>回到原文</Button>)}<Button type="button" variant="ghost" disabled={sourceBlocked} onClick={()=>{editContent({...content,fragments:content.fragments.filter((value)=>value.id!==fragment.id)});}}>移除这一段</Button></div></div>)}
     <label htmlFor={fieldId+'-note'}>再记一点<Textarea id={fieldId+'-note'} value={note} maxLength={8000} onChange={event=>{editNote(event.target.value);}} placeholder="记下与你有关的重点…"/></label>
     {!!messages.length&&<ReadingDetails mode="inline" className="summary-key-messages"><ReadingSummary>把消息标为重点</ReadingSummary>{messages.filter(message=>message.state==='accepted'&&!message.sharedSummaryId).map(message=><label key={message.messageId}><input type="checkbox" checked={content.keyMessageRefs.some((reference)=>reference.messageId===message.messageId&&reference.revision===message.revision)} disabled={sourceBlocked} onChange={event=>{editContent({...content,coverage:{...content.coverage,throughSequence:BigInt(message.sequence)>BigInt(content.coverage.throughSequence)?message.sequence:content.coverage.throughSequence,complete:false},keyMessageRefs:event.target.checked?[...content.keyMessageRefs,{messageId:message.messageId,revision:message.revision}]:content.keyMessageRefs.filter((reference)=>reference.messageId!==message.messageId)});}}/><span>{String(message.text).slice(0,160)}</span></label>)}</ReadingDetails>}
     <div className="button-row"><Button type="submit" disabled={busy||sourceBlocked||!bridge||(!content.fragments.length&&!content.keyMessageRefs.length&&!note.trim())}>保存笔记</Button><Button type="button" variant="ghost" onClick={()=>setEditing(false)}>稍后继续</Button></div>
    </form>}
    {!!visibleContent.keyMessageRefs.length&&<section className="summary-key-list"><h3>重点消息</h3>{visibleContent.keyMessageRefs.map((reference,index)=><div key={refKey(reference)}><Button variant="link" disabled={!connected||busy} onClick={()=>run(()=>locate(reference))}>{messages.find(message=>message.messageId===reference.messageId)?.text?.slice(0,110)??'查看第 '+(index+1)+' 条重点消息'}</Button>{editing&&<Button variant="ghost" onClick={()=>{editContent({...content,keyMessageRefs:content.keyMessageRefs.filter((value)=>refKey(value)!==refKey(reference))});}}>移出重点</Button>}</div>)}</section>}
    <section className="summary-model-import"><button type="button" aria-haspopup="dialog" onClick={()=>setImportOpen(true)}>导入自己的模型整理</button>{importOpen&&<ReadingSurface open title="导入模型整理" onClose={()=>setImportOpen(false)}><p>选择自己的模型按银河格式生成的笔记文件，先在本机查看和编辑。</p><label>选择笔记文件<input type="file" accept=".json,application/json" disabled={busy} onChange={event=>{const file=event.target.files?.[0];if(file)void run(async()=>{if(file.size>65536)throw Error('笔记文件过大。');const parsed=summaryContentSchema.parse(JSON.parse(await file.text()));editContent(parsed);setEditing(true);setImportOpen(false);setNotice('已打开模型整理，可检查后保存。');});event.target.value='';}}/></label><ReadingDetails mode="inline"><ReadingSummary>粘贴已有结构化内容</ReadingSummary><Textarea aria-label="模型生成的笔记内容" maxLength={65536} value={importText} onChange={event=>setImportText(event.target.value)}/><Button variant="outline" disabled={!importText.trim()} onClick={()=>run(async()=>{editContent(summaryContentSchema.parse(JSON.parse(importText)));setEditing(true);setImportText('');setImportOpen(false);})}>打开供我检查</Button></ReadingDetails></ReadingSurface>}</section>
    {record&&record.conflicts.length>0&&<section className="summary-conflicts"><h3>不同设备留下了不同版本</h3><p>可以采用一份，或在编辑区合并。现有内容会保留到你作出选择。</p><Button variant="outline" disabled={busy||sourceBlocked||dirty} onClick={()=>run(async()=>{await bridge.local.resolve({summaryId,expectedLocalRevision:record.localRevision,content},{confirmed:true});await reloadEditor();setNotice('已采用当前编辑内容。');})}>采用当前编辑内容</Button>{[record.remoteCurrent,...record.conflicts].filter((version):version is SummaryCloudVersion=>!!version).map((version)=><article key={version.versionId}>{(version.content?.fragments??[]).map((fragment)=><p key={fragment.id}>{fragment.text}</p>)}<Button variant="outline" disabled={busy||sourceBlocked||!summaryVersionReadable(version.content)} onClick={()=>run(async()=>{if(!summaryVersionReadable(version.content))throw Error('这份版本当前没有可采用的正文。');await bridge.local.resolve({summaryId,expectedLocalRevision:record.localRevision,content:version.content},{confirmed:true});await reloadEditor();setNotice('已采用这份版本。');})}>采用这个版本</Button></article>)}</section>}
    {record&&room&&shareOpen&&<section className="summary-share"><h3>分享哪些笔记</h3><p>分享给此对话的成员，按当前 {room.retentionDays} 天的规则保留。</p>{record.content.fragments.map((fragment)=><label key={fragment.id}><input type="checkbox" checked={fragments.includes(fragment.id)} onChange={event=>setFragments(event.target.checked?[...fragments,fragment.id]:fragments.filter(id=>id!==fragment.id))}/><span>{fragment.text}</span></label>)}{record.content.keyMessageRefs.map((reference,index)=><label key={refKey(reference)}><input type="checkbox" checked={keys.includes(refKey(reference))} onChange={event=>setKeys(event.target.checked?[...keys,refKey(reference)]:keys.filter(id=>id!==refKey(reference)))}/><span>重点消息 {index+1}</span><Button variant="link" onClick={()=>run(()=>locate(reference))}>原文</Button></label>)}<Button disabled={busy||dirty||!connected||sourceBlocked||!!pending&&!pending.canStartNewSelection||(!fragments.length&&!keys.length)} onClick={()=>run(async()=>{const result=await bridge.share({summaryId,expectedLocalRevision:record.localRevision,fragmentIds:fragments,keyMessageRefs:record.content.keyMessageRefs.filter((reference)=>keys.includes(refKey(reference))),room});setNotice(result.state==='published'?'已分享给这段对话。':'正在发送分享内容。');setFragments([]);setKeys([]);setShareOpen(false);})}>分享选中的内容</Button><Button variant="ghost" onClick={()=>setShareOpen(false)}>取消</Button>{dirty&&<p className="muted">先保存当前编辑，再选择要分享的内容。</p>}</section>}
    {pending&&<div className="summary-pending"><p>{({'stopped-local':'已停止继续发送，原分享的结果还在核对。','authorization-expired':'原分享已超过当时选择的期限，没有再次发出。','original-retention-unavailable':'这份旧分享的原保留期限无法确认，没有再次发出。','original-retention-changed':'对话的保留期限已改变，原分享没有再次发出。'} as Record<string,string>)[pendingReason]??'正在接续上次分享，确认后会自动更新。'}</p>{pending.phase!=='stopped-local'&&<Button variant="ghost" disabled={!connected||busy} onClick={()=>setConfirm('cancel-share')}>撤回分享</Button>}</div>}
   </>:<section className="summary-shared">{!connected?<p>连接后查看成员分享的笔记。</p>:!shares.length?<p className="history-empty">还没有人分享笔记。</p>:shares.map(shared=><article key={shared.shareId}><header><h3>{shared.authorId===subjectId?'我分享的笔记':'成员的笔记'}</h3><time>{new Date(shared.createdAt).toLocaleDateString()}</time></header>{shared.sourceInvalidated&&<p className="muted">部分原文已变化，相应片段暂时收起。</p>}{(shared.content?.fragments??[]).map((fragment)=><p key={fragment.id}>{fragment.text}</p>)}{(shared.content?.keyMessageRefs??[]).map((reference,index)=><Button key={refKey(reference)} variant="link" onClick={()=>run(()=>locate(reference))}>重点消息 {index+1}</Button>)}{shared.state!=='published'&&<p className="muted">{shared.state==='pending'?'正在发送':shared.state==='expired'?'已到期':'已撤回'}</p>}{shared.authorId===subjectId&&shared.state==='published'&&<Button variant="ghost" disabled={busy} onClick={()=>setConfirm('retract:'+shared.shareId)}>撤回我的分享</Button>}</article>)}{shareNext&&<Button variant="outline" disabled={busy} onClick={()=>run(async()=>{const lease=epoch.current,page=await bridge.shared.list({roomId,after:shareNext});if(lease!==epoch.current)return;sharesExpanded.current=true;setShares(old=>[...old,...page.items].filter((item,index,all)=>all.findIndex(value=>value.shareId===item.shareId)===index));setShareNext(page.nextAfter);},false)}>更早的分享</Button>}</section>}
  </>}
  </>}
  {confirm&&<section className="summary-confirm" aria-label="确认笔记操作"><h3>{confirm==='delete-cloud'?'删除这份云副本？':'撤回这次分享？'}</h3><p>{confirm==='delete-cloud'?'本机笔记和已分享的独立版本保留。':'私人笔记保留，不改动其他人的消息。'}</p><div className="button-row"><Button disabled={busy} onClick={()=>run(async()=>{if(confirm==='delete-cloud')await bridge.local.deleteCloud({summaryId},{confirmed:true});else if(confirm==='cancel-share'){if(!roomId)throw Error('当前对话位置暂时不可用。');const result=await bridge.cancelPending(roomId);setNotice(result?.serverRetractionConfirmed?'已撤回分享。':'已停止继续发送，服务端结果仍待确认。');}else {if(!roomId)throw Error('当前对话位置暂时不可用。');await bridge.shared.retract({roomId,shareId:confirm.slice(8)});}setConfirm(null);})}>{confirm==='delete-cloud'?'删除云副本':'撤回分享'}</Button><Button variant="outline" onClick={()=>setConfirm(null)}>保留</Button></div></section>}
 </section>;
}
