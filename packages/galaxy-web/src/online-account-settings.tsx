import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {OfficialAccountStatus,useOfficialAccountSession,type OfficialSession} from './official-account-panel';
import {conversationArchiveParts,exportConversationArchive,readConversationArchiveFile,conversationArchiveReading} from './account-archive-file.mjs';
import {AccountExternalCredentials} from './account-external-credentials';
import {AccountWorkHistory} from './account-work-history';
import {ReadingDetails,ReadingSummary,ReadingSurface} from './reading-details';
import {LocalGalaxyPanelEntry} from './local-galaxy-entry';
import './online-account-settings.css';
import './account-reading.css';

type Settings={accountId:string;subjectType:'person'|'organization'|'agent'|null;displayName:string|null;revision:number;publicQuery:{enabled:boolean;scope:'profile'|'profile-and-public-posts';showLinkedIds:boolean;showExternalCredentials:boolean};archiveRetentionDays:number|null;typeHistory:{previousType:string|null;nextType:string;revision:number;reason:string;basis:string;createdAt:string}[]};
type Archive={id:string;title:string;state?:string;status?:string;createdAt?:string;chunkCount?:number};
type ArchivePage={archives:Archive[];nextAfter:string|null};
type ArchiveStatus={id:string;state:string;archive?:Archive};
type ArchiveSelection={id:string;title:string;complete:boolean;sessions:ArchiveReadingSession[]};
type ImportSession={sessionId:string;title:string;content:unknown;format:'galaxy-private-conversation-v1'|'selected-session';coverage:unknown;completeConversation:boolean|null;messageCount:number|null;excludedItems:number;hasMore:boolean;hasEarlier:boolean};
type ImportFile={workspaceId:string|null;sessions:ImportSession[]};
type ArchiveReadingEntry={id:string;role:string;text:string;at:unknown;excludedItems:number};
type ArchiveReadingSession=Pick<ImportSession,'sessionId'|'title'|'coverage'|'completeConversation'|'excludedItems'|'hasMore'|'hasEarlier'>&{entries:ArchiveReadingEntry[]};
const archiveComplete=(value:Archive)=>['complete','completed','ready'].includes(value.state??value.status??'');
const typeName=(value:string|null)=>(({person:'个人',organization:'组织',agent:'Agent'} as Record<string,string>)[value??'']??'尚未记录');
const message=(reason:unknown)=>{const code=reason&&typeof reason==='object'&&'code'in reason?String(reason.code):'';return ({official_account_changed:'登录账户已经变化，原操作没有改为其他账户执行。',official_account_session_expired:'账户登录已到期，请重新登录后继续。',official_account_unavailable:'账户暂时无法连接，未提交的内容保留。',account_settings_changed:'账户资料已在别处更新，你的修改保留。'} as Record<string,string>)[code]??(reason instanceof Error&&/[\u3400-\u9fff]/.test(reason.message)?reason.message:'这次操作暂未完成，已有资料保留。');};

export function OnlineAccountSettings({endpoint,navigate,view='profile'}:{endpoint?:string;navigate:(path:string)=>void;view?:string}){
 const official=useOfficialAccountSession(endpoint),authority=useRef(official);authority.current=official;
 const local=useRef<{endpoint:string|undefined;session:OfficialSession|null}>({endpoint,session:null});
 if(local.current.endpoint!==endpoint||official.phase==='signed-out'||official.phase==='loading')local.current={endpoint,session:null};
 if(official.phase==='signed-in')local.current={endpoint,session:official.session};
 const session=official.session??(['offline','unavailable'].includes(official.phase)?local.current.session:null),ownerId=session?.account.id,csrf=session?.csrfToken;
 const client=useMemo(()=>{
  const source=official.client;if(!source)return null;
  return {...source,async call(...args:Parameters<typeof source.call>){
   const current=authority.current;
   const code=['offline','unavailable'].includes(current.phase)?'official_account_unavailable':current.phase!=='signed-in'||!current.session||!ownerId||current.session.account.id!==ownerId||current.session.csrfToken!==csrf?'official_account_changed':null;
   if(code)throw Object.assign(Error(code),{code});
   return source.call(...args);
  }};
 },[official.client,ownerId,csrf,endpoint]);
 const available=official.phase==='signed-in';
 return <section className={'online-account-settings'+(['work','archives'].includes(view)?' online-account-reading':'')}><header className="account-page-heading"><h1>{view==='type'?'更正账户主体类型':view==='archives'?'我的私有会话':view==='credentials'?'外部凭据':view==='work'?'工作资料':'账户资料'}</h1></header><OfficialAccountStatus model={official} navigate={navigate} returnTo={'/app/account?section=settings'+(view!=='profile'?'&view='+view:'')} showIds={false} compact/>{session?.account.id&&client&&<OnlineAccountSession key={endpoint+':'+session.account.id+':'+session.csrfToken} session={session} client={client} navigate={navigate} view={view} available={available}/>}</section>;
}

