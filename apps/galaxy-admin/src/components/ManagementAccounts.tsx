'use client';

import {useCallback,useEffect,useLayoutEffect,useRef,useState,type ReactNode,type RefObject} from 'react';
import {flushSync} from 'react-dom';
import Link from 'next/link';
import {useRouter,useSearchParams} from 'next/navigation';
import {Pagination} from './Pagination';
import {AdminTabs} from './AdminTabs';
import {ReadStatus} from './OperationControls';
import {HistoryOperator} from './HistoryOperator';
import {SettingsDraftBoundary,useSettingsDraftState} from './SettingsDraftBoundary';
import {GuardedGetForm} from './GuardedGetForm';
import {AccountRolePicker} from './AccountRolePicker';
import {useOperationsRead} from '../lib/use-operations-read';
import {useSettingsDraftMemory} from '../lib/use-settings-draft-memory';
import {settingsManagementReceiptPath,type SettingsDraftSession,type SettingsPendingReceipt} from '../lib/settings-draft-memory';
import {operationsRequest,OperationsRequestError} from '../lib/operations-client';
import {hasOperatorPermission,operatorPermissionLabel,type OperatorBusinessAuthorization} from '../lib/access';
import {permissionOperationResult} from '../lib/permissions-view-model';
import {managementAccountDate,managementAccountErrors,managementAccountName,managementAccountQualification,managementAccountState,managementAccountTabs,managementAccountsBase,managementAccountsHref,managementAccountsLocation,managementAccountsQuery,managementAccountsRoute,managementAiDomains,managementAiLabel,managementAiSources,managementAssignments,managementAssignmentImpact,managementCanCommand,managementCommandImpacts,managementCommandLabels,managementDirectoryStatus,managementPermissionSources,managementPhaseLabels,managementPhaseStates,managementProfileMerge,managementProfileRefresh,managementReceiptLabel,managementReceiptMatches,managementRecoveredAssignment,managementRoleAiDomains} from '../lib/management-accounts-view-model';
import type {ManagementAccount,ManagementAccountDetail,ManagementAccountsLocation,ManagementAccountsPage,ManagementActionDraft,ManagementAssignableRole,ManagementAssignment,ManagementCommandKind,ManagementCommandReceipt,ManagementCreateDraft,ManagementHistory,ManagementProfileDraft} from './management-accounts-types';
import type {AssignmentSave,PermissionOperationRead} from './permissions-types';
import './management-accounts.css';

type Props={operatorId:string;csrfToken:string;businessAuthorization:OperatorBusinessAuthorization|null;initialLocation:ManagementAccountsLocation;initialPage:ManagementAccountsPage|null;initialDetail:ManagementAccountDetail|null;initialError?:string;initialDetailError?:string};
type Intent={operationId:string;owner:string;csrfToken:string;path:string;targetOperatorId:string|null;kind:ManagementCommandKind|'assignment-save';body:Record<string,unknown>;recorded:boolean;readOnly:boolean;rejectionCode?:string};
type Resolved={kind:'management';value:ManagementCommandReceipt}|{kind:'assignment';value:AssignmentSave};
type ProfileChoices=Partial<Record<'firstName'|'lastName'|'note','mine'|'current'>>;
const isTerminal=(value:ManagementCommandReceipt)=>value.state==='completed'||value.state==='partial'||value.state==='failed';

/** Secrets remain in one private ref, separate from React pending state and
 * authored drafts. A received reservation is thereafter recovered by GET. */
