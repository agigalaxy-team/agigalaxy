import { ReadingDetails, ReadingSummary } from './reading-details';
import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {BookOpen,Check,Cloud,Smartphone,X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {createChoiceSyncClient} from './choice-sync-client.mjs';
import {stableJson} from '../../galaxy-official/src/shared/web-primitives.mjs';
import {ChoiceRetainedOperations,useChoiceViewLease,type ChoiceViewLease} from './choice-retained-operations';
import type {ChoiceContent,CloudChoiceContent,CloudChoice,CloudChoiceVersion,ChoicePreference,ChoiceLocalState,ChoiceSyncProps,ChoiceSyncPreview,ChoiceSyncViewClient} from './choice-sync-view-types';
import {recordErrorField} from './record-workspace-types';
import './choice-sync-workspace.css';

type Props=ChoiceSyncProps;
const referenceNames:Record<string,string>={history:'经历',case:'工作',capsule:'方法',task:'求助',opportunity:'招募',proof:'验证材料',worker:'工作节点',hub:'服务'};
const time=(v:string|number|null|undefined)=>v?new Date(v).toLocaleString('zh-CN'):'';
const failure=(e:unknown)=>({choice_sync_not_selected:'这份参考尚未允许保存到其他设备。',choice_source_changed:'来源已更新，请回到查找页面，按当前内容更新这份参考。',choice_source_unavailable:'原来源当前无法读取，暂时不能保存这份参考。',choice_original_source_query_unavailable:'这台设备没有原查询条件，请重新查找并保存当前参考。',choice_preference_conflict:'另一台设备刚修改了保存范围，已重新读取，请再选择一次。',choice_cloud_content_unavailable:'这份副本已到期或无法读取，原本机内容保留。',choice_sync_preview_changed:'这份参考或上次保存的状态已变化，请重新查看后再保存。'} as Record<string,string>)[recordErrorField(e,'code')||recordErrorField(e,'message')]??'暂时未能完成，原本机内容仍保留。';
function References({content}:{content:Pick<CloudChoiceContent,'selectedRefs'|'resultRefs'>|null|undefined}){
 const counts:Record<string,number>={};for(const ref of content?.selectedRefs??[])counts[ref.type]=(counts[ref.type]??0)+1;
 return <div className="choice-reference-summary">{Object.entries(counts).map(([type,count])=><span key={type}>{referenceNames[type]??'参考'} {count}</span>)}{!Object.keys(counts).length&&<span>尚未选定参考</span>}{!!content?.resultRefs?.length&&<span>关联结果 {content.resultRefs.length}</span>}</div>;
}
function saveRecord(value:unknown){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='galaxy-reference.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function ChoiceSyncWorkspace(props:Props){
 const view=useChoiceViewLease(props.runtime,props.subjectId);
 if(!view.lease)return <section className="choice-sync"><h2>跨设备使用</h2><p>选择你的银河身份后，可以在其他设备继续使用自己的参考。</p></section>;
 return <ChoiceSyncView key={view.key} {...props} lease={view.lease}/>;
}
function ChoiceSyncView({runtime,subjectId,connected,localChoices,lease}:Props&{lease:ChoiceViewLease}){
 const ordinaryConnected=connected&&lease.bindingId!==null;
 const client=useMemo<ChoiceSyncViewClient|null>(()=>runtime&&subjectId?createChoiceSyncClient(runtime,{subjectId}):null,[runtime,subjectId]);
 const [preferences,setPreferences]=useState<ChoicePreference|null>(null),[cloud,setCloud]=useState<CloudChoice[]>([]),[after,setAfter]=useState<string|null>(null),[localState,setLocalState]=useState<ChoiceLocalState|null>(null);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[readError,setReadError]=useState('');
 const [preview,setPreview]=useState<ChoiceSyncPreview|null>(null),[deleteTarget,setDeleteTarget]=useState<CloudChoice|null>(null),[resolutions,setResolutions]=useState<Record<string,string[]>>({});
 const dialog=useRef<HTMLDialogElement>(null),deletion=useRef<HTMLDialogElement>(null),epoch=useRef(0),reading=useRef(false),running=useRef(false),cloudPages=useRef(1),refreshRef=useRef<()=>Promise<void>>(async()=>{});
 const valid=(token:number)=>{if(token!==epoch.current)return false;try{lease.assertCurrent();return true;}catch{return false;}};
 async function refresh(){if(!client||reading.current||running.current)return;const token=epoch.current;if(!valid(token))return;reading.current=true;
  try{const readLocal=async()=>{const state=await client.localState();for(const request of Object.values(state.pending??{})){try{await client.reconcileRetained(request.snapshotId,{versionId:request.versionId});}catch{/* The original remains pending; no resend or wider read. */}if(!valid(token))return null;}return client.localState();};
   const readCloud=async()=>{const first=await client.list();let items=first.items,nextAfter=first.nextAfter;for(let page=1;page<cloudPages.current&&nextAfter;page++){const next=await client.list({after:nextAfter});items=[...items,...next.items];nextAfter=next.nextAfter;}return{items,nextAfter};};
   const [local,p,page]=await Promise.allSettled([readLocal(),ordinaryConnected?client.preferences():Promise.resolve(null),ordinaryConnected?readCloud():Promise.resolve(null)]);if(!valid(token))return;
   if(local.status==='fulfilled')setLocalState(local.value);else setLocalState(null);
   if(ordinaryConnected){if(p.status==='fulfilled')setPreferences(p.value);else setPreferences(null);
    if(page.status==='fulfilled'&&page.value){setCloud(page.value.items);setAfter(page.value.nextAfter);}else{setCloud([]);setAfter(null);}
    setReadError(p.status==='rejected'||page.status==='rejected'?'暂时无法读取当前云副本。':'');
   }else{setPreferences(null);setCloud([]);setAfter(null);}
  }finally{reading.current=false;if(valid(token))setLoading(false);}
 }
 useLayoutEffect(()=>{refreshRef.current=refresh;});
 useEffect(()=>{const viewEpoch=epoch,token=++viewEpoch.current;void refreshRef.current();const observe=()=>{if(!document.hidden&&viewEpoch.current===token)void refreshRef.current();};const timer=window.setInterval(observe,20000);document.addEventListener('visibilitychange',observe);return()=>{viewEpoch.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',observe);client?.close();};},[client]);
 useEffect(()=>{if(preview)dialog.current?.showModal();else dialog.current?.close();},[preview]);
 useEffect(()=>{if(deleteTarget)deletion.current?.showModal();else deletion.current?.close();},[deleteTarget]);
 async function run(fn:(c:NonNullable<typeof client>,active:()=>boolean)=>Promise<void>){if(!client||running.current)return;const token=epoch.current,active=()=>valid(token);if(!active())return;running.current=true;setBusy(true);setError('');setNotice('');
  try{await fn(client,active);}catch(e){if(active())setError(failure(e));}finally{running.current=false;if(active()){setBusy(false);void refreshRef.current();}}
 }
 async function openPreview(id:string){await run(async(c,active)=>{const state=await c.localState(),pending=state.pending?.[id],own=await c.localPreview(id);if(active())setPreview({id,content:pending?.content??own,expectedLocalHash:pending?undefined:own.hash,expectedPendingVersionId:pending?.versionId,resolveVersionIds:pending?pending.resolveVersionIds:resolutions[id]??[]});});}
 async function confirmSync(){const selected=preview;if(!selected)return;await run(async(c,active)=>{
  const p=await c.preferences();if(!p.enabled||!p.snapshotIds.includes(selected.id)){const ids=[...new Set([...(p.enabled?p.snapshotIds:[]),selected.id])];await c.savePreference({endpoint:p.endpoint,expectedRevision:p.revision,enabled:true,snapshotIds:ids});}
  const value=await c.sync(selected.id,{resolveVersionIds:selected.resolveVersionIds,expectedLocalHash:selected.expectedLocalHash,expectedPendingVersionId:selected.expectedPendingVersionId});
  if(active()){setPreview(null);setCloud(old=>[value,...old.filter(v=>v.snapshotId!==value.snapshotId)]);setNotice(value.syncState==='conflict'?'两台设备的内容都有变化，两个版本都已保留。':'已保存，可以在你的其他设备继续使用。');}
 });}
 async function stopScope(id:string){await run(async(c,active)=>{const p=await c.preferences(),ids=p.snapshotIds.filter((value:string)=>value!==id);const next=await c.savePreference({endpoint:p.endpoint,expectedRevision:p.revision,enabled:p.enabled&&ids.length>0,snapshotIds:ids});if(active()){setPreferences(next);setNotice('已关闭这份参考的后续保存。已有副本仍保留至到期，可单独删除。');}});}
 const cloudById=new Map(cloud.map(v=>[v.snapshotId,v]));
 const titles=Object.fromEntries([...cloud.map(v=>[v.snapshotId,v.current?.content?.localTaskRef]),...localChoices.map(v=>[v.id,v.versions.at(-1)?.localTaskRef])].filter(v=>v[1]));
 const restored=Object.values(localState?.restored??{});
 const comparedFields=['localTaskRef','visibleRationale','rationaleAuthor','candidateRefs','selectedRefs','resultRefs'] as const satisfies readonly (keyof ChoiceContent)[];
 const sameCopy=(snapshot:CloudChoice)=>{const local=localChoices.find(c=>c.id===snapshot.snapshotId)?.versions.at(-1),content=snapshot.current?.content;return local&&snapshot.current?.state==='current'&&!snapshot.conflicts.length&&content&&content.localVersion===local.version&&comparedFields.every(key=>stableJson(content[key])===stableJson(local[key]));};
 const separateCopies=cloud.filter(snapshot=>!sameCopy(snapshot));
 if(!client)return null;
 return <section className="choice-sync">
  <header className="choice-sync-heading"><Cloud size={27} aria-hidden="true"/><div><h2>跨设备使用</h2><p>把选定的参考与自己的想法，保存在仅你可见的空间。</p></div></header>
  {!ordinaryConnected&&<p className="choice-notice">连接身份后可读取和保存云副本。本机已经下载的内容仍可查看。</p>}
  {error&&<p role="alert" className="message error">{error}</p>}{notice&&<p className="message"><output>{notice}</output></p>}
  {readError&&<p role="alert">{readError}<button className="text-link" disabled={busy} onClick={()=>void refreshRef.current()}>重试</button></p>}
  {loading&&<p className="muted">正在读取你的参考…</p>}
  <section aria-labelledby="choice-local-heading"><div className="section-heading"><h3 id="choice-local-heading">这台设备的参考</h3><Smartphone size={18} aria-hidden="true"/></div>
   {!localChoices.length&&!loading&&<p className="empty-state">在“我的参考”保存想法后，可以选择带到其他设备。</p>}
   {localChoices.map(choice=>{const content=choice.versions.at(-1),snapshot=cloudById.get(choice.id),current=snapshot?.current,pending=localState?.pending?.[choice.id],allowed=preferences?.enabled&&preferences.snapshotIds.includes(choice.id);if(!content)return null;return <article className="choice-item" key={choice.id}>
    <div className="choice-item-heading"><BookOpen size={21} aria-hidden="true"/><h4>{content.localTaskRef}</h4></div><p className="choice-rationale">{content.visibleRationale}</p><References content={content}/>
    <div className="choice-item-footer"><span className="muted">{pending?'上次保存正在确认':snapshot?.current?.state==='current'?<><Check size={14}/> 已有私有副本</>:allowed?'已选择跨设备使用':'仅在这台设备'}</span><Button type="button" variant="outline" disabled={busy||!ordinaryConnected||!preferences} onClick={()=>void openPreview(choice.id)}>{pending?'继续上次保存':snapshot?.current?.state==='current'?'更新副本':'在其他设备使用'}</Button></div>
    {(allowed||pending||snapshot&&sameCopy(snapshot))&&<ReadingDetails mode="inline" className="choice-options"><ReadingSummary>保存选项</ReadingSummary>{current&&snapshot&&sameCopy(snapshot)&&<><p>私有副本保留至 {time(current.expiresAt)}</p><button className="text-link" disabled={busy||!ordinaryConnected} onClick={()=>void run(async(c,active)=>{await c.restore(snapshot.snapshotId,current.versionId);if(active())setNotice('已下载到这台设备，原来的参考仍保留。');})}>下载这份副本</button><button className="text-link" disabled={busy||!ordinaryConnected} onClick={()=>setDeleteTarget(snapshot)}>删除云副本</button></>}{allowed&&<button className="text-link" disabled={busy} onClick={()=>void stopScope(choice.id)}>关闭这份参考的后续保存</button>}{pending&&<button className="text-link" disabled={busy} onClick={()=>void run(async(c,active)=>{await c.discardPending(choice.id);if(active())setNotice('已停止这台设备继续发送。先前是否已收到，仍会按原记录读取。');})}>停止这次发送</button>}</ReadingDetails>}
   </article>;})}
  </section>
  {(!cloud.length||separateCopies.length>0||after)&&<section className="choice-cloud" aria-labelledby="choice-cloud-heading"><div className="section-heading"><h3 id="choice-cloud-heading">我的私有副本</h3><Cloud size={18} aria-hidden="true"/></div>
   {!cloud.length&&!loading&&!readError&&ordinaryConnected&&<p className="muted">还没有可读取的副本。</p>}
   {separateCopies.map(snapshot=><article className="choice-item" key={snapshot.snapshotId}><h4>{snapshot.current?.content?.localTaskRef??titles[snapshot.snapshotId]??'参考记录'}</h4>
    {[snapshot.current,...snapshot.conflicts].filter((version):version is CloudChoiceVersion=>version!==null).map(version=><div className="choice-version" key={version.versionId}><p className="eyebrow">{version.state==='conflict'?'另一台设备的内容':version.state==='expired'?'已到期':'已保存的内容'}</p><p className="choice-rationale">{version.content?.visibleRationale??'这份内容目前无法读取。'}</p><References content={version.content}/>
     <p className="muted">{version.expiresAt?'保留至 '+time(version.expiresAt):''}{version.priorRationaleCurrent===false?' · 来源已变化，请重新查找后判断。':''}</p>
     {version.state==='conflict'&&localChoices.some(c=>c.id===snapshot.snapshotId)&&<label className="choice-conflict"><input type="checkbox" checked={(resolutions[snapshot.snapshotId]??[]).includes(version.versionId)} onChange={e=>setResolutions(old=>({...old,[snapshot.snapshotId]:e.target.checked?[...new Set([...(old[snapshot.snapshotId]??[]),version.versionId])]:(old[snapshot.snapshotId]??[]).filter(id=>id!==version.versionId)}))}/>已比较这份内容，下次保存时采用我更新后的本机版本</label>}
     {version.content?.visibleRationale&&['current','conflict'].includes(version.state)&&<button className="text-link" disabled={busy||!ordinaryConnected} onClick={()=>void run(async(c,active)=>{await c.restore(snapshot.snapshotId,version.versionId);if(active())setNotice('已下载到这台设备，原来的参考仍保留。');})}>下载到这台设备</button>}
    </div>)}
    <ReadingDetails mode="inline" className="choice-options"><ReadingSummary>副本选项</ReadingSummary>{preferences?.snapshotIds.includes(snapshot.snapshotId)&&!localChoices.some(c=>c.id===snapshot.snapshotId)&&<button className="text-link" disabled={busy} onClick={()=>void stopScope(snapshot.snapshotId)}>关闭这份参考的后续保存</button>}<button className="text-link" disabled={busy||!ordinaryConnected} onClick={()=>setDeleteTarget(snapshot)}>删除云副本</button></ReadingDetails>
   </article>)}
   {after&&<Button type="button" variant="outline" disabled={busy||!ordinaryConnected} onClick={()=>void run(async(c,active)=>{const page=await c.list({after});if(active()){cloudPages.current++;setCloud(old=>[...old,...page.items.filter(v=>!old.some(item=>item.snapshotId===v.snapshotId))]);setAfter(page.nextAfter);}})}>查看更早副本</Button>}
  </section>}
  {!!restored.length&&<ReadingDetails className="choice-downloads"><ReadingSummary>已下载到这台设备 · {restored.length} 份</ReadingSummary><p className="muted">保留的是下载时的内容，重新使用前请查看当前来源。</p>{restored.map(value=><article className="choice-item" key={value.versionId}><h4>{value.content.localTaskRef}</h4><p className="choice-rationale">{value.content.visibleRationale}</p><References content={value.content}/><span className="muted">{time(value.restoredAt)}</span><ReadingDetails mode="inline" className="choice-options"><ReadingSummary>下载选项</ReadingSummary><button className="text-link" onClick={()=>saveRecord(value)}>保存完整记录文件</button><button className="text-link" disabled={busy} onClick={()=>void run(async(c,active)=>{await c.removeRestored(value.versionId);if(active())setNotice('已移除这个下载版本。');})}>移除本机下载</button></ReadingDetails></article>)}</ReadingDetails>}
  <ChoiceRetainedOperations client={client} lease={lease} titles={titles} onResolved={()=>void refreshRef.current()}/>
  <p className="choice-retention-note">云副本在最后一次有效内容更新 30 天后清理。只保存你的判断和参考指向，原查询上下文及来源正文留在原处。</p>
  {preview&&<dialog ref={dialog} className="choice-dialog" aria-labelledby="choice-preview-title" onCancel={e=>{e.preventDefault();if(!busy)setPreview(null);}}><button className="dialog-close" aria-label="关闭预览" disabled={busy} onClick={()=>setPreview(null)}><X size={20}/></button><p className="eyebrow">仅你可见 · 跨设备使用</p><h2 id="choice-preview-title">{preview.expectedPendingVersionId?'继续上次保存':'保存这份参考'}</h2>{error&&<p role="alert" className="message error">{error}</p>}<h3>{preview.content.localTaskRef}</h3><p className="choice-rationale">{preview.content.visibleRationale}</p><References content={preview.content}/><p className="muted">包括这次比较的 {preview.content.candidateRefs.length} 项参考指向和你写下的判断，不包含来源正文。</p>{preview.resolveVersionIds.length>0&&<p>同时采用本机版本，处理刚才比较过的 {preview.resolveVersionIds.length} 份其他设备内容。</p>}<ReadingDetails className="choice-options"><ReadingSummary>查看完整数据</ReadingSummary><button className="text-link" onClick={()=>saveRecord(preview.content)}>保存数据预览文件</button></ReadingDetails><div className="button-row"><Button disabled={busy} onClick={()=>void confirmSync()}>{busy?'正在保存…':preview.expectedPendingVersionId?'继续保存':'保存到我的私有空间'}</Button><Button variant="outline" disabled={busy} onClick={()=>setPreview(null)}>返回</Button></div></dialog>}
  {deleteTarget&&<dialog ref={deletion} className="choice-dialog" aria-labelledby="choice-delete-title" onCancel={e=>{e.preventDefault();if(!busy)setDeleteTarget(null);}}><h2 id="choice-delete-title">删除这份云副本？</h2>{error&&<p role="alert" className="message error">{error}</p>}<p>{deleteTarget.current?.content?.localTaskRef??'参考记录'}</p><p>本机参考、已经下载的版本和原工作仍保留。</p><div className="button-row"><Button disabled={busy} onClick={()=>void run(async(c,active)=>{await c.delete(deleteTarget.snapshotId);if(active()){setDeleteTarget(null);setNotice('云副本已删除。');}})}>删除云副本</Button><Button variant="outline" disabled={busy} onClick={()=>setDeleteTarget(null)}>保留</Button></div></dialog>}
 </section>;
}
