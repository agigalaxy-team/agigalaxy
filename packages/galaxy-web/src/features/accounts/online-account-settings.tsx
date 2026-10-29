import {SelectionRail} from '../../shared/navigation/SelectionRail';
import React,{useCallback,useEffect,useEffectEvent,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {OfficialAccountStatus,type OfficialSession} from './official-account-panel';
import {AccountSessionScope,useAccountSessionModel,useOnlineAccountDraftMemory} from './account-session-scope';
import {AccountEntryPage,useAccountConnection} from './account-center';
import {conversationArchiveParts,exportConversationArchive,readConversationArchiveFile,conversationArchiveReading} from './account-archive-file.mjs';
import {AccountExternalCredentials} from './account-external-credentials';
import {AccountWorkHistory} from './account-work-history';
import {ReadingSurface} from "../../shared/reading/reading-details";
import {LocalGalaxyPanelEntry} from "../local-galaxy/local-galaxy-entry";
import {useReadTasks} from "../../shared/reading/use-read-task";
import {definitiveReadFailure} from '../../shared/reading/read-failure';
import {FeedbackOwnData} from "../feedback/own-data";
import {AccountAvatarPicker} from './account-profile-avatar';
import {LoadingFeedback,ReadFailure} from "../../shared/feedback/interaction-feedback";
import './online-account-settings.css';
import './online-account-settings-dialog.css';
import './account-reading.css';

type Settings={accountId:string;uid?:string|null;subjectType:'person'|'organization'|'agent'|null;displayName:string|null;avatarKey:string|null;bio:string;revision:number;publicQuery:{enabled:boolean;scope:'profile'|'profile-and-public-posts';showLinkedIds:boolean;showExternalCredentials:boolean};archiveRetentionDays:number|null;typeHistory:{previousType:string|null;nextType:string;revision:number;reason:string;basis:string;createdAt:string}[]};
type SettingsChanges=Partial<Pick<Settings,'displayName'|'avatarKey'|'bio'|'publicQuery'|'archiveRetentionDays'>>;
const sameSetting=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
function settingsConflict(previous:Settings,incoming:Settings,changes:SettingsChanges){
 for(const key of Object.keys(changes) as (keyof SettingsChanges)[])if(!sameSetting(incoming[key],previous[key])&&!sameSetting(incoming[key],changes[key]))return true;
 return false;
}
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

type OnlineAccountProps={endpoint?:string;navigate:(path:string)=>void;view?:string};
export function OnlineAccountSettings(props:OnlineAccountProps){return <AccountSessionScope endpoint={props.endpoint}><OnlineAccountSettingsContent {...props}/></AccountSessionScope>;}
function OnlineAccountSettingsContent({endpoint,navigate,view='profile'}:OnlineAccountProps){
 const official=useAccountSessionModel(),{session,authority}=useAccountConnection(endpoint,official),ownerId=session?.account.id,csrf=session?.csrfToken,source=official.client;
 const client=useMemo(()=>{
  if(!source)return null;
   return {...source,async call(...args:Parameters<typeof source.call>){
   const current=authority.requireSession(ownerId,csrf),result=await source.call(args[0],args[1],{...args[2],session:current});
   authority.requireSession(ownerId,csrf);return result;
   },async transfer(...args:Parameters<typeof source.transfer>){
    const current=authority.requireSession(ownerId,csrf),result=await source.transfer(args[0],args[1],{...args[2],session:current});
    authority.requireSession(ownerId,csrf);return result;
   }};
 },[source,ownerId,csrf,authority]);
 const available=official.phase==='signed-in';
 if(!session?.account.id||!client)return <AccountEntryPage navigate={navigate} returnTo={'/app/account?section=settings'+(view!=='profile'?'&view='+view:'')}/>;
 return <section className={'online-account-settings'+(['work','archives'].includes(view)?' online-account-reading':'')}><header className="account-page-heading">{['work','archives'].includes(view)&&<button type="button" className="back-link" onClick={()=>navigate('/app/work')}>我的工作</button>}<h1>{view==='type'?'更正账户类型':view==='archives'?'我的私有会话':view==='credentials'?'外部凭据':view==='work'?'工作记录':view==='privacy'?'隐私与资料':'账户设置'}</h1></header>{!available&&<OfficialAccountStatus model={official} navigate={navigate} returnTo={'/app/account?section=settings'+(view!=='profile'?'&view='+view:'')} compact/>}<OnlineAccountSession key={endpoint+':'+session.account.id+':'+session.csrfToken} session={session} client={client} draftClient={source!} navigate={navigate} view={view} available={available} onProfileSaved={()=>void official.refresh()}/></section>;
}

function OnlineAccountSession({session,client,draftClient,navigate,view,available,onProfileSaved}:{session:OfficialSession;client:NonNullable<ReturnType<typeof useAccountSessionModel>['client']>;draftClient:object;navigate:(path:string)=>void;view:string;available:boolean;onProfileSaved:()=>void}){
 const [settings,setSettings]=useState<Settings|null>(null),[archives,setArchives]=useState<Archive[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[read,setRead]=useState(0),[settingsChanged,setSettingsChanged]=useState(false);
 const dirty=useRef({displayName:false,avatarKey:false,bio:false,publicQuery:false,retention:false});
  const [archiveNext,setArchiveNext]=useState<string|null>(null),loaded=useRef({settings:-1,archives:-1});
 const [avatarKey,setAvatarKey]=useState<string|null>(null),[bio,setBio]=useState('');
 const [displayName,setDisplayName]=useState(''),[queryEnabled,setQueryEnabled]=useState(false),[queryScope,setQueryScope]=useState<Settings['publicQuery']['scope']>('profile'),[showLinkedIds,setShowLinkedIds]=useState(false),[showExternalCredentials,setShowExternalCredentials]=useState(false),[retention,setRetention]=useState('');
 const currentInput=useRef({displayName:'',avatarKey:null as string|null,bio:'',publicQuery:{enabled:false,scope:'profile' as Settings['publicQuery']['scope'],showLinkedIds:false,showExternalCredentials:false},retention:''});
 const draftMemory=useOnlineAccountDraftMemory(),draftLease=useMemo(()=>({client:draftClient,accountId:session.account.id!,csrfToken:session.csrfToken}),[draftClient,session.account.id,session.csrfToken]);
 const settingsSource=useRef<Settings|null>(null),draftConflict=useRef(false);
 const persistDraft=useCallback(()=>{if(settingsSource.current)draftMemory.write(draftLease,settingsSource.current,currentInput.current,dirty.current,draftConflict.current);},[draftMemory,draftLease]);
 const markSettingsChanged=(value:boolean)=>{draftConflict.current=value;setSettingsChanged(value);};
 useLayoutEffect(()=>()=>persistDraft(),[persistDraft]);
 useLayoutEffect(()=>{currentInput.current={displayName,avatarKey,bio,publicQuery:{enabled:queryEnabled,scope:queryScope,showLinkedIds,showExternalCredentials},retention};},[displayName,avatarKey,bio,queryEnabled,queryScope,showLinkedIds,showExternalCredentials,retention]);
 function editName(value:string){dirty.current.displayName=true;currentInput.current.displayName=value;setDisplayName(value);setNotice('');persistDraft();}
 function editAvatar(value:string|null){dirty.current.avatarKey=true;currentInput.current.avatarKey=value;setAvatarKey(value);setNotice('');persistDraft();}
 function editBio(value:string){dirty.current.bio=true;currentInput.current.bio=value;setBio(value);setNotice('');persistDraft();}
 function editPrivacy(patch:Partial<Settings['publicQuery']>){const value={...currentInput.current.publicQuery,...patch};dirty.current.publicQuery=true;currentInput.current.publicQuery=value;setQueryEnabled(value.enabled);setQueryScope(value.scope);setShowLinkedIds(value.showLinkedIds);setShowExternalCredentials(value.showExternalCredentials);setNotice('');persistDraft();}
 function editRetention(value:string){dirty.current.retention=true;currentInput.current.retention=value;setRetention(value);setNotice('');persistDraft();}
 const [nextType,setNextType]=useState<Settings['subjectType']>(null),[reason,setReason]=useState(''),[basis,setBasis]=useState(''),[typeSourceChanged,setTypeSourceChanged]=useState(false);
 const typeInput=useRef({nextType:null as Settings['subjectType'],reason:'',basis:''}),typeChanged=useRef(false);
 const persistTypeCorrection=useCallback(()=>{if(settingsSource.current)draftMemory.writeTypeCorrection(draftLease,settingsSource.current,typeInput.current,typeChanged.current);},[draftMemory,draftLease]);
 useLayoutEffect(()=>()=>persistTypeCorrection(),[persistTypeCorrection]);
 const applyTypeSource=useCallback((value:Settings)=>{
  const restored=draftMemory.restoreTypeCorrection(draftLease,value),input=restored?.values??{nextType:value.subjectType,reason:'',basis:''};
  typeInput.current=input;typeChanged.current=restored?.sourceChanged===true;setNextType(input.nextType);setReason(input.reason);setBasis(input.basis);setTypeSourceChanged(typeChanged.current);
 },[draftMemory,draftLease]);
 function editTypeCorrection(patch:Partial<typeof typeInput.current>){const input={...typeInput.current,...patch};typeInput.current=input;typeChanged.current=false;setNextType(input.nextType);setReason(input.reason);setBasis(input.basis);setTypeSourceChanged(false);setError('');setNotice('');persistTypeCorrection();}
 const [file,setFile]=useState<ImportFile|null>(null),[selection,setSelection]=useState<string[]>([]),[title,setTitle]=useState(''),[deleteId,setDeleteId]=useState<string|null>(null),[uploadPending,setUploadPending]=useState(false);
 const [archiveAction,setArchiveAction]=useState<'sync'|'import'|'cleanup'|null>(null),[readingArchive,setReadingArchive]=useState<ArchiveSelection|null>(null);
 const archiveAutoOpened=useRef(false);
  const archiveMore=useRef<HTMLDivElement>(null),archivePages=useRef(1),archiveValue=useRef<ArchiveSelection|null>(null),archiveTarget=useRef<Archive|null>(null),failedAction=useRef<(()=>Promise<void>)|null>(null);
 const [archivesLoaded,setArchivesLoaded]=useState(false),[settingsBusy,setSettingsBusy]=useState(false),[settingsError,setSettingsError]=useState(''),[archiveListBusy,setArchiveListBusy]=useState(false),[archiveDetailBusy,setArchiveDetailBusy]=useState(false),[archiveListError,setArchiveListError]=useState(''),[archiveDetailError,setArchiveDetailError]=useState(''),[archiveSelectedId,setArchiveSelectedId]=useState<string|null>(null),[archiveShown,setArchiveShown]=useState(40),[exportingId,setExportingId]=useState<string|null>(null);
 const tasks=useReadTasks(session.account.id??'official-account');
 useLayoutEffect(()=>{archiveValue.current=readingArchive;},[readingArchive]);
 const accountId=session.account.id;
  const active=useRef(true),working=useRef(false),upload=useRef<{id:string;title:string;workspaceId:string|null;sessionIds:string[];parts:string[];next:number;created:boolean}|null>(null);
 const call=useCallback((path:string,input:unknown=null,method='POST',options?:{signal?:AbortSignal})=>client.call(path,input,{method,signal:options?.signal}),[client]);
 async function archiveCall(path:string,input:unknown,operation:NonNullable<typeof upload.current>){for(let attempt=0;;attempt++){if(!active.current||upload.current!==operation)throw new DOMException('Upload stopped','AbortError');try{return await call(path,input);}catch(reason){const network=reason instanceof TypeError||reason instanceof DOMException&&['AbortError','TimeoutError'].includes(reason.name);if(!network||attempt>=2||navigator.onLine===false)throw reason;await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));}}}
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 const applySettings=useCallback((value:Settings)=>{if(!dirty.current.displayName)setDisplayName(value.displayName??'');if(!dirty.current.avatarKey)setAvatarKey(value.avatarKey??null);if(!dirty.current.bio)setBio(value.bio??'');if(!dirty.current.publicQuery){setQueryEnabled(value.publicQuery.enabled);setQueryScope(value.publicQuery.scope);setShowLinkedIds(value.publicQuery.showLinkedIds===true);setShowExternalCredentials(value.publicQuery.showExternalCredentials===true);}if(!dirty.current.retention)setRetention(value.archiveRetentionDays===null?'':String(value.archiveRetentionDays));},[]);
 const loadSettings=useCallback(()=>tasks.run({lane:'settings',key:'current'},async({signal})=>{
  const value=await call('/v1/account/settings',null,'GET',{signal}) as Settings;if(value.accountId!==accountId)throw Error('official_account_changed');return value;
 },{onStart:()=>{setSettingsBusy(true);setSettingsError('');},onSuccess:value=>{
  loaded.current.settings=read;settingsSource.current=value;setSettings(value);applyTypeSource(value);
  const restored=draftMemory.restore(draftLease,value);
  if(restored){
   dirty.current=restored.dirty;currentInput.current=restored.values;
   setDisplayName(restored.values.displayName);setAvatarKey(restored.values.avatarKey);setBio(restored.values.bio);setQueryEnabled(restored.values.publicQuery.enabled);setQueryScope(restored.values.publicQuery.scope);setShowLinkedIds(restored.values.publicQuery.showLinkedIds);setShowExternalCredentials(restored.values.publicQuery.showExternalCredentials);setRetention(restored.values.retention);
   draftConflict.current=restored.conflicted;setSettingsChanged(restored.conflicted);
   if(restored.conflicted)setNotice('资料已在别处更新，你的修改保留。请核对后再保存。');
  }else applySettings(value);
  persistDraft();
 },onError:reason=>{if(definitiveReadFailure(reason))setSettings(null);setSettingsError(message(reason));},onSettled:()=>setSettingsBusy(false)}),[tasks,call,applySettings,applyTypeSource,read,accountId,draftMemory,draftLease,persistDraft]);
 const openArchive=useCallback((value:Archive)=>{
  const same=archiveTarget.current?.id===value.id;archiveTarget.current=value;setArchiveSelectedId(value.id);if(!same){setArchiveShown(40);setReadingArchive(null);setDeleteId(null);setArchiveDetailError('');}
  return tasks.run<ArchiveSelection>({lane:'archive-detail',key:value.id},async({signal})=>{
   if(!archiveComplete(value))return {id:value.id,title:value.title,complete:false,sessions:[]} as ArchiveSelection;
   const result=await exportConversationArchive((path:string,input:unknown)=>call(path,input,'POST',{signal}),value.id,{signal});
   return {id:value.id,title:value.title,complete:true,sessions:conversationArchiveReading(result.content)} as ArchiveSelection;
  },{onStart:()=>{setArchiveDetailBusy(true);setArchiveDetailError('');},onSuccess:setReadingArchive,onError:reason=>{if(definitiveReadFailure(reason))setReadingArchive(null);setArchiveDetailError(message(reason));},onSettled:()=>setArchiveDetailBusy(false)});
 },[tasks,call]);
 const confirmArchive=useCallback((value:Archive,rows:Archive[])=>{
  const visible=rows.find(item=>item.id===value.id);
  if(visible){if(archiveValue.current?.id!==visible.id||!archiveValue.current.complete&&archiveComplete(visible))void openArchive(visible);return;}
  void tasks.run({lane:'archive-detail',key:value.id},async({signal})=>{
   const status=await call('/v1/account/archives/status',{id:value.id},'POST',{signal}) as ArchiveStatus;if(status.id!==value.id)throw Error('会话资料与当前选择不一致。');
   if(!status.archive)return {status,selection:null};
   if(!archiveComplete(status.archive))return {status,selection:{id:value.id,title:status.archive.title,complete:false,sessions:[]} as ArchiveSelection};
   const result=await exportConversationArchive((path:string,input:unknown)=>call(path,input,'POST',{signal}),value.id,{signal});return {status,selection:{id:value.id,title:status.archive.title,complete:true,sessions:conversationArchiveReading(result.content)} as ArchiveSelection};
  },{onStart:()=>{setArchiveDetailBusy(true);setArchiveDetailError('');},onSuccess:result=>{if(result.selection){setReadingArchive(result.selection);return;}archiveTarget.current=null;setArchiveSelectedId(null);setReadingArchive(null);setDeleteId(null);setNotice(result.status.state==='expired'?'这份会话已按清理设置移除。':'这份会话已不在此账户中。');},onError:reason=>{if(definitiveReadFailure(reason))setReadingArchive(null);setArchiveDetailError(message(reason));},onSettled:()=>setArchiveDetailBusy(false)});
 },[tasks,call,openArchive]);
 const loadArchives=useCallback((after?:string)=>tasks.run({lane:'archive-list',key:after??'head'},async({signal})=>{
  const rows:Archive[]=[];let cursor=after,last:ArchivePage|null=null;const seen=new Set<string>();
  for(let index=0;index<(after?1:archivePages.current);index++){const result=await call('/v1/account/archives'+(cursor?'?'+new URLSearchParams({after:cursor,limit:'50'}):''),null,'GET',{signal}) as ArchivePage;signal.throwIfAborted();if(!Array.isArray(result.archives))throw Error('会话列表暂时无法读取。');rows.push(...result.archives);last=result;if(!result.nextAfter)break;if(result.nextAfter===cursor||seen.has(result.nextAfter))throw Error('后续会话暂时无法读取。');seen.add(result.nextAfter);cursor=result.nextAfter;}return {rows,last};
 },{onStart:()=>{setArchiveListBusy(true);setArchiveListError('');},onSuccess:({rows,last})=>{if(!last)return;if(after)archivePages.current++;setArchives(old=>after?[...new Map([...old,...rows].map(item=>[item.id,item])).values()]:rows);setArchiveNext(last.nextAfter??null);setArchivesLoaded(true);loaded.current.archives=read;if(!after&&archiveTarget.current)confirmArchive(archiveTarget.current,rows);},onError:reason=>{if(definitiveReadFailure(reason)){tasks.cancel('archive-detail');setArchiveDetailBusy(false);setArchives([]);setArchiveNext(null);setReadingArchive(null);setArchivesLoaded(false);}setArchiveListError(message(reason));},onSettled:()=>setArchiveListBusy(false)}),[tasks,call,confirmArchive,read]);
 useEffect(()=>{
  let active=true;
  const refresh=async()=>{
   await Promise.resolve();if(!active)return;
   if(!available){tasks.cancel('settings');loaded.current.settings=-1;setSettingsBusy(false);return;}
   if(!['profile','privacy','type','archives'].includes(view)||loaded.current.settings===read)return;
   await loadSettings();
  };
  void refresh();return()=>{active=false;tasks.cancel('settings');};
 },[loadSettings,read,view,available,tasks]);
 useEffect(()=>{
  let active=true;
  const unavailable=()=>{if(!active)return;tasks.cancel('archive-list');tasks.cancel('archive-detail');tasks.cancel('archive-export');setExportingId(null);setArchiveListBusy(false);setArchiveDetailBusy(false);setArchiveListError(navigator.onLine===false?'暂时离线，联网后继续读取所选会话。':'账户连接恢复后继续读取。');};
  const refresh=()=>{if(active&&!document.hidden&&!working.current&&!tasks.isPending('archive-list')&&navigator.onLine!==false)void loadArchives();};
  const initialise=async()=>{
   await Promise.resolve();if(!active)return;
   if(!available){unavailable();return;}
   if(view!=='archives'){setArchiveListBusy(false);setArchiveDetailBusy(false);setExportingId(null);setArchives([]);setArchiveNext(null);setReadingArchive(null);setArchivesLoaded(false);return;}
   if(navigator.onLine===false)unavailable();else refresh();
  };
  void initialise();
  const cancel=()=>{active=false;tasks.cancel('archive-list');tasks.cancel('archive-detail');tasks.cancel('archive-export');};
  if(!available||view!=='archives')return cancel;
  const timer=window.setInterval(refresh,30000);window.addEventListener('focus',refresh);window.addEventListener('online',refresh);window.addEventListener('offline',unavailable);document.addEventListener('visibilitychange',refresh);
  return()=>{cancel();window.clearInterval(timer);window.removeEventListener('focus',refresh);window.removeEventListener('online',refresh);window.removeEventListener('offline',unavailable);document.removeEventListener('visibilitychange',refresh);};
 },[loadArchives,view,available,tasks]);
 async function run(action:()=>Promise<void>,retryAction:()=>Promise<void>=action){if(working.current)return;working.current=true;tasks.cancel();setExportingId(null);setSettingsBusy(false);setArchiveListBusy(false);setArchiveDetailBusy(false);failedAction.current=null;setBusy(true);setError('');setNotice('');try{await action();}catch(e){if(active.current){failedAction.current=retryAction;setError(message(e));}}finally{working.current=false;if(active.current)setBusy(false);}}
 async function save(section:'profile'|'privacy'|'retention'='profile'){
  if(!settings)return;
  let base=settings;
  const submitted={displayName,avatarKey,bio,publicQuery:{enabled:queryEnabled,scope:queryScope,showLinkedIds,showExternalCredentials},retention};
  const days=section==='retention'?(retention.trim()===''?null:Number(retention)):settings.archiveRetentionDays;
  if(days!==null&&(!Number.isInteger(days)||days<1||days>36500))throw Error('请输入 1 至 36500 天，或留空长期保存。');
  const changes:SettingsChanges={};
  if(section==='profile'){
   if(dirty.current.displayName&&!sameSetting(displayName.trim()||null,settings.displayName))changes.displayName=displayName.trim()||null;
   if(dirty.current.avatarKey&&!sameSetting(avatarKey,settings.avatarKey??null))changes.avatarKey=avatarKey;
   if(dirty.current.bio&&!sameSetting(bio.trim(),settings.bio??''))changes.bio=bio.trim();
  }else if(section==='privacy'){
   if(dirty.current.publicQuery&&!sameSetting(submitted.publicQuery,settings.publicQuery))changes.publicQuery=submitted.publicQuery;
  }else if(dirty.current.retention&&!sameSetting(days,settings.archiveRetentionDays))changes.archiveRetentionDays=days;
  if(!Object.keys(changes).length){
   if(section==='profile'){dirty.current.displayName=false;dirty.current.avatarKey=false;dirty.current.bio=false;}else if(section==='privacy')dirty.current.publicQuery=false;else dirty.current.retention=false;
   applySettings(settings);if(!Object.values(dirty.current).some(Boolean))markSettingsChanged(false);persistDraft();setNotice('已保存。');return;
  }
  for(let attempt=0;attempt<2;attempt++){
   try{
    const fields={displayName:base.displayName,avatarKey:base.avatarKey??null,bio:base.bio??'',publicQuery:base.publicQuery,archiveRetentionDays:base.archiveRetentionDays,...changes};
    const saved=await call('/v1/account/settings',{expectedRevision:base.revision,...fields}) as {accountId:string;revision:number};
    if(saved.accountId!==session.account.id||!Number.isInteger(saved.revision))throw Error('official_account_changed');
    if(active.current){
     const value={...base,...fields,revision:saved.revision};
     const unchanged=section==='profile'?currentInput.current.displayName===submitted.displayName&&currentInput.current.avatarKey===submitted.avatarKey&&currentInput.current.bio===submitted.bio:section==='privacy'?sameSetting(currentInput.current.publicQuery,submitted.publicQuery):currentInput.current.retention===submitted.retention;
     settingsSource.current=value;setSettings(value);
     if(section==='profile'){dirty.current.displayName=currentInput.current.displayName!==submitted.displayName;dirty.current.avatarKey=currentInput.current.avatarKey!==submitted.avatarKey;dirty.current.bio=currentInput.current.bio!==submitted.bio;}else if(section==='privacy')dirty.current.publicQuery=!unchanged;else dirty.current.retention=!unchanged;
     applySettings(value);markSettingsChanged(false);persistDraft();setNotice(unchanged?'已保存。':'新修改尚未保存。');if(section==='profile')onProfileSaved();
    }
    return;
   }catch(problem){
    const code=problem&&typeof problem==='object'&&'code'in problem?String(problem.code):'';
    if(code!=='account_settings_changed'||attempt>0)throw problem;
    const incomingSettings=await call('/v1/account/settings',null,'GET') as Settings;
    if(incomingSettings.accountId!==session.account.id)throw Error('official_account_changed');
    const conflict=settingsConflict(base,incomingSettings,changes);
    settingsSource.current=incomingSettings;setSettings(incomingSettings);applySettings(incomingSettings);base=incomingSettings;
    if(conflict){markSettingsChanged(true);persistDraft();throw Error(section==='retention'?'清理设置已在别处改为'+(incomingSettings.archiveRetentionDays===null?'长期保存':incomingSettings.archiveRetentionDays+'天')+'。你的选择保留，确认后可再保存。':'账户资料已在别处更新：名称'+(incomingSettings.displayName?'“'+incomingSettings.displayName+'”':'未设置')+'，公开查询'+(incomingSettings.publicQuery.enabled?'已开启':'已关闭')+'。你的修改保留，确认后可再保存。');}
    persistDraft();
   }
  }
 }

 function discardProfileChanges(){
  const current=settingsSource.current;if(!current)return;
  dirty.current.displayName=false;dirty.current.avatarKey=false;dirty.current.bio=false;
  currentInput.current={...currentInput.current,displayName:current.displayName??'',avatarKey:current.avatarKey??null,bio:current.bio??''};
  setDisplayName(currentInput.current.displayName);setAvatarKey(currentInput.current.avatarKey);setBio(currentInput.current.bio);
  if(!Object.values(dirty.current).some(Boolean))markSettingsChanged(false);
  failedAction.current=null;setError('');setNotice('已撤销本次资料修改。');persistDraft();
 }
 function discardTypeCorrection(){
  draftMemory.clearTypeCorrection(draftLease);const input={nextType:settingsSource.current?.subjectType??null,reason:'',basis:''};
  typeInput.current=input;typeChanged.current=false;setNextType(input.nextType);setReason('');setBasis('');setTypeSourceChanged(false);failedAction.current=null;setError('');setNotice('已撤销本次更正。');
 }
 async function changeType(){
  const base=settingsSource.current,input={...typeInput.current};if(!base||!input.nextType||input.nextType===base.subjectType)return;
  try{await call('/v1/account/type-change',{expectedRevision:base.revision,subjectType:input.nextType,reason:input.reason.trim(),basis:input.basis.trim(),preserveHistory:true});}
  catch(problem){
   const code=problem&&typeof problem==='object'&&'code'in problem?String(problem.code):'';
   if(code!=='account_settings_changed')throw problem;
   const refreshed=await loadSettings();
   if(active.current&&refreshed.status==='success'){typeChanged.current=true;setTypeSourceChanged(true);persistTypeCorrection();setNotice('账户资料已更新，你的更正内容保留。');}
   return;
  }
  if(active.current){draftMemory.clearTypeCorrection(draftLease);typeInput.current={nextType:null,reason:'',basis:''};typeChanged.current=false;setReason('');setBasis('');setNextType(null);setTypeSourceChanged(false);setNotice('账户类型已更正，变更记录已保留。');setRead(value=>value+1);}
 }
 async function chooseFile(selected:File){if(selected.size>67108864)throw Error('会话文件超过 64 MiB，请选择较小范围或分段导出。');const value=readConversationArchiveFile(await selected.text());if(active.current){setFile(value);setSelection([]);setTitle(selected.name.replace(/\.json$/i,''));upload.current=null;setUploadPending(false);}}
 async function archive(){
  if(!upload.current){if(!file||!selection.length)throw Error('请选择需要保存的会话。');upload.current={id:crypto.randomUUID(),title:title.trim()||'所选会话',workspaceId:file.workspaceId,sessionIds:[...selection],parts:conversationArchiveParts(file,selection),next:0,created:false};setUploadPending(true);}
  const value=upload.current;
  if(!value.created){await archiveCall('/v1/account/archives/create',{id:value.id,title:value.title,selection:{workspaceId:value.workspaceId,sessionIds:value.sessionIds},uploadLevel:'conversation-archive',includeFullConversation:true},value);value.created=true;}
  while(value.next<value.parts.length){await archiveCall('/v1/account/archives/chunk',{id:value.id,sequence:value.next,content:value.parts[value.next]},value);value.next++;}
  await archiveCall('/v1/account/archives/complete',{id:value.id,chunkCount:value.parts.length},value);
  if(active.current&&upload.current===value){upload.current=null;setUploadPending(false);setFile(null);setSelection([]);setNotice('会话已保存。');setArchiveAction(null);setRead(value=>value+1);}
 }
 const resumeArchive=useEffectEvent(()=>{if(available&&upload.current&&!working.current)void run(archive);});
 useEffect(()=>{const resume=()=>resumeArchive();if(available)resume();window.addEventListener('online',resume);return()=>window.removeEventListener('online',resume);},[client,session.account.id,session.csrfToken,available]);
 function download(value:Archive){return tasks.run({lane:'archive-export',key:value.id},({signal})=>exportConversationArchive((path:string,input:unknown)=>call(path,input,'POST',{signal}),value.id,{signal}),{onStart:()=>{setExportingId(value.id);setArchiveDetailError('');},onSuccess:result=>{const url=URL.createObjectURL(new Blob([result.content],{type:'application/json;charset=utf-8'})),anchor=document.createElement('a');anchor.href=url;anchor.download=(value.title||'银河私有会话').replace(/[\\/:*?"<>|]/g,'_')+'.json';anchor.click();URL.revokeObjectURL(url);setNotice('下载已开始。');},onError:reason=>setArchiveDetailError(message(reason)),onSettled:()=>setExportingId(null)});}
 function loadArchivePage(){if(archiveNext)return loadArchives(archiveNext);}
 useEffect(()=>{const element=archiveMore.current;if(!available||archiveListBusy||!element||!archiveNext||view!=='archives')return;const observer=new IntersectionObserver(entries=>{if(entries.some(value=>value.isIntersecting)&&!working.current)void loadArchives(archiveNext);},{rootMargin:'300px'});observer.observe(element);return()=>observer.disconnect();},[archiveNext,view,archiveListBusy,available,loadArchives]);
 useEffect(()=>{const first=archives.find(archiveComplete);if(available&&view==='archives'&&!archiveAutoOpened.current&&!archiveTarget.current&&first&&!working.current&&window.matchMedia('(min-width:761px)').matches){archiveAutoOpened.current=true;void openArchive(first);}},[archives,view,available,openArchive]);
 const actionFeedback=<ReadFailure message={error} retryLabel="重试" retrying={busy} onRetry={!settingsChanged&&available?()=>{const action=failedAction.current;if(action)void run(action);else setRead(value=>value+1);}:undefined}/>;
 return <>{!['work','archives'].includes(view)&&<SelectionRail active={view} className="online-account-tabs" aria-label="账户设置">{[['profile','个人资料'],['privacy','隐私与资料'],['credentials','外部凭据']].map(([key,label])=><button key={key} type="button" aria-current={view===key||view==='type'&&key==='profile'?'page':undefined} onClick={()=>navigate('/app/account?section=settings'+(key==='profile'?'':'&view='+key))}>{label}</button>)}</SelectionRail>}
  {!archiveAction&&!deleteId&&<>{actionFeedback}{notice&&<output className="message">{notice}</output>}</>}
  {['profile','privacy','type'].includes(view)&&<LoadingFeedback active={settingsBusy} label="正在读取账户资料…" scopeKey={session.account.id+':settings'}/>} {settingsError&&['profile','privacy','type','archives'].includes(view)&&<ReadFailure message={settingsError} onRetry={available?()=>{void loadSettings();}:undefined} retrying={settingsBusy}/>}
  {view==='credentials'&&<AccountExternalCredentials call={call} available={available}/>} {session.account.id&&<AccountWorkHistory accountId={session.account.id} call={call} available={available} active={view==='work'}/>}
 {settings&&view==='profile'&&<form className="workspace-form online-account-form" onSubmit={event=>{event.preventDefault();void run(()=>save('profile'));}}>{settings.uid&&<p className="account-uid"><span>UID</span> <code>{settings.uid}</code></p>}<label>用户名<input value={displayName} maxLength={120} onChange={event=>editName(event.target.value)} aria-describedby="account-username-help"/></label><p id="account-username-help" className="muted">用户名可修改，UID 保持不变。</p><AccountAvatarPicker subjectType={settings.subjectType} seed={settings.accountId} value={avatarKey} onChange={editAvatar} disabled={busy||!available}/><label>个人简介<textarea aria-label="个人简介" value={bio} maxLength={500} rows={4} disabled={busy||!available} onChange={event=>editBio(event.target.value)} aria-describedby="account-bio-help"/></label><p id="account-bio-help" className="muted">介绍一下自己，最多 500 字。仅在你已允许的资料查询范围内展示。</p><div className="online-account-type-line"><span>{typeName(settings.subjectType)}</span><button type="button" className="text-link" onClick={()=>navigate('/app/account?section=settings&view=type')}>更正账户类型</button></div><div className="button-row"><Button type="submit" disabled={busy||!available}>保存</Button>{(dirty.current.displayName||dirty.current.avatarKey||dirty.current.bio)&&<Button type="button" variant="ghost" disabled={busy} onClick={discardProfileChanges}>撤销修改</Button>}</div></form>}
 {settings&&view==='privacy'&&<section className="account-privacy-settings"><form className="workspace-form online-account-form" onSubmit={event=>{event.preventDefault();void run(()=>save('privacy'));}}><fieldset><legend>对外公开</legend><label><input type="checkbox" checked={queryEnabled} onChange={event=>editPrivacy({enabled:event.target.checked})}/>允许别人查询此账户</label>{queryEnabled&&<><label><input type="radio" name="online-query-scope" checked={queryScope==='profile'} onChange={()=>editPrivacy({scope:'profile'})}/>仅账户资料</label><label><input type="radio" name="online-query-scope" checked={queryScope==='profile-and-public-posts'} onChange={()=>editPrivacy({scope:'profile-and-public-posts'})}/>账户资料和公开帖子</label><label><input type="checkbox" checked={showLinkedIds} onChange={event=>editPrivacy({showLinkedIds:event.target.checked})}/>展示关联 ID，并允许从 ID 找到此账户</label><label><input type="checkbox" checked={showExternalCredentials} onChange={event=>editPrivacy({showExternalCredentials:event.target.checked})}/>展示本人的外部凭据</label><p className="muted">私有会话、本地资料和凭据原件保持私有。</p>{session.account.id&&<a href={'/app/accounts/'+session.account.id} onClick={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate('/app/accounts/'+session.account.id);}}>查看公开资料页</a>}</>}</fieldset><Button type="submit" disabled={busy||!available}>保存公开设置</Button></form><section className="account-private-data-links"><h2>管理我的资料</h2><a href="/app/work" onClick={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate('/app/work');}}>工作记录</a><a href="/app/account?section=settings&view=archives" onClick={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate('/app/account?section=settings&view=archives');}}>私有会话与自动清理</a></section>{accountId&&<FeedbackOwnData accountId={accountId} available={available} call={(path,input,options)=>call(path,input,options?.method??'POST',{signal:options?.signal})} transfer={(path,input,options)=>client.transfer(path,input,{...options,session})}/>}</section>}
 {settings&&view==='type'&&<section className="online-account-type"><form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(changeType,async()=>{await loadSettings();});}}><fieldset disabled={busy}><legend>当前：{typeName(settings.subjectType)}</legend>{(['person','organization','agent'] as const).map(value=><label key={value}><input type="radio" name="online-account-type" checked={nextType===value} onChange={()=>editTypeCorrection({nextType:value})}/>{typeName(value)}</label>)}</fieldset>{typeSourceChanged&&<p className="message" ><output>当前账户类型为{typeName(settings.subjectType)}，资料已有更新。你的更正内容保留，请核对后再提交。</output></p>}<label>更正原因<textarea aria-label="更正原因" minLength={8} maxLength={2000} required disabled={busy} value={reason} onChange={event=>editTypeCorrection({reason:event.target.value})}/></label><label>相应依据<textarea aria-label="相应依据" minLength={8} maxLength={4000} required disabled={busy} value={basis} onChange={event=>editTypeCorrection({basis:event.target.value})}/></label><p className="muted">保留变更记录，不改变本地 ID、既有署名或授权。</p><div className="button-row"><Button type="submit" disabled={busy||!available||!nextType||nextType===settings.subjectType}>提交更正</Button>{(reason||basis||nextType!==settings.subjectType)&&<Button type="button" variant="ghost" disabled={busy} onClick={discardTypeCorrection}>撤销本次更正</Button>}</div></form><h2>变更记录</h2>{settings.typeHistory?.length?<ol className="plain-record-list">{settings.typeHistory.map(item=><li key={item.revision}><strong>{typeName(item.previousType)} · {typeName(item.nextType)}</strong><p>{item.reason}</p><p>{item.basis}</p><time>{new Date(item.createdAt).toLocaleString('zh-CN')}</time></li>)}</ol>:<p>暂无变更。</p>}</section>}
 {view==='archives'&&<section className="online-account-archives"><header className="account-archive-toolbar"><span className="muted">仅自己可见</span><div className="button-row"><Button variant="outline" onClick={()=>setArchiveAction('sync')}>同步会话</Button><Button variant="ghost" onClick={()=>setArchiveAction('import')}>导入文件</Button><Button variant="ghost" onClick={()=>setArchiveAction('cleanup')}>清理设置</Button></div></header>
  {archiveListError&&<ReadFailure message={archiveListError} onRetry={available?()=>{void loadArchives();}:undefined} retrying={archiveListBusy}/>}<LoadingFeedback active={archiveListBusy} label={archivesLoaded?'正在刷新会话列表…':'正在加载会话列表…'} scopeKey={session.account.id+':archives'}/>
  <div className={'account-reading'+(archiveSelectedId?' has-selection':'')}><aside className="account-reading-index" aria-label="会话列表">{archives.length?<ul className="account-archive-list">{archives.map(value=><li key={value.id}><button type="button" className="account-reading-row" disabled={busy||!available} aria-current={archiveSelectedId===value.id} onClick={()=>void openArchive(value)}><strong>{value.title}</strong>{value.createdAt&&<time>{new Date(value.createdAt).toLocaleString('zh-CN')}</time>}{!archiveComplete(value)&&<small>保存中</small>}</button></li>)}</ul>:!available?<p>连接恢复后继续读取会话。</p>:archivesLoaded&&!archiveListBusy&&!archiveListError?<p className="empty-state">还没有私有会话。</p>:null}<div ref={archiveMore}>{archiveNext&&<Button variant="ghost" disabled={busy||archiveListBusy||!available} onClick={()=>void loadArchivePage()}>更多会话</Button>}</div></aside>
  <article className="account-reading-detail">{archiveSelectedId&&<button type="button" className="account-reading-back" onClick={()=>{tasks.cancel('archive-detail');setArchiveDetailBusy(false);setArchiveDetailError('');archiveTarget.current=null;setArchiveSelectedId(null);setReadingArchive(null);}}>会话列表</button>}<LoadingFeedback active={archiveDetailBusy} label="正在读取所选会话…" scopeKey={session.account.id+':'+archiveSelectedId}/><LoadingFeedback active={!!exportingId} label="正在导出会话…" scopeKey={session.account.id+':export:'+exportingId}/>{archiveDetailError&&<ReadFailure message={archiveDetailError} onRetry={available&&archiveSelectedId?()=>{if(archiveTarget.current)void openArchive(archiveTarget.current);}:undefined} retrying={archiveDetailBusy}/>}
  {readingArchive?<><header><div><h2>{readingArchive.title}</h2><span className="muted">仅自己可见</span></div><div className="button-row">{readingArchive.complete&&<Button variant="outline" disabled={busy||archiveDetailBusy||!!exportingId||!available} onClick={()=>void download({id:readingArchive.id,title:readingArchive.title})}>导出</Button>}<Button variant="ghost" disabled={busy||archiveDetailBusy||!available} onClick={()=>setDeleteId(readingArchive.id)}>删除</Button></div></header>{readingArchive.complete?<ArchiveReading key={readingArchive.id} sessions={readingArchive.sessions} archiveTitle={readingArchive.title} shown={archiveShown} onMore={()=>setArchiveShown(value=>value+40)}/>:<p>这份会话尚未保存完成，可以继续原来的上传或删除此副本。</p>}</>:<div className="account-reading-empty">{archiveSelectedId?archiveDetailBusy||archiveListBusy?'':'连接恢复后继续读取所选会话。':'选择一份会话阅读'}</div>}</article></div>
  {available&&deleteId&&<ReadingSurface open className="account-settings-dialog" title="删除私有会话" onClose={()=>setDeleteId(null)}>{actionFeedback}<p>删除“{archives.find(value=>value.id===deleteId)?.title??'所选会话'}”？已导出的副本保留。</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>setDeleteId(null)}>取消</Button><Button disabled={busy} onClick={()=>void run(async()=>{const id=deleteId;await call('/v1/account/archives/delete',{id});if(active.current){if(archiveTarget.current?.id===id){archiveTarget.current=null;setArchiveSelectedId(null);}setDeleteId(null);setArchives(old=>old.filter(value=>value.id!==id));setReadingArchive(old=>old?.id===id?null:old);setNotice('已删除。');}})}>删除</Button></div></ReadingSurface>}

 {archiveAction&&<ReadingSurface open className="account-settings-dialog" title={archiveAction==='sync'?'同步本机会话':archiveAction==='import'?'导入会话':'自动清理'} onClose={()=>setArchiveAction(null)}>
 {actionFeedback}
 {archiveAction==='sync'&&<LocalGalaxyPanelEntry view="privacy"/>}
 {archiveAction==='cleanup'&&!settings&&<output>正在加载清理设置…</output>}{archiveAction==='cleanup'&&settings&&<form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(async()=>{await save('retention');if(!dirty.current.retention)setArchiveAction(null);});}}><label>保存天数<input type="number" min={1} max={36500} value={retention} onChange={event=>editRetention(event.target.value)} placeholder="长期保存"/></label><p className="muted">留空则长期保存。按每份会话的创建日期计算，也适用于已有会话。</p><div className="button-row"><Button type="submit" disabled={busy||!available}>保存</Button>{retention.trim()&&<Button type="button" variant="ghost" disabled={busy||!available} onClick={()=>void run(async()=>{await save('retention');if(dirty.current.retention)return;await call('/v1/account/archives/cleanup',{});if(active.current){setNotice('已按设置清理。');setArchiveAction(null);setRead(value=>value+1);}})}>保存并立即清理</Button>}</div></form>}
 {archiveAction==='import'&&<section className="account-archive-import"><p>选择银河导出的会话文件，再选择需要保存的内容。</p><input type="file" aria-label="会话导出文件" accept="application/json,.json" disabled={busy||uploadPending} onChange={event=>{const selected=event.target.files?.[0];if(selected)void run(()=>chooseFile(selected));}}/>{file&&<form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(archive);}}><label>名称<input maxLength={200} value={title} disabled={busy||uploadPending} onChange={event=>setTitle(event.target.value)}/></label><fieldset disabled={busy||uploadPending}><legend>保存哪些会话</legend>{file.sessions.map((item:ImportSession)=><label key={item.sessionId}><input type="checkbox" checked={selection.includes(item.sessionId)} onChange={event=>setSelection(old=>event.target.checked?[...old,item.sessionId]:old.filter(value=>value!==item.sessionId))}/><span>{item.title}{item.format==='galaxy-private-conversation-v1'&&<small className="archive-source-coverage">{item.messageCount} 条已保存材料{item.completeConversation?'':' · 部分会话'}{item.excludedItems?' · '+item.excludedItems+' 处排除':''}{item.hasEarlier?' · 有更早内容未包含':''}{item.hasMore?' · 有后续内容未包含':''}</small>}{typeof item.coverage==='string'&&<small className="archive-source-coverage">{item.coverage}</small>}</span></label>)}</fieldset><Button type="submit" disabled={busy||!available||!selection.length}>{busy?'正在保存…':uploadPending?'继续保存':'保存所选会话'}</Button></form>}{uploadPending&&!busy&&<Button variant="ghost" onClick={()=>{upload.current=null;setUploadPending(false);setNotice('已停止上传，已保存的内容保留。');setRead(value=>value+1);}}>停止上传</Button>}</section>}
 </ReadingSurface>}
 </section>}
 </>;
}
function archiveReadingSections(sessions:ArchiveReadingSession[]){
 const rows:{session:ArchiveReadingSession;start:number}[]=[];
 let start=0;
 for(const session of sessions){rows.push({session,start});start+=session.entries.length;}
 return rows;
}
function ArchiveReading({sessions,archiveTitle,shown,onMore}:{sessions:ArchiveReadingSession[];archiveTitle:string;shown:number;onMore:()=>void}){
 const more=useRef<HTMLDivElement>(null),count=sessions.reduce((sum,value)=>sum+value.entries.length,0);
 useEffect(()=>{if(shown>=count||!more.current)return;const observer=new IntersectionObserver(entries=>{if(entries.some(value=>value.isIntersecting))onMore();},{rootMargin:'300px'});observer.observe(more.current);return()=>observer.disconnect();},[shown,count,onMore]);
 return <div className="account-conversation-reading">{archiveReadingSections(sessions).map(({session,start})=><section key={session.sessionId}>{(sessions.length>1||session.title!==archiveTitle)&&<h2>{session.title}</h2>}{(session.completeConversation===false||session.excludedItems>0||session.hasMore||session.hasEarlier)&&<p className="archive-source-coverage">{session.completeConversation===false?'已保存的部分会话。 ':''}{session.excludedItems?'含 '+session.excludedItems+' 处排除材料。 ':''}{session.hasEarlier?'有更早内容未包含。 ':''}{session.hasMore?'有后续内容未包含。':''}</p>}{session.entries.length?session.entries.slice(0,Math.max(0,shown-start)).map((entry)=><article key={entry.id} className={'account-conversation-message conversation-role-'+entry.role}><header><strong>{({user:'用户',assistant:'AI',system:'系统',tool:'工具',message:'内容'} as Record<string,string>)[entry.role]??entry.role}</strong>{typeof entry.at==='string'&&Number.isFinite(Date.parse(entry.at))&&<time>{new Date(entry.at).toLocaleString('zh-CN')}</time>}</header>{entry.text?<div className="forum-prose">{entry.text.split(/\n{2,}/).map((paragraph,index)=><p key={index}>{paragraph}</p>)}</div>:<p className="muted">此条未保存可读文字。</p>}{entry.excludedItems>0&&<small className="archive-source-coverage">{entry.excludedItems} 处材料已排除</small>}</article>):<p>这份资料没有可显示的会话文字，可导出后查看原文件。</p>}</section>)}<div ref={more}>{shown<count&&<Button variant="ghost" onClick={onMore}>继续阅读</Button>}</div></div>;
}
