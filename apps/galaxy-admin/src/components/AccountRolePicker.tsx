'use client';

import './account-role-picker.css';

export type AccountRoleOption={id:string;name:string;description:string;enabled:boolean;permissions:readonly string[];canAssign:boolean;assignmentReason?:'role-disabled'|'assignment-denied'|'exceeds-permissions'|null};
function unavailable(role:AccountRoleOption){return !role.enabled?'已停用':role.assignmentReason==='exceeds-permissions'?'超出你的可授予权限':role.assignmentReason==='assignment-denied'?'无角色分配权限':!role.canAssign?'当前不可分配':'';}
/** Edits one role selection only. Human and AI pages retain their own current
 * authorization, target, ledger and command submission. */
export function AccountRolePicker({roles,value,onChange,disabled=false,label='分配角色'}:{roles:readonly AccountRoleOption[];value:string;onChange:(id:string)=>void;disabled?:boolean;label?:string}){
 const selected=roles.find(role=>role.id===value);
 return <label className="account-role-picker"><span>{label}</span><select value={value} disabled={disabled||!roles.length} onChange={event=>{const id=event.target.value;onChange(id);}}>
  <option value="">{roles.length?'选择已有业务角色':'暂无可分配角色'}</option>
  {roles.map(role=><option key={role.id} value={role.id} disabled={!role.enabled||!role.canAssign}>{role.name}{unavailable(role)?'（'+unavailable(role)+'）':''}</option>)}
 </select>{selected&&<small>{selected.description?selected.description+' · ':''}{selected.permissions.length} 项权限{unavailable(selected)?' · '+unavailable(selected):''}</small>}</label>;
}
