'use client';

import {type ReactNode,type RefObject} from 'react';
import Link from 'next/link';
import {Pagination} from '../Pagination';
import {HistoryOperator} from '../HistoryOperator';
import {AccountRolePicker} from '../AccountRolePicker';
import {operatorPermissionLabel} from '../../lib/access';
import {managementAccountDate,managementAccountErrors,managementAccountName,managementAccountQualification,managementAccountState,managementAiDomains,managementAiLabel,managementAssignmentImpact,managementCommandImpacts,managementCommandLabels,managementPhaseLabels,managementPhaseStates,managementProfileMerge,managementReceiptLabel,managementRoleAiDomains} from "../../lib/management-accounts/management-accounts-view-model";
import type {ManagementAccount,ManagementAccountDetail,ManagementAccountsLocation,ManagementAccountsPage,ManagementActionDraft,ManagementAssignableRole,ManagementAssignment,ManagementCommandReceipt,ManagementCreateDraft,ManagementHistory,ManagementProfileDraft} from "./management-accounts-types";

export function Avatar({item,large=false}:{item:ManagementAccount;large?:boolean}){return <span className={'ma-avatar'+(large?' is-large':'')} aria-hidden="true">{managementAccountName(item).slice(0,1)}</span>;}
export function AccountState({item}:{item:ManagementAccount}){return <span className="ma-state" data-state={item.lifecycle==='deleted'?'deleted':item.enabled===true?'enabled':item.enabled===false?'disabled':'unknown'}>{managementAccountState(item)}</span>;}
export function Directory({value,selected,location,locked,loading,focusScope,focusReady,onSelect,onNavigate,pageHref,scrollRef,onScroll}:{value:ManagementAccountsPage|null;selected:string;location:ManagementAccountsLocation;locked:boolean;loading:boolean;focusScope:string|null;focusReady:boolean;onSelect:(id:string)=>void;onNavigate:(patch:Partial<ManagementAccountsLocation>)=>void;pageHref:(page:number)=>string;scrollRef:RefObject<HTMLDivElement|null>;onScroll:(position:number)=>void}){
 const page=value?.pagination;
 return <section className="ma-directory" aria-label="管理账户目录">
  <div className="ma-table-scroll" ref={scrollRef} onScroll={event=>onScroll(event.currentTarget.scrollTop)}><table><thead><tr><th>名称</th><th>登录名</th><th>账户类型</th><th>状态</th><th>业务角色</th><th>AI使用范围</th></tr></thead><tbody>{value?.items.map(item=><tr key={item.operatorId} className={item.operatorId===selected?'is-selected':undefined} aria-selected={item.operatorId===selected}>
   <th scope="row"><button type="button" className="ma-select" disabled={locked} onClick={()=>onSelect(item.operatorId)}><Avatar item={item}/><span>{managementAccountName(item)}</span></button></th><td>{item.username||'未取得'}</td><td>{managementAccountQualification(item)}</td><td><AccountState item={item}/></td><td>{item.businessRoles.filter(role=>role.enabled&&role.assignmentEnabled).map(role=>role.name).join('、')||'未分配'}</td><td>{item.enabled===false||item.lifecycle==='deleted'?'账户不可使用':managementAiLabel(item.aiUse?.domains)}</td>
  </tr>)}</tbody></table>{value&&!value.items.length&&<div className="ma-empty"><h2>{value.source.coverage==='complete-generation'?'没有符合条件的管理账户':'管理目录尚未就绪'}</h2><p>{value.source.coverage==='complete-generation'?'调整查询条件后再试。':'目录就绪后显示匹配账户。'}</p></div>}</div>
  <Pagination page={page?.page??location.page} pageSize={location.pageSize} pageSizeOptions={[20,50,100]} total={page?.matchingTotal??null} totalPages={page?.totalPages??null} hasPrevious={location.page>1} hasNext={page?.totalPages!==null&&page?.totalPages!==undefined&&location.page<page.totalPages} onPage={page=>onNavigate({page,operator:''})} onPageSize={size=>onNavigate({page:1,pageSize:size===100?100:size===50?50:20,operator:''})} pageHref={pageHref} loading={loading} disabled={locked} focusScope={focusScope} focusReady={focusReady} ariaLabel="管理账户分页" unitLabel="位"><label>排序<select value={location.sort} disabled={locked} onChange={event=>onNavigate({sort:event.target.value==='name-asc'?'name-asc':event.target.value==='created-asc'?'created-asc':'created-desc',page:1,operator:''})}><option value="created-desc">最近创建在前</option><option value="created-asc">最早创建在前</option><option value="name-asc">按名称</option></select></label></Pagination>
 </section>;
}