function useManagementCommand({operatorId,csrfToken,canRead,canSubmit,onResult,onRejected}:{operatorId:string;csrfToken:string;canRead:boolean;canSubmit:(intent:Intent)=>boolean;onResult:(value:Resolved,terminal:boolean)=>void;onRejected:()=>void}){
 const [pending,setPending]=useState<Intent|null>(null),[requesting,setRequesting]=useState(false),[error,setError]=useState(''),[attempt,setAttempt]=useState(0),[wakeup,setWakeup]=useState(0);
 const original=useRef<Intent|null>(null),secret=useRef<string|null>(null),active=useRef<AbortController|null>(null),alive=useRef(false),inFlight=useRef(false),latest=useRef({operatorId,csrfToken,canRead,canSubmit,onResult,onRejected});
 useLayoutEffect(()=>{latest.current={operatorId,csrfToken,canRead,canSubmit,onResult,onRejected};});
 const run=useCallback(async(first=false)=>{
  const intent=original.current;
  if(!intent||!alive.current||inFlight.current||!latest.current.canRead||intent.owner!==latest.current.operatorId||intent.csrfToken!==latest.current.csrfToken||!navigator.onLine||document.visibilityState==='hidden')return;
  const controller=new AbortController();active.current=controller;inFlight.current=true;setRequesting(true);
  const current=()=>alive.current&&!controller.signal.aborted&&original.current===intent&&intent.owner===latest.current.operatorId&&intent.csrfToken===latest.current.csrfToken;
  const deliver=(result:Resolved)=>{
   if(!current())return;intent.recorded=true;secret.current=null;
   const terminal=result.kind==='assignment'||isTerminal(result.value);
   if(terminal){original.current=null;setPending(null);setError('');}else{setPending({...intent});setError('');}
   latest.current.onResult(result,terminal);
  };
  function assignment(value:AssignmentSave){
   const body=intent!.body,row=value?.assignment;
   if(value?.operationId!==intent!.operationId||!row||row.operatorId!==intent!.targetOperatorId||row.roleId!==body.roleId||row.enabled!==body.enabled||body.id&&row.id!==body.id)throw Error('Unbound assignment result');
   deliver({kind:'assignment',value});
  }
  function account(value:ManagementCommandReceipt){
   if(!managementReceiptMatches(value,{operationId:intent!.operationId,kind:intent!.kind as ManagementCommandKind,targetOperatorId:intent!.targetOperatorId}))throw Error('Unbound management result');
   deliver({kind:'management',value});
  }
  try{
   let post=first;
   if(!first){
    if(intent.kind==='assignment-save'){
     const result=await operationsRequest<PermissionOperationRead>(managementAccountsBase+'/'+intent.targetOperatorId+'/assignments/operations/'+intent.operationId,{signal:controller.signal});
     if(!current())return;
     if(result.state==='recorded'){
      if(intent.readOnly){const value=managementRecoveredAssignment(result,intent,intent.owner);if(!value)throw Error('Unbound restored assignment');deliver({kind:'assignment',value});return;}
      const value=permissionOperationResult(result,{path:'/v1/operations/permissions/assignments',body:{...intent.body,operatorId:intent.targetOperatorId}},intent.owner);
      if(!value||!('assignment' in value))throw Error('Unbound original assignment');assignment(value);return;
     }
     if(result.state!=='not-recorded'||result.operationId!==intent.operationId)throw Error('Original assignment unavailable');
    }else{
     const result=await operationsRequest<ManagementCommandReceipt>(managementAccountsBase+'/operations/'+intent.operationId,{signal:controller.signal});
     if(!current())return;
     if(result.state!=='not-recorded'){account(result);return;}
     if(result.operationId!==intent.operationId)throw Error('Original management result unavailable');
    }
    if(intent.rejectionCode){original.current=null;secret.current=null;setPending(null);setError(managementAccountErrors[intent.rejectionCode]??'账户已有更新，请按当前记录继续。');latest.current.onRejected();return;}
    post=!intent.readOnly&&!intent.recorded&&latest.current.canSubmit(intent);
   }
   if(!post||intent.readOnly||!latest.current.canSubmit(intent)){setError(intent.readOnly?'尚未取得这次处理的结果，系统会继续查询。':'当前无法继续这次处理，系统会继续读取已有结果。');return;}
   const needsSecret=intent.kind==='create'||intent.kind==='password-reset';
   if(needsSecret&&secret.current===null){setError('本次密码步骤的结果尚未确定，系统会继续读取已有结果。');return;}
   const body=needsSecret?{...intent.body,temporaryPassword:secret.current}:intent.body;
   const value=await operationsRequest<ManagementCommandReceipt|AssignmentSave>(intent.path,{csrfToken:intent.csrfToken,body,signal:controller.signal});
   if(!current())return;
   if(intent.kind==='assignment-save')assignment(value as AssignmentSave);else account(value as ManagementCommandReceipt);
  }catch(failure){
   if(!current())return;
   // Only these pre-effect parse/CAS failures prove this intent did not write.
   // Authorization/read/transport errors continue through the original GET.
   const known=failure instanceof OperationsRequestError&&(failure.code==='invalid_management_accounts_request'||failure.status===409&&['management_identity_target_changed','management_operation_pending','operations_permissions_version_changed','operations_permissions_target_changed','operations_assignment_exists'].includes(failure.code));
   if(known){intent.rejectionCode=failure.code;setPending({...intent});setError('正在更新当前记录…');}
   else{if(failure instanceof OperationsRequestError&&[401,403].includes(failure.status))secret.current=null;setError(failure instanceof OperationsRequestError&&[401,403].includes(failure.status)?'当前无法读取这次处理的结果。':attempt>=2?'连接暂时中断，系统正在恢复。':'');}
  }finally{
   if(active.current===controller){active.current=null;inFlight.current=false;if(alive.current){setRequesting(false);setAttempt(value=>value+1);}}
  }
 },[attempt]);
 useLayoutEffect(()=>{alive.current=true;original.current=null;secret.current=null;setPending(null);setError('');setAttempt(0);return()=>{alive.current=false;active.current?.abort();active.current=null;original.current=null;secret.current=null;inFlight.current=false;};},[operatorId,csrfToken]);
 useLayoutEffect(()=>{if(!canRead)secret.current=null;},[canRead]);
 useEffect(()=>{
  const resume=()=>{if(document.visibilityState==='visible'&&navigator.onLine)setWakeup(value=>value+1);};
  window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);
  return()=>{window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);};
 },[]);
 useEffect(()=>{if(!pending||requesting||!canRead)return;const timer=setTimeout(()=>void run(),Math.min(10000,1500*2**Math.min(attempt,3)));return()=>clearTimeout(timer);},[pending,requesting,attempt,wakeup,run,canRead]);
 return {pending,requesting,error,locked:pending!==null,
  resume:(locator:SettingsPendingReceipt)=>{
   const path=settingsManagementReceiptPath(locator);if(!path||original.current||!latest.current.canRead)return;
   const intent:Intent={operationId:locator.operationId,owner:operatorId,csrfToken,path,targetOperatorId:locator.targetOperatorId??null,kind:locator.kind as Intent['kind'],body:{},recorded:true,readOnly:true};
   original.current=intent;secret.current=null;setPending(intent);setAttempt(0);setError('');void run();
  },
  submit:(input:Omit<Intent,'operationId'|'owner'|'csrfToken'|'recorded'|'readOnly'>,password?:string)=>{
   if(original.current||Object.hasOwn(input.body,'temporaryPassword'))return;
   const operationId=crypto.randomUUID(),intent:Intent={...input,body:{...structuredClone(input.body),operationId},operationId,owner:operatorId,csrfToken,recorded:false,readOnly:false};
   if(!latest.current.canSubmit(intent))return;
   original.current=intent;secret.current=password??null;setPending(intent);setAttempt(0);setError('');void run(true);
  }};
}

