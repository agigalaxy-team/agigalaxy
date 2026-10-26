'use client';

import {useCallback,useEffect,useState} from 'react';
import {AdminIcon} from "../AdminIcons";
import {AdminTabs} from "../AdminTabs";
import {ReadStatus} from "../OperationControls";
import {useOperationsRead} from "../../lib/use-operations-read";
import {useDetailReturnFocus} from "../../lib/use-detail-return-focus";
import {fileBytes,fileTime} from "../../lib/files/files-view-model";
import {cleanupCandidatesPath,cleanupCodes,cleanupKey,cleanupReasons,cleanupStates,cleanupTitle} from "../../lib/files/file-cleanup-view-model";
import type {CleanupCandidate,CleanupCandidates,CleanupPlan,CleanupPlans,CleanupReceipt} from './file-cleanup-types';
import type {FilesLocation} from "../../lib/files/files-view-model";
import {useCleanupCommand} from "../../lib/files/use-cleanup-command";
import './file-cleanup.css';

export function FileCleanup({location,csrfToken,navigate,onLock,onChanged}:{location:FilesLocation;csrfToken:string;navigate:(patch:Partial<FilesLocation>)=>void;onLock:(locked:boolean)=>void;onChanged:()=>void}){
 const [tab,setTab]=useState<'candidates'|'plans'>(location.plan?'plans':'candidates'),[after,setAfter]=useState(''),[trail,setTrail]=useState<string[]>([]),[planAfter,setPlanAfter]=useState(''),[planTrail,setPlanTrail]=useState<string[]>([]),[selection,setSelection]=useState<Record<string,CleanupCandidate>>({}),[reason,setReason]=useState('');
 const candidates=useOperationsRead<CleanupCandidates>({path:cleanupCandidatesPath(location.kind,after),failureMessage:'待清理文件暂时无法取得。',clearOnOffline:true});
 const plans=useOperationsRead<CleanupPlans>({path:'/v1/operations/files/cleanup/plans?limit=25'+(planAfter?'&after='+planAfter:''),failureMessage:'清理计划暂时无法取得。',clearOnOffline:true});
 const detail=useOperationsRead<CleanupPlan>({path:location.plan?'/v1/operations/files/cleanup/plans/'+location.plan:null,failureMessage:'这份清理计划暂时无法取得。',clearOnOffline:true});
 const plan=detail.value,permissions=candidates.value?.permissions??plans.value?.permissions;
 const detailFocus=useDetailReturnFocus({selectedKey:location.plan??'',scopeKey:tab+':'+location.kind+':'+planAfter,readableKeys:tab==='plans'&&plans.verified&&plans.value?plans.value.items.map(item=>item.id):null});
 const committed=useCallback(async(value:CleanupReceipt)=>{if(value.kind==='create'){setSelection({});setReason('');setTab('plans');navigate({plan:value.planId});}await Promise.all([plans.read(),candidates.read(),detail.read()]);onChanged();},[plans.read,candidates.read,detail.read,navigate,onChanged]);
 const conflict=useCallback(()=>{void candidates.read();void plans.read();void detail.read();},[candidates.read,plans.read,detail.read]);
 const command=useCleanupCommand({csrfToken,canRead:candidates.verified||plans.verified||detail.verified,canCreate:!!permissions?.canCreate&&candidates.verified,canApprove:!!plan?.permissions.canApprove&&detail.verified,canCancel:!!plan?.permissions.canCancel&&detail.verified,onCommitted:committed,onConflict:conflict});
 const selected=Object.values(selection),count=selected.length;
 useEffect(()=>{onLock(command.locked);return()=>onLock(false);},[command.locked,onLock]);
 useEffect(()=>{setAfter('');setTrail([]);},[location.kind]);
 useEffect(()=>{if(location.plan)setTab('plans');},[location.plan]);
 useEffect(()=>{if(!plan||!['queued','running'].includes(plan.state))return;const timer=setTimeout(()=>{if(navigator.onLine&&document.visibilityState==='visible'){void detail.read();void plans.read();}},3000);return()=>clearTimeout(timer);},[plan,detail.read,plans.read]);
 function select(item:CleanupCandidate){if(command.locked||!item.eligible||!permissions?.canCreate)return;setSelection(previous=>{const next={...previous},key=cleanupKey(item);if(next[key])delete next[key];else if(Object.keys(next).length<50)next[key]=item;return next;});}
 function closeDetail(){if(command.locked)return;detailFocus.prepareReturn();navigate({plan:''});}
 const materialValid=candidates.verified&&!!candidates.value;
 return <div className="galaxy-files-cleanup" aria-label="具体文件清理计划">
  <section className="galaxy-cleanup-directory">
   <header className="galaxy-cleanup-heading"><AdminTabs items={[{id:'candidates',label:'待清理文件',disabled:command.locked},{id:'plans',label:'已有计划',disabled:command.locked}]} active={tab} onChange={value=>setTab(value as typeof tab)} ariaLabel="清理记录"/><button type="button" disabled={command.locked||candidates.refreshing||plans.refreshing} onClick={()=>{void candidates.read();void plans.read();void detail.read();}}><AdminIcon name="refresh" size={14}/>刷新</button></header>
   <div className="galaxy-cleanup-filters"><label>来源<select value={location.kind} disabled={command.locked} onChange={event=>navigate({kind:event.target.value as FilesLocation['kind']})}><option value="chat">私聊附件</option><option value="forum">社区附件</option><option value="all">全部来源</option></select></label><span>{tab==='candidates'?'仅列当前符合旧文件运营清理条件的记录':'每份计划只处理已列明的文件'}</span></div>
   <div className="galaxy-cleanup-read"><ReadStatus loading={tab==='candidates'?candidates.loading:plans.loading} error={tab==='candidates'?candidates.error:plans.error} retry={tab==='candidates'?candidates.read:plans.read}/></div>
   <div className="galaxy-cleanup-scroll">
    {tab==='candidates'?candidates.value?.items.length?<table><thead><tr><th>选择</th><th>文件</th><th>大小</th><th>清理原因</th><th>当前引用</th><th>既有到期时间</th></tr></thead><tbody>{candidates.value.items.map(item=><tr key={cleanupKey(item)}><td><input type="checkbox" aria-label={'选择 '+cleanupTitle(item)} checked={!!selection[cleanupKey(item)]} disabled={command.locked||!item.eligible||!permissions?.canCreate||count>=50&&!selection[cleanupKey(item)]} onChange={()=>select(item)}/></td><td><strong>{cleanupTitle(item)}</strong><small>{item.kind==='chat'?'私聊附件':'社区附件'} · {item.id.slice(0,8)}</small>{item.blockedReason&&<small>{cleanupCodes[item.blockedReason]??'当前暂不可清理'}</small>}</td><td>{fileBytes(item.size)}</td><td>{cleanupReasons[item.reason]}</td><td>{item.activeReferences===null?'未确认':item.activeReferences+' 个有效引用'}<small>共 {item.referenceCount} 个来源引用</small></td><td>{fileTime(item.expiresAt)}</td></tr>)}</tbody></table>:!candidates.loading&&<div className="galaxy-cleanup-empty"><AdminIcon name="file" size={28}/><h3>{candidates.value?'本批没有待制定计划的文件':'当前记录不可读取'}</h3>{candidates.value?.nextAfter&&<p>还有后续记录可查看。</p>}</div>
     :plans.value?.items.length?<table><thead><tr><th>具体计划</th><th>文件数</th><th>声明大小合计</th><th>状态</th><th>制定者</th></tr></thead><tbody>{plans.value.items.map(item=><tr key={item.id} data-selected={location.plan===item.id}><td><button ref={button=>detailFocus.register(item.id,button)} type="button" disabled={command.locked} onClick={()=>navigate({plan:item.id})}>{fileTime(item.createdAt)}</button><small>{item.reason||'文件清理计划'}</small></td><td>{item.itemCount}</td><td>{fileBytes(item.declaredBytes)}</td><td>{cleanupStates[item.state]}</td><td>{item.createdBy.displayName??'管理账户'}</td></tr>)}</tbody></table>:!plans.loading&&<div className="galaxy-cleanup-empty"><AdminIcon name="file" size={28}/><h3>{plans.value?'还没有清理计划':'清理计划暂不可读取'}</h3></div>}
   </div>
   <footer className="galaxy-cleanup-pages">{tab==='candidates'?<><div>{after&&<button type="button" disabled={command.locked} onClick={()=>{setAfter(trail.at(-1)??'');setTrail(previous=>previous.slice(0,-1));}}>上一批</button>}{candidates.value?.nextAfter&&<button type="button" disabled={command.locked} onClick={()=>{setTrail(previous=>[...previous,after]);setAfter(candidates.value!.nextAfter!);}}>下一批</button>}</div><span>已选 {materialValid?count:0} 份</span></>:<div>{planAfter&&<button type="button" disabled={command.locked} onClick={()=>{setPlanAfter(planTrail.at(-1)??'');setPlanTrail(previous=>previous.slice(0,-1));}}>上一批</button>}{plans.value?.nextAfter&&<button type="button" disabled={command.locked} onClick={()=>{setPlanTrail(previous=>[...previous,planAfter]);setPlanAfter(plans.value!.nextAfter!);}}>下一批</button>}</div>}</footer>
   {tab==='candidates'&&<form className="galaxy-cleanup-create" onSubmit={event=>{event.preventDefault();if(!materialValid||!count||command.locked)return;command.submit('create','/v1/operations/files/cleanup/plans',{items:selected.map(item=>({kind:item.kind,id:item.id,expectedVersion:item.expectedVersion})),reason:reason.trim()});}}><label>计划说明（可选）<input value={reason} maxLength={1600} disabled={command.locked||!permissions?.canCreate} onChange={event=>setReason(event.target.value)}/></label><button type="submit" disabled={command.locked||!permissions?.canCreate||!materialValid||!count}>制定清理计划</button><button type="button" disabled={command.locked||!count} onClick={()=>setSelection({})}>清空选择</button></form>}
  </section>
  <aside className="galaxy-cleanup-detail">
    <header><h2>计划与处理结果</h2>{location.plan&&<button type="button" aria-label="关闭清理计划" disabled={command.locked} onClick={closeDetail}><AdminIcon name="close" size={16}/></button>}</header>
   <ReadStatus loading={detail.loading} error={detail.error} retry={detail.read}/>
   <div className="galaxy-cleanup-scroll">
    {plan?<><div className="galaxy-cleanup-plan-state"><strong>{cleanupStates[plan.state]}</strong><span>{fileTime(plan.createdAt)}</span></div><dl><div><dt>文件范围</dt><dd>{plan.itemCount} 份 · {fileBytes(plan.declaredBytes)}</dd></div><div><dt>制定者</dt><dd>{plan.createdBy.displayName??'管理账户'}</dd></div>{plan.approvedBy&&<div><dt>确认者</dt><dd>{plan.approvedBy.displayName??'管理账户'} · {fileTime(plan.approvedAt)}</dd></div>}{plan.reason&&<div><dt>说明</dt><dd>{plan.reason}</dd></div>}</dl>
     {plan.state==='awaiting-approval'&&<p className="galaxy-cleanup-impact">确认后清除以下文件在服务器上的副本，无法从此处恢复。系统会再次核对当前引用和状态；有变化的文件不会继续清理。</p>}
     <div className="galaxy-cleanup-totals"><span>对象已移除 <b>{plan.counts.removed}</b></span><span>未继续 <b>{plan.counts.skipped}</b></span><span>结果未确认 <b>{plan.counts['result-unknown']}</b></span></div>
     <ol className="galaxy-cleanup-items">{plan.items.map(item=><li key={cleanupKey(item)}><strong>{cleanupTitle(item)}</strong><span>{fileBytes(item.size)} · {cleanupReasons[item.reason]}</span><small>{item.resultCode?cleanupCodes[item.resultCode]??'处理结果暂未确认':item.state==='removing'?'正在核对并清理':item.state==='pending'?'等待本计划处理':item.state==='removed'?'对象已移除':'未继续清理'}</small></li>)}</ol>
     {plan.state==='attention'&&<p>部分对象的结果尚未确认。可在文件记录中查看当前状态；需要再次清理时制定新的具体计划。</p>}
    </>:<div className="galaxy-cleanup-empty"><AdminIcon name="file" size={28}/><h3>{location.plan?'正在取得计划':'选择一份具体计划'}</h3><p>先选择待清理文件，制定计划后审阅并确认。</p></div>}
   </div>
   <footer className="galaxy-cleanup-actions">{command.pending?<p role="status">{command.error||(!navigator.onLine?'网络已断开，恢复后会自动接续。':'正在处理这份计划…')}</p>:command.error?<p role="alert">{command.error}</p>:command.message?<output role="status">{command.message}</output>:null}
    {plan&&<div>{plan.permissions.canApprove&&<button type="button" className="galaxy-cleanup-confirm" disabled={command.locked||!detail.verified} onClick={()=>command.submit('approve','/v1/operations/files/cleanup/plans/'+plan.id+'/approve',{expectedRevision:plan.revision})}>确认并清理这 {plan.itemCount} 份文件</button>}{plan.permissions.canCancel&&<button type="button" disabled={command.locked||!detail.verified} onClick={()=>command.submit('cancel','/v1/operations/files/cleanup/plans/'+plan.id+'/cancel',{expectedRevision:plan.revision})}>取消这份计划</button>}</div>}
   </footer>
  </aside>
 </div>;
}
