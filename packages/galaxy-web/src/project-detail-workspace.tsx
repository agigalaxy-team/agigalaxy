import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {FactDetails} from './fact-details';
import {OpportunityContactWorkspace} from './opportunity-contact-workspace';
import {createProjectViewClient,projectQueryMemory,projectViewScope,hasIndependentProject} from './project-view-client.mjs';

type Props={projectId:string;runtime:any;subjectId:string|null;connected:boolean;navigate:(path:string)=>void};
const purposes=[['conversation','交流想法'],['reuse','了解可复用内容'],['collaboration','共同协作'],['recruitment','了解持续角色需求']];
const roleNames:Record<string,string>={owner:'项目管理者',editor:'资料编辑者',representative:'对外代表'};
export function ProjectDetailWorkspace(props:Props){return <ProjectDetailView key={props.projectId+projectViewScope(props.runtime,props.connected)} {...props}/>;}
function ProjectDetailView({projectId,runtime,subjectId,connected,navigate}:Props){
 const client=useMemo(()=>runtime?createProjectViewClient(runtime,{connected,subjectId}):null,[runtime,connected,subjectId]);
 const [project,setProject]=useState<any>(null),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [selected,setSelected]=useState<string[]>(()=>projectQueryMemory(runtime,connected,'project:'+projectId)?.purposes??['conversation','collaboration']);
 const [query,setQuery]=useState<any>(null),[items,setItems]=useState<any[]>([]),[next,setNext]=useState<string|null>(null),[searched,setSearched]=useState(false),[coverage,setCoverage]=useState<any>(null),[detail,setDetail]=useState<any>(null);
 const alive=useRef(true), working=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 async function run(fn:(commit:(action:()=>void)=>void)=>Promise<void>){if(working.current||!client)return;working.current=true;setBusy(true);setError('');
  const commit=(action:()=>void)=>{if(alive.current){client.current();action();}};
  try{await fn(commit);}catch(e:any){if(alive.current)setError(typeof e?.message==='string'&&e.message.trim()?e.message:'项目详情操作暂未完成，请稍后重试。');}finally{working.current=false;if(alive.current)setBusy(false);}}
 async function load(commit:(action:()=>void)=>void){try{const value=await client!.project(projectId);commit(()=>{setProject(value);setLoaded(true);});}
  catch(e){commit(()=>{setProject(null);setLoaded(true);setItems([]);setDetail(null);setQuery(null);setSearched(false);});throw e;}}
 useEffect(()=>{
  if(!client)return;
  void run(load);
  const refresh=()=>{if(document.visibilityState==='visible'&&!working.current)void run(load);};
  const timer=window.setInterval(refresh,20000);
  document.addEventListener('visibilitychange',refresh);
  return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
 },[client,projectId]);
 async function search(after:string|null=null){await run(async commit=>{
  const result=await client!.related(projectId,after?query.purposes:selected,after);
  commit(()=>{setProject(result.project);setQuery(result.query);setItems(old=>after?[...old,...result.result.items]:result.result.items);setNext(result.result.nextAfter);setSearched(true);
   setCoverage(result.result.coverage??result.result);if(!after)setDetail(null);projectQueryMemory(runtime,connected,'project:'+projectId,{purposes:result.query.purposes});});
 });}
 const projectDocument=project?.document;
 return <section><div className="eyebrow">项目固定链接</div><h1 className="small">{projectDocument?.title??'项目详情'}</h1><code className="identity-id">{projectId}</code>
  <div className="button-row"><Button type="button" variant="outline" onClick={()=>navigate('/app/projects')}>项目与联系</Button><Button type="button" variant="outline" onClick={()=>navigate('/app/match')}>发现匹配</Button>
   <Button type="button" variant="outline" onClick={()=>navigate('/app/publish')}>发布任务</Button><Button type="button" variant="outline" onClick={()=>navigate('/app/participate')}>参与任务</Button>
   <Button type="button" variant="ghost" disabled={!client||busy} onClick={()=>run(load)}>刷新当前项目</Button></div>
  {error&&<p className="message error" role="alert">{error} {loaded&&!project?'当前链接下没有可读取的项目资料；这不确认项目是否存在或是否已删除。':''}</p>}
  {!loaded&&!error&&<p role="status">{runtime?'正在取得当前项目资料。':'正在准备数据连接。'}</p>}
  {!connected&&<p>正在按公开权限浏览。连接自己的银河身份后，可读取获准的私有资料或执行明确操作；链接本身不带权限。</p>}
  {project&&<article className="task-body"><p className="tag">发布者声明 · 未据此认证能力或法律所有权</p><p>版本 {project.revision} · {project.state==='active'?'当前有效':project.state==='archived'?'已归档':project.state} · {project.visibility==='Public'?'公开资料':'按授权展示'}</p>
   {projectDocument?<><p className="lead">{projectDocument.summary}</p><h2>功能与适用方向</h2><p>{projectDocument.functions.join('、')}</p><p>技术与环境：{projectDocument.technologies.length?projectDocument.technologies.join('、'):'未提供'}</p>
    <p>项目类型：{projectDocument.kind==='module'?'功能模块':'项目'}；参与主体声明：{({human:'人',agent:'Agent',team:'团队',tool:'工具',unknown:'未说明'} as Record<string,string>)[projectDocument.participantKind]??'未说明'}。</p>
    <p>发现设置：{projectDocument.discoverable?'允许在相应意愿与权限下发现':'当前不参与新发现'}。关闭发现不会自动撤销已经公开的资料。</p>
    {projectDocument.sourceUrl&&/^https?:\/\//.test(projectDocument.sourceUrl)&&<a href={projectDocument.sourceUrl} target="_blank" rel="noopener noreferrer">查看发布者提供的外部来源（未据此证明所有权或当前运行）</a>}
   </>:<p>你当前只能查看管理转交提示，原项目正文尚未授权；不能据此接受其资料、文件或Agent控制。</p>}
   <p>当前管理主体：<code>{project.ownerId}</code></p><p>本人当前角色：{project.ownRoles?.map((r:string)=>roleNames[r]??r).join('、')||'当前无项目管理角色'}。项目角色不包含私有文件或他人Agent控制。</p>
   {project.source&&<details><summary>资料来源与字段作者</summary><p>原声明：{project.source.sourceStatementId??'独立项目声明'}；当前资料事件：{project.source.documentEventId}</p>
    <ul>{project.source.fieldSources?.map((source:any)=><li key={source.field}>{source.field}：{source.subjectId} · 原操作 {source.operationId}</li>)}</ul></details>}
   {!!project.management?.transfers?.length&&<p>存在当前可见的管理转交待办。转交需要受让人接受；资料不可读时不能据提示直接认领。</p>}
   {(project.permissions?.edit||project.permissions?.represent||project.management?.transfers?.length>0)&&<Button type="button" variant="outline" onClick={()=>navigate('/app/projects?section=projects&projectId='+projectId)}>在管理工作区处理这个项目</Button>}
   <p className="muted">来自原聊天或任务时，返回后按同一项目ID刷新当前状态。关闭页面不归档项目、不撤销联系，也不会创建新的任务。</p>
  </article>}
  {projectDocument&&project.state==='active'&&<section className="task-body"><h2>围绕这个项目寻找机会</h2><p>使用上面这份当前可读的功能与目标临时查询；结果是功能相关的项目和机会，不是本项目成员清单或全部招募。不会自动保存新项目、失败Case或任务。</p>
   <form onSubmit={e=>{e.preventDefault();search();}} className="workspace-form"><fieldset className="purpose-options"><legend>希望获得什么，可同时选择</legend>{purposes.map(([id,label])=><label key={id}><input type="checkbox" checked={selected.includes(id)} onChange={e=>setSelected(e.target.checked?[...selected,id]:selected.filter(x=>x!==id))}/>{label}</label>)}</fieldset>
    <Button type="submit" disabled={busy||!client||!selected.length}>用这些功能和目的查找</Button></form>
   {searched&&<p className="muted">这是当前权限与分页范围内的结果；功能交集是依据之一，技术相同不代表功能相同。用户或自己的模型继续解释相关性，不存在全网或能力保证。{coverage?.windowLimited?'当前扫描窗口有限。':''}</p>}
   {searched&&!items.length&&<p className="empty-state">这一范围没有当前可见的机会。可调整目的、继续下一范围或回到原工作；这不代表没有相关的人。</p>}
   {items.map(item=><article className="task-card" key={item.id}><span className="tag">{item.recruitmentId?'持续角色需求声明':'项目或模块声明'}</span><h3>{item.project.title}</h3><p>{item.help.statement}</p><p>共同功能：{item.help.functions.join('、')}；当前可交流目的：{item.help.purposes.join('、')}</p>
    <Button type="button" variant="outline" disabled={busy} onClick={()=>run(async commit=>{try{const value=await client!.detail(query,item.opportunityRef);commit(()=>setDetail(value));}catch(e){commit(()=>setDetail(null));throw e;}})}>查看真实依据与下一步</Button>
    {hasIndependentProject(item)?<Button type="button" variant="ghost" onClick={()=>navigate('/app/projects/'+item.projectId)}>打开项目</Button>:<p>这项内容来自原Profile声明，保留原查询依据，尚无独立项目页。</p>}</article>)}
   {next&&<Button type="button" variant="outline" disabled={busy} onClick={()=>search(next)}>继续当前查询的下一范围</Button>}
   {detail&&<section><h3>{detail.opportunity.project.title}</h3><p>以下按当前授权展示经历。声明、尝试、结果和验证分别成立；没有经历也可以开始开放交流。</p>
    {detail.experience?.items?.map((item:any)=><article className="task-card" key={item.key??item.id}><h4>{item.title??item.kind}</h4><FactDetails item={item}/>{item.taskId&&<Button type="button" variant="ghost" onClick={()=>navigate('/app/tasks/'+item.taskId)}>查看关联任务</Button>}</article>)}
    {!detail.experience?.items?.length&&<p>本页没有向你开放的经历，不能据此推断对方无能力。</p>}
    {(detail.experience?.nextCursor??detail.experience?.nextAfter)&&<Button type="button" variant="outline" disabled={busy} onClick={()=>run(async commit=>{const value=await client!.detail(query,detail.opportunity.opportunityRef,detail.experience.nextCursor??detail.experience.nextAfter);commit(()=>setDetail(value));})}>继续读取经历</Button>}
    <OpportunityContactWorkspace runtime={runtime} connected={connected} subjectId={subjectId} query={query} opportunity={detail.opportunity} navigate={navigate}/>
   </section>}
  </section>}
 </section>;
}