function Avatar({item,large=false}:{item:ManagementAccount;large?:boolean}){return <span className={'ma-avatar'+(large?' is-large':'')} aria-hidden="true">{managementAccountName(item).slice(0,1)}</span>;}
function AccountState({item}:{item:ManagementAccount}){return <span className="ma-state" data-state={item.lifecycle==='deleted'?'deleted':item.enabled===true?'enabled':item.enabled===false?'disabled':'unknown'}>{managementAccountState(item)}</span>;}
function Directory({value,selected,location,locked,loading,focusScope,focusReady,onSelect,onNavigate,pageHref,scrollRef,onScroll}:{value:ManagementAccountsPage|null;selected:string;location:ManagementAccountsLocation;locked:boolean;loading:boolean;focusScope:string|null;focusReady:boolean;onSelect:(id:string)=>void;onNavigate:(patch:Partial<ManagementAccountsLocation>)=>void;pageHref:(page:number)=>string;scrollRef:RefObject<HTMLDivElement|null>;onScroll:(position:number)=>void}){
 const page=value?.pagination;
 return <section className="ma-directory" aria-label="管理账户目录">
  <div className="ma-table-scroll" ref={scrollRef} onScroll={event=>onScroll(event.currentTarget.scrollTop)}><table><thead><tr><th>名称</th><th>登录名</th><th>账户类型</th><th>状态</th><th>业务角色</th><th>AI使用范围</th></tr></thead><tbody>{value?.items.map(item=><tr key={item.operatorId} className={item.operatorId===selected?'is-selected':undefined} aria-selected={item.operatorId===selected}>
   <th scope="row"><button type="button" className="ma-select" disabled={locked} onClick={()=>onSelect(item.operatorId)}><Avatar item={item}/><span>{managementAccountName(item)}</span></button></th><td>{item.username||'未取得'}</td><td>{managementAccountQualification(item)}</td><td><AccountState item={item}/></td><td>{item.businessRoles.filter(role=>role.enabled&&role.assignmentEnabled).map(role=>role.name).join('、')||'未分配'}</td><td>{item.enabled===false||item.lifecycle==='deleted'?'账户不可使用':managementAiLabel(item.aiUse?.domains)}</td>
  </tr>)}</tbody></table>{value&&!value.items.length&&<div className="ma-empty"><h2>{value.source.coverage==='complete-generation'?'没有符合条件的管理账户':'管理目录尚未就绪'}</h2><p>{value.source.coverage==='complete-generation'?'调整查询条件后再试。':'目录就绪后显示匹配账户。'}</p></div>}</div>
  <Pagination page={page?.page??location.page} pageSize={location.pageSize} pageSizeOptions={[20,50,100]} total={page?.matchingTotal??null} totalPages={page?.totalPages??null} hasPrevious={location.page>1} hasNext={page?.totalPages!==null&&page?.totalPages!==undefined&&location.page<page.totalPages} onPage={page=>onNavigate({page,operator:''})} onPageSize={size=>onNavigate({page:1,pageSize:size===100?100:size===50?50:20,operator:''})} pageHref={pageHref} loading={loading} disabled={locked} focusScope={focusScope} focusReady={focusReady} ariaLabel="管理账户分页" unitLabel="位"><label>排序<select value={location.sort} disabled={locked} onChange={event=>onNavigate({sort:event.target.value==='name-asc'?'name-asc':event.target.value==='created-asc'?'created-asc':'created-desc',page:1,operator:''})}><option value="created-desc">最近创建在前</option><option value="created-asc">最早创建在前</option><option value="name-asc">按名称</option></select></label></Pagination>
 </section>;
}

