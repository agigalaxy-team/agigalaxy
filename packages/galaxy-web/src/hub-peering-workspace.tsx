import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {peeringAgreementSchema,peeringSummaryFields} from '../../galaxy-official/src/shared/hub-peering-v2-schema.mjs';
type Props={client:any;hubId:string;owner:boolean;subjectId:string;onPending:()=>void};
const fieldNames:Record<string,string>={eventType:'贡献类型',actorId:'本人银河 ID',role:'当次角色',interventionTypes:'实际介入方式',scopeVersion:'当次范围版本',reportedOutcome:'作者报告的结果',time:'记录时间'};
export function HubPeeringWorkspace({client,hubId,owner,subjectId,onPending}:Props){
  const [connections,setConnections]=useState<any[]>([]),[connectionAfter,setConnectionAfter]=useState<string|null>(null),[agreementId,setAgreementId]=useState('');
  const [agreements,setAgreements]=useState<any[]>([]),[agreementAfter,setAgreementAfter]=useState<string|null>(null),[grants,setGrants]=useState<any[]>([]),[grantAfter,setGrantAfter]=useState<string|null>(null);
  const [localParty,setLocalParty]=useState<any>(null),[peerParty,setPeerParty]=useState(''),[agreementText,setAgreementText]=useState('');
  const [kind,setKind]=useState('case-event'),[parentId,setParentId]=useState(''),[sources,setSources]=useState<any[]>([]),[sourceAfter,setSourceAfter]=useState<string|null>(null),[source,setSource]=useState<any>(null);
  const [fields,setFields]=useState<string[]>(['eventType','actorId']),[readers,setReaders]=useState(''),[sourcePreview,setSourcePreview]=useState<any>(null),[preview,setPreview]=useState<any>(null);
  const [result,setResult]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const epoch=useRef(0),running=useRef(false);
  useEffect(()=>{epoch.current++;setConnections([]);setAgreements([]);setGrants([]);setSources([]);setResult(null);setPreview(null);setSourcePreview(null);setSource(null);setAgreementId('');setLocalParty(null);setAgreementText('');setPeerParty('');setError('');setBusy(false);},[client,hubId,subjectId]);
  useEffect(()=>{if(!result?.expiresAt)return;const t=setTimeout(()=>setResult(null),Math.max(0,result.expiresAt*1000-Date.now()));return()=>clearTimeout(t);},[result]);
  const run=async(fn:(valid:()=>boolean)=>Promise<void>)=>{if(running.current)return;const token=epoch.current,valid=()=>token===epoch.current;running.current=true;setBusy(true);setError('');setMessage('');
    try{await fn(valid);}catch(e:any){if(valid())setError((typeof e?.message==='string'&&e.message.trim()?e.message:'操作暂未完成，请核对原操作。'));}finally{running.current=false;if(valid())setBusy(false);}};
  const base=(kind:string)=>({schemaVersion:2,id:crypto.randomUUID(),hubId,kind});
  const selectedSource=()=>source?.kind==='contribution-summary'?{...source,fields}:source;
  async function listConnections(next?:string){await run(async valid=>{const p=await client.peering('connections',{hubId,...(next?{after:next}:{})});if(valid()){setConnections(x=>next?[...x,...p.items]:p.items);setConnectionAfter(p.nextCursor);}});}
  async function owned(which:'agreements'|'grants',next?:string){await run(async valid=>{const p=await client.peering('list',{hubId,kind:which,...(next?{after:next}:{})});if(valid()){
    if(which==='agreements'){setAgreements(x=>next?[...x,...p.items]:p.items);setAgreementAfter(p.nextCursor);}else{setGrants(x=>next?[...x,...p.items]:p.items);setGrantAfter(p.nextCursor);}}});}
  async function findSources(next?:string){await run(async valid=>{const p=await client.peering('sources',{hubId,kind,...(kind==='ci-proof-v2'?{}:{parentId:parentId.trim()}),...(next?{after:next}:{})});
    if(valid()){setSources(x=>next?[...x,...p.items]:p.items);setSourceAfter(p.nextCursor);}});}
  async function query(after=0,recheck:string[]=[]){await run(async valid=>{setResult(null);const p=await client.peering('query',{hubId,agreementId:agreementId.trim(),queryId:crypto.randomUUID(),after,recheck});if(valid())setResult(p);});}
  function prepareAgreement(){const agreement=peeringAgreementSchema.parse(JSON.parse(agreementText));setPreview({...base('peer-approve'),expectedVersion:agreement.version-1,agreement});}
  return <section className="task-card"><h2>向已选社区查询获准的帮助依据</h2><p>互联可返回原始 CI 观察证明和作者明确选定的贡献摘要。普通阅读、加入社区和公开任务都不会自动授权跨社区分享。</p>
    <Button type="button" disabled={busy} onClick={()=>listConnections()}>查看本次可选直连范围</Button>
    {connections.map(c=><div key={c.agreementId}><p>{c.peer} · 第 {c.version} 版 · 需实际查询确认对端状态</p><Button type="button" disabled={busy} onClick={()=>{setAgreementId(c.agreementId);setResult(null);setSourcePreview(null);}}>选择此范围</Button></div>)}
    {connectionAfter&&<Button type="button" disabled={busy} onClick={()=>listConnections(connectionAfter)}>更多范围</Button>}
    <label>双方约定的范围 ID<input value={agreementId} onChange={e=>{setAgreementId(e.target.value);setResult(null);setSourcePreview(null);}}/></label>
    <Button type="button" disabled={busy||!agreementId.trim()} onClick={()=>query()}>查询当前获准材料</Button>
    {result&&<div><p>{result.state==='unknown'?'对端状态或查询结果未确认。本次不沿用旧结果。':'本次返回已核对的选定材料；不构成独立能力认证。'}</p>
      {result.checkedAt&&<p>核对时间 {new Date(result.checkedAt*1000).toLocaleString()}；本页结果仅在该短期核对窗口显示。</p>}
      {result.items?.map((item:any)=><article key={item.grantId}><p>来源许可 {item.grantId}：{item.state==='current'?'当前可读':'已无法取得；不保留原正文'}</p>
        {item.state==='current'&&<><p>来源签发方：{item.issuer} · {item.synthetic===true?'合成验证材料':item.synthetic===null?'演示属性未确认':'未标记为合成材料'}</p>
          {item.projection?<dl>{Object.entries(item.projection).map(([k,v])=><React.Fragment key={k}><dt>{fieldNames[k]??k}</dt><dd>{typeof v==='string'?v:JSON.stringify(v)}</dd></React.Fragment>)}</dl>
            :<p>原始 CI 观察证明已保留签发方签名；代码托管方观察结果不等于第三方专家验证。</p>}
          <details><summary>精确来源和原签名</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(item,null,2)}</pre></details></>}
      </article>)}
      {result.items?.length===0&&result.state!=='unknown'&&<p>本次没有对你开放的材料；这不表示没有帮助能力或没有贡献。</p>}
      {result.hasMore&&<Button type="button" disabled={busy} onClick={()=>query(result.nextCursor)}>下一页</Button>}
      {result.deferredRecheck?.length>0&&<div><p>部分来源尚未在本次大小限制内重新核对，不将其视为可用或已删除。</p><Button type="button" disabled={busy} onClick={()=>query(result.nextCursor,result.deferredRecheck)}>继续核对剩余来源</Button></div>}
      {result.items?.length>0&&<Button type="button" disabled={busy} onClick={()=>query(result.nextCursor,result.items.map((i:any)=>i.grantId).slice(0,20))}>重新核对当前页来源</Button>}
    </div>}
    <details><summary>选择本人可分享的具体材料</summary><p>原文权限保持独立。先选来源和字段，再指定对端银河 ID；保存不会计为成功复用。</p>
      <select value={kind} onChange={e=>{setKind(e.target.value);setSources([]);setSource(null);setSourcePreview(null);}}><option value="case-event">本人 Case 贡献</option><option value="task-event">本人 Task 贡献</option><option value="ci-proof-v2">本人已发布的 CI 观察证明</option></select>
      {kind!=='ci-proof-v2'&&<label>{kind==='case-event'?'Case':'Task'} ID<input value={parentId} onChange={e=>{setParentId(e.target.value);setSource(null);setSourcePreview(null);}}/></label>}
      <Button type="button" disabled={busy||kind!=='ci-proof-v2'&&!parentId.trim()} onClick={()=>findSources()}>查找本人精确来源</Button>
      {sources.map((s,i)=><div key={i}><p>{s.eventType} · {s.source.id??s.source.source.id}</p><Button type="button" disabled={busy} onClick={()=>{setSource(s.source);setSourcePreview(null);setFields(['eventType','actorId']);}}>选取此来源</Button></div>)}
      {sourceAfter&&<Button type="button" disabled={busy} onClick={()=>findSources(sourceAfter)}>更多来源</Button>}
      {source?.kind==='contribution-summary'&&<fieldset><legend>只披露选中的结构字段</legend>{peeringSummaryFields.map(f=><label key={f}><input type="checkbox" checked={fields.includes(f)} disabled={['eventType','actorId'].includes(f)} onChange={e=>{setFields(x=>e.target.checked?[...new Set([...x,f])]:x.filter(y=>y!==f));setSourcePreview(null);}}/>{fieldNames[f]}</label>)}</fieldset>}
      <label>允许读取的对端银河 ID（每行一项）<textarea value={readers} onChange={e=>{setReaders(e.target.value);setPreview(null);}}/></label>
      <Button type="button" disabled={busy||!source||!agreementId.trim()} onClick={()=>run(async valid=>{const p=await client.peering('preview',{hubId,agreementId:agreementId.trim(),source:selectedSource()});if(valid())setSourcePreview(p);})}>预览精确披露内容</Button>
      {sourcePreview&&<><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(sourcePreview.projection,null,2)}</pre><p>本次许可最多持续 24 小时，并受双方范围、原材料权限与到期时间限制。</p>
        <Button type="button" disabled={busy||!readers.trim()} onClick={()=>setPreview({...base('source-grant'),agreementId:agreementId.trim(),agreementVersion:sourcePreview.agreementVersion,source:sourcePreview.source,
          requesterIds:[...new Set(readers.split(/\s+/).filter(Boolean))],expiresAt:Math.min(sourcePreview.maxExpiresAt,Math.floor(Date.now()/1000)+86400),purpose:'selected-peering-read-only',disclosure:'exact-proof-or-selected-nonnarrative-contribution-fields',redactionConfirmed:true})}>预览本次许可</Button></>}
      <Button type="button" disabled={busy} onClick={()=>owned('grants')}>本人已给出的许可</Button>{grants.map(g=><div key={g.id}><p>{g.id} · {g.state} · 到期 {new Date(g.expiresAt*1000).toLocaleString()}</p>
        {g.state!=='revoked'&&<Button type="button" disabled={busy} onClick={()=>setPreview({...base('source-revoke'),grantId:g.id})}>撤销这项许可</Button>}</div>)}{grantAfter&&<Button type="button" disabled={busy} onClick={()=>owned('grants',grantAfter)}>更多许可</Button>}
    </details>
    {owner&&<details><summary>运营者配置直接互联</summary><p>双方各自确认完全相同的约定。公钥需按双方选定的渠道核对；填入地址或报告不会证明独立运营、上线或兼容。</p>
      <Button type="button" disabled={busy} onClick={()=>run(async valid=>{const p=await client.peering('party',{hubId});if(valid())setLocalParty(p.party);})}>读取本服务公开身份字段</Button>
      {localParty&&<><label>可交给对方核对的本方公开字段<textarea readOnly value={JSON.stringify(localParty,null,2)}/></label><label>对方明确提供的公开字段<textarea value={peerParty} onChange={e=>setPeerParty(e.target.value)}/></label>
        <Button type="button" disabled={busy||!peerParty.trim()} onClick={()=>run(async()=>{const other=JSON.parse(peerParty),now=Math.floor(Date.now()/1000),parties=[localParty,other].sort((a,b)=>a.endpoint.localeCompare(b.endpoint));
          const draft={profile:'galaxy-direct-proof/1',id:crypto.randomUUID(),version:1,parties,sourceKinds:['contribution-summary','ci-proof-v2'],purpose:'help-discovery',ratePerMinute:10,pageSize:5,
            expiresAt:Math.min(now+86400,...parties.flatMap(p=>p.keys.map((k:any)=>k.notAfter))),responseMaxAgeSeconds:120,cache:'no-response-body-retention',route:'direct',officialProtocolFee:0,
            localEvaluationAuthority:'no-automatic-capability-upgrade',rawTaskContext:'excluded',intake:'each-party-hub-private-intake'};setAgreementText(JSON.stringify(peeringAgreementSchema.parse(draft),null,2));})}>生成可共同审阅的约定草稿</Button></>}
      <label>双方约定的完整 JSON（也可粘贴对方发来的精确版本）<textarea value={agreementText} onChange={e=>{setAgreementText(e.target.value);setPreview(null);}}/></label>
      <Button type="button" disabled={busy||!agreementText.trim()} onClick={()=>run(async()=>prepareAgreement())}>预览本地确认</Button>
      <Button type="button" disabled={busy} onClick={()=>owned('agreements')}>查看本方已有约定</Button>{agreements.map(a=><article key={a.id}><p>{a.id} · 第 {a.version} 版 · {a.state}</p>
        {a.record?.agreement&&<Button type="button" disabled={busy} onClick={()=>setAgreementText(JSON.stringify(a.record.agreement,null,2))}>载入原约定</Button>}
        {a.state!=='exited'&&<Button type="button" disabled={busy} onClick={()=>setPreview({...base('peer-exit'),agreementId:a.id,expectedVersion:a.version})}>退出此互联</Button>}</article>)}
      {agreementAfter&&<Button type="button" disabled={busy} onClick={()=>owned('agreements',agreementAfter)}>更多约定</Button>}
    </details>}
    {preview&&<div><h3>确认本次明确范围</h3><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(preview,null,2)}</pre><p>只提交这份原始内容和本机签署的许可。未知结果会保留原操作，先在页面底部核对回执。</p>
      <Button type="button" disabled={busy} onClick={()=>run(async valid=>{try{const r=await client.submit(preview,{family:'peering',confirmed:true});if(valid()){setPreview(null);setResult(null);setMessage('已记录本次操作；对端状态仍须实际查询。');if(r.kind==='peer-approve')setAgreementId(r.objectId);}}finally{onPending();}})}>确认并签署提交</Button>
      <Button type="button" disabled={busy} variant="ghost" onClick={()=>setPreview(null)}>取消</Button></div>}
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
  </section>;
}
