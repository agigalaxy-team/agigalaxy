import type {AutomationAiAccount,AutomationAiAccountOption,AutomationAiAccountOptions,AutomationAiBindingState,AutomationGrant,AutomationResourceScope,BusinessRole,ManagementPerson,PermissionAction,PermissionHistoryItem,PermissionOperationRead,PermissionRead,PermissionSave} from '../components/permissions-types';

import {requiresManagementMaintainer} from '../../../../packages/galaxy-official/src/shared/operations-management-maintainer-actions.mjs';

export type PermissionsTab='roles'|'personnel'|'automatic';
export type PermissionsLocation={tab:PermissionsTab;id:string;after:string;trail:string[];roleId?:string;aiAccountId?:string};
type RoleFields=Pick<BusinessRole,'name'|'description'|'enabled'|'permissions'|'subjectScope'>;
type AutomationFields=Pick<AutomationGrant,'name'|'executorKind'|'mode'|'enabled'|'permissions'|'resourceIds'|'aiAccountId'>&{resourceScope:AutomationResourceScope};
export type RoleDraft={id:string|null;baseVersion:number;name:string;description:string;enabled:boolean;permissions:string[];subjectScope?:'shared'|'ai-only';baseline?:RoleFields|null};
export type AutomationDraft={id:string|null;baseVersion:number;name:string;executorKind:'program'|'ai';mode:'assisted'|'automatic';enabled:boolean;permissions:string[];resourceIds:string[];resourceScope:AutomationResourceScope;scopeConfirmed:boolean;aiAccountId:string|null;baseline?:AutomationFields|null};
export type PermissionFilter={query:string;group:string;selectedOnly:boolean};
export type PermissionMergeChoice=Record<string,'mine'|'current'>;
export type PermissionMergeConflict={key:string;label:string;mine:string;current:string};
export const emptyPermissionFilter:PermissionFilter={query:'',group:'',selectedOnly:false};
export function permissionConditionReason(reason:string|{code:string;message:string}){
 const code=typeof reason==='string'?reason:reason.code;
 const labels:Record<string,string>={'permission-missing':'当前角色缺少所需权限。','human-decision-required':'这项处理需要人工决定。','handler-not-connected':'该动作的业务处理尚未接通。','object-scope-unresolved':'尚未明确可处理的业务对象范围。','runtime-not-connected':'自动执行服务尚未接通。','model-not-configured':'尚未配置可用模型。',disabled:'AI 工作账户当前停用。','account-disabled':'AI 工作账户当前停用。','role-exceeded':'所配动作超出 AI 当前角色权限。',unassigned:'尚未分配 AI 工作账户。',unsupported:'所配动作暂不支持自动执行。',unavailable:'当前授权条件暂不可读取。','role-missing':'尚未分配有效业务角色。','assignment-denied':'这项分配超出当前管理人员的授权范围。','exceeds-permissions':'所配动作超出当前可授权限。','execution-not-connected':'执行通道尚未接通。','grant-disabled':'自动执行授权当前停用。'};
 return labels[code]??(typeof reason==='object'&&reason.message?reason.message:'所需处理条件尚未满足。');
}
export function permissionCopyAutomationRole(role:BusinessRole,catalog:readonly PermissionAction[],grantable:ReadonlySet<string>){
 const known=new Map(catalog.map(item=>[item.code,item]));let humanOnly=0,unavailable=0;
 const permissions=[...new Set(role.permissions)].filter(code=>{const item=known.get(code);if(item?.humanOnly){humanOnly++;return false;}if(!item||!grantable.has(code)){unavailable++;return false;}return true;}).sort();return {permissions,humanOnly,unavailable};
}

