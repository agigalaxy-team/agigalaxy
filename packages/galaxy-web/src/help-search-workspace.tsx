import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {createHelpSearchClient} from './help-search-client.mjs';
import {ChoiceSyncWorkspace} from './choice-sync-workspace';
import {HistoryFacts} from './history-facts';

type Props={runtime:any;connected:boolean;subjectId?:string;navigate:(path:string)=>void};
const labels:Record<string,string>={history:'工作经历与尝试',case:'案例事实',capsule:'Capsule 可复用方法',task:'当前任务',opportunity:'交流与协作机会',proof:'CI 来源证明',worker:'Worker 声明',hub:'Hub 声明',
  failed:'未成功',partial:'部分完成',succeeded:'报告成功',inconclusive:'尚无定论',conflicting:'结论存在冲突',diagnosis:'诊断',advice:'建议',patch:'补丁',verification:'验证',review:'复核','tool-introduction':'引入工具',
  current:'当前来源一致',changed:'来源已更新，原理由需要复看','unavailable-in-current-query':'当前查询中已不可取得','check-failed':'本次核对失败，状态未确认'};
const label=(v:string)=>labels[v]??v;
const candidateKey=(item:any)=>`${item.type}:${item.ref.id}:${item.ref.version}`;
const failure=(e:any)=>({history_sources_changed_retry:'来源有变化，请从第一页重新查询。',discovery_sources_changed_retry:'机会已更新，请从第一页重新查询。',search_identity_changed:'身份已变化，请重新打开本页。',choice_version_conflict:'这份选择记录已有新版本，请刷新后编辑。',choice_source_not_read_in_this_client:'先读取当前候选，再保存选择。'} as Record<string,string>)[e?.code??e?.message]??'这项操作未完成。请检查当前连接后重试。';
function Facts({item}:{item:any}) {
  const r=item.record;
  if(r?.kind==='case-history'||r?.kind==='task-history')return <HistoryFacts record={r}/>;
  return <div className="fact-details">
    {r.attempts?.map((a:any)=><p key={`${a.id}:${a.version}`}><strong>{a.strategy}</strong> · {label(a.reportedOutcome??a.status)}<br/>{a.summary??a.failureReason}<br/><small>{a.environment?`${a.environment.name} ${a.environment.version}`:'环境未提供'} · 版本 {a.version}</small></p>)}
    {r.interventions?.map((v:any)=><p key={`${v.id}:${v.version}`}><strong>{v.types.map(label).join('、')}</strong>：{v.description}<br/>{v.observedEffect}</p>)}
    {r.results?.map((v:any)=><p key={`${v.id}:${v.version}`}><strong>{label(v.reportedOutcome)}</strong>：{v.summary}<br/>适用限制：{v.limitations}</p>)}
    {r.request&&<p>目标：{r.request.workContext?.goal}<br/>当前情况：{r.request.workContext?.currentSituation}<br/>{r.enrollmentOpen?'当前仍在征集参与者':'当前已不再征集'}；发布任务不表示有人已承接。</p>}
    {r.help&&<p>可交流的功能：{r.help.functions?.join('、')}<br/>对方当前欢迎接触；尚未发送邀请，也未加入房间。项目内容来自本人声明，相关经历可继续展开。</p>}
    {r.data&&<p>仓库：{r.data.source.owner}/{r.data.source.repository}<br/>运行：{r.data.source.runId}，第 {r.data.source.attempt} 次<br/>观测结论：{r.data.conclusion}。仓库控制的运行，不代表独立专家认证。</p>}
    {item.type==='capsule'&&<p>{r.newApplicationAllowed?'当前允许尝试应用':'当前不宜开始新的应用'}。阅读不算应用成功，请先查看方法、许可和版本。</p>}
    {['worker','hub'].includes(item.type)&&<p>目录内容来自所有者声明；尚不据此证明远程连接或真实能力。</p>}
    <p className="muted">记录时间、来源版本及权限按本次读取核对。相关经历不会自动变成当前参与意愿；接受交付也不等于问题已经验证解决。</p>
    <details><summary>查看准确来源字段</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:420,overflow:'auto'}}>{JSON.stringify({source:item.source,version:item.sourceVersion,record:item.record,matchReasons:item.matchReasons,limitations:item.limitations},null,2)}</pre></details>
  </div>;
}

