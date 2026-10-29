'use client';
import {AutonomyObjectContext} from "../autonomy/AutonomyObjectContext";

import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {FormEvent,ReactNode} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useOperationsRead} from "../../lib/use-operations-read";
import {recoverGovernanceCommand,isGovernanceRecovered,validateGovernanceOperation,governanceRecoveryPendingMessage} from "../../lib/governance-command-recovery";
import type {GovernanceRecovered} from "../../lib/governance-command-recovery";
import {scheduleOperationsDeadline} from "../../lib/schedule-operations-deadline";
import {AccountReference,CommandFeedback,ReadStatus} from "../OperationControls";
import {useOperationCommand} from "../../lib/use-operation-command";
import {AdminIcon} from "../AdminIcons";
import {AdminTabs} from "../AdminTabs";
import {HistoryOperator} from "../HistoryOperator";
import type {OperationsList} from "../operations-business-types";
import {timeLabel} from "../business-types";
import type {CaseDecision,CaseDraft,CaseEvent,CaseFilters,CaseReport,CaseRestrictionAction} from './cases-types';
import {caseAccountLabel,caseActorLabel,caseDecisionBody,caseDurationLabel,caseEventLabel,caseHasRestriction,caseHideDurations,caseResolutions,caseResolutionLabel,caseRecordedAction,caseRestrictionActions,caseRestrictionLabel,casesHref,casesNextHref,casesPreviousHref,casesReadPath,caseSourceLink,caseStateLabel,caseStates,caseTargetLabel,caseTitle,emptyCaseDraft,filterCases} from './cases-types';
import './cases.css';

type Props={filters:CaseFilters;csrfToken:string;canManage:boolean};
type CasePage=OperationsList<CaseReport>&{readExpiresAt?:number};
const errors={forum_report_version_conflict:'这份举报已有新记录，已重新读取。请按当前材料继续。',operations_source_changed:'来源已有更新，请按当前材料继续。',forum_independent_handler_required:'当前管理身份不能处理这份举报。',forum_hide_expiry:'来源或允许的隐藏期限已有变化，请重新读取后继续。'};
const eventNarratives=new Set(['report','supplement','appeal']);
function Empty({title,children}:{title:string;children?:ReactNode}){return <div className="galaxy-cases-empty"><AdminIcon name="governance" size={32}/><h2>{title}</h2>{children&&<p>{children}</p>}</div>;}
function CaseState({value}:{value:string}){return <span className="galaxy-cases-state" data-state={Object.hasOwn(caseStates,value)?value:'unknown'}>{caseStateLabel(value)}</span>;}
function EventActor({event}:{event:CaseEvent}){return <span>{caseActorLabel(event)}{event.accountId&&<> · <AccountReference id={event.accountId}/></>}{event.operatorId&&<> · <HistoryOperator id={event.operatorId} name={event.actorKind==='business-operator'?event.operatorDisplayName:null}/></>}</span>;}
function EventHistory({events}:{events:CaseEvent[]}){return events.length?<ol className="galaxy-cases-history">{events.map(event=><li key={event.id}><div><strong>{caseEventLabel(event)}</strong><time dateTime={event.createdAt}>{timeLabel(event.createdAt)}</time></div>{event.summary&&<p className="galaxy-cases-prose">{event.summary}</p>}{event.resolution&&<p>{caseResolutionLabel(event.resolution)}</p>}{event.restrictionAction&&<p>{caseRecordedAction(event.restrictionAction)}</p>}{event.effectUntil&&<p className="galaxy-cases-muted">本次隐藏至 {timeLabel(event.effectUntil)}</p>}<EventActor event={event}/></li>)}</ol>:<p className="galaxy-cases-muted">暂无可读取的处理记录。</p>;}
function Materials({report}:{report:CaseReport}){
 const narratives=(report.events??[]).filter(event=>eventNarratives.has(event.kind)),appeals=narratives.filter(event=>event.kind==='appeal');
 const ordered=appeals.length?[appeals[appeals.length-1],...narratives.filter(event=>event.id!==appeals[appeals.length-1].id)]:narratives;
 return ordered.length?<div className="galaxy-cases-narratives">{ordered.map(event=><article key={event.id} className="galaxy-cases-narrative" data-kind={event.kind}><header><h3>{caseEventLabel(event)}</h3><time dateTime={event.createdAt}>{timeLabel(event.createdAt)}</time></header>{event.summary?<p className="galaxy-cases-prose">{event.summary}</p>:<p className="galaxy-cases-muted">这条说明当前不可读取。</p>}<EventActor event={event}/></article>)}</div>:<Empty title="暂无可读取的说明">{report.operationsDisclosed?'当前没有可向运营展示的举报或申诉说明。':'原举报说明未向运营开放。'}</Empty>;
}
function Source({report}:{report:CaseReport}){
 const source=report.source;
 if(source?.availability!=='available'||!source.content)return <Empty title="来源当前不可读取">公开范围、有效期限或来源状态变化后，正文可能暂不可用。</Empty>;
 return <article className="galaxy-cases-source"><p className="galaxy-cases-eyebrow">{caseTargetLabel(report)} · 本次举报指向的内容</p><h3>{source.content.title||'回复内容'}</h3><p className="galaxy-cases-prose">{source.content.body}</p>{source.content.links.length>0&&<div className="galaxy-cases-source-links">{source.content.links.map((value,index)=>{const href=caseSourceLink(value);return href?<a key={index} href={href} target="_blank" rel="noreferrer">{value}</a>:null;})}</div>}<a href={'https://agigalaxy.org/app/community?post='+encodeURIComponent(report.target.postId)} target="_blank" rel="noreferrer">打开帖子</a></article>;
}

