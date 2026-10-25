'use client';

import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useTransition} from 'react';
import type {ReactNode} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {AdminIcon} from '../AdminIcons';
import {HistoryOperator} from '../HistoryOperator';
import {FeedbackAttachments} from './FeedbackAttachments';
import {CommandFeedback,ReadStatus} from '../OperationControls';
import {SettingsDraftBoundary,useSettingsDraftState} from '../SettingsDraftBoundary';
import {useSettingsDraftMemory} from '../../lib/use-settings-draft-memory';
import {useFeedbackCommand} from '../../lib/use-feedback-command';
import {feedbackDraft as createDraft,feedbackDraftChanged as changed} from '../../lib/feedback-draft-memory';
import type {FeedbackDraft as Draft} from '../../lib/feedback-draft-memory';
import {useOperationsRead} from '../../lib/use-operations-read';
import type {FeedbackCategory,FeedbackDetail,FeedbackEvent,FeedbackItem,FeedbackModule,FeedbackPage,FeedbackProps,FeedbackSaved,FeedbackState,FeedbackSummary} from '../feedback-types';
import {feedbackCategoryLabel,feedbackCategoryLabels,feedbackModuleLabels,feedbackModules,feedbackStateLabels,feedbackStates} from '../feedback-types';
import './feedback.css';

const route='/admin/operations/feedback';
const errors={feedback_revision_conflict:'这条反馈已有更新，你的输入仍保留。请核对当前处理状态。',feedback_no_change:'没有需要保存的变化，请查看当前处理状态。',business_admin_operation_conflict:'原操作内容不一致，请重新读取当前反馈。',invalid_feedback_request:'请检查分类、状态和备注内容。',not_found:'这条反馈已不存在。'};
const timestamp=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const fullTimestamp=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const accountLabel=(value:FeedbackItem['account'])=>value.displayName||value.uid;