function RoleLink({id,name}:{id:string;name:string}){return <Link href={'/admin/operations/permissions?id='+encodeURIComponent(id)} prefetch={false}>{name}</Link>;}

export function CreateForm({draft,password,locked,canSubmit,onChange,onPassword,onSubmit,onCancel}:{draft:ManagementCreateDraft;password:string;locked:boolean;canSubmit:boolean;onChange:(patch:Partial<ManagementCreateDraft>)=>void;onPassword:(value:string)=>void;onSubmit:()=>void;onCancel:()=>void}){
 return <form className="ma-form" onSubmit={event=>{event.preventDefault();onSubmit();}}><fieldset disabled={locked}><legend>新建成员</legend>
  <label>登录名<input autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={100} pattern={'[A-Za-z0-9][A-Za-z0-9._\\-]*'} value={draft.username} onChange={event=>onChange({username:event.target.value})}/></label>
  <div className="ma-form-grid"><label>姓<input autoComplete="off" maxLength={100} value={draft.lastName} onChange={event=>onChange({lastName:event.target.value})}/></label><label>名<input autoComplete="off" maxLength={100} value={draft.firstName} onChange={event=>onChange({firstName:event.target.value})}/></label></div>
  <label>临时密码<input type="password" autoComplete="new-password" maxLength={4096} required value={password} onChange={event=>onPassword(event.target.value)}/></label><p className="ma-note">首次登录必须修改密码。</p>
  <label>管理备注<textarea maxLength={1000} value={draft.note} onChange={event=>onChange({note:event.target.value})}/></label>
  <div className="ma-actions"><button type="submit" className="ma-primary" disabled={!canSubmit}>创建成员</button><button type="button" onClick={onCancel}>取消</button></div>
 </fieldset></form>;
}

export function RolesPanel({roles,assignments,addable,choice,locked,canAssign,canViewRoles,onChoice,onAssign,onRevoke,impact,children}:{roles:ManagementAssignableRole[];assignments:ManagementAssignment[];addable:ManagementAssignableRole[];choice:string;locked:boolean;canAssign:boolean;canViewRoles:boolean;onChoice:(id:string)=>void;onAssign:()=>void;onRevoke:(assignment:ManagementAssignment)=>void;impact:(roleId:string)=>ReactNode;children?:ReactNode}){
 const active=assignments.filter(item=>item.enabled);
 return <section className="ma-panel"><header><h3>已分配角色</h3>{canViewRoles&&<Link href="/admin/operations/permissions" prefetch={false}>管理业务角色</Link>}</header>
  {active.length?<ul className="ma-roles">{active.map(assignment=>{const role=roles.find(item=>item.id===assignment.roleId);return <li key={assignment.id}><div><strong>{role?canViewRoles?<RoleLink id={role.id} name={role.name}/>:role.name:'角色名称未取得'}</strong><p>{role?role.enabled?'启用中':'角色已停用':'角色状态未取得'}{role?.enabled?' · AI使用：'+managementAiLabel(managementRoleAiDomains(role.permissions)):''}</p>{role?.description&&<p>{role.description}</p>}{canAssign&&impact(assignment.roleId)}</div>{canAssign&&<button type="button" className="ma-danger" disabled={locked} onClick={()=>onRevoke(assignment)}>撤回</button>}</li>;})}</ul>:<p className="ma-muted">尚未分配业务角色。</p>}
  {canAssign&&<form className="ma-assignment" onSubmit={event=>{event.preventDefault();onAssign();}}><AccountRolePicker roles={addable} value={choice} disabled={locked} onChange={onChoice}/><button className="ma-primary" type="submit" disabled={locked||!addable.some(role=>role.id===choice)}>分配</button></form>}
  {children}
 </section>;
}