function RoleLink({id,name}:{id:string;name:string}){return <Link href={'/admin/operations/permissions?id='+encodeURIComponent(id)} prefetch={false}>{name}</Link>;}

function CreateForm({draft,password,locked,canSubmit,onChange,onPassword,onSubmit,onCancel}:{draft:ManagementCreateDraft;password:string;locked:boolean;canSubmit:boolean;onChange:(patch:Partial<ManagementCreateDraft>)=>void;onPassword:(value:string)=>void;onSubmit:()=>void;onCancel:()=>void}){
 return <form className="ma-form" onSubmit={event=>{event.preventDefault();onSubmit();}}><fieldset disabled={locked}><legend>新建成员</legend>
  <label>登录名<input autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={100} pattern={'[A-Za-z0-9][A-Za-z0-9._\\-]*'} value={draft.username} onChange={event=>onChange({username:event.target.value})}/></label>
  <div className="ma-form-grid"><label>姓<input autoComplete="off" maxLength={100} value={draft.lastName} onChange={event=>onChange({lastName:event.target.value})}/></label><label>名<input autoComplete="off" maxLength={100} value={draft.firstName} onChange={event=>onChange({firstName:event.target.value})}/></label></div>
  <label>临时密码<input type="password" autoComplete="new-password" maxLength={4096} required value={password} onChange={event=>onPassword(event.target.value)}/></label><p className="ma-note">首次登录必须修改密码。</p>
  <label>管理备注<textarea maxLength={1000} value={draft.note} onChange={event=>onChange({note:event.target.value})}/></label>
  <div className="ma-actions"><button type="submit" className="ma-primary" disabled={!canSubmit}>创建成员</button><button type="button" onClick={onCancel}>取消</button></div>
 </fieldset></form>;
}

