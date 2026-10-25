import type {AgentOsDomain} from './agentos-client';
import {aiWorkPreparationRegistry} from '../../../../packages/galaxy-official/src/shared/operations-ai-action-registry.mjs';

export type WorkbenchActionCard={cardId:string;operationId:string;turnId?:string|null;kind:string;domain:AgentOsDomain;target:{kind:string;label:string;href:string|null};title:string;impact:string[];basis:{label:string;value:string}[];requiredAction:string;capability:{canConfirm:boolean;canDismiss?:boolean;reason:string|null};state:'prepared'|'processing'|'completed'|'unknown'|'not-available';result:{state:string;summary:string;operationId:string}|null;checkedAt:number;readExpiresAt:number};
const kinds=new Set<string>(aiWorkPreparationRegistry.flatMap(entry=>typeof entry.kind==='string'?[entry.kind]:[]));
const states=new Set(['prepared','processing','completed','unknown','not-available']);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const text=(value:unknown,max=5000)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,max):'';
const second=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const href=(value:unknown)=>typeof value==='string'&&/^\/admin\/operations\/[a-z-]+(?:\?[^\s\\#]*)?$/.test(value)&&!/[\p{Cc}]/u.test(value)?value:null;
export function workbenchActionCards(value:unknown,domain:AgentOsDomain):WorkbenchActionCard[]{
 if(!Array.isArray(value))return[];
 return value.slice(0,50).flatMap(raw=>{const item=record(raw),target=record(item?.target),capability=record(item?.capability),result=record(item?.result);
  if(!item||!target||!uuid(item.cardId)||!uuid(item.operationId)||item.domain!==domain||typeof item.kind!=='string'||!kinds.has(item.kind)||typeof item.state!=='string'||!states.has(item.state)||!second(item.checkedAt)||!second(item.readExpiresAt))return[];
  const title=text(item.title,180),name=text(target.label,180);if(!title||!name)return[];
  const ruleCard=item.kind==='rule-publish'||item.kind==='rule-restore',cleanupCard=item.kind==='file-cleanup-approve',draftCard=['message-draft-create','message-draft-save'].includes(item.kind),impactLimit=ruleCard?84:cleanupCard?54:12;
  if((ruleCard||cleanupCard)&&(!Array.isArray(item.impact)||item.impact.length>impactLimit||item.impact.some(line=>typeof line!=='string'||line.length>5000)||item.impact.reduce((sum,line)=>sum+(line as string).length,0)>20000))return[];
  return[{cardId:item.cardId,operationId:item.operationId,turnId:uuid(item.turnId)?item.turnId:null,kind:item.kind,domain,target:{kind:text(target.kind,80),label:name,href:href(target.href)},title,
   impact:Array.isArray(item.impact)?item.impact.filter((v):v is string=>typeof v==='string').slice(0,impactLimit).map(v=>text(v,draftCard?8000:5000)):[],
   basis:Array.isArray(item.basis)?item.basis.slice(0,12).flatMap(value=>{const row=record(value);return row&&text(row.label,100)&&text(row.value)?[{label:text(row.label,100),value:text(row.value)}]:[];}):[],
   requiredAction:text(item.requiredAction,100),capability:{canConfirm:item.state==='prepared'&&capability?.canConfirm===true,canDismiss:['prepared','not-available'].includes(item.state)&&capability?.canDismiss===true,reason:typeof capability?.reason==='string'?text(capability.reason,100):null},state:item.state as WorkbenchActionCard['state'],
   result:result&&result.operationId===item.operationId&&typeof result.summary==='string'?{operationId:item.operationId,state:text(result.state,80),summary:text(result.summary)}:null,checkedAt:item.checkedAt,readExpiresAt:item.readExpiresAt}];
 });
}
export const workbenchCardPath=(domain:AgentOsDomain,cardId:string)=>'/v1/operations/agentos/conversations/'+domain+'/cards/'+encodeURIComponent(cardId);
export const workbenchCardReason=(code:string|null)=>code==='operations_permission_denied'||code==='business_admin_denied'?'当前无此操作权限。':code==='operations_agentos_restriction_changed'?'账户参与状态已有变化，请按当前内容重新准备。':code==='operations_agentos_restriction_deadline'||code==='operations_file_access_until'?'请选择明确且尚未到达的截止时间。':code==='operations_agentos_restriction_inactive'?'当前没有需要解除的参与限制。':code==='operations_file_access_restore_unavailable'?'文件当前不符合恢复条件，请查看文件状态。':code==='operations_file_access_unavailable'?'文件当前不符合停止访问条件，请查看文件状态。':code==='operations_source_changed'||code==='operations_visibility_changed'||code==='operations_file_cleanup_plan_changed'||code==='operations_file_changed'||code==='operations_file_access_changed'?'对象状态已有变化，请按当前内容重新准备。':code==='operations_agentos_human_review_required'?'这项处理需要人工决定。':code==='operations_agentos_rule_review_required'?'请在业务规则页审阅完整变更后处理。':code==='operations_agentos_cleanup_review_required'?'请在文件处理页审阅完整清理计划后确认。':code==='operations_agentos_action_not_connected'?'这项处理暂不可用。':'当前条件暂不满足，操作未执行。';
