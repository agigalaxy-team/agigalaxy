import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {createChoiceSyncClient} from './choice-sync-client.mjs';
type Props={runtime:any;subjectId?:string;connected:boolean;localChoices:any[]};
export function ChoiceSyncWorkspace({runtime,subjectId,connected,localChoices}:Props){
 const client=useMemo(()=>runtime&&subjectId?createChoiceSyncClient(runtime,{subjectId}):null,[runtime,subjectId]);
 const [preferences,setPreferences]=useState<any>(null),[selected,setSelected]=useState<string[]>([]),[cloud,setCloud]=useState<any[]>([]),[after,setAfter]=useState<string|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[preview,setPreview]=useState<any>(null),[resolutions,setResolutions]=useState<Record<string,string[]>>({}),epoch=useRef(0),running=useRef(false);
 const [restored,setRestored]=useState<any[]>([]);
 useEffect(()=>{const token=++epoch.current;setPreferences(null);setSelected([]);setCloud([]);setPreview(null);setError('');setNotice('');setRestored([]);setBusy(false);
  client?.localState().then(v=>{if(epoch.current===token)setRestored(Object.values(v.restored));}).catch(()=>{});
  return()=>{epoch.current++;client?.close();};},[client]);
 async function run(fn:(c:NonNullable<typeof client>,valid:()=>boolean)=>Promise<void>){if(!client||running.current)return;const token=epoch.current,valid=()=>token===epoch.current;running.current=true;setBusy(true);setError('');setNotice('');
  try{await fn(client,valid);}catch(e:any){if(valid())setError(({choice_sync_not_selected:'先单独勾选这份记录并保存同步范围。',choice_source_changed:'来源已更新，请重新查询并形成当前选择后再同步。',choice_source_unavailable:'所选来源当前不可用，未将旧理由上传。',choice_original_source_query_unavailable:'这台设备没有原查询条件。先重新查询当前候选并保存新的本机选择。',choice_preference_conflict:'同步范围被另一设备修改，请重新读取再选择。',choice_cloud_content_unavailable:'这份云版本已失效或到期，没有恢复旧理由。'} as Record<string,string>)[e.code??e.message]??'操作未完成；已有本机记录保留。可以重试原操作或重新读取云端状态。');}finally{running.current=false;if(valid())setBusy(false);}}
 const replace=(v:any)=>setCloud(old=>[v,...old.filter(x=>x.snapshotId!==v.snapshotId)]);
 if(!client)return <section className="help-intro"><h2>跨设备使用</h2><p>本机选择默认留在当前设备。连接并绑定你的银河身份后，可以单独选择哪些记录同步到个人私有空间。</p></section>;
 return <section className="help-intro"><h2>可选：私有云选择记录</h2><p>只有你单独选中的记录才可同步。这里与房间摘要的开关独立，也不会公开分享。云副本在最后有效内容更新 30 天后清理；读取或重试不延长时间。</p>
  <Button type="button" variant="outline" disabled={busy} onClick={()=>run(async(c,valid)=>{const p=await c.preferences();if(valid()){setPreferences(p);setSelected(p.snapshotIds);}})}>读取当前同步范围</Button>
  {preferences&&<form className="workspace-form" onSubmit={e=>{e.preventDefault();run(async(c,valid)=>{const p=await c.savePreference({endpoint:preferences.endpoint,expectedRevision:preferences.revision,enabled:selected.length>0,snapshotIds:selected});if(valid()){setPreferences(p);setNotice('范围已保存。使用下面的“同步这份记录”才会上传所选内容。');}});}}>
   <p>当前：{preferences.enabled?'已允许选定记录':'关闭'}。改变范围不会自动上传或删除已有云副本。</p>
   {localChoices.map(choice=><label key={choice.id}><input type="checkbox" checked={selected.includes(choice.id)} onChange={e=>setSelected(old=>e.target.checked?[...new Set([...old,choice.id])]:old.filter(id=>id!==choice.id))}/>{choice.versions.at(-1).localTaskRef}</label>)}
   {selected.filter(id=>!localChoices.some(c=>c.id===id)).map(id=><label key={id}><input type="checkbox" checked onChange={()=>setSelected(old=>old.filter(v=>v!==id))}/>其他设备的已选记录 {id.slice(0,8)}</label>)}
   <Button type="submit" disabled={busy}>保存这次明确选择的范围</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>setSelected([])}>取消全部选择</Button>
  </form>}
  {localChoices.map(choice=><article className="task-card" key={choice.id}><h3>{choice.versions.at(-1).localTaskRef}</h3>
   <Button type="button" variant="outline" disabled={busy} onClick={()=>run(async(c,valid)=>{const v=await c.localPreview(choice.id);if(valid())setPreview(v);})}>预览将同步的最小记录</Button>
   <Button type="button" disabled={busy||!preferences?.enabled||!preferences.snapshotIds.includes(choice.id)} onClick={()=>run(async(c,valid)=>{const v=await c.sync(choice.id,{resolveVersionIds:resolutions[choice.id]??[]});if(valid()){replace(v);setNotice(v.syncState==='conflict'?'已保存为冲突版本，两方内容均保留。':'已同步选定记录。');}})}>同步这份记录</Button>
   <Button type="button" variant="ghost" disabled={busy} onClick={()=>run(async(c,valid)=>{const v=await c.discardPending(choice.id);if(valid()&&v){replace(v);setNotice('已核对云端并放弃本机待重试请求。原来源和已收到的云版本未删除。');}})}>核对并放弃待重试请求</Button>
  </article>)}
  {preview&&<details open><summary>选定数据预览</summary><p>{preview.visibleRationale}</p><p>候选 {preview.candidateRefs.length} 项、选定 {preview.selectedRefs.length} 项、实际结果关联 {preview.resultRefs.length} 项。不会上传原查询上下文或来源正文。</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({localTaskRef:preview.localTaskRef,rationaleAuthor:preview.rationaleAuthor,candidateRefs:preview.candidateRefs,selectedRefs:preview.selectedRefs,resultRefs:preview.resultRefs},null,2)}</pre></details>}
  <Button type="button" variant="outline" disabled={busy} onClick={()=>run(async(c,valid)=>{const page=await c.list();if(valid()){setCloud(page.items);setAfter(page.nextAfter);}})}>读取本人云端记录</Button>
  {cloud.map(snapshot=><article className="task-card" key={snapshot.snapshotId}><h3>{snapshot.current?.content.localTaskRef??'云选择记录'} · 修订 {snapshot.revision}</h3>
   {[snapshot.current,...snapshot.conflicts].filter(Boolean).map((v:any)=><section key={v.versionId}><strong>{v.state==='conflict'?'另一设备的冲突版本':v.state==='expired'?'已到期版本':'当前云版本'}</strong>
    <p>{v.content.visibleRationale??'理由因来源失效、到期或删除而不可用。'}</p><small>到期：{new Date(v.expiresAt).toLocaleString()}；当前来源：{v.priorRationaleCurrent?'引用一致':'需要重新判断'}。选择不代表应用成功。</small>
    {v.state==='conflict'&&<label><input type="checkbox" checked={(resolutions[snapshot.snapshotId]??[]).includes(v.versionId)} onChange={e=>setResolutions(old=>({...old,[snapshot.snapshotId]:e.target.checked?[...(old[snapshot.snapshotId]??[]),v.versionId]:(old[snapshot.snapshotId]??[]).filter(id=>id!==v.versionId)}))}/>已比较这份冲突；用我更新后的本机选择明确解决它</label>}
   <Button type="button" variant="ghost" disabled={busy||!connected||!v.content.visibleRationale} onClick={()=>run(async(c,valid)=>{const saved=await c.restore(snapshot.snapshotId,v.versionId);if(valid()){setRestored(old=>[saved,...old.filter(item=>item.versionId!==saved.versionId)]);setNotice('所选云版本已另存到下方本机版本区，原本机草稿未被覆盖。');}})}>另存这份版本到本机</Button>
   </section>)}
   <p>跨设备没有原查询条件时，应重新查当前来源再形成新选择。模型可帮助比较双方，但不会自动扩展同步范围。</p>
   <Button type="button" variant="ghost" disabled={busy} onClick={()=>run(async(c,valid)=>{await c.delete(snapshot.snapshotId);if(valid()){setCloud(old=>old.filter(v=>v.snapshotId!==snapshot.snapshotId));setNotice('云副本已删除，本机记录和原工作事实保留。');}})}>删除这份云副本</Button>
  </article>)}
  {after&&<Button type="button" variant="outline" disabled={busy} onClick={()=>run(async(c,valid)=>{const page=await c.list({after});if(valid()){setCloud(old=>[...old,...page.items]);setAfter(page.nextAfter);}})}>下一页云记录</Button>}
  {restored.length>0&&<section><h3>明确另存的本机历史版本</h3><p>这些是你主动下载的历史记录，可以离线查看；不说明当前来源仍有效。联网后重新核对来源，再决定是否采用。</p>{restored.map(v=><article className="task-card" key={v.versionId}><h4>{v.content.localTaskRef}</h4><p>{v.content.visibleRationale}</p><small>另存于 {new Date(v.restoredAt).toLocaleString()}</small><details><summary>所选引用和当时状态</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({candidateRefs:v.content.candidateRefs,selectedRefs:v.content.selectedRefs,resultRefs:v.content.resultRefs,sourceStatus:v.sourceStatus},null,2)}</pre></details>
   <Button type="button" variant="ghost" disabled={busy} onClick={()=>run(async(c,valid)=>{await c.removeRestored(v.versionId);if(valid())setRestored(old=>old.filter(item=>item.versionId!==v.versionId));})}>删除这个本机下载版本</Button></article>)}</section>}
  {!connected&&<p>当前未连接。云操作需重新连接；本机下载的历史版本仍可单独查看和删除。</p>}
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 </section>;
}