function RolesPanel({roles,assignments,addable,choice,locked,canAssign,canViewRoles,onChoice,onAssign,onRevoke,impact,children}:{roles:ManagementAssignableRole[];assignments:ManagementAssignment[];addable:ManagementAssignableRole[];choice:string;locked:boolean;canAssign:boolean;canViewRoles:boolean;onChoice:(id:string)=>void;onAssign:()=>void;onRevoke:(assignment:ManagementAssignment)=>void;impact:(roleId:string)=>ReactNode;children?:ReactNode}){
 const active=assignments.filter(item=>item.enabled);
 return <section className="ma-panel"><header><h3>已分配角色</h3>{canViewRoles&&<Link href="/admin/operations/permissions" prefetch={false}>管理业务角色</Link>}</header>
  {active.length?<ul className="ma-roles">{active.map(assignment=>{const role=roles.find(item=>item.id===assignment.roleId);return <li key={assignment.id}><div><strong>{role?canViewRoles?<RoleLink id={role.id} name={role.name}/>:role.name:'角色名称未取得'}</strong><p>{role?role.enabled?'启用中':'角色已停用':'角色状态未取得'}{role?.enabled?' · AI使用：'+managementAiLabel(managementRoleAiDomains(role.permissions)):''}</p>{role?.description&&<p>{role.description}</p>}{canAssign&&impact(assignment.roleId)}</div>{canAssign&&<button type="button" className="ma-danger" disabled={locked} onClick={()=>onRevoke(assignment)}>撤回</button>}</li>;})}</ul>:<p className="ma-muted">尚未分配业务角色。</p>}
  {canAssign&&<form className="ma-assignment" onSubmit={event=>{event.preventDefault();onAssign();}}><AccountRolePicker roles={addable} value={choice} disabled={locked} onChange={onChoice}/><button className="ma-primary" type="submit" disabled={locked||!addable.some(role=>role.id===choice)}>分配</button></form>}
  {children}
 </section>;
}

function AiUsePanel({domains,root,enabled,sources,locked,canAssign,onRoles}:{domains:ManagementAccount['aiUse']['domains']|null;root:boolean;enabled:boolean;sources:Readonly<Record<string,readonly string[]>>;locked:boolean;canAssign:boolean;onRoles?:()=>void}){
 return <section className="ma-panel"><header><h3>AI使用权限</h3>{!root&&onRoles&&<button type="button" disabled={locked} onClick={onRoles}>{canAssign?'调整角色分配':'查看业务角色'}</button>}</header><p>{enabled?'可使用：'+managementAiLabel(domains):'账户当前不可使用 AI'}</p>
  <table className="ma-ai-table"><thead><tr><th>AI</th><th>范围</th><th>来源</th></tr></thead><tbody>{managementAiDomains.map(item=>{const assigned=domains?.includes(item.id);return <tr key={item.id}><td>{item.label}</td><td>{domains===null?'尚未取得':assigned?enabled?'已开放':'账户不可使用':'未授予'}</td><td>{assigned?root?'根管理员':sources[item.id]?.join('、')||'来源未取得':'—'}</td></tr>;})}</tbody></table>
  <p className="ma-muted">{root?'根管理员使用全部 AI。':'使用范围由有效业务角色提供。'}</p>
 </section>;
}