export function AiUsePanel({domains,root,enabled,sources,locked,canAssign,onRoles}:{domains:ManagementAccount['aiUse']['domains']|null;root:boolean;enabled:boolean;sources:Readonly<Record<string,readonly string[]>>;locked:boolean;canAssign:boolean;onRoles?:()=>void}){
 return <section className="ma-panel"><header><h3>AI使用权限</h3>{!root&&onRoles&&<button type="button" disabled={locked} onClick={onRoles}>{canAssign?'调整角色分配':'查看业务角色'}</button>}</header><p>{enabled?'可使用：'+managementAiLabel(domains):'账户当前不可使用 AI'}</p>
  <table className="ma-ai-table"><thead><tr><th>AI</th><th>范围</th><th>来源</th></tr></thead><tbody>{managementAiDomains.map(item=>{const assigned=domains?.includes(item.id);return <tr key={item.id}><td>{item.label}</td><td>{domains===null?'尚未取得':assigned?enabled?'已开放':'账户不可使用':'未授予'}</td><td>{assigned?root?'根管理员':sources[item.id]?.join('、')||'来源未取得':'—'}</td></tr>;})}</tbody></table>
  <p className="ma-muted">{root?'根管理员使用全部 AI。':'使用范围由有效业务角色提供。'}</p>
 </section>;
}

export function PermissionList({permissions,sources}:{permissions:readonly string[];sources:Readonly<Record<string,readonly string[]>>}){
 return permissions.length?<ul className="ma-permissions">{permissions.map(code=><li key={code}>{operatorPermissionLabel(code)}<small>{sources[code]?.join('、')||'来源未取得'}</small></li>)}</ul>:<p className="ma-muted">尚无有效业务权限。</p>;
}

