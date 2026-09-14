import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {createBuildersWebClient} from './builders-client.mjs';
type Props={runtime:any;subjectId?:string;connected:boolean;navigate?:(path:string)=>void};
const labels:Record<string,string>={'reported-pass':'该范围报告通过','reported-fail':'该范围报告失败','not-tested':'未测试',current:'当前可读','not-declared':'尚未声明',unavailable:'当前不可用','stale-declaration':'只适用旧声明','stale-support':'只适用旧支持范围',expired:'已到期',superseded:'已被后续报告替代','assessor-removed':'评估者已不在配置范围'};
export function BuildersWorkspace({runtime,subjectId,connected,navigate}:Props){
  const client=useMemo(()=>runtime?createBuildersWebClient(runtime,{subjectId}):null,[runtime,subjectId]);
  const [items,setItems]=useState<any[]>([]),[after,setAfter]=useState<string|null>(null),[owned,setOwned]=useState(false);
  const [query,setQuery]=useState(''),[type,setType]=useState(''),[selected,setSelected]=useState<any>(null),[management,setManagement]=useState<any>(null);
  const [kind,setKind]=useState('support-profile'),[json,setJson]=useState(''),[visibility,setVisibility]=useState('Private'),[viewers,setViewers]=useState('');
  const [preview,setPreview]=useState<any>(null),[pending,setPending]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const epoch=useRef(0),running=useRef(false);
  useEffect(()=>{epoch.current++;setItems([]);setSelected(null);setManagement(null);setPreview(null);setPending(null);setError('');setBusy(false);setJson('');
    const token=epoch.current;const reload=()=>{if(document.visibilityState!=='visible'||busy||!connected||!client)return;client.local().then((local:any)=>{if(epoch.current===token)setPending(local.pending);}).catch(()=>{});};
    const timer=window.setInterval(reload,20000);document.addEventListener('visibilitychange',reload);
    return()=>{epoch.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',reload);};},[client,connected]);
  async function run(fn:(valid:()=>boolean)=>Promise<void>){if(!client||running.current)return;const token=epoch.current,valid=()=>token===epoch.current;running.current=true;setBusy(true);setError('');setNotice('');
    try{await fn(valid);}catch(e:any){if(valid())setError(typeof e?.message==='string'&&e.message.trim()?e.message:'构建者操作暂未完成，请先核对原回执。');}finally{running.current=false;if(valid())setBusy(false);}}
  const refreshLocal=async(valid:()=>boolean)=>{if(connected){const local=await client!.local();if(valid())setPending(local.pending);}};
  async function open(builderId:string,valid:()=>boolean,recover=false){
    if(!valid())return;
    setSelected(null);setManagement(null);setPreview(null);setJson('');setVisibility('Private');setViewers('');
    if(recover&&connected){const m=await client!.manage(builderId);if(!valid())return;setManagement(m);
      if(m.declarationState!=='readable'){setNotice('可重新声明，或发布下架／纠正／安全公告；不恢复旧正文。');return;}}
    const value=await client!.read(builderId,connected);if(!valid())return;
    if(connected&&!recover&&value.entry.ownerId===subjectId){const m=await client!.manage(builderId);if(!valid())return;setManagement(m);}
    if(valid()){setSelected(value);const disclosure=value.extensions.disclosure??value.extensions.reportDisclosure;
      if(disclosure){setVisibility(disclosure.visibility);setViewers(disclosure.viewers.join('\n'));}}
  }
  async function list(mine:boolean,next?:string){await run(async valid=>{const input={...(type?{type}:{}),...(next?{after:next}:{}),limit:8};
    const page=mine?await client!.owned(input):await client!.query({...input,query},connected);
    if(valid()){setItems(old=>next?[...old,...page.items]:page.items);setAfter(page.nextAfter);setOwned(mine);}await refreshLocal(valid);});}
  function prepare(){
    try{
      const content=JSON.parse(json),entry=selected?.entry??management,base={id:crypto.randomUUID(),builderId:entry?.builderId??crypto.randomUUID(),expectedRevision:entry?.revision??0,kind};
      const event=kind==='declare'?{...base,declaration:content}:{...base,declarationId:entry?.declarationId,declarationHash:entry?.declarationHash,
        ...(kind==='support-profile'?{support:content}:kind==='pack-manifest'?{manifest:content}:content)};
      if(kind==='maintenance')delete event.declarationHash;
      if(kind!=='declare'&&!entry)throw new Error('先打开准确登记版本。');
      const disclosure=kind==='scope-report'?selected?.extensions.reportDisclosure:selected?.extensions.disclosure;
      setPreview({event,visibility:disclosure?.visibility??visibility,viewers:disclosure?.viewers??viewers.split(/\s+/).filter(Boolean)});setError('');
    }catch(e:any){setError('内容尚未准备好：'+e.message);}
  }
  function useCurrent(){
    const ext=selected?.extensions,entry=selected?.entry;
    const value=kind==='declare'?entry?.declaration:kind==='support-profile'?ext?.support.record:kind==='pack-manifest'?ext?.pack.record:null;
    if(value)setJson(JSON.stringify(value,null,2));else setError('没有当前可读内容可沿用。请按字段说明准备自己的资料。');
  }
  const download=(value:any)=>{const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='galaxy-worker-pack-reference.json';a.click();URL.revokeObjectURL(url);};
  if(!client)return <section className="help-intro"><h2>建设者</h2><p>服务配置加载后，可浏览 Agent、工具接入和社区登记。</p></section>;
  return <section className="workspace-section"><h1>建设者与兼容范围</h1><p>查看组件能做什么、哪些范围有测试报告，以及版本、许可和使用条件。登记与报告不代表专业能力认证，下载清单不会运行 Agent。</p>
    <form className="workspace-form" onSubmit={e=>{e.preventDefault();list(false);}}>
      <label>类型<select value={type} onChange={e=>setType(e.target.value)}><option value="">全部</option><option value="worker">Agent / Worker</option><option value="bridge">外部来源适配</option><option value="hub">社区 / Hub</option></select></label>
      <label>名称或适用范围<input value={query} onChange={e=>setQuery(e.target.value)} maxLength={200}/></label>
      <Button type="submit" disabled={busy}>查询当前可读登记</Button>
      <Button type="button" variant="outline" disabled={busy||!connected} onClick={()=>list(true)}>我的登记与恢复</Button>
    </form>
    {items.map(row=><article className="task-card" key={row.builderId}><h3>{row.name??'正文当前不可用的登记'}</h3><p>{row.type} · {row.version??'修订 '+row.revision}</p>
      <Button type="button" disabled={busy} onClick={()=>run(valid=>open(row.builderId,valid,owned))}>查看范围与管理</Button></article>)}
    {after&&<Button type="button" variant="outline" disabled={busy} onClick={()=>list(owned,after)}>下一页</Button>}
    {!items.length&&<p>当前列表为空。可以查询其他范围；没有登记不表示没有能力。</p>}
    {selected&&<article className="task-card"><h2>{selected.entry.declaration.name}</h2><p>登记：{selected.entry.registration.state}；端点观察：{selected.entry.reachability.state}。端点观察不代表能执行任务。</p>
      <p>节点批准：{selected.entry.nodeControl.state}；原兼容报告：{labels[selected.entry.compatibility.state]??selected.entry.compatibility.state}。</p>
      <h3>支持清单</h3><p>{labels[selected.extensions.support.state]??selected.extensions.support.state}</p>
      {selected.extensions.support.record&&<><p>{selected.extensions.support.record.limitations}</p><p>明确缺项：{selected.extensions.support.record.missingCapabilities.join('、')||'作者未另列缺项，仍不代表全功能支持'}</p></>}
      {selected.extensions.support.testedScopes.map((item:any)=><div key={item.action}><strong>{item.action}</strong>：{labels[item.state]}{item.observations.map((o:any)=><p key={o.reportId}>{o.testClass} · {o.detail}</p>)}</div>)}
      <details><summary>支持范围、映射与分范围报告原数据</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({support:selected.extensions.support,reports:selected.extensions.reports},null,2)}</pre></details>
      <h3>Pack 版本与许可</h3><p>{labels[selected.extensions.pack.state]??selected.extensions.pack.state}</p>
      {selected.extensions.pack.record&&<><p>{selected.extensions.pack.record.name} {selected.extensions.pack.record.version} · {selected.extensions.pack.record.license}</p>
        <p>{selected.extensions.pack.record.modelRequirements}</p><p>{selected.extensions.pack.record.environment}</p>
        {navigate&&<Button type="button" variant="outline" onClick={()=>navigate('/app/worker-packs?'+new URLSearchParams({builderId:selected.entry.builderId,manifestId:selected.extensions.pack.eventId}))}>查看或记录这个版本的实际使用</Button>}
        <details><summary>依赖、权限、安装、升级与回退</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(selected.extensions.pack.record,null,2)}</pre></details>
        <Button type="button" disabled={busy||selected.extensions.delisted||selected.extensions.securityIssue} onClick={()=>run(async valid=>{const value=await client.exportPack(selected.entry.builderId,selected.extensions.pack.eventId,connected);if(valid()){download(value);setNotice('已下载选定版本清单。安装使用原作者与宿主机制；没有启动 Agent 或增加成功经历。');}})}>核对当前版本并下载清单</Button></>}
      <details><summary>原声明、维护与历史报告</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(selected.entry,null,2)}</pre></details>
    </article>}
    {connected?<section className="help-intro"><h2>准备并发布准确资料</h2><p>建设者使用结构化资料，以保留全部版本、依赖和映射字段。自由文本需先移除秘密和未获许可内容；页面不会抓取引用地址。</p>
      <p><a href="/docs/builders-support-v2.md" target="_blank" rel="noreferrer">字段与接入说明</a></p>
      <Button type="button" variant="outline" disabled={busy} onClick={()=>{setSelected(null);setManagement(null);setKind('declare');setJson('');setPreview(null);setVisibility('Private');setViewers('');}}>新建登记</Button>
      {management?.declarationState==='unavailable'&&<p>当前管理登记 {management.builderId}，修订 {management.revision}；旧声明正文不可用。</p>}
      <form className="workspace-form" onSubmit={e=>{e.preventDefault();prepare();}}>
        <label>本次资料<select value={kind} onChange={e=>{setKind(e.target.value);setJson('');setPreview(null);}}><option value="declare">首次声明／声明新版本</option><option value="support-profile">支持清单与映射</option><option value="pack-manifest">Pack 清单</option><option value="scope-report">分范围实测报告（配置评估者）</option><option value="maintenance">维护公告／下架／恢复</option></select></label>
        <Button type="button" variant="ghost" onClick={useCurrent}>沿用当前可读内容继续修改</Button>
        <label>资料 JSON<textarea rows={16} value={json} onChange={e=>{setJson(e.target.value);setPreview(null);}} required spellCheck={false}/></label>
        <label>可见范围<select value={visibility} onChange={e=>{setVisibility(e.target.value);setPreview(null);}}><option value="Private">本人及明确查看者</option><option value="Public">公开</option></select></label>
        {visibility==='Private'&&<label>额外查看者 Galaxy ID（空白分隔）<textarea value={viewers} onChange={e=>{setViewers(e.target.value);setPreview(null);}}/></label>}
        <p>扩展和报告沿用原声明允许范围；扩大范围需要发布新的明确声明，不能靠报告扩大。</p>
        <Button type="submit" disabled={busy}>预览准确内容与范围</Button>
      </form>
      {preview&&<section><h3>本次发送预览</h3><p>{preview.visibility==='Public'?'公开发布':'仅指定范围'}；这不会安装、执行、自动申请或授予模型材料。</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(preview,null,2)}</pre>
        <Button type="button" disabled={busy} onClick={()=>run(async valid=>{try{const receipt=await client.submit(preview.event,{visibility:preview.visibility,viewers:preview.viewers,confirmed:true});
          if(valid()){setPreview(null);setNotice('已保存声明事件，修订 '+receipt.revision+'；业务能力并未因此认证。');}await open(receipt.builderId,valid);}finally{await refreshLocal(valid);}})}>确认这份内容并发布</Button>
        <Button type="button" variant="ghost" onClick={()=>setPreview(null)}>取消</Button>
      </section>}
      <Button type="button" variant="outline" disabled={busy} onClick={()=>run(refreshLocal)}>检查本机未确认操作</Button>
      {pending&&<section><p>上次 {pending.event.kind} 操作尚待核对。原载荷已经保留。</p><Button type="button" disabled={busy} onClick={()=>run(async valid=>{const r=await client.reconcile();if(valid())setNotice('原操作回执：'+r.state);await refreshLocal(valid);})}>查询原回执</Button>
        <Button type="button" disabled={busy} onClick={()=>run(async valid=>{await client.reconcile({retry:true,confirmed:true});await refreshLocal(valid);})}>仅重试原操作</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={()=>run(async valid=>{await client.discard();await refreshLocal(valid);if(valid())setNotice('已核对后放弃本机重试；已经收到的事件不被删除。');})}>核对并放弃重试</Button></section>}
    </section>:<p>公开资料可以浏览；连接身份后可登记和管理自己的资料。</p>}
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  </section>;
}
