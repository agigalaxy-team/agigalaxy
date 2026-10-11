import {useCurrentTaskMaterialTree} from './task-material-view';
import React,{useEffect,useEffectEvent,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {FactDetails} from './fact-details';
import {MemberAvatar,memberName,useMemberNames} from './conversation-ui';
import {OpportunityContactWorkspace} from './opportunity-contact-workspace';
import {browseReturnPath,browseReturnLabel} from './public-browse-workspace';
import {isDiscoveryPurpose,object,projectErrorText} from './project-workspace-types';
import type {ProjectRuntime,ProjectView,ProjectViewClient,DiscoveryPurpose,DiscoveryQuery,VisibleOpportunity,OpportunityDetail,UnavailableOpportunityDetail} from './project-workspace-types';
import {createProjectViewClient,projectQueryMemory,projectViewScope,hasIndependentProject,opportunityUnavailable,opportunityLocator} from './project-view-client.mjs';

type Props={projectId:string;runtime:ProjectRuntime|null|undefined;subjectId:string|null;connected:boolean;navigate:(path:string)=>void};
const purposes:readonly (readonly [DiscoveryPurpose,string])[]=[['conversation','交流想法'],['reuse','了解可复用内容'],['collaboration','共同协作'],['recruitment','了解持续角色需求']];
function locateOpportunity(value:VisibleOpportunity):UnavailableOpportunityDetail['opportunity']{return{...opportunityLocator(value),sourceUnavailable:true};}
const roleNames:Record<string,string>={owner:'项目管理者',editor:'资料编辑者',representative:'对外代表'};
export function ProjectDetailWorkspace(props:Props){return <ProjectDetailView key={props.projectId+projectViewScope(props.runtime,props.connected)} {...props}/>;}
function ProjectDetailView({projectId,runtime,subjectId,connected,navigate}:Props){
 const client=useMemo<ProjectViewClient|null>(()=>runtime?createProjectViewClient(runtime,{connected,subjectId}):null,[runtime,connected,subjectId]);
 const [project,setProject]=useState<ProjectView|null>(null),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [selected,setSelected]=useState<DiscoveryPurpose[]>(()=>{const saved:unknown=projectQueryMemory(runtime,connected,'project:'+projectId);return object(saved)&&Array.isArray(saved.purposes)?saved.purposes.filter(isDiscoveryPurpose):['conversation','collaboration'];});
 const [query,setQuery]=useState<DiscoveryQuery|null>(null),[items,setItems]=useState<VisibleOpportunity[]>([]),[next,setNext]=useState<string|null>(null),[searched,setSearched]=useState(false),[coverage,setCoverage]=useState<{windowLimited:boolean}|null>(null),[readDetail,setDetail]=useState<OpportunityDetail|UnavailableOpportunityDetail|null>(null);
 const detail=useCurrentTaskMaterialTree(runtime,readDetail);
 const wantsContact=new URLSearchParams(location.search).get('action')==='contact';
 const [direct,setDirect]=useState<{project:ProjectView;query:DiscoveryQuery;detail:OpportunityDetail|{opportunity:UnavailableOpportunityDetail['opportunity']}}|null>(null),[directError,setDirectError]=useState('');
 const [relatedOpen,setRelatedOpen]=useState(false);
 const detailDialog=useRef<HTMLDialogElement>(null);
 const names=useMemberNames(runtime??null,subjectId??undefined,connected,[...(project?.ownerId?[project.ownerId]:[]),...items.map(item=>item.subjectId),...(detail?.opportunity?.subjectId?[detail.opportunity.subjectId]:[])]);
 const name=(id:string)=>names[id]??memberName(id);
 useEffect(()=>{if(detail)detailDialog.current?.showModal();else detailDialog.current?.close();},[detail]);
 const alive=useRef(true), working=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 async function run(fn:(commit:(action:()=>void)=>void)=>Promise<void>){if(working.current||!client)return;working.current=true;setBusy(true);setError('');
  const commit=(action:()=>void)=>{if(alive.current){client.current();action();}};
  try{await fn(commit);}catch(e:unknown){if(alive.current)setError(projectErrorText(e).trim()?projectErrorText(e):'项目详情操作暂未完成，请稍后重试。');}finally{working.current=false;if(alive.current)setBusy(false);}}
 async function load(commit:(action:()=>void)=>void){try{const value=await client!.project(projectId);commit(()=>{setProject(value);setLoaded(true);});}
  catch(e){commit(()=>{setProject(null);setLoaded(true);setItems([]);setDetail(null);setQuery(null);setSearched(false);setDirect(prior=>prior?{...prior,detail:{opportunity:locateOpportunity(prior.detail.opportunity)}}:null);});throw opportunityUnavailable(e)?new Error('目前无法读取这份项目资料。'):e;}}
 async function prepareDirect(commit:(action:()=>void)=>void){
  await load(commit);
  try{const value=await client!.contactForProject(projectId);commit(()=>{setProject(value.project);setDirect(value);setDirectError('');});}
  catch(e:unknown){commit(()=>{setDirect(prior=>prior?{...prior,detail:{opportunity:locateOpportunity(prior.detail.opportunity)}}:null);setDirectError(opportunityUnavailable(e)?'对方目前没有开放这个项目的联系入口。':projectErrorText(e)?projectErrorText(e):'当前联系条件暂未取得，请稍后重试。');});if(opportunityUnavailable(e))await load(commit);}
 }
 function openDirect(){const params=new URLSearchParams(location.search);params.set('action','contact');navigate('/app/projects/'+projectId+'?'+params.toString()+'#project-contact');}
 function hideDirectSource(){setDirect(prior=>prior?{...prior,detail:{opportunity:locateOpportunity(prior.detail.opportunity)}}:null);void run(load);}
 const refreshProject=useEffectEvent(()=>{if(client&&!working.current)void run(wantsContact?prepareDirect:load);});
 useEffect(()=>{
  if(!client)return;
  refreshProject();
  const refresh=()=>{if(document.visibilityState==='visible')refreshProject();};
  const timer=window.setInterval(refresh,20000);
  document.addEventListener('visibilitychange',refresh);
  return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
 },[client,projectId,wantsContact]);
 async function search(after:string|null=null){await run(async commit=>{
  if(!client||after&&!query)throw Error('请先读取当前项目的查找范围。');
  const result=await client.related(projectId,after?query!.purposes:selected,after);
  commit(()=>{setProject(result.project);setQuery(result.query);setItems(old=>after?[...old,...result.result.items]:result.result.items);setNext(result.result.nextAfter);setSearched(true);
   setCoverage(result.result.coverage??result.result);if(!after)setDetail(null);projectQueryMemory(runtime,connected,'project:'+projectId,{purposes:result.query.purposes});});
 });}
 function hideSource(item:VisibleOpportunity){const locator=locateOpportunity(item);setItems(old=>old.map(row=>row.id===item.id?locator:row));setDetail({opportunity:locator,experience:{items:[]}});}
 const projectDocument=project?.document;
 return <section className="project-reading-page"><a href={browseReturnPath('/app/projects')} className="back-link" onClick={event=>{event.preventDefault();navigate(browseReturnPath('/app/projects'));}}>← {browseReturnLabel('/app/projects')}</a>
  <header className="directory-heading"><div><p className="eyebrow">{projectDocument?.kind==='module'?'模块':'项目'}</p><h1 className="small">{projectDocument?.title??'项目介绍'}</h1></div></header>
  {error&&<p className="message error" role="alert">{error}</p>}{loaded&&!project&&<Button type="button" variant="outline" disabled={busy||!client} onClick={()=>run(load)}>重新读取</Button>}
  {!loaded&&!error&&<p><output>正在读取项目介绍…</output></p>}
  {project&&<article className="project-public-reading">
   <div className="person-line"><MemberAvatar subjectId={project.ownerId}/><span>{name(project.ownerId)} 分享的{projectDocument?.kind==='module'?'模块':'项目'}</span></div>
   <p className="record-meta">{project.state==='active'?'进行中':project.state==='archived'?'已归档':project.state} · {project.visibility==='Public'?'公开介绍':'按所选范围分享'}</p>
   {projectDocument?<><p className="lead reading-prose">{projectDocument.summary}</p><h2>可以做什么</h2><p className="reading-prose">{projectDocument.functions.join('、')}</p>{projectDocument.technologies.length>0&&<><h2>使用的技术</h2><p>{projectDocument.technologies.join('、')}</p></>}
    {projectDocument.sourceUrl&&/^https?:\/\//.test(projectDocument.sourceUrl)&&<p><a href={projectDocument.sourceUrl} target="_blank" rel="noopener noreferrer">查看项目来源 ↗</a></p>}
   </>:<p>你已收到管理转交邀请，请先请原管理者分享必要的项目介绍。</p>}
   <div className="button-row">{projectDocument&&project.state==='active'&&project.ownerId!==subjectId&&!wantsContact&&<Button type="button" onClick={openDirect}>联系这个项目</Button>}
    {(project.permissions?.edit||project.permissions?.represent||(project.management?.transfers?.length??0)>0)&&<Button type="button" variant="outline" onClick={()=>navigate('/app/projects?section=projects&projectId='+projectId)}>{project.management?.transfers?.length?'查看管理与转交':'管理项目'}</Button>}
    {projectDocument&&project.state==='active'&&!relatedOpen&&<button type="button" className="text-link" onClick={()=>setRelatedOpen(true)}>寻找相关项目</button>}
   </div>
   <details className="technical-details"><summary>项目资料与管理信息</summary><p>当前版本 {project.revision} · {projectDocument?.discoverable?'允许参与发现':'未参与新的发现'}</p><p>本人角色：{project.ownRoles?.map((role:string)=>roleNames[role]??role).join('、')||'项目阅读者'}</p>{projectDocument?.participantKind&&projectDocument.participantKind!=='unknown'&&<p>发布者说明的参与身份：{({human:'个人',agent:'Agent',team:'团队',tool:'工具',organization:'组织',service:'服务'} as Record<string,string>)[projectDocument.participantKind]??projectDocument.participantKind}</p>}<p>项目编号 {projectId}</p><p>管理者 {project.ownerId}</p>
    {project.source&&<><p>来源 {project.source.sourceStatementId??'独立项目介绍'} · 当前资料事件 {project.source.documentEventId}</p>{project.source.fieldSources?.map(source=><p key={source.field}>{({title:'名称',summary:'介绍',functions:'功能',technologies:'技术',sourceUrl:'来源地址'} as Record<string,string>)[source.field]??source.field}：{source.subjectId} · {source.operationId}</p>)}</>}
    <button type="button" className="text-link" disabled={!client||busy} onClick={()=>run(load)}>重新读取项目</button>
   </details>
  </article>}
  {wantsContact&&<section id="project-contact" className="project-contact-entry" aria-label="联系当前项目">
   {directError&&<><p className="message"><output>{directError}</output></p><Button type="button" variant="outline" disabled={busy||!client} onClick={()=>run(prepareDirect)}>重新读取联系入口</Button></>}
   {!direct&&!directError&&<p><output>正在读取联系入口…</output></p>}
   {direct&&<OpportunityContactWorkspace runtime={runtime??null} connected={connected} subjectId={subjectId} query={direct.query} opportunity={direct.detail.opportunity} navigate={navigate} onSourceUnavailable={hideDirectSource} onNeedIdentity={()=>navigate('/app/settings/identity')} sourceIsCurrentPage/>}
  </section>}
  {projectDocument&&project.state==='active'&&relatedOpen&&<section className="project-related-search"><button type="button" className="back-link" onClick={()=>setRelatedOpen(false)}>← 收起相关项目</button><h2>寻找相关项目</h2><p>按这个项目的功能和你的交流目的继续寻找。</p>
   <form onSubmit={event=>{event.preventDefault();void search();}} className="workspace-form"><fieldset className="purpose-options"><legend>你希望了解什么</legend>{purposes.map(([id,label])=><label className="checkbox-row" key={id}><input type="checkbox" checked={selected.includes(id)} onChange={event=>setSelected(event.target.checked?[...selected,id]:selected.filter(value=>value!==id))}/>{label}</label>)}</fieldset><Button type="submit" disabled={busy||!client||!selected.length}>{busy?'正在查找…':'查找相关项目'}</Button></form>
   {searched&&!items.length&&<p className="empty-state">暂时没有找到当前可见的相关项目，可以调整交流目的。</p>}
   <div className="reading-list">{items.map(item=><article className="reading-list-item" key={item.id}>{item.sourceUnavailable?<p>这项介绍当前不可读取，请重新查询。</p>:<><p className="record-meta">{item.recruitmentId?'持续招募':'项目介绍'} · {name(item.subjectId)}</p><h3><button type="button" className="reading-title-link" disabled={busy} onClick={()=>run(async commit=>{try{if(!query||!client)throw Error('请先读取当前项目的查找范围。');const value=await client.detail(query,item.opportunityRef);commit(()=>setDetail(value));}catch(reason){commit(()=>{if(opportunityUnavailable(reason))hideSource(item);else setDetail(null);});throw reason;}})}>{item.project.title}</button></h3><p className="reading-prose">{item.help.statement}</p><p className="record-meta">相关功能：{item.help.functions.join('、')}</p>{hasIndependentProject(item)&&<button type="button" className="text-link" onClick={()=>navigate('/app/projects/'+item.projectId)}>阅读项目 →</button>}</>}</article>)}</div>
   {next&&<Button type="button" variant="outline" disabled={busy} onClick={()=>search(next)}>更多相关项目</Button>}{coverage?.windowLimited&&<p className="record-meta">已展示本次查询范围内的可读结果。</p>}
  </section>}
  <dialog ref={detailDialog} className="galaxy-dialog project-opportunity-dialog" onCancel={event=>{if(event.target===event.currentTarget)setDetail(null);}}>
   {detail&&<><header className="dialog-heading"><h2>{detail.opportunity.sourceUnavailable?'项目资料已变化':detail.opportunity.project.title}</h2><button type="button" className="text-link" onClick={()=>setDetail(null)}>关闭</button></header>
    {!detail.opportunity.sourceUnavailable&&<><div className="person-line"><MemberAvatar subjectId={detail.opportunity.subjectId}/><span>{name(detail.opportunity.subjectId)}</span></div><p className="reading-prose">{detail.opportunity.project.summary}</p><p>{detail.opportunity.help?.statement}</p>
     {(detail.experience?.items?.length??0)>0&&<h3>分享的工作经历</h3>}{detail.experience?.items?.map(item=><article className="reading-list-item" key={item.key}><h4>{item.title??'工作记录'}</h4><FactDetails item={item} runtime={runtime} connected={connected} subjectId={subjectId??undefined} navigate={navigate}/>{item.taskId&&<button type="button" className="text-link" onClick={()=>navigate('/app/tasks/'+item.taskId)}>阅读关联工作 →</button>}</article>)}
     {(detail.experience?.nextCursor??detail.experience?.nextAfter)&&<Button type="button" variant="outline" disabled={busy} onClick={()=>run(async commit=>{try{if(!query||!client||!detail.experience)throw Error('请先读取当前项目的查找范围。');const value=await client.detail(query,detail.opportunity.opportunityRef,detail.experience.nextCursor??detail.experience.nextAfter);commit(()=>setDetail(value));}catch(reason){if(opportunityUnavailable(reason))commit(()=>hideSource(detail.opportunity));throw reason;}})}>更多工作经历</Button>}
    </>}
    <OpportunityContactWorkspace runtime={runtime??null} connected={connected} subjectId={subjectId} query={query} opportunity={detail.opportunity} navigate={navigate} onSourceUnavailable={()=>hideSource(detail.opportunity)}/>
   </>}
  </dialog>
 </section>;
}
