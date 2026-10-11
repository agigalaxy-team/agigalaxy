import React,{lazy,Suspense,useEffect,useMemo,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,ArrowUpRight,Award,BookOpen,Pencil} from 'lucide-react';
import {createProfileClient} from './profile-client.mjs';
import {createHistoryClient} from './history-client.mjs';
import {HistoryWorkspace,type HistoryForm} from './history-workspace';
import {PersonProfileEditor} from './person-profile-editor';
import {historyRoleLabel} from './history-facts';
import {MemberAvatar,memberName} from './conversation-ui';
import {profilePath,profileExperiencePath,profileReturn,profileReturnLabel} from './profile-navigation.mjs';
import {useCurrentTaskMaterialTree} from './task-material-view';
import type {AccountRuntime,PersonOverview,ProfileProject,HonorBadge,HonorDetail,HonorResponse} from './account-workspace-types';
import type {HistoryPage} from './record-workspace-types';
import './person-profile.css';

const RequesterRecords=lazy(()=>import('./contribution-workspace').then(module=>({default:module.RequesterRecords})));
type Go=(path:string)=>void;
type Props={runtime:AccountRuntime;connected:boolean;subjectId?:string;targetSubjectId:string;search:string;navigate:Go};
const withoutProfileDeclaration=(profile:PersonOverview):PersonOverview=>({...profile,displayName:null,about:null,tags:[],projects:[],profileSource:null,profileReadExpiresAt:undefined});
function historySearch(parameters:URLSearchParams):HistoryForm{return {query:(parameters.get('q')??'').slice(0,200),timeWindow:['90-days','365-days','custom'].includes(parameters.get('period')??'')?parameters.get('period')!:'all-visible',from:parameters.get('from')??'',before:parameters.get('before')??''};}
function Link({to,navigate,children,...rest}:{to:string;navigate:Go;children:React.ReactNode}&Omit<React.ComponentPropsWithoutRef<'a'>,'href'|'onClick'>){return <a href={to} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(to);}}} {...rest}>{children}</a>;}
function ProfileText({value}:{value:string}){return <div className="person-prose">{value.split(/\n\s*\n/).filter(Boolean).map((paragraph,index)=><p key={index}>{paragraph}</p>)}</div>;}
function Intro({about}:{about:string}){
 const paragraphs=about.split(/\n\s*\n/),first=paragraphs[0],boundary=first.slice(0,260).search(/[。！？.!?]\s*[^。！？.!?]*$/);
 const summary=first.length<=260?first:boundary>=50?first.slice(0,boundary+1):first.slice(0,240)+'…';
 return summary===about?<ProfileText value={about}/>:<><p className="person-prose">{summary}</p><details className="person-full-intro"><summary>完整介绍</summary><ProfileText value={about}/></details></>;
}
function Projects({items,preview=false}:{items:ProfileProject[];preview?:boolean}){
 return items.length?<div className={'person-projects'+(preview?' is-preview':'')}>{items.map(item=><article key={item.id}><h3>{item.title}</h3><p>{item.summary}</p>{(item.functions.length>0||item.technologies.length>0)&&<p className="person-project-functions">{item.functions.join(' · ')}{item.technologies.length>0&&<>{item.functions.length>0&&<br/>}{item.technologies.join(' · ')}</>}</p>}{item.sourceUrl&&<a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">查看{item.kind==='module'?'模块':'项目'}<ArrowUpRight size={15}/></a>}</article>)}</div>:<p className="person-muted">暂时没有可查看的项目介绍。</p>;
}

export function PersonProfile(props:Props){
 const binding=props.runtime.api.snapshot();
 return <PersonSession key={JSON.stringify([props.runtime.api.endpoint,props.subjectId,props.targetSubjectId,props.connected,binding?.bindingId,binding?.generation])} {...props}/>;
}
function PersonSession({runtime,connected,subjectId,targetSubjectId,search,navigate}:Props){
 const client=useMemo(()=>createProfileClient(runtime,{subjectId:subjectId??null,targetSubjectId,authenticated:connected}),[runtime,connected,subjectId,targetSubjectId]);
 const historyClient=useMemo(()=>createHistoryClient(runtime,{subjectId:subjectId??null,targetSubjectId,authenticated:connected}),[runtime,connected,subjectId,targetSubjectId]);
 const [profile,setProfile]=useState<PersonOverview|null>(null),[readRecent,setRecent]=useState<HistoryPage|null>(null),[error,setError]=useState(''),[historyError,setHistoryError]=useState('');
 const [loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0),[saved,setSaved]=useState(false),[declarationUnavailable,setDeclarationUnavailable]=useState(false),declarationRead=useRef(0);
 const recent=useCurrentTaskMaterialTree(runtime,readRecent),parameters=new URLSearchParams(search),requestedSection=parameters.get('section');
 const appliedSearch=historySearch(parameters),searchKey=JSON.stringify(appliedSearch),[searchState,setSearchState]=useState({key:searchKey,form:appliedSearch});
 const searchForm=searchState.key===searchKey?searchState.form:appliedSearch;
 if(searchState.key!==searchKey)setSearchState({key:searchKey,form:appliedSearch});
 const setSearchForm=(form:HistoryForm)=>setSearchState({key:searchKey,form});
 const section=requestedSection==='experience'||requestedSection==='projects'?requestedSection:'overview';
 const own=subjectId===targetSubjectId,base=profilePath(targetSubjectId)!,back=profileReturn(history.state);
 function sectionPath(next:string,changes:Record<string,string|null>={}){const nextParameters=new URLSearchParams(parameters);nextParameters.delete('edit');if(next==='overview')nextParameters.delete('section');else nextParameters.set('section',next);for(const [key,value] of Object.entries(changes)){if(value===null)nextParameters.delete(key);else nextParameters.set(key,value);}return base+(nextParameters.size?'?'+nextParameters:'');}
 const experience=sectionPath('experience',{view:null,record:null});
 function searchHistory(form:HistoryForm){navigate(sectionPath('experience',{q:form.query||null,period:form.timeWindow==='all-visible'?null:form.timeWindow,from:form.from||null,before:form.before||null,record:null}));}
 useEffect(()=>{let active=true;
  client.overview().then(value=>{if(active){declarationRead.current++;const unavailable=navigator.onLine===false||!!value.profileReadExpiresAt&&value.profileReadExpiresAt*1000<=Date.now();setProfile(unavailable?withoutProfileDeclaration(value):value);setDeclarationUnavailable(unavailable);setError('');}},()=>{if(active){declarationRead.current++;setProfile(null);setError('资料暂时不可读取。');}}).finally(()=>{if(active)setLoading(false);});
  historyClient.query({subjectId:targetSubjectId,query:'',timeWindow:{kind:'all-visible'},limit:3}).then(value=>{if(active){setRecent(value);setHistoryError('');}},()=>{if(active){setRecent(null);setHistoryError('经历暂时不可读取。');}});
  return()=>{active=false;};
 },[client,historyClient,targetSubjectId,refresh]);
 useEffect(()=>{const reread=()=>{if(!document.hidden&&navigator.onLine!==false)setRefresh(value=>value+1);},offline=()=>{declarationRead.current++;setProfile(value=>value?withoutProfileDeclaration(value):null);setDeclarationUnavailable(true);};const timer=window.setInterval(reread,60000);document.addEventListener('visibilitychange',reread);window.addEventListener('focus',reread);window.addEventListener('online',reread);window.addEventListener('offline',offline);return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',reread);window.removeEventListener('focus',reread);window.removeEventListener('online',reread);window.removeEventListener('offline',offline);client.close();historyClient.close();};},[client,historyClient]);
 useEffect(()=>{const expiresAt=profile?.profileReadExpiresAt;if(!profile||!expiresAt)return;const remaining=expiresAt*1000-Date.now(),sequence=declarationRead.current;
  const reread=remaining>5000?window.setTimeout(()=>setRefresh(value=>value+1),remaining-5000):null;
  const expire=window.setTimeout(()=>{if(sequence!==declarationRead.current)return;declarationRead.current++;setProfile(value=>value===profile?withoutProfileDeclaration(value):value);setDeclarationUnavailable(true);if(navigator.onLine!==false)setRefresh(value=>value+1);},Math.max(0,remaining));
  return()=>{if(reread!==null)window.clearTimeout(reread);window.clearTimeout(expire);};
 },[profile]);
 const retry=()=>{setLoading(!profile);setRefresh(value=>value+1);};
 const editorPath=sectionPath(section,{edit:'1'});
 if(own&&parameters.get('edit')==='1')return <PersonProfileEditor runtime={runtime} subjectId={targetSubjectId} connected={connected} onClose={()=>navigate(sectionPath(section))} onNeedIdentity={()=>navigate('/app/settings/identity')} onSaved={()=>{setSaved(true);setProfile(null);setRecent(null);setLoading(true);setRefresh(value=>value+1);navigate(sectionPath('overview'));}}/>;
 return <article className="person-profile" aria-busy={loading}>
  <Link to={back} navigate={navigate} className="person-return"><ArrowLeft size={16}/>{profileReturnLabel(back)}</Link>
  <header className="person-identity"><span className="person-portrait" aria-hidden="true"><MemberAvatar subjectId={targetSubjectId} own={own}/></span><div><p className="eyebrow">{own?'我的个人资料':'个人资料'}</p><h1>{profile?.displayName??memberName(targetSubjectId)}</h1></div>{own&&<div className="person-identity-actions"><Link to={editorPath} navigate={navigate} className="person-edit-link"><Pencil size={15}/>编辑资料</Link><Link to="/app/account" navigate={navigate} className="person-self-link">我的银河<ArrowUpRight size={14}/></Link></div>}</header>
  {saved&&<output className="person-updated">资料已更新。</output>}
  <nav className="person-tabs" aria-label="个人资料">{[['overview','概览'],['experience','经历与贡献'],['projects','项目']].map(([id,title])=><Link key={id} to={sectionPath(id)} navigate={navigate} aria-current={section===id?'page':undefined}>{title}</Link>)}</nav>
  {loading&&!profile&&<output>正在读取资料…</output>}{error&&<p className="person-read-error" role="alert">{error}<button type="button" onClick={retry}>重试</button></p>}
  {declarationUnavailable&&!error&&<p className="person-read-error">介绍和项目需要重新核对当前可见范围。<button type="button" onClick={retry}>重新读取</button></p>}
  {section==='overview'&&<div className="person-overview"><div className="person-main">
   <section className="person-section"><header><h2>介绍</h2>{profile?.profileSource&&<span className="person-muted">本人填写</span>}</header>{profile?.about?<Intro about={profile.about}/>:!loading&&!error&&!declarationUnavailable&&<p className="person-muted">暂时没有可查看的介绍。</p>}</section>
   <section className="person-section"><header><h2>近期经历</h2><Link to={experience} navigate={navigate}>完整经历<ArrowRight size={14}/></Link></header>
    {historyError&&<p role="alert" className="person-read-error">{historyError}<button type="button" onClick={retry}>重试</button></p>}
    {recent?.items.length?<ol className="person-experience-list">{recent.items.map(item=>{const times=item.activityTimes.map(time=>Date.parse(time)).filter(Number.isFinite),at=times.length?new Date(Math.max(...times)):null;return <li key={item.key}><Link to={profileExperiencePath(targetSubjectId,item.key)!} navigate={navigate}><h3>{item.title??'工作经历'}<ArrowRight size={15}/></h3>{item.summary&&<p>{item.summary}</p>}<div className="history-meta">{at&&<time dateTime={at.toISOString()}>{at.toLocaleDateString('zh-CN')}</time>}{item.subjectRoles.length>0&&<span>{item.subjectRoles.map(historyRoleLabel).join(' · ')}</span>}{item.synthetic&&<span>合成示例</span>}</div></Link></li>;})}</ol>:recent&&<p className="person-muted">暂时没有可查看的经历。</p>}
   </section>
   {!!profile?.projects.length&&<section className="person-section"><header><h2>项目</h2><Link to={sectionPath('projects')} navigate={navigate}>全部项目<ArrowRight size={14}/></Link></header><Projects items={profile.projects.slice(0,2)} preview/></section>}
  </div><aside className="person-side">
   {!!profile?.tags.length&&<section className="person-section"><h2>关注与参与方向</h2><ul className="person-directions">{profile.tags.map(tag=><li key={tag}>{tag}</li>)}</ul></section>}
   {profile&&<Recognitions client={client} profile={profile} refresh={refresh} experience={experience} navigate={navigate}/>}
  </aside></div>}
  {section==='experience'&&<><nav className="work-filter-links" aria-label="经历内容"><Link to={sectionPath('experience',{view:null})} navigate={navigate} aria-current={parameters.get('view')!=='requests'?'page':undefined}>工作经历</Link><Link to={sectionPath('experience',{view:'requests'})} navigate={navigate} aria-current={parameters.get('view')==='requests'?'page':undefined}>发起的工作</Link></nav>{parameters.get('view')==='requests'?<Suspense fallback={<output>正在读取发起的工作…</output>}><RequesterRecords runtime={runtime} connected={connected} subjectId={targetSubjectId} viewerId={subjectId}/></Suspense>:<HistoryWorkspace key={searchKey} runtime={runtime} connected={connected} subjectId={subjectId} targetSubjectId={targetSubjectId} navigate={navigate} recordKey={parameters.get('record')??undefined} onRecordChange={key=>navigate(sectionPath('experience',{record:key}))} searchForm={searchForm} onSearchFormChange={setSearchForm} appliedSearch={appliedSearch} onSearch={searchHistory}/>}</>}
  {section==='projects'&&<section className="person-section"><header><h2>项目介绍</h2>{profile?.projects.length?<span className="person-muted">本人填写</span>:null}</header>{profile&&!declarationUnavailable&&<Projects items={profile.projects}/>}</section>}
 </article>;
}

function Recognitions({client,profile,refresh,experience,navigate}:{client:ReturnType<typeof createProfileClient>;profile:PersonOverview;refresh:number;experience:string;navigate:Go}){
 const [selectedId,setSelected]=useState<string|null>(null),selected=profile.honors.find(item=>item.id===selectedId);
 return <section className="person-section"><header><h2>贡献认可</h2></header>{profile.honors.length?<div className="person-recognition-list">{profile.honors.map(item=><button key={item.id} type="button" aria-expanded={selected?.id===item.id} onClick={()=>setSelected(old=>old===item.id?null:item.id)}><Award size={24}/><span>{item.title}</span></button>)}</div>:<p className="person-muted">{profile.honorsError?'认可资料暂时不可读取。':'暂无可查看的认可。'}</p>}
  {selected&&<RecognitionDetail key={selected.id} client={client} profile={profile} refresh={refresh} item={selected} experience={experience} navigate={navigate}/>}
 </section>;
}

type HonorRead={profile:PersonOverview;refresh:number;retry:number;detail:HonorDetail|null;error:string};
function currentHonorDetail(value:HonorResponse):HonorDetail{
 if(value.card.status!=='active')throw Error('honor_changed');
 return {...value,items:value.items??value.contributions??[],nextAfter:value.nextAfter??value.pagination?.contributions?.nextAfter??null,sourceFingerprint:value.sourceFingerprint??value.card.sourceFingerprint};
}
const honorError=(error:unknown)=>error instanceof Error&&error.message==='honor_changed'?'这项认可的当前依据已变化。':'当前依据暂时不可读取。';
function RecognitionDetail({client,profile,refresh,item,experience,navigate}:{client:ReturnType<typeof createProfileClient>;profile:PersonOverview;refresh:number;item:HonorBadge;experience:string;navigate:Go}){
 const [result,setResult]=useState<HonorRead|null>(null),[retry,setRetry]=useState(0),[moreFor,setMoreFor]=useState<HonorRead|null>(null),control=useRef({sequence:0});
 const current=result?.profile===profile&&result.refresh===refresh&&result.retry===retry?result:null;
 const detail=current?.detail,error=current?.error,busy=!current||moreFor===current;
 useEffect(()=>{const state=control.current,token=++state.sequence;
  client.honor(item,{}).then(value=>{const detail=currentHonorDetail(value);if(state.sequence===token)setResult({profile,refresh,retry,detail,error:''});}).catch(error=>{if(state.sequence===token)setResult({profile,refresh,retry,detail:null,error:honorError(error)});});
  return()=>{state.sequence++;};
 },[client,profile,refresh,item,retry]);
 async function readMore(){
  if(!current||!detail?.nextAfter||busy)return;
  const state=control.current,token=state.sequence;setMoreFor(current);
  try{const value=await client.honor(item,{after:detail.nextAfter,expectedFingerprint:detail.sourceFingerprint}),next=currentHonorDetail(value);
   if(state.sequence===token)setResult({...current,detail:{...next,items:[...detail.items,...next.items]},error:''});
  }catch(error){if(state.sequence===token)setResult({...current,detail:null,error:honorError(error)});}
 }
 return <div className="person-recognition-detail" aria-busy={busy}><h3>{item.title}</h3><p>依据当前可读的参与事实，按“{item.title}”规则形成。</p>{busy&&!detail&&<output>正在读取依据…</output>}{error&&<p role="alert" className="person-read-error">{error}<button type="button" onClick={()=>setRetry(value=>value+1)}>重试</button></p>}{detail&&<><ul>{detail.items.map((evidence,index)=><li key={evidence.id??evidence.assistanceId??index}><strong>{evidence.title??evidence.case?.title??(evidence.accepted?'已被接受的参与':'相关参与记录')}</strong>{evidence.summary&&<p>{evidence.summary}</p>}{evidence.participatedAt&&<time>{new Date(evidence.participatedAt*1000).toLocaleDateString('zh-CN')}</time>}{evidence.projections?.map((projection,i)=><p key={i}>{projection.projection?.title??projection.projection?.summary??'当前允许查看的参与事实'}</p>)}</li>)}</ul>{detail.nextAfter&&<button type="button" className="text-link" disabled={busy} onClick={()=>void readMore()}>更多依据</button>}<details><summary>规则与颁发方</summary><p>{detail.card.rule.title} · {detail.card.rule.version}</p><p>{detail.card.issuer}</p></details></>}<Link to={experience} navigate={navigate}><BookOpen size={15}/>查看完整经历</Link></div>;
}