function PermissionList({permissions,sources}:{permissions:readonly string[];sources:Readonly<Record<string,readonly string[]>>}){
 return permissions.length?<ul className="ma-permissions">{permissions.map(code=><li key={code}>{operatorPermissionLabel(code)}<small>{sources[code]?.join('、')||'来源未取得'}</small></li>)}</ul>:<p className="ma-muted">尚无有效业务权限。</p>;
}

function ActionForm({draft,password,locked,changed,canSubmit,onChange,onPassword,onSubmit,onCancel}:{draft:ManagementActionDraft;password:string;locked:boolean;changed:boolean;canSubmit:boolean;onChange:(patch:Partial<ManagementActionDraft>)=>void;onPassword:(value:string)=>void;onSubmit:()=>void;onCancel:()=>void}){
 const label=draft.kind==='admission-change'?draft.action==='promote'?'设为管理员':'改为成员':managementCommandLabels[draft.kind];
 return <form className="ma-form" onSubmit={event=>{event.preventDefault();onSubmit();}}><fieldset disabled={locked}><legend>{label}</legend><p className="ma-note">{managementCommandImpacts[draft.kind]}</p>
  {changed&&<p className="galaxy-error" role="status">账户已有更新，请取消后按当前资料重新选择操作。填写的说明仍保留。</p>}
  {draft.kind==='password-reset'&&<label>新临时密码<input type="password" autoComplete="new-password" required maxLength={4096} value={password} onChange={event=>onPassword(event.target.value)}/></label>}
  {draft.kind==='email-change'&&<label>新邮箱<input type="email" autoComplete="off" required maxLength={320} value={draft.newEmail} onChange={event=>onChange({newEmail:event.target.value})}/></label>}
  <label>处理说明<span className="ma-muted">选填</span><textarea maxLength={1000} value={draft.reason} onChange={event=>onChange({reason:event.target.value})}/></label>
  {draft.kind==='delete'&&<label className="ma-check"><input type="checkbox" checked={draft.confirmed} onChange={event=>onChange({confirmed:event.target.checked})}/>删除该账户的登录身份，保留历史关联</label>}
  <div className="ma-actions"><button type="submit" className={draft.kind==='delete'||draft.kind==='login-disable'?'ma-danger':'ma-primary'} disabled={!canSubmit||changed}>{label}</button><button type="button" onClick={onCancel}>取消</button></div>
 </fieldset></form>;
}

