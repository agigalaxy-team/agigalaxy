import React,{useEffect,useEffectEvent,useId,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {createHelpSearchClient} from './help-search-client.mjs';
import {ChoiceSyncWorkspace} from './choice-sync-workspace';
import {DiscoveryTabs,discoveryTarget} from './discovery-navigation';
import {OpportunityContactWorkspace} from './opportunity-contact-workspace';
import {MemberAvatar,memberName,useMemberNames} from './conversation-ui';
import {HistoryFacts} from './history-facts';
import {useCurrentTaskMaterialTree,TaskCurrentSourceItem,TaskMaterialNotice} from './task-material-view';
import {useGovernanceDraft} from './governance-presentation';
import {useChoiceViewLease} from './choice-retained-operations';
import {carryHelpOrigin,helpOriginLocator} from './help-origin-client.mjs';
import {searchV2Scope} from '../../galaxy-official/src/shared/search-v2-schema.mjs';
import {discoveryQueryV2Schema} from '../../galaxy-official/src/shared/discovery-schema-v2.mjs';
import type {ProjectRuntime} from './project-workspace-types';
import {contactDraftRuntime} from './help-contact-view-types';
import {projectErrorText} from './project-workspace-types';
import type {ChoiceViewLease} from './choice-retained-operations';
import type {SearchRequest,SearchType,SearchRef,SearchItem,SearchRecord,SearchPage,HelpSearchClient,HelpDetail,HelpLocal,HelpSource,SearchGroup,SearchGroupResult,ReferenceState,SearchReference,ResultRef,LocalChoice,ChoiceReference} from './help-contact-view-types';
import {ArrowLeft,ArrowRight,Bookmark,BookOpen,Check,Layers,Search,SlidersHorizontal,X} from 'lucide-react';

type Props={runtime:ProjectRuntime|null;connected:boolean;subjectId?:string;navigate:(path:string)=>void};
const searchTypes:SearchType[]=['history','capsule','task','opportunity','proof','worker','hub'];
const labels:Record<string,string>={history:'经历',case:'案例',capsule:'方法',task:'求助',opportunity:'交流机会',proof:'CI 证明',worker:'Worker',hub:'Hub',
  failed:'未成功',partial:'部分完成',succeeded:'报告成功',inconclusive:'尚无定论',conflicting:'结论存在冲突',diagnosis:'诊断',advice:'建议',patch:'补丁',verification:'验证',review:'复核','tool-introduction':'引入工具',
  current:'当前来源一致',changed:'来源已更新，原理由需要复看','unavailable-in-current-query':'当前查询中已不可取得','check-failed':'本次核对失败，状态未确认'};
const label=(v:string)=>labels[v]??v;
const candidateKey=(item:Pick<SearchItem,'type'|'ref'>)=>`${item.type}:${item.ref.id}:${item.ref.version}`;
type ReadingLocator=Pick<SearchRef,'type'|'id'|'version'>;
function readingLocator():ReadingLocator|null{
 try{const raw:unknown=JSON.parse(new URLSearchParams(location.search).get('reading')??'null');if(!raw||typeof raw!=='object')return null;const value=raw as Partial<ReadingLocator>;return [...searchTypes,'case'].includes(value.type??'')&&typeof value.id==='string'&&value.id.length<=300&&typeof value.version==='string'&&value.version.length<=512?{type:value.type!,id:value.id,version:value.version}:null;}catch{return null;}
}
function rememberReading(value:ReadingLocator|null){const url=new URL(location.href);if(value)url.searchParams.set('reading',JSON.stringify(value));else url.searchParams.delete('reading');history.replaceState(history.state,'',url.pathname+url.search+url.hash);}
const failure=(e:unknown)=>({history_sources_changed_retry:'来源有变化，请从第一页重新查询。',discovery_sources_changed_retry:'机会已更新，请从第一页重新查询。',search_identity_changed:'身份已变化，请重新打开本页。',choice_version_conflict:'这份选择记录已有新版本，请刷新后编辑。',choice_source_not_read_in_this_client:'先读取当前候选，再保存选择。',comparison_input_changed:'你刚才修改了判断，内容已保留；请确认后再保存。',comparison_source_changed:'参考来源已经变化，请查看当前状态后再决定。',comparison_result_changed:'此前关联的结果版本当前无法读取；原判断仍保留，请核对或明确移除这个引用。'} as Record<string,string>)[projectErrorText(e,'code')||projectErrorText(e)]??'这项操作未完成。请检查当前连接后重试。';
type FactsItem={record:SearchRecord;type?:SearchType;ref?:SearchItem['ref'];source?:SearchItem['source'];sourceVersion?:string;limitations?:SearchItem['limitations']};
function Facts({item:record,runtime}:{item:FactsItem;runtime?:ProjectRuntime|null}) {
  const item=useCurrentTaskMaterialTree(runtime,record);if(!item)return <p>正在核对当前可读来源。</p>;
  const r=item.record;
  if(r?.kind==='case-history'||r?.kind==='task-history')return <HistoryFacts record={r} runtime={runtime??undefined}/>;
  return <div className="fact-details">
    {r.attempts?.map(a=><p key={`${a.id}:${a.version}`}><strong>{a.strategy}</strong> · {label(a.reportedOutcome??a.status??'')}<br/>{a.summary??a.failureReason}<br/><small>{a.environment?`${a.environment.name} ${a.environment.version}`:'环境未提供'} · 版本 {a.version}</small></p>)}
    {r.interventions?.map(v=><p key={`${v.id}:${v.version}`}><strong>{v.types.map(label).join('、')}</strong>：{v.description}<br/>{v.observedEffect}</p>)}
    {r.results?.map(v=><p key={`${v.id}:${v.version}`}><strong>{label(v.reportedOutcome)}</strong>：{v.summary}<br/>适用限制：{v.limitations}</p>)}
    {r.request&&<><section><h3>想完成的事</h3><p>{r.request.workContext?.goal}</p></section>{r.request.workContext?.currentSituation&&<section><h3>目前的情况</h3><p>{r.request.workContext.currentSituation}</p></section>}<p className="help-read-note">{r.enrollmentOpen?'正在寻找帮助':'已结束征集'}</p></>}
    {r.help&&<p>交流方向：{r.help.functions?.join('、')}</p>}
    {r.data&&<p>仓库：{r.data.source.owner}/{r.data.source.repository}<br/>运行：{r.data.source.runId}，第 {r.data.source.attempt} 次<br/>观测结论：{r.data.conclusion}。仓库控制的运行，不代表独立专家认证。</p>}
    {item.type==='capsule'&&!r.newApplicationAllowed&&<p>这份方法当前不宜开始新的应用。</p>}
    {['worker','hub'].includes(item.type??'')&&<p>目录内容来自所有者声明；尚不据此证明远程连接或真实能力。</p>}
    {item.limitations&&item.limitations.length>0&&<section><h4>使用前留意</h4><ul>{item.limitations.map((value,index)=><li key={index}>{typeof value==='string'?value:value.message??value.description??value.reason}</li>)}</ul></section>}
    <details className="help-source-reference"><summary>来源与版本</summary><dl className="source-reference"><dt>来源</dt><dd>{item.ref?.id??item.source?.key??'当前所选记录'}</dd><dt>版本</dt><dd>{item.ref?.version??item.sourceVersion??'随当前来源读取'}</dd></dl></details>
  </div>;
}

function SourceDetail({item,client,readReference,navigate,onCurrent,onInclude,included,runtime,connected,subjectId,search}:{item:SearchItem;client:HelpSearchClient|null;readReference:(item:SearchItem)=>Promise<SearchReference>;navigate:(path:string)=>void;onCurrent:(item:SearchItem)=>void;onInclude:(item:SearchItem)=>void;included:boolean;runtime:ProjectRuntime|null;connected:boolean;subjectId?:string;search:SearchRequest|null}) {
  const [readDetail,setDetail]=useState<HelpDetail|null>(null),[readFresh,setFresh]=useState<SearchItem|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState(''),epoch=useRef(0),reading=useRef(false);
  const detail=useCurrentTaskMaterialTree(runtime,readDetail),fresh=useCurrentTaskMaterialTree(runtime,readFresh);
  const names=useMemberNames(runtime,subjectId,connected,[detail?.opportunity?.subjectId]);
  const parsed=search?.type==='opportunity'?discoveryQueryV2Schema.safeParse(search.query):null;
  const opportunityQuery=parsed?.success?{context:parsed.data.context,purposes:parsed.data.purposes}:null;
  function hideSource(){setFresh(null);setDetail(null);setError('这份介绍或交流意愿已经变化，请返回结果重新查找。联系草稿仍保留。');}
  function read(after:string|null=null):Promise<void>{
    if(reading.current||!client)return Promise.resolve();const token=epoch.current;reading.current=true;
    return readReference(item).then(async current=>{
      if(token!==epoch.current)return;
      if(current.state!=='current'||!current.item){setFresh(null);setDetail(null);setError(current.state==='changed'?'这份内容已有更新。返回查找后，可以打开当前版本。':'这份来源当前无法读取，已收起原内容。');return;}
      const value:HelpDetail=['capsule','opportunity'].includes(item.type)?await client.detail(current.item,{after}):{};
      if(token!==epoch.current)return;
      if(item.type==='capsule'&&(value.capsuleId!==item.id||value.versionId!==item.source.versionId))throw Error('capsule_version_mismatch');
      if(value.sourceStatus==='source-unavailable'){setFresh(null);setDetail(null);setError('方法来源当前不可用，已收起原内容。');return;}
      setFresh(current.item);setDetail(value);setError('');onCurrent(current.item);
    }).catch(reason=>{if(token===epoch.current){setFresh(null);setDetail(null);setError(failure(reason));}}).finally(()=>{reading.current=false;if(token===epoch.current)setBusy(false);});
  }
  const readCurrent=useEffectEvent(()=>read());
  useEffect(()=>{const currentEpoch=epoch;currentEpoch.current++;void readCurrent();const observe=()=>{if(!document.hidden)void readCurrent();};const timer=window.setInterval(observe,30000);document.addEventListener('visibilitychange',observe);return()=>{currentEpoch.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',observe);};},[item,client]);
  const capsuleTarget=detail?.version&&detail.capsuleId&&detail.versionId?carryHelpOrigin('/app/capsules/'+detail.capsuleId+'/versions/'+detail.versionId,location.pathname+location.search+location.hash):null;
  const opportunity=detail?.opportunity;
  return <div>
    {opportunity&&<div className="person-line help-source-person"><MemberAvatar subjectId={opportunity.subjectId}/><span>{memberName(opportunity.subjectId,subjectId,names[opportunity.subjectId]??undefined)}</span></div>}
    <h2 id="help-detail-title">{fresh?.title??'读取参考内容'}</h2>
    {busy&&!fresh&&<output>正在读取当前可见内容…</output>}
    {error&&<p role="alert">{error}<Button type="button" variant="ghost" disabled={busy} onClick={()=>{setBusy(true);setError('');void read();}}>重试</Button></p>}
    {fresh&&<><p className="help-detail-summary">{fresh.summary}</p>
      {detail?.version&&<article className="help-method-reading"><section><h3>具体做法</h3><p className="reading-prose">{detail.version.solutionStrategy}</p></section><section><h3>适用条件</h3><p className="reading-prose">{detail.version.applicableScope}</p><p className="help-read-note">{detail.version.environment.name} {detail.version.environment.version}</p></section>
        {!!detail.version.limitations.length&&<section><h3>使用时留意</h3><ul>{detail.version.limitations.map((value:string)=><li key={value}>{value}</li>)}</ul></section>}
        <section><h3>怎样检查结果</h3><p className="reading-prose">{detail.version.verificationMethod}</p></section>
        {!!(detail.version.tools.length||detail.version.skills.length||detail.version.mcpRefs.length)&&<section className="help-method-tools"><h3>需要的工具</h3>{detail.version.tools.length>0&&<p>{detail.version.tools.join('、')}</p>}{detail.version.skills.length>0&&<p>Skill：{detail.version.skills.join('、')}</p>}{detail.version.mcpRefs.length>0&&<p>MCP：{detail.version.mcpRefs.join('、')}</p>}</section>}
        <p className="help-read-note">版本 {detail.version.version} · 许可：{detail.version.license}</p>
        {capsuleTarget&&<a className="primary-action" href={capsuleTarget} onClick={event=>{event.preventDefault();navigate(capsuleTarget);}}>{helpOriginLocator(location.pathname+location.search+location.hash)?'阅读全文并带回原工作':'阅读全文与使用'} <ArrowRight size={14}/></a>}
      </article>}
      {opportunity&&<div className="help-opportunity-reading">{opportunity.project.summary!==fresh.summary&&<p className="reading-prose">{opportunity.project.summary}</p>}<p className="help-read-note">{opportunity.help.functions.join(' · ')}</p>
       <OpportunityContactWorkspace runtime={runtime} connected={connected} subjectId={subjectId} query={opportunityQuery} opportunity={opportunity} navigate={navigate} onSourceUnavailable={hideSource} onNeedIdentity={()=>navigate('/app/settings/identity')}/>
      </div>}
      {detail?.experience&&<section className="help-source-experience"><h3>相关经历</h3>
        {detail.experience.items.length===0&&<p className="help-read-note">对方暂未分享可读的工作经历。</p>}
        {detail.experience.items.map(record=><details key={record.key}><summary>{record.title??'工作经历'}</summary><Facts runtime={runtime} item={{record,source:{key:record.key},sourceVersion:detail.experience?.rebuild.sourceHash}}/></details>)}
        {detail.experience.nextCursor&&<Button type="button" variant="outline" disabled={busy} onClick={()=>{setBusy(true);void read(detail.experience!.nextCursor);}}>更多经历</Button>}
      </section>}
      {!['capsule','opportunity'].includes(item.type)&&<><TaskMaterialNotice task={fresh.record}/><Facts item={fresh} runtime={runtime}/></>}
      <footer>{fresh.type==='task'&&<Button onClick={()=>navigate('/app/tasks/'+fresh.id)}>查看求助 <ArrowRight size={14}/></Button>}{fresh.type==='opportunity'&&!opportunity&&<Button onClick={()=>navigate(discoveryTarget('/app/match',fresh.title))}>查找相关同行 <ArrowRight size={14}/></Button>}<Button variant="outline" onClick={()=>onInclude(fresh)}>{included?'移出比较':'加入比较'}</Button></footer>
    </>}
  </div>;
}

type HelpView='search'|'saved'|'sync';
type ComparisonDraft={id:string;version:number;localTaskRef:string;rationale:string;refs:SearchRef[];selected:string[];results:ResultRef[];savedSignature:string|null};
const refKey=(ref:ChoiceReference)=>ref.type+':'+ref.id+':'+ref.version;
const cleanSearch=(search:SearchRequest)=>{const value=structuredClone(search);delete value.query.after;return value;};
const signature=(value:ComparisonDraft)=>JSON.stringify({localTaskRef:value.localTaskRef,rationale:value.rationale,refs:value.refs,selected:value.selected,results:value.results});
const blankComparison=(id=crypto.randomUUID()):ComparisonDraft=>({id,version:0,localTaskRef:'',rationale:'',refs:[],selected:[],results:[],savedSignature:null});
const usefulDraft=(value:ComparisonDraft)=>!!(value.refs.length||value.rationale.trim()||value.localTaskRef.trim());
const isUnsaved=(value:ComparisonDraft)=>usefulDraft(value)&&signature(value)!==value.savedSignature;
type HelpInput={query:string;routeQuery:string;functions:string;types:SearchType[];searches:SearchRequest[];pageCounts:Record<string,number>;view:HelpView;sourceFilter:string;filtersOpen:boolean;comparing:boolean;activeId:string;drafts:Record<string,ComparisonDraft>;positions:Record<string,number>};
const helpView=(value:string|null):HelpView=>value==='saved'||value==='sync'?value:'search';
function initialHelpInput():HelpInput{
  const params=new URLSearchParams(location.search),active=blankComparison(),urlView=params.get('view');
  return{query:params.get('q')?.slice(0,200)??'',routeQuery:params.get('q')?.slice(0,200)??'',functions:'',types:['history','capsule','task'],searches:[],pageCounts:{} as Record<string,number>,view:helpView(urlView),sourceFilter:'all',filtersOpen:false,comparing:params.get('compare')==='1',activeId:active.id,drafts:{[active.id]:active} as Record<string,ComparisonDraft>,positions:{} as Record<string,number>};
}

export function HelpSearchWorkspace(props:Props) {
  const scope=useChoiceViewLease(props.runtime,props.subjectId);
  return <HelpSearchSession key={scope.key+':'+props.connected} {...props} lease={scope.lease}/>;
}
function HelpSearchSession({runtime,connected,subjectId,navigate,lease}:Props&{lease:ChoiceViewLease|null}) {
  const origin=helpOriginLocator(location.pathname+location.search+location.hash),originReturn=origin?.returnTo,publishTarget=carryHelpOrigin('/app/publish',location.pathname+location.search+location.hash);
  const initial=useMemo(()=>initialHelpInput(),[]),initialParams=useMemo(()=>new URLSearchParams(location.search),[]);
  const client:HelpSearchClient|null=useMemo(()=>runtime?createHelpSearchClient(runtime,{authenticated:connected,subjectId:subjectId??null}):null,[runtime,connected,subjectId]);
  // This record contains only the owner's input and exact source locators.
  const draft=useGovernanceDraft(contactDraftRuntime(runtime),subjectId,!!lease,'help-search-input:v1:'+JSON.stringify([runtime?.api.endpoint,subjectId??null,origin?.taskId??null]),initial);
  const input=useMemo(()=>({...initial,...draft.value}),[initial,draft.value]),inputRef=useRef(input),draftRef=useRef(draft);useEffect(()=>{inputRef.current=input;draftRef.current=draft;},[input,draft]);
  const active:ComparisonDraft=input.drafts[input.activeId]??initial.drafts[initial.activeId],activeRef=useRef(active);useEffect(()=>{activeRef.current=active;},[active]);
  const [sources,setSources]=useState<HelpSource[]>([]),[extraItems,setExtraItems]=useState<SearchItem[]>([]),[readReferenceStates,setReferenceStates]=useState<Record<string,ReferenceState>>({});
  const referenceStates=useCurrentTaskMaterialTree(runtime,readReferenceStates)??{};
  const [busy,setBusy]=useState(false),[refreshing,setRefreshing]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[local,setLocal]=useState<HelpLocal>({choices:[],referenceStates:{}});
  const [savedLimit,setSavedLimit]=useState(8),[opened,setOpened]=useState<SearchItem|null>(null),[restored,setRestored]=useState(false),detailDialog=useRef<HTMLDialogElement>(null);
  const [openedSearch,setOpenedSearch]=useState<SearchRequest|null>(null);
  const fieldId=useId();
  const generation=useRef(0),working=useRef(false),background=useRef(false),sourceSerial=useRef(0),booted=useRef(false),positionTimer=useRef<number|undefined>(undefined),positionRestoring=useRef(false),positionRestoreSerial=useRef(0);
  const lookup=useRef<Record<string,SearchRequest>>({});
  const isCurrent=(token=generation.current)=>{if(token!==generation.current)return false;try{lease?.assertCurrent();return true;}catch{return false;}};
  function change(patch:Partial<HelpInput>){const next={...inputRef.current,...patch};inputRef.current=next;activeRef.current=next.drafts[next.activeId]??activeRef.current;draftRef.current.change(patch);}
  function changeActive(patch:Partial<ComparisonDraft>){const current=inputRef.current,old=current.drafts[current.activeId]??activeRef.current,next={...old,...patch};change({drafts:{...current.drafts,[next.id]:next}});}
  const positionKey=(value:HelpInput)=>value.view==='search'&&value.comparing?'compare:'+value.activeId:value.view;
  function rememberPosition(){if(!draftRef.current.ready||positionRestoring.current)return;const current=inputRef.current,key=positionKey(current),y=Math.max(0,Math.round(window.scrollY));if(Math.abs((current.positions[key]??0)-y)>2)change({positions:{...current.positions,[key]:y}});}
  function route(value:HelpInput){const url=new URL(location.href);url.searchParams.set('view',value.view);if(value.routeQuery)url.searchParams.set('q',value.routeQuery);else url.searchParams.delete('q');if(value.comparing&&value.view==='search')url.searchParams.set('compare','1');else url.searchParams.delete('compare');history.replaceState({...history.state,scrollY:window.scrollY},'',url.pathname+url.search+url.hash);}
  function restorePosition(value:HelpInput){positionRestoring.current=true;const y=value.positions[positionKey(value)]??0,token=generation.current,serial=++positionRestoreSerial.current,href=location.href;requestAnimationFrame(()=>requestAnimationFrame(()=>{if(serial!==positionRestoreSerial.current)return;positionRestoring.current=false;if(isCurrent(token)&&location.href===href)window.scrollTo({top:y,behavior:'auto'});}));}
  function goView(view:HelpView,comparing=false){rememberPosition();const next={...inputRef.current,view,comparing};change({view,comparing});route(next);restorePosition(next);}
  function leave(target:string){rememberPosition();navigate(target);}
  function openSource(item:SearchItem){rememberReading({type:item.type,...item.ref});setOpenedSearch(sourceSearch(item));setOpened(item);}
  function closeSource(){rememberReading(null);setOpened(null);setOpenedSearch(null);}
  function sourceSearch(item:SearchItem){return lookup.current[candidateKey(item)]??activeRef.current.refs.find(ref=>refKey(ref)===candidateKey(item))?.search??inputRef.current.searches.find(search=>search.type===item.type)??null;}
  async function run(fn:(valid:()=>boolean)=>Promise<void>){if(working.current||!client)return;const token=generation.current,valid=()=>isCurrent(token);working.current=true;setBusy(true);setError('');setNotice('');
    try{await fn(valid);}catch(e){if(valid())setError(failure(e));}finally{working.current=false;if(valid())setBusy(false);}
  }
  function requests(value:HelpInput):SearchRequest[]{return value.types.map((type):SearchRequest=>type==='opportunity'?{type,query:{context:{kind:'ephemeral',title:value.query.trim()||'主动寻找相关交流',functions:value.functions.split(/[,，\n]/).map(v=>v.trim()).filter(Boolean)},purposes:['conversation','collaboration'],limit:8}}:{type,query:{query:value.query,limit:8}});}
  function currentContext(value:HelpInput){const selected=value.drafts[value.activeId];return JSON.stringify({searches:value.searches,pageCounts:value.pageCounts,activeId:value.activeId,refs:selected?.refs});}
  async function readContent(value:HelpInput,valid:()=>boolean) {
    if(!client)return null;const serial=++sourceSerial.current,context=currentContext(value),selected:ComparisonDraft=value.drafts[value.activeId]??activeRef.current,groups=new Map<string,SearchGroup>();
    for(const search of value.searches){const clean=cleanSearch(search),key=JSON.stringify(clean);groups.set(key,{key,search:clean,pages:Math.max(1,value.pageCounts[search.type]??1),base:true,refs:[]});}
    const retainedRefs=[...selected.refs],reading=readingLocator();
    if(reading&&!retainedRefs.some(ref=>ref.type===reading.type&&ref.id===reading.id&&ref.version===reading.version)){const search=value.searches.find(search=>search.type===reading.type);if(search)retainedRefs.push({...reading,search});}
    for(const ref of retainedRefs){if(!ref.search)continue;const search=cleanSearch(ref.search),key=JSON.stringify(search),group=groups.get(key)??{key,search,pages:1,base:false,refs:[]};group.refs.push(ref);groups.set(key,group);}
    const allowed=()=>valid()&&serial===sourceSerial.current&&context===currentContext(inputRef.current);
    const rows:SearchGroupResult[]=[];const entries=[...groups.values()];
    // Re-run original queries. Source bodies are held only in memory, and old
    // versions never become the newly selected version without a user action.
    for(let offset=0;offset<entries.length;offset+=4){
      const batch=await Promise.all(entries.slice(offset,offset+4).map(async group=>{
        const found:SearchItem[]=[],cursors=new Set<string>();let after:string|null=null,page:SearchPage|null=null,count=0;
        try{
          do{
            if(!allowed())return null;const request=cleanSearch(group.search);if(after)request.query.after=after;page=await client.query(request);if(!allowed())return null;count++;
            for(const item of page.items){if(!found.some(old=>candidateKey(old)===candidateKey(item)))found.push(item);lookup.current[candidateKey(item)]=group.search;}
            const needsRefs=group.refs.some((ref:SearchRef)=>!found.some(item=>item.ref.id===ref.id));after=page.nextCursor;
            if(!after||count>=group.pages&&!needsRefs)break;if(cursors.has(after))throw Error('search_source_cursor_loop');cursors.add(after);
          }while(after);
          if(!page)return null;return{...group,state:'fulfilled' as const,page:{...page,items:found},items:found,loadedPages:count};
        }catch(e){return{...group,state:'failed' as const,error:failure(e),page:null,items:[]};}
      }));if(!allowed())return null;rows.push(...batch.filter(row=>row!==null));
    }
    const states:Record<string,ReferenceState>={},all:SearchItem[]=[];
    for(const row of rows)for(const item of row.items)if(!all.some(old=>candidateKey(old)===candidateKey(item)))all.push(item);
    for(const ref of selected.refs){const search=ref.search,row=search?rows.find(r=>r.key===JSON.stringify(cleanSearch(search))):null,item=row?.items.find(candidate=>candidate.ref.id===ref.id);states[refKey(ref)]=!row||row.state==='failed'?{state:'check-failed',item:null}:{state:item?(item.ref.version===ref.version?'current':'changed'):'unavailable-in-current-query',item:item??null};}
    if(allowed()){setSources(value.searches.map(search=>{const row=rows.find(r=>r.key===JSON.stringify(cleanSearch(search)));return row?.state==='fulfilled'?{type:search.type,state:'fulfilled' as const,page:row.page,loadedPages:row.loadedPages}:{type:search.type,state:'failed' as const,page:null,error:row?.error};}));setExtraItems(all);setReferenceStates(states);}
    return allowed()?{items:all,states}:null;
  }
  function refreshSaved():Promise<void>{
    if(!client||!isCurrent()||document.hidden||working.current||background.current)return Promise.resolve();background.current=true;const token=generation.current;
    return client.local().then(async data=>{
      let value=data;if(!isCurrent(token))return;setRefreshing(true);
      if(inputRef.current.view==='saved')for(const choice of [...value.choices].reverse().slice(0,savedLimit)){value=await client.refreshChoice(choice.id);if(!isCurrent(token))return;}
      if(isCurrent(token))setLocal(value);
    }).catch(()=>{if(isCurrent(token))setNotice('部分来源暂时无法核对，原判断仍保留。');}).finally(()=>{background.current=false;if(isCurrent(token))setRefreshing(false);});
  }
  const refreshSavedCurrent=useEffectEvent(()=>refreshSaved());
  const refreshSourcesCurrent=useEffectEvent(async()=>{
    if(!restored||working.current||background.current||document.hidden||inputRef.current.view!=='search'||!client)return;const token=generation.current;background.current=true;setRefreshing(true);
    try{await readContent(inputRef.current,()=>isCurrent(token));}finally{background.current=false;if(isCurrent(token))setRefreshing(false);}
  });
  const refreshLocal=useEffectEvent((token:number)=>{if(document.hidden||working.current||background.current||!client)return;void client.local().then(value=>{if(isCurrent(token))setLocal(value);}).catch(()=>{});});
  const rememberCurrentPosition=useEffectEvent(()=>rememberPosition());
  useEffect(()=>{const epoch=generation,sourceRequests=sourceSerial;const token=++epoch.current;const reload=()=>refreshLocal(token);reload();
    const localTimer=window.setInterval(reload,15000),sourceTimer=window.setInterval(()=>{void refreshSourcesCurrent();void refreshSavedCurrent();},60000);
    const visible=()=>{if(!document.hidden){void refreshSourcesCurrent();void refreshSavedCurrent();}},scrolled=()=>{window.clearTimeout(positionTimer.current);positionTimer.current=window.setTimeout(rememberCurrentPosition,180);};
    document.addEventListener('visibilitychange',visible);window.addEventListener('scroll',scrolled,{passive:true});
    return()=>{epoch.current++;sourceRequests.current++;window.clearInterval(localTimer);window.clearInterval(sourceTimer);window.clearTimeout(positionTimer.current);document.removeEventListener('visibilitychange',visible);window.removeEventListener('scroll',scrolled);client?.close();};
  },[client,lease]);
  const restoreInput=useEffectEvent(()=>{
    if(!draft.ready||booted.current||!client)return Promise.resolve();booted.current=true;
    const token=generation.current,valid=()=>isCurrent(token);
    return client.local().then(data=>({data,error:null})).catch(reason=>({data:null,error:failure(reason)})).then(async result=>{
      if(!valid())return;if(result.error)setError(result.error);
      let value=inputRef.current,patch:Partial<HelpInput>={};const urlView=initialParams.get('view'),urlQuery=initialParams.get('q');
      if(['search','saved','sync'].includes(urlView??''))patch.view=helpView(urlView);
      if(initialParams.has('compare'))patch.comparing=initialParams.get('compare')==='1';
      if(urlQuery!==null&&urlQuery.slice(0,200)!==value.routeQuery){const next=blankComparison();patch={...patch,query:urlQuery.slice(0,200),routeQuery:urlQuery.slice(0,200),searches:[],pageCounts:{},activeId:next.id,drafts:{...value.drafts,[next.id]:next},comparing:false};}
      if(!value.searches.length&&(patch.query??value.query).trim())patch.searches=requests({...value,...patch});
      if(Object.keys(patch).length){change(patch);value=inputRef.current;}
      if(result.data)setLocal(result.data);
      const content=value.view==='search'?await readContent(value,valid):null;if(!valid())return;
      const reading=readingLocator();if(reading&&content){const item=content.items.find(item=>item.type===reading.type&&item.ref.id===reading.id&&item.ref.version===reading.version);if(item){setOpenedSearch(sourceSearch(item));setOpened(item);}else setNotice('刚才查看的内容暂未读到，可以重新查找当前可用的版本。');}
      setRestored(true);route(value);restorePosition(value);
    }).catch(reason=>{if(valid())setError(failure(reason));});
  });
  useEffect(()=>{void restoreInput();},[draft.ready,client]);
  useEffect(()=>{if(restored&&input.view==='saved')void refreshSavedCurrent();},[restored,input.view,savedLimit]);
  useEffect(()=>{if(opened)detailDialog.current?.showModal();else detailDialog.current?.close();},[opened]);
  async function search(valid:()=>boolean){
    rememberPosition();const current=inputRef.current,next=blankComparison(),old=current.drafts[current.activeId],drafts={...current.drafts};if(old&&!isUnsaved(old))delete drafts[old.id];drafts[next.id]=next;
    change({searches:requests(current),routeQuery:current.query,pageCounts:{},activeId:next.id,drafts,sourceFilter:'all',comparing:false,view:'search'});route(inputRef.current);setSources([]);setExtraItems([]);setReferenceStates({});await readContent(inputRef.current,valid);if(valid())restorePosition({...inputRef.current,positions:{...inputRef.current.positions,search:0}});
  }
  async function more(type:string,valid:()=>boolean){change({pageCounts:{...inputRef.current.pageCounts,[type]:(sources.find(source=>source.type===type)?.loadedPages??inputRef.current.pageCounts[type]??1)+1}});await readContent(inputRef.current,valid);}
  const items=[...sources.flatMap(source=>source.page?.items??[]),...extraItems].filter((item,index,all)=>all.findIndex(other=>candidateKey(other)===candidateKey(item))===index);
  const resultOptions=items.flatMap(item=>{const caseId=item.record.caseId;if(!caseId)return[];return(item.record.results??[]).filter(value=>!value.supersededInVisibleHistory).map(value=>({key:caseId+':'+value.id+':'+value.version,ref:{caseId,id:value.id,version:value.version},summary:value.summary,outcome:value.reportedOutcome}));}).filter((value,index,all)=>all.findIndex(other=>other.key===value.key)===index);
  const resultKey=(value:ResultRef)=>value.caseId+':'+value.id+':'+value.version;
  const candidateKeys=active.refs.map(refKey),selected=active.selected;
  function include(item:SearchItem){
    const key=candidateKey(item),current=activeRef.current,exists=current.refs.some(ref=>refKey(ref)===key),search=lookup.current[key]??inputRef.current.searches.find(value=>value.type===item.type);if(!search&&!exists){setError('这份来源当前未读到，请重新查找。');return;}
    const refs=exists?current.refs.filter(ref=>refKey(ref)!==key):[...current.refs,{type:item.type,id:item.ref.id,version:item.ref.version,search:search?cleanSearch(search):null}];
    changeActive({refs,selected:current.selected.filter(value=>value!==key),localTaskRef:current.localTaskRef||inputRef.current.query.trim()});
    setReferenceStates(old=>({...old,[key]:{state:'current',item}}));
  }
  function removeReference(ref:SearchRef){const key=refKey(ref);changeActive({refs:activeRef.current.refs.filter(value=>refKey(value)!==key),selected:activeRef.current.selected.filter(value=>value!==key)});}
  function selectCurrent(ref:SearchRef,item:SearchItem){const key=refKey(ref),nextKey=candidateKey(item),current=activeRef.current;changeActive({refs:current.refs.map(value=>refKey(value)===key?{...value,id:item.ref.id,version:item.ref.version}:value).filter((value,index,all)=>all.findIndex(other=>refKey(other)===refKey(value))===index),selected:current.selected.includes(key)?[...new Set(current.selected.map(value=>value===key?nextKey:value))]:current.selected});setReferenceStates(old=>({...old,[nextKey]:{state:'current',item}}));setNotice('已改用当前版本，请按新内容核对你的判断。');}
  async function openDraft(id:string,valid:()=>boolean){rememberPosition();change({activeId:id,view:'search',comparing:true});route(inputRef.current);setReferenceStates({});setExtraItems([]);await readContent(inputRef.current,valid);if(valid())restorePosition(inputRef.current);}
  async function editChoice(choice:LocalChoice,valid:()=>boolean){
    const existing=inputRef.current.drafts[choice.id];if(existing&&isUnsaved(existing)){await openDraft(choice.id,valid);return;}
    lease?.assertCurrent();if(!runtime)return;const lookups:Record<string,SearchRequest>|null=await runtime.getLocal('help-choice-lookups-v2',subjectId);lease?.assertCurrent();if(!valid())return;
    const saved=choice.versions.at(-1);if(!saved)return;const value:ComparisonDraft={id:choice.id,version:saved.version,localTaskRef:saved.localTaskRef,rationale:saved.visibleRationale,refs:saved.candidateRefs.map(ref=>({...ref,search:lookups?.[refKey(ref)]??null})),selected:saved.selectedRefs.map(refKey),results:saved.resultRefs??[],savedSignature:null};value.savedSignature=signature(value);
    change({drafts:{...inputRef.current.drafts,[value.id]:value}});await openDraft(value.id,valid);
  }
  async function saveComparison(valid:()=>boolean){
    const before=structuredClone(activeRef.current),beforeSignature=signature(before),loaded=await readContent(inputRef.current,valid);if(!valid()||!loaded)return;
    if(beforeSignature!==signature(activeRef.current))throw Error('comparison_input_changed');
    if(before.refs.some(ref=>loaded.states[refKey(ref)]?.state!=='current'))throw Error('comparison_source_changed');
    const actualResults=loaded.items.flatMap(item=>{const caseId=item.record.caseId;if(!caseId)return[];return(item.record.results??[]).filter(value=>!value.supersededInVisibleHistory).map(value=>({caseId,id:value.id,version:value.version}));});
    if(before.results.some(ref=>!actualResults.some(value=>resultKey(value)===resultKey(ref))))throw Error('comparison_result_changed');
    const saved=await client!.saveChoice({id:before.id,expectedVersion:before.version,localTaskRef:before.localTaskRef,visibleRationale:before.rationale,rationaleAuthor:'user',candidateKeys:before.refs.map(refKey),selectedKeys:before.selected,resultRefs:before.results});if(!valid())return;
    const value=await client!.local();if(!valid())return;setLocal(value);
    const latest=inputRef.current.drafts[before.id];if(latest){const same=signature(latest)===beforeSignature;change({drafts:{...inputRef.current.drafts,[before.id]:{...latest,version:saved.version,savedSignature:beforeSignature}}});if(same&&inputRef.current.activeId===before.id){goView('saved');setNotice('这次参考已保存。');}else setNotice('刚才的判断已保存，之后输入的内容仍留在本机草稿。');}
  }
  async function readReference(item:SearchItem):Promise<SearchReference>{const token=generation.current,search=lookup.current[candidateKey(item)]??activeRef.current.refs.find(ref=>refKey(ref)===candidateKey(item))?.search;if(!runtime||!search||!isCurrent(token))throw Error('choice_source_not_read_in_this_client');
    const scope=searchV2Scope(item.type),granted=runtime.api.snapshot()?.scopes??[],value:SearchReference=await runtime.api.call('/v2/search/reference',{search:cleanSearch(search),ref:item.ref},{authenticated:connected&&(granted.includes('*')||granted.includes(scope))});if(!isCurrent(token))throw Error('search_identity_changed');
    if(value.state!=='current'){const key=candidateKey(item);setSources(old=>old.map(source=>source.state==='fulfilled'?{...source,page:{...source.page,items:source.page.items.filter(candidate=>candidateKey(candidate)!==key)}}:source));setExtraItems(old=>old.filter(candidate=>candidateKey(candidate)!==key));setReferenceStates(old=>({...old,[key]:{state:value.state,item:value.item??null}}));}
    return value;
  }
  const granted=runtime?.api.snapshot()?.scopes??[],publicOnly=connected?input.types.filter(type=>{const scope=searchV2Scope(type);return !!scope&&!granted.includes('*')&&!granted.includes(scope);}):[];
  const allEmpty=sources.length>0&&sources.every(source=>source.state!=='failed'&&source.page?.sourceState!=='disabled'&&source.page?.items?.length===0&&!source.page?.nextCursor),shownSources=sources.filter(source=>input.sourceFilter==='all'||source.type===input.sourceFilter);
  const unsaved=Object.values(input.drafts).filter(isUnsaved),unavailable=active.refs.some(ref=>referenceStates[refKey(ref)]?.state!=='current');
  return <section className="help-search-page">
    <DiscoveryTabs path="/app/search" query={input.query} navigate={leave}/>
    <header className="help-page-heading"><div>{originReturn&&<a className="back-link" href={originReturn} onClick={event=>{event.preventDefault();leave(originReturn);}}><ArrowLeft size={14}/>回到原工作</a>}<h1 className="small">找帮助</h1><p>从做过的事、可用的方法和正在发生的交流开始。</p></div><a href={publishTarget} onClick={event=>{event.preventDefault();leave(publishTarget);}}>发起求助 <ArrowRight size={15}/></a></header>
    <nav className="help-view-tabs" aria-label="查找与参考"><button aria-current={input.view==='search'?'page':undefined} onClick={()=>{goView('search');if(!sources.length&&input.searches.length)void run(valid=>readContent(inputRef.current,valid).then(()=>{}));}}><Search size={15}/>查找</button><button aria-current={input.view==='saved'?'page':undefined} onClick={()=>goView('saved')}><Bookmark size={15}/>我的参考{local.choices.length>0&&<span>{local.choices.length}</span>}</button>{input.view==='sync'&&<span aria-current="page">跨设备使用</span>}</nav>
    {error&&<p role="alert" className="message error">{error}</p>}{notice&&<output className="message">{notice}</output>}
    {!draft.ready||!restored?<output>正在恢复这次查找…</output>:<>
    {lease&&draft.status&&input.view==='search'&&<output className="draft-status">{draft.status}</output>}
    {input.view==='search'&&!input.comparing&&<>
      <form className="help-query" onSubmit={event=>{event.preventDefault();void run(search);}}><div><Search size={19}/><Input aria-label="查找帮助" value={input.query} maxLength={200} onChange={event=>change({query:event.target.value})} placeholder="你正在做什么，或需要怎样的帮助？"/><Button type="submit" disabled={!client||busy||!input.types.length}>{busy?'查找中…':'查找'}</Button></div><button type="button" className="text-action" aria-expanded={input.filtersOpen} onClick={()=>change({filtersOpen:!input.filtersOpen})}><SlidersHorizontal size={14}/>来源与条件</button>{input.filtersOpen&&<fieldset className="help-source-options"><legend>查询哪些内容</legend><div>{searchTypes.map(type=><label key={type}><input type="checkbox" checked={input.types.includes(type)} onChange={event=>change({types:event.target.checked?[...input.types,type]:input.types.filter(value=>value!==type)})}/>{label(type)}</label>)}</div>{input.types.includes('opportunity')&&<label htmlFor={fieldId+'-functions'}>想交流的事情<Input id={fieldId+'-functions'} required value={input.functions} onChange={event=>change({functions:event.target.value})} placeholder="例如：文档解析，表格识别"/><small>不同的事情用逗号分开。</small></label>}</fieldset>}</form>
      {publicOnly.length>0&&<p className="help-read-note">部分来源仅查询公开资料。</p>}
      {sources.length>0&&<nav className="help-source-tabs" aria-label="结果类别"><button aria-pressed={input.sourceFilter==='all'} onClick={()=>change({sourceFilter:'all'})}>全部</button>{sources.map(source=><button key={source.type} aria-pressed={input.sourceFilter===source.type} onClick={()=>change({sourceFilter:source.type})}>{label(source.type)}{source.state==='fulfilled'&&<span>{source.page.items.length}{source.page.nextCursor?'+':''}</span>}</button>)}</nav>}
      {(busy||refreshing)&&!sources.length&&<output className="reading-status">正在读取当前来源…</output>}
      {!sources.length&&!busy&&!refreshing&&<div className="help-start"><BookOpen size={30}/><h2>有用的经验，可能就在下一次查找里</h2><p>试试目标、方法或环境关键词。</p><a href="/app/participate" onClick={event=>{event.preventDefault();leave('/app/participate');}}>看看大家正在做什么 <ArrowRight size={14}/></a></div>}
      {allEmpty&&<div className="empty-state"><h2>暂时没有相关内容</h2><p>换一个关键词，或把想推进的事发成求助。</p><Button variant="outline" onClick={()=>leave(publishTarget)}>发起求助</Button></div>}
      {!allEmpty&&shownSources.map(source=><section key={source.type} className="help-results-group" aria-label={label(source.type)}>
        {source.state==='failed'?<div className="help-source-error"><p>{label(source.type)}暂时无法读取。</p><Button variant="ghost" disabled={busy} onClick={()=>void run(valid=>readContent(inputRef.current,valid).then(()=>{}))}>重试</Button></div>:<>
          {source.page.sourceState==='disabled'?<p className="help-read-note">交流发现已暂停。<a href="/app/match" onClick={event=>{event.preventDefault();leave('/app/match');}}>调整偏好</a></p>:source.page.items.length===0&&input.sourceFilter!=='all'?<p className="help-read-note">这一类暂时没有匹配内容。</p>:null}
          <div className="help-results">{source.page.items.map(sourceItem=><TaskCurrentSourceItem key={candidateKey(sourceItem)} runtime={runtime} item={sourceItem}>{item=><article><div className="help-result-type"><span>{label(item.type)}</span>{candidateKeys.includes(candidateKey(item))&&<span><Check size={12}/>已加入比较</span>}</div><h2><button onClick={()=>openSource(item)}>{item.title}</button></h2><p>{item.summary}</p><footer><button className="text-action" onClick={()=>openSource(item)}>{item.type==='capsule'?'了解这份方法':item.type==='opportunity'?'了解对方的工作':'查看内容'}<ArrowRight size={13}/></button><button className="text-action" disabled={busy} aria-pressed={candidateKeys.includes(candidateKey(item))} onClick={()=>include(item)}><Layers size={13}/>{candidateKeys.includes(candidateKey(item))?'移出比较':'加入比较'}</button></footer></article>}</TaskCurrentSourceItem>)}</div>
          {source.page.nextCursor&&<button className="load-more" disabled={busy} onClick={()=>void run(valid=>more(source.type,valid))}>更多{label(source.type)}</button>}
        </>}
      </section>)}
      {candidateKeys.length>0&&<div className="help-selection-bar"><span><Layers size={16}/>{candidateKeys.length} 项待比较</span><button onClick={()=>goView('search',true)}>看看这些参考 <ArrowRight size={14}/></button></div>}
      {unsaved.filter(value=>value.id!==active.id).length>0&&<p className="help-read-note">此前未保存的判断保留在<button className="text-action" onClick={()=>goView('saved')}>我的参考</button>。</p>}
    </>}
    {input.view==='search'&&input.comparing&&<section className="help-comparison">
      <button className="back-link" onClick={()=>goView('search')}><ArrowLeft size={15}/>返回查找结果</button><h2>这次要参考什么？</h2>
      <div className="help-comparison-list">{active.refs.map(ref=>{const key=refKey(ref),state=referenceStates[key],item=state?.item,current=state?.state==='current';return <article key={key}>
        <label><input type="checkbox" disabled={!current||busy} checked={selected.includes(key)} onChange={event=>changeActive({selected:event.target.checked?[...active.selected,key]:active.selected.filter(value=>value!==key)})}/><span><small>{label(ref.type)}{state&&!current?' · '+label(state.state):''}</small><strong>{item?.title??'此前加入的'+label(ref.type)}</strong>{current&&item?<p>{item.summary}</p>:<p>{state?.state==='changed'?'来源有新版本，原来的选择与理由仍保留。':state?.state==='unavailable-in-current-query'?'当前查询已无法取得这份内容。你可以保留判断草稿，或明确移除此引用。':state?.state==='check-failed'?'本次未能核对来源，正文暂时收起。':'正在读取当前来源…'}</p>}</span></label>
        <button className="icon-button" disabled={busy} aria-label={'移出比较：'+(item?.title??label(ref.type))} onClick={()=>removeReference(ref)}><X size={16}/></button>
        {item&&<button className="text-action" disabled={busy} onClick={()=>openSource(item)}>{current?'查看内容':'查看当前版本'}</button>}{state?.state==='changed'&&item&&<button className="text-action" disabled={busy} onClick={()=>selectCurrent(ref,item)}>改用当前版本</button>}{state?.state==='check-failed'&&<button className="text-action" disabled={busy} onClick={()=>void run(valid=>readContent(inputRef.current,valid).then(()=>{}))}>重新读取</button>}
      </article>;})}</div>
      {!active.refs.length&&<p className="help-read-note">还没有加入参考。返回查找后可以继续选择，下面的文字会保留。</p>}
      <form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(saveComparison);}}>
        <label htmlFor={fieldId+'-work'}>用于哪项工作<Input id={fieldId+'-work'} required maxLength={300} value={active.localTaskRef} onChange={event=>changeActive({localTaskRef:event.target.value})}/></label>
        <label htmlFor={fieldId+'-rationale'}>记下你的判断<Textarea id={fieldId+'-rationale'} required maxLength={1200} value={active.rationale} onChange={event=>changeActive({rationale:event.target.value})} placeholder="哪些内容有帮助，或者还需要确认什么？"/></label>
        {(resultOptions.length>0||active.results.length>0)&&<details className="help-optional-results" open={active.results.length>0||undefined}><summary>{active.results.length?`已关联 ${active.results.length} 项结果`:'关联已有结果（可选）'}</summary><fieldset><legend className="sr-only">选择已有结果</legend>{resultOptions.map(value=><label key={value.key}><input type="checkbox" checked={active.results.some(ref=>resultKey(ref)===value.key)} onChange={event=>changeActive({results:event.target.checked?[...active.results,value.ref]:active.results.filter(ref=>resultKey(ref)!==value.key)})}/>{label(value.outcome)}：{value.summary}</label>)}{active.results.filter(ref=>!resultOptions.some(value=>value.key===resultKey(ref))).map(ref=><p key={resultKey(ref)}>此前关联的结果版本当前未读到。<button type="button" className="text-action" onClick={()=>changeActive({results:active.results.filter(value=>resultKey(value)!==resultKey(ref))})}>移除这个结果引用</button></p>)}</fieldset></details>}
        <p className="help-read-note">勾选的内容会记为本次参考。你的输入自动保存在此浏览器。</p>
        {unavailable&&<p className="help-read-note">有来源需要核对。保留原判断，或明确选择当前版本后再保存。</p>}
        <Button type="submit" disabled={busy||!candidateKeys.length||candidateKeys.length>64||unavailable}>{busy?'正在保存…':'保存这次参考'}</Button>{candidateKeys.length>64&&<p role="alert">一次最多保存 64 项，请移出一些内容。</p>}
      </form>
    </section>}
    {input.view==='saved'&&<section className="help-saved"><div className="section-heading"><h2>我的参考</h2><button className="text-action" onClick={()=>goView('sync')}>跨设备使用 <ArrowRight size={14}/></button></div>
      {unsaved.length>0&&<section aria-label="未保存的判断"><h3>继续未保存的判断</h3>{unsaved.map(value=><article className="help-saved-item" key={value.id}><h3>{value.localTaskRef||'还没命名的判断'}</h3>{value.rationale&&<p>{value.rationale}</p>}<p className="help-read-note">{value.refs.length} 项待比较 · 本机草稿</p><button className="text-action" disabled={busy} onClick={()=>void run(valid=>openDraft(value.id,valid))}>继续这次判断 <ArrowRight size={14}/></button></article>)}</section>}
      {local.choices.length===0&&unsaved.length===0&&<div className="empty-state"><Bookmark size={30}/><h2>留住这次查找中的想法</h2><p>查找后把相关内容加入比较，再记下自己的选择。</p><Button variant="outline" onClick={()=>goView('search')}>去查找</Button></div>}
      {refreshing&&<output className="help-read-note">正在读取参考来源的当前状态…</output>}
      {[...local.choices].reverse().slice(0,savedLimit).map(choice=>{const current=choice.versions.at(-1);if(!current)return null;return <article className="help-saved-item" key={choice.id}><header><BookOpen size={21}/><div><h3>{current.localTaskRef}</h3><span>{current.selectedRefs.length} 项参考 · {new Date(current.recordedAt).toLocaleDateString('zh-CN')}</span></div></header><p>{current.visibleRationale}</p><div className="saved-source-states">{current.candidateRefs.map(ref=>{const state=local.referenceStates[refKey(ref)];return <span key={refKey(ref)}>{label(ref.type)} · {state?label(state.state):'正在读取当前状态'}</span>;})}</div><footer><button className="text-action" disabled={busy} onClick={()=>void run(valid=>editChoice(choice,valid))}>{input.drafts[choice.id]&&isUnsaved(input.drafts[choice.id])?'继续未保存的修改':'继续比较与判断'}</button><button className="text-action" disabled={busy} onClick={()=>void run(async valid=>{const value=await client!.removeChoice(choice.id);if(!valid())return;setLocal(value);const drafts={...inputRef.current.drafts};if(drafts[choice.id]&&!isUnsaved(drafts[choice.id])){delete drafts[choice.id];change({drafts});}})}>删除</button></footer></article>;})}
      {local.choices.length>savedLimit&&<Button variant="ghost" disabled={busy} onClick={()=>setSavedLimit(value=>value+8)}>更早的参考</Button>}
    </section>}
    {input.view==='sync'&&<section className="help-sync"><button className="back-link" onClick={()=>goView('saved')}><ArrowLeft size={15}/>返回我的参考</button><ChoiceSyncWorkspace runtime={runtime} subjectId={subjectId} connected={connected} localChoices={local.choices}/></section>}
    </>}
    <dialog ref={detailDialog} className="help-detail-dialog conversation-panel" aria-labelledby="help-detail-title" onClose={closeSource}><header><span>{opened?label(opened.type):''}</span><button className="icon-button" aria-label="关闭内容" onClick={closeSource}><X size={20}/></button></header>{opened&&<div className="help-detail-body"><SourceDetail key={candidateKey(opened)} item={opened} client={client} readReference={readReference} onCurrent={item=>setReferenceStates(old=>({...old,[candidateKey(item)]:{state:'current',item}}))} runtime={runtime} connected={connected} subjectId={subjectId} search={openedSearch} navigate={leave} included={candidateKeys.includes(candidateKey(opened))} onInclude={include}/></div>}</dialog>
  </section>;
}
