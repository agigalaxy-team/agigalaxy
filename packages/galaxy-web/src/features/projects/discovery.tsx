import {ReadingDetails,ReadingSummary} from "../../shared/reading/reading-details";
import {useCurrentTaskMaterialTree} from "../tasks/materials/task-material-view";
import {useEffect,useEffectEvent,useMemo,useRef,useState} from "react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Search,UsersRound,X} from "lucide-react";
import {HistoryFacts} from "../work-records/history";
import {OpportunityContactWorkspace} from "./contacts/opportunity";
import {projectQueryMemory,projectViewScope,opportunityUnavailable} from "./clients/views.mjs";
import {useGovernanceDraft} from "../governance/governance-presentation";
import {MemberLink,memberName,useMemberNames} from "../../shared/people/conversation-ui";
import {DiscoveryTabs,discoveryTarget} from "../discovery/navigation";
import {helpOriginLocator} from "../help-search/help-origin-client.mjs";
import {discoveryQueryV2Schema} from "../../../../galaxy-contracts/src/discovery-schema-v2.mjs";
import "./discovery.css";
import type {ProjectRuntime,DiscoveryPage,Opportunity,VisibleOpportunity,OpportunityDetail,UnavailableOpportunityDetail,DiscoveryQuery} from "./contracts";
import {bodyFreeOpportunity,contactDraftRuntime} from "../help-search/help-contact-view-types";
import type {DiscoveryInput} from "../help-search/help-contact-view-types";
import {useQueryReads,sourceReadDeadline} from "../../application/query-reads";
import {nativeQueryScope} from "../../application/query-scope";
import {LoadingFeedback,ReadFailure} from "../../shared/feedback/interaction-feedback";
import {purposes,tags,errorMessage,discoveryMemory} from "./query-memory";