function DecisionFacts({decision,label}:{decision:CaseDecision;label:string}){
 return <section className="galaxy-cases-decision-meta">
  <h3>{label}</h3>
  <dl className="galaxy-cases-facts">
   <dt>处理结果</dt><dd>{caseResolutionLabel(decision.resolution)}</dd>
   <dt>处理身份</dt>
   <dd>{decision.actorKind==='business-operator'?'运营管理身份':decision.actorKind==='identity'?'银河身份':'未记录'}{decision.actorId&&<> · <HistoryOperator id={decision.actorId} name={decision.actorKind==='business-operator'?decision.operatorDisplayName:null}/></>}</dd>
   <dt>主导方式</dt><dd>未记录</dd>
   <dt>处理时间</dt><dd>{timeLabel(decision.createdAt)}</dd>
   {decision.restrictionAction&&<><dt>本次动作</dt><dd>{caseRecordedAction(decision.restrictionAction)}</dd></>}
   {decision.effectUntil&&<><dt>处置期限</dt><dd>{timeLabel(decision.effectUntil)}</dd></>}
  </dl>
 </section>;
}
function DecisionRecords({report}:{report:CaseReport}){return <div className="galaxy-cases-decision-records">{report.initialDecision?<DecisionFacts decision={report.initialDecision} label="首个可读取的决定"/>:<p className="galaxy-cases-muted">原决定元数据当前未记录或不可读取。</p>}{report.currentDecision&&report.currentDecision.id!==report.initialDecision?.id&&<DecisionFacts decision={report.currentDecision} label="当前决定"/>}</div>;}