function SourceDetail({item,client}:{item:any;client:any}) {
  const [detail,setDetail]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),epoch=useRef(0);
  useEffect(()=>()=>{epoch.current++;},[item,client]);
  async function read(after:string|null=null){const token=epoch.current;setBusy(true);setError('');setDetail(null);
    try{const value=await client.detail(item,{after});if(token===epoch.current)setDetail(value);}catch(e){if(token===epoch.current)setError(failure(e));}finally{if(token===epoch.current)setBusy(false);}}
  return <div><Button type="button" variant="outline" disabled={busy} onClick={()=>read()}>{item.type==='capsule'?'读取所选版本的完整方法':'读取对方实际经历'}</Button>
    {error&&<p role="alert">{error}</p>}
    {detail?.version&&<div><h4>{detail.version.title} · 版本 {detail.version.version}</h4><p>环境：{detail.version.environment.name} {detail.version.environment.version}</p>
      <p>{detail.version.solutionStrategy}</p><p>工具：{detail.version.tools.join('、')||'未要求'}；Skill：{detail.version.skills.join('、')||'未要求'}；MCP：{detail.version.mcpRefs.join('、')||'未要求'}</p>
      <p>适用范围：{detail.version.applicableScope}<br/>验证方法：{detail.version.verificationMethod}<br/>许可：{detail.version.license}</p><ul>{detail.version.limitations.map((v:string)=><li key={v}>{v}</li>)}</ul>
      <p>本次只读取，没有记录成功复用。开始应用时应在实际工作中留下尝试及结果。</p></div>}
    {detail?.sourceStatus==='source-unavailable'&&<p>方法来源当前不可用，已停止展示其正文。</p>}
    {detail?.experience&&<div><p>以下是对方当前可见的实际经历，是否与本次功能相关仍由你或自己的模型判断；没有经历也可以交流或开放协助。</p>
      {detail.experience.items.length===0&&<p>这一页没有可见经历。</p>}
      {detail.experience.items.map((record:any)=><details key={record.key}><summary>{record.title??'授权工作事实'}</summary><Facts item={{record,source:{key:record.key},sourceVersion:detail.experience.rebuild.sourceHash}}/></details>)}
      {detail.experience.nextCursor&&<Button type="button" variant="outline" disabled={busy} onClick={()=>read(detail.experience.nextCursor)}>下一页经历</Button>}</div>}
  </div>;
}

