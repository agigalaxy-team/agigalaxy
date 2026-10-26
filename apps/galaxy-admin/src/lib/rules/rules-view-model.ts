import type {RulesBusinessRule,RulesCatalog,RulesCondition,RulesControls,RulesDraft,RulesGroup,RulesKey,RulesLocation,RulesPolicy,RulesSample,RulesTab,RulesTrace,RulesVersion} from "../../components/rules/rules-types";

export const rulesKeys:RulesKey[]=['business-controls','resource-budget','community-quota','forum-quota'];
export const rulesNames:Record<RulesKey,string>={'business-controls':'业务规则与名单','resource-budget':'资源额度','community-quota':'参与额度','forum-quota':'论坛额度'};
export const rulesTabs:{id:RulesTab;label:string}[]=[{id:'parameters',label:'常用参数'},{id:'conditions',label:'条件组合'},{id:'lists',label:'名单与例外'},{id:'adoption',label:'生效状态'}];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sequence=(value:string)=>/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n?value:'';
export function rulesLocation(search:Record<string,unknown>):RulesLocation{
 const scalar=(key:string)=>typeof search[key]==='string'?search[key] as string:'';
 const trail=scalar('trail').split(',').filter(value=>value==='first'||!!sequence(value)).slice(-30);
 return {key:rulesKeys.includes(scalar('key') as RulesKey)?scalar('key') as RulesKey:'business-controls',tab:rulesTabs.some(tab=>tab.id===scalar('tab'))?scalar('tab') as RulesTab:'parameters',rule:uuid.test(scalar('rule'))?scalar('rule'):'',list:uuid.test(scalar('list'))?scalar('list'):'',version:uuid.test(scalar('version'))?scalar('version'):'',after:sequence(scalar('after')),trail};
}
export function rulesHref(location:RulesLocation,patch:Partial<RulesLocation>={}){
 const changed=patch.key!==undefined&&patch.key!==location.key,next={...location,...(changed?{rule:'',list:'',version:'',after:'',trail:[]}:{}),...patch};
 const safe=rulesLocation({...next,trail:next.trail.join(',')}),query=new URLSearchParams({key:safe.key,tab:safe.tab});
 for(const name of ['rule','list','version','after'] as const)if(safe[name])query.set(name,safe[name]);if(safe.trail.length)query.set('trail',safe.trail.join(','));return '/admin/operations/rules?'+query;
}
export function rulesPath(kind:'overview'|'detail'|'versions',location:RulesLocation){return kind==='overview'?'/v1/operations/rules/overview':'/v1/operations/rules/'+location.key+'/'+(kind==='detail'?'detail':'versions?'+new URLSearchParams({limit:'20',...(location.after?{after:location.after}:{})}));}
export const rulesClone=<T,>(value:T):T=>structuredClone(value);
export const rulesSame=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export const rulesIsControls=(policy:RulesPolicy):policy is RulesControls=>'schema' in policy&&policy.schema==='business-controls/1';
export const rulesSource=(detail:{active:RulesVersion;draft:RulesVersion|null})=>detail.draft??detail.active;
export function rulesTime(value:string|number|null|undefined){if(value===null||value===undefined)return '未记录';const date=new Date(typeof value==='number'?value*1000:value);return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未记录';}
export const rulesInteger=(value:number|null|undefined)=>typeof value==='number'&&Number.isSafeInteger(value)?value.toLocaleString('zh-CN'):'未知';
export type RulesNumericField={path:string;label:string;min:number;max:number;unit:string};
export type RulesNumericGroup={title:string;fields:RulesNumericField[]};
const f=(path:string,label:string,min:number,max:number,unit='次'):RulesNumericField=>({path,label,min,max,unit});
const quota=(keys:Record<string,string>):RulesNumericGroup[]=>['new','normal'].map(kind=>({title:kind==='new'?'新账户每日额度':'普通账户每日额度',fields:Object.entries(keys).map(([key,label])=>f(kind+'.'+key,label,1,100000))}));
export const rulesNumericFields:Record<Exclude<RulesKey,'business-controls'>,RulesNumericGroup[]>={
 'resource-budget':[{title:'单主体资源',fields:[f('maxPayloadBytesPerSubject','数据存储上限',0,1099511627776,'字节'),f('maxQueuedJobsPerSubject','排队任务上限',1,100000,'项'),f('maxActiveExportsPerSubject','有效导出上限',1,1000,'项')]},{title:'并行处理',fields:[f('maxActiveJobsGlobal','全服务并行任务',1,1000,'项'),f('maxActiveJobsPerSubject','单主体并行任务',1,1000,'项')]}],
 'community-quota':[...quota({task:'任务',comment:'评论',invitation:'邀请'}),{title:'账户与邀请',fields:[f('promotionDays','转为普通账户所需时间',1,365,'天'),f('invitationCooldownDays','邀请冷却时间',1,365,'天')]}],
 'forum-quota':[...quota({post:'发帖',version:'帖子修订',reply:'回复',report:'举报'}),{title:'发布与处理期限',fields:[f('maxPermissionSeconds','内容授权最长时间',60,2592000,'秒'),f('maxGovernanceHideSeconds','治理隐藏最长时间',60,86400,'秒'),f('dailyUsageDays','用量记录保留时间',1,30,'天'),f('auditDays','社区审计保留时间',1,180,'天')]},{title:'内容大小',fields:[f('accountForumMaxBytes','单账户社区数据上限',65536,8388608,'字节'),f('maxTitleCodePoints','标题上限',1,160,'字'),f('maxBodyCodePoints','帖子上限',1,8000,'字'),f('maxReplyCodePoints','回复上限',1,2000,'字'),f('maxReportCodePoints','举报说明上限',1,1600,'字'),f('maxLinks','链接数量上限',0,8,'个'),f('maxLinkCodePoints','单链接长度上限',1,2048,'字'),f('maxPayloadBytes','单次内容上限',4096,49152,'字节')]},{title:'申诉与处理记录',fields:[f('maxAppeals','每案申诉上限',1,3),f('maxReportEvents','每案处理记录上限',4,100,'条')]}],
};
export function rulesNumericValue(policy:RulesPolicy,path:string){const [first,last]=path.split('.'),value=(policy as Record<string,unknown>)[first];return last&&value&&typeof value==='object'?(value as Record<string,unknown>)[last]:value;}
export function rulesSetNumeric(policy:RulesPolicy,path:string,value:string):RulesPolicy{const copy=rulesClone(policy) as Record<string,unknown>,[first,last]=path.split('.'),number=value===''?Number.NaN:Number(value);if(last)copy[first]={...(copy[first] as object),[last]:number};else copy[first]=number;return copy as RulesPolicy;}
export function rulesNewRule(id:string):RulesBusinessRule{return {id,name:'',enabled:false,targets:['forum-post'],conditions:{combinator:'and',rules:[{field:'accountTier',operator:'eq',value:'new'}]},action:'reject',exceptions:[]};}
export function rulesQuery(group:unknown):RulesGroup{
 const node=group as {combinator?:unknown;rules?:unknown[]};return {combinator:node?.combinator==='or'?'or':'and',rules:(Array.isArray(node?.rules)?node.rules:[]).map(child=>{
  if(child&&typeof child==='object'&&'rules' in child)return rulesQuery(child);
  const value=child as RulesCondition;return {field:value?.field,operator:value?.operator,value:typeof value?.value==='number'||typeof value?.value==='string'?value.value:''};
 })};
}
export function rulesValidation(key:RulesKey,policy:RulesPolicy,catalog:RulesCatalog):string[]{
 if(key!=='business-controls')return rulesNumericFields[key].flatMap(group=>group.fields).flatMap(field=>{const value=rulesNumericValue(policy,field.path);return typeof value==='number'&&Number.isSafeInteger(value)&&value>=field.min&&value<=field.max?[]:[field.label+'需要填写 '+field.min+'–'+field.max+' 之间的整数。'];});
 if(!rulesIsControls(policy))return ['当前业务规则格式无法编辑，请重新读取。'];
 const errors:string[]=[],identities=new Set<string>();
 const name=(value:string)=>!!value.trim()&&value.trim().length<=80&&!/[\p{Cc}\p{Cs}]/u.test(value.trim());
 if(policy.rules.length>100||policy.lists.length>50)errors.push('规则或名单数量超出当前支持范围。');
 for(const list of policy.lists){if(!name(list.name))errors.push('请填写名单名称。');if(!uuid.test(list.id)||identities.has(list.id))errors.push('名单记录需要重新读取。');identities.add(list.id);if(list.entries.length>500)errors.push('每份名单最多 500 个条目。');const normalized=list.entries.map(entry=>entry.normalize('NFKC').toLocaleLowerCase('und'));if(new Set(normalized).size!==normalized.length)errors.push('名单中有重复条目，请合并。');if(list.entries.some(entry=>!entry.trim()||entry.length>160||/[\p{Cc}\p{Cs}]/u.test(entry)))errors.push('每个名单条目需要为 1–160 个字符。');if(list.kind==='domain'&&list.entries.some(entry=>{try{const url=new URL('https://'+entry);return !url.hostname.includes('.')||/[/\\:@?#\s]/u.test(entry);}catch{return true;}}))errors.push('域名名单只填写域名，不含网址路径或通配符。');}
 let total=0;
 for(const rule of policy.rules){if(!name(rule.name))errors.push('请填写规则名称。');if(!rule.targets.length)errors.push('请为规则选择适用操作。');if(!uuid.test(rule.id)||identities.has(rule.id))errors.push('规则记录需要重新读取。');identities.add(rule.id);
  const inspect=(node:RulesGroup|RulesCondition,depth:number)=>{if(++total>1000||depth>6){errors.push('条件层级或数量过多。');return;}if('rules' in node){if(!node.rules.length||node.rules.length>20)errors.push('每组需要 1–20 个条件。');node.rules.forEach(child=>inspect(child,depth+1));return;}const field=catalog.fields.find(item=>item.name===node.field);if(!field||rule.targets.some(target=>!field.targets.includes(target))||!field.operators.some(operator=>operator.name===node.operator)){errors.push('有条件不适用于所选操作，请调整条件或适用操作。');return;}if(field.kind==='number'&&(typeof node.value!=='number'||!Number.isSafeInteger(node.value)||node.value<0))errors.push(field.label+'需要填写非负整数。');if(field.kind==='select'&&!field.values?.some(value=>value.name===node.value))errors.push('请选择'+field.label+'。');if(field.kind==='keyword-list'||field.kind==='domain-list'){const kind=field.kind==='keyword-list'?'keyword':'domain';if(!policy.lists.some(list=>list.id===node.value&&list.kind===kind))errors.push('请选择当前存在且类型相符的名单。');}};
  inspect(rule.conditions,0);if(rule.exceptions.length>30)errors.push('每条规则最多 30 组例外。');for(const exception of rule.exceptions){if(!name(exception.name))errors.push('请填写例外名称。');if(!exception.accountIds.length||exception.accountIds.length>100)errors.push('每组例外需要选择 1–100 个账户。');}
 }
 return [...new Set(errors)];
}
export type RulesConflict={path:string;label:string;mine:unknown;current:unknown};
export function rulesMerge(base:RulesPolicy,mine:RulesPolicy,current:RulesPolicy,choices:Record<string,'mine'|'current'>={}){
 const conflicts:RulesConflict[]=[];
 const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
 const merge=(before:unknown,local:unknown,remote:unknown,path:string):unknown=>{
  if(rulesSame(local,before))return rulesClone(remote);if(rulesSame(remote,before)||rulesSame(local,remote))return rulesClone(local);
  if(object(local)&&object(remote)&&object(before)){const result:Record<string,unknown>={};for(const key of new Set([...Object.keys(remote),...Object.keys(local)])){const value=merge(before[key],local[key],remote[key],path?path+'.'+key:key);if(value!==undefined)result[key]=value;}return result;}
  const keyed=(value:unknown)=>Array.isArray(value)&&value.every(item=>object(item)&&typeof item.id==='string');
  if(keyed(before)&&keyed(local)&&keyed(remote)){const a=before as {id:string}[],b=local as {id:string}[],c=remote as {id:string}[],result:unknown[]=[];for(const id of new Set([...c.map(item=>item.id),...b.map(item=>item.id)])){const value=merge(a.find(item=>item.id===id),b.find(item=>item.id===id),c.find(item=>item.id===id),path+'.'+id);if(value!==undefined)result.push(value);}return result;}
  conflicts.push({path,label:rulesConflictLabel(path,mine,current),mine:local,current:remote});return rulesClone(choices[path]==='mine'?local:remote);
 };
 return {policy:merge(base,mine,current,'') as RulesPolicy,conflicts};
}
export function rulesConflictLabel(path:string,...policies:RulesPolicy[]){const parts=path.split('.'),last=parts[parts.length-1];const names:Record<string,string>={features:'功能启停',forumPost:'帖子发布与修订',forumReply:'回复发布',chatSend:'私聊发送与编辑',attachmentUpload:'附件上传',conditions:'组合条件',name:'名称',enabled:'启停状态',targets:'适用操作',entries:'名单条目',accountIds:'例外账户',exceptions:'例外',lists:'名单',rules:'规则'};const numeric=Object.values(rulesNumericFields).flatMap(groups=>groups.flatMap(group=>group.fields)).find(field=>field.path===path);if(numeric)return numeric.label;let owner='';for(const policy of policies)if(rulesIsControls(policy)){for(const item of [...policy.rules,...policy.lists,...policy.rules.flatMap(rule=>rule.exceptions)])if(parts.includes(item.id))owner=item.name||'未命名记录';}return [owner,names[last]??names[parts[0]]??'规则设置'].filter(Boolean).join(' · ');}
export function rulesConflictValue(value:unknown):string{if(value===undefined)return '已移除';if(typeof value==='boolean')return value?'启用':'停用';if(typeof value==='number')return rulesInteger(value);if(typeof value==='string')return value;if(Array.isArray(value))return value.length+' 项';return '已修改的设置';}
export function rulesTraceLabel(node:RulesTrace,catalog:RulesCatalog,policy:RulesControls){if(node.kind==='group')return node.combinator==='or'?'满足任一条件':'同时满足条件';const field=catalog.fields.find(item=>item.name===node.field),operator=field?.operators.find(item=>item.name===node.operator);const value=field?.kind.endsWith('-list')?policy.lists.find(list=>list.id===node.value)?.name??'名单已不可用':field?.values?.find(item=>item.name===node.value)?.label??String(node.value??'未填写');return [field?.label??'条件',operator?.label??'',value].filter(Boolean).join(' ');}
export function rulesSampleFacts(input:Record<string,string>,key:RulesKey):RulesSample{
 const result:Record<string,unknown>={};for(const field of ['target','accountTier','subjectType','quotaCategory'] as const)if(input[field])result[field]=input[field];
 for(const field of ['attachmentCount','fileBytes','used'] as const)if(input[field]?.trim())result[field]=Number(input[field]);
 if(key==='business-controls'){if(input.textProvided==='yes')result.text=input.text??'';if(input.linksProvided==='yes')result.links=(input.links??'').split(/\r?\n/).map(value=>value.trim()).filter(Boolean);if(input.accountId)result.accountId=input.accountId;}
 if(key==='resource-budget')for(const stage of ['before','after']){const names=['payloadBytes','queuedJobs','activeExports'];if(names.every(name=>input[stage+'.'+name]?.trim()))result[stage]=Object.fromEntries(names.map(name=>[name,Number(input[stage+'.'+name])]));}
 return result as RulesSample;
}
export function rulesNewDraft(detail:{revision:number;active:RulesVersion;draft:RulesVersion|null}):RulesDraft{const policy=rulesSource(detail).policy;return {base:rulesClone(policy),policy:rulesClone(policy),revision:detail.revision,reason:''};}
export const rulesErrors:Record<string,string>={operations_rule_revision_changed:'规则已有更新，你的修改已保留。',operations_rule_draft_changed:'草稿已被更新，请合并当前版本后继续。',operations_rule_source_changed:'当前发布版本已变化，请重新读取后继续。',operations_rule_version_unavailable:'这个规则版本暂时无法取得。',operations_rule_version_not_published:'只能恢复已发布的历史版本。',operations_rule_exception_account_unavailable:'所选例外账户已不可用，请重新选择。',operations_command_changed:'原操作内容已变化，请保留当前修改后重新提交。',invalid_operations_rule_request:'请检查规则条件、名单及数值。',operations_policy_not_initialized:'规则暂未就绪，请稍后读取。'};