export function Cases({filters:location,csrfToken,canManage}:Props){
 const [pendingFilters,setPendingFilters]=useState<CaseFilters|null>(null),filters=pendingFilters??location;
 const router=useRouter(),listPath=casesReadPath(filters);
 const page=useOperationsRead<CasePage>({path:listPath,failureMessage:'举报与申诉列表暂时无法取得。',clearOnOffline:true});
 const [selections,setSelections]=useState<Record<string,string>>({});
 const items=page.value?.items??[],visible=useMemo(()=>filterCases(items,filters),[page.value,filters.query,filters.kind]);
 const selected=filters.selected||selections[listPath]||visible[0]?.id||'';
 const current=useOperationsRead<CaseReport>({path:selected?'/v1/operations/community/reports/'+selected:null,failureMessage:'这份举报暂时无法取得。',clearOnOffline:true});
 const report=current.value,[drafts,setDrafts]=useState<Record<string,CaseDraft>>({});
 const listRef=useRef<HTMLDivElement>(null),materialRef=useRef<HTMLDivElement>(null),handlingRef=useRef<HTMLElement>(null);
 const positions=useRef(new Map<string,number>()),viewKey=selected+':'+filters.view;
 const draft=selected?drafts[selected]??emptyCaseDraft:emptyCaseDraft;
 const setDraft=(change:Partial<CaseDraft>)=>setDrafts(previous=>({...previous,[selected]:{...(previous[selected]??emptyCaseDraft),...change}}));
 const committed=useCallback(async(value:{reportId:string}|GovernanceRecovered)=>{
  const reportId=isGovernanceRecovered(value)?value.targetId:value.reportId;
  if(reportId)setDrafts(previous=>{const next={...previous};delete next[reportId];return next;});
  await current.read();void page.read();
 },[current.read,page.read]);
 const conflict=useCallback(()=>{void current.read();void page.read();},[current.read,page.read]);
 const command=useOperationCommand<{reportId:string}|GovernanceRecovered>({csrfToken,canWrite:canManage&&!!report?.canModerate&&current.verified,canRecover:current.verified||page.verified,recover:recoverGovernanceCommand,validateResult:validateGovernanceOperation,recoveryPendingMessage:governanceRecoveryPendingMessage,onCommitted:committed,onConflict:conflict,errorMessages:errors});
 useEffect(()=>{if(!command.locked)setPendingFilters(null);},[command.locked]);
 const now=Math.floor(Date.now()/1000),hasRestriction=!!report&&caseHasRestriction(report,now),durations=report?caseHideDurations(report,now):[];
 const duration=durations.includes(Number(draft.seconds))?Number(draft.seconds):durations[0];
 const effectiveDraft={...draft,seconds:String(duration??'')};
 const decision=report?caseDecisionBody(report,effectiveDraft,now):null;
 const events=report?.events??[],lastDecision=report?.currentDecision?events.find(event=>event.id===report.currentDecision?.id):[...events].reverse().find(event=>event.kind==='resolve');
 const restrictionActions=report?caseRestrictionActions(report,now):[],availableActions=restrictionActions.filter(action=>action!=='hide'||draft.resolution==='accepted');
 const expiry=report?.source?.publishedUntil;
 useEffect(()=>{if(selected)setSelections(previous=>previous[listPath]===selected?previous:{...previous,[listPath]:selected});},[selected,listPath]);
 useEffect(()=>{
  if(!expiry)return;
  return scheduleOperationsDeadline(expiry*1000,()=>{current.clear();if(navigator.onLine&&document.visibilityState==='visible')void current.read();});
 },[expiry,current.clear,current.read]);
 useLayoutEffect(()=>{if(page.value&&listRef.current)listRef.current.scrollTop=positions.current.get('list:'+listPath)??0;},[listPath,page.value!==null]);
 useLayoutEffect(()=>{if(materialRef.current)materialRef.current.scrollTop=positions.current.get('material:'+viewKey)??0;if(handlingRef.current)handlingRef.current.scrollTop=positions.current.get('handling:'+selected)??0;},[viewKey,report?.id]);
 const navigate=(change:Partial<CaseFilters>,replace=false)=>{
  if(command.locked)return;
  const href=casesHref(filters,{selected,...change});
  if(replace)router.replace(href,{scroll:false});else router.push(href,{scroll:false});
 };
 function filter(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(command.locked)return;const data=new FormData(event.currentTarget);
  navigate({query:String(data.get('q')??''),kind:String(data.get('kind')??'') as CaseFilters['kind']});
 }
 async function submit(){
  if(!report||!current.verified||!canManage||command.locked)return;
  const body=caseDecisionBody(report,effectiveDraft,Math.floor(Date.now()/1000));if(!body)return;
  setPendingFilters({...filters,selected:report.id});
  await command.submit('/v1/operations/community/reports/'+report.id+'/resolve',body,'处理结果已记录。');
 }
 return <section className="galaxy-cases">
  <header className="galaxy-cases-header"><div><h1>举报与申诉</h1><p><AdminIcon name="content" size={14}/>公开帖子与回复</p></div><button className="galaxy-cases-refresh" type="button" disabled={page.loading||current.loading||command.locked} onClick={()=>{void page.read();if(selected)void current.read();}}><AdminIcon name="refresh" size={15}/>刷新记录</button></header>
  <div className="galaxy-cases-layout">
   <section className="galaxy-cases-directory" aria-label="举报与申诉列表">
    <AdminTabs items={[{id:'all',label:'全部'},...Object.entries(caseStates).map(([id,label])=>({id,label}))].map(item=>({...item,disabled:command.locked}))} active={filters.state||'all'} onChange={id=>navigate({state:id==='all'?'':id,after:'',trail:''})} ariaLabel="处理状态"/>
    <form key={filters.query+':'+filters.kind} className="galaxy-cases-filters" onSubmit={filter}><fieldset disabled={command.locked}><label className="galaxy-cases-search"><span>本页关键词</span><div><AdminIcon name="search" size={15}/><input name="q" defaultValue={filters.query} maxLength={160} placeholder="标题、编号或账户"/></div></label><label><span>本页对象</span><select name="kind" defaultValue={filters.kind}><option value="">全部对象</option><option value="post-version">帖子版本</option><option value="reply">回复</option></select></label><button type="submit">筛选</button></fieldset></form>
    <div className="galaxy-cases-list-caption"><span>{page.value?'本页 '+items.length+' 条'+(filters.query||filters.kind?' · 显示 '+visible.length+' 条':''):'每批 25 条'}</span>{(filters.query||filters.kind)&&<button type="button" disabled={command.locked} onClick={()=>navigate({query:'',kind:''})}>清除本页筛选</button>}</div>
    <div className="galaxy-cases-status"><ReadStatus loading={page.loading} error={page.error} retry={page.read}/></div>
    <div className="galaxy-cases-list-columns" aria-hidden="true"><span>举报对象</span><span>状态</span><span>提交时间</span></div>
    <div className="galaxy-cases-list-scroll" ref={listRef} onScroll={event=>{if(page.value)positions.current.set('list:'+listPath,event.currentTarget.scrollTop);}}>
     <ul className="galaxy-cases-list">{visible.map(item=><li key={item.id}><button type="button" className="galaxy-cases-list-item" aria-pressed={selected===item.id} disabled={command.locked} onClick={()=>navigate({selected:item.id})}><span className="galaxy-cases-list-title"><strong>{caseTitle(item)}</strong><span>{item.reporter?caseAccountLabel(item.reporter):item.id.slice(0,8)} · {caseTargetLabel(item)}</span></span><CaseState value={item.state}/><time dateTime={item.createdAt}>{timeLabel(item.createdAt)}</time></button></li>)}</ul>
     {page.value&&!visible.length&&!page.loading&&<Empty title={filters.query||filters.kind?'本页没有匹配记录':'没有相符的举报'}>{filters.query||filters.kind?'可清除本页筛选或继续查看其他批次。':undefined}</Empty>}
    </div>
    <nav className="galaxy-cases-pagination" aria-label="举报记录分页"><span>每批 25 条</span><div>{filters.after&&<><Link href={casesHref(filters,{after:'',trail:'',selected})} scroll={false} aria-disabled={command.locked} onClick={event=>{if(command.locked)event.preventDefault();}}>首批</Link>{filters.trail&&<Link href={casesPreviousHref({...filters,selected})} scroll={false} aria-disabled={command.locked} onClick={event=>{if(command.locked)event.preventDefault();}}>上一批</Link>}</>}{page.value?.nextAfter&&<Link href={casesNextHref({...filters,selected},page.value.nextAfter)} scroll={false} aria-disabled={command.locked} onClick={event=>{if(command.locked)event.preventDefault();}}>下一批</Link>}</div></nav>
   </section>
   <section className="galaxy-cases-material" aria-labelledby="galaxy-case-title">
    <div className="galaxy-cases-status"><ReadStatus loading={current.loading} error={current.error} retry={current.read}/></div>
    {report?<><header className="galaxy-cases-detail-header"><div><span className="galaxy-cases-eyebrow">记录 {report.id.slice(0,8)}</span><CaseState value={report.state}/></div><h2 id="galaxy-case-title">{caseTitle(report)}</h2><dl><dt>提交时间</dt><dd><time dateTime={report.createdAt}>{timeLabel(report.createdAt)}</time></dd><dt>举报账户</dt><dd>{report.reporterAccountId?<AccountReference id={report.reporterAccountId} label={caseAccountLabel(report.reporter)}/>:report.reporterId?<code>{report.reporterId}</code>:'未记录'}</dd><dt>内容作者</dt><dd>{report.targetAuthorAccountId?<AccountReference id={report.targetAuthorAccountId} label={caseAccountLabel(report.targetAuthor)}/>:report.targetAuthorId?<code>{report.targetAuthorId}</code>:'未记录'}</dd></dl></header><AutonomyObjectContext targetType="community-report" targetId={report.id} csrfToken={csrfToken} onChanged={current.read}/>
     <AdminTabs items={[{id:'materials',label:'案件材料'},{id:'source',label:'来源正文'},{id:'history',label:'处理记录'}].map(item=>({...item,disabled:command.locked,panelId:'galaxy-case-material-panel'}))} active={filters.view} onChange={view=>navigate({view:view as CaseFilters['view']},true)} ariaLabel="举报详情"/>
     <div className="galaxy-cases-material-scroll" id="galaxy-case-material-panel" role="tabpanel" aria-label={filters.view==='source'?'来源正文':filters.view==='history'?'处理记录':'案件材料'} ref={materialRef} onScroll={event=>positions.current.set('material:'+viewKey,event.currentTarget.scrollTop)}>
      {selected&&!visible.some(item=>item.id===selected)&&page.value&&<p className="galaxy-cases-selected-note">当前记录不在本页筛选范围内。</p>}
      {filters.view==='source'?<Source report={report}/>:filters.view==='history'?<><DecisionRecords report={report}/><EventHistory events={events}/></>:<Materials report={report}/>}
     </div></>:!current.loading&&!current.error&&<Empty title={selected?'暂无可读取的记录':'选择一份举报'}>{selected?undefined:'查看材料与处理记录。'}</Empty>}
   </section>
   <aside className="galaxy-cases-handling" aria-label="处理与记录" ref={handlingRef} onScroll={event=>{if(report)positions.current.set('handling:'+selected,event.currentTarget.scrollTop);}}>
    {report?<><section className="galaxy-cases-handling-section"><h2>当前处置</h2><dl className="galaxy-cases-facts"><dt>处理状态</dt><dd><CaseState value={report.state}/></dd><dt>主导方式</dt><dd>未记录</dd><dt>本案隐藏</dt><dd>{hasRestriction?'至 '+timeLabel(report.currentEffect?.until??report.restrictedUntil):(report.currentEffect?.until??report.restrictedUntil)?'已到期':'无有效隐藏'}</dd>{report.closedAt&&<><dt>结案时间</dt><dd>{timeLabel(report.closedAt)}</dd></>}</dl>{lastDecision&&<div className="galaxy-cases-last-decision"><h3>最近已记录的处理</h3><p>{caseResolutionLabel(lastDecision.resolution)}</p>{lastDecision.summary&&<p className="galaxy-cases-prose">{lastDecision.summary}</p>}<p><EventActor event={lastDecision}/></p><time dateTime={lastDecision.createdAt}>{timeLabel(lastDecision.createdAt)}</time></div>}</section>
     <section className="galaxy-cases-handling-section">
      <h2>{report.state==='appealed'?'申诉复核':'处理这份举报'}</h2>
      {report.knownPartyConflict?<p className="galaxy-cases-warning"><AdminIcon name="warning" size={16}/>此案涉及当前管理身份，需其他管理人员处理。</p>
       :!canManage?<p className="galaxy-cases-muted">当前没有举报处理权限。</p>
       :!report.canModerate?<p className="galaxy-cases-muted">{report.state==='resolved'?'处理结果已记录。':report.state==='withdrawn'?'举报已撤回。':'当前不能处理这份举报。'}</p>
       :!restrictionActions.length?<p className="galaxy-cases-warning"><AdminIcon name="info" size={16}/>现有处置仍生效，当前没有可用的复核操作。</p>
       :<form className="galaxy-cases-decision" onSubmit={event=>{event.preventDefault();void submit();}}>
        <fieldset disabled={command.locked||current.loading||!current.verified}>
         <label>处理结果<select value={draft.resolution} onChange={event=>setDraft({resolution:event.target.value,...(draft.restrictionAction==='hide'&&event.target.value!=='accepted'?{restrictionAction:'keep'}:{})})} required><option value="">选择处理结果</option>{Object.entries(caseResolutions).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
         <label>处理说明<textarea value={draft.summary} onChange={event=>setDraft({summary:event.target.value})} minLength={3} maxLength={1600} rows={5} required placeholder="记录本次判断及依据"/></label>
         {(availableActions.length>1||!availableActions.includes(draft.restrictionAction))&&<label>本案内容显示<select value={availableActions.includes(draft.restrictionAction)?draft.restrictionAction:''} onChange={event=>setDraft({restrictionAction:event.target.value as CaseRestrictionAction})} required>{!availableActions.includes(draft.restrictionAction)&&<option value="">显示状态已有变化，请重新选择</option>}{availableActions.map(action=><option key={action} value={action}>{caseRestrictionLabel(action,hasRestriction)}</option>)}</select></label>}
         {availableActions.length===1&&availableActions[0]==='keep'&&hasRestriction&&<p className="galaxy-cases-muted">本次维持本案现有隐藏。</p>}
         {draft.restrictionAction==='release'&&availableActions.includes('release')&&<p className="galaxy-cases-muted">只解除本案形成的隐藏，其他处置继续生效。</p>}
         {draft.restrictionAction==='hide'&&availableActions.includes('hide')&&<label>隐藏时长<select value={duration??''} onChange={event=>setDraft({seconds:event.target.value})} required>{!durations.length&&<option value="">当前来源已不可暂时隐藏</option>}{durations.map(value=><option value={value} key={value}>{caseDurationLabel(value)}</option>)}</select></label>}
         <button type="submit" disabled={!decision}>记录处理结果</button>
        </fieldset>
       </form>}
      <div className="galaxy-cases-command"><CommandFeedback command={command}/></div>
      {report.resultDelivery?.channel==='original-case-read'&&report.resultDelivery.state==='readable'&&<p className="galaxy-cases-delivery">结果反馈：原案件内查看。{report.resultDelivery.notification==='not-connected'&&<span>主动通知未接通。</span>}</p>}
     </section>
     <section className="galaxy-cases-handling-section galaxy-cases-recent"><h2><AdminIcon name="history" size={16}/>最近记录</h2><EventHistory events={events.slice(-3)}/>{events.length>3&&<button type="button" className="galaxy-cases-text-button" disabled={command.locked} onClick={()=>navigate({view:'history'},true)}>查看全部已记录过程</button>}<Link href={'/admin/operations/audit?resource='+report.id}>查看业务审计</Link></section>
    </>:<Empty title="尚未选择记录"/>}
   </aside>
  </div>
 </section>;
}
