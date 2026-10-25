'use client';

import {useLayoutEffect,useRef} from 'react';
import type {RefObject} from 'react';
import {permissionFilterItems,permissionGroups,permissionScopeState,personPermissionSources} from '../lib/permissions-view-model';
import type {PermissionFilter} from '../lib/permissions-view-model';
import type {BusinessRole,ManagementPerson,PermissionAction} from './permissions-types';
import {AdminIcon} from './AdminIcons';

function ScopeCheckbox({checked,indeterminate,disabled,label,onChange}:{checked:boolean;indeterminate:boolean;disabled?:boolean;label:string;onChange:()=>void}){
 const ref=useRef<HTMLInputElement|null>(null);useLayoutEffect(()=>{if(ref.current)ref.current.indeterminate=indeterminate;},[indeterminate]);
 return <input ref={ref} type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={onChange}/>;
}

export function PermissionMatrix({catalog,selected,filter,onFilter,editing=false,disabled=false,onToggle,onScope,grantable,automatic=false,person,roles=[],contentRef,onScroll,focusScope}:{catalog:PermissionAction[];selected:readonly string[];filter:PermissionFilter;onFilter:(patch:Partial<PermissionFilter>)=>void;editing?:boolean;disabled?:boolean;onToggle?:(code:string)=>void;onScope?:(items:PermissionAction[],action:'all'|'clear'|'invert')=>void;grantable?:ReadonlySet<string>;automatic?:boolean;person?:ManagementPerson;roles?:BusinessRole[];contentRef?:RefObject<HTMLDivElement|null>;onScroll?:(top:number)=>void;focusScope:string}){
 const picked=new Set(selected),visible=permissionFilterItems(catalog,selected,filter),scope=permissionScopeState(visible,selected,grantable,automatic);
 const panelRef=useRef<HTMLDivElement|null>(null),selectedFilterRef=useRef<HTMLInputElement|null>(null);
 const removedFocus=useRef<{element:HTMLInputElement;index:number;context:string}|null>(null);
 const focusContext=JSON.stringify([focusScope,filter.query,filter.group,filter.selectedOnly,editing,disabled,automatic,catalog.map(item=>[item.code,item.humanOnly===true]),grantable?[...grantable].sort():null]);
 useLayoutEffect(()=>{
  const previous=removedFocus.current;if(!previous)return;removedFocus.current=null;
  if(previous.context!==focusContext||previous.element.isConnected||!filter.selectedOnly||!editing||disabled)return;
  if(document.activeElement!==document.body&&document.activeElement!==previous.element)return;
  const remaining=panelRef.current?.querySelectorAll<HTMLInputElement>('.galaxy-permissions-check input:not(:disabled)');
  const target=remaining?.length?remaining[Math.min(previous.index,remaining.length-1)]:selectedFilterRef.current;
  if(target&&!target.disabled)target.focus({preventScroll:true});
 },[selected,focusContext,filter.selectedOnly,editing,disabled]);
 function toggleFocused(item:PermissionAction,element:HTMLInputElement){
  removedFocus.current=null;
  if(filter.selectedOnly&&picked.has(item.code)&&document.activeElement===element){
   const inputs=[...panelRef.current!.querySelectorAll<HTMLInputElement>('.galaxy-permissions-check input:not(:disabled)')];
   removedFocus.current={element,index:Math.max(0,inputs.indexOf(element)),context:focusContext};
  }
  onToggle?.(item.code);
 }
 return <div className="galaxy-permissions-matrix-panel" ref={panelRef}><div className="galaxy-permissions-matrix-tools">
  <label className="galaxy-permissions-permission-search"><AdminIcon name="search" size={14}/><input value={filter.query} disabled={disabled} placeholder="查找权限或功能" aria-label="查找权限或功能" onChange={event=>onFilter({query:event.target.value})}/></label>
  <label className="galaxy-permissions-group-filter"><span>功能组</span><select aria-label="定位功能组" value={filter.group} disabled={disabled} onChange={event=>onFilter({group:event.target.value})}><option value="">全部功能组</option>{permissionGroups(catalog).map(group=><option key={group.id} value={group.id}>{group.label}</option>)}</select></label>
  <label className="galaxy-permissions-selected-filter"><input ref={selectedFilterRef} type="checkbox" checked={filter.selectedOnly} disabled={disabled} onChange={event=>onFilter({selectedOnly:event.target.checked})}/>{person?'仅已授权':'仅已选'}</label>
 </div>{editing&&<div className="galaxy-permissions-scope-tools"><label><ScopeCheckbox checked={scope.checked} indeterminate={scope.indeterminate} disabled={disabled||!scope.canInvert} label="全选当前结果中的可选权限" onChange={()=>onScope?.(visible,scope.canSelect?'all':'clear')}/><span>当前结果 {scope.total} 项 · 已选 {scope.selectedCount} 项</span></label><button type="button" disabled={disabled||!scope.canSelect} onClick={()=>onScope?.(visible,'all')}>全选可选权限</button><button type="button" disabled={disabled||!scope.canClear} onClick={()=>onScope?.(visible,'clear')}>清空结果</button><button type="button" disabled={disabled||!scope.canInvert} onClick={()=>onScope?.(visible,'invert')}>反选结果</button></div>}
 {editing&&<p className="galaxy-permissions-read-status galaxy-permissions-muted">仅作用于当前结果，筛选外的勾选会保留。</p>}
 <div className="galaxy-permissions-matrix-content" ref={contentRef} onScroll={event=>onScroll?.(event.currentTarget.scrollTop)}><table className="galaxy-permissions-matrix"><thead><tr><th>功能模块</th><th>具体操作</th><th>{person?'当前权限':'权限配置'}</th>{person&&<th>权限来源</th>}</tr></thead><tbody>{permissionGroups(visible).flatMap(group=>group.items.map((item,index)=>{
  const source=person?personPermissionSources(person,item.code,roles):null;
  const blocked=disabled||automatic&&item.humanOnly&&!picked.has(item.code)||!!grantable&&!grantable.has(item.code)&&!picked.has(item.code);
  const groupScope=permissionScopeState(group.items,selected,grantable,automatic);
  return <tr key={item.code}>{index===0&&<th scope="rowgroup" rowSpan={group.items.length}><div className="galaxy-permissions-group-title">{editing&&<ScopeCheckbox checked={groupScope.checked} indeterminate={groupScope.indeterminate} disabled={disabled||!groupScope.canInvert} label={group.label+' · 全选本组可选权限'} onChange={()=>onScope?.(group.items,groupScope.canSelect?'all':'clear')}/>}<span>{group.label}</span></div>{editing&&<div className="galaxy-permissions-group-actions"><span>已选 {groupScope.selectedCount}/{groupScope.total} 项</span><button type="button" disabled={disabled||!groupScope.canClear} aria-label={group.label+' · 清空本组结果'} onClick={()=>onScope?.(group.items,'clear')}>清空</button><button type="button" disabled={disabled||!groupScope.canInvert} aria-label={group.label+' · 反选本组结果'} onClick={()=>onScope?.(group.items,'invert')}>反选</button></div>}</th>}<td><span>{item.label}</span>{item.sensitive&&<small className="galaxy-permissions-sensitive">敏感读取／处理</small>}{item.humanOnly&&<small className="galaxy-permissions-human">须人工</small>}</td><td>{person?<span className="galaxy-permissions-access" data-state={source?.state}>{source?.state==='granted'?<><AdminIcon name="check" size={14}/>已授权</>:source?.state==='denied'?'未授权':'未确认'}</span>:editing?<label className="galaxy-permissions-check"><input type="checkbox" checked={picked.has(item.code)} disabled={blocked} onChange={event=>toggleFocused(item,event.currentTarget)} aria-label={item.groupLabel+' · '+item.label}/><span>{picked.has(item.code)?'已选':'未选'}</span></label>:<span className="galaxy-permissions-access" data-state={picked.has(item.code)?'granted':'denied'}>{picked.has(item.code)?<><AdminIcon name="check" size={14}/>已配置</>:'未配置'}</span>}</td>{person&&<td className="galaxy-permissions-source">{source?.labels.join('、')||'—'}</td>}</tr>;
 }))}</tbody></table>{!visible.length&&<p className="galaxy-permissions-matrix-empty">没有匹配的权限。</p>}</div></div>;
}