type Filters=Pick<FeedbackProps,'query'|'category'|'state'|'module'|'days'|'after'>;
function mergeDraft(draft:Draft,value:FeedbackItem):Draft{
  if(draft.baseRevision===value.revision)return draft;
  const conflict=draft.category!==draft.baseCategory&&value.category!==draft.baseCategory&&draft.category!==value.category
    ||draft.module!==draft.baseModule&&value.module!==draft.baseModule&&draft.module!==value.module
    ||draft.state!==draft.baseState&&value.state!==draft.baseState&&draft.state!==value.state;
  if(conflict)return draft;
  return {...createDraft(value,draft.note),category:draft.category===draft.baseCategory?value.category:draft.category,module:draft.module===draft.baseModule?value.module:draft.module,state:draft.state===draft.baseState?value.state:draft.state};
}
function pageHref(filters:Filters,values:Record<string,string|null|undefined>={}){
  const params=new URLSearchParams({days:filters.days});
  for(const key of ['query','category','state','module','after'] as const)if(filters[key])params.set(key,filters[key]);
  for(const [key,value]of Object.entries(values)){if(value)params.set(key,value);else params.delete(key);}
  return route+'?'+params.toString();
}
function Tag({category}:{category:FeedbackCategory}){return <span className="galaxy-feedback-tag" data-category={category??'unclassified'}>{feedbackCategoryLabel(category)}</span>;}
function State({state}:{state:FeedbackState}){return <span className="galaxy-feedback-state" data-state={state}>{feedbackStateLabels[state]}</span>;}
function Empty({children}:{children:ReactNode}){return <div className="galaxy-feedback-empty"><AdminIcon name="comment" size={27}/><p>{children}</p></div>;}
function FeedbackFilters({filters,disabled,onApply}:{filters:Filters;disabled:boolean;onApply:(form:HTMLFormElement)=>void}){
  return <form className="galaxy-feedback-filters" action={route} onSubmit={event=>{event.preventDefault();onApply(event.currentTarget);}}><fieldset className="galaxy-feedback-filter-fields" disabled={disabled}>
    <label>反馈类型<select name="category" defaultValue={filters.category}><option value="">全部类型</option><option value="unclassified">待归类</option>{Object.entries(feedbackCategoryLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    <label>处理状态<select name="state" defaultValue={filters.state}><option value="">全部状态</option>{feedbackStates.map(value=><option key={value} value={value}>{feedbackStateLabels[value]}</option>)}</select></label>
    <label>所属模块<select name="module" defaultValue={filters.module}><option value="">全部模块</option>{feedbackModules.map(value=><option key={value} value={value}>{feedbackModuleLabels[value]}</option>)}</select></label>
    <label>提交时间<select name="days" defaultValue={filters.days}><option value="7">最近7天</option><option value="28">最近28天</option><option value="all">全部时间</option></select></label>
    <label className="galaxy-feedback-search">关键词<AdminIcon name="search" size={15}/><input name="query" defaultValue={filters.query} maxLength={160} placeholder="搜索标题或正文" type="search"/></label>
    <button type="submit">查找反馈</button>
  </fieldset></form>;
}
function Overview({summary}:{summary:FeedbackSummary|null}){
  const metrics=[['反馈总数',summary?.total],['待归类',summary?.unclassified],['待处理',summary?.pending],['处理中',summary?summary.total-summary.pending-summary.closed:undefined],['已处理',summary?.closed]] as const;
  return <><dl className="galaxy-feedback-summary">{metrics.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value===undefined?'—':value.toLocaleString('zh-CN')}</dd></div>)}</dl><p className="galaxy-feedback-summary-caption">概览与分类分布按关键词、所属模块和提交时间统计。</p></>;
}
function Distribution({summary}:{summary:FeedbackSummary|null}){
  const maximum=Math.max(1,...(summary?.byCategory.map(item=>item.count)??[]));
  return <section className="galaxy-feedback-panel galaxy-feedback-distribution"><h2>反馈分类</h2>{summary?summary.total?<>{[null,'problem','suggestion'].map(value=>{const category=value as FeedbackCategory,count=summary.byCategory.find(item=>item.category===category)?.count??0;return <div key={category??'unclassified'} className="galaxy-feedback-distribution-row" data-category={category??'unclassified'}><span>{feedbackCategoryLabel(category)}</span><span className="galaxy-feedback-distribution-bar" aria-hidden="true"><span style={{width:count/maximum*100+'%'}}/></span><b>{count.toLocaleString('zh-CN')}</b></div>;})}</>:<p>当前范围内还没有反馈。</p>:<p>尚未取得分类统计。</p>}</section>;
}
function FeedbackArticle({value,csrfToken,positions}:{value:FeedbackDetail;csrfToken:string;positions:Map<string,number>}){
  const item=value.feedback;
  const article=useRef<HTMLElement|null>(null);
  useLayoutEffect(()=>{if(article.current)article.current.scrollTop=positions.get(item.id)??0;},[item.id,positions]);
  return <article ref={article} onScroll={event=>positions.set(item.id,event.currentTarget.scrollTop)} className="galaxy-feedback-panel galaxy-feedback-article" aria-labelledby="feedback-title"><header className="galaxy-feedback-article-heading"><h2 id="feedback-title">{item.title}</h2><State state={item.state}/></header>
    <div className="galaxy-feedback-byline"><Link href={'/admin/operations/users?account='+encodeURIComponent(item.account.accountId)}><AdminIcon name="user" size={14}/>{accountLabel(item.account)}</Link><span>UID {item.account.uid}</span><time dateTime={item.createdAt}>{fullTimestamp(item.createdAt)}</time><span>{feedbackModuleLabels[item.module]}</span><Tag category={item.category}/></div>
    <p className="galaxy-feedback-body">{item.body}</p>
    <FeedbackAttachments key={item.id} feedbackId={item.id} items={item.attachments} csrfToken={csrfToken}/>
  </article>;
}
function FeedbackHistory({value}:{value:FeedbackDetail}){
  const [cursor,setCursor]=useState(''),[older,setOlder]=useState<FeedbackEvent[]>([]);
  const more=useOperationsRead<FeedbackDetail>({path:cursor?'/v1/operations/feedback/'+value.feedback.id+'?historyAfter='+encodeURIComponent(cursor):null,failureMessage:'更早的处理记录暂时无法取得。',clearOnOffline:true});
  useEffect(()=>{if(more.value)setOlder(previous=>{const seen=new Set(previous.map(item=>item.id));return [...previous,...more.value!.history.items.filter(item=>!seen.has(item.id))];});},[more.value]);
  const history=useMemo(()=>{
    const unique=new Map([...value.history.items,...older].map(item=>[item.id,item]));
    return [...unique.values()].sort((a,b)=>{const left=BigInt(a.sequence),right=BigInt(b.sequence);return left>right?-1:left<right?1:0;});
  },[value.history.items,older]);
  const nextAfter=cursor?more.value?.history.nextAfter:value.history.nextAfter;
  return <section className="galaxy-feedback-panel galaxy-feedback-history"><h2>处理历史</h2>{history.length?<ol className="galaxy-feedback-history-list">{history.map(event=><li key={event.id}><strong>{event.kind==='submitted'?'用户提交反馈':<><HistoryOperator id={event.operatorId} name={event.operatorDisplayName}/>更新处理</>}</strong><time dateTime={event.createdAt}>{fullTimestamp(event.createdAt)}</time>{event.kind==='updated'&&<p className="galaxy-feedback-history-snapshot">{feedbackCategoryLabel(event.category)} · {feedbackModuleLabels[event.module]} · {feedbackStateLabels[event.state]}</p>}{event.note&&<p className="galaxy-feedback-history-note">{event.note}</p>}</li>)}</ol>:<p className="galaxy-feedback-read-status">没有处理记录。</p>}<ReadStatus loading={more.loading} error={more.error} retry={more.read}/>{nextAfter&&!more.loading&&<button type="button" className="galaxy-secondary" onClick={()=>setCursor(nextAfter)}>更早记录</button>}</section>;
}

