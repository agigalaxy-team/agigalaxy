import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {createHubsWebClient} from './hubs-client.mjs';
import {HubPeeringWorkspace} from './hub-peering-workspace';
type Props={runtime:any;subjectId?:string;connected:boolean};
const fields:Record<string,string>={scope:'服务范围',constituency:'服务对象',operator:'运营者',governance:'治理和责任',memberBenefits:'成员获得的帮助',commercialModel:'费用与商业规则',evidenceSources:'接受的证据来源',strengthMapping:'如何解释证据强度',membershipPolicy:'加入规则',workerPolicy:'Agent 与 Worker 规则',visibility:'可见和分享范围',retention:'保留与删除',residency:'数据存放区域',training:'训练用途',qualification:'资格规则',honor:'贡献与荣誉',reputation:'评价视图',bridgeMapping:'外部来源映射',conformance:'兼容范围',exportPolicy:'可携带导出',exitPolicy:'退出影响',successMetrics:'怎样衡量实际价值'};
const statuses:Record<string,string>={declared:'运营者声明',unknown:'未核实','reported-tested':'引用有限测试报告','reported-pass':'该项报告通过','reported-fail':'该项报告未通过','reported-not-tested':'该项未测试','report-unavailable':'当前无法核对报告',active:'当前可用','historical-version':'历史版本','declaration-changed':'登记版本已改变','declaration-unavailable':'登记当前不可用',suspended:'已暂停',invited:'邀请待确认',declined:'已拒绝',exited:'已退出',removed:'运营者已移除','charter-reconfirmation-required':'需按新章程重新邀请和确认','awaiting-member-confirmation':'等待成员确认','permission-unavailable':'授权当前不可用',expired:'已到期',inactive:'范围已关闭'};
const scopeNames:Record<string,string>={'approved-proof-query':'在另有材料许可时查询证明','member-updates':'查看本人的成员范围更新'};
export function HubsWorkspace({runtime,subjectId,connected}:Props){
  const client=useMemo(()=>runtime?createHubsWebClient(runtime,{subjectId}):null,[runtime,subjectId]);
  const [items,setItems]=useState<any[]>([]),[after,setAfter]=useState<string|null>(null),[listView,setListView]=useState('public'),[hubId,setHubId]=useState('');
  const [selected,setSelected]=useState<any>(null),[members,setMembers]=useState<any[]>([]),[memberAfter,setMemberAfter]=useState<string|null>(null),[threads,setThreads]=useState<any[]>([]),[threadAfter,setThreadAfter]=useState<string|null>(null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[preview,setPreview]=useState<any>(null),[pending,setPending]=useState<any>(null);
  const [draft,setDraft]=useState<any>(null),[builder,setBuilder]=useState<any>(null),[invitee,setInvitee]=useState(''),[scopeSelection,setScopeSelection]=useState<string[]>(['approved-proof-query']);
  const [title,setTitle]=useState(''),[body,setBody]=useState(''),[reply,setReply]=useState<Record<string,string>>({});
  const epoch=useRef(0),running=useRef(false),isOwner=!!selected&&selected.ownerId===subjectId;
  useEffect(()=>{epoch.current++;setItems([]);setAfter(null);setSelected(null);setMembers([]);setThreads([]);setDraft(null);setBuilder(null);setPreview(null);setPending(null);setError('');setBusy(false);
    const token=epoch.current;const refresh=()=>{if(document.visibilityState!=='visible'||running.current||!client||!connected)return;client.local().then((l:any)=>{if(epoch.current===token)setPending(l.pending);}).catch((e:any)=>{if(epoch.current===token)setError(e.message??'暂时无法核对 Hub 操作。');});};
    const timer=window.setInterval(refresh,15000);const onVisible=()=>refresh();document.addEventListener('visibilitychange',onVisible);
    return()=>{epoch.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',onVisible);};},[client,connected]);
  function requireClient(){if(!client)throw new Error('服务配置尚未加载。');return client;}
  async function run(fn:(valid:()=>boolean)=>Promise<void>){if(!client||running.current)return;const token=epoch.current,valid=()=>token===epoch.current;running.current=true;setBusy(true);setError('');setNotice('');
    try{await fn(valid);}catch(e:any){if(valid())setError((typeof e?.message==='string'&&e.message.trim()?e.message:'操作暂未完成，请核对原回执。'));}finally{running.current=false;if(valid())setBusy(false);}}
  async function refreshPending(valid:()=>boolean){if(connected){const l=await requireClient().local();if(valid())setPending(l.pending);}}
  async function open(id:string,valid:()=>boolean){if(!valid())return;setSelected(null);setMembers([]);setThreads([]);setPreview(null);setDraft(null);setBuilder(null);
    const s=await requireClient().read({hubId:id},connected);if(!valid())return;setSelected(s);setHubId(id);
    if(connected){const m=await requireClient().members({hubId:id});if(valid()){setMembers(m.items);setMemberAfter(m.nextCursor);}
      const t=await requireClient().intake({hubId:id});if(valid()){setThreads(t.items);setThreadAfter(t.nextCursor);}await refreshPending(valid);}}
  async function list(view:string,next?:string){await run(async valid=>{const p=await requireClient().query({view,...(next?{after:next}:{}),limit:12},connected&&view!=='public');
    if(valid()){setListView(view);setItems(old=>next?[...old,...p.items]:p.items);setAfter(p.nextCursor);}await refreshPending(valid);});}
  const prepare=(event:any,viewers:string[]=[],visibility='Private')=>{setPreview({event,viewers,visibility});setError('');};
  const base=(kind:string)=>({schemaVersion:2,id:crypto.randomUUID(),hubId:selected.hubId,kind});
  async function editCharter(valid:()=>boolean){const id=hubId.trim();const b=await requireClient().builder(id);if(!valid())return;
    if(b.type!=='hub'||!b.declaration)throw new Error('请先在建设者页完成本人 Hub 登记。');const management=await requireClient().manage({hubId:id});if(!valid())return;setBuilder({...b,charterVersion:management.latestVersion});
    const now=Math.floor(Date.now()/1000),blank=Object.fromEntries(Object.keys(fields).map(k=>[k,{text:'',status:'unknown',asOf:now}]));
    setDraft(management.current?structuredClone(management.current.charter):{profile:'galaxy-hub-charter/1',name:b.declaration.name,...blank,
      offeredScopes:['approved-proof-query'],intake:{kind:'hub-private-intake',responseTargetDays:7},routing:{direct:true,relay:'not-enabled',officialProtocolFee:0},
      pilot:{classification:'operator-declared-network',synthetic:false}});setPreview(null);}
  if(!client)return <section><h2>社区与 Hub</h2><p>服务配置加载后，可了解社区规则和当前可用范围。</p></section>;
  return <section className="workspace-section"><h1>社区与 Hub</h1><p>选择适合自己问题的社区，先了解能获得的帮助、材料范围和退出方式。加入社区保留原银河身份；各任务与聊天仍需各自授权。</p>
    <div><Button type="button" disabled={busy} onClick={()=>list('public')}>浏览公开社区</Button> <Button type="button" variant="outline" disabled={busy||!connected} onClick={()=>list('joined')}>我的邀请与加入记录</Button> <Button type="button" variant="outline" disabled={busy||!connected} onClick={()=>list('owned')}>我运营的社区</Button></div>
    {items.map(h=><article className="task-card" key={h.hubId}><h2>{h.charter.name}</h2><p>{h.charter.scope.text}</p><p>{h.charter.memberBenefits.text}</p><Button type="button" disabled={busy} onClick={()=>run(valid=>open(h.hubId,valid))}>查看章程与加入范围</Button></article>)}
    {after&&<Button type="button" disabled={busy} onClick={()=>list(listView,after)}>下一页</Button>}
    <form className="workspace-form" onSubmit={e=>{e.preventDefault();run(valid=>open(hubId.trim(),valid));}}><label>准确社区登记 ID<input required value={hubId} onChange={e=>setHubId(e.target.value)}/></label><Button type="submit" disabled={busy}>打开</Button></form>
    {selected&&<article className="task-card"><h2>{selected.charter.name}</h2><p>章程第 {selected.version} 版 · {statuses[selected.state]??selected.state}</p>
      {selected.charter.pilot.synthetic&&<p>此社区标记为合成演示，不能作为真实运营或成员规模证据。</p>}
      <p>{selected.charter.scope.text}</p><p>{selected.charter.memberBenefits.text}</p>
      {Object.entries(fields).map(([key,label])=><details key={key}><summary>{label} · {statuses[selected.claims[key]?.currentState]??'待核对'}</summary><p>{selected.charter[key].text}</p><p>声明日期：{new Date(selected.charter[key].asOf*1000).toLocaleString()}</p>
        {selected.charter[key].reportRef&&<p>仅引用报告中的 {selected.charter[key].reportRef.action}；不构成整个社区或专业能力认证。</p>}</details>)}
      <p>争议与问题通过下方私密受理区联系运营者。运营者声明的响应目标：{selected.charter.intake.responseTargetDays} 天。</p><p>直连无需官方协议费用；当前不启用中转。</p>
      <details><summary>版本与原登记关联</summary><p>章程事件 {selected.charterEventId}；原声明 {selected.declarationId}；摘要 {selected.declarationHash}。</p></details>
      {connected&&<section><h3>{isOwner?'成员管理':'我的加入范围'}</h3>{!members.length&&<p>当前没有可显示的成员记录。受邀后可在这里确认具体范围。</p>}
        {members.map(m=><div key={m.membershipId}><p>{m.memberId} · {statuses[m.state]??m.state} · {statuses[m.authorization]??m.authorization}；接受章程第 {m.charterVersion} 版。</p><p>{m.scopes.map((s:string)=>scopeNames[s]).join('、')}</p>
          {m.state==='invited'&&m.memberId===subjectId&&<><fieldset><legend>本次接受范围，可缩小</legend>{m.scopes.map((s:string)=><label key={s}><input type="checkbox" checked={scopeSelection.includes(s)} onChange={e=>setScopeSelection(old=>e.target.checked?[...old.filter(x=>x!==s),s]:old.filter(x=>x!==s))}/>{scopeNames[s]}</label>)}</fieldset>
            <Button type="button" disabled={busy||m.authorization!=='awaiting-member-confirmation'||!scopeSelection.some(s=>m.scopes.includes(s))} onClick={()=>prepare({...base('accept'),membershipId:m.membershipId,expectedVersion:m.version,charterVersion:m.charterVersion,acceptedScopes:scopeSelection.filter(s=>m.scopes.includes(s))},[selected.ownerId])}>预览并接受选定范围</Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={()=>prepare({...base('decline'),membershipId:m.membershipId,expectedVersion:m.version,charterVersion:m.charterVersion},[selected.ownerId])}>拒绝邀请</Button></>}
          {['active','invited'].includes(m.state)&&<Button type="button" variant="outline" disabled={busy} onClick={()=>prepare({...base(isOwner?'remove':'exit'),membershipId:m.membershipId,expectedVersion:m.version,charterVersion:m.charterVersion},[isOwner?m.memberId:selected.ownerId])}>{isOwner?'移除本次成员范围':'退出本次成员范围'}</Button>}
        </div>)}{memberAfter&&<Button type="button" disabled={busy} onClick={()=>run(async valid=>{const p=await client.members({hubId:selected.hubId,after:memberAfter});if(valid()){setMembers(x=>[...x,...p.items]);setMemberAfter(p.nextCursor);}})}>更多成员记录</Button>}
        {isOwner&&<form className="workspace-form" onSubmit={e=>{e.preventDefault();prepare({...base('invite'),membershipId:crypto.randomUUID(),memberId:invitee.trim(),expectedVersion:0,charterVersion:selected.version,scopes:scopeSelection.filter(s=>selected.charter.offeredScopes.includes(s)),expiresAt:Math.floor(Date.now()/1000)+1800},[invitee.trim()]);}}>
          <label>邀请已在本服务绑定的银河 ID<input required value={invitee} onChange={e=>setInvitee(e.target.value)}/></label><fieldset><legend>邀请范围</legend>{selected.charter.offeredScopes.map((s:string)=><label key={s}><input type="checkbox" checked={scopeSelection.includes(s)} onChange={e=>setScopeSelection(x=>e.target.checked?[...x.filter(y=>y!==s),s]:x.filter(y=>y!==s))}/>{scopeNames[s]}</label>)}</fieldset>
          <p>本次范围有效期为 30 分钟，用于受控加入体验。长期成员策略需运营者另行维护；用户模型、任务资料和设备控制均不包含在内。</p><Button type="submit" disabled={busy||!scopeSelection.length}>预览邀请</Button></form>}
      </section>}
      {connected&&<section><h3>私密问题与争议受理</h3>{!isOwner&&<form className="workspace-form" onSubmit={e=>{e.preventDefault();prepare({...base('intake-open'),threadId:crypto.randomUUID(),title,text:body},[selected.ownerId]);}}>
        <label>标题<input required maxLength={160} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>仅向运营者提供的问题说明<textarea required maxLength={6000} value={body} onChange={e=>setBody(e.target.value)}/></label><Button type="submit" disabled={busy}>预览私密问题</Button></form>}
        {threads.map(t=><article key={t.threadId}><p>受理状态：{t.state==='open'?'待处理或沟通中':'已关闭'}；正文到期 {new Date(t.expiresAt*1000).toLocaleString()}</p>{t.messages.map((m:any)=><div key={m.id}><strong>{m.title??(m.authorId===selected.ownerId?'运营者':'提交者')}</strong><p>{m.contentAvailable?m.text:'该条正文已到期、被删除或授权不可用。'}</p></div>)}
          {t.state==='open'&&t.expiresAt*1000>Date.now()&&<form onSubmit={e=>{e.preventDefault();const creator=t.messages.find((m:any)=>m.kind==='intake-open')?.authorId;prepare({...base('intake-reply'),threadId:t.threadId,expectedVersion:t.version,text:reply[t.threadId]??''},[isOwner?creator:selected.ownerId]);}}>
            <label>继续说明<textarea required maxLength={6000} value={reply[t.threadId]??''} onChange={e=>setReply(x=>({...x,[t.threadId]:e.target.value}))}/></label><Button type="submit" disabled={busy}>预览回复</Button><Button type="button" variant="outline" disabled={busy||!reply[t.threadId]?.trim()} onClick={()=>prepare({...base('intake-close'),threadId:t.threadId,expectedVersion:t.version,text:reply[t.threadId]},[isOwner?t.messages.find((m:any)=>m.kind==='intake-open')?.authorId:selected.ownerId])}>预览说明并关闭</Button></form>}</article>)}
        {threadAfter&&<Button type="button" disabled={busy} onClick={()=>run(async valid=>{const p=await client.intake({hubId:selected.hubId,after:threadAfter});if(valid()){setThreads(x=>[...x,...p.items]);setThreadAfter(p.nextCursor);}})}>更多受理记录</Button>}
      </section>}
    </article>}
    {connected&&selected&&<HubPeeringWorkspace client={client} hubId={selected.hubId} owner={isOwner} subjectId={subjectId!} onPending={()=>run(refreshPending)}/> }
    {connected&&<section><h2>运营者编写版本化章程</h2><p>填写上方本人已有的 Hub 登记 ID，再载入章程。每项声明保留日期与核验范围。</p><Button type="button" disabled={busy} onClick={()=>run(editCharter)}>载入本人登记并编写</Button>
      {draft&&builder&&<form className="workspace-form" onSubmit={e=>{e.preventDefault();prepare({schemaVersion:2,id:crypto.randomUUID(),hubId:builder.builderId,kind:'charter',expectedVersion:builder.charterVersion,declarationId:builder.declarationId,declarationHash:builder.declarationHash,charter:draft},builder.disclosure.viewers,builder.disclosure.visibility);}}>
        <label>社区名称<input required value={draft.name} onChange={e=>setDraft((d:any)=>({...d,name:e.target.value}))}/></label>
        {Object.entries(fields).map(([key,label])=><fieldset key={key}><legend>{label}</legend><textarea required maxLength={1500} value={draft[key].text} onChange={e=>setDraft((d:any)=>({...d,[key]:{...d[key],text:e.target.value,asOf:Math.floor(Date.now()/1000)}}))}/>
          <select value={draft[key].status} onChange={e=>setDraft((d:any)=>({...d,[key]:{text:d[key].text,status:e.target.value,asOf:Math.floor(Date.now()/1000)}}))}><option value="unknown">尚未核实</option><option value="declared">运营者声明</option>{draft[key].reportRef&&<option value="reported-tested">保留已有精确报告引用</option>}</select></fieldset>)}
        <p>本页不将文字或兼容报告升级为第三方认证。需要新增精确报告引用时使用完整字段 API，所有引用需能当前核对。</p>
        <label>运营者声明的受理响应目标（天）<input type="number" min={1} max={90} required value={draft.intake.responseTargetDays} onChange={e=>setDraft((d:any)=>({...d,intake:{...d.intake,responseTargetDays:Number(e.target.value)}}))}/></label>
        <label><input type="checkbox" checked={draft.pilot.synthetic} onChange={e=>setDraft((d:any)=>({...d,pilot:{...d.pilot,synthetic:e.target.checked}}))}/>本资料属于合成演示</label><Button type="submit" disabled={busy}>预览完整章程和现有可见范围</Button>
      </form>}
    </section>}
    {preview&&<section className="task-card"><h2>确认本次内容</h2><p>{preview.visibility==='Public'?'公开发布':'仅本人及指定对方可读'}；加入／退出只改变本次社区范围。</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(preview,null,2)}</pre>
      <Button type="button" disabled={busy} onClick={()=>run(async valid=>{try{const r=await client.submit(preview.event,{...preview,confirmed:true});if(valid()){setPreview(null);setNotice('已记录原操作；不表示获得专业认证或开放全部材料。');}await open(r.hubId,valid);}finally{await refreshPending(valid);}})}>确认并发送</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>setPreview(null)}>取消</Button></section>}
    {connected&&<Button type="button" variant="outline" disabled={busy} onClick={()=>run(refreshPending)}>核对本机未完成操作</Button>}
    {pending&&<section><p>有原操作等待核对，内容与操作 ID 已保留。</p><Button type="button" disabled={busy} onClick={()=>run(async valid=>{const r=await client.reconcile();if(valid())setNotice('原回执状态：'+r.state);await refreshPending(valid);})}>查询原回执</Button><Button type="button" disabled={busy} onClick={()=>run(async valid=>{await client.reconcile({retry:true,confirmed:true});await refreshPending(valid);})}>仅重试原操作</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>run(async valid=>{await client.discard();await refreshPending(valid);})}>核对并放弃本机重试</Button></section>}
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  </section>;
}
