import type {AiWorkAccount,AiWorkDetail,AiWorkDomain,AiWorkLocation,AiWorkProfileDraft,AiWorkReceipt,AiWorkTab} from '../components/ai-work-accounts-types';
import {aiWorkPreparation,aiWorkCapabilities} from '../../../../packages/galaxy-official/src/shared/operations-ai-work-capabilities.mjs';
export const aiWorkRoute='/admin/operations/ai-work-accounts';
export const aiWorkBase='/v1/operations/ai-work-accounts';
export const aiWorkDomains:ReadonlyArray<{id:AiWorkDomain;label:string}>=[{id:'overview',label:'总控'},{id:'governance',label:'治理'},{id:'messaging',label:'消息'},{id:'discovery',label:'数据与发现'},{id:'maintenance',label:'运维'}];
export const aiWorkTabs:ReadonlyArray<{id:AiWorkTab;label:string}>=[{id:'overview',label:'岗位概览'},{id:'roles',label:'角色与权限'},{id:'duty',label:'值守与提示词'},{id:'history',label:'变更记录'}];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function aiWorkLocation(input:Record<string,unknown>={}):AiWorkLocation{
 const after=typeof input.after==='string'?input.after:'';
 return{domain:aiWorkDomains.some(row=>row.id===input.domain)?input.domain as AiWorkDomain:'overview',tab:input.tab==='automation'?'roles':aiWorkTabs.some(row=>row.id===input.tab)?input.tab as AiWorkTab:'overview',after:/^[1-9][0-9]{0,18}$/.test(after)&&BigInt(after)<=9223372036854775807n?after:''};
}
export function aiWorkHref(location:AiWorkLocation,patch:Partial<AiWorkLocation>={}){const value=aiWorkLocation({...location,...patch}),query=new URLSearchParams({domain:value.domain,tab:value.tab});if(value.after&&value.tab==='history')query.set('after',value.after);return aiWorkRoute+'?'+query;}
export function aiWorkLabel(domain:AiWorkDomain){return aiWorkDomains.find(row=>row.id===domain)?.label??'AI工作账户';}
export function aiWorkWorkbench(domain:AiWorkDomain){return '/admin?aiDomain='+domain;}
export function aiWorkDate(value:string|null|undefined){return value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):'未记录';}
export function aiWorkProfile(account:AiWorkAccount):AiWorkProfileDraft{return{name:account.name,description:account.description,reason:'',baseName:account.name,baseDescription:account.description,baseVersion:account.version};}
export function aiWorkProfileMerge(draft:AiWorkProfileDraft,account:AiWorkAccount,choices:Partial<Record<'name'|'description','mine'|'current'>>={}){
 const result={name:draft.name,description:draft.description},conflicts:Array<{field:'name'|'description';mine:string;current:string}>=[];
 for(const field of ['name','description'] as const){const base=field==='name'?draft.baseName:draft.baseDescription;if(draft[field]===base)result[field]=account[field];else if(account[field]!==base&&account[field]!==draft[field]){conflicts.push({field,mine:draft[field],current:account[field]});if(choices[field]==='current')result[field]=account[field];}}
 return{...result,expectedVersion:account.version,conflicts,ready:conflicts.every(row=>choices[row.field]==='mine'||choices[row.field]==='current')};
}
export function aiWorkReceiptMatches(value:AiWorkReceipt,intent:{domain:AiWorkDomain;kind:string;body:Readonly<Record<string,unknown>>}){
 if(!value||value.state!=='recorded'||!uuid.test(String(intent.body.operationId))||value.operationId!==intent.body.operationId||value.domain!==intent.domain||value.kind!==intent.kind||!value.selection||!value.result?.account||!uuid.test(value.result.account.id)||value.result.account.domain!==intent.domain)return false;
 const keys=intent.kind==='profile-save'?['expectedVersion','name','description']:intent.kind==='state-save'?['expectedVersion','enabled']:intent.kind==='assignment-save'?['expectedVersion','roleId','enabled']:[];
 if(!keys.length||keys.some(key=>value.selection![key]!==intent.body[key]))return false;
 if(intent.kind==='assignment-save'){
  const row=value.result.assignment;
  return (value.selection.id??null)===(intent.body.id??null)&&!!row&&row.aiAccountId===value.result.account.id&&row.roleId===intent.body.roleId&&row.enabled===intent.body.enabled&&row.version===Number(intent.body.expectedVersion)+1&&(!intent.body.id||row.id===intent.body.id);
 }
 return value.result.account.version===Number(intent.body.expectedVersion)+1&&(intent.kind==='profile-save'?value.result.account.name===intent.body.name&&value.result.account.description===intent.body.description:value.result.account.enabled===intent.body.enabled);
}
export function aiWorkRestoredReceiptMatches(value:AiWorkReceipt,locator:{operationId:string;kind:string;domain?:AiWorkDomain}){return !!locator.domain&&value.operationId===locator.operationId&&value.selection!==null&&aiWorkReceiptMatches(value,{domain:locator.domain,kind:locator.kind,body:{...value.selection,operationId:locator.operationId}});}
export function aiWorkPermissionUse(detail:AiWorkDetail,permission:string){
 const uses:string[]=[];if(detail.effective.queryPermissions.includes(permission))uses.push('受托查询');
 if((aiWorkPreparation as unknown as readonly {kind:string;read:string;actions:readonly string[]}[]).some(row=>detail.effective.preparableKinds.includes(row.kind)&&(row.read===permission||row.actions.includes(permission))))uses.push('准备人工操作');
 if(detail.effective.autonomousPermissions.includes(permission))uses.push('自主执行（按授权范围）');
 return uses.join('、')||'尚无已接工具';
}
export function aiWorkRoleImpact(detail:AiWorkDetail,roleId:string,enabled:boolean){
 const before=new Set(detail.effective.permissions),after=new Set(detail.roles.filter(role=>role.enabled&&(role.id===roleId?enabled:detail.assignments.some(row=>row.roleId===role.id&&row.enabled))).flatMap(role=>role.permissions));
 const added=[...after].filter(code=>!before.has(code)),removed=[...before].filter(code=>!after.has(code)),capabilities=aiWorkCapabilities(detail.account.domain,detail.account.enabled?[...after]:[]);
 return{added,removed,...capabilities};
}
export const aiWorkErrors:Record<string,string>={invalid_operations_ai_work_request:'填写内容无效，请检查后再保存。',operations_ai_work_not_initialized:'AI工作账户尚待初始化。',operations_ai_work_version_changed:'岗位资料已有更新，已保留你的修改。',operations_ai_work_assignment_changed:'角色分配已有更新，请按当前记录继续。',operations_ai_work_role_denied:'当前不能分配这个角色，请选择仍可分配的角色。',operations_ai_work_operation_conflict:'这次处理与已提交的内容不一致。',operations_ai_work_permission_denied:'当前岗位不具备这项业务权限。'};
export const aiWorkPrepareLabels:Record<string,string>={'content-visibility':'公开内容下架与恢复','content-curation':'公开内容编排','section-classification':'版块分类','section-visibility':'版块下架与恢复','resource-visibility':'项目与方法展示','account-restriction':'单账户参与限制','feedback-update':'使用反馈处理','case-resolve':'举报与申诉复核','strategy-continue':'具体策略事项续接','file-scan-retry':'扫描重试','file-access':'单文件访问停止与恢复','file-cleanup-approve':'具体清理计划批准','messaging-state':'消息计划状态','search-apply':'应用搜索草稿','search-restore':'恢复搜索版本','strategy-control':'策略启停','ordinary-strategy-draft':'保存获准范围内的策略调整','ordinary-strategy-publish':'发布获准范围内的策略调整','rule-publish':'发布规则草稿','rule-restore':'恢复规则版本'};
