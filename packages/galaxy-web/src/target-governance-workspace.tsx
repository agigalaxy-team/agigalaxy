import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { createTargetGovernanceClientV2 } from '../../galaxy-official/src/target-governance-client-v2.mjs';

const labels: Record<string,string> = { received:'已记录，等待获授权处理者',reviewing:'复核中',resolved:'已有处理决定',appealed:'申诉已记录',withdrawn:'举报者已撤回',
 'discovery-hidden':'停止对外发现展示','new-participation-paused':'暂停新参与','sending-paused':'暂停发送及编辑','invitations-paused':'暂停邀请',
 review:'开始复核',pause:'临时限制',resume:'解除本案限制',resolve:'记录裁定',supplement:'补充说明',appeal:'提出申诉','withdraw-report':'撤回举报' };

/** Standalone detail/intake component; parent owns routing and stable deep links. */
export function TargetGovernanceWorkspace({runtime,subjectId,connected,target,reportId,navigate}:any){
 const client=useMemo(()=>connected?createTargetGovernanceClientV2({api:runtime.api,getLocal:runtime.getLocal,putLocal:runtime.putLocal,subjectId}):null,[runtime,subjectId,connected]);
 const generation=useRef(0),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [config,setConfig]=useState<any>(null),[currentTarget,setCurrentTarget]=useState<any>(null),[items,setItems]=useState<any[]>([]),[next,setNext]=useState<any>(null),[selected,setSelected]=useState<any>(null),[pending,setPending]=useState<any[]>([]);
 const [summary,setSummary]=useState(''),[category,setCategory]=useState('other'),[action,setAction]=useState('supplement'),[viewers,setViewers]=useState<string[]>([]),[rule,setRule]=useState(''),[scopes,setScopes]=useState<string[]>([]),[hours,setHours]=useState(24),[verdict,setVerdict]=useState('dismissed'),[preview,setPreview]=useState<any>(null),[authPreview,setAuthPreview]=useState<any>(null);
 useEffect(()=>{generation.current++;setItems([]);setSelected(null);setPreview(null);setAuthPreview(null);setSummary('');setViewers([]);setCurrentTarget(null);setError('');setNotice('');setPending([]);
  const gen=generation.current;const refreshPending=()=>{if(document.visibilityState!=='visible'||busy||!client)return;client.pending().then((p:any)=>{if(generation.current===gen)setPending(p);}).catch(()=>{});};
  const timer=window.setInterval(refreshPending,15000);const onVisible=()=>refreshPending();document.addEventListener('visibilitychange',onVisible);
  return()=>{generation.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',onVisible);};},[client,target?.type,target?.id,reportId]);
 async function work(fn:(valid:()=>boolean)=>Promise<void>){const gen=generation.current;setBusy(true);setError('');try{await fn(()=>generation.current===gen);}catch(e:any){if(gen===generation.current)setError(e.code??e.message);}finally{if(gen===generation.current){setBusy(false);if(client)try{const p=await client.pending();if(gen===generation.current)setPending(p);}catch{}}}}
 async function load(after?:string){if(!client)return;await work(async valid=>{
  const c=await client.config(),r=await client.query({...(target?{target:{type:target.type,id:target.id}}:{}),...(after?{after}:{})});
  let t=null,s=null;if(target)try{t=await client.target({type:target.type,id:target.id});}catch{/* Existing report/appeal may still be accessible after source withdrawal. */}
  if(reportId)s=await client.get(reportId);if(valid()){setConfig(c);setItems(old=>after?[...old,...r.items]:r.items);setNext(r.next);setCurrentTarget(t);if(s)setSelected(s);}
 });}
 useEffect(()=>{if(client)void load();},[client,target?.type,target?.id,reportId]);
 function open(row:any){setSelected(row);setSummary('');setPreview(null);setAction(row.canRespond?'supplement':'review');setViewers([]);setScopes([]);setRule('');}
 const kind=selected?.target.type??target?.type,scopeOptions=kind==='task'?['discovery-hidden','new-participation-paused']:['sending-paused','invitations-paused'];
 const decision=['review','pause','resolve','resume'].includes(action),required=selected&&decision?selected.requiredDecisionViewers.filter((x:string)=>x!==subjectId):[];
 const availableViewers=[...new Set<string>([...(config?.moderatorIds??[]),...(selected?[selected.reporterId]:[])])].filter(x=>x!==subjectId);
 const actions=selected?[...(selected.canRespond?['supplement']:[]),...(selected.canAppeal?['appeal']:[]),...(selected.canWithdraw?['withdraw-report']:[]),...(selected.canModerate?['review','pause','resolve','resume']:[])]:[];
 async function prepare(e:React.FormEvent){e.preventDefault();if(!client)return;await work(async valid=>{
  const fresh=selected?await client.get(selected.reportId):await client.target({type:target.type,id:target.id});
  let p:any={schemaVersion:2,id:crypto.randomUUID(),summary};
  if(selected){p={...p,reportId:fresh.reportId,expectedVersion:fresh.version,kind:action};
   if(action==='pause')Object.assign(p,{targetVersion:fresh.currentTarget?.version,scopes,until:Math.floor(Date.now()/1000)+hours*3600,rule});
   if(action==='resolve')Object.assign(p,{targetVersion:fresh.currentTarget?.version,verdict,rule,restriction:verdict==='upheld'&&scopes.length?{scopes,until:Math.floor(Date.now()/1000)+hours*3600}:null});
  }else Object.assign(p,{target:fresh.target,category});
  const result=await client.prepare(selected?'event':'report',p,{viewers:[...new Set([...viewers,...required])]});if(valid()){setPreview(result);if(selected)setSelected(fresh);else setCurrentTarget(fresh);}
 });}
 if(!connected)return <section className="card"><h2>任务与房间举报、申诉</h2><p>连接本人银河身份后，可以提交限定受众的说明和查看处理状态。</p></section>;
 return <section className="card"><h2>任务与房间举报、申诉</h2>
  <p>举报是待复核的说明。处理仅影响列出的操作，不替代任务验收、成员共同决定或专业能力结论。</p>
  <p className="muted">{config?.configured?'当前配置了处理角色；实际受理与响应时间尚不作承诺。':'当前没有配置处理角色。可记录私人请求，但不能承诺已经有人受理。'}</p>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <Button type="button" disabled={busy} onClick={()=>void load()}>刷新当前状态</Button>
  {target&&<p>对象：{target.type==='room'?'普通房间':'任务'} <code>{target.id}</code>。{!currentTarget&&'当前原对象不可用；已有处理记录仍可按本人权限查看。'}</p>}
  {pending.map(p=><div className="card" key={p.operationId}><p>原操作 <code>{p.operationId}</code>：{p.state==='stopped-local'?'本机已停止重试，服务端取消未确认':'结果待核对'}</p>
   <Button type="button" disabled={busy} onClick={()=>void work(async valid=>{const r=await client!.reconcile(p.operationId);if(valid())setNotice(r.state==='acknowledged'?'原操作已确认接收。':'服务端尚无该原操作回执，不能据此宣称已取消。');})}>查询原回执</Button>
   {p.state!=='stopped-local'&&<><Button type="button" disabled={busy} onClick={()=>void work(async valid=>{await client!.retry(p.operationId,{confirmed:true});if(valid())setNotice('原操作已确认接收。');})}>重试原内容与授权</Button>
    <Button type="button" disabled={busy} onClick={()=>void work(async valid=>{const r=await client!.reviewAuthorization(p.operationId);if(valid()){if(r.state==='reauthorization-required')setAuthPreview(r);else setNotice(r.state==='acknowledged'?'原操作已接收。':'已有原授权，继续沿用原内容重试。');}})}>检查旧设备授权接续</Button>
    <Button type="button" disabled={busy} onClick={()=>void work(async valid=>{const r=await client!.stopLocalRetry(p.operationId,{confirmed:true});if(valid())setNotice(r.state==='acknowledged'?'原操作已接收。':'只停止本机重试；保留原ID查询，服务端取消未确认。');})}>停止本机重试</Button></>}
  </div>)}
  <div className="button-row">{target&&<Button type="button" disabled={busy||!currentTarget} onClick={()=>{setSelected(null);setPreview(null);setSummary('');setViewers([]);}}>新建限定举报</Button>}
   {items.map(r=><Button type="button" key={r.reportId} disabled={busy} onClick={()=>open(r)}>{labels[r.state]??r.state} · {r.reportId.slice(0,8)}</Button>)}
   {next&&<Button type="button" disabled={busy} onClick={()=>void load(next)}>继续读取</Button>}</div>
  {!items.length&&<p>当前没有本人可见的处理记录。</p>}
  {selected&&<div><h3>处理记录 {selected.reportId}</h3><p>{labels[selected.state]??selected.state} · 版本 {selected.version}</p>
   <p>原举报对象版本 {selected.target.version}；当前观察版本 {selected.currentTarget?.version??'不可用'}。处理材料没有赋予整份原对象的阅读权限。</p>
   {(selected.currentRestrictions?.restrictions??[]).map((r:any)=><p key={r.reportId}>有效限制：{r.scopes.map((s:string)=>labels[s]).join('、')}，至 {new Date(r.until).toLocaleString()}，案件 {r.reportId}</p>)}
   {!selected.events.length&&<p>私人说明目前无读取授权或已经过期；这里只显示必要状态。</p>}
   {selected.events.map((e:any)=><article className="card" key={e.eventId}><p>{labels[e.kind]??'举报说明'} · {e.authorId} · {new Date(e.at).toLocaleString()}</p><p style={{whiteSpace:'pre-wrap'}}>{e.summary}</p>{e.rule&&<p>规则：{e.rule}</p>}</article>)}
   {navigate&&<Button type="button" onClick={()=>navigate(selected.target.type==='task'?`/app/tasks/${selected.target.id}`:`/app/rooms/${selected.target.id}`)}>返回原对象（按当前权限读取）</Button>}
  </div>}
  {((!selected&&currentTarget)||selected&&actions.length>0)&&<form onSubmit={prepare}>
   {selected?<label>本次操作<select value={action} onChange={e=>{setAction(e.target.value);setPreview(null);}}>{actions.map(a=><option key={a} value={a}>{labels[a]}</option>)}</select></label>:<label>理由类别<select value={category} onChange={e=>setCategory(e.target.value)}><option value="other">其他规则问题</option><option value="advertising">无关广告</option><option value="harassment">骚扰</option><option value="privacy">隐私</option><option value="misrepresentation">冒用或虚假陈述</option></select></label>}
   <label>必要说明<Textarea maxLength={1600} value={summary} onChange={e=>{setSummary(e.target.value);setPreview(null);}} required/></label>
   <p className="muted">只填写本次必要说明，不复制无关私聊、密钥或材料。正常仓库链接和报价不会仅因包含链接、价格而自动认定违规。</p>
   {selected&&['pause','resolve'].includes(action)&&<><label>规则依据<Input required value={rule} maxLength={120} onChange={e=>setRule(e.target.value)}/></label>
    {action==='resolve'&&<label>结论<select value={verdict} onChange={e=>setVerdict(e.target.value)}><option value="dismissed">未成立／撤销本案限制</option><option value="upheld">在所述范围成立</option></select></label>}
    {(action==='pause'||verdict==='upheld')&&<><fieldset><legend>限制范围</legend>{scopeOptions.map(s=><label key={s}><input type="checkbox" checked={scopes.includes(s)} onChange={e=>setScopes(e.target.checked?[...scopes,s]:scopes.filter(x=>x!==s))}/>{labels[s]}</label>)}</fieldset>
     <label>持续小时（临时暂停最长168，裁定最长720）<Input type="number" min={1} max={action==='pause'?168:720} value={hours} onChange={e=>setHours(Number(e.target.value))}/></label></>}
   </>}
   <fieldset><legend>本次私人说明的可见人员</legend>{availableViewers.map(id=><label className="button-row" key={id}><input type="checkbox" checked={required.includes(id)||viewers.includes(id)} disabled={required.includes(id)} onChange={e=>{setViewers(e.target.checked?[...viewers,id]:viewers.filter(x=>x!==id));setPreview(null);}}/><code>{id}</code>{required.includes(id)&&'（必要回执接收者）'}</label>)}{!availableViewers.length&&<p>仅本人保存；暂无获配置的处理者。</p>}</fieldset>
   <Button type="submit" disabled={busy||!summary.trim()}>生成准确预览</Button>
  </form>}
  {preview&&<div className="card"><h3>待确认的本次记录</h3><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify({endpoint:preview.endpoint,subjectId:preview.subjectId,payload:preview.payload,viewers:preview.viewers},null,2)}</pre>
   <Button type="button" disabled={busy} onClick={()=>void work(async valid=>{const p=preview;setPreview(null);const r=await client!.execute(p,{confirmed:true});const next=r.reportId?await client!.get(r.reportId):null;if(valid()){setNotice('本次记录已接收，不代表违规成立或全部限制解除。');setSummary('');if(next)setSelected(next);}})}>确认提交所示内容与受众</Button>
   <Button type="button" disabled={busy} onClick={()=>setPreview(null)}>取消本次预览</Button>
  </div>}
  {authPreview&&<div className="card"><h3>原操作重新授权</h3><p>只有业务回执与原 Consent 均不存在时才允许本环节。内容、操作ID和受众保持所示值，由当前设备签署新的授权。</p><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(authPreview,null,2)}</pre>
   <Button type="button" disabled={busy} onClick={()=>void work(async valid=>{const p=authPreview;setAuthPreview(null);await client!.reauthorize(p,{confirmed:true});if(valid())setNotice('同一原操作已在明确重新授权后接收。');})}>确认原内容与新授权期限</Button><Button type="button" disabled={busy} onClick={()=>setAuthPreview(null)}>取消重新授权</Button></div>}
 </section>;
}
