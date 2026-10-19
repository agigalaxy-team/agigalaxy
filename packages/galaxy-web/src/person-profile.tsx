import { ReadingDetails, ReadingSummary } from './reading-details';
import React,{lazy,Suspense,useEffect,useMemo,useRef,useState} from 'react';
import {Pencil} from 'lucide-react';
import {createProfileClient} from './profile-client.mjs';
import {createHistoryClient} from './history-client.mjs';
import {HistoryWorkspace,type HistoryForm} from './history-workspace';
import {PersonProfileEditor} from './person-profile-editor';
import {PersonRecognitions,RecognitionOverview} from './person-recognitions';
import {PersonProjects} from './person-projects';
import {AgentWorkContinuation} from './agent-work-continuation';
import {SaveForLaterButton} from './reading-bookmarks-workspace';
import {PublicIdentityAccounts} from './public-account-relations';
import {historyRoleLabel} from './history-facts';
import {MemberAvatar,memberName} from './conversation-ui';
import {profilePath,profileExperiencePath,profileReturn,profileReturnLabel} from './profile-navigation.mjs';
import {useCurrentTaskMaterialTree} from './task-material-view';
import type {AccountRuntime,PersonOverview} from './account-workspace-types';
import type {HistoryPage} from './record-workspace-types';
import './person-profile.css';

const RequesterRecords=lazy(()=>import('./contribution-workspace').then(module=>({default:module.RequesterRecords})));
type Go=(path:string)=>void;
type Props={runtime:AccountRuntime;connected:boolean;subjectId?:string;targetSubjectId:string;search:string;navigate:Go;onReturn?:Go};
const withoutProfileDeclaration=(profile:PersonOverview):PersonOverview=>({...profile,displayName:null,about:null,tags:[],projects:[],profileSource:null,profileReadExpiresAt:undefined});
function historySearch(parameters:URLSearchParams):HistoryForm{return {query:(parameters.get('q')??'').slice(0,200),timeWindow:['90-days','365-days','custom'].includes(parameters.get('period')??'')?parameters.get('period')!:'all-visible',from:parameters.get('from')??'',before:parameters.get('before')??''};}
function Link({to,navigate,children,...rest}:{to:string;navigate:Go;children:React.ReactNode}&Omit<React.ComponentPropsWithoutRef<'a'>,'href'|'onClick'>){return <a href={to} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(to);}}} {...rest}>{children}</a>;}
function ProfileText({value}:{value:string}){return <div className="person-prose">{value.split(/\n\s*\n/).filter(Boolean).map((paragraph,index)=><p key={index}>{paragraph}</p>)}</div>;}
function Intro({about}:{about:string}){
 const paragraphs=about.split(/\n\s*\n/),first=paragraphs[0],boundary=first.slice(0,260).search(/[。！？.!?]\s*[^。！？.!?]*$/);
 const summary=first.length<=260?first:boundary>=50?first.slice(0,boundary+1):first.slice(0,240)+'…';
 return summary===about?<ProfileText value={about}/>:<><p className="person-prose">{summary}</p><ReadingDetails className="person-full-intro"><ReadingSummary>完整介绍</ReadingSummary><ProfileText value={about}/></ReadingDetails></>;
}