function FeedbackContent({selected,after,query,category,state,module,days,csrfToken,canManage}:FeedbackProps){
  const router=useRouter(),[navigating,startNavigation]=useTransition();
  const filters:Filters={after,query,category,state,module,days},filterKey=JSON.stringify(filters);
  const [picked,setPicked]=useState<{context:string;id:string}|null>(null),[drafts,setDrafts]=useState<Record<string,Draft>>({}),[commandFor,setCommandFor]=useState('');
  const readingPositions=useRef(new Map<string,number>());
  const editorHeading=useRef<HTMLHeadingElement|null>(null);
  const directoryElement=useRef<HTMLUListElement|null>(null),directoryPositions=useRef(new Map<string,number>());
  const listParams=new URLSearchParams({limit:'25',days,...(after?{after}:{}),...(query?{query}:{}),...(category?{category}:{}),...(state?{state}:{}),...(module?{module}:{})});
  const directory=useOperationsRead<FeedbackPage>({path:'/v1/operations/feedback?'+listParams.toString(),failureMessage:'反馈列表暂时无法取得。',clearOnOffline:true});
  useLayoutEffect(()=>{if(directory.verified&&directoryElement.current)directoryElement.current.scrollTop=directoryPositions.current.get(filterKey)??0;},[filterKey,directory.verified,!!directory.value?.items.length]);
  const selectedId=picked?.context===filterKey?picked.id:selected||directory.value?.items[0]?.id||'';
  const current=useOperationsRead<FeedbackDetail>({path:selectedId?'/v1/operations/feedback/'+selectedId:null,failureMessage:'这条反馈暂时无法取得。',clearOnOffline:true});
  const item=current.value?.feedback,draft=item?drafts[item.id]??createDraft(item):undefined;
  const conflict=!!item&&!!draft&&draft.baseRevision!==item.revision;
  useEffect(()=>{setPicked(null);},[selected,filterKey]);
  const committed=useCallback(async(id:string)=>{
    setCommandFor(id);setDrafts(previous=>{const next={...previous};delete next[id];return next;});
    await Promise.all([directory.read(),current.read()]);
  },[directory.read,current.read]);
  const reread=useCallback(()=>{void current.read();void directory.read();},[current.read,directory.read]);
  const denied=/登录|权限|未获准/.test(directory.error+' '+current.error);
  const clearDenied=useCallback(()=>{setDrafts({});readingPositions.current.clear();directoryPositions.current.clear();directory.clear();current.clear();void directory.read();void current.read();},[directory.clear,current.clear,directory.read,current.read]);
  const command=useFeedbackCommand({csrfToken,ready:directory.verified,canRead:directory.verified&&!denied,canWrite:canManage&&current.value?.permissions.canManage===true&&current.verified,onCommitted:committed,onConflict:reread,onReadDenied:clearDenied,errorMessages:errors});
  const locked=command.locked||navigating;
  const memory=useSettingsDraftMemory({scope:'feedback',ready:directory.verified,denied,blocked:command.locked,snapshot:()=>({drafts,readingPositions:[...readingPositions.current],directoryPositions:[...directoryPositions.current]}),restore:value=>{setDrafts(value.drafts);readingPositions.current=new Map(value.readingPositions);directoryPositions.current=new Map(value.directoryPositions);},discard:()=>{setDrafts({});readingPositions.current.clear();directoryPositions.current.clear();}});
  useEffect(()=>{if(!item||!memory.initialized)return;setDrafts(previous=>{const old=previous[item.id];const next=old?mergeDraft(old,item):createDraft(item);return old===next?previous:{...previous,[item.id]:next};});},[item,memory.initialized]);
  const canEdit=memory.initialized&&canManage&&current.value?.permissions.canManage===true&&current.verified&&!current.loading&&!locked;
  useSettingsDraftState(Object.values(drafts).some(changed),command.locked);
  const summary=directory.verified?directory.value?.summary??null:null;
  function pick(id:string){if(locked)return;setPicked({context:filterKey,id});startNavigation(()=>router.replace(pageHref(filters,{id}),{scroll:false}));}
  function apply(form:HTMLFormElement){if(locked)return;const data=new FormData(form),params=new URLSearchParams();for(const key of ['query','category','state','module','days']){const value=String(data.get(key)??'').trim();if(value)params.set(key,value);}startNavigation(()=>router.push(route+'?'+params.toString(),{scroll:false}));}
  function update(values:Partial<Pick<Draft,'category'|'module'|'state'|'note'>>){if(!item)return;setDrafts(previous=>({...previous,[item.id]:{...(previous[item.id]??createDraft(item)),...values}}));}
  function useCurrent(keepChoices:boolean){if(!item||!draft)return;setDrafts(previous=>({...previous,[item.id]:keepChoices?{...draft,baseRevision:item.revision,baseCategory:item.category,baseModule:item.module,baseState:item.state}:createDraft(item,draft.note)}));}
  async function save(markClosed=false){
    if(!item||!draft||!canEdit||conflict)return;
    const nextState=markClosed?'closed':draft.state,body:Record<string,unknown>={expectedRevision:draft.baseRevision};
    if(draft.category!==draft.baseCategory)body.category=draft.category;
    if(draft.module!==draft.baseModule)body.module=draft.module;
    if(nextState!==draft.baseState)body.state=nextState;
    if(draft.note.trim())body.note=draft.note.trim();
    if(Object.keys(body).length===1)return;
    setCommandFor(item.id);
    await command.submit(item.id,body,markClosed?'反馈已标记为已处理。':'处理已保存。');
  }
  function discard(){if(!item||!canEdit)return;setDrafts(previous=>({...previous,[item.id]:createDraft(item)}));requestAnimationFrame(()=>editorHeading.current?.focus({preventScroll:true}));}
  const refresh=()=>{if(!command.locked)reread();};
  return <section className="galaxy-feedback"><header className="galaxy-feedback-header"><h1>使用反馈</h1><button type="button" className="galaxy-secondary" disabled={!directory.ready||locked||directory.loading||current.loading} onClick={refresh}><AdminIcon name="refresh" size={14}/>刷新</button></header>
    <FeedbackFilters key={filterKey} filters={filters} disabled={locked} onApply={apply}/>
    <Overview summary={summary}/>
    <div className="galaxy-feedback-columns">
      <section className="galaxy-feedback-panel galaxy-feedback-directory" aria-labelledby="feedback-list-title"><header className="galaxy-feedback-panel-header"><h2 id="feedback-list-title">反馈列表</h2>{directory.value&&<p>本批 {directory.value.items.length} 条</p>}</header>
        {(directory.loading||directory.error)&&<div className="galaxy-feedback-read-status"><ReadStatus loading={directory.loading} error={directory.error} retry={directory.read}/></div>}
        {directory.value?.items.length?<ul ref={directoryElement} onScroll={event=>{if(directory.verified)directoryPositions.current.set(filterKey,event.currentTarget.scrollTop);}} className="galaxy-feedback-list">{directory.value.items.map(entry=><li key={entry.id}><button type="button" className="galaxy-feedback-row" aria-current={selectedId===entry.id?'true':undefined} disabled={locked} onClick={()=>pick(entry.id)}><span className="galaxy-feedback-row-top"><strong>{entry.title}</strong><State state={entry.state}/></span><p className="galaxy-feedback-excerpt">{entry.excerpt}</p><span className="galaxy-feedback-row-meta"><Tag category={entry.category}/><span>{feedbackModuleLabels[entry.module]}</span><span>{accountLabel(entry.account)}</span><time dateTime={entry.createdAt}>{timestamp(entry.createdAt)}</time>{entry.attachmentCount>0&&<span><AdminIcon name="file" size={11}/> {entry.attachmentCount}</span>}</span></button></li>)}</ul>:directory.verified&&!directory.loading?<Empty>暂无符合条件的反馈。</Empty>:null}
        {directory.value&&(after||directory.value.nextAfter)&&<footer className="galaxy-feedback-list-footer">{after?<Link aria-disabled={locked||undefined} tabIndex={locked?-1:undefined} onClick={event=>{if(locked)event.preventDefault();}} href={pageHref(filters,{after:null,id:null})} scroll={false}>回到最新</Link>:<span>按提交时间排列</span>}{directory.value.nextAfter&&<Link aria-disabled={locked||undefined} tabIndex={locked?-1:undefined} onClick={event=>{if(locked)event.preventDefault();}} href={pageHref(filters,{after:directory.value.nextAfter,id:null})} scroll={false}>下一批</Link>}</footer>}
      </section>
      {current.value?<FeedbackArticle value={current.value} csrfToken={csrfToken} positions={readingPositions.current}/>:<section className="galaxy-feedback-panel galaxy-feedback-article" aria-label="反馈正文">{selectedId?<div className="galaxy-feedback-read-status"><ReadStatus loading={current.loading} error={current.error} retry={current.read}/></div>:<Empty>{directory.verified?'选择反馈后查看正文。':'正在读取反馈列表…'}</Empty>}</section>}
      <aside className="galaxy-feedback-aside" aria-label="反馈处理">
        <section className="galaxy-feedback-panel galaxy-feedback-editor"><h2 ref={editorHeading} tabIndex={-1}>反馈处理{(!canManage||current.value?.permissions.canManage===false)&&<span className="galaxy-feedback-readonly">只读</span>}</h2>{current.error&&current.value&&<p className="galaxy-error" role="alert">{current.error}</p>}{item&&draft?<>
          {conflict&&<div className="galaxy-feedback-conflict" role="status"><p>其他管理员已更新这条反馈，你的输入仍保留。</p><p>当前已保存：{feedbackCategoryLabel(item.category)} · {feedbackModuleLabels[item.module]} · {feedbackStateLabels[item.state]}</p><button type="button" className="galaxy-secondary" disabled={locked} onClick={()=>useCurrent(false)}>采用当前分类和状态</button><button type="button" className="galaxy-secondary" disabled={locked} onClick={()=>useCurrent(true)}>保留我的选择</button></div>}
          <form onSubmit={event=>{event.preventDefault();void save();}}><fieldset disabled={!canEdit}><div className="galaxy-feedback-editor-fields"><label>反馈类型<select value={draft.category??'unclassified'} onChange={event=>update({category:event.target.value==='unclassified'?null:event.target.value as Exclude<FeedbackCategory,null>})}><option value="unclassified">待归类</option>{Object.entries(feedbackCategoryLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>所属模块<select value={draft.module} onChange={event=>update({module:event.target.value as FeedbackModule})}>{feedbackModules.map(value=><option key={value} value={value}>{feedbackModuleLabels[value]}</option>)}</select></label><label>处理状态<select value={draft.state} onChange={event=>update({state:event.target.value as FeedbackState})}>{feedbackStates.map(value=><option key={value} value={value}>{feedbackStateLabels[value]}</option>)}</select></label></div>
            <label className="galaxy-feedback-editor-note"><span>内部备注<small>{Array.from(draft.note).length}/2000</small></span><textarea value={draft.note} maxLength={2000} rows={5} placeholder="记录排查结果或后续安排" onChange={event=>update({note:event.target.value})}/></label>
            {canManage&&current.value?.permissions.canManage&&<div className="galaxy-feedback-editor-actions"><button type="submit" disabled={conflict||!changed(draft)}>保存处理</button><button type="button" className="galaxy-secondary" disabled={conflict||draft.baseState==='closed'&&draft.category===draft.baseCategory&&draft.module===draft.baseModule&&!draft.note.trim()} onClick={()=>void save(true)}>标记已处理</button><button type="button" className="galaxy-secondary" disabled={!changed(draft)&&!conflict} onClick={discard}>撤销修改</button></div>}
          </fieldset></form>
        </>:<p className="galaxy-feedback-read-status">{selectedId?'读取反馈后可查看处理状态。':'尚未选择反馈。'}</p>}
        {(commandFor===selectedId||command.locked)&&<CommandFeedback command={command}/>}</section>
        {current.value&&<FeedbackHistory key={current.value.feedback.id} value={current.value}/>}
        <Distribution summary={summary}/>
      </aside>
    </div>
  </section>;
}
export function Feedback(props:FeedbackProps){return <SettingsDraftBoundary scope={route} resetKey={props.csrfToken}><FeedbackContent {...props}/></SettingsDraftBoundary>;}
