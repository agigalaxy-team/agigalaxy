import type {AgentOsCommand,AgentOsDomain,AgentOsGrantOption,AgentOsPreparedAction} from './agentos-client';
import type {PublicContentDetail,PublicContentItem,PublicContentKind} from '../components/public-content-types';

const contentActions=new Set(['content.read','content.hide','content.restore']);
export function selectedContentPermissions(permissions:readonly string[]){return permissions.length>0&&permissions.every(code=>contentActions.has(code));}
export function automationContentLabel(item:Pick<PublicContentItem,'kind'|'title'|'excerpt'|'sourceState'>){
  if(item.sourceState!=='available')return '内容当前不可读取';
  return item.kind==='reply'?(item.excerpt?.trim()?'回复 · '+item.excerpt.trim().slice(0,100):'公开回复'):(item.title?.trim()||'公开帖子');
}
export const preparedContentHref=(target:{kind:PublicContentKind;id:string})=>'/admin/operations/community?tab=posts&contentKind='+target.kind+'&id='+encodeURIComponent(target.id);
export type AuthorizedPreparationDraft={action:''|'hide'|'restore';until:string;reason:string};
export type AuthorizedPreparationBody={grantId:string;expectedGrantVersion:number;domain:AgentOsDomain;actions:string[];resourceIds:string[];preparedCommand:AgentOsPreparedAction};
export function grantIncludesContent(grant:AgentOsGrantOption,id:string){
  const scope=grant.resourceScope;
  return scope?.kind==='eligible'||scope?.kind==='selected'&&scope.resourceIds.includes(id);
}
export function preparationUntil(value:string){
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))return null;
  const time=Date.parse(value+':00+08:00');
  return Number.isFinite(time)&&new Date(time+8*3600000).toISOString().slice(0,16)===value?Math.floor(time/1000):null;
}
export function authorizedPreparation({grant,domain,target,draft,source,verified,now=Math.floor(Date.now()/1000)}:{grant:AgentOsGrantOption|null;domain:AgentOsDomain;target:{kind:PublicContentKind;id:string}|null;draft:AuthorizedPreparationDraft;source:PublicContentDetail|null;verified:boolean;now?:number}):{body:AuthorizedPreparationBody|null;issue:string}{
  const invalid=(issue:string)=>({body:null,issue});
  if(!grant||grant.domain!==domain||grant.mode!=='assisted')return invalid('请选择本领域当前可用的人员代办授权。');
  if(domain!=='governance'||!grant.actions.includes('content.read'))return invalid('这项授权尚未接入公开内容处理。');
  if(!target)return invalid('请选择这次处理的公开内容。');
  if(!grantIncludesContent(grant,target.id))return invalid('这项内容不在当前授权范围内。');
  if(!verified||!source)return invalid('正在核对当前内容。');
  const item=source.content;
  if(item.kind!==target.kind||item.id!==target.id||item.sourceState!=='available'||item.state!=='published')return invalid('这项内容当前不具备处理条件。');
  if(!draft.action)return invalid('请选择这次下架或恢复。');
  const action='content.'+draft.action;
  if(!grant.actions.includes(action))return invalid('当前授权不含这项动作。');
  if(draft.action==='hide'?!item.capabilities.canHide:!item.capabilities.canRestore)return invalid(draft.action==='hide'?'这项内容当前不能下架。':'这项内容当前不能恢复。');
  const reason=draft.reason.trim();
  if(reason.length<3||reason.length>1600)return invalid('请填写至少 3 字的本次处理说明。');
  let until:number|undefined;
  if(draft.action==='hide'){
    const value=preparationUntil(draft.until);
    if(value===null||value<=now)return invalid('请明确填写未来的下架截止时间。');
    if(!Number.isSafeInteger(item.maxHideSeconds)||item.maxHideSeconds<=0||value>now+item.maxHideSeconds)return invalid('下架截止超出当前允许的最长时间。');
    until=value;
  }
  if(!Number.isSafeInteger(item.version)||item.version<0||!Number.isSafeInteger(item.visibility.version)||item.visibility.version<0)return invalid('当前内容版本尚未取得。');
  const input={kind:draft.action,expectedVersion:item.version,expectedRevision:item.visibility.version,reason,...(until===undefined?{}:{until})};
  return {body:{grantId:grant.id,expectedGrantVersion:grant.version,domain,actions:['content.read',action],resourceIds:[item.id],preparedCommand:{tool:'content-visibility',targetKind:item.kind,targetId:item.id,input}},issue:''};
}
export function authorizedCommandMatches(value:AgentOsCommand,intent:{path:string;body:Record<string,unknown>}){
  const {path,body}=intent;
  if(!path.startsWith('/v1/operations/agentos/executions'))return true;
  if(value.operationId!==body.operationId)return false;
  if(value.state==='not-recorded')return true;
  const suffix=/\/executions\/([0-9a-f-]{36})\/(events|runs|review|continue)$/i.exec(path);
  const kind=suffix?(suffix[2]==='events'?body.kind:suffix[2]==='runs'?'run':suffix[2]):path==='/v1/operations/agentos/executions'?'create':null;
  if(!kind||value.kind!==kind)return false;
  if(suffix)return (value.executionId??value.execution?.id)===suffix[1];
  const execution=value.execution;
  if(!execution||execution.grantId!==body.grantId||execution.grantVersion!==body.expectedGrantVersion||execution.domain!==body.domain)return false;
  const sameStrings=(left:unknown,right:readonly string[])=>Array.isArray(left)&&left.length===right.length&&left.every(item=>typeof item==='string'&&right.includes(item));
  if(!sameStrings(body.actions,execution.actions)||!sameStrings(body.resourceIds,execution.resourceIds))return false;
  const request=body.preparedCommand;
  if(request===null||request===undefined)return value.preparedAction===null;
  if(typeof request!=='object'||!('tool' in request)||!('targetKind' in request)||!('targetId' in request)||!('input' in request)||!request.input||typeof request.input!=='object')return false;
  const prepared=value.preparedAction,input=request.input;
  if(!prepared)return false;
  return prepared.tool===request.tool&&prepared.targetKind===request.targetKind&&prepared.targetId===request.targetId&&['kind','expectedVersion','expectedRevision','reason','until'].every(key=>(prepared.input as unknown as Record<string,unknown>)[key]===(input as Record<string,unknown>)[key]);
}