function OnlineAccountSession({session,client,navigate,view,available}:{session:OfficialSession;client:NonNullable<ReturnType<typeof useOfficialAccountSession>['client']>;navigate:(path:string)=>void;view:string;available:boolean}){
 const [settings,setSettings]=useState<Settings|null>(null),[archives,setArchives]=useState<Archive[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[read,setRead]=useState(0),[settingsChanged,setSettingsChanged]=useState(false);
 const dirty=useRef({displayName:false,publicQuery:false,retention:false});
  const [archiveNext,setArchiveNext]=useState<string|null>(null),loaded=useRef({settings:-1,archives:-1});
 const [displayName,setDisplayName]=useState(''),[queryEnabled,setQueryEnabled]=useState(false),[queryScope,setQueryScope]=useState<Settings['publicQuery']['scope']>('profile'),[showLinkedIds,setShowLinkedIds]=useState(false),[showExternalCredentials,setShowExternalCredentials]=useState(false),[retention,setRetention]=useState('');
 const [nextType,setNextType]=useState<Settings['subjectType']>(null),[reason,setReason]=useState(''),[basis,setBasis]=useState('');
 const [file,setFile]=useState<ImportFile|null>(null),[selection,setSelection]=useState<string[]>([]),[title,setTitle]=useState(''),[deleteId,setDeleteId]=useState<string|null>(null);
 const [archiveAction,setArchiveAction]=useState<'sync'|'import'|'cleanup'|null>(null),[readingArchive,setReadingArchive]=useState<ArchiveSelection|null>(null);
 const archiveAutoOpened=useRef(false);
 const archiveMore=useRef<HTMLDivElement>(null),archivePages=useRef(1),archiveSelection=useRef(0),archiveListEpoch=useRef(0),archiveLoader=useRef<((after?:string)=>Promise<void>)|null>(null),archiveValue=useRef<ArchiveSelection|null>(null),archiveTarget=useRef<Archive|null>(null),failedAction=useRef<(()=>Promise<void>)|null>(null);
 const [archivesLoaded,setArchivesLoaded]=useState(false);
 archiveValue.current=readingArchive;
 const loginSession=useRef(session);loginSession.current=session;
  const active=useRef(true),working=useRef(false),upload=useRef<{id:string;title:string;workspaceId:string|null;sessionIds:string[];parts:string[];next:number;created:boolean}|null>(null);
 const call=(path:string,input:unknown=null,method='POST')=>client.call(path,input,{method,session});
 async function archiveCall(path:string,input:unknown,operation:NonNullable<typeof upload.current>){for(let attempt=0;;attempt++){if(!active.current||upload.current!==operation)throw new DOMException('Upload stopped','AbortError');try{return await call(path,input);}catch(reason){const network=reason instanceof TypeError||reason instanceof DOMException&&['AbortError','TimeoutError'].includes(reason.name);if(!network||attempt>=2||navigator.onLine===false)throw reason;await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));}}}
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 useEffect(()=>{
  if(!available||!['profile','type','archives'].includes(view)||loaded.current.settings===read)return;
  let current=true;const original=loginSession.current;
  void client.call('/v1/account/settings',null,{method:'GET',session:original}).then(result=>{
   if(!current)return;const value=result as Settings;
   if(value.accountId!==original.account.id){setError('账户资料与当前登录不一致。');return;}
   loaded.current.settings=read;setSettings(value);applySettings(value);setError('');
  }).catch(reason=>{if(current)setError(message(reason));});
  return()=>{current=false;};
 },[client,session.account.id,session.csrfToken,read,view,available]);
 useEffect(()=>{
  if(view!=='archives')return;
  if(!available){archiveListEpoch.current++;archiveSelection.current++;setArchives([]);setArchiveNext(null);setReadingArchive(null);setArchivesLoaded(false);return;}
  let current=true,inFlight=false;
  const valid=(ticket:number)=>current&&active.current&&ticket===archiveListEpoch.current&&navigator.onLine!==false;
  const load=async(after?:string)=>{
   if(inFlight)return;inFlight=true;const ticket=++archiveListEpoch.current,selected=archiveValue.current?.id===archiveTarget.current?.id?archiveValue.current:archiveTarget.current?{id:archiveTarget.current.id,title:archiveTarget.current.title,complete:false}:null,selectedAt=archiveSelection.current;
   try{
    const rows:Archive[]=[];let cursor=after,last:ArchivePage|null=null;const seen=new Set<string>();
    for(let index=0;index<(after?1:archivePages.current);index++){
     const result=await client.call('/v1/account/archives'+(cursor?'?'+new URLSearchParams({after:cursor,limit:'50'}):''),null,{method:'GET',session:loginSession.current}) as ArchivePage;
     if(!valid(ticket))return;
     if(!Array.isArray(result.archives))throw Error('会话列表暂时无法读取。');
     rows.push(...result.archives);last=result;if(!result.nextAfter)break;
     if(seen.has(result.nextAfter))throw Error('后续会话暂时无法读取。');seen.add(result.nextAfter);cursor=result.nextAfter;
    }
    if(!last||!valid(ticket))return;
    if(after)archivePages.current++;
    setArchives(old=>after?[...new Map([...old,...rows].map(item=>[item.id,item])).values()]:rows);
    setArchiveNext(last.nextAfter??null);setArchivesLoaded(true);loaded.current.archives=read;
    if(!failedAction.current)setError('');
    if(!after&&selected&&selectedAt===archiveSelection.current){
     let latest=rows.find(item=>item.id===selected.id);
     if(!latest){
      const status=await client.call('/v1/account/archives/status',{id:selected.id},{session:loginSession.current}) as ArchiveStatus;
      if(!valid(ticket)||selectedAt!==archiveSelection.current)return;
      if(status.id!==selected.id)throw Error('会话资料与当前选择不一致。');
      latest=status.archive;
      if(!latest){archiveSelection.current++;archiveTarget.current=null;setReadingArchive(null);setDeleteId(null);setNotice(status.state==='expired'?'这份会话已按清理设置移除。':'这份会话已不在此账户中。');return;}
     }
     if(!selected.complete&&archiveComplete(latest))await openArchive(latest);
    }
   }finally{inFlight=false;}
  };
  archiveLoader.current=load;
  const refresh=()=>{if(document.hidden||working.current||navigator.onLine===false)return;void load().catch(reason=>{if(current&&active.current){archiveSelection.current++;setArchives([]);setArchiveNext(null);setReadingArchive(null);setArchivesLoaded(false);failedAction.current=null;setError(message(reason));}});};
  const offline=()=>{archiveListEpoch.current++;archiveSelection.current++;setArchives([]);setArchiveNext(null);setReadingArchive(null);setArchivesLoaded(false);setError('暂时离线，联网后自动恢复会话列表。');};
  if(navigator.onLine===false)offline();else refresh();
  const timer=window.setInterval(refresh,30000);window.addEventListener('focus',refresh);window.addEventListener('online',refresh);window.addEventListener('offline',offline);document.addEventListener('visibilitychange',refresh);
  return()=>{current=false;archiveListEpoch.current++;archiveSelection.current++;archiveLoader.current=null;window.clearInterval(timer);window.removeEventListener('focus',refresh);window.removeEventListener('online',refresh);window.removeEventListener('offline',offline);document.removeEventListener('visibilitychange',refresh);};
 },[client,session.account.id,session.csrfToken,read,view,available]);
 async function run(action:()=>Promise<void>){if(working.current)return;working.current=true;failedAction.current=null;setBusy(true);setError('');setNotice('');try{await action();}catch(e){if(active.current){failedAction.current=action;setError(message(e));}}finally{working.current=false;if(active.current)setBusy(false);}}
 function applySettings(value:Settings){if(!dirty.current.displayName)setDisplayName(value.displayName??'');if(!dirty.current.publicQuery){setQueryEnabled(value.publicQuery.enabled);setQueryScope(value.publicQuery.scope);setShowLinkedIds(value.publicQuery.showLinkedIds===true);setShowExternalCredentials(value.publicQuery.showExternalCredentials===true);}if(!dirty.current.retention)setRetention(value.archiveRetentionDays===null?'':String(value.archiveRetentionDays));}
 async function save(section:'profile'|'retention'='profile'){
  if(!settings)return;let base=settings;const days=section==='retention'?(retention.trim()===''?null:Number(retention)):settings.archiveRetentionDays;
  if(days!==null&&(!Number.isInteger(days)||days<1||days>36500))throw Error('请输入 1 至 36500 天，或留空长期保存。');
  const equal=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right),changes:Partial<Pick<Settings,'displayName'|'publicQuery'|'archiveRetentionDays'>>={};
  if(section==='profile'){if(dirty.current.displayName&&!equal(displayName.trim()||null,settings.displayName))changes.displayName=displayName.trim()||null;const query={enabled:queryEnabled,scope:queryScope,showLinkedIds,showExternalCredentials};if(dirty.current.publicQuery&&!equal(query,settings.publicQuery))changes.publicQuery=query;}else if(dirty.current.retention&&!equal(days,settings.archiveRetentionDays))changes.archiveRetentionDays=days;
  const keys=Object.keys(changes) as (keyof typeof changes)[];if(!keys.length){setNotice('已保存。');return;}
  for(let attempt=0;attempt<2;attempt++){
   try{const fields={displayName:base.displayName,publicQuery:base.publicQuery,archiveRetentionDays:base.archiveRetentionDays,...changes},saved=await call('/v1/account/settings',{expectedRevision:base.revision,...fields}) as {accountId:string;revision:number};if(saved.accountId!==session.account.id||!Number.isInteger(saved.revision))throw Error('official_account_changed');if(active.current){const value={...base,...fields,revision:saved.revision};setSettings(value);if(section==='profile'){dirty.current.displayName=false;dirty.current.publicQuery=false;}else dirty.current.retention=false;applySettings(value);setSettingsChanged(false);setNotice('已保存。');}return;}
   catch(reason){const code=reason&&typeof reason==='object'&&'code'in reason?String(reason.code):'';if(code!=='account_settings_changed'||attempt>0)throw reason;const fresh=await call('/v1/account/settings',null,'GET') as Settings;if(fresh.accountId!==session.account.id)throw Error('official_account_changed');const conflict=keys.some(key=>!equal(fresh[key],base[key])&&!equal(fresh[key],changes[key]));setSettings(fresh);applySettings(fresh);base=fresh;if(conflict){setSettingsChanged(true);throw Error(section==='retention'?'清理设置已在别处改为'+(fresh.archiveRetentionDays===null?'长期保存':fresh.archiveRetentionDays+'天')+'。你的选择保留，确认后可再保存。':'账户资料已在别处更新：名称'+(fresh.displayName?'“'+fresh.displayName+'”':'未设置')+'，公开查询'+(fresh.publicQuery.enabled?'已开启':'已关闭')+'。你的修改保留，确认后可再保存。');}}
  }
 }

 async function changeType(){if(!settings||!nextType)return;await call('/v1/account/type-change',{expectedRevision:settings.revision,subjectType:nextType,reason:reason.trim(),basis:basis.trim(),preserveHistory:true});if(active.current){setReason('');setBasis('');setNextType(null);setNotice('账户类型已更正，变更记录已保留。');setRead(value=>value+1);}}
 async function chooseFile(selected:File){if(selected.size>67108864)throw Error('会话文件超过 64 MiB，请选择较小范围或分段导出。');const value=readConversationArchiveFile(await selected.text());if(active.current){setFile(value);setSelection([]);setTitle(selected.name.replace(/\.json$/i,''));upload.current=null;}}
 async function archive(){
  if(!upload.current){if(!file||!selection.length)throw Error('请选择需要保存的会话。');upload.current={id:crypto.randomUUID(),title:title.trim()||'所选会话',workspaceId:file.workspaceId,sessionIds:[...selection],parts:conversationArchiveParts(file,selection),next:0,created:false};}
  const value=upload.current;
  if(!value.created){await archiveCall('/v1/account/archives/create',{id:value.id,title:value.title,selection:{workspaceId:value.workspaceId,sessionIds:value.sessionIds},uploadLevel:'conversation-archive',includeFullConversation:true},value);value.created=true;}
  while(value.next<value.parts.length){await archiveCall('/v1/account/archives/chunk',{id:value.id,sequence:value.next,content:value.parts[value.next]},value);value.next++;}
  await archiveCall('/v1/account/archives/complete',{id:value.id,chunkCount:value.parts.length},value);
  if(active.current&&upload.current===value){upload.current=null;setFile(null);setSelection([]);setNotice('会话已保存。');setArchiveAction(null);setRead(value=>value+1);}
 }
 useEffect(()=>{const resume=()=>{if(available&&upload.current&&!working.current)void run(archive);};if(available)resume();window.addEventListener('online',resume);return()=>window.removeEventListener('online',resume);},[client,session.account.id,session.csrfToken,available]);
 async function download(value:Archive){const result=await exportConversationArchive((path:string,input:unknown)=>call(path,input),value.id);if(!active.current)return;const url=URL.createObjectURL(new Blob([result.content],{type:'application/json;charset=utf-8'})),anchor=document.createElement('a');anchor.href=url;anchor.download=(value.title||'银河私有会话').replace(/[\\/:*?"<>|]/g,'_')+'.json';anchor.click();URL.revokeObjectURL(url);setNotice('下载已开始。');}
 async function loadArchivePage(){if(archiveNext)await archiveLoader.current?.(archiveNext);}
 useEffect(()=>{const element=archiveMore.current;if(!element||!archiveNext||view!=='archives')return;const observer=new IntersectionObserver(entries=>{if(entries.some(value=>value.isIntersecting)&&!working.current)void run(loadArchivePage);},{rootMargin:'300px'});observer.observe(element);return()=>observer.disconnect();},[archiveNext,view,busy]);
 async function openArchive(value:Archive){archiveTarget.current=value;const ticket=++archiveSelection.current;if(!archiveComplete(value)){setReadingArchive({id:value.id,title:value.title,complete:false,sessions:[]});return;}try{const result=await exportConversationArchive((path:string,input:unknown)=>call(path,input),value.id),sessions:ArchiveReadingSession[]=conversationArchiveReading(result.content);if(active.current&&ticket===archiveSelection.current)setReadingArchive({id:value.id,title:value.title,complete:true,sessions});}catch(reason){if(active.current&&ticket===archiveSelection.current)setReadingArchive(null);throw reason;}}
 useEffect(()=>{const first=archives.find(archiveComplete);if(view==='archives'&&!archiveAutoOpened.current&&first&&!working.current&&window.matchMedia('(min-width:761px)').matches){archiveAutoOpened.current=true;void run(()=>openArchive(first));}},[archives,view]);
 return <><nav className="online-account-tabs" aria-label="账户资料栏目">{[['profile','个人资料'],['credentials','外部凭据'],['work','工作资料'],['archives','私有会话']].map(([key,label])=><button key={key} type="button" aria-current={view===key?'page':undefined} onClick={()=>navigate('/app/account?section=settings'+(key==='profile'?'':'&view='+key))}>{label}</button>)}</nav>
  {error&&<p className="message error" role="alert">{error}{!settingsChanged&&available&&<Button variant="ghost" disabled={busy} onClick={()=>{const action=failedAction.current;if(action)void run(action);else setRead(value=>value+1);}}>重试</Button>}</p>}{notice&&<output className="message">{notice}</output>}
 {view==='credentials'&&<AccountExternalCredentials call={call} available={available}/>}{view==='work'&&session.account.id&&<AccountWorkHistory accountId={session.account.id} call={call} available={available}/>}
 {settings&&view==='profile'&&<form className="workspace-form online-account-form" onSubmit={event=>{event.preventDefault();void run(save);}}><label>显示名称<input value={displayName} maxLength={120} onChange={event=>{dirty.current.displayName=true;setDisplayName(event.target.value);}}/></label><div className="online-account-type-line"><span>{typeName(settings.subjectType)}</span><button type="button" className="text-link" onClick={()=>navigate('/app/account?section=settings&view=type')}>更正账户类型</button></div><fieldset><legend>公开资料</legend><label><input type="checkbox" checked={queryEnabled} onChange={event=>{dirty.current.publicQuery=true;setQueryEnabled(event.target.checked);}}/>允许别人查询此账户</label>{queryEnabled&&<><label><input type="radio" name="online-query-scope" checked={queryScope==='profile'} onChange={()=>{dirty.current.publicQuery=true;setQueryScope('profile');}}/>仅账户资料</label><label><input type="radio" name="online-query-scope" checked={queryScope==='profile-and-public-posts'} onChange={()=>{dirty.current.publicQuery=true;setQueryScope('profile-and-public-posts');}}/>账户资料和公开帖子</label><label><input type="checkbox" checked={showLinkedIds} onChange={event=>{dirty.current.publicQuery=true;setShowLinkedIds(event.target.checked);}}/>展示关联 ID，并允许从 ID 找到此账户</label><label><input type="checkbox" checked={showExternalCredentials} onChange={event=>{dirty.current.publicQuery=true;setShowExternalCredentials(event.target.checked);}}/>展示已导入且未停止展示的本人外部凭据</label><p className="muted">私有会话、本地资料和凭据原件保持私有。</p>{session.account.id&&<a href={'/app/accounts/'+session.account.id} onClick={event=>{event.preventDefault();navigate('/app/accounts/'+session.account.id);}}>查看公开资料页</a>}</>}</fieldset><Button type="submit" disabled={busy||!available}>保存</Button></form>}
 {settings&&view==='type'&&<section className="online-account-type"><form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(changeType);}}><fieldset disabled={busy}><legend>当前：{typeName(settings.subjectType)}</legend>{(['person','organization','agent'] as const).map(value=><label key={value}><input type="radio" name="online-account-type" checked={nextType===value} onChange={()=>setNextType(value)}/>{typeName(value)}</label>)}</fieldset><label>更正原因<textarea minLength={8} maxLength={2000} required value={reason} onChange={event=>setReason(event.target.value)}/></label><label>相应依据<textarea minLength={8} maxLength={4000} required value={basis} onChange={event=>setBasis(event.target.value)}/></label><p className="muted">保留变更记录，不改变本地 ID、既有署名或授权。</p><Button type="submit" disabled={busy||!available||!nextType||nextType===settings.subjectType}>提交更正</Button></form><h2>变更记录</h2>{!available?<p>连接恢复后显示变更记录。</p>:settings.typeHistory?.length?<ol className="plain-record-list">{settings.typeHistory.map(item=><li key={item.revision}><strong>{typeName(item.previousType)} · {typeName(item.nextType)}</strong><p>{item.reason}</p><p>{item.basis}</p><time>{new Date(item.createdAt).toLocaleString('zh-CN')}</time></li>)}</ol>:<p>暂无变更。</p>}</section>}
 {view==='archives'&&<section className="online-account-archives"><header className="account-archive-toolbar"><span className="muted">仅自己可见</span><div className="button-row"><Button variant="outline" onClick={()=>setArchiveAction('sync')}>同步会话</Button><Button variant="ghost" onClick={()=>setArchiveAction('import')}>导入文件</Button><Button variant="ghost" onClick={()=>setArchiveAction('cleanup')}>清理设置</Button></div></header>
 <div className={'account-reading'+(readingArchive?' has-selection':'')}><aside className="account-reading-index" aria-label="会话列表">{available&&archives.length?<ul className="account-archive-list">{archives.map(value=><li key={value.id}><button type="button" className="account-reading-row" disabled={busy} aria-current={readingArchive?.id===value.id} onClick={()=>void run(()=>openArchive(value))}><strong>{value.title}</strong>{value.createdAt&&<time>{new Date(value.createdAt).toLocaleString('zh-CN')}</time>}{!archiveComplete(value)&&<small>保存中</small>}</button></li>)}</ul>:!available?<p>连接恢复后显示会话。</p>:archivesLoaded?<p className="empty-state">还没有私有会话。</p>:error?<p>会话暂时无法加载。</p>:<output>正在加载会话…</output>}<div ref={archiveMore}>{archiveNext&&<Button variant="ghost" disabled={busy} onClick={()=>void run(loadArchivePage)}>更多会话</Button>}</div></aside>
 {available&&readingArchive?<article className="account-reading-detail"><button type="button" className="account-reading-back" onClick={()=>{archiveSelection.current++;archiveTarget.current=null;setReadingArchive(null);}}>会话列表</button><header><div><h2>{readingArchive.title}</h2><span className="muted">仅自己可见</span></div><div className="button-row">{readingArchive.complete&&<Button variant="outline" disabled={busy} onClick={()=>void run(()=>download({id:readingArchive.id,title:readingArchive.title}))}>导出</Button>}<Button variant="ghost" disabled={busy} onClick={()=>setDeleteId(readingArchive.id)}>删除</Button></div></header>{readingArchive.complete?<ArchiveReading key={readingArchive.id} sessions={readingArchive.sessions} archiveTitle={readingArchive.title}/>:<p>这份会话尚未保存完成，可以继续原来的上传或删除此副本。</p>}</article>:<div className="account-reading-detail account-reading-empty">{busy?'正在加载会话…':'选择一份会话阅读'}</div>}</div>
 {available&&deleteId&&<ReadingSurface open title="删除私有会话" onClose={()=>setDeleteId(null)}><p>删除“{archives.find(value=>value.id===deleteId)?.title??'所选会话'}”？已导出的副本保留。</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>setDeleteId(null)}>取消</Button><Button disabled={busy} onClick={()=>void run(async()=>{const id=deleteId;await call('/v1/account/archives/delete',{id});if(active.current){archiveSelection.current++;if(archiveTarget.current?.id===id)archiveTarget.current=null;setDeleteId(null);setArchives(old=>old.filter(value=>value.id!==id));setReadingArchive(old=>old?.id===id?null:old);setNotice('已删除。');}})}>删除</Button></div></ReadingSurface>}

 {archiveAction&&<ReadingSurface open title={archiveAction==='sync'?'同步本机会话':archiveAction==='import'?'导入会话':'自动清理'} onClose={()=>setArchiveAction(null)}>
 {archiveAction==='sync'&&<LocalGalaxyPanelEntry view="privacy"/>}
 {archiveAction==='cleanup'&&!settings&&<output>正在加载清理设置…</output>}{archiveAction==='cleanup'&&settings&&<form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(async()=>{await save('retention');setArchiveAction(null);});}}><label>保存天数<input type="number" min={1} max={36500} value={retention} onChange={event=>{dirty.current.retention=true;setRetention(event.target.value);}} placeholder="长期保存"/></label><p className="muted">留空则长期保存。按每份会话的创建日期计算，也适用于已有会话。</p><div className="button-row"><Button type="submit" disabled={busy||!available}>保存</Button>{retention.trim()&&<Button type="button" variant="ghost" disabled={busy||!available} onClick={()=>void run(async()=>{await save('retention');await call('/v1/account/archives/cleanup',{});if(active.current){setNotice('已按设置清理。');setArchiveAction(null);setRead(value=>value+1);}})}>保存并立即清理</Button>}</div></form>}
 {archiveAction==='import'&&<section className="account-archive-import"><p>选择银河导出的会话文件，再选择需要保存的内容。</p><input type="file" aria-label="会话导出文件" accept="application/json,.json" disabled={busy||!!upload.current} onChange={event=>{const selected=event.target.files?.[0];if(selected)void run(()=>chooseFile(selected));}}/>{file&&<form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(archive);}}><label>名称<input maxLength={200} value={title} disabled={busy||!!upload.current} onChange={event=>setTitle(event.target.value)}/></label><fieldset disabled={busy||!!upload.current}><legend>保存哪些会话</legend>{file.sessions.map((item:ImportSession)=><label key={item.sessionId}><input type="checkbox" checked={selection.includes(item.sessionId)} onChange={event=>setSelection(old=>event.target.checked?[...old,item.sessionId]:old.filter(value=>value!==item.sessionId))}/><span>{item.title}{item.format==='galaxy-private-conversation-v1'&&<small className="archive-source-coverage">{item.messageCount} 条已保存材料{item.completeConversation?'':' · 部分会话'}{item.excludedItems?' · '+item.excludedItems+' 处排除':''}{item.hasEarlier?' · 有更早内容未包含':''}{item.hasMore?' · 有后续内容未包含':''}</small>}{typeof item.coverage==='string'&&<small className="archive-source-coverage">{item.coverage}</small>}</span></label>)}</fieldset><Button type="submit" disabled={busy||!available||!selection.length}>{busy?'正在保存…':upload.current?'继续保存':'保存所选会话'}</Button></form>}{upload.current&&!busy&&<Button variant="ghost" onClick={()=>{upload.current=null;setNotice('已停止上传，已保存的内容保留。');setRead(value=>value+1);}}>停止上传</Button>}</section>}
 </ReadingSurface>}
 </section>}
 </>;
}
function ArchiveReading({sessions,archiveTitle}:{sessions:ArchiveReadingSession[];archiveTitle:string}){
 const [shown,setShown]=useState(40),more=useRef<HTMLDivElement>(null),count=sessions.reduce((sum,value)=>sum+value.entries.length,0);
 useEffect(()=>{if(shown>=count||!more.current)return;const observer=new IntersectionObserver(entries=>{if(entries.some(value=>value.isIntersecting))setShown(value=>value+40);},{rootMargin:'300px'});observer.observe(more.current);return()=>observer.disconnect();},[shown,count]);
 let offset=0;
 return <div className="account-conversation-reading">{sessions.map(session=>{const start=offset;offset+=session.entries.length;return <section key={session.sessionId}>{(sessions.length>1||session.title!==archiveTitle)&&<h2>{session.title}</h2>}{(session.completeConversation===false||session.excludedItems>0||session.hasMore||session.hasEarlier)&&<p className="archive-source-coverage">{session.completeConversation===false?'已保存的部分会话。 ':''}{session.excludedItems?'含 '+session.excludedItems+' 处排除材料。 ':''}{session.hasEarlier?'有更早内容未包含。 ':''}{session.hasMore?'有后续内容未包含。':''}</p>}{session.entries.length?session.entries.slice(0,Math.max(0,shown-start)).map((entry)=><article key={entry.id} className={'account-conversation-message conversation-role-'+entry.role}><header><strong>{({user:'用户',assistant:'AI',system:'系统',tool:'工具',message:'内容'} as Record<string,string>)[entry.role]??entry.role}</strong>{typeof entry.at==='string'&&Number.isFinite(Date.parse(entry.at))&&<time>{new Date(entry.at).toLocaleString('zh-CN')}</time>}</header>{entry.text?<div className="forum-prose">{entry.text.split(/\n{2,}/).map((paragraph,index)=><p key={index}>{paragraph}</p>)}</div>:<p className="muted">此条未保存可读文字。</p>}{entry.excludedItems>0&&<small className="archive-source-coverage">{entry.excludedItems} 处材料已排除</small>}</article>):<p>这份资料没有可显示的会话文字，可导出后查看原文件。</p>}</section>;})}<div ref={more}>{shown<count&&<Button variant="ghost" onClick={()=>setShown(value=>value+40)}>继续阅读</Button>}</div></div>;
}