export function HelpSearchWorkspace({runtime,connected,subjectId,navigate}:Props) {
  const client=useMemo(()=>runtime?createHelpSearchClient(runtime,{authenticated:connected,subjectId:subjectId??null}):null,[runtime,connected,subjectId]);
  const [query,setQuery]=useState(''),[functions,setFunctions]=useState(''),[types,setTypes]=useState(['history','capsule','task']);
  const [sources,setSources]=useState<any[]>([]),[requests,setRequests]=useState<Record<string,any>>({}),[selected,setSelected]=useState<string[]>([]),[candidateKeys,setCandidateKeys]=useState<string[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[local,setLocal]=useState<any>({choices:[],referenceStates:{}});
  const [rationale,setRationale]=useState(''),[localTaskRef,setLocalTaskRef]=useState(''),[draftId,setDraftId]=useState(()=>crypto.randomUUID());
  const [resultKeys,setResultKeys]=useState<string[]>([]);
  const [draftVersion,setDraftVersion]=useState(0);
  const generation=useRef(0),working=useRef(false);
  useEffect(()=>{const token=++generation.current;setSources([]);setRequests({});setSelected([]);setCandidateKeys([]);setLocal({choices:[],referenceStates:{}});setError('');setNotice('');setBusy(false);working.current=false;
    client?.local().then(v=>{if(generation.current===token)setLocal(v);}).catch(()=>{});
    const reload=()=>{if(document.visibilityState!=='visible'||working.current||!client)return;client.local().then(v=>{if(generation.current===token)setLocal(v);}).catch(()=>{});};
    const timer=window.setInterval(reload,15000);const onVisible=()=>reload();document.addEventListener('visibilitychange',onVisible);
    return()=>{generation.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',onVisible);client?.close();};},[client]);
  function activeClient(){if(!client)throw new Error('search_client_unavailable');return client;}
  async function run(fn:(valid:()=>boolean)=>Promise<void>){if(working.current||!client)return;const token=generation.current,valid=()=>token===generation.current;working.current=true;setBusy(true);setError('');setNotice('');
    try{await fn(valid);}catch(e){if(valid())setError(failure(e));}finally{if(valid()){working.current=false;setBusy(false);}}}
  function request(type:string){return{type,query:type==='opportunity'?{context:{kind:'ephemeral',title:query.trim()||'主动寻找相关交流',functions:functions.split(/[,，\n]/).map(v=>v.trim()).filter(Boolean)},purposes:['conversation','collaboration'],limit:8}:{query,limit:8}};}
  async function search(valid:()=>boolean){const list=types.map(request);const response=await activeClient().combine(list);if(!valid())return;
    setSources(response.sources);setRequests(Object.fromEntries(list.map(v=>[v.type,v])));setSelected([]);setCandidateKeys([]);setResultKeys([]);setDraftId(crypto.randomUUID());setDraftVersion(0);}
  async function more(type:string,next:string,valid:()=>boolean){const response=await activeClient().query({...requests[type],query:{...requests[type].query,after:next}});if(!valid())return;
    setSources(old=>old.map(source=>source.type===type?{type,state:'fulfilled',page:{...response,items:[...(source.page?.items??[]),...response.items]}}:source));}
  const items=sources.flatMap(s=>s.page?.items??[]);
  const resultOptions=items.flatMap((item:any)=>(item.record?.results??[]).filter((v:any)=>!v.supersededInVisibleHistory).map((v:any)=>({
    key:`${item.record.caseId}:${v.id}:${v.version}`,ref:{caseId:item.record.caseId,id:v.id,version:v.version},summary:v.summary,outcome:v.reportedOutcome
  }))).filter((v:any,index:number,all:any[])=>all.findIndex(x=>x.key===v.key)===index);
  return <section>
    <div className="eyebrow">为下一步取得依据</div><h1 className="small">寻找可用的帮助</h1>
    <p className="lead">查找相关的真实工作、尝试和失败、可复用方法，以及当前任务与愿意交流的同行。你或自己的模型解释这些资料，再决定下一步。</p>
    <form className="workspace-form" onSubmit={e=>{e.preventDefault();run(search);}}>
      <label>当前想解决或了解什么<Input value={query} maxLength={200} onChange={e=>setQuery(e.target.value)} placeholder="问题、功能、失败模式或环境关键词"/></label>
      <fieldset><legend>一起查询的资料</legend><div className="form-pair">{['history','capsule','task','opportunity','proof','worker','hub'].map(type=><label key={type}><input type="checkbox" checked={types.includes(type)} onChange={e=>setTypes(current=>e.target.checked?[...current,type]:current.filter(v=>v!==type))}/>{label(type)}</label>)}</div></fieldset>
      {types.includes('opportunity')&&<label>想交流的功能（用逗号分隔）<Input required value={functions} onChange={e=>setFunctions(e.target.value)} placeholder="例如：table-extraction, 文档解析"/><small>先按明确功能匹配。相同技术栈不等于相同功能。</small></label>}
      <Button type="submit" disabled={!client||busy||!types.length}>查询所选资料</Button>
    </form>
    {error&&<p role="alert" className="message error">{error}</p>}{notice&&<p role="status" className="message">{notice}</p>}
    {sources.map(source=><section key={source.type} className="help-intro"><h2>{label(source.type)}</h2>
      {source.state==='failed'?<div><p>这一来源本次读取失败，其他结果仍可使用。没有将失败当成“没有可用帮助”。</p><Button type="button" variant="outline" disabled={busy} onClick={()=>run(async valid=>{const page=await activeClient().query(requests[source.type]);if(valid())setSources(old=>old.map(s=>s.type===source.type?{type:source.type,state:'fulfilled',page}:s));})}>重试这一来源</Button></div>:<>
      {source.page.sourceState==='disabled'?<p>当前发现偏好关闭或已暂停。可在主动匹配中调整；其他查询不受影响。</p>:source.page.items.length===0?<p>这一页没有符合条件的可见资料。可以调整关键词、继续分页或改用其他帮助路径。</p>:null}
      <div className="result-list">{source.page.items.map((item:any)=><article className="task-card" key={candidateKey(item)}>
        <label><input type="checkbox" disabled={busy} checked={candidateKeys.includes(candidateKey(item))} onChange={e=>{const key=candidateKey(item);setCandidateKeys(old=>e.target.checked?[...old,key]:old.filter(k=>k!==key));if(!e.target.checked)setSelected(old=>old.filter(k=>k!==key));}}/>纳入本次比较候选</label>
        <label><input type="checkbox" disabled={busy||!candidateKeys.includes(candidateKey(item))} checked={selected.includes(candidateKey(item))} onChange={e=>setSelected(old=>e.target.checked?[...old,candidateKey(item)]:old.filter(k=>k!==candidateKey(item)))}/>从候选中选用（尚未联系或应用）</label>
        <h3>{item.title}</h3><p>{item.summary}</p><details><summary>查看依据、条件和来源</summary><Facts item={item}/></details>
        {['capsule','opportunity'].includes(item.type)&&<SourceDetail item={item} client={client}/>}
        {item.type==='task'&&<Button type="button" variant="outline" onClick={()=>navigate(`/app/tasks/${item.id}`)}>了解任务并决定是否参与</Button>}
        {item.type==='opportunity'&&<Button type="button" variant="outline" onClick={()=>navigate('/app/match')}>进入主动匹配</Button>}
      </article>)}</div>
      <p className="muted">本页 {source.page.items.length} 项。只代表本次可见范围；{source.page.coverage?.windowLimited?'来源窗口有限，可继续下一页。':'没有提供全网数量或能力排名。'}</p>
      {source.page.nextCursor&&<Button type="button" variant="outline" disabled={busy} onClick={()=>run(valid=>more(source.type,source.page.nextCursor,valid))}>继续这一来源</Button>}
      </>}
    </section>)}
    {items.length>0&&<form className="workspace-form" onSubmit={e=>{e.preventDefault();run(async valid=>{const current=activeClient();await current.saveChoice({id:draftId,expectedVersion:draftVersion,localTaskRef,visibleRationale:rationale,rationaleAuthor:'user',candidateKeys,selectedKeys:selected,resultRefs:resultOptions.filter((v:any)=>resultKeys.includes(v.key)).map((v:any)=>v.ref)});const value=await current.local();if(valid()){const saved=value.choices.find((c:any)=>c.id===draftId)?.versions.at(-1);if(saved)setDraftVersion(saved.version);setLocal(value);setNotice('比较候选、选用结果与简要理由已保存在本机；没有发送邀请或发布任务。');}});}}>
      <h2>{draftVersion?'更新选定记录的本机版本':'保留这次选择'}</h2><label>本机工作名称或引用<Input required maxLength={300} value={localTaskRef} onChange={e=>setLocalTaskRef(e.target.value)} placeholder="用来返回当前工作，不会创建任务"/></label>
      <label>你看到的简要选择理由<Textarea required maxLength={1200} value={rationale} onChange={e=>setRationale(e.target.value)} placeholder="例如：这份诊断经历相关，但还需确认环境与对方意愿。不要填写模型私有推理。"/></label>
      {resultOptions.length>0&&<fieldset><legend>可选：关联已经发生的结果</legend><p className="muted">仅建立关系，不声称这次选择导致了该结果，也不将“部分完成”改成成功。</p>{resultOptions.map((v:any)=><label key={v.key}><input type="checkbox" checked={resultKeys.includes(v.key)} onChange={e=>setResultKeys(old=>e.target.checked?[...old,v.key]:old.filter(k=>k!==v.key))}/>{label(v.outcome)}：{v.summary}</label>)}</fieldset>}
      <p>仅保存对象与版本引用、这段理由及你的选择。默认本机保存；房间摘要的云同步开关不会把它上传。</p>
      <p>已加载 {items.length} 项；纳入本次比较 {candidateKeys.length} 项；选用 {selected.length} 项。可以保留比较后暂不选用的理由。</p>
      <Button type="submit" disabled={busy||!candidateKeys.length||candidateKeys.length>64}>保存本机选择</Button>{candidateKeys.length>64&&<p role="alert">本次比较最多保存 64 项引用。请取消部分“纳入本次比较候选”，已加载结果仍保留，不会替你截取前 64 项。</p>}
    </form>}
    {local.choices.length>0&&<section className="help-intro"><h2>本机选择记录</h2>{local.choices.map((choice:any)=>{const current=choice.versions.at(-1);return <article className="task-card" key={choice.id}><h3>{current.localTaskRef}</h3><p>{current.visibleRationale}</p><p>版本 {current.version} · 选定 {current.selectedRefs.length} 项；选择不等于已联系或已成功应用。</p>
      {current.candidateRefs.map((ref:any)=>{const state=local.referenceStates[`${ref.type}:${ref.id}:${ref.version}`];return state?<p key={`${ref.type}:${ref.id}`}>{label(ref.type)}：{label(state.state)}</p>:null;})}
      <Button type="button" variant="outline" disabled={busy} onClick={()=>run(async valid=>{const value=await activeClient().refreshChoice(choice.id);if(valid())setLocal(value);})}>核对当前来源</Button>
      <Button type="button" variant="outline" disabled={busy||!items.length} onClick={()=>{const loadedKeys=new Set(items.map(candidateKey));const keys=current.candidateRefs.map((r:any)=>`${r.type}:${r.id}:${r.version}`);setDraftId(choice.id);setDraftVersion(current.version);setLocalTaskRef(current.localTaskRef);setRationale(current.visibleRationale);setCandidateKeys(keys.filter((k:string)=>loadedKeys.has(k)));setSelected(current.selectedRefs.map((r:any)=>`${r.type}:${r.id}:${r.version}`).filter((k:string)=>loadedKeys.has(k)));setResultKeys([]);setNotice(`已恢复当前页面中可核对的候选。原记录有 ${keys.filter((k:string)=>!loadedKeys.has(k)).length} 项尚未在本页重新读取；原版本仍保留。请复看候选、理由与选择后保存新版本。`);}}>用当前候选更新本机版本</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={()=>run(async valid=>{const value=await activeClient().removeChoice(choice.id);if(valid())setLocal(value);})}>删除本机记录</Button></article>;})}</section>}
    <ChoiceSyncWorkspace runtime={runtime} subjectId={subjectId} connected={connected} localChoices={local.choices}/>
    <div className="help-intro"><h2>其他下一步同样保留</h2><p>可以返回原聊天继续与当前 AI 探索，按需采用 Capsule 或历史方案，发起开放协助，或讨论赏金与专家协助。资料不足时无需凑齐候选。</p><Button type="button" variant="outline" onClick={()=>navigate('/app/publish')}>准备协助请求</Button><Button type="button" variant="ghost" onClick={()=>navigate('/app/participate')}>查看参与任务</Button></div>
  </section>;
}
