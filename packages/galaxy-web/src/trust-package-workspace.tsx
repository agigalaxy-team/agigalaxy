import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {verifyTrustPackage} from '../../galaxy-official/src/trust-package.mjs';

type Props={runtime:any;subjectId?:string;connected:boolean;navigate:(path:string)=>void};
const reason=(e:any)=>({trust_preview_required:'请重新查看确切内容，再选择签署。',trust_preview_changed:'预览内容发生变化，请重新核对。',
 trust_identity_snapshot_required:'此处还没有身份公开控制历史。请点击“刷新身份公开资料”主动获取，再制作资料包。',
 trust_identity_changed:'当前身份或设备已改变，请重新打开此流程。',trust_source_changed:'来源或许可已变化，请重新查看材料。',
 trust_connection_required:'此操作需要连接你所选的银河服务；原创自述包仍可本地使用。',trust_original_authorization_stale:'原授权属于旧连接，请保留原操作查询；不会静默签成新授权。',
 trust_result_unknown:'尚未取得回执。原签名已保留，可查询原操作。',trust_linked_source_permission_required:'这条材料包含尚未取得再披露许可的关联来源。可以保留本人引用，暂不能整体复制。'} as Record<string,string>)[e?.code]??e?.message??'操作未完成。';
function download(name:string,text:string,type='text/plain;charset=utf-8'){const url=URL.createObjectURL(new Blob([text],{type}));const link=document.createElement('a');
 link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
const summary=(e:any)=>e.title??e.summary??e.description??e.strategy??e.kind;

export function TrustPackageWorkspace({runtime,subjectId,connected,navigate}:Props){
 const client=runtime?.trustPackages,epoch=useRef(0),working=useRef(false);
 const [claim,setClaim]=useState(''),[audienceKind,setAudienceKind]=useState('subjects'),[recipients,setRecipients]=useState(''),[days,setDays]=useState(1);
 const [caseId,setCaseId]=useState(''),[taskId,setTaskId]=useState(''),[events,setEvents]=useState<any[]>([]),[selections,setSelections]=useState<any[]>([]);
 const [kind,setKind]=useState('evidence'),[recordId,setRecordId]=useState(''),[version,setVersion]=useState(1),[grantee,setGrantee]=useState('');
 const [licenses,setLicenses]=useState<any[]>([]),[received,setReceived]=useState<any[]>([]),[pending,setPending]=useState<any[]>([]);
 const [authorNext,setAuthorNext]=useState<string|null>(null),[recipientNext,setRecipientNext]=useState<string|null>(null);
 const [preview,setPreview]=useState<any>(null),[permissionPreview,setPermissionPreview]=useState<any>(null),[container,setContainer]=useState<any>(null);
 const [imported,setImported]=useState<any>(null),[report,setReport]=useState<any>(null),[online,setOnline]=useState<any>(null);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const audience=()=>audienceKind==='public'?{kind:'public'}:{kind:'subjects',subjectIds:[...new Set(recipients.split(/[\s,，、]+/).filter(Boolean))]};
 const expiry=()=>Math.floor(Date.now()/1000)+days*86400;
 async function refresh(lease:number){
  if(!client||!subjectId)return;const p=await client.pending();if(lease!==epoch.current)return;setPending(p);
  if(connected){const [a,b]=await Promise.all([runtime.api.call('/v2/trust-package/permissions/query',{role:'author'}),runtime.api.call('/v2/trust-package/permissions/query',{role:'grantee'})]);
   if(lease===epoch.current){setLicenses(a.items);setReceived(b.items);setAuthorNext(a.nextAfter);setRecipientNext(b.nextAfter);}}
 }
 async function run(action:(apply:(f:()=>void)=>void)=>Promise<void>){if(working.current)return;const lease=epoch.current;working.current=true;setBusy(true);setError('');setNotice('');
  const apply=(f:()=>void)=>{if(lease===epoch.current)f();};
  try{await action(apply);await refresh(lease);}catch(e){apply(()=>setError(reason(e)));await refresh(lease).catch(()=>{});}
  finally{working.current=false;apply(()=>setBusy(false));}}
 useEffect(()=>{const lease=++epoch.current;setPreview(null);setPermissionPreview(null);setContainer(null);setSelections([]);setEvents([]);setLicenses([]);setReceived([]);setPending([]);setClaim('');
  setRecipients('');setCaseId('');setTaskId('');setRecordId('');setGrantee('');setError('');
  const reload=()=>{if(document.visibilityState==='visible'&&!working.current)void refresh(epoch.current).catch(e=>{if(epoch.current===lease)setError(reason(e));});};
  void refresh(lease).catch(e=>{if(lease===epoch.current)setError(reason(e));});
  const timer=window.setInterval(reload,15000);const onVisible=()=>reload();document.addEventListener('visibilitychange',onVisible);
  return()=>{epoch.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',onVisible);};},[runtime,subjectId,connected]);
 function changed(action:()=>void){action();setPreview(null);setPermissionPreview(null);}
 function add(ref:any,permissionId?:string,permissionExpiresAt?:number){changed(()=>setSelections(old=>[...old.filter(x=>JSON.stringify(x.ref)!==JSON.stringify(ref)),{ref,mode:permissionId?'copy':'reference',...(permissionId?{permissionId,permissionExpiresAt}:{})}]));}
 async function inspectFile(file:File,apply:(f:()=>void)=>void){if(file.size>4500000)throw new Error('文件超过普通信任包的大小限制。');const text=await file.text();
  const result=await verifyTrustPackage(text);const value=JSON.parse(text);apply(()=>{setImported(value);setReport(result);setOnline(null);setNotice('已在本浏览器离线核对；未打开包内链接，未创建业务事实。');});}
 return <section className="trust-package-workspace">
  <header className="page-heading"><h1>可携带信任资料</h1><p>选择自述与材料，带着可读说明、精确来源和签名交流。没有经历也可以开始。</p></header>
  {error&&<p className="message error" role="alert">{error}</p>}{notice&&<p className="message" role="status">{notice}</p>}
  <section className="task-card"><h2>离线查看收到的资料</h2><p>只核对文件完整性、所含身份历史与独立许可。签名有效不代表内容真实或具备某种能力。</p>
   <label htmlFor="trust-import">选择本机信任包 JSON 文件<Input id="trust-import" type="file" accept="application/json,.json" disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(file)void run(apply=>inspectFile(file,apply));e.target.value='';}}/></label>
   {report&&<div><p>主体：<code>{report.subjectId}</code></p><p>文件：{report.integrity==='valid'?'完整性通过':report.integrity}；签名：包含的控制历史内有效；时间状态：{report.temporalState}。</p>
    <p>当前撤销状态：尚未在线核对。能力：未认证。此包未导入为任务、履历或贡献。</p><pre style={{whiteSpace:'pre-wrap'}}>{report.summary}</pre>
    {report.sources.map((s:any)=><p key={s.ref.id+':'+s.ref.version}>{s.ref.kind} {s.ref.id}：许可 {s.reproductionPermission.status}；原签名 {s.originalSignature.status}。</p>)}
    {client&&connected&&<Button type="button" variant="outline" disabled={busy} onClick={()=>void run(async apply=>{const result=await client.checkOnline(imported,{selectedEndpoint:runtime.api.endpoint});apply(()=>setOnline(result.online));})}>只向已连接的服务查询当前状态</Button>}
    {online&&<div className="message"><p>核对服务：{online.selectedEndpoint}。没有上传整包，也没有跟随包内其他端点。</p><p>身份当前状态：{online.control.status}</p>{online.items.map((s:any)=><p key={s.ref.id+':'+s.ref.version}>{s.ref.id}：{s.status} {s.reason??''}</p>)}</div>}
   </div>}
  </section>
  {!subjectId||!client?<section className="task-card"><h2>准备自己的资料</h2><p>先建立或恢复本机银河身份。离线导入仍可使用。</p><Button type="button" onClick={()=>navigate('/app/settings/identity')}>打开身份设置</Button></section>:<>
  {client.refreshIdentity&&<div className="message"><p>原创自述平常只使用本机身份材料。首次获取或设备变化后，可以主动联网更新公开控制历史；不会上传整包或自述。</p>
   <Button type="button" variant="outline" disabled={busy} onClick={()=>void run(async apply=>{await client.refreshIdentity();apply(()=>{setPreview(null);setPermissionPreview(null);setNotice('身份公开资料已更新，可以重新准备本机资料包。');});})}>刷新身份公开资料</Button></div>}
  <form className="workspace-form" onSubmit={e=>{e.preventDefault();void run(async apply=>{const result=await client.prepare({claims:claim.trim()?[{id:crypto.randomUUID(),text:claim.trim(),authority:'self-asserted',capabilityVerified:false}]:[],
    selections:selections.map(({permissionExpiresAt,...selection})=>selection),audience:audience(),
    expiresAt:Math.min(expiry(),...selections.filter(s=>s.mode==='copy').map(s=>s.permissionExpiresAt??Infinity))});apply(()=>setPreview(result));});}}>
   <h2>准备自己的资料</h2><label htmlFor="trust-claim">本人自述（明确标为未验证，可留空）<Textarea id="trust-claim" maxLength={4000} value={claim} onChange={e=>changed(()=>setClaim(e.target.value))}/></label>
   <label htmlFor="trust-audience">这次的受众<select id="trust-audience" value={audienceKind} onChange={e=>changed(()=>setAudienceKind(e.target.value))}><option value="subjects">指定银河 ID</option><option value="public">公开</option></select></label>
   {audienceKind==='subjects'&&<label htmlFor="trust-recipients">受众银河 ID（多个用空格分开）<Textarea id="trust-recipients" required value={recipients} onChange={e=>changed(()=>setRecipients(e.target.value))}/></label>}
   <p>这是签署的使用范围；普通可读包没有加密，也无法阻止收件者转发。</p>
   <label htmlFor="trust-days">本包有效天数<Input id="trust-days" type="number" min={1} max={30} required value={days} onChange={e=>changed(()=>setDays(Number(e.target.value)))}/></label>
   {selections.some(s=>s.mode==='copy')&&<p>含复制许可时，本包期限最多到所选许可中最早的到期时间；确切预览会列出实际期限。</p>}
   <h3>已选择的材料</h3>{!selections.length&&<p>尚未选择来源。只带原创自述也可以生成。</p>}
   {selections.map((s,i)=><article className="message" key={s.ref.kind+':'+s.ref.id+':'+s.ref.version}><p>{s.ref.kind} {s.ref.id} / {s.ref.version} · {s.mode==='copy'?'作者许可的精确记录':'仅本人引用'}</p>
    <Button type="button" variant="ghost" onClick={()=>changed(()=>setSelections(old=>old.filter((_,n)=>n!==i)))}>移除此材料</Button>
    {connected&&s.mode==='reference'&&<Button type="button" variant="outline" disabled={busy||!grantee} onClick={()=>void run(async apply=>{
     const result=await client.permissionPreview({id:crypto.randomUUID(),operationId:crypto.randomUUID(),source:s.ref,grantee:grantee.trim(),audience:audience(),expiresAt:expiry()});apply(()=>setPermissionPreview(result));})}>预览此材料的复制许可</Button>}
   </article>)}
   <Button type="submit" disabled={busy||!claim.trim()&&!selections.length}>生成确切预览</Button>
  </form>
  {connected&&<details className="room-settings"><summary>添加实际来源、管理复制许可</summary>
   <form className="workspace-form" onSubmit={e=>{e.preventDefault();void run(async apply=>{const value=await runtime.api.call(`/v2/cases/${caseId.trim()}/read`,taskId.trim()?{taskId:taskId.trim()}:{});apply(()=>setEvents(value.events));});}}>
    <label htmlFor="trust-case">已有 Case ID<Input id="trust-case" required value={caseId} onChange={e=>{setCaseId(e.target.value);setEvents([]);}}/></label>
    <label htmlFor="trust-task">相关 Task ID（需要任务上下文时填写）<Input id="trust-task" value={taskId} onChange={e=>{setTaskId(e.target.value);setEvents([]);}}/></label>
    <Button type="submit" variant="outline" disabled={busy}>读取我当前可见的事实</Button>
   </form>
   {events.map(e=><article className="message" key={e.eventId}><p>{e.kind} · Case 版本 {e.caseVersion} · {summary(e)}</p>
    <Button type="button" variant="outline" disabled={e.actorId!==subjectId} onClick={()=>add({endpoint:runtime.api.endpoint,kind:'case-event',id:e.eventId,caseId:e.caseId,version:e.caseVersion,...(taskId.trim()?{taskId:taskId.trim()}:{})})}>选择本人事实引用</Button>
    {e.actorId!==subjectId&&<p>其他作者的当前阅读权不等于携带许可。请由原作者签署专门许可。</p>}</article>)}
   <form className="workspace-form" onSubmit={e=>{e.preventDefault();add({endpoint:runtime.api.endpoint,kind,id:recordId.trim(),version});}}>
    <label htmlFor="trust-record-kind">已有记录类型<select id="trust-record-kind" value={kind} onChange={e=>setKind(e.target.value)}><option value="evidence">Evidence</option><option value="verification">Verification</option></select></label>
    <label htmlFor="trust-record-id">本人记录 ID<Input id="trust-record-id" required value={recordId} onChange={e=>setRecordId(e.target.value)}/></label>
    <label htmlFor="trust-record-version">准确版本<Input id="trust-record-version" type="number" min={1} required value={version} onChange={e=>setVersion(Number(e.target.value))}/></label>
    <Button type="submit" variant="outline">加入引用候选并在预览时核对</Button>
   </form>
   <label htmlFor="trust-grantee">允许制作信任包的持包人银河 ID（本人也可以填自己）<Input id="trust-grantee" value={grantee} onChange={e=>changed(()=>setGrantee(e.target.value))}/></label>
   <h3>我已签署的许可</h3>{!licenses.length&&<p>本页尚未取得许可记录。</p>}{licenses.map(p=><article className="message" key={p.id}><p>{p.source.kind} {p.source.id} / {p.source.version} · {p.status}</p><p>持包人：{p.granteeId}；许可 ID：{p.id}</p>
   <Button type="button" variant="outline" disabled={busy||p.status==='revoked'} onClick={()=>void run(async apply=>{const result=await client.permissionPreview({id:p.id,operationId:crypto.randomUUID()},{revoke:true});apply(()=>setPermissionPreview(result));})}>预览撤销</Button></article>)}
   {authorNext&&<Button type="button" variant="outline" disabled={busy} onClick={()=>{const lease=epoch.current;void runtime.api.call('/v2/trust-package/permissions/query',{role:'author',after:authorNext}).then((p:any)=>{if(lease===epoch.current){setLicenses(old=>[...old,...p.items]);setAuthorNext(p.nextAfter);}}).catch((e:any)=>{if(lease===epoch.current)setError(reason(e));});}}>更多我签署的许可</Button>}
   <h3>我收到的专用许可</h3>{!received.length&&<p>本页尚未取得可用许可。</p>}{received.map(p=><article className="message" key={p.id}><p>{p.source.kind} {p.source.id} / {p.source.version} · {p.status}</p>
    <p>许可到期：{new Date(p.expiresAt*1000).toLocaleString()}。</p><Button type="button" variant="outline" disabled={p.status!=='active'} onClick={()=>add(p.source,p.id,p.expiresAt)}>选择这份精确许可材料</Button></article>)}
   {recipientNext&&<Button type="button" variant="outline" disabled={busy} onClick={()=>{const lease=epoch.current;void runtime.api.call('/v2/trust-package/permissions/query',{role:'grantee',after:recipientNext}).then((p:any)=>{if(lease===epoch.current){setReceived(old=>[...old,...p.items]);setRecipientNext(p.nextAfter);}}).catch((e:any)=>{if(lease===epoch.current)setError(reason(e));});}}>更多收到的许可</Button>}
  </details>}
  {permissionPreview&&<article className="task-card"><h2>核对作者许可</h2><p>只授权选定记录、持包人、受众和期限。不会复制原 Consent 的其他收件人，也不会授予线上访问或训练权。</p>
   {permissionPreview.sourcePreview&&<pre style={{whiteSpace:'pre-wrap'}}>{permissionPreview.sourcePreview.bodyText}</pre>}
   <pre style={{whiteSpace:'pre-wrap'}}>{permissionPreview.payloadJson}</pre><div className="button-row">
    <Button type="button" disabled={busy} onClick={()=>void run(async apply=>{const p=permissionPreview;apply(()=>setPermissionPreview(null));const result=await client.executePermission(p,{confirmed:true});apply(()=>setNotice(`许可操作已记录：${result.status}。`));})}>签署并提交这份许可操作</Button>
    <Button type="button" variant="ghost" onClick={()=>{setPermissionPreview(null);setNotice('已拒绝此次预览，未提交新许可。');}}>不签署</Button></div></article>}
  {preview&&<article className="task-card"><h2>确切导出预览</h2>{preview.state!=='ready'?<><p>以下来源尚不能带入，请调整选择。</p>{preview.items.filter((s:any)=>s.state!=='available').map((s:any)=><p key={s.ref.id}>{s.ref.id}：{s.reason}</p>)}</>:<>
   <pre style={{whiteSpace:'pre-wrap'}}>{preview.files['summary.md']}</pre><details><summary>核对将携带的完整结构化内容</summary><pre style={{whiteSpace:'pre-wrap'}}>{preview.files['objects.json']}</pre></details>
   <Button type="button" disabled={busy} onClick={()=>void run(async apply=>{const p=preview;apply(()=>setPreview(null));const result=await client.exportPackage(p,{confirmed:true});apply(()=>{setContainer(result.container);setNotice('已使用本机设备签署并保存在本机，未发布到云端。');});})}>确认这些内容并在本机签署</Button>
   <Button type="button" variant="ghost" onClick={()=>setPreview(null)}>取消预览</Button></>}</article>}
  {container&&<article className="task-card"><h2>下载签署后的资料</h2><div className="button-row"><Button type="button" onClick={()=>download('galaxy-trust-package.json',JSON.stringify(container), 'application/json')}>下载完整可导入包</Button>
   {Object.entries(container.files).map(([name,text])=><Button type="button" key={name} variant="outline" onClick={()=>download(name,text as string)}>{name}</Button>)}
   <Button type="button" variant="outline" onClick={()=>download('manifest.json',container.manifestJson)}>manifest.json</Button><Button type="button" variant="outline" onClick={()=>download('manifest.jws',container.signature)}>manifest.jws</Button>
   <Button type="button" variant="ghost" onClick={()=>void run(async apply=>{await client.deleteLocalExport();apply(()=>{setContainer(null);setNotice('已清除此处本机保存的导出包；已下载或发送的外部副本不在此操作内。');});})}>清除此处本机副本</Button></div></article>}
  {pending.length>0&&<section className="task-card"><h2>原许可操作待对账</h2>{pending.map(p=><article key={p.operationId}><p>{p.kind} · {p.id} · {p.state}</p><div className="button-row">
   <Button type="button" disabled={busy} variant="outline" onClick={()=>void run(async apply=>{const r=await client.reconcile(p.operationId);apply(()=>setNotice(`原操作状态：${r.status??r.state}`));})}>查询原回执</Button>
   <Button type="button" disabled={busy||p.state==='stopped-local'} variant="outline" onClick={()=>void run(async apply=>{const r=await client.retry(p.operationId);apply(()=>setNotice(`相同签名操作：${r.status??r.state}`));})}>重试同一签名</Button>
   <Button type="button" disabled={busy||p.state==='stopped-local'} variant="ghost" onClick={()=>void run(async apply=>{const r=await client.stopRetry(p.operationId);apply(()=>setNotice(r.state==='stopped-local'?'已停止本机重试，服务端取消未确认；仍保留原 ID 对账。':`原操作已记录：${r.status}`));})}>停止本机重试</Button>
  </div></article>)}</section>}
 </>}
 </section>;
}
