import type {ManagementAccount,ManagementAccountDetail,ManagementAccountTab,ManagementAccountsLocation,ManagementAccountsPage,ManagementAiDomain,ManagementAssignment,ManagementCommandKind,ManagementCommandReceipt,ManagementPhaseKind,ManagementProfileDraft} from '../components/management-accounts-types';
import type {AssignmentSave,PermissionOperationRead} from '../components/permissions-types';
import {requiresManagementMaintainer} from '../../../../packages/galaxy-official/src/shared/operations-management-maintainer-actions.mjs';

export const managementAccountsRoute='/admin/operations/management-accounts';
export const managementAccountsBase='/v1/operations/management-accounts';
export const managementAccountTabs:ReadonlyArray<{id:ManagementAccountTab;label:string}>=[
 {id:'overview',label:'账户概况'},{id:'roles',label:'业务角色'},{id:'ai',label:'AI使用'},{id:'history',label:'处理记录'},
];
export const managementAiDomains:ReadonlyArray<{id:ManagementAiDomain;label:string}>=[
 {id:'overview',label:'总控 AI'},{id:'governance',label:'治理 AI'},{id:'messaging',label:'消息 AI'},{id:'discovery',label:'数据与发现 AI'},{id:'maintenance',label:'运维 AI'},
];
export const managementCommandLabels:Readonly<Record<ManagementCommandKind,string>>={create:'创建管理账户','profile-update':'保存资料','login-disable':'停用账户','login-restore':'恢复账户','password-reset':'重置临时密码','sessions-revoke':'撤销登录会话',delete:'删除管理账户','admission-change':'调整管理员资格','email-change':'验证新邮箱'};
export const managementCommandImpacts:Readonly<Record<Exclude<ManagementCommandKind,'create'|'profile-update'>,string>>={
 'login-disable':'停止此账户登录，并办理现有登录会话撤销；已发生的业务记录保留。',
 'login-restore':'恢复此账户登录，原业务角色按当前状态生效；不会恢复旧会话。',
 'password-reset':'设置本次临时密码；该账户下次登录必须修改。',
 'sessions-revoke':'结束此账户当前登录会话；本人仍可按当前登录条件重新登录。',
 delete:'删除此账户的登录身份，保留必要的历史关联。此操作不可恢复。',
 'admission-change':'变更后台管理资格；业务权限与可用 AI 仍来自已分配角色。',
 'email-change':'新邮箱验证完成后生效；账户与原角色保持关联。',
};
export const managementPhaseLabels:Readonly<Record<ManagementPhaseKind,string>>={'native-account':'登录账户','native-admission':'后台资格','local-principal':'管理资料','business-assignments':'业务角色','native-sessions':'认证登录会话','portal-sessions':'后台登录会话','email-verification':'新邮箱验证'};
export const managementPhaseStates={accepted:'已接收',confirmed:'已完成',submitted:'已提交',failed:'未完成',unknown:'结果尚未确定'} as const;
export const managementAccountErrors:Readonly<Record<string,string>>={
 invalid_management_accounts_request:'填写内容无效，请检查后再提交。',management_identity_target_changed:'账户已有更新，请按当前资料继续。',management_operation_conflict:'这次处理与已提交的内容不一致。',management_username_conflict:'登录名已存在，请换一个登录名。',
 management_password_policy_rejected:'临时密码不符合当前密码要求，请重新设置。',management_root_protected:'根管理员的登录身份受保护，不能进行此项操作。',management_root_only:'这项操作仅根管理员可以办理。',management_self_protected:'不能停用或删除当前登录账户。',
 management_writer_not_configured:'账户维护暂未接通。',management_identity_unavailable:'登录身份暂时无法读取。',management_identity_read_forbidden:'当前无法读取登录身份。',management_identity_client_unavailable:'账户服务暂时无法连接。',management_identity_response_invalid:'账户服务暂时无法读取。',management_identity_not_found:'登录身份未找到。',
 management_identity_write_forbidden:'账户服务未允许这项变更。',management_identity_write_failed:'这项变更未完成。',management_identity_submission_unknown:'处理结果尚未确定，系统正在恢复连接。',management_sessions_unavailable:'会话服务暂时无法读取。',management_directory_source_changed:'管理目录正在变化，请稍后重试。',management_command_unavailable:'处理服务暂时无法连接。',management_email_verification_not_configured:'邮箱验证尚未接通。',
 operations_assignment_exists:'该账户已有这项角色分配，请按当前记录继续。',operations_permissions_version_changed:'角色分配已有更新，已保留当前选择。',operations_permissions_target_changed:'账户或角色状态已有变化，请按当前记录继续。',operations_role_not_found:'所选角色已不存在。',
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const operatorId=/^[a-f0-9]{64}$/;
const text=(value:unknown)=>typeof value==='string'?value:'';
export function managementAccountsLocation(input:Record<string,unknown>={}):ManagementAccountsLocation{
 const page=Number(input.page),size=Number(input.pageSize),operator=text(input.operator).toLowerCase(),roleId=text(input.roleId).toLowerCase();
 return {page:Number.isSafeInteger(page)&&page>=1&&page<=1_000_000?page:1,pageSize:size===50?50:size===100?100:20,
  query:text(input.query).trim().slice(0,200),enabled:input.enabled==='true'?'true':input.enabled==='false'?'false':'',roleId:uuid.test(roleId)?roleId:'',
  aiDomain:managementAiDomains.some(item=>item.id===input.aiDomain)?input.aiDomain as ManagementAiDomain:'',
  sort:input.sort==='created-desc'?'created-desc':input.sort==='created-asc'?'created-asc':'name-asc',
  operator:operatorId.test(operator)?operator:'',creating:input.create==='1'||input.creating===true,
  tab:managementAccountTabs.some(item=>item.id===input.tab)?input.tab as ManagementAccountTab:'overview',
  historyAfter:/^[1-9][0-9]{0,18}$/.test(text(input.historyAfter))&&BigInt(text(input.historyAfter))<=9223372036854775807n?text(input.historyAfter):''};
}
export function managementAccountsQuery(location:ManagementAccountsLocation){
 const query=new URLSearchParams({page:String(location.page),pageSize:String(location.pageSize),sort:location.sort});
 for(const key of ['query','enabled','roleId','aiDomain'] as const)if(location[key])query.set(key,location[key]);
 return query;
}
export function managementAccountsHref(location:ManagementAccountsLocation,patch:Partial<ManagementAccountsLocation>={}){
 const next=managementAccountsLocation({...location,...patch}),params=managementAccountsQuery(next);
 if(next.creating)params.set('create','1');else if(next.operator)params.set('operator',next.operator);
 if(!next.creating&&next.tab!=='overview')params.set('tab',next.tab);
 if(!next.creating&&next.historyAfter)params.set('historyAfter',next.historyAfter);
 return managementAccountsRoute+'?'+params;
}
export function managementAccountDate(value:string|null|undefined){
 if(!value||!Number.isFinite(Date.parse(value)))return '未记录';
 return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
}
export function managementAiLabel(domains:readonly ManagementAiDomain[]|null|undefined){return Array.isArray(domains)?domains.length?managementAiDomains.filter(item=>domains.includes(item.id)).map(item=>item.label).join('、'):'尚未开放':'尚未取得';}
export function managementRoleAiDomains(permissions:readonly string[]){return managementAiDomains.filter(item=>permissions.includes('ai.use.'+item.id)).map(item=>item.id);}
export function managementAccountName(item:ManagementAccount){return item.displayName?.trim()||item.username?.trim()||'管理账户';}
export function managementAccountQualification(item:Pick<ManagementAccount,'admission'|'rootAdministrator'>){return item.rootAdministrator?'根管理员':item.admission==='administrator'?'管理员':item.admission==='reader'?'成员':item.admission==='none'?'无后台资格':'资格尚未取得';}
export function managementAccountState(item:Pick<ManagementAccount,'lifecycle'|'enabled'>){return item.lifecycle==='deleted'?'已删除':item.enabled===true?'已启用':item.enabled===false?'已停用':'状态未取得';}
export function managementDirectoryStatus(value:ManagementAccountsPage|null){
 if(!value)return '';
 const source=value.source,observed=source.asOf?'（'+managementAccountDate(source.asOf)+'）':'';
 if(source.state==='not-configured')return '管理账户目录尚未配置。';
 if(source.state==='syncing')return source.coverage==='complete-generation'?'目录正在更新，当前显示上次完整目录'+observed+'。':'正在取得完整目录。';
 if(source.state==='unavailable')return source.coverage==='complete-generation'?'目录暂时无法更新，当前显示上次完整目录'+observed+'。':'管理账户目录暂时无法读取。';
 return '';
}
export function managementAssignments(detail:ManagementAccountDetail):ManagementAssignment[]{return detail.item.businessRoles.map(role=>({id:role.assignmentId,operatorId:detail.item.operatorId,roleId:role.id,enabled:role.assignmentEnabled,version:role.assignmentVersion}));}
export function managementPermissionSources(detail:ManagementAccountDetail){
 const result:Record<string,string[]>={};for(const source of detail.effective.sources)for(const code of source.permissions){const labels=result[code]??=[];if(!labels.includes(source.label))labels.push(source.label);}return result;
}
export function managementAiSources(detail:ManagementAccountDetail){
 const permissions=managementPermissionSources(detail);return Object.fromEntries(managementAiDomains.map(item=>[item.id,permissions['ai.use.'+item.id]??[]]));
}
/** Role definitions remain intact. Only the expected effective result follows
 * the same current admission gate as the management read model. */
export function managementAssignmentImpact(detail:ManagementAccountDetail,roleId:string,enabled:boolean){
 if(detail.effective.state!=='available')return {state:'not-eligible' as const,added:[],removed:[],after:[]};
 const before=new Set(detail.effective.permissions);
 if(detail.item.rootAdministrator)return {state:'available' as const,added:[],removed:[],after:[...before]};
 const effective=(codes:readonly string[])=>new Set(codes.filter(code=>detail.item.admission==='administrator'||!requiresManagementMaintainer(code)));
 const assigned=(id:string)=>detail.item.businessRoles.some(row=>row.id===id&&row.assignmentEnabled);
 const original=effective(detail.roles.filter(role=>role.enabled&&assigned(role.id)).flatMap(role=>role.permissions));
 if(original.size!==before.size||[...before].some(code=>!original.has(code)))return {state:'updating' as const,added:[],removed:[],after:[]};
 const after=effective(detail.roles.filter(role=>role.enabled&&(role.id===roleId?enabled:assigned(role.id))).flatMap(role=>role.permissions));
 return {state:'available' as const,added:[...after].filter(code=>!before.has(code)),removed:[...before].filter(code=>!after.has(code)),after:[...after]};
}
export function managementCanCommand(detail:ManagementAccountDetail|null,kind:ManagementCommandKind){
 const caps=detail?.capabilities;if(!caps)return false;
 return kind==='profile-update'?caps.canEditProfile:kind==='login-disable'?caps.canDisableLogin:kind==='login-restore'?caps.canRestoreLogin:kind==='password-reset'?caps.canResetPassword:kind==='sessions-revoke'?caps.canRevokeSessions:kind==='delete'?caps.canDelete:kind==='admission-change'?caps.canChangeAdmission:kind==='email-change'?caps.canChangeEmail:false;
}
export function managementReceiptMatches(value:ManagementCommandReceipt,intent:{operationId:string;kind:ManagementCommandKind;targetOperatorId:string|null}){
 if(!value||!uuid.test(intent.operationId)||value.operationId!==intent.operationId||value.kind!==intent.kind||!['accepted','completed','partial','failed','unknown'].includes(value.state))return false;
 if(intent.kind==='create')return value.targetOperatorId===null?value.state==='accepted'||value.state==='failed'||value.state==='unknown':typeof value.targetOperatorId==='string'&&operatorId.test(value.targetOperatorId);
 return value.targetOperatorId===intent.targetOperatorId;
}
/** A restored locator has no command body. Read the owned immutable event;
 * never rebuild or submit an assignment from that locator. */
export function managementRecoveredAssignment(value:PermissionOperationRead,locator:{operationId:string;targetOperatorId:string|null},owner:string):AssignmentSave|null{
 if(value.state!=='recorded'||value.operationId!==locator.operationId||value.operatorId!==owner||value.kind!=='assignment-save'||!value.selection||!('assignment' in value.result)||value.result.operationId!==locator.operationId)return null;
 const selection=value.selection,row=value.result.assignment;
 if(selection.operatorId!==locator.targetOperatorId||row.operatorId!==locator.targetOperatorId||selection.roleId!==row.roleId||selection.enabled!==row.enabled||selection.id!==null&&selection.id!==row.id||typeof selection.expectedVersion!=='number'||selection.expectedVersion+1!==row.version)return null;
 return value.result;
}
export function managementReceiptLabel(value:ManagementCommandReceipt){
 if(value.state==='completed')return value.kind==='email-change'?'邮箱验证请求已提交，完成验证后新邮箱才生效。':value.kind==='create'?'管理账户已创建。':value.kind==='profile-update'?'账户资料已保存。':value.kind==='admission-change'?'管理员资格已更新。':value.kind?managementCommandLabels[value.kind]+'已完成。':'处理已完成。';
 if(value.state==='partial')return '部分处理已完成，请查看各项结果。';
 if(value.state==='failed')return '这次处理未完成，请查看各项结果。';
 return value.kind==='create'?'正在创建管理账户…':'正在办理'+(value.kind?managementCommandLabels[value.kind]:'账户变更')+'…';
}
export function managementProfileMerge(draft:ManagementProfileDraft,current:{firstName:string|null;lastName:string|null;note:string;targetVersion:string},choices:Partial<Record<'firstName'|'lastName'|'note','mine'|'current'>>={}){
 const fields=['firstName','lastName','note'] as const,merged={firstName:'',lastName:'',note:''},conflicts:Array<{field:'firstName'|'lastName'|'note';label:string;mine:string;current:string}>=[];
 for(const field of fields){
  const mine=draft[field],fresh=current[field]??'',base=field==='firstName'?draft.baseFirstName:field==='lastName'?draft.baseLastName:draft.baseNote;
  if(mine===base)merged[field]=fresh;
  else if(fresh===base||mine===fresh)merged[field]=mine;
  else{conflicts.push({field,label:field==='firstName'?'名':field==='lastName'?'姓':'管理备注',mine,current:fresh});merged[field]=choices[field]==='current'?fresh:mine;}
 }
 return {...merged,targetVersion:current.targetVersion,conflicts,ready:conflicts.every(item=>choices[item.field]==='mine'||choices[item.field]==='current')};
}
export function managementProfileRefresh(draft:ManagementProfileDraft,current:{firstName:string|null;lastName:string|null;note:string}){
 let next=draft;
 for(const [field,baseline] of [['firstName','baseFirstName'],['lastName','baseLastName'],['note','baseNote']] as const){const fresh=current[field]??'';if(draft[field]===draft[baseline]&&fresh!==draft[field])next={...next,[field]:fresh,[baseline]:fresh};}
 return next;
}