type Props={runtime:ProjectRuntime|null;connected:boolean;navigate:(path:string)=>void};
export function DiscoveryWorkspace(props:Props){return <DiscoveryView key={projectViewScope(props.runtime,props.connected)} {...props}/>;}
function DiscoveryView({runtime,connected,navigate}:Props){
 const scope=projectViewScope(runtime,connected),subjectId=connected?runtime?.api.snapshot()?.subjectId:undefined;
 const reads=useQueryReads(nativeQueryScope(runtime,subjectId),'projects',scope);
 const [entryQuery]=useState(()=>new URLSearchParams(location.search).get('q'));
 const memoryKey=entryQuery===null?'discovery':'discovery-query:'+entryQuery;
 const originReturn=helpOriginLocator(location.pathname+location.search+location.hash)?.returnTo;
 const [initial]=useState<DiscoveryInput>(()=>{
  const previous=discoveryMemory(projectQueryMemory(runtime,connected,'discovery')),saved=discoveryMemory(projectQueryMemory(runtime,connected,memoryKey));
  const reusable=entryQuery===null||previous.title===entryQuery?previous:{};
  return{title:entryQuery?.slice(0,200)??'',functions:'',technologies:'',selected:['conversation','collaboration'],submittedQuery:null,openedRef:null,...reusable,...saved};
 });
 const draft=useGovernanceDraft(contactDraftRuntime(runtime),subjectId,connected,entryQuery===null?'discovery-input:v2':'discovery-query-input:v1:'+entryQuery,initial),input=useMemo(()=>({...initial,...draft.value}),[initial,draft.value]),inputRef=useRef(input);
 useEffect(()=>{inputRef.current=input;},[input]);
 const [items,setItems]=useState<VisibleOpportunity[]>([]),[next,setNext]=useState<string|null>(null),[readDetail,setDetail]=useState<OpportunityDetail|UnavailableOpportunityDetail|null>(null);
 const [displayQuery,setDisplayQuery]=useState<DiscoveryQuery|null>(null);
 const [busy,setBusy]=useState(false),[searching,setSearching]=useState(false),[error,setError]=useState(''),[detailError,setDetailError]=useState('');
 const [searched,setSearched]=useState(false);
 const query=useRef<DiscoveryQuery|null>(null),opened=useRef<VisibleOpportunity|null>(null),pages=useRef(1),historyPages=useRef(1),booted=useRef(false);
 const life=useRef(0),detailIntent=useRef(0),foregroundDetail=useRef(false),foregroundSearch=useRef(false),background=useRef(false),dialog=useRef<HTMLDialogElement>(null);
 const detail=useCurrentTaskMaterialTree(runtime,readDetail);
 const names=useMemberNames(runtime,subjectId??undefined,connected,[...items.map(item=>item.subjectId),detail?.opportunity?.subjectId]);
 const person=(item:VisibleOpportunity)=>memberName(item.subjectId,subjectId??undefined,names[item.subjectId]??undefined);
 const current=(token:number)=>token===life.current&&projectViewScope(runtime,connected)===scope;
 function change(patch:Partial<DiscoveryInput>){if(['title','functions','technologies','selected'].some(key=>key in patch))detailIntent.current++;const value={...inputRef.current,...patch};inputRef.current=value;draft.change(patch);projectQueryMemory(runtime,connected,'discovery',value);if(memoryKey!=='discovery')projectQueryMemory(runtime,connected,memoryKey,value);}
 async function read<T>(path:string,value:unknown,token:number):Promise<T>{if(!current(token))throw Error('身份或连接已变化，请重新打开查找。');if(!runtime)throw Error('connection_required');const result:T=await runtime.api.call(path,value,{authenticated:connected});if(!current(token))throw Error('身份或连接已变化，请重新打开查找。');return result;}
 useEffect(()=>{const lifeRef=life;lifeRef.current++;return()=>{lifeRef.current++;};},[]);
  useEffect(()=>{if(detail||detailError||busy)dialog.current?.showModal();else dialog.current?.close();},[detail,detailError,busy]);
 function closeDetail(){reads.cancel('detail');detailIntent.current++;foregroundDetail.current=false;opened.current=null;setDetail(null);setDetailError('');setBusy(false);change({openedRef:null});}
 function hideSource(item:VisibleOpportunity){const locator=bodyFreeOpportunity(item);opened.current=locator;setItems(old=>old.map(row=>row.id===item.id?locator:row));setDetail({opportunity:locator,experience:{items:[]}});setDetailError('这份介绍或交流意愿已经变化，请重新查找。');}
 async function inspect(item:VisibleOpportunity,count=1,quiet=false){
  if(!query.current||quiet&&(foregroundDetail.current||opened.current?.id!==item.id))return;
  const token=life.current,selectedQuery=query.current,same=opened.current?.id===item.id;opened.current=item;historyPages.current=count;
  if(!quiet){detailIntent.current++;foregroundDetail.current=true;}
  return reads.run({lane:'detail',key:JSON.stringify([selectedQuery,item.opportunityRef,count,quiet?'refresh':'foreground'])},async({signal})=>{
   let value:OpportunityDetail|null=null,after:string|null=null;const rows:OpportunityDetail['experience']['items']=[];
   for(let page=0;page<count;page++){value=await read<OpportunityDetail>('/v2/discovery/detail',{...selectedQuery,opportunityRef:item.opportunityRef,...(after?{experienceAfter:after}:{})},token);if(signal.aborted)throw new DOMException('Read replaced','AbortError');rows.push(...value.experience.items);after=value.experience.nextCursor??value.experience.nextAfter??null;if(!after)break;}
   if(!value)throw Error('没有读到项目介绍。');value.experience.items=[...new Map(rows.map(row=>[row.key,row])).values()];return value;
  },{
   validUntil:sourceReadDeadline,
   onStart:()=>{if(!quiet){setBusy(true);setDetailError('');if(!same)setDetail(null);change({openedRef:bodyFreeOpportunity(item)});}},
   onSuccess:value=>{if(current(token)){opened.current=value.opportunity;setDetail(value);setDisplayQuery(selectedQuery);setDetailError('');}},
   onError:reason=>{if(current(token)){setDetail({opportunity:bodyFreeOpportunity(item),experience:{items:[]}});setDetailError(opportunityUnavailable(reason)?'这份介绍或交流意愿已经变化，请重新查找。':'暂时无法读取这份资料，联系草稿仍保留。');}},
   onSettled:()=>{if(current(token)&&!quiet){foregroundDetail.current=false;setBusy(false);}},
  });
 }
 async function search(options:{after?:string;restore?:DiscoveryQuery;quiet?:boolean}={}){
  if(!runtime||!draft.ready||options.quiet&&foregroundSearch.current)return;let selectedQuery=options.restore??query.current;
  if(!options.after&&!options.restore){const value=inputRef.current,result=discoveryQueryV2Schema.safeParse({context:{kind:'ephemeral',title:value.title.trim(),functions:tags(value.functions||value.title),technologies:tags(value.technologies)},purposes:value.selected});if(!result.success){setError(value.title.length>80&&!value.functions?'请把想交流的方向缩短到 80 字以内，或在筛选中填写几个简短的方向词。':'请填写简短的交流方向，并至少选择一种交流方式。多个方向可用逗号分开。');return;}selectedQuery={context:result.data.context,purposes:result.data.purposes};pages.current=1;const url=new URL(location.href);url.searchParams.set('q',value.title.trim());history.replaceState(history.state,'',url.pathname+url.search+url.hash);}
  if(!selectedQuery)return;const token=life.current,count=options.after?1:pages.current;query.current=selectedQuery;if(!options.quiet)foregroundSearch.current=true;
  return reads.run({lane:'search',key:JSON.stringify([selectedQuery,options.after??null,count,options.quiet?'refresh':'foreground'])},async({signal})=>{
   let after=options.after??null;const rows:Opportunity[]=[];
   for(let page=0;page<count;page++){const value=await read<DiscoveryPage>('/v2/discovery/query',{...selectedQuery,limit:20,...(after?{after}:{})},token);if(signal.aborted)throw new DOMException('Read replaced','AbortError');rows.push(...value.items);after=value.nextAfter??null;if(!after)break;}return{rows,after};
  },{
   validUntil:sourceReadDeadline,
   onStart:()=>{if(!options.quiet){setSearching(true);setError('');if(!options.after&&!options.restore){reads.cancel('detail');detailIntent.current++;foregroundDetail.current=false;opened.current=null;setDetail(null);setDetailError('');setBusy(false);change({submittedQuery:selectedQuery,openedRef:null});}}},
   onSuccess:({rows,after})=>{if(current(token)){setItems(old=>[...new Map((options.after?[...old,...rows]:rows).map(item=>[item.id,item])).values()]);if(options.after)pages.current++;setNext(after);setSearched(true);setError('');}},
   onError:reason=>{if(current(token)){setError(errorMessage(reason));setItems([]);setNext(null);}},
   onSettled:()=>{if(current(token)&&!options.quiet){foregroundSearch.current=false;setSearching(false);}},
  });
 }
 const reload=useEffectEvent(async()=>{if(background.current||foregroundSearch.current||foregroundDetail.current||document.hidden||!query.current)return;const selectedQuery=query.current,selected=opened.current,intent=detailIntent.current;background.current=true;try{const result=await search({restore:selectedQuery,quiet:true});if(result?.status==='success'&&selected&&query.current===selectedQuery&&opened.current?.id===selected.id&&detailIntent.current===intent&&!foregroundDetail.current)await inspect(selected,historyPages.current,true);}finally{background.current=false;}});
 const restoreSources=useEffectEvent(()=>{
  if(!draft.ready||booted.current)return;booted.current=true;if(!input.submittedQuery){if(entryQuery?.trim())void search();return;}
  const selectedQuery=input.submittedQuery,restore=input.openedRef,intent=detailIntent.current;
  void search({restore:selectedQuery}).then(result=>{if(result?.status==='success'&&restore&&intent===detailIntent.current&&!opened.current)void inspect(restore);});
 });
 useEffect(()=>{restoreSources();},[draft.ready]);
  useEffect(()=>{const refresh=()=>void reload();window.addEventListener('online',refresh);return()=>{window.removeEventListener('online',refresh);};},[]);

 const go=(path:string)=>{reads.cancel('detail');detailIntent.current++;foregroundDetail.current=false;navigate(path);};
 return <section className="discovery-page">
  <DiscoveryTabs path="/app/match" query={input.title} navigate={go}/>
  <header className="discovery-heading">{originReturn&&<a className="back-link" href={originReturn} onClick={event=>{event.preventDefault();go(originReturn);}}>回到原工作</a>}<h1>寻找同行</h1><p>从你关心的方向，找到可以交流的人和项目。</p></header>
  <form className="discovery-search" onSubmit={event=>{event.preventDefault();void search();}}>
   <label htmlFor="discovery-topic">想找什么方向</label><div className="discovery-query-row"><Input id="discovery-topic" required maxLength={200} disabled={!draft.ready} value={input.title} onChange={event=>change({title:event.target.value})} placeholder="例如：阅读体验、网页协作"/><Button type="submit" disabled={!runtime||!draft.ready||searching}>{searching?'正在查找…':<><Search size={17}/>查找</>}</Button></div>
   <div className="discovery-filters"><fieldset><legend>希望怎样交流</legend>{purposes.map(([id,title])=><label key={id}><input type="checkbox" checked={input.selected.includes(id)} onChange={event=>change({selected:event.target.checked?[...input.selected,id]:input.selected.filter(value=>value!==id)})}/>{title}</label>)}</fieldset><label htmlFor="discovery-functions">限定方向（可选）<Input id="discovery-functions" value={input.functions} onChange={event=>change({functions:event.target.value})} placeholder="留空时按上面的方向查找"/></label><label htmlFor="discovery-technologies">技术或环境（可选）<Input id="discovery-technologies" value={input.technologies} onChange={event=>change({technologies:event.target.value})} placeholder="例如：React、PostgreSQL"/></label></div>
   {draft.status&&!['正在保存…','草稿已保存在本机。','已恢复本机草稿。'].includes(draft.status)&&<output>{draft.status}</output>}
  </form>
  {error&&<ReadFailure message={error} onRetry={()=>void search({restore:query.current??undefined})} retrying={searching}/>}
  <LoadingFeedback active={!draft.ready||searching} label={!draft.ready?'正在恢复查找…':'正在查找相关的人和项目…'} scopeKey={JSON.stringify([scope,query.current])}/>
  {draft.ready&&!input.submittedQuery&&!entryQuery?.trim()&&!searched&&!searching&&!error&&<div className="discovery-start"><UsersRound size={28}/><h2>先说一个想交流的方向</h2><p>查看对方正在做的项目，再决定是否联系。交流方式和技术条件可以按需要补充。</p></div>}
  <div className="discovery-results" aria-busy={searching}>{items.map(item=><article key={item.id} className="discovery-result">{item.sourceUnavailable?<p>这项介绍当前无法读取。</p>:<><div className="person-line"><MemberLink subjectId={item.subjectId} name={person(item)} ownId={subjectId??undefined} navigate={navigate} avatar/></div><h2><button type="button" disabled={busy} onClick={()=>void inspect(item)}>{item.project.title}</button></h2><p className="reading-prose">{item.help.statement}</p><p className="discovery-directions">{item.help.functions.join(' · ')}</p><button type="button" className="text-link" disabled={busy} onClick={()=>void inspect(item)}>了解与联系 </button></>}</article>)}</div>
  {searched&&!searching&&!items.length&&!error&&<p className="empty-state">暂时没有找到相关的人或项目，试试更简短的方向词。</p>}{next&&<Button type="button" variant="outline" disabled={searching} onClick={()=>void search({after:next})}>更多结果</Button>}
  <footer className="discovery-other"><a href={discoveryTarget('/app/search',input.title)} onClick={event=>{event.preventDefault();go(discoveryTarget('/app/search',input.title));}}>查找方法与工具 </a><a href="/app/projects?section=projects" onClick={event=>{event.preventDefault();go('/app/projects?section=projects');}}>我的项目与联系 </a></footer>
  <dialog ref={dialog} className="galaxy-dialog discovery-reading" aria-labelledby="discovery-detail-title" onCancel={event=>{if(event.target===event.currentTarget){event.preventDefault();closeDetail();}}}>
    <header className="dialog-heading"><span id="discovery-detail-title">了解与联系</span><button type="button" className="icon-button" aria-label="关闭项目介绍" onClick={closeDetail}><X size={20}/></button></header>
    <LoadingFeedback active={busy&&!detail&&!detailError} label="正在加载项目介绍…" scopeKey={scope+':'+(opened.current?.id??'detail')}/>
   {detailError&&<ReadFailure message={detailError} onRetry={()=>{if(opened.current)void inspect(opened.current,historyPages.current);}} retrying={busy}/>}
    {detail&&detail.experience&&!detail.opportunity.sourceUnavailable&&<><div className="person-line"><MemberLink subjectId={detail.opportunity.subjectId} name={person(detail.opportunity)} ownId={subjectId??undefined} navigate={navigate} avatar/></div><h2>{detail.opportunity.project.title}</h2><p className="discovery-intro reading-prose">{detail.opportunity.project.summary}</p>{detail.opportunity.help.statement!==detail.opportunity.project.summary&&<p className="reading-prose">{detail.opportunity.help.statement}</p>}
    <section className="discovery-experience"><h3>工作经历</h3>{detail.experience.items.map(item=><ReadingDetails key={item.key}><ReadingSummary>{item.title??'这项工作'}</ReadingSummary><HistoryFacts record={item} runtime={runtime} connected={connected} subjectId={subjectId} navigate={go}/></ReadingDetails>)}{!detail.experience.items.length&&<p>对方暂未分享可读的工作经历。</p>}{(detail.experience.nextCursor??detail.experience.nextAfter)&&<button type="button" className="text-link" disabled={busy} onClick={()=>void inspect(detail.opportunity,historyPages.current+1)}>更多经历</button>}</section>
   </>}
   {detail&&<OpportunityContactWorkspace runtime={runtime} connected={connected} subjectId={subjectId} query={displayQuery} opportunity={detail.opportunity} navigate={go} onSourceUnavailable={()=>hideSource(detail.opportunity)} onNeedIdentity={()=>go('/app/settings/identity')}/>}
  </dialog>
 </section>;
}
