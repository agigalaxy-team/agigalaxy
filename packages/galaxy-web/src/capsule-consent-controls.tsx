import React,{useEffect,useMemo,useState} from 'react';
import {Button} from '@/components/ui/button';
import {createCapsuleVisibilityClient} from './capsule-visibility-client.mjs';

export function CapsuleConsentControls({runtime,subjectId,targets,busy,run,onChanged}:any){
 const client=useMemo(()=>createCapsuleVisibilityClient({api:runtime.api,getLocal:runtime.getLocal,putLocal:runtime.putLocal,subjectId}),[runtime,subjectId]);
 const [preview,setPreview]=useState<any>(null),[records,setRecords]=useState<any[]>([]),[message,setMessage]=useState('');
 useEffect(()=>{let live=true;client.pending().then(x=>{if(live)setRecords(x);}).catch(()=>{});return()=>{live=false;};},[client]);
 async function refresh(){setRecords(await client.pending());}
 async function operate(fn:()=>Promise<any>){try{const result=await fn();setMessage(result.state==='revoked'?'原展示授权已撤销，当前获准展示将更新。':result.state==='expired'?'原授权已到期，不再提供该范围的展示。':'原授权仍有效；可明确继续撤销。');setPreview(null);await onChanged();}finally{await refresh();}}
 const options=[...new Map(targets.filter(Boolean).map((t:any)=>[t.consentId,t])).values()] as any[];
 return <details className="room-settings"><summary>管理我发布的版本和使用记录的展示授权</summary>
  <p>只撤销选定记录的当前展示授权。不会删除别人的工作、撤销任务或收回外部已下载的副本。来源许可有单独的撤销入口。</p>
  <fieldset disabled={busy}>
   {options.map(t=><div className="task-card" key={t.consentId}><p>{t.label}</p><Button type="button" variant="outline" onClick={()=>run(async()=>{setPreview(await client.prepare(t));setMessage('');})}>查看这一条的展示授权</Button></div>)}
   {!options.length&&<p>当前页没有本人可管理的版本或使用记录。可查看原操作的撤销回执。</p>}
   {preview&&<section className="task-card"><h3>撤销精确记录的展示授权</h3><p>动作：{preview.target.type==='use'?'参考／实际应用／再验证':'Capsule 版本发布'}；原操作：<code>{preview.target.operationId}</code></p>
    <p>当前范围：{preview.visibility}；额外阅读者：{preview.viewers?.length??0}。当前状态：{preview.state}。</p>
    <p>确认后这项授权不能自动恢复。需要重新公开时应按新合法材料与明确操作重新授权，不能把撤销解释为物理删除。</p>
    {preview.state==='active'&&<Button type="button" onClick={()=>run(()=>operate(()=>client.execute(preview,{confirmed:true})))}>确认撤销这项展示授权</Button>}
    <Button type="button" variant="ghost" onClick={()=>setPreview(null)}>取消预览</Button>
   </section>}
   {!!records.length&&<section><h3>原授权回执</h3>{records.map(r=><article className="task-card" key={r.target.consentId}><p><code>{r.target.operationId}</code> · {r.state==='result-unknown'?'结果未知，先查询原授权':r.state==='revoked'?'已撤销':r.state==='expired'?'已到期':'仍有效'}</p>
    <Button type="button" variant="outline" onClick={()=>run(()=>operate(()=>client.reconcile(r.target.consentId)))}>查询原授权状态</Button>
    {!['revoked','expired'].includes(r.state)&&<Button type="button" onClick={()=>run(()=>operate(()=>client.retry(r.target.consentId,{confirmed:true})))}>继续撤销同一项</Button>}
   </article>)}</section>}
  </fieldset>{message&&<p className="message">{message}</p>}
 </details>;
}
