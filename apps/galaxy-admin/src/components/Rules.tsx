'use client';
import {useCallback,useEffect,useState} from 'react';
import Link from 'next/link';
import {useOperationsRead} from '../lib/use-operations-read';
import {CommandFeedback,ReadStatus,useOperationCommand} from './OperationControls';
import type {ProductRule,RuleDetail,RuleKey,RuleList,RuleSaved} from './operations-product-types';
import {ruleLabels} from './operations-product-types';
import {timeLabel} from './business-types';
type Field={path:string;label:string;min:number;max:number};
type FieldGroup={title:string;fields:Field[]};
const field=(path:string,label:string,min:number,max:number):Field=>({path,label,min,max});
const quota=(keys:Record<string,string>):FieldGroup[]=>['new','normal'].map(kind=>({title:kind==='new'?'新账户每日额度':'普通账户每日额度',fields:Object.entries(keys).map(([key,label])=>field(kind+'.'+key,label,1,100000))}));
const fields:Record<RuleKey,FieldGroup[]>={
  'resource-budget':[{title:'单主体资源',fields:[field('maxPayloadBytesPerSubject','数据存储上限（字节）',0,1099511627776),field('maxQueuedJobsPerSubject','排队任务上限',1,100000),field('maxActiveExportsPerSubject','有效导出上限',1,1000)]},{title:'并行处理',fields:[field('maxActiveJobsGlobal','全服务并行任务',1,1000),field('maxActiveJobsPerSubject','单主体并行任务',1,1000)]}],
  'community-quota':[...quota({task:'任务',comment:'评论',invitation:'邀请'}),{title:'账户与邀请',fields:[field('promotionDays','转为普通账户所需天数',1,365),field('invitationCooldownDays','邀请冷却天数',1,365)]}],
  'forum-quota':[...quota({post:'发帖',version:'帖子修订',reply:'回复',report:'举报'}),{title:'发布与处理期限',fields:[field('maxPermissionSeconds','内容授权最长时间（秒）',60,2592000),field('maxGovernanceHideSeconds','治理隐藏最长时间（秒）',60,86400),field('dailyUsageDays','用量记录保留天数',1,30),field('auditDays','社区审计保留天数',1,180)]},{title:'内容大小',fields:[field('accountForumMaxBytes','单账户社区数据上限（字节）',65536,8388608),field('maxTitleCodePoints','标题字数上限',1,160),field('maxBodyCodePoints','帖子字数上限',1,8000),field('maxReplyCodePoints','回复字数上限',1,2000),field('maxReportCodePoints','举报说明字数上限',1,1600),field('maxLinks','链接数量上限',0,8),field('maxLinkCodePoints','单链接长度上限',1,2048),field('maxPayloadBytes','单次内容上限（字节）',4096,49152)]},{title:'申诉与处理记录',fields:[field('maxAppeals','每案申诉上限',1,3),field('maxReportEvents','每案处理记录上限',4,100)]}],
};
function values(rule:ProductRule):Record<string,string>{return Object.fromEntries(fields[rule.key].flatMap(group=>group.fields).map((item):[string,string]=>{const [first,last]=item.path.split('.'),section=rule.policy[first];const value=last&&section&&typeof section==='object'?(section as Record<string,unknown>)[last]:section;return [item.path,typeof value==='number'?String(value):''];}));}
const ruleErrors={operations_policy_version_changed:'规则已有新版本，你的修改仍保留，请查看当前规则。',invalid_operations_product_request:'规则数值超出允许范围，请检查对应字段。'};
function ChangedRuleFields({base,current,draft}:{base:ProductRule;current:ProductRule;draft:Record<string,string>}){
  if(base.version===current.version)return null;
  const before=values(base),latest=values(current),changed=fields[base.key].flatMap(group=>group.fields).filter(item=>before[item.path]!==latest[item.path]);
  return changed.length?<div className="galaxy-table-scroll"><table><caption>其他操作已更新的设置</caption><thead><tr><th>设置</th><th>当前已保存</th><th>你的输入</th></tr></thead><tbody>{changed.map(item=><tr key={item.path}><th>{item.label}</th><td>{latest[item.path]}</td><td>{draft[item.path]}</td></tr>)}</tbody></table></div>:null;
}
function RuleEditor({value,csrfToken,canManage,refresh}:{value:RuleDetail;csrfToken:string;canManage:boolean;refresh:()=>Promise<unknown>}){
  const [base,setBase]=useState(value.rule),[draft,setDraft]=useState(()=>values(value.rule));
  const committed=useCallback(async(result:RuleSaved)=>{setBase(result.rule);setDraft(values(result.rule));await refresh();},[refresh]);
  const conflict=useCallback(()=>{void refresh();},[refresh]);
  const command=useOperationCommand<RuleSaved>({csrfToken,canWrite:canManage,onCommitted:committed,onConflict:conflict,errorMessages:ruleErrors});
  async function save(){const policy=structuredClone(base.policy);for(const [path,text]of Object.entries(draft)){const [first,last]=path.split('.');if(last){const previous=policy[first];policy[first]={...(previous&&typeof previous==='object'?previous:{}),[last]:Number(text)};}else policy[first]=Number(text);}await command.submit('/v1/operations/rules/'+base.key,{expectedVersion:base.version,policy},'规则已保存，正在等待相关进程采用。');}
  return <><p className="galaxy-operation-basis">当前版本 {value.rule.version} · {value.rule.source==='business-operator'?'运营调整':'服务配置'} · {timeLabel(value.rule.createdAt)}</p>{base.version!==value.rule.version&&<p className="galaxy-error">当前规则已有新版本。你的输入仍保留。<button type="button" disabled={command.locked} onClick={()=>{setBase(value.rule);setDraft(values(value.rule));}}>使用当前规则</button></p>}<ChangedRuleFields base={base} current={value.rule} draft={draft}/><form onSubmit={event=>{event.preventDefault();void save();}}><fieldset disabled={!canManage||command.locked}>{fields[base.key].map(group=><section className="galaxy-rule-group" key={group.title}><h3>{group.title}</h3><div className="galaxy-operation-fields">{group.fields.map(item=><label key={item.path}>{item.label}<input type="number" min={item.min} max={item.max} step="1" required value={draft[item.path]} onChange={event=>setDraft(previous=>({...previous,[item.path]:event.target.value}))}/></label>)}</div></section>)}{canManage&&<button type="submit">保存规则</button>}</fieldset></form><CommandFeedback command={command}/></>;
}
export function Rules({selected,csrfToken,canManage}:{selected:RuleKey;csrfToken:string;canManage:boolean}){
  const directory=useOperationsRead<RuleList>({path:'/v1/operations/rules',failureMessage:'规则目录暂时无法取得。'});
  const current=useOperationsRead<RuleDetail>({path:'/v1/operations/rules/'+selected,failureMessage:'当前规则暂时无法取得。'});
  const [historyAfter,setHistoryAfter]=useState('');
  const history=useOperationsRead<{items:ProductRule[];nextAfter:string|null}>({path:historyAfter?'/v1/operations/rules/'+selected+'/history?'+new URLSearchParams({limit:'20',...(historyAfter==='first'?{}:{after:historyAfter})}):null,failureMessage:'规则历史暂时无法取得。'});
  useEffect(()=>{if(!current.value||current.loading||current.value.processes.every(item=>item.current)&&current.value.processes.length)return;const timer=setTimeout(()=>{if(navigator.onLine&&document.visibilityState==='visible')void current.read();},5000);return()=>clearTimeout(timer);},[current.value,current.loading,current.read]);
  return <section className="galaxy-business-users"><header><h1>运营规则</h1></header><nav className="galaxy-operations-tabs" aria-label="规则类型">{Object.entries(ruleLabels).map(([key,label])=><Link key={key} href={'/admin/operations/rules?key='+key} aria-current={selected===key?'page':undefined}>{label}</Link>)}</nav><ReadStatus loading={current.loading} error={current.error} retry={current.read}/>{current.value&&<><RuleEditor key={selected} value={current.value} csrfToken={csrfToken} canManage={canManage&&current.verified} refresh={current.read}/><section><h2>实际采用状态</h2>{current.value.processes.length?<ul className="galaxy-records">{current.value.processes.map(item=><li key={item.component+item.instanceId}><strong>{item.component} · {item.instanceId}</strong><p>{item.current?'已采用当前版本':!item.fresh?'近期状态尚未更新':item.errorCode?'采用失败':'等待采用'}{item.adoptedVersion!==null?' · 已采用版本 '+item.adoptedVersion:''}</p>{item.errorCode&&<code>{item.errorCode}</code>}<time>{timeLabel(item.checkedAt)}</time></li>)}</ul>:<p>尚未取得相关进程的采用记录。</p>}</section></>}
    <section><h2>规则历史</h2>{!historyAfter?<button type="button" className="galaxy-secondary" onClick={()=>setHistoryAfter('first')}>查看历史版本</button>:<><ReadStatus loading={history.loading} error={history.error} retry={history.read}/>{history.value&&<><ul className="galaxy-records">{history.value.items.map(rule=><li key={rule.version}><strong>版本 {rule.version}</strong><time>{timeLabel(rule.createdAt)}</time><dl className="galaxy-audit-metadata">{fields[rule.key].flatMap(group=>group.fields).map(item=><div key={item.path} style={{display:'contents'}}><dt>{item.label}</dt><dd>{values(rule)[item.path]}</dd></div>)}</dl></li>)}</ul>{history.value.nextAfter&&<button type="button" onClick={()=>setHistoryAfter(history.value!.nextAfter!)}>更早版本</button>}</>}</>}</section>
    {directory.value?.protectedSources.length?<p className="galaxy-operation-basis">签名治理规则仍使用原有独立审阅与签署流程。</p>:null}
  </section>;
}