// Explicit initial sets. Future additions to the server catalog never extend them.
export const permissionRoleTemplates=[
 {id:'basic',name:'基础查看',description:'查看常用业务资料',permissions:['workbench.read','accounts.read','sections.read','content.read','resources.read','notices.read']},
 {id:'content',name:'公开内容运营',description:'维护公开内容、标签及公开举报',permissions:['workbench.read','sections.read','content.read','content.hide','content.restore','content.curate','content.tags.read','content.tags.manage','cases.read','cases.resolve']},
 {id:'messaging',name:'消息运营',description:'管理官方消息草稿与发布',permissions:['workbench.read','notices.read','notices.create','notices.update','notices.publish','notices.withdraw']},
 {id:'analytics',name:'使用分析',description:'查看账户汇总与使用分析',permissions:['workbench.read','accounts.read','analytics.read']},
] as const;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const opaque=/^[a-zA-Z0-9_.:@-]{1,160}$/;
const validSequence=(value:string)=>/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
export function permissionsLocation(input:Record<string,unknown>):PermissionsLocation{
 const text=(key:string)=>typeof input[key]==='string'?input[key] as string:'';
 const rawTab=text('tab'),tab:PermissionsTab=rawTab==='personnel'||rawTab==='automatic'?rawTab:'roles';
 const rawId=text('id'),id=tab!=='personnel'?(rawId==='new'||uuid.test(rawId.toLowerCase())?rawId.toLowerCase():''):opaque.test(rawId)?rawId:'';
 const after=validSequence(text('after'))?text('after'):'';
 const rawTrail=text('trail'),trail=rawTrail.length<=2048?rawTrail.split(',').filter(value=>value==='start'||validSequence(value)).slice(-30):[];
 const roleId=text('role').toLowerCase(),aiAccountId=text('aiAccount').toLowerCase();
 return {tab,id,after,trail,...(tab==='personnel'&&uuid.test(roleId)?{roleId}:{}),...(tab==='automatic'&&id==='new'&&uuid.test(aiAccountId)?{aiAccountId}:{})};
}
export function permissionsHref(location:PermissionsLocation,patch:Partial<PermissionsLocation>={}){
 const next={...location,...patch},query=new URLSearchParams();
 if(next.tab!=='roles')query.set('tab',next.tab);
 if(next.id)query.set('id',next.id);
 if(next.tab==='automatic'&&next.id==='new'&&next.aiAccountId&&uuid.test(next.aiAccountId))query.set('aiAccount',next.aiAccountId);
 if(next.tab==='personnel'&&next.roleId&&uuid.test(next.roleId))query.set('role',next.roleId);
 if(next.after)query.set('after',next.after);
 if(next.trail.length)query.set('trail',next.trail.join(','));
 return '/admin/operations/permissions'+(query.size?'?'+query.toString():'');
}
export function permissionHistoryQuery(location:PermissionsLocation,resourceId?:string,targetOperatorId?:string){
 const query=new URLSearchParams({limit:'20'});if(location.after)query.set('after',location.after);if(resourceId&&uuid.test(resourceId))query.set('resourceId',resourceId);if(targetOperatorId&&opaque.test(targetOperatorId))query.set('targetOperatorId',targetOperatorId);return query.toString();
}
export function nextPermissionHistory(location:PermissionsLocation,next:string):Partial<PermissionsLocation>{
 return validSequence(next)?{after:next,trail:[...location.trail,location.after||'start'].slice(-30)}:{};
}
export function previousPermissionHistory(location:PermissionsLocation):Partial<PermissionsLocation>{
 const last=location.trail.at(-1);return {after:last&&last!=='start'?last:'',trail:location.trail.slice(0,-1)};
}
export function permissionReadCurrent<T extends PermissionRead>(value:T|null,now=Date.now()):T|null{
 if(!value||!Number.isFinite(value.checkedAt))return null;
 const end=value.readExpiresAt;return Number.isFinite(end)&&end*1000>now?value:null;
}
export function permissionTime(value:string|null|undefined){
 return value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'未记录';
}
export function roleDraft(role?:BusinessRole|null):RoleDraft{
 return role?{id:role.id,baseVersion:role.version,name:role.name,description:role.description,enabled:role.enabled,permissions:[...role.permissions],subjectScope:role.subjectScope??'shared',baseline:{name:role.name,description:role.description,enabled:role.enabled,permissions:[...role.permissions],subjectScope:role.subjectScope??'shared'}}:{id:null,baseVersion:0,name:'',description:'',enabled:true,permissions:[],subjectScope:'shared',baseline:null};
}
export function copyRoleDraft(role:BusinessRole):RoleDraft{return {...roleDraft(),name:role.name.slice(0,117)+' 副本',description:role.description,enabled:role.enabled,permissions:[...role.permissions],subjectScope:role.subjectScope??'shared'};}
export function permissionFilterItems(catalog:readonly PermissionAction[],selected:readonly string[],filter:PermissionFilter){
 const picked=new Set(selected),query=filter.query.normalize('NFKC').trim().toLocaleLowerCase();
 return catalog.filter(item=>(!filter.group||filter.group===item.group)&&(!filter.selectedOnly||picked.has(item.code))&&(!query||[item.label,item.groupLabel,item.code].some(value=>value.normalize('NFKC').toLocaleLowerCase().includes(query))));
}
export function permissionCanAdd(item:PermissionAction,grantable?:ReadonlySet<string>,automatic=false){return (!grantable||grantable.has(item.code))&&(!automatic||!item.humanOnly);}
export function permissionScopeState(items:readonly PermissionAction[],selected:readonly string[],grantable?:ReadonlySet<string>,automatic=false){
 const picked=new Set(selected),eligible=items.filter(item=>permissionCanAdd(item,grantable,automatic)),selectedCount=items.filter(item=>picked.has(item.code)).length;
 const checked=eligible.length>0&&eligible.every(item=>picked.has(item.code));
 return {checked,indeterminate:!checked&&selectedCount>0,selectedCount,total:items.length,canSelect:eligible.some(item=>!picked.has(item.code)),canClear:selectedCount>0,canInvert:eligible.length>0||selectedCount>0};
}
export function permissionSelectScope(selected:readonly string[],items:readonly PermissionAction[],action:'all'|'clear'|'invert',grantable?:ReadonlySet<string>,automatic=false){
 const next=new Set(selected);
 for(const item of items){if(action==='clear'||action==='invert'&&next.has(item.code))next.delete(item.code);else if(permissionCanAdd(item,grantable,automatic))next.add(item.code);}
 return [...next];
}
const samePermissionValue=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
function mergePermissionFields<T extends RoleDraft|AutomationDraft>(draft:T,current:BusinessRole|AutomationGrant,choices:PermissionMergeChoice={},aiAccounts:readonly AutomationAiAccount[]=[]){
 const base=draft.baseline,conflicts:PermissionMergeConflict[]=[],merged={...draft,baseVersion:current.version};let unresolved=0;
 const fieldLabel:Record<string,string>={name:'名称',description:'说明',enabled:'启用状态',executorKind:'执行类型',mode:'执行方式',resourceScope:'对象范围',aiAccountId:'AI工作账户',subjectScope:'角色用途'};
 const text=(key:string,value:unknown)=>typeof value==='boolean'?(value?'启用':'停用'):key==='mode'?(value==='assisted'?'人员代办':'系统自动'):key==='executorKind'?(value==='ai'?'AI':'程序'):key==='resourceScope'?permissionScopeLabel(value as AutomationResourceScope):key==='aiAccountId'?permissionAiAccountLabel(typeof value==='string'?value:null,aiAccounts):typeof value==='string'&&value?value:'未填写';
 const fields=('executorKind' in draft?['name','enabled','executorKind','mode','resourceScope','aiAccountId']:['name','description','enabled','subjectScope']) as string[];
 for(const key of fields){const before=base?(base as unknown as Record<string,unknown>)[key]:undefined,local=(draft as unknown as Record<string,unknown>)[key],remote=key==='resourceScope'?permissionResourceScope(current as AutomationGrant):(current as unknown as Record<string,unknown>)[key];let value:unknown;
  if(base&&samePermissionValue(local,before))value=remote;
  else if(base&&samePermissionValue(remote,before)||samePermissionValue(local,remote))value=local;
  else{conflicts.push({key,label:fieldLabel[key],mine:text(key,local),current:text(key,remote)});if(!choices[key])unresolved++;value=choices[key]==='mine'?local:remote;}
  (merged as unknown as Record<string,unknown>)[key]=Array.isArray(value)?[...value]:value;
 }
 if(base){const before=new Set(base.permissions),local=new Set(draft.permissions),remote=new Set(current.permissions),codes=new Set([...before,...local,...remote]);merged.permissions=[...codes].filter(code=>local.has(code)===before.has(code)?remote.has(code):local.has(code));}
 else if(samePermissionValue([...draft.permissions].sort(),[...current.permissions].sort()))merged.permissions=[...draft.permissions];
 else{conflicts.push({key:'permissions',label:'业务权限',mine:'保留我的权限配置',current:'采用当前权限配置'});if(!choices.permissions)unresolved++;merged.permissions=[...(choices.permissions==='mine'?draft.permissions:current.permissions)];}
 if('executorKind' in merged){const scope=merged.resourceScope;merged.resourceIds=scope.kind==='selected'?[...scope.resourceIds]:[];merged.scopeConfirmed=scope.kind!=='unresolved';merged.aiAccountId=merged.executorKind==='program'?null:merged.aiAccountId??null;}
 merged.baseline=('executorKind' in current?{name:current.name,enabled:current.enabled,executorKind:current.executorKind,mode:current.mode,resourceIds:[...current.resourceIds],resourceScope:permissionResourceScope(current),permissions:[...current.permissions],aiAccountId:current.aiAccountId??null}:{name:current.name,description:current.description,enabled:current.enabled,permissions:[...current.permissions],subjectScope:current.subjectScope??'shared'}) as T['baseline'];
 return {draft:merged,conflicts,unresolved};
}
export const roleMerge=(draft:RoleDraft,current:BusinessRole,choices:PermissionMergeChoice={})=>mergePermissionFields(draft,current,choices);
export const automationMerge=(draft:AutomationDraft,current:AutomationGrant,choices:PermissionMergeChoice={},aiAccounts:readonly AutomationAiAccount[]=[])=>mergePermissionFields(draft,current,choices,aiAccounts);
export function permissionAuthorityKnown(person:ManagementPerson){return person.authorizationState==='available'&&!!person.effective&&(person.effective.source==='preconfigured-root'||person.effective.source==='business-roles');}
export function permissionAuthorityLabel(source:NonNullable<ManagementPerson['effective']>['source']|undefined){return source==='preconfigured-root'?'根管理员':source==='business-roles'?'业务角色':source==='upstream-administrator'?'旧上游来源':'未确认';}
export function personPermissionImpact(person:ManagementPerson,roles:readonly BusinessRole[],change:{role?:BusinessRole;assignment?:{roleId:string;enabled:boolean}}){
 const effective=person.effective;
 if(!permissionAuthorityKnown(person)||!effective)return {state:'unknown' as const,added:[] as string[],removed:[] as string[],retained:[] as string[]};
 if(effective.source==='preconfigured-root')return {state:'root' as const,added:[] as string[],removed:[] as string[],retained:[...effective.permissions]};
 const activeRoles=roles.filter(role=>role.enabled&&person.assignments.some(item=>item.enabled&&item.roleId===role.id));
 const afterRoles=roles.map(role=>change.role?.id===role.id?change.role:role).filter(role=>role.enabled&&(change.assignment?.roleId===role.id?change.assignment.enabled:person.assignments.some(item=>item.enabled&&item.roleId===role.id)));
 const beforeCodes=activeRoles.flatMap(role=>role.permissions),afterCodes=afterRoles.flatMap(role=>role.permissions),qualification=person.managementEligibility;
 if([...beforeCodes,...afterCodes].some(requiresManagementMaintainer)&&qualification!=='qualified'&&qualification!=='unqualified')return {state:'unknown' as const,added:[] as string[],removed:[] as string[],retained:[] as string[]};
 const currentCodes=(codes:readonly string[])=>new Set(codes.filter(code=>qualification!=='unqualified'||!requiresManagementMaintainer(code)));
 const before=currentCodes(beforeCodes),after=currentCodes(afterCodes);
 if(before.size!==new Set(effective.permissions).size||effective.permissions.some(code=>!before.has(code)))return {state:'unknown' as const,added:[] as string[],removed:[] as string[],retained:[] as string[]};
 const touched=new Set([...(roles.find(role=>role.id===(change.role?.id??change.assignment?.roleId))?.permissions??[]),...(change.role?.permissions??[])]),requiresAdministrator=qualification==='unqualified'?[...new Set(afterCodes.filter(requiresManagementMaintainer))]:[];
 return {state:'known' as const,added:[...after].filter(code=>!before.has(code)),removed:[...before].filter(code=>!after.has(code)),retained:[...before].filter(code=>after.has(code)&&touched.has(code)),...(requiresAdministrator.length?{requiresAdministrator}:{})};
}
export function permissionOperationKind(path:string){return path==='/v1/operations/permissions/roles'?'role-save':path==='/v1/operations/permissions/assignments'?'assignment-save':path==='/v1/operations/permissions/automation'?'automation-save':null;}
export function permissionOperationSelection(kind:string|null,body:Record<string,unknown>){
 const fields=kind==='role-save'?['name','description','enabled','permissions',...(Object.hasOwn(body,'subjectScope')?['subjectScope']:[])]:kind==='assignment-save'?['operatorId','roleId','enabled']:kind==='automation-save'?['name','executorKind','mode','enabled','permissions','resourceIds',...(Object.hasOwn(body,'resourceScope')?['resourceScope']:[]),...(Object.hasOwn(body,'aiAccountId')?['aiAccountId']:[])]:null;
 if(!fields)return null;return Object.fromEntries([['id',body.id??null],['expectedVersion',body.expectedVersion],...fields.map(key=>[key,body[key]])]);
}
export function permissionOperationResult(value:PermissionOperationRead,intent:{path:string;body:Record<string,unknown>},operatorId:string):PermissionSave|null{
 const kind=permissionOperationKind(intent.path);
 const expected=permissionOperationSelection(kind,intent.body);
 if(value.state!=='recorded'||value.operationId!==intent.body.operationId||value.operatorId!==operatorId||value.kind!==kind||!value.selection||!expected||!samePermissionValue(Object.keys(value.selection).sort(),Object.keys(expected).sort())||!samePermissionValue(permissionOperationSelection(kind,value.selection),expected)||value.result.operationId!==intent.body.operationId)return null;
 if(kind==='role-save'&&'role' in value.result&&(!intent.body.id||value.result.role.id===intent.body.id))return value.result;
 if(kind==='assignment-save'&&'assignment' in value.result&&(!intent.body.id||value.result.assignment.id===intent.body.id)&&value.result.assignment.operatorId===intent.body.operatorId&&value.result.assignment.roleId===intent.body.roleId)return value.result;
 if(kind==='automation-save'&&'automation' in value.result&&(!intent.body.id||value.result.automation.id===intent.body.id)&&(!Object.hasOwn(intent.body,'aiAccountId')||value.result.automation.aiAccountId===intent.body.aiAccountId))return value.result;
 return null;
}
export function permissionDifference(before:readonly string[],after:readonly string[],catalog:readonly PermissionAction[]){
 const oldSet=new Set(before),newSet=new Set(after);
 return {added:catalog.filter(action=>newSet.has(action.code)&&!oldSet.has(action.code)),removed:catalog.filter(action=>oldSet.has(action.code)&&!newSet.has(action.code))};
}
export function permissionGroups(catalog:readonly PermissionAction[]){
 const groups=new Map<string,{id:string;label:string;items:PermissionAction[]}>();
 for(const action of catalog){let group=groups.get(action.group);if(!group){group={id:action.group,label:action.groupLabel,items:[]};groups.set(action.group,group);}group.items.push(action);}
 return [...groups.values()];
}
export function roleDraftChanged(draft:RoleDraft,role?:BusinessRole|null){
 if(!role)return !!draft.name.trim()||!!draft.description.trim()||draft.permissions.length>0||!draft.enabled;
 const expected=[...new Set(role.permissions)].sort(),actual=[...new Set(draft.permissions)].sort();
 return draft.name.trim()!==role.name||draft.description.trim()!==role.description||draft.enabled!==role.enabled||(draft.subjectScope??'shared')!==(role.subjectScope??'shared')||expected.join('\0')!==actual.join('\0');
}
export function roleSaveBody(draft:RoleDraft,catalog:readonly PermissionAction[]){
 const known=new Set(catalog.map(action=>action.code));
 if(!draft.name.trim()||draft.name.trim().length>120||/[\p{Cc}]/u.test(draft.name)||draft.description.trim().length>1000||/[\p{Cc}]/u.test(draft.description)||draft.permissions.some(code=>!known.has(code)))return null;
 return {...(draft.id?{id:draft.id}:{}),expectedVersion:draft.baseVersion,name:draft.name.trim(),description:draft.description.trim(),enabled:draft.enabled,permissions:[...new Set(draft.permissions)].sort(),subjectScope:draft.subjectScope??'shared'};
}
export function permissionResourceScope(grant:Pick<AutomationGrant,'resourceIds'|'resourceScope'>):AutomationResourceScope{
 const scope=grant.resourceScope;if(scope?.kind==='selected')return {kind:'selected',resourceIds:[...scope.resourceIds]};if(scope?.kind==='eligible')return {kind:'eligible'};
 return scope?.kind==='unresolved'||!grant.resourceIds.length?{kind:'unresolved'}:{kind:'selected',resourceIds:[...grant.resourceIds]};
}
export function permissionScopeLabel(scope:AutomationResourceScope|string[]|null){
 if(scope===null)return '未记录';const value=Array.isArray(scope)?(scope.length?{kind:'selected' as const,resourceIds:scope}:{kind:'unresolved' as const}):scope;
 return value.kind==='selected'?'指定 '+value.resourceIds.length+' 个对象':value.kind==='eligible'?'全部符合条件对象，含后续新对象':'对象范围未确定';
}
export function automationDraft(grant?:AutomationGrant|null):AutomationDraft{
 if(!grant)return {id:null,baseVersion:0,name:'',executorKind:'program',mode:'assisted',enabled:false,permissions:[],resourceIds:[],resourceScope:{kind:'unresolved'},scopeConfirmed:false,aiAccountId:null,baseline:null};
 const resourceScope=permissionResourceScope(grant),aiAccountId=grant.executorKind==='program'?null:grant.aiAccountId??null;return {id:grant.id,baseVersion:grant.version,name:grant.name,executorKind:grant.executorKind,mode:grant.mode,enabled:grant.enabled,permissions:[...grant.permissions],resourceIds:[...grant.resourceIds],resourceScope,scopeConfirmed:resourceScope.kind!=='unresolved',aiAccountId,baseline:{name:grant.name,executorKind:grant.executorKind,mode:grant.mode,enabled:grant.enabled,permissions:[...grant.permissions],resourceIds:[...grant.resourceIds],resourceScope,aiAccountId}};
}
/** A context hint initializes only a new draft from the currently readable AI catalog. */
export function newAiAutomationDraft(accountId:string|undefined,options:AutomationAiAccountOptions):AutomationDraft{
 const draft=automationDraft(),account=options.state==='available'&&accountId?options.items.find(item=>item.id===accountId):null;
 return account?{...draft,executorKind:'ai',aiAccountId:account.id}:draft;
}
export function automationSaveBody(draft:AutomationDraft,catalog:readonly PermissionAction[],aiOptions?:AutomationAiAccountOptions){
 const known=new Map(catalog.map(action=>[action.code,action]));
 const scope=draft.resourceScope,ids=scope.kind==='selected'?scope.resourceIds:[];
 if(!draft.name.trim()||draft.name.trim().length>120||/[\p{Cc}]/u.test(draft.name)||!draft.id&&(scope.kind==='unresolved'||!draft.scopeConfirmed)||scope.kind==='selected'&&!ids.length||ids.length>100||ids.some(id=>!uuid.test(id))||new Set(ids).size!==ids.length||draft.permissions.some(code=>!known.has(code)||known.get(code)?.humanOnly))return null;
 if(draft.aiAccountId!==null&&!uuid.test(draft.aiAccountId)||automationBindingIssue(draft,aiOptions))return null;
 return {...(draft.id?{id:draft.id}:{}),expectedVersion:draft.baseVersion,name:draft.name.trim(),executorKind:draft.executorKind,mode:draft.mode,enabled:draft.enabled,permissions:[...new Set(draft.permissions)].sort(),resourceIds:[...ids],resourceScope:scope.kind==='selected'?{kind:'selected' as const,resourceIds:[...ids]}:{kind:scope.kind},aiAccountId:draft.executorKind==='program'?null:draft.aiAccountId};
}
export function automationDraftChanged(draft:AutomationDraft,grant?:AutomationGrant|null){
 if(!grant)return !!draft.name.trim()||draft.permissions.length>0||draft.scopeConfirmed||draft.enabled||draft.aiAccountId!==null||draft.executorKind!=='program'||draft.mode!=='assisted';
 return draft.name.trim()!==grant.name||draft.executorKind!==grant.executorKind||draft.mode!==grant.mode||draft.enabled!==grant.enabled||[...draft.permissions].sort().join('\0')!==[...grant.permissions].sort().join('\0')||!samePermissionValue(draft.resourceScope,permissionResourceScope(grant))||(draft.executorKind==='program'?null:draft.aiAccountId)!==(grant.executorKind==='program'?null:grant.aiAccountId??null);
}
export const permissionAiDomains={overview:'总控',governance:'治理',messaging:'消息',discovery:'数据与发现',maintenance:'运维'} as const;
export const permissionAiBindingNames:Record<AutomationAiBindingState,string>={'not-applicable':'程序授权',unassigned:'未分配AI工作账户',bound:'已关联工作账户',disabled:'工作账户已停用','role-exceeded':'动作超出工作账户权限',unsupported:'工作账户暂无相应执行能力',unavailable:'工作账户暂不可核对'};
export function permissionAiAccountLabel(id:string|null|undefined,items:readonly AutomationAiAccount[]=[]){if(!id)return '未分配';const account=items.find(row=>row.id===id);if(!account)return '工作账户暂不可读取';const domain=permissionAiDomains[account.domain];return account.name===domain?account.name:account.name+'（'+domain+'）';}
export function permissionAiExecutionIssue(account:AutomationAiAccountOption){
 if(!account.enabled)return '工作账户已停用';
 if(account.canEnable)return '';
 if(account.unavailableReason==='execution-not-connected')return '执行处理器尚未就绪';
 if(account.unavailableReason==='role-missing')return '请先为该工作账户分配包含相应执行动作的业务角色';
 if(account.unavailableReason==='assignment-denied')return '你没有自动执行授权的配置权限';
 if(account.unavailableReason==='exceeds-permissions')return '该岗位可执行的动作超出你当前可授予的权限';
 return '当前没有可用于自动执行的动作，请查看岗位角色与已接能力';
}
export function automationBindingIssue(draft:AutomationDraft,options?:AutomationAiAccountOptions){
 if(draft.executorKind==='program')return '';
 if(!draft.aiAccountId)return '请选择承担此授权的AI工作账户。';
 if(options?.state!=='available')return 'AI工作账户暂时无法核对，草稿已保留。';
 const account=options.items.find(row=>row.id===draft.aiAccountId);
 if(!account)return '所选AI工作账户当前不可读取，请重新选择。';
 if(!draft.permissions.length)return '请选择本次允许执行的动作。';
 const allowed=account.permissions;if(allowed&&draft.permissions.some(code=>!allowed.includes(code)))return '包含超出该工作账户业务角色权限的动作，请调整后保存。';
 return '';
}
export function personPermissionSources(person:ManagementPerson,code:string,roles:readonly BusinessRole[]){
 if(!permissionAuthorityKnown(person)||!person.effective)return {state:'unknown' as const,labels:person.effective?.source==='upstream-administrator'?['旧上游来源']:[] as string[]};
 if(!person.effective.permissions.includes(code))return {state:'denied' as const,labels:[] as string[]};
 if(person.effective.source==='preconfigured-root')return {state:'granted' as const,labels:['根管理员']};
 const labels=person.assignments.filter(assignment=>assignment.enabled).flatMap(assignment=>{const role=roles.find(item=>item.id===assignment.roleId&&item.enabled&&item.permissions.includes(code));return role?[role.name]:[];});
 return {state:'granted' as const,labels:labels.length?[...new Set(labels)]:['业务角色']};
}
export const permissionHistoryNames={ 'role-save':'保存业务角色','assignment-save':'调整人员角色','automation-save':'调整自动执行授权'} as const;
const managementName=(value:unknown)=>typeof value==='string'&&value.trim()?value.trim():'管理账户';
export function permissionHistoryOperator(item:{operatorDisplayName?:string|null}){return managementName(item.operatorDisplayName);}
export const permissionFieldNames:Record<string,string>={name:'名称',description:'说明',enabled:'启用状态',permissions:'业务权限',operatorId:'管理人员',roleId:'角色',executorKind:'执行类型',mode:'执行方式',resourceIds:'对象范围',aiAccountId:'AI工作账户',subjectScope:'角色用途'};