function ProfileForm({draft,current,choices,locked,canSubmit,onChange,onChoice,onSubmit,onCancel}:{draft:ManagementProfileDraft;current:ManagementAccountDetail;choices:Partial<Record<'firstName'|'lastName'|'note','mine'|'current'>>;locked:boolean;canSubmit:boolean;onChange:(patch:Partial<ManagementProfileDraft>)=>void;onChoice:(field:'firstName'|'lastName'|'note',choice:'mine'|'current')=>void;onSubmit:()=>void;onCancel:()=>void}){
 const merge=managementProfileMerge(draft,{...current.identity,note:current.profile.note,targetVersion:current.targetVersion},choices);
 return <form className="ma-form" onSubmit={event=>{event.preventDefault();onSubmit();}}><fieldset disabled={locked}><legend>编辑资料</legend>
  <div className="ma-form-grid"><label>姓<input maxLength={100} autoComplete="off" value={draft.lastName} onChange={event=>onChange({lastName:event.target.value})}/></label><label>名<input maxLength={100} autoComplete="off" value={draft.firstName} onChange={event=>onChange({firstName:event.target.value})}/></label></div>
  <label>管理备注<textarea maxLength={1000} value={draft.note} onChange={event=>onChange({note:event.target.value})}/></label>
  {merge.conflicts.length>0&&<section className="ma-impact"><h3>资料已有其他修改</h3>{merge.conflicts.map(conflict=><label key={conflict.field}>{conflict.label}<span>我的修改：{conflict.mine||'空白'}；当前资料：{conflict.current||'空白'}</span><select value={choices[conflict.field]??''} onChange={event=>{const value=event.target.value;if(value==='mine'||value==='current')onChoice(conflict.field,value);}}><option value="">选择保留内容</option><option value="mine">保留我的修改</option><option value="current">使用当前资料</option></select></label>)}</section>}
  <label>修改说明<span className="ma-muted">选填</span><textarea maxLength={1000} value={draft.reason} onChange={event=>onChange({reason:event.target.value})}/></label>
  <div className="ma-actions"><button type="submit" className="ma-primary" disabled={!canSubmit||!merge.ready}>保存资料</button><button type="button" onClick={onCancel}>取消</button></div>
 </fieldset></form>;
}

function Receipt({value}:{value:ManagementCommandReceipt}){
 return <section className="ma-receipt" role="status"><p>{managementReceiptLabel(value)}</p>{value.result?.phases.length?<dl className="ma-facts">{value.result.phases.map((phase,index)=><div className="ma-effect" key={phase.kind+':'+index}><dt>{managementPhaseLabels[phase.kind]}</dt><dd>{managementPhaseStates[phase.state]}{phase.revokedSessions!==undefined?' · '+phase.revokedSessions+' 个会话':''}{phase.code&&<span className="ma-muted"> · {managementAccountErrors[phase.code]??'请稍后查看处理结果。'}</span>}</dd></div>)}</dl>:null}</section>;
}

function History({items}:{items:ManagementHistory['items']}){
 return items.length?<ol className="ma-history">{items.map(item=><li key={item.operationId}><header><strong>{managementCommandLabels[item.kind]}</strong><span>{managementAccountDate(item.recordedAt)}</span></header><p><HistoryOperator id={item.operatorId} name={item.operatorDisplayName}/></p>{item.reason&&<p>{item.reason}</p>}<Receipt value={{...item,checkedAt:0,readExpiresAt:0,metadataOnly:true,replayed:true}}/></li>)}</ol>:<p className="ma-muted">暂无管理账户处理记录。</p>;
}

function AssignmentImpact({detail,roleId,enabled}:{detail:ManagementAccountDetail;roleId:string;enabled:boolean}){
 if(detail.effective.state!=='available')return <p className="ma-muted">账户当前不可使用，权限生效情况按当前状态核对。</p>;
 const impact=managementAssignmentImpact(detail,roleId,enabled);
 if(impact.state!=='available')return <p className="ma-muted">权限来源正在更新，暂不能预览变化。</p>;
 const {added,removed}=impact,after=new Set(impact.after),aiAdded=managementRoleAiDomains(added),aiRemoved=managementRoleAiDomains(removed);
 return <div className="ma-impact"><p>预计{enabled?'分配':'撤回'}后：{added.length?'新增 '+added.length+' 项权限':''}{added.length&&removed.length?'；':''}{removed.length?'移除 '+removed.length+' 项权限':''}{!added.length&&!removed.length?'有效权限保持不变':''}。</p>{aiAdded.length>0&&<p>新增 AI 使用：{managementAiLabel(aiAdded)}</p>}{aiRemoved.length>0&&<p>移除 AI 使用：{managementAiLabel(aiRemoved)}</p>}{!enabled&&managementAiDomains.some(item=>after.has('ai.use.'+item.id))&&<p>其他有效角色仍提供：{managementAiLabel(managementRoleAiDomains([...after]))}</p>}</div>;
}

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