export function PersonProfile(props:Props){
 const binding=props.runtime.api.snapshot();
 return <PersonSession key={JSON.stringify([props.runtime.api.endpoint,props.subjectId,props.targetSubjectId,props.connected,binding?.bindingId,binding?.generation])} {...props}/>;
}
function PersonSession({runtime,connected,subjectId,targetSubjectId,search,navigate,onReturn}:Props){
 const client=useMemo(()=>createProfileClient(runtime,{subjectId:subjectId??null,targetSubjectId,authenticated:connected}),[runtime,connected,subjectId,targetSubjectId]);
 const historyClient=useMemo(()=>createHistoryClient(runtime,{subjectId:subjectId??null,targetSubjectId,authenticated:connected}),[runtime,connected,subjectId,targetSubjectId]);
 const [profile,setProfile]=useState<PersonOverview|null>(null),[readRecent,setRecent]=useState<HistoryPage|null>(null),[error,setError]=useState(''),[historyError,setHistoryError]=useState('');
 const [loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0),[saved,setSaved]=useState(false),[declarationUnavailable,setDeclarationUnavailable]=useState(false),declarationRead=useRef(0);
 const recent=useCurrentTaskMaterialTree(runtime,readRecent),parameters=new URLSearchParams(search),requestedSection=parameters.get('section');
 const appliedSearch=historySearch(parameters),searchKey=JSON.stringify(appliedSearch),[searchState,setSearchState]=useState({key:searchKey,form:appliedSearch});
 const searchForm=searchState.key===searchKey?searchState.form:appliedSearch;
 if(searchState.key!==searchKey)setSearchState({key:searchKey,form:appliedSearch});
 const setSearchForm=(form:HistoryForm)=>setSearchState({key:searchKey,form});
 const section=requestedSection==='experience'||requestedSection==='projects'||requestedSection==='recognition'?requestedSection:'overview';
 const own=subjectId===targetSubjectId,base=profilePath(targetSubjectId)!,back=profileReturn(history.state);
 function sectionPath(next:string,changes:Record<string,string|null>={}){const nextParameters=new URLSearchParams(parameters);nextParameters.delete('edit');if(next==='overview')nextParameters.delete('section');else nextParameters.set('section',next);for(const [key,value] of Object.entries(changes)){if(value===null)nextParameters.delete(key);else nextParameters.set(key,value);}return base+(nextParameters.size?'?'+nextParameters:'');}
 const experience=sectionPath('experience',{view:null,record:null});
 const recognitionPath=(id?:string)=>sectionPath('recognition',{honor:id??null});
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
  <Link to={back} navigate={onReturn??navigate} className="person-return">{profileReturnLabel(back)}</Link>
  <header className="person-identity"><span className="person-portrait" aria-hidden="true"><MemberAvatar subjectId={targetSubjectId} own={own}/></span><div><p className="eyebrow">{own?'我的个人资料':'个人资料'}</p><h1>{profile?.displayName??memberName(targetSubjectId)}</h1></div>{own&&<div className="person-identity-actions"><Link to={editorPath} navigate={navigate} className="person-edit-link"><Pencil size={15}/>编辑资料</Link><Link to="/app/account" navigate={navigate} className="person-self-link">我的银河</Link></div>}</header>
  {!own&&profile?.profileSource&&!declarationUnavailable&&<SaveForLaterButton runtime={runtime} connected={connected} subjectId={subjectId} reference={{kind:"person",subjectId:targetSubjectId}} onNeedIdentity={()=>navigate("/app/settings/identity")}/>}
  {profile?.profileSource&&!declarationUnavailable&&<AgentWorkContinuation runtime={runtime} subjectId={subjectId} object={{kind:'person',id:targetSubjectId}} title={profile.displayName??memberName(targetSubjectId)} purpose="根据当前允许阅读的介绍和具体经历，理解此人与原来事情相关的经验" returnTo={location.pathname+location.search+location.hash} onNeedIdentity={()=>navigate('/app/settings/identity')}/>}
  {saved&&<output className="person-updated">资料已更新。</output>}
  <nav className="person-tabs" aria-label="个人资料">{[['overview','概览'],['experience','经历与贡献'],['projects','作品与项目'],['recognition','认可']].map(([id,title])=><Link key={id} to={sectionPath(id)} navigate={navigate} aria-current={section===id?'page':undefined}>{title}</Link>)}</nav>
  {loading&&!profile&&<output>正在读取资料…</output>}{error&&<p className="person-read-error" role="alert">{error}<button type="button" onClick={retry}>重试</button></p>}
  {declarationUnavailable&&!error&&<p className="person-read-error">介绍和项目需要重新核对当前可见范围。<button type="button" onClick={retry}>重新读取</button></p>}
  {section==='overview'&&<div className="person-overview"><div className="person-main">
   <section className="person-section"><header><h2>介绍</h2>{profile?.profileSource&&<span className="person-muted">本人填写</span>}</header>{profile?.about?<Intro about={profile.about}/>:!loading&&!error&&!declarationUnavailable&&<p className="person-muted">暂时没有可查看的介绍。</p>}</section>
   <section className="person-section"><header><h2>近期经历</h2><Link to={experience} navigate={navigate}>完整经历</Link></header>
    {historyError&&<p role="alert" className="person-read-error">{historyError}<button type="button" onClick={retry}>重试</button></p>}
    {recent?.items.length?<ol className="person-experience-list">{recent.items.map(item=>{const times=item.activityTimes.map(time=>Date.parse(time)).filter(Number.isFinite),at=times.length?new Date(Math.max(...times)):null;return <li key={item.key}><Link to={profileExperiencePath(targetSubjectId,item.key)!} navigate={navigate}><h3>{item.title??'工作经历'}</h3>{item.summary&&<p>{item.summary}</p>}<div className="history-meta">{at&&<time dateTime={at.toISOString()}>{at.toLocaleDateString('zh-CN')}</time>}{item.subjectRoles.length>0&&<span>{item.subjectRoles.map(historyRoleLabel).join(' · ')}</span>}{item.synthetic&&<span>合成示例</span>}</div></Link></li>;})}</ol>:recent&&<p className="person-muted">暂时没有可查看的经历。</p>}
   </section>
   <PersonProjects runtime={runtime} connected={connected} ownerId={targetSubjectId} legacy={declarationUnavailable?[]:profile?.projects??[]} refresh={refresh} check={client.check} navigate={navigate} allPath={sectionPath('projects')} preview/>
  </div><aside className="person-side">
   <PublicIdentityAccounts key={targetSubjectId} subjectId={targetSubjectId} endpoint={runtime.api.endpoint} navigate={navigate}/>
   {!!profile?.tags.length&&<section className="person-section"><h2>关注与参与方向</h2><ul className="person-directions">{profile.tags.map(tag=><li key={tag}>{tag}</li>)}</ul></section>}
   {profile&&<RecognitionOverview {...{profile,recognitionPath,navigate}}/>}
  </aside></div>}
  {section==='experience'&&<><nav className="work-filter-links" aria-label="经历内容"><Link to={sectionPath('experience',{view:null})} navigate={navigate} aria-current={parameters.get('view')!=='requests'?'page':undefined}>工作经历</Link><Link to={sectionPath('experience',{view:'requests'})} navigate={navigate} aria-current={parameters.get('view')==='requests'?'page':undefined}>发起的工作</Link></nav>{parameters.get('view')==='requests'?<Suspense fallback={<output>正在读取发起的工作…</output>}><RequesterRecords runtime={runtime} connected={connected} subjectId={targetSubjectId} viewerId={subjectId}/></Suspense>:<HistoryWorkspace key={searchKey} runtime={runtime} connected={connected} subjectId={subjectId} targetSubjectId={targetSubjectId} navigate={navigate} recordKey={parameters.get('record')??undefined} onRecordChange={key=>navigate(sectionPath('experience',{record:key}))} searchForm={searchForm} onSearchFormChange={setSearchForm} appliedSearch={appliedSearch} onSearch={searchHistory}/>}</>}
  {section==='projects'&&<PersonProjects runtime={runtime} connected={connected} ownerId={targetSubjectId} legacy={declarationUnavailable?[]:profile?.projects??[]} refresh={refresh} check={client.check} navigate={navigate} allPath={sectionPath('projects')}/>}
  {section==='recognition'&&profile&&<PersonRecognitions {...{client,profile,refresh,recognitionPath,experience,navigate}} selectedId={parameters.get('honor')}/>}
 </article>;
}
