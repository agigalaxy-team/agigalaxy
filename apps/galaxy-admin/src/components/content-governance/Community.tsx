'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {GuardedGetForm} from "../GuardedGetForm";
import Link from 'next/link';
import {useOperationsRead} from "../../lib/use-operations-read";
import {recoverGovernanceCommand,isGovernanceRecovered,validateGovernanceOperation,governanceRecoveryPendingMessage} from "../../lib/governance-command-recovery";
import {scheduleOperationsDeadline} from "../../lib/schedule-operations-deadline";
import {AccountReference,CommandFeedback,ReadStatus} from "../OperationControls";
import {useOperationCommand} from "../../lib/use-operation-command";
import type {ForumReport,ForumSource,ManagedSection,SectionPage} from './community-operations-types';
import {forumReportStates,forumResolutions} from './community-operations-types';
import type {OperationsList} from "../operations-business-types";
import {untilLabel} from "../operations-business-types";
import {timeLabel} from "../business-types";
import {PublicContent} from './PublicContent';
import type {PublicContentProps} from './public-content-types';
type Props={tab:'sections'|'posts'|'reports';selected:string;after:string;state:string;category:string;csrfToken:string;canManage:boolean;publicContent?:Pick<PublicContentProps,'selectedKind'|'contentTab'|'filters'>};
const errors={forum_section_version_conflict:'版块已有更新，请按当前记录继续。',forum_report_version_conflict:'举报已有新记录，请按当前内容继续。',operations_source_changed:'来源已有更新，请按当前内容继续。',operations_visibility_changed:'显示状态已更新，请按当前记录继续。',forum_independent_handler_required:'此案不能由当前管理身份处理。',forum_hide_expiry:'来源或处理期限已变化，请读取后继续。',operations_hide_expiry:'所选处理时间已失效，请重新选择。'};
const pageLink=(tab:Props['tab'],values:Record<string,string>={})=>'/admin/operations/community?'+new URLSearchParams({tab,...values});
function Source({value}:{value:ForumSource|undefined}){return value?.availability==='available'&&value.content?<div><h3>{value.content.title||'回复内容'}</h3><p className="galaxy-operational-body">{value.content.body}</p>{value.content.links.map(link=><p key={link}><a href={link} target="_blank" rel="noreferrer">{link}</a></p>)}<p><a href={'https://agigalaxy.org/app/community?post='+value.locator.postId} target="_blank" rel="noreferrer">打开原帖</a></p></div>:<p>来源当前非公开或不可读。</p>;}
function Pages({tab,after,next,filters,locked=false}:{tab:Props['tab'];after:string;next:string|null;filters?:Record<string,string>;locked?:boolean}){return <nav className="galaxy-operation-actions" aria-label="记录分页">{after&&<Link href={pageLink(tab,filters)} aria-disabled={locked||undefined} tabIndex={locked?-1:undefined} onClick={event=>{if(locked)event.preventDefault();}}>返回首批</Link>}{next&&<Link href={pageLink(tab,{...filters,after:next})} aria-disabled={locked||undefined} tabIndex={locked?-1:undefined} onClick={event=>{if(locked)event.preventDefault();}}>下一页</Link>}</nav>;}
function Sections(props:Props){
  type Location=Pick<Props,'selected'|'after'|'state'|'category'>;
  type Draft={newCategory:string|null;reason:string;seconds:string};
  const [held,setHeld]=useState<Location|null>(null),[drafts,setDrafts]=useState<Record<string,Draft>>({}),[commandFor,setCommandFor]=useState('');
  const {selected,after,state,category}=held??props,{csrfToken,canManage}=props;
  const filters={...(state?{state}:{}),...(category?{category}:{})};
  const page=useOperationsRead<SectionPage>({path:'/v1/operations/community/sections?'+new URLSearchParams({limit:'25',...filters,...(after?{after}:{})}),failureMessage:'版块列表暂时无法取得。'});
  const current=useOperationsRead<ManagedSection>({path:selected?'/v1/operations/community/sections/'+selected:null,failureMessage:'这个版块暂时无法取得。',clearOnOffline:true});
  const detail=current.value,draft=drafts[selected]??{newCategory:null,reason:'',seconds:'3600'},{newCategory,reason,seconds}=draft;
  const intent=useRef<{selected:string;draft:Draft}|null>(null);
  const committed=useCallback(async()=>{
    const done=intent.current;
    if(done)setDrafts(previous=>{const value=previous[done.selected];return value&&value.newCategory===done.draft.newCategory&&value.reason===done.draft.reason&&value.seconds===done.draft.seconds?{...previous,[done.selected]:{...value,reason:'',newCategory:null}}:previous;});
    intent.current=null;await current.read();void page.read();
  },[current.read,page.read]);
  const conflict=useCallback(()=>{void current.read();},[current.read]);
  const command=useOperationCommand({csrfToken,canWrite:canManage&&!!detail&&(detail.canManage||detail.canHide||detail.canRestore)&&current.verified,canRecover:current.verified||page.verified,recover:recoverGovernanceCommand,validateResult:validateGovernanceOperation,recoveryPendingMessage:governanceRecoveryPendingMessage,onCommitted:committed,onConflict:conflict,errorMessages:errors});
  useEffect(()=>{if(!command.locked&&held)setHeld(null);},[command.locked,held]);
  function edit(patch:Partial<Draft>){if(command.locked)return;setDrafts(previous=>({...previous,[selected]:{...draft,...patch}}));}
  const categoryLabel=(id:string)=>page.value?.categories.find(value=>value.id===id)?.label??id;
  const durations=detail?[900,3600,21600,detail.maxHideSeconds].filter((value,index,all)=>value<=detail.maxHideSeconds&&all.indexOf(value)===index).sort((a,b)=>a-b):[];
  const duration=durations.includes(Number(seconds))?Number(seconds):durations[0];
  async function mutate(kind:'classification'|'visibility'){
    if(command.locked||!detail||!canManage||!current.verified||current.loading||!(kind==='classification'?detail.canManage:detail.visibility.hidden?detail.canRestore:detail.canHide))return;
    intent.current={selected,draft:{...draft}};setCommandFor(selected);setHeld({selected,after,state,category});
    await command.submit('/v1/operations/community/sections/'+detail.id+'/'+kind,{expectedVersion:detail.version,reason,...(kind==='classification'?{category:newCategory??detail.category}:{kind:detail.visibility.hidden?'restore':'hide',expectedVisibilityVersion:detail.visibility.version,...(!detail.visibility.hidden?{until:Math.floor(Date.now()/1000)+duration}:{})})},kind==='classification'?'版块归类已更新。':detail.visibility.hidden?'已解除运营隐藏。':'版块已暂时隐藏。');
  }
  return <>
    <GuardedGetForm key={state+':'+category} method="get" action="/admin/operations/community" className="galaxy-user-search" blocked={command.locked}>
      <input type="hidden" name="tab" value="sections"/>
      <label>版块状态<select name="state" defaultValue={state} disabled={command.locked}><option value="">全部</option><option value="active">活动中</option><option value="archived">已归档</option></select></label>
      <label>全站分类<select name="category" defaultValue={category} disabled={command.locked}><option value="">全部分类</option>{page.value?.categories.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <button type="submit" disabled={command.locked}>筛选</button>
    </GuardedGetForm>
    <ReadStatus loading={page.loading} error={page.error} retry={page.read}/>
    {page.value&&<>
      <div className="galaxy-table-scroll"><table><thead><tr><th>版块</th><th>维护者</th><th>分类</th><th>状态</th><th>运营显示</th></tr></thead><tbody>{page.value.items.map(item=><tr key={item.id}>
        <th><Link href={pageLink('sections',{...filters,id:item.id})} aria-disabled={command.locked||undefined} tabIndex={command.locked?-1:undefined} onClick={event=>{if(command.locked)event.preventDefault();}}>{item.title||'受限版块'}</Link></th>
        <td><AccountReference id={item.maintainerAccountId} label={item.maintainerDisplayName||item.maintainerUid}/></td><td>{categoryLabel(item.category)}</td><td>{item.state==='active'?'活动中':'已归档'}</td><td>{item.visibility.hidden?'隐藏至 '+untilLabel(item.visibility.until):'正常'}</td>
      </tr>)}</tbody></table></div>
      {!page.value.items.length&&<p>没有相符的版块。</p>}
      <Pages tab="sections" after={after} next={page.value.nextAfter} filters={filters} locked={command.locked}/>
    </>}
    {commandFor===selected&&<CommandFeedback command={command}/>}
    {selected&&<section><ReadStatus loading={current.loading} error={current.error} retry={current.read}/>{detail&&<>
      <h2>{detail.title||'受限版块'}</h2><p>{detail.theme}</p><p className="galaxy-operational-body">{detail.description}</p>{detail.sourceState==='restricted'&&<p>版块介绍不在当前公开范围内。</p>}
      <dl className="galaxy-operational-facts"><dt>维护者</dt><dd><AccountReference id={detail.maintainerAccountId} label={detail.maintainerDisplayName||detail.maintainerUid}/></dd><dt>全站分类</dt><dd>{categoryLabel(detail.category)}</dd><dt>运营显示</dt><dd>{detail.visibility.hidden?'隐藏至 '+untilLabel(detail.visibility.until):'正常'}</dd><dt>更新时间</dt><dd>{timeLabel(detail.updatedAt)}</dd></dl>
      {canManage&&(detail.canManage||detail.canHide||detail.canRestore)&&<form onSubmit={event=>{event.preventDefault();void mutate('classification');}}><fieldset disabled={command.locked||!current.verified||current.loading}>
        <label>处理说明<textarea value={reason} onChange={event=>edit({reason:event.target.value})} minLength={3} maxLength={1600} required/></label>
        <label>全站分类<select disabled={!detail.canManage} value={newCategory??detail.category} onChange={event=>edit({newCategory:event.target.value})}>{page.value?.categories.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <button type="submit" disabled={!detail.canManage||!page.value?.categories.length||(newCategory??detail.category)===detail.category}>保存分类</button>
        {!detail.visibility.hidden&&<label>隐藏时长<select value={duration} onChange={event=>edit({seconds:event.target.value})}>{durations.map(value=><option key={value} value={value}>{value>=3600?value/3600+' 小时':value/60+' 分钟'}</option>)}</select></label>}
        {(detail.canHide||detail.canRestore)&&<button type="button" className="galaxy-secondary" disabled={reason.trim().length<3||(detail.visibility.hidden?!detail.canRestore:!detail.canHide)} onClick={()=>void mutate('visibility')}>{detail.visibility.hidden?'解除运营隐藏':'暂时隐藏版块'}</button>}
      </fieldset></form>}
      <p><Link href={'/admin/operations/audit?resource='+detail.id} aria-disabled={command.locked||undefined} tabIndex={command.locked?-1:undefined} onClick={event=>{if(command.locked)event.preventDefault();}}>处理记录</Link></p>
    </>}</section>}
  </>;
}
function Reports({selected,after,state,csrfToken,canManage}:Props){
  const page=useOperationsRead<OperationsList<ForumReport>>({path:'/v1/operations/community/reports?'+new URLSearchParams({limit:'25',...(state?{state}:{}),...(after?{after}:{})}),failureMessage:'社区举报暂时无法取得。'});
  const current=useOperationsRead<ForumReport>({path:selected?'/v1/operations/community/reports/'+selected:null,failureMessage:'这份举报暂时无法取得。',clearOnOffline:true});
  const detail=current.value,[resolution,setResolution]=useState(''),[summary,setSummary]=useState(''),[hide,setHide]=useState(false),[seconds,setSeconds]=useState('3600');
  const committed=useCallback(async(value:unknown)=>{await current.read();void page.read();if(!isGovernanceRecovered(value)){setSummary('');setResolution('');setHide(false);}},[current.read,page.read]);
  const conflict=useCallback(()=>{void current.read();},[current.read]);
  const command=useOperationCommand({csrfToken,canWrite:canManage&&!!detail?.canModerate&&current.verified,canRecover:current.verified||page.verified,recover:recoverGovernanceCommand,validateResult:validateGovernanceOperation,recoveryPendingMessage:governanceRecoveryPendingMessage,onCommitted:committed,onConflict:conflict,errorMessages:errors});
  const expiry=detail?.source?.publishedUntil;
  useEffect(()=>{if(!expiry)return;return scheduleOperationsDeadline(expiry*1000,()=>{current.clear();if(navigator.onLine&&document.visibilityState==='visible')void current.read();});},[expiry,current.clear,current.read]);
  const maximum=detail?Math.max(0,Math.min(detail.maxHideSeconds,(detail.source?.publishedUntil??detail.checkedAt)-detail.checkedAt)):0;
  const durations=[900,3600,21600,maximum].filter((value,index,all)=>value>0&&value<=maximum&&all.indexOf(value)===index).sort((a,b)=>a-b),duration=durations.includes(Number(seconds))?Number(seconds):durations[0];
  async function submit(){if(!detail||!resolution||!current.verified)return;const until=hide&&resolution==='accepted'?Math.min(Math.floor(Date.now()/1000)+duration,detail.source?.publishedUntil??0):undefined;await command.submit('/v1/operations/community/reports/'+detail.id+'/resolve',{expectedVersion:detail.version,resolution,summary,...(until?{hideUntil:until}:{})},'处理结果已记录。');}
  return <><form method="get" action="/admin/operations/community" className="galaxy-user-search"><input type="hidden" name="tab" value="reports"/><label>处理状态<select name="state" defaultValue={state}><option value="">全部</option>{Object.entries(forumReportStates).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><button type="submit">筛选</button></form><ReadStatus loading={page.loading} error={page.error} retry={page.read}/>{page.value&&<><div className="galaxy-table-scroll"><table><thead><tr><th>举报</th><th>状态</th><th>对象</th><th>提交时间</th></tr></thead><tbody>{page.value.items.map(item=><tr key={item.id}><th><Link href={pageLink('reports',{...(state?{state}:{}),id:item.id})}>查看举报</Link></th><td>{forumReportStates[item.state]}</td><td>{item.target.kind==='reply'?'回复':'帖子版本'}</td><td>{timeLabel(item.createdAt)}</td></tr>)}</tbody></table></div>{!page.value.items.length&&<p>没有相符的举报。</p>}<Pages tab="reports" after={after} next={page.value.nextAfter} filters={state?{state}:{}}/></>}<CommandFeedback command={command}/>
    {selected&&<section><ReadStatus loading={current.loading} error={current.error} retry={current.read}/>{detail&&<><h2>举报详情</h2><p>{forumReportStates[detail.state]} · {timeLabel(detail.createdAt)}</p><div className="galaxy-operation-detail"><div><Source value={detail.source}/><h3>材料与处理经过</h3>{detail.events?.length?<ol className="galaxy-records">{detail.events.map(event=><li key={event.id}><strong>{event.kind==='resolve'?'处理结果':event.kind==='appeal'?'申诉':event.kind==='supplement'?'补充说明':'举报说明'}</strong>{event.summary&&<p>{event.summary}</p>}{event.resolution&&<p>{forumResolutions[event.resolution]??event.resolution}</p>}<span>{event.actorKind==='business-operator'?'运营处理':'当事账户提交'} · {timeLabel(event.createdAt)}</span>{event.effectUntil&&<span>有效至 {timeLabel(event.effectUntil)}</span>}</li>)}</ol>:<p>{detail.operationsDisclosed?'当前没有可读的说明记录。':'原举报说明未向运营开放。'}</p>}</div><div><dl className="galaxy-operational-facts"><dt>举报账户</dt><dd>{detail.reporterAccountId?<AccountReference id={detail.reporterAccountId}/>:detail.reporterId||'未记录'}</dd><dt>内容作者</dt><dd>{detail.targetAuthorAccountId?<AccountReference id={detail.targetAuthorAccountId}/>:detail.targetAuthorId||'未记录'}</dd><dt>当前限制</dt><dd>{detail.restrictedUntil?timeLabel(detail.restrictedUntil):'无当前限制'}</dd></dl>{detail.knownPartyConflict&&<p>此案涉及当前管理身份，不能由你处理。</p>}{canManage&&detail.canModerate&&<form onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={command.locked||current.loading||!current.verified}><label>处理结果<select value={resolution} onChange={event=>setResolution(event.target.value)} required><option value="">选择处理结果</option>{Object.entries(forumResolutions).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>处理说明<textarea value={summary} onChange={event=>setSummary(event.target.value)} minLength={3} maxLength={1600} required/></label>{resolution==='accepted'&&maximum>0&&<><label className="galaxy-checkbox-label"><input type="checkbox" checked={hide} onChange={event=>setHide(event.target.checked)}/>暂时隐藏相关内容</label>{hide&&<label>隐藏时长<select value={duration} onChange={event=>setSeconds(event.target.value)}>{durations.map(value=><option key={value} value={value}>{value>=3600?value/3600+' 小时':value/60+' 分钟'}</option>)}</select></label>}</>}<button type="submit">记录处理结果</button></fieldset></form>}<p><Link href={'/admin/operations/audit?resource='+detail.id}>操作记录</Link></p></div></div></>}</section>}
  </>;
}
export function Community(props:Props){
  if(props.tab==='posts')return <PublicContent selected={props.selected} selectedKind={props.publicContent?.selectedKind??'post'} contentTab={props.publicContent?.contentTab??'content'} filters={props.publicContent?.filters??{query:'',kind:'',topic:'',visibility:'',pinned:'',featured:'',days:'all',after:props.after}} csrfToken={props.csrfToken} canManage={props.canManage}/>;
  return <section className="galaxy-business-users"><header><h1>{props.tab==='reports'?'举报与申诉':'版块与分类'}</h1></header>{props.tab==='sections'?<Sections {...props}/>:<Reports {...props}/>}</section>;
}
