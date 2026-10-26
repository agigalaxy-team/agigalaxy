'use client';

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {flushSync} from 'react-dom';
import {useRouter,useSearchParams} from 'next/navigation';
import {AdminTabs} from "../AdminTabs";
import {ReadStatus} from "../OperationControls";
import {SettingsDraftBoundary,useSettingsDraftState} from "../SettingsDraftBoundary";
import {GuardedGetForm} from "../GuardedGetForm";
import {useOperationsRead} from "../../lib/use-operations-read";
import {useSettingsDraftMemory} from "../../lib/use-settings-draft-memory";
import {settingsManagementReceiptPath,type SettingsDraftSession} from "../../lib/settings-draft-memory";
import {hasOperatorPermission,type OperatorBusinessAuthorization} from "../../lib/access";
import {managementAccountDate,managementAccountName,managementAccountQualification,managementAccountTabs,managementAccountsBase,managementAccountsHref,managementAccountsLocation,managementAccountsQuery,managementAccountsRoute,managementAiDomains,managementAiLabel,managementAiSources,managementAssignments,managementCanCommand,managementCommandLabels,managementDirectoryStatus,managementPermissionSources,managementProfileMerge,managementProfileRefresh,managementRoleAiDomains} from "../../lib/management-accounts/management-accounts-view-model";
import type {ManagementAccountDetail,ManagementAccountsLocation,ManagementAccountsPage,ManagementActionDraft,ManagementCreateDraft,ManagementHistory,ManagementProfileDraft} from './management-accounts-types';

import {useManagementCommand,type ManagementCommandIntent as Intent,type ManagementCommandResolved as Resolved} from "../../lib/management-accounts/use-management-command";
import {Avatar,AccountState,Directory,CreateForm,RolesPanel,AiUsePanel,PermissionList,ActionForm,ProfileForm,Receipt,History,AssignmentImpact} from "./ManagementAccountPanels";
import './management-accounts.css';

type Props={operatorId:string;csrfToken:string;businessAuthorization:OperatorBusinessAuthorization|null;initialLocation:ManagementAccountsLocation;initialPage:ManagementAccountsPage|null;initialDetail:ManagementAccountDetail|null;initialError?:string;initialDetailError?:string};
type ProfileChoices=Partial<Record<'firstName'|'lastName'|'note','mine'|'current'>>;

export function ManagementAccounts(props:Props){return <section className="galaxy-management-accounts"><SettingsDraftBoundary scope={managementAccountsRoute} resetKey={props.csrfToken}><ManagementAccountsContent {...props}/></SettingsDraftBoundary></section>;}

