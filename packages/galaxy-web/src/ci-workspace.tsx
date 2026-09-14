import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {ciSourceFromEvidence,getCiClient} from './ci-client.mjs';
type Props={runtime:any;connected:boolean;subjectId?:string;caseId:string;results:any[];evidence:any[]};
const names:any={pending:'等待观测',observed:'已取得外部观测',unavailable:'外部来源暂不可用',revoked:'已停止或撤销',stale:'观测已过期',
  'source-unavailable':'来源或授权已变化',active:'当前证明有效',success:'CI 通过',failure:'CI 未通过',recorded:'操作已记录'};
export function CiWorkspace({runtime,connected,subjectId,caseId,results,evidence}:Props){
  const [selected,setSelected]=useState(''),[resultId,setResultId]=useState(''),[local,setLocal]=useState<any>(null),[views,setViews]=useState<any>({}),
    [preview,setPreview]=useState<any>(null),[visible,setVisible]=useState<'Private'|'Public'>('Private'),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=useRef(0),client=useMemo(()=>connected&&subjectId?getCiClient(runtime,subjectId):null,[runtime,connected,subjectId]);
  const choices=evidence.filter(x=>x.record?.reportedBy===subjectId&&x.record?.evidenceType==='ci-result'&&x.referenceStatus==='current');
  const ownResults=[...new Map(results.filter(r=>r.actorId===subjectId).map(r=>[r.id,r])).values()];
  async function call(path:string,input:any){const epoch=generation.current;const value=await runtime.api.call(path,input);
    if(epoch!==generation.current)throw new Error('页面身份或案例已变化，请重新打开。');return value;}
  async function refresh(){if(!client)return;const epoch=generation.current,state=await client.local();if(epoch!==generation.current)return;
    const updated:any={};for(const item of state.requests.filter((r:any)=>r.caseId===caseId)){
      try{updated[item.id]=await call('/v2/ci/requests/read',{id:item.id});}catch{updated[item.id]={state:'source-unavailable'};}}
    for(const item of state.proofs.filter((p:any)=>state.requests.some((r:any)=>r.caseId===caseId&&r.id===p.requestId))){
      try{updated[item.id]=await call('/v2/ci/proofs/read',{id:item.id});}catch{updated[item.id]={status:'source-unavailable'};}}
    if(epoch===generation.current){setLocal(state);setViews(updated);}}
  useEffect(()=>{generation.current++;setLocal(null);setViews({});setPreview(null);setConfirm(false);setSelected('');setResultId('');setError('');
    if(client)refresh().catch(()=>setError('暂未读取到 CI 操作，请刷新。'));return()=>{generation.current++;};},[client,caseId]);
  async function run(fn:()=>Promise<any>){const epoch=generation.current;setBusy(true);setError('');try{await fn();if(epoch===generation.current)await refresh();}
    catch(e:any){if(epoch===generation.current)setError(/^[a-z][a-z0-9_]+$/.test(e.message)?'操作未完成，请刷新来源、版本及连接后重试。':e.message??'操作未完成。');}
    finally{if(epoch===generation.current)setBusy(false);}}
  if(!client)return null;
  const sourceView=choices.find(x=>`${x.id}:${x.version}`===selected),source=ciSourceFromEvidence(sourceView),result=ownResults.find(r=>`${r.id}:${r.version}`===resultId);
  const requests=local?.requests.filter((r:any)=>r.caseId===caseId)??[];
  return <section className="fact-panel"><h3>外部 CI 观测与证明</h3><p>选择自己的来源和结果，由银河读取公共 GitHub 的实际运行记录。CI 通过不表示整个问题已解决，也不认证个人能力。</p>
    {error&&<p role="alert">{error}</p>}
    {local?.pending&&<div><p>有一笔操作等待确认结果。不会自动创建重复请求。</p>
      <Button type="button" disabled={busy} onClick={()=>run(()=>client.reconcile())}>查询原操作</Button>
      <Button type="button" disabled={busy} onClick={()=>run(()=>client.reconcile({retry:true,confirmed:true}))}>确认重试原操作</Button>
      <Button type="button" disabled={busy} onClick={()=>run(()=>client.reconcile({retry:true,reauthorize:true,confirmed:true}))}>重新授权同一内容</Button></div>}
    <form onSubmit={e=>{e.preventDefault();if(!source||!sourceView||!result)return;run(()=>client.submit('request',{id:crypto.randomUUID(),schemaVersion:2,kind:'observe',
      purpose:'observe-selected-ci-source-and-prepare-bounded-proof',caseId,evidenceRef:{id:sourceView.id,version:sourceView.version},resultRef:{id:result.id,version:result.version},source},{confirmed:true}));}}>
      <label>已记录的 CI 来源<select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">选择来源</option>{choices.map(x=><option key={`${x.id}:${x.version}`} value={`${x.id}:${x.version}`}>{x.record.summary} · 版本 {x.version}</option>)}</select></label>
      <label>这次观测对应的本人结果<select value={resultId} onChange={e=>setResultId(e.target.value)}><option value="">选择结果</option>{ownResults.map(x=><option key={`${x.id}:${x.version}`} value={`${x.id}:${x.version}`}>{x.summary} · 版本 {x.version}</option>)}</select></label>
      {!choices.length&&<p>先在证据区记录本人的 CI 来源，再选择实际结果。</p>}{sourceView&&!source&&<p>这份来源尚未包含完整的 GitHub 仓库、运行次数和提交版本，请先纠正来源记录。</p>}
      {source&&<p>{source.owner}/{source.repository}，运行 {source.runId}，第 {source.attempt} 次，提交 {source.commit}。</p>}
      <Button type="submit" disabled={busy||!!local?.pending||!source||!result}>确认排队观测</Button></form>
    <Button type="button" disabled={busy} onClick={()=>run(refresh)}>刷新当前观测</Button>
    {requests.map((r:any)=>{const v=views[r.id];return <article className="task-card" key={r.id}><p>结果版本 {r.resultRef.version}，证据版本 {r.evidenceRef.version}：{names[v?.state]??'尚未读取'}。</p>
      {v?.observation&&<p>{names[v.observation.conclusion]??(v.observation.completed?'已完成外部执行':'外部执行尚未完成')}；采集时间 {new Date(v.observation.collectedAt*1000).toLocaleString()}。</p>}
      {v?.synthetic&&<p>演示资料，不计入真实贡献或资格。</p>}
      <Button type="button" disabled={busy||v?.state!=='observed'||!v?.observation?.completed} onClick={()=>run(async()=>{setPreview(await call('/v2/ci/proofs/preview',{id:crypto.randomUUID(),requestId:r.id}));setConfirm(false);setVisible('Private');})}>预览可披露的证明</Button>
      <Button type="button" variant="outline" disabled={busy||v?.state==='revoked'} onClick={()=>run(()=>call('/v2/ci/requests/revoke',{id:r.id}))}>停止观测并使证明失效</Button>
    </article>;})}
    {preview&&<form onSubmit={e=>{e.preventDefault();if(!confirm)return;run(async()=>{await client.submit('proof',JSON.parse(preview.payloadJson),{confirmed:true,visibility:visible});setPreview(null);});}}>
      <h4>本次证明预览</h4><p>以下内容不含原案例、任务和证据正文。选择公开后，仓库和运行信息会公开。</p><pre>{JSON.stringify(JSON.parse(preview.payloadJson),null,2)}</pre>
      <label>可见范围<select value={visible} onChange={e=>setVisible(e.target.value as any)}><option value="Private">仅自己</option><option value="Public">公开这份 CI 证明</option></select></label>
      <label><input type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>我已核对本次披露的内容和范围</label>
      <Button type="submit" disabled={busy||!confirm||!!local?.pending}>确认并签署证明授权</Button><Button type="button" variant="outline" onClick={()=>setPreview(null)}>取消</Button></form>}
    {(local?.proofs??[]).filter((p:any)=>requests.some((r:any)=>r.id===p.requestId)).map((p:any)=><article key={p.id}><p>{p.visibility==='Public'?'公开':'私有'}证明：{names[views[p.id]?.status]??'待读取'}。</p>
      <Button type="button" disabled={busy} onClick={()=>run(()=>call('/v2/ci/proofs/revoke',{id:p.id}))}>撤销这份证明</Button></article>)}
  </section>;
}