export function ActionForm({draft,password,locked,changed,canSubmit,onChange,onPassword,onSubmit,onCancel}:{draft:ManagementActionDraft;password:string;locked:boolean;changed:boolean;canSubmit:boolean;onChange:(patch:Partial<ManagementActionDraft>)=>void;onPassword:(value:string)=>void;onSubmit:()=>void;onCancel:()=>void}){
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

export function ProfileForm({draft,current,choices,locked,canSubmit,onChange,onChoice,onSubmit,onCancel}:{draft:ManagementProfileDraft;current:ManagementAccountDetail;choices:Partial<Record<'firstName'|'lastName'|'note','mine'|'current'>>;locked:boolean;canSubmit:boolean;onChange:(patch:Partial<ManagementProfileDraft>)=>void;onChoice:(field:'firstName'|'lastName'|'note',choice:'mine'|'current')=>void;onSubmit:()=>void;onCancel:()=>void}){
 const merge=managementProfileMerge(draft,{...current.identity,note:current.profile.note,targetVersion:current.targetVersion},choices);
 return <form className="ma-form" onSubmit={event=>{event.preventDefault();onSubmit();}}><fieldset disabled={locked}><legend>编辑资料</legend>
  <div className="ma-form-grid"><label>姓<input maxLength={100} autoComplete="off" value={draft.lastName} onChange={event=>onChange({lastName:event.target.value})}/></label><label>名<input maxLength={100} autoComplete="off" value={draft.firstName} onChange={event=>onChange({firstName:event.target.value})}/></label></div>
  <label>管理备注<textarea maxLength={1000} value={draft.note} onChange={event=>onChange({note:event.target.value})}/></label>
  {merge.conflicts.length>0&&<section className="ma-impact"><h3>资料已有其他修改</h3>{merge.conflicts.map(conflict=><label key={conflict.field}>{conflict.label}<span>我的修改：{conflict.mine||'空白'}；当前资料：{conflict.current||'空白'}</span><select value={choices[conflict.field]??''} onChange={event=>{const value=event.target.value;if(value==='mine'||value==='current')onChoice(conflict.field,value);}}><option value="">选择保留内容</option><option value="mine">保留我的修改</option><option value="current">使用当前资料</option></select></label>)}</section>}
  <label>修改说明<span className="ma-muted">选填</span><textarea maxLength={1000} value={draft.reason} onChange={event=>onChange({reason:event.target.value})}/></label>
  <div className="ma-actions"><button type="submit" className="ma-primary" disabled={!canSubmit||!merge.ready}>保存资料</button><button type="button" onClick={onCancel}>取消</button></div>
 </fieldset></form>;
}

export function Receipt({value}:{value:ManagementCommandReceipt}){
 return <section className="ma-receipt" role="status"><p>{managementReceiptLabel(value)}</p>{value.result?.phases.length?<dl className="ma-facts">{value.result.phases.map((phase,index)=><div className="ma-effect" key={phase.kind+':'+index}><dt>{managementPhaseLabels[phase.kind]}</dt><dd>{managementPhaseStates[phase.state]}{phase.revokedSessions!==undefined?' · '+phase.revokedSessions+' 个会话':''}{phase.code&&<span className="ma-muted"> · {managementAccountErrors[phase.code]??'请稍后查看处理结果。'}</span>}</dd></div>)}</dl>:null}</section>;
}

export function History({items}:{items:ManagementHistory['items']}){
 return items.length?<ol className="ma-history">{items.map(item=><li key={item.operationId}><header><strong>{managementCommandLabels[item.kind]}</strong><span>{managementAccountDate(item.recordedAt)}</span></header><p><HistoryOperator id={item.operatorId} name={item.operatorDisplayName}/></p>{item.reason&&<p>{item.reason}</p>}<Receipt value={{...item,checkedAt:0,readExpiresAt:0,metadataOnly:true,replayed:true}}/></li>)}</ol>:<p className="ma-muted">暂无管理账户处理记录。</p>;
}

export function AssignmentImpact({detail,roleId,enabled}:{detail:ManagementAccountDetail;roleId:string;enabled:boolean}){
 if(detail.effective.state!=='available')return <p className="ma-muted">账户当前不可使用，权限生效情况按当前状态核对。</p>;
 const impact=managementAssignmentImpact(detail,roleId,enabled);
 if(impact.state!=='available')return <p className="ma-muted">权限来源正在更新，暂不能预览变化。</p>;
 const {added,removed}=impact,after=new Set(impact.after),aiAdded=managementRoleAiDomains(added),aiRemoved=managementRoleAiDomains(removed);
 return <div className="ma-impact"><p>预计{enabled?'分配':'撤回'}后：{added.length?'新增 '+added.length+' 项权限':''}{added.length&&removed.length?'；':''}{removed.length?'移除 '+removed.length+' 项权限':''}{!added.length&&!removed.length?'有效权限保持不变':''}。</p>{aiAdded.length>0&&<p>新增 AI 使用：{managementAiLabel(aiAdded)}</p>}{aiRemoved.length>0&&<p>移除 AI 使用：{managementAiLabel(aiRemoved)}</p>}{!enabled&&managementAiDomains.some(item=>after.has('ai.use.'+item.id))&&<p>其他有效角色仍提供：{managementAiLabel(managementRoleAiDomains([...after]))}</p>}</div>;
}