function ManagementAccountsContent({operatorId,csrfToken,businessAuthorization,initialLocation,initialPage,initialDetail,initialError='',initialDetailError=''}:Props){
 const router=useRouter(),search=useSearchParams(),browserLocation=managementAccountsLocation(Object.fromEntries(search.entries()));
 const [serverPage,setServerPage]=useState(initialPage),[serverDetail,setServerDetail]=useState(initialDetail);
 useEffect(()=>{setServerPage(null);setServerDetail(null);},[]);
 const [pin,setPin]=useState<{location:ManagementAccountsLocation;csrfToken:string}|null>(null),location=pin?.csrfToken===csrfToken?pin.location:browserLocation;
 const listQuery=managementAccountsQuery(location).toString(),initialQuery=managementAccountsQuery(initialLocation).toString();
 const directory=useOperationsRead<ManagementAccountsPage>({path:managementAccountsBase+'?'+listQuery,initial:listQuery===initialQuery?serverPage:null,initialError:listQuery===initialQuery?initialError:'',failureMessage:'管理账户目录暂时无法读取。',clearOnOffline:true});
 const page=directory.value,selected=location.creating?'':location.operator||page?.items[0]?.operatorId||'';
 const detail=useOperationsRead<ManagementAccountDetail>({path:selected?managementAccountsBase+'/'+selected:null,initial:serverDetail?.item.operatorId===selected?serverDetail:null,initialError:selected===initialLocation.operator?initialDetailError:'',failureMessage:'当前管理账户暂时无法读取。',clearOnOffline:true});
 const current=detail.verified&&detail.value?.item.operatorId===selected?detail.value:null,item=current?.item??null;
 const historyRead=useOperationsRead<ManagementHistory>({path:selected&&location.tab==='history'&&location.historyAfter?managementAccountsBase+'/'+selected+'/history?'+new URLSearchParams({after:location.historyAfter,limit:'30'}):null,failureMessage:'处理记录暂时无法读取。',clearOnOffline:true});
 const [filters,setFilters]=useState(browserLocation);
 const [createDraft,setCreateDraft]=useState<ManagementCreateDraft>({username:'',firstName:'',lastName:'',note:'',roleIds:[]}),[password,setPassword]=useState('');
 const [profileDrafts,setProfileDrafts]=useState<Record<string,ManagementProfileDraft>>({}),[editing,setEditing]=useState<Record<string,boolean>>({}),[mergeChoices,setMergeChoices]=useState<Record<string,{version:string;fields:ProfileChoices}>>({});
 const [actionDrafts,setActionDrafts]=useState<Record<string,ManagementActionDraft>>({}),[roleChoice,setRoleChoice]=useState<Record<string,string>>({}),[last,setLast]=useState<Resolved|null>(null),[message,setMessage]=useState(''),[postCreate,setPostCreate]=useState<ManagementAccountsLocation|null>(null);
 const passwordOwner=location.creating?'create':selected+':'+(actionDrafts[selected]?.kind??'');
 useLayoutEffect(()=>{setPassword('');},[passwordOwner]);
 useEffect(()=>{setFilters(browserLocation);},[managementAccountsQuery(browserLocation).toString()]);
 const canViewRoles=hasOperatorPermission({businessAuthorization},'permissions.read');
 const canSubmit=useCallback((intent:Intent)=>{
  if(intent.owner!==operatorId||intent.csrfToken!==csrfToken)return false;
  if(intent.kind==='create')return directory.verified&&page?.capabilities.canCreate===true&&(intent.body.roleIds as string[]??[]).every(id=>page.roles.some(role=>role.id===id&&role.canAssign));
  if(!detail.verified||!current||current.item.operatorId!==intent.targetOperatorId)return false;
  if(intent.kind==='assignment-save')return current.capabilities.canAssignRoles&&(intent.body.enabled===false||current.roles.some(role=>role.id===intent.body.roleId&&role.canAssign));
  return managementCanCommand(current,intent.kind);
 },[operatorId,csrfToken,directory.verified,page,detail.verified,current]);
 const onResult=useCallback((result:Resolved,terminal:boolean)=>{
  setLast(result);setPassword('');
  if(!terminal)return;
  if(result.kind==='assignment'){
   setMessage(result.value.assignment.enabled?'业务角色已分配。':'业务角色已撤回。');
   setRoleChoice(previous=>({...previous,[result.value.assignment.operatorId]:''}));
  }else{
   const value=result.value,id=value.targetOperatorId;
   setMessage('');
   if(value.state==='completed'&&id){setEditing(previous=>({...previous,[id]:false}));setProfileDrafts(previous=>{const next={...previous};delete next[id];return next;});setActionDrafts(previous=>{const next={...previous};delete next[id];return next;});}
   if(value.kind==='create'&&id&&value.state!=='failed'){
    setCreateDraft({username:'',firstName:'',lastName:'',note:'',roleIds:[]});
    const destination={...location,creating:false,operator:id,tab:'overview' as const,historyAfter:''};setPin({location:destination,csrfToken});setPostCreate(destination);
   }
  }
  void directory.read();void detail.read();
 },[csrfToken,location,directory.read,detail.read]);
 const command=useManagementCommand({operatorId,csrfToken,canRead:directory.verified,canSubmit,onResult,onRejected:()=>{void detail.read();void directory.read();}}),locked=command.locked;
 const interactionDisabled=locked||!directory.ready;
 const paginationOwnerScope=JSON.stringify([operatorId,csrfToken,businessAuthorization?.version??'',managementAccountsQuery({...location,page:1}).toString()]);
 const paginationSource=useRef<{scope:string;generation:string}|null>(null);
 const canReadDirectory=hasOperatorPermission({businessAuthorization},'management.accounts.read');
 const freshPaginationGeneration=directory.verified&&page?.source.coverage==='complete-generation'?page.source.generationId:null;
 const paginationGeneration=freshPaginationGeneration??(paginationSource.current?.scope===paginationOwnerScope?paginationSource.current.generation:null);
 const paginationFocusScope=canReadDirectory&&!locked&&!directory.error&&csrfToken&&businessAuthorization?.version&&paginationGeneration?JSON.stringify([paginationOwnerScope,paginationGeneration]):null;
 useLayoutEffect(()=>{
  if(!canReadDirectory||directory.error||paginationSource.current?.scope!==paginationOwnerScope)paginationSource.current=null;
  // Current source metadata only; commands and private password memory are separate.
  if(canReadDirectory&&!directory.error&&freshPaginationGeneration)paginationSource.current={scope:paginationOwnerScope,generation:freshPaginationGeneration};
 },[paginationOwnerScope,freshPaginationGeneration,canReadDirectory,directory.error]);
 useEffect(()=>{if(!locked&&!postCreate)setPin(null);},[locked,postCreate]);
 useEffect(()=>{if(!postCreate||locked)return;if(!browserLocation.creating&&browserLocation.operator===postCreate.operator){setPostCreate(null);setPin(null);}else router.push(managementAccountsHref(postCreate),{scroll:false});},[postCreate,locked,browserLocation.creating,browserLocation.operator,router]);
 useLayoutEffect(()=>{if(!directory.verified)setPassword('');},[directory.verified]);
 const profile=current?profileDrafts[selected]??{firstName:current.identity.firstName??'',lastName:current.identity.lastName??'',note:current.profile.note,reason:'',targetVersion:current.targetVersion,baseFirstName:current.identity.firstName??'',baseLastName:current.identity.lastName??'',baseNote:current.profile.note}:null;
 useEffect(()=>{if(!current)return;setProfileDrafts(previous=>{const old=previous[selected];if(!old)return previous;const fresh=managementProfileRefresh(old,{...current.identity,note:current.profile.note});return fresh===old?previous:{...previous,[selected]:fresh};});},[selected,current?.targetVersion]);
 const action=actionDrafts[selected]??null,choice=mergeChoices[selected],choices=current&&choice&&choice.version===current.targetVersion?choice.fields:{};
 const merged=profile&&current?managementProfileMerge(profile,{...current.identity,note:current.profile.note,targetVersion:current.targetVersion},choices):null;
 const profileChanged=!!current&&!!merged&&(merged.firstName!==(current.identity.firstName??'')||merged.lastName!==(current.identity.lastName??'')||merged.note!==current.profile.note);
 const dirty=!!password||!!(createDraft.username||createDraft.firstName||createDraft.lastName||createDraft.note||createDraft.roleIds.length)||Object.values(profileDrafts).some(draft=>draft.firstName!==draft.baseFirstName||draft.lastName!==draft.baseLastName||draft.note!==draft.baseNote||!!draft.reason)||Object.values(actionDrafts).some(draft=>!!(draft.reason||draft.newEmail||draft.confirmed));
 useSettingsDraftState(dirty,locked);
 const tablePositions=useRef(new Map<string,number>()),detailPositions=useRef(new Map<string,number>()),tableRef=useRef<HTMLDivElement|null>(null),leftRef=useRef<HTMLDivElement|null>(null),rightRef=useRef<HTMLDivElement|null>(null),readingKey=selected+':'+location.tab;
 const memory=useSettingsDraftMemory({scope:'management',ready:directory.verified,blocked:locked,denied:!!directory.error&&/登录|权限/.test(directory.error),snapshot:()=>({createDraft,profileDrafts,actionDrafts,editing,roleChoice,mergeChoices,tablePositions:[...tablePositions.current],detailPositions:[...detailPositions.current]}),restore:value=>{setCreateDraft(value.createDraft);setProfileDrafts(value.profileDrafts);setActionDrafts(value.actionDrafts);setEditing(value.editing);setRoleChoice(value.roleChoice);setMergeChoices(value.mergeChoices);tablePositions.current=new Map(value.tablePositions);detailPositions.current=new Map(value.detailPositions);setPassword('');},discard:()=>{setCreateDraft({username:'',firstName:'',lastName:'',note:'',roleIds:[]});setProfileDrafts({});setActionDrafts({});setEditing({});setRoleChoice({});setMergeChoices({});setPassword('');}});
 const pendingSession=useRef<SettingsDraftSession|null>(null);
 useLayoutEffect(()=>{
  const session=memory.session;if(!session?.current()){pendingSession.current=null;return;}
  if(!directory.verified||!memory.initialized)return;
  if(pendingSession.current!==session){
   pendingSession.current=session;const saved=session.pending('management');
   if(saved&&settingsManagementReceiptPath(saved)){
    setPin({location:{...browserLocation,creating:saved.kind==='create',operator:saved.targetOperatorId??'',tab:'overview',historyAfter:''},csrfToken});command.resume(saved);return;
   }
  }
  session.setPending('management',command.pending?{operationId:command.pending.operationId,kind:command.pending.kind,targetOperatorId:command.pending.targetOperatorId}:null);
 },[memory.session,memory.initialized,directory.verified,command.pending,csrfToken]);
 useLayoutEffect(()=>{if(tableRef.current)tableRef.current.scrollTop=tablePositions.current.get(listQuery)??0;},[listQuery,directory.verified,!!page,memory.initialized]);
 useLayoutEffect(()=>{if(leftRef.current)leftRef.current.scrollTop=detailPositions.current.get(readingKey+':left')??0;if(rightRef.current)rightRef.current.scrollTop=detailPositions.current.get(readingKey+':right')??0;},[readingKey,!!current,memory.initialized]);
 function updateFilters(patch:Partial<ManagementAccountsLocation>){flushSync(()=>setFilters(previous=>({...previous,...patch})));}
 // These destinations stay inside this mounted editor. Keep its per-account
 // drafts and original pending owner; cross-module Links still use the shared guard.
 function navigate(patch:Partial<ManagementAccountsLocation>){if(locked)return;setMessage('');router.push(managementAccountsHref(location,patch),{scroll:false});}
 function pinCurrent(){setPin({location:{...location,...(!location.creating?{operator:selected}:{})},csrfToken});setLast(null);setMessage('');}
 function openProfile(){if(!current||locked||!current.capabilities.canEditProfile)return;setActionDrafts(previous=>{const next={...previous};delete next[selected];return next;});setProfileDrafts(previous=>previous[selected]?previous:{...previous,[selected]:{firstName:current.identity.firstName??'',lastName:current.identity.lastName??'',note:current.profile.note,reason:'',targetVersion:current.targetVersion,baseFirstName:current.identity.firstName??'',baseLastName:current.identity.lastName??'',baseNote:current.profile.note}});setEditing(previous=>({...previous,[selected]:true}));if(location.tab!=='overview')navigate({tab:'overview',historyAfter:''});}
 function changeProfile(patch:Partial<ManagementProfileDraft>){if(!profile||!current||locked)return;setProfileDrafts(previous=>({...previous,[selected]:{...profile,...patch}}));}
 function cancelProfile(){if(locked)return;setEditing(previous=>({...previous,[selected]:false}));setProfileDrafts(previous=>{const next={...previous};delete next[selected];return next;});setMergeChoices(previous=>{const next={...previous};delete next[selected];return next;});}
 function openAction(kind:ManagementActionDraft['kind']){
  if(!current||locked||!managementCanCommand(current,kind))return;setPassword('');setEditing(previous=>({...previous,[selected]:false}));
  setActionDrafts(previous=>({...previous,[selected]:{kind,reason:previous[selected]?.reason??'',targetVersion:current.targetVersion,newEmail:previous[selected]?.kind===kind?previous[selected].newEmail:'',action:item?.admission==='administrator'?'demote':'promote',confirmed:false}}));
  if(location.tab!=='overview')navigate({tab:'overview',historyAfter:''});
 }
 function submitCreate(){
  if(locked||!directory.verified||!page?.capabilities.canCreate||!password||createDraft.roleIds.length>100||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(createDraft.username.trim())||createDraft.roleIds.some(id=>!page.roles.some(role=>role.id===id&&role.canAssign)))return;
  pinCurrent();const secret=password;setPassword('');command.submit({kind:'create',path:managementAccountsBase,targetOperatorId:null,body:{...createDraft,username:createDraft.username.trim(),firstName:createDraft.firstName.trim(),lastName:createDraft.lastName.trim(),note:createDraft.note.trim()}},secret);
 }
 function submitProfile(){
  if(locked||!current||!profile||!merged?.ready||!current.capabilities.canEditProfile||!profileChanged)return;
  const fields:Record<string,string>={};if(merged.firstName!==(current.identity.firstName??''))fields.firstName=merged.firstName.trim();if(merged.lastName!==(current.identity.lastName??''))fields.lastName=merged.lastName.trim();if(merged.note!==current.profile.note)fields.note=merged.note.trim();
  pinCurrent();command.submit({kind:'profile-update',path:managementAccountsBase+'/'+selected+'/commands',targetOperatorId:selected,body:{kind:'profile-update',expectedVersion:current.targetVersion,reason:profile.reason.trim(),...fields}});
 }
 function submitAction(){
  if(locked||!current||!action||!managementCanCommand(current,action.kind)||action.targetVersion!==current.targetVersion||action.kind==='password-reset'&&!password||action.kind==='email-change'&&!action.newEmail.trim()||action.kind==='delete'&&!action.confirmed)return;
  pinCurrent();const secret=action.kind==='password-reset'?password:undefined;setPassword('');
  command.submit({kind:action.kind,path:managementAccountsBase+'/'+selected+'/commands',targetOperatorId:selected,body:{kind:action.kind,expectedVersion:action.targetVersion,reason:action.reason.trim(),...(action.kind==='email-change'?{newEmail:action.newEmail.trim()}:{}),...(action.kind==='admission-change'?{action:action.action}:{})}},secret);
 }
 const assignments=current?managementAssignments(current):[],roles=current?.roles??[],activeRoles=assignments.filter(value=>value.enabled),addable=roles.filter(role=>role.canAssign&&!activeRoles.some(assignment=>assignment.roleId===role.id)),chosen=roles.find(role=>role.id===roleChoice[selected]);
 function assign(roleId:string,enabled:boolean){
  if(locked||!current||!current.capabilities.canAssignRoles)return;
  const role=roles.find(item=>item.id===roleId),old=assignments.find(item=>item.roleId===roleId);if(!role||enabled&&!role.canAssign||enabled&&old?.enabled||!enabled&&!old?.enabled)return;
  pinCurrent();command.submit({kind:'assignment-save',path:managementAccountsBase+'/'+selected+'/assignments',targetOperatorId:selected,body:{...(old?{id:old.id}:{}),expectedVersion:old?.version??0,roleId,enabled}});
 }
 const permissionSources=current?managementPermissionSources(current):{},aiSources=current?managementAiSources(current):{};
 const sourceStatus=managementDirectoryStatus(page),history=location.historyAfter?historyRead.value:current?.history;
 const showReceipt=last?.kind==='management'&&(location.creating&&directory.verified||current&&last.value.targetOperatorId===selected)?last.value:null;
 const createRoles=page?.roles??[],createInvalid=createDraft.roleIds.some(id=>!createRoles.some(role=>role.id===id&&role.canAssign));
 return <>
  <header className="ma-heading"><div><h1>{location.creating?'新建管理账户':'管理账户'}</h1><p className="ma-muted">后台登录账户与业务角色</p></div><div className="ma-actions">{location.creating?<button type="button" disabled={interactionDisabled} onClick={()=>navigate({creating:false})}>返回账户目录</button>:<>{page?.capabilities.canCreate&&<button type="button" className="ma-primary" disabled={locked||!directory.verified} onClick={()=>navigate({creating:true,tab:'overview',historyAfter:''})}>新建管理账户</button>}<button type="button" disabled={interactionDisabled||directory.refreshing} onClick={()=>void directory.read()}>刷新目录</button></>}</div></header>
  <div className="ma-status"><ReadStatus loading={directory.loading} error={directory.error} retry={directory.read}/>{sourceStatus&&<p role="status">{sourceStatus}</p>}{command.pending?<p role="status">{command.error||'正在'+(command.pending.kind==='assignment-save'?'更新业务角色':managementCommandLabels[command.pending.kind])+'…'}</p>:command.error?<p className="galaxy-error" role="alert">{command.error}</p>:message?<p role="status">{message}</p>:null}</div>
  {location.creating?<section className="ma-create"><div className="ma-detail-body"><div className="ma-scroll">
   {directory.verified&&page?.capabilities.canCreate?<section className="ma-panel"><CreateForm draft={createDraft} password={password} locked={locked} canSubmit={!locked&&!createInvalid&&!!password&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(createDraft.username.trim())} onChange={patch=>setCreateDraft(previous=>({...previous,...patch}))} onPassword={setPassword} onSubmit={submitCreate} onCancel={()=>{setPassword('');setCreateDraft({username:'',firstName:'',lastName:'',note:'',roleIds:[]});navigate({creating:false});}}/></section>:<div className="ma-empty"><h2>当前无法新建管理账户</h2><p>请按当前管理资格和账户服务状态继续。</p></div>}
   {showReceipt&&<Receipt value={showReceipt}/>}</div><div className="ma-scroll"><section className="ma-panel"><header><h3>初始业务角色</h3></header>{createRoles.length?<div className="ma-form">{createRoles.map(role=>{const picked=createDraft.roleIds.includes(role.id);return <label className="ma-check" key={role.id}><input type="checkbox" checked={picked} disabled={locked||!directory.verified||!picked&&(!role.canAssign||createDraft.roleIds.length>=100)} onChange={event=>{const checked=event.target.checked;setCreateDraft(previous=>({...previous,roleIds:checked?previous.roleIds.length<100?[...new Set([...previous.roleIds,role.id])]:previous.roleIds:previous.roleIds.filter(id=>id!==role.id)}));}}/><span>{role.name}{!role.enabled?'（已停用）':''}<span className="ma-muted"> · AI使用：{managementAiLabel(managementRoleAiDomains(role.permissions))}</span></span></label>;})}</div>:<p className="ma-muted">尚无可选业务角色，创建后可在账户详情分配。</p>}{createDraft.roleIds.length>=100&&<p className="ma-muted">本次已选择 100 个角色，可先移除再调整。</p>}{createInvalid&&<p className="galaxy-error">有选中角色已不可分配，请先移除。</p>}</section><section className="ma-panel"><h3>成员账户</h3><p className="ma-muted">新账户按所选角色获得业务权限和 AI 使用范围。管理员资格由根管理员另行调整。</p></section></div></div></section>:<>
   <GuardedGetForm action={managementAccountsRoute} blocked={interactionDisabled} className="ma-filters"><input type="hidden" name="page" value="1"/><input type="hidden" name="pageSize" value={location.pageSize}/><input type="hidden" name="sort" value={location.sort}/>
    <label className="ma-search">搜索<input name="query" placeholder="名称、登录名或邮箱" maxLength={200} value={filters.query} disabled={interactionDisabled} onChange={event=>{const query=event.target.value;updateFilters({query});}}/></label>
    <label>状态<select name="enabled" value={filters.enabled} disabled={interactionDisabled} onChange={event=>{const enabled=event.target.value==='true'?'true':event.target.value==='false'?'false':'';updateFilters({enabled});}}><option value="">全部</option><option value="true">启用</option><option value="false">停用</option></select></label>
    <label>业务角色<select name="roleId" value={filters.roleId} disabled={interactionDisabled} onChange={event=>{const roleId=event.target.value;updateFilters({roleId});}}><option value="">全部角色</option>{page?.roles.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
    <label>AI使用<select name="aiDomain" value={filters.aiDomain} disabled={interactionDisabled} onChange={event=>{const aiDomain=event.target.value as ManagementAccountsLocation['aiDomain'];updateFilters({aiDomain});}}><option value="">全部范围</option>{managementAiDomains.map(domain=><option key={domain.id} value={domain.id}>{domain.label}</option>)}</select></label>
    <div className="ma-filter-actions"><button type="submit" className="ma-primary" disabled={interactionDisabled}>查询</button><button type="button" disabled={interactionDisabled} onClick={()=>navigate({page:1,query:'',enabled:'',roleId:'',aiDomain:'',operator:'',tab:'overview',historyAfter:''})}>清空</button></div>
   </GuardedGetForm>
   <div className="ma-workspace">
    <Directory value={page} selected={selected} location={location} focusScope={paginationFocusScope} focusReady={!!freshPaginationGeneration&&!directory.error} locked={interactionDisabled} loading={directory.loading||directory.refreshing} onSelect={operator=>navigate({operator,tab:'overview',historyAfter:''})} onNavigate={navigate} pageHref={page=>managementAccountsHref(location,{page,operator:''})} scrollRef={tableRef} onScroll={position=>{tablePositions.current.set(listQuery,position);}}/>
    <section className="ma-detail" aria-label="当前管理账户"><div className="ma-status"><ReadStatus loading={detail.loading} error={detail.error} retry={detail.read}/></div>
     {item&&current?<><header className="ma-detail-heading"><div className="ma-person"><Avatar item={item} large/><div><h2>{managementAccountName(item)}</h2><p><span>{item.username||'登录名未取得'}</span><AccountState item={item}/><span>{managementAccountQualification(item)}</span>{selected===operatorId&&<span>当前登录</span>}</p></div></div><div className="ma-actions">{current.capabilities.canEditProfile&&<button type="button" disabled={locked} onClick={openProfile}>编辑资料</button>}{current.capabilities.canDisableLogin&&<button type="button" className="ma-danger" disabled={locked} onClick={()=>openAction('login-disable')}>停用</button>}{current.capabilities.canRestoreLogin&&<button type="button" disabled={locked} onClick={()=>openAction('login-restore')}>恢复</button>}{current.capabilities.canDelete&&<button type="button" className="ma-danger" disabled={locked} onClick={()=>openAction('delete')}>删除</button>}</div></header>
      <AdminTabs ariaLabel="管理账户详情" active={location.tab} items={managementAccountTabs.map(tab=>({...tab,disabled:locked&&tab.id!==location.tab}))} onChange={tab=>navigate({tab:tab as ManagementAccountsLocation['tab'],historyAfter:''})}/>
      <div className={'ma-detail-body'+(location.tab==='history'?' is-single':'')}>
       <div className="ma-scroll" ref={leftRef} onScroll={event=>{detailPositions.current.set(readingKey+':left',event.currentTarget.scrollTop);}}>
        {location.tab==='overview'&&<section className="ma-panel">{editing[selected]&&profile?<ProfileForm draft={profile} current={current} choices={choices} locked={locked} canSubmit={!locked&&current.capabilities.canEditProfile&&profileChanged} onChange={changeProfile} onChoice={(field,value)=>setMergeChoices(previous=>({...previous,[selected]:{version:current.targetVersion,fields:{...(previous[selected]?.version===current.targetVersion?previous[selected].fields:{}),[field]:value}}}))} onSubmit={submitProfile} onCancel={cancelProfile}/>:action?<ActionForm draft={action} password={password} locked={locked} changed={action.targetVersion!==current.targetVersion} canSubmit={!locked&&managementCanCommand(current,action.kind)&&(action.kind!=='password-reset'||!!password)&&(action.kind!=='email-change'||!!action.newEmail.trim())&&(action.kind!=='delete'||action.confirmed)} onChange={patch=>setActionDrafts(previous=>({...previous,[selected]:{...previous[selected],...patch}}))} onPassword={setPassword} onSubmit={submitAction} onCancel={()=>{setPassword('');setActionDrafts(previous=>{const next={...previous};delete next[selected];return next;});}}/>:<><header><h3>账户资料</h3></header><dl className="ma-facts"><dt>名称</dt><dd>{managementAccountName(item)}</dd><dt>登录名</dt><dd>{item.username||'未取得'}</dd><dt>邮箱</dt><dd>{item.email||(current.identity.state==='available'?'未提供':'尚未取得')}{item.email&&<span className="ma-muted"> · {item.emailVerified===true?'已验证':item.emailVerified===false?'未验证':'验证状态未取得'}</span>}</dd><dt>账户类型</dt><dd>{managementAccountQualification(item)}</dd><dt>创建时间</dt><dd>{managementAccountDate(item.createdAt)}</dd><dt>密码要求</dt><dd>{current.identity.state!=='available'?'尚未取得':current.identity.requiredActions.includes('UPDATE_PASSWORD')?'下次登录需修改密码':'未要求修改'}</dd><dt>管理备注</dt><dd>{current.profile.note||'未填写'}</dd></dl>{current.capabilities.canChangeEmail&&<div className="ma-actions"><button type="button" disabled={locked} onClick={()=>openAction('email-change')}>更换邮箱</button></div>}{current.identity.state!=='available'&&<p className="ma-muted">{current.identity.state==='not-found'?'登录身份未找到。':current.identity.state==='not-configured'?'登录身份来源尚未配置。':'登录身份暂时无法读取。'}</p>}</>}</section>}
        {location.tab==='roles'&&<RolesPanel roles={roles} assignments={assignments} addable={addable} choice={roleChoice[selected]??''} locked={locked} canAssign={current.capabilities.canAssignRoles} canViewRoles={canViewRoles} onChoice={id=>setRoleChoice(previous=>({...previous,[selected]:id}))} onAssign={()=>chosen&&assign(chosen.id,true)} onRevoke={assignment=>assign(assignment.roleId,false)} impact={roleId=><AssignmentImpact detail={current} roleId={roleId} enabled={false}/>}>{chosen&&!activeRoles.some(value=>value.roleId===chosen.id)&&<AssignmentImpact detail={current} roleId={chosen.id} enabled/>}{item.rootAdministrator&&<p className="ma-muted">根管理员拥有预配置完整权限，业务角色不会收窄其权限。</p>}</RolesPanel>}
        {location.tab==='ai'&&<AiUsePanel domains={current.aiUse.domains} root={item.rootAdministrator} enabled={item.enabled===true&&current.effective.state==='available'} sources={aiSources} locked={locked} canAssign={current.capabilities.canAssignRoles} onRoles={()=>navigate({tab:'roles'})}/>}
        {location.tab==='history'&&<section className="ma-panel"><header><h3>账户处理记录</h3></header><ReadStatus loading={historyRead.loading} error={historyRead.error} retry={historyRead.read}/>{history&&<History items={history.items}/>}<div className="ma-actions">{location.historyAfter&&<button type="button" disabled={locked} onClick={()=>navigate({historyAfter:''})}>最新记录</button>}{history?.nextAfter&&<button type="button" disabled={locked} onClick={()=>navigate({historyAfter:history.nextAfter!})}>更早记录</button>}</div></section>}
        {showReceipt&&<Receipt value={showReceipt}/>} 
       </div>
       {location.tab!=='history'&&<div className="ma-scroll" ref={rightRef} onScroll={event=>{detailPositions.current.set(readingKey+':right',event.currentTarget.scrollTop);}}>
        {location.tab==='overview'?<section className="ma-panel"><header><h3>登录与安全</h3></header><dl className="ma-facts"><dt>认证登录会话</dt><dd>{current.security.sessions.sso.state==='available'&&current.security.sessions.sso.activeCount!==null?current.security.sessions.sso.activeCount+' 个':'尚未取得'}</dd><dt>后台登录会话</dt><dd>{current.security.sessions.portal.state==='available'&&current.security.sessions.portal.activeCount!==null?current.security.sessions.portal.activeCount+' 个':'尚未取得'}</dd></dl><div className="ma-actions">{current.capabilities.canResetPassword&&<button type="button" disabled={locked} onClick={()=>openAction('password-reset')}>重置临时密码</button>}{current.capabilities.canRevokeSessions&&<button type="button" disabled={locked} onClick={()=>openAction('sessions-revoke')}>撤销会话</button>}{current.capabilities.canChangeAdmission&&<button type="button" disabled={locked} onClick={()=>openAction('admission-change')}>{item.admission==='administrator'?'改为成员':'设为管理员'}</button>}</div>{item.rootAdministrator&&<p className="ma-muted" style={{marginTop:12}}>根管理员身份由预配置固定，不能在后台停用、删除或变更资格。</p>}</section>:location.tab==='roles'?<><AiUsePanel domains={current.aiUse.domains} root={item.rootAdministrator} enabled={item.enabled===true&&current.effective.state==='available'} sources={aiSources} locked={locked} canAssign={current.capabilities.canAssignRoles}/><section className="ma-panel"><header><h3>当前有效权限 · {current.effective.permissions.length} 项</h3></header><PermissionList permissions={current.effective.permissions} sources={permissionSources}/></section></>:<section className="ma-panel"><header><h3>业务权限来源</h3></header><p className="ma-muted">业务查询同时受本账户与 AI 工作账户权限限制。</p><PermissionList permissions={current.effective.permissions} sources={permissionSources}/></section>}
       </div>}
      </div>
     </>:<div className="ma-empty"><h2>{selected?'账户详情暂不可读取':'选择一个管理账户'}</h2>{!selected&&<p>从上方目录进入账户资料、角色与 AI 使用范围。</p>}</div>}
    </section>
   </div>
  </>}
 </>;
}
