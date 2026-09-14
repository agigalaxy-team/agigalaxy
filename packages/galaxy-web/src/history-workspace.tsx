import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {createHistoryClient,prepareHistoryQuery} from './history-client.mjs';
import {HistoryFacts,HistoryFields} from './history-facts';
type Props={runtime:any;connected:boolean;subjectId?:string;navigate:(path:string)=>void};
const readable=(e:any)=>({history_sources_changed_retry:'可见来源已有变化，请从第一页重新查询，原分页不再续接。',history_identity_changed:'当前身份已变化，请重新查询。',invalid_history_cursor:'这一分页已失效，请重新查询。'} as Record<string,string>)[e?.code??e?.message]??(e?.name==='ZodError'||e instanceof RangeError?'请检查银河 ID、时间范围及筛选字段。关键词最多 8 组，自定义结束时间必须晚于开始时间。':'本次读取未完成；没有把失败当作没有经历。可以保留筛选条件重试。');
export function HistoryWorkspace({runtime,connected,subjectId,navigate}:Props){
  const client=useMemo(()=>runtime?createHistoryClient(runtime,{authenticated:connected,subjectId:subjectId??null}):null,[runtime,connected,subjectId]);
  const [form,setForm]=useState({subjectId:subjectId??'',query:'',capabilityId:'',timeWindow:'all-visible',from:'',before:'',taskId:'',environment:''});
  const [page,setPage]=useState<any>(null),[request,setRequest]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const epoch=useRef(0),working=useRef(false);
  useEffect(()=>{epoch.current++;working.current=false;setBusy(false);setPage(null);setRequest(null);setError('');setNotice('');setForm(v=>({...v,subjectId:subjectId??''}));return()=>{epoch.current++;client?.close();};},[client,subjectId]);
  function edit(key:string,value:string){epoch.current++;working.current=false;setBusy(false);setForm(v=>({...v,[key]:value}));setPage(null);setRequest(null);setError('');setNotice('');}
  async function read(after:string|null=null){if(!client||working.current)return;const token=++epoch.current;working.current=true;setBusy(true);setError('');setNotice('');
    try{const query=after?{...request,after}:prepareHistoryQuery(form);const value=await client.query(query);if(token!==epoch.current)return;setRequest({...query,after:null});setPage((old:any)=>after?{...value,items:[...old.items,...value.items]}:value);}
    catch(e){if(token===epoch.current){setError(readable(e));if((e as any)?.code==='history_sources_changed_retry'||(e as any)?.message==='history_sources_changed_retry'){setPage(null);setRequest(null);}}}
    finally{if(token===epoch.current){working.current=false;setBusy(false);}}}
  return <section className="task-body" aria-busy={busy}><h2>按主体查询完整工作经历</h2><p>查看实际尝试、失败、环境、各方介入、结果及验证；保留具体信息供你或自己的模型判断。没有可见历史的新参与者仍可进入开放协助。</p>
    <form className="workspace-form" onSubmit={e=>{e.preventDefault();read();}}>
      <label>银河 ID<Input required value={form.subjectId} onChange={e=>edit('subjectId',e.target.value)} placeholder="本人或协作者的 GUID"/></label>
      <label>相关经历关键词<Input maxLength={200} value={form.query} onChange={e=>edit('query',e.target.value)} placeholder="最多 8 组，以空格分隔；匹配可见字段"/></label>
      <div className="form-pair"><label>时间范围<select value={form.timeWindow} onChange={e=>edit('timeWindow',e.target.value)}><option value="all-visible">全部可见时间</option><option value="90-days">最近 90 天</option><option value="365-days">最近 365 天</option><option value="custom">自定义范围</option></select></label><label>任务声明的能力标识（可选）<Input maxLength={128} value={form.capabilityId} onChange={e=>edit('capabilityId',e.target.value)} placeholder="例如 software-debugging；不代表认证"/></label></div>
      {form.timeWindow==='custom'&&<div className="form-pair"><label>开始时间（本机时区，包含）<Input type="datetime-local" required value={form.from} onChange={e=>edit('from',e.target.value)}/></label><label>结束时间（本机时区，不包含）<Input type="datetime-local" required value={form.before} onChange={e=>edit('before',e.target.value)}/></label></div>}
      <details><summary>结合当前任务与环境比较</summary><label>当前任务标识（可选）<Input value={form.taskId} onChange={e=>edit('taskId',e.target.value)}/></label><label>目标环境（可选）<Input maxLength={160} value={form.environment} onChange={e=>edit('environment',e.target.value)}/></label><p className="muted">这两项补充比较依据，不排除不同任务或未知环境，也不自动认定环境兼容。</p></details>
      <div className="button-row"><Button type="submit" disabled={!client||busy}>查询当前可见经历</Button>{busy&&<Button type="button" variant="ghost" onClick={()=>{epoch.current++;working.current=false;setBusy(false);setNotice('已停止接收本次查询结果。服务端只读请求可能已执行，没有更改履历。');}}>取消本次等待</Button>}</div>
    </form>
    {error&&<p role="alert" className="message error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {page&&<div><p>已加载 {page.items.length} 项当前可见记录。{page.nextCursor?'仍有下一页。':'本次来源范围已读取完。'}不是全网总数，也不是能力排名。</p><p className="muted">核对时间：{new Date(page.rebuild.checkedAt).toLocaleString()}；规则 {page.rebuild.ruleId} v{page.rebuild.ruleVersion}。</p>
      {page.selfDeclared&&Object.keys(page.selfDeclared).length>0&&<details><summary>主体自行声明的信息（与工作事实分开）</summary><HistoryFields value={page.selfDeclared}/></details>}
      {!page.items.length&&<div className="empty-state"><p>当前条件下没有可见记录，可能尚未形成事实、权限未开放或不符合筛选。不能据此否定能力。</p><Button type="button" variant="outline" onClick={()=>navigate('/app/participate')}>仍可参与开放协助</Button></div>}
      {page.items.map((record:any)=><article className="task-card" key={record.key}><h3>{record.title??'授权工作事实'}</h3>{record.summary&&<p>{record.summary}</p>}<HistoryFacts record={record} navigate={navigate}/></article>)}
      {page.nextCursor&&<Button type="button" variant="outline" disabled={busy} onClick={()=>read(page.nextCursor)}>继续下一页当前可见经历</Button>}
    </div>}
  </section>;
}