export type PermissionDeltaLine={label:string;text:string};
/** Read only the recorded delta; current records supply names, never old grants. */
export function permissionHistoryDeltaLines(event:Pick<PermissionHistoryItem,'delta'>&Partial<Pick<PermissionHistoryItem,'assignmentOperatorDisplayName'>>,catalog:readonly PermissionAction[],{roles=[],people=[],aiAccounts=[]}:{roles?:readonly BusinessRole[];people?:readonly ManagementPerson[];aiAccounts?:readonly AutomationAiAccount[]}={}):PermissionDeltaLine[]{
 const delta=event.delta;if(!delta)return [{label:'变更差异',text:'未记录'}];
 const lines:PermissionDeltaLine[]=[];
 const actionNames=(codes:readonly string[])=>{
  const items=[...new Set(codes)].map(code=>catalog.find(item=>item.code===code)),names=items.flatMap(item=>item?[item.groupLabel+' · '+item.label]:[]),missing=items.filter(item=>!item).length;
  return [...names,...(missing?['另有 '+missing+' 项权限名称暂未取得']:[])].join('、');
 };
 const enabled=(before:boolean|null,after:boolean,assignment=false)=>{
  const name=(value:boolean)=>assignment?(value?'已分配':'已撤回'):(value?'已启用':'已停用');
  if(before===null)return '新建为'+name(after);
  return before===after?'保持'+name(after):'由'+name(before)+'改为'+name(after);
 };
 if(delta.kind==='assignment'){
  const person=people.find(item=>item.operatorId===delta.operatorId),role=roles.find(item=>item.id===delta.roleId);
  const displayName=Object.hasOwn(event,'assignmentOperatorDisplayName')?event.assignmentOperatorDisplayName:person?.displayName;
  return [{label:'管理人员',text:managementName(displayName)},{label:'业务角色',text:role?.name??'角色记录 '+delta.roleId.slice(0,8)},{label:'角色分配',text:enabled(delta.enabled.before,delta.enabled.after,true)}];
 }
 if(delta.permissions.added.length)lines.push({label:'新增权限',text:actionNames(delta.permissions.added)});
 if(delta.permissions.removed.length)lines.push({label:'移除权限',text:actionNames(delta.permissions.removed)});
 if(delta.enabled.before===null||delta.enabled.before!==delta.enabled.after)lines.push({label:delta.kind==='role'?'角色状态':'授权状态',text:enabled(delta.enabled.before,delta.enabled.after)});
 if(delta.kind==='automation'){
  const before=delta.scope.before,after=delta.scope.after;
  if(before===null)lines.push({label:'对象范围',text:'新建为'+permissionScopeLabel(after)});
  else if(!samePermissionValue(before,after))lines.push({label:'对象范围',text:'由'+permissionScopeLabel(before)+'改为'+permissionScopeLabel(after)});
  const modeNames={assisted:'人员代办',automatic:'系统自动'},executorNames={program:'程序',ai:'AI'};
  if(delta.mode.before===null||delta.mode.before!==delta.mode.after)lines.push({label:'执行方式',text:delta.mode.before===null?'设置为'+modeNames[delta.mode.after]:'由'+modeNames[delta.mode.before]+'改为'+modeNames[delta.mode.after]});
  if(delta.executorKind.before===null||delta.executorKind.before!==delta.executorKind.after)lines.push({label:'执行类型',text:delta.executorKind.before===null?'设置为'+executorNames[delta.executorKind.after]:'由'+executorNames[delta.executorKind.before]+'改为'+executorNames[delta.executorKind.after]});
  if(delta.aiAccountId&&delta.aiAccountId.before!==delta.aiAccountId.after)lines.push({label:'AI工作账户',text:'由'+permissionAiAccountLabel(delta.aiAccountId.before,aiAccounts)+'改为'+permissionAiAccountLabel(delta.aiAccountId.after,aiAccounts)});
 }
 return lines.length?lines:[{label:delta.kind==='role'?'权限与启用状态':'权限、状态及范围',text:'未变'}];
}
