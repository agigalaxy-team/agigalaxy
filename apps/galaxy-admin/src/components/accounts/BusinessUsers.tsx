'use client';

import {useEffect,useLayoutEffect,useMemo,useRef,useState,useTransition} from 'react';
import Link from 'next/link';
import {useRouter,useSearchParams} from 'next/navigation';
import type {AccountType,AuditPage,BusinessUser,BusinessUserOperationAction,BusinessUserOperationReceipt,BusinessUserWriteResult,LinkedId,TypeHistoryItem,UserDetail,UserPage} from "../business-types";
import {typeLabel} from "../business-types";
import {AdminTabs} from "../AdminTabs";
import {AccountProfileAvatar} from "../../../../../packages/galaxy-web/src/features/accounts/account-profile-avatar";
import {HistoryOperator} from "../HistoryOperator";
import {GuardedGetForm} from "../GuardedGetForm";
import {AccountActivityChart,AccountProfile} from './AccountProfile';
import {AccountUsageAnalysis} from './AccountUsageAnalysis';
import type {AccountUsageAnalysisValue} from './account-usage-analysis-types';
import {CommandFeedback,ReadStatus} from "../OperationControls";
import {useOperationCommand} from "../../lib/use-operation-command";
import {useOperationsRead} from "../../lib/use-operations-read";
import type {AccountDirectorySummary,AccountSummary} from "../../lib/analytics/account-summary";
import {countLabel,dateTime,periodLabel,summaryDays} from "../../lib/analytics/account-summary";
import {hasOperatorPermission,type OperatorBusinessAuthorization} from "../../lib/access";
import {SettingsDraftBoundary,useSettingsDraftState} from "../SettingsDraftBoundary";
import {useSettingsDraftMemory} from "../../lib/use-settings-draft-memory";
import type {SettingsDraftSession} from "../../lib/settings-draft-memory";
import {operationsRequest} from "../../lib/operations-client";
import {businessUserCommandPath,businessUserEmptyDraft,businessUserOriginalReceipt,businessUserPendingReceipt,businessUserReceiptPath,businessUserRestrictionDirty,businessUserReviewType,businessUserTypeDirty,businessUserWriteResult} from "../../lib/accounts/business-users-draft-memory";
import type {BusinessUserDraft,BusinessUserPendingReceipt} from "../../lib/accounts/business-users-draft-memory";
import './account-profile.css';

type EmbeddedAccount={accountId:string;registrationId?:string;tab:AccountTab;readable:boolean;href:(values:Record<string,string|null|undefined>)=>string;onState:(state:{locked:boolean;dirty:boolean;registrationId?:string;tab?:AccountTab})=>void};
type Props={list:UserPage|null;detail:UserDetail|null;audit:AuditPage|null;query:string;error:string;auditError:string;csrfToken:string;businessAuthorization?:OperatorBusinessAuthorization;embedded?:EmbeddedAccount};
type AccountTab='overview'|'profile'|'restrictions'|'history';
type AccountDraft=BusinessUserDraft;
type CurrentBusinessIntent=Omit<BusinessUserPendingReceipt,'operationId'>&{operationId?:string};
type AccountSummaryWithUsage=AccountSummary&{usageAnalysis?:AccountUsageAnalysisValue|null};
const tabs=[{id:'overview',label:'概览'},{id:'profile',label:'画像与使用'},{id:'restrictions',label:'参与限制'},{id:'history',label:'处理历史'}] as const;
const actionLabels:Record<string,string>={'restriction-set':'暂停社区参与','restriction-release':'解除社区参与限制','type-change':'更正账户类型','users-query':'查询账户','user-read':'查看账户','audit-read':'查看操作记录'};
const errorMessages:Record<string,string>={account_restriction_changed:'参与限制已有更新，请读取当前状态后继续。',account_settings_changed:'账户资料已有更新，请读取当前状态后继续。',business_admin_denied:'当前登录没有这项管理权限。',operations_access_denied:'当前登录没有这项管理权限。',invalid_restriction_expiry:'请选择有效的截止时间。',business_admin_operation_conflict:'原操作内容不一致，请读取当前记录。'};

function Email({account}:{account:BusinessUser}){
  return <>{account.identity.email??(account.identity.state==='temporarily-unavailable'?'登录资料暂不可用':account.identity.state==='not-configured'?'登录目录未接入':'未取得邮箱')}</>;
}
function Avatar({account,large=false}:{account:BusinessUser;large?:boolean}){
  return <AccountProfileAvatar className={'galaxy-account-avatar type-'+(account.subjectType??'unknown')+(large?' is-large':'')} name={account.displayName||account.uid} avatarKey={account.avatarKey} subjectType={account.subjectType} seed={account.accountId} size={large?64:36}/>;
}
function AccountState({account}:{account:BusinessUser}){
  return <span className={'galaxy-account-state'+(account.restriction.active?' is-restricted':'')}><i aria-hidden="true"/>{account.restriction.active?'限制中':'正常'}</span>;
}
function DirectoryMetrics({value,days}:{value:AccountDirectorySummary|null;days:7|28}){
  const totals=value?.totals;
  const metrics=[['业务账户',totals?.accounts,''],['个人',totals?.person,'type-person'],['Agent',totals?.agent,'type-agent'],['组织',totals?.organization,'type-organization'],[`近${days}天活跃`,totals?.active,''],['受限账户',totals?.restricted,'is-restricted']] as const;
  return <dl className="galaxy-account-directory-metrics">{metrics.map(([label,value,className])=><div key={label}><dt>{label}</dt><dd className={className}>{countLabel(value)}</dd></div>)}</dl>;
}
function AccountCard({account,detail,summary,loading,error,href,retry}:{account:BusinessUser;detail:UserDetail|null;summary:AccountSummary|null;loading:boolean;error:string;href:(tab:AccountTab)=>string;retry:()=>void}){
  return <aside className="galaxy-account-card" aria-label="选中账户">
    <div className="galaxy-account-card-person"><Avatar account={account} large/><div><h2>{account.displayName||account.uid}</h2><AccountState account={account}/></div></div>
    <dl className="galaxy-account-facts"><dt>UID</dt><dd className="galaxy-account-uid">{account.uid}</dd><dt>主体类型</dt><dd>{typeLabel(account.subjectType)}</dd><dt>邮箱</dt><dd><Email account={account}/></dd><dt>创建时间</dt><dd>{dateTime(account.createdAt)}</dd><dt>最近公开参与</dt><dd>{summary?.usage.lastActivityAt?dateTime(summary.usage.lastActivityAt):'未记录'}</dd><dt>关联 ID</dt><dd>{account.links.activeCount}</dd></dl>
    {loading&&<p className="galaxy-account-read-status" role="status">正在读取账户…</p>}
    {error&&<p className="galaxy-error" role="alert">{error}<button type="button" onClick={retry}>重新读取</button></p>}
    <div className="galaxy-account-card-section"><h3>当前参与状态</h3>{account.restriction.active?<><p className="galaxy-account-restriction-until">限制至 {dateTime(account.restriction.until)}</p>{account.restriction.reason&&<p>{account.restriction.reason}</p>}</>:<p className="galaxy-account-neutral">当前无参与限制</p>}</div>
    <nav className="galaxy-account-card-actions" aria-label="账户操作"><Link href={href('overview')}>查看详情</Link><Link href={href('profile')}>画像与使用</Link><Link href={href('restrictions')}>{account.restriction.active?'查看参与限制':'参与限制'}</Link><Link href={href('history')}>处理历史</Link></nav>
    {detail?.profile.publicQuery.enabled&&<p className="galaxy-account-card-footnote">已开放公开查询</p>}
  </aside>;
}

function BusinessUsersContent({list,detail:providedDetail,audit:providedAudit,query:providedQuery,error:providedError,auditError:providedAuditError,csrfToken,businessAuthorization,embedded}:Props){
  const router=useRouter(),location=useSearchParams(),[refreshing,startRefresh]=useTransition();
  const [pendingLocation,setPendingLocation]=useState<{accountId:string;search:string;registrationId?:string;tab?:AccountTab}|null>(null),search=new URLSearchParams(pendingLocation?.search??location.toString());
  const [resumed,setResumed]=useState<BusinessUserPendingReceipt|null>(null),pendingSession=useRef<SettingsDraftSession|null>(null),resolved=useRef(''),intent=useRef<CurrentBusinessIntent|null>(null),[lastResult,setLastResult]=useState<{action:BusinessUserOperationAction;value:BusinessUserWriteResult}|null>(null);
  const typeHeading=useRef<HTMLHeadingElement|null>(null),restrictionHeading=useRef<HTMLHeadingElement|null>(null);
  const query=pendingLocation?search.get('query')??'':providedQuery;
  const requested=search.get('account')??'',requestedAccountId=pendingLocation?.accountId??embedded?.accountId??(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requested)?requested.toLowerCase():'');
  const [initialDetail,setInitialDetail]=useState(providedDetail);
  const canReadEmbedded=embedded?.readable!==false;
  const detailRead=useOperationsRead<UserDetail>({path:requestedAccountId&&canReadEmbedded?'/v1/operations/users/'+requestedAccountId:null,initial:canReadEmbedded&&initialDetail?.account.accountId===requestedAccountId?initialDetail:null,failureMessage:'账户详情暂时无法取得。',clearOnOffline:true});
  const linksAfter=search.get('linksAfter'),historyAfter=embedded?search.get('typeHistoryAfter'):search.get('historyAfter');
  const initialPages=useMemo(()=>initialDetail?.account.accountId===requestedAccountId?{links:{...initialDetail.linkedIds,checkedAt:initialDetail.checkedAt},history:{items:initialDetail.typeHistory,nextAfter:initialDetail.typeHistoryNextAfter,checkedAt:initialDetail.checkedAt}}:null,[initialDetail,requestedAccountId]);
  const linksRead=useOperationsRead<{items:LinkedId[];nextAfter:string|null;checkedAt:number}>({path:requestedAccountId&&canReadEmbedded&&linksAfter?'/v1/operations/users/'+requestedAccountId+'/links?'+new URLSearchParams({limit:'20',after:linksAfter}):null,initial:canReadEmbedded&&linksAfter?initialPages?.links:null,failureMessage:'更多关联记录暂时无法取得。',clearOnOffline:true});
  const historyRead=useOperationsRead<{items:TypeHistoryItem[];nextAfter:number|null;checkedAt:number}>({path:requestedAccountId&&canReadEmbedded&&historyAfter?'/v1/operations/users/'+requestedAccountId+'/type-history?'+new URLSearchParams({limit:'100',after:historyAfter}):null,initial:canReadEmbedded&&historyAfter?initialPages?.history:null,failureMessage:'更早的类型记录暂时无法取得。',clearOnOffline:true});
  useEffect(()=>setInitialDetail(null),[]);
  const fresh=detailRead.value,detail=fresh?{...fresh,...(linksAfter?{linkedIds:linksRead.value??{items:[],nextAfter:null}}:{}),...(historyAfter?{typeHistory:historyRead.value?.items??[],typeHistoryNextAfter:historyRead.value?.nextAfter??null}:{})}:null,sameProvided=providedDetail?.account.accountId===requestedAccountId;
  const embeddedAudit=useOperationsRead<AuditPage>({path:embedded&&canReadEmbedded&&embedded.tab==='history'&&hasOperatorPermission({businessAuthorization},'audit.read')?'/v1/operations/users/'+requestedAccountId+'/audit?'+new URLSearchParams({limit:'30',...(search.get('auditAfter')?{after:search.get('auditAfter')!}:{})}):null,failureMessage:'处理记录暂时无法取得。',clearOnOffline:true});
  const audit=embedded?embeddedAudit.value:sameProvided&&detail?providedAudit:null,error=requestedAccountId?detailRead.error||linksRead.error||historyRead.error||(sameProvided?providedError:''):providedError,auditError=embedded?hasOperatorPermission({businessAuthorization},'audit.read')?embeddedAudit.error:'当前没有读取业务审计的权限。':sameProvided?providedAuditError:'';
  const [picked,setPicked]=useState<string|null>(null),[drafts,setDrafts]=useState<Record<string,AccountDraft>>({}),operationAccount=useRef('');
  const period=summaryDays(search.get('days')),account=detail?.account??list?.items.find(item=>item.accountId===(picked??search.get('selected')))??list?.items[0]??null;
  const draftKey=requestedAccountId||account?.accountId||'',emptyDraft:AccountDraft=detail?businessUserEmptyDraft(detail):{restrictionReason:'',typeReason:'',basis:'',nextType:null,typeBase:null,days:'1',profileRevision:0,restrictionRevision:0,restrictionActive:false},draft=drafts[draftKey]??emptyDraft;
  const {restrictionReason,typeReason,basis,nextType,days}=draft,updateDraft=(change:Partial<AccountDraft>)=>{if(!detail||command.locked||!detailRead.verified)return;setDrafts(previous=>{const old=previous[draftKey]??emptyDraft,current=businessUserEmptyDraft(detail),base={...old,...(!businessUserTypeDirty(old)?{typeBase:current.typeBase,nextType:current.nextType,profileRevision:current.profileRevision}:{}),...(!businessUserRestrictionDirty(old)?{restrictionRevision:current.restrictionRevision,restrictionActive:current.restrictionActive}:{})};return{...previous,[draftKey]:{...base,...change}};});};
  const setRestrictionReason=(value:string)=>updateDraft({restrictionReason:value}),setTypeReason=(value:string)=>updateDraft({typeReason:value}),setBasis=(value:string)=>updateDraft({basis:value}),setNextType=(value:AccountType)=>updateDraft({nextType:value}),setDays=(value:string)=>{if(value==='1'||value==='7'||value==='30')updateDraft({days:value});};
  const requestedTab=pendingLocation?.tab??embedded?.tab??search.get('tab'),tab:AccountTab=tabs.some(item=>item.id===requestedTab)?requestedTab as AccountTab:'overview';
  const subjectType=['person','agent','organization','unknown'].includes(search.get('subjectType')??'')?search.get('subjectType')??'':'';
  const restriction=['restricted','normal'].includes(search.get('restriction')??'')?search.get('restriction')??'':'';
  const refresh=()=>{if(requestedAccountId)void detailRead.read();if(linksAfter)void linksRead.read();if(historyAfter)void historyRead.read();startRefresh(()=>router.refresh());};
  function pageLink(values:Record<string,string|null|undefined>={}){
    if(embedded)return embedded.href(values);
    const params=new URLSearchParams(search.toString());
    if(query)params.set('query',query);else params.delete('query');
    for(const [key,value] of Object.entries(values)){if(value==null||value==='')params.delete(key);else params.set(key,value);}
    return '/admin/operations/users'+(params.size?'?'+params:'');
  }
  const accountLink=(value:AccountTab)=>pageLink({account:account?.accountId,selected:account?.accountId,tab:value,linksAfter:null,historyAfter:null,auditAfter:null});
  const preview=useOperationsRead<UserDetail>({path:!detail&&account?'/v1/operations/users/'+account.accountId:null,failureMessage:'账户详情暂时无法取得。',clearOnOffline:true});
  const allowed=(code:string)=>hasOperatorPermission({businessAuthorization},code),canReadAnalytics=allowed('analytics.read');
  const overview=useOperationsRead<AccountDirectorySummary>({path:!detail&&canReadAnalytics?'/v1/operations/users/summary?days='+period:null,failureMessage:'账户统计暂时无法取得。'});
  const summary=useOperationsRead<AccountSummaryWithUsage>({path:account&&canReadAnalytics?'/v1/operations/users/'+account.accountId+'/summary?days='+period:null,failureMessage:'画像与使用数据暂时无法取得。',clearOnOffline:true});
  const current=detail??preview.value,canChangeType=allowed('accounts.type.change')&&detail?.permissions.canChangeType===true,canRestrict=allowed('accounts.restriction.apply')&&detail?.permissions.canRestrict===true,canRelease=allowed('accounts.restriction.release')&&detail?.permissions.canRelease===true,canManage=canChangeType||canRestrict||canRelease;
  function refreshCurrent(){void detailRead.read();if(embedded&&tab==='history')void embeddedAudit.read();}
  function clearAuthored(original:BusinessUserPendingReceipt,value:BusinessUserWriteResult){
    setDrafts(previous=>{const old=previous[original.accountId];if(!old)return previous;const next=original.kind==='type-change'&&'subjectType'in value?{...old,typeReason:'',basis:'',nextType:value.subjectType,typeBase:value.subjectType,profileRevision:value.revision}
      :'restriction'in value?{...old,restrictionReason:'',days:'1' as const,restrictionRevision:value.restriction.revision,restrictionActive:value.restriction.active}:old;
      const copy={...previous};if(!businessUserTypeDirty(next)&&!businessUserRestrictionDirty(next))delete copy[original.accountId];else copy[original.accountId]=next;return copy;});
  }
  function finish(original:BusinessUserPendingReceipt,value:BusinessUserWriteResult){operationAccount.current=original.accountId;setLastResult({action:original.kind,value});clearAuthored(original,value);intent.current=null;refreshCurrent();}
  const canRead=allowed('accounts.read'),canRecover=canRead&&detailRead.verified&&!!detail;
  const currentCommand=useOperationCommand<BusinessUserWriteResult>({csrfToken,canWrite:canRecover&&!resumed&&(canManage||!!intent.current),errorMessages,onCommitted:value=>{const original=businessUserPendingReceipt(intent.current);if(original)finish(original,value);},onConflict:refreshCurrent,
    validateResult:(value,pending)=>{const original=intent.current,locator=original?businessUserPendingReceipt({...original,operationId:pending.body.operationId}):null;
      if(!locator||pending.path!==businessUserCommandPath(locator.accountId,locator.kind)||!businessUserWriteResult(value,locator,pending.body))throw Error('Original business-user result unavailable');intent.current=locator;},
    recover:async(pending,{signal})=>{const original=intent.current,locator=original?businessUserPendingReceipt({...original,operationId:pending.body.operationId}):null;
      if(!locator||pending.path!==businessUserCommandPath(locator.accountId,locator.kind))throw Error('Original business-user locator unavailable');
      let receipt:BusinessUserOperationReceipt;try{receipt=await operationsRequest<BusinessUserOperationReceipt>(businessUserReceiptPath(locator)!,{signal});}catch{throw Error('Original business-user result unavailable');}
      const current=businessUserOriginalReceipt(receipt,locator,pending.body);if(!current?.result)throw Error('Original business-user result not observed');
      return{state:'recorded',value:current.result};}
  });
  const resumedRead=useOperationsRead<BusinessUserOperationReceipt>({path:resumed&&canRead?businessUserReceiptPath(resumed):null,failureMessage:'处理结果暂时无法读取，连接恢复后会继续。',clearOnOffline:true});
  const command={...currentCommand,locked:currentCommand.locked||!!resumed,pending:currentCommand.pending??resumed,error:resumed?resumedRead.error:currentCommand.error};
  const hasEmbeddedDraft=Object.values(drafts).some(value=>businessUserTypeDirty(value)||businessUserRestrictionDirty(value)),embeddedState=useRef(embedded?.onState);embeddedState.current=embedded?.onState;
  useLayoutEffect(()=>{const original=resumed??intent.current;embeddedState.current?.({locked:command.locked,dirty:hasEmbeddedDraft,...(original?.registrationId?{registrationId:original.registrationId,tab:original.kind==='type-change'?'overview':'restrictions'}:{})});},[command.locked,hasEmbeddedDraft,resumed]);
  useEffect(()=>{if(!command.locked)setPendingLocation(null);},[command.locked]);
  const denied=!canRead||/登录|权限|未获准/.test(detailRead.error);
  const memory=useSettingsDraftMemory({scope:'business-users',ready:canRead&&detailRead.verified,denied,blocked:command.locked,snapshot:()=>({drafts}),restore:value=>setDrafts(value.drafts),discard:()=>setDrafts({})});
  useLayoutEffect(()=>{
    const session=memory.session;if(!memory.initialized||!session?.current())return;
    if(pendingSession.current!==session){pendingSession.current=session;const saved=businessUserPendingReceipt(session.pending('business-users'));if(saved){setResumed(saved);operationAccount.current=saved.accountId;setPendingLocation({accountId:saved.accountId,search:location.toString(),registrationId:saved.registrationId,tab:saved.kind==='type-change'?'overview':'restrictions'});return;}}
    const pending=currentCommand.pending;if(pending&&intent.current){const locator=businessUserPendingReceipt({...intent.current,operationId:pending.body.operationId});if(locator&&pending.path===businessUserCommandPath(locator.accountId,locator.kind))session.setPending('business-users',locator);}
    else if(!resumed)session.setPending('business-users',null);
  },[memory.initialized,memory.session,currentCommand.pending,resumed,location.toString()]);
  useEffect(()=>{
    if(!resumed||!canRead||!memory.session?.current())return;
    const value=resumedRead.verified?businessUserOriginalReceipt(resumedRead.value,resumed):null;
    if(value?.result&&resolved.current!==resumed.operationId){resolved.current=resumed.operationId;finish(resumed,value.result);memory.session.setPending('business-users',null);setResumed(null);return;}
    if(resumedRead.loading||resumedRead.refreshing)return;const timer=setTimeout(()=>{if(navigator.onLine&&document.visibilityState==='visible')void resumedRead.read();},5000);return()=>clearTimeout(timer);
  },[resumed,resumedRead.value,resumedRead.verified,resumedRead.loading,resumedRead.refreshing,resumedRead.read,canRead,memory.session]);
  const disabled=command.locked||refreshing||!!requestedAccountId&&!detailRead.verified,typeStale=!!detail&&draft.profileRevision!==detail.profile.revision,restrictionStale=!!detail&&(draft.restrictionRevision!==detail.account.restriction.revision||draft.restrictionActive!==detail.account.restriction.active);
  function reviewType(choice?:'mine'|'current'){if(disabled||!detail||!canChangeType)return;const next=businessUserReviewType(draft,detail,choice);if(next)setDrafts(previous=>({...previous,[draftKey]:next}));}
  function reviewRestriction(){if(disabled||!detail)return;updateDraft({restrictionRevision:detail.account.restriction.revision,restrictionActive:detail.account.restriction.active});}
  function cancel(area:'type'|'restriction'){if(disabled||!detail)return;setDrafts(previous=>{const old=previous[draftKey]??draft,current=businessUserEmptyDraft(detail),next=area==='type'?{...old,typeReason:'',basis:'',nextType:current.nextType,typeBase:current.typeBase,profileRevision:current.profileRevision}:{...old,restrictionReason:'',days:'1' as const,restrictionRevision:current.restrictionRevision,restrictionActive:current.restrictionActive};const copy={...previous};if(!businessUserTypeDirty(next)&&!businessUserRestrictionDirty(next))delete copy[draftKey];else copy[draftKey]=next;return copy;});requestAnimationFrame(()=>{const heading=area==='type'?typeHeading.current:restrictionHeading.current;if(heading?.isConnected)heading.focus({preventScroll:true});});}
  function mutate(action:BusinessUserOperationAction,body:Record<string,unknown>){
    if(!detail||!detailRead.verified||disabled||!(action==='type-change'?canChangeType&&!typeStale:action==='restriction-release'?canRelease&&!restrictionStale:canRestrict&&!restrictionStale))return;
    operationAccount.current=detail.account.accountId;intent.current={kind:action,accountId:detail.account.accountId,...(embedded?.registrationId?{registrationId:embedded.registrationId}:{})};setLastResult(null);setPendingLocation({accountId:detail.account.accountId,search:search.toString(),registrationId:embedded?.registrationId,tab});
    void currentCommand.submit(businessUserCommandPath(detail.account.accountId,action),body,'');
  }
  const resultMessage=lastResult?.value.accountId===requestedAccountId?(lastResult.action==='type-change'?'账户类型已更正。':lastResult.action==='restriction-release'?'参与限制已解除。':'社区参与限制已设置。'):'';

  if(requestedAccountId&&!detail)return <section className="galaxy-business-users galaxy-accounts is-detail">{!embedded&&<header className="galaxy-account-page-heading"><h1>账户详情</h1></header>}<ReadStatus loading={detailRead.loading} error={error} retry={detailRead.read}/><CommandFeedback command={command}/>{command.locked&&denied&&<p role="status">当前已无读取该账户的权限，处理结果尚未确认。</p>}{!embedded&&<BusinessDraftState dirty={hasEmbeddedDraft} pending={command.locked}/>}</section>;

  return <section className={'galaxy-business-users galaxy-accounts'+(detail?' is-detail':' is-directory')}>
    {!embedded&&<header className="galaxy-account-page-heading"><div>{detail?<><p className="galaxy-account-breadcrumb">用户与账号 / 用户详情</p><div className="galaxy-account-object"><Avatar account={detail.account}/><h1>{detail.account.displayName||detail.account.uid}</h1><span className="galaxy-account-object-uid">UID {detail.account.uid}</span><span className={'galaxy-account-type type-'+(detail.account.subjectType??'unknown')}>{typeLabel(detail.account.subjectType)}</span><AccountState account={detail.account}/></div></>:<h1>业务账户</h1>}</div>{detail&&<Link className="galaxy-account-return" href={pageLink({account:null,tab:null,linksAfter:null,historyAfter:null,auditAfter:null})}>返回账户列表</Link>}</header>}
    {error&&<p className="galaxy-error" role="alert">{error}<button type="button" onClick={refresh} disabled={refreshing}>重新读取</button></p>}
    {detail?<>
      {!embedded&&<div className="galaxy-account-detail-toolbar"><AdminTabs ariaLabel="账户详情" items={tabs.map(item=>({...item,href:accountLink(item.id)}))} active={tab}/><label className="galaxy-account-period"><span className="galaxy-account-sr-only">统计时间</span><select value={String(period)} disabled={!detailRead.ready} onChange={event=>router.push(pageLink({days:event.target.value}))}><option value="7">近7天</option><option value="28">近28天</option></select></label></div>}
      {(operationAccount.current===requestedAccountId||command.locked)&&<CommandFeedback command={command}/>}
      {resultMessage&&<output className="galaxy-account-result" role="status">{resultMessage}</output>}
      {!embedded&&<BusinessDraftState dirty={hasEmbeddedDraft} pending={command.locked}/>}
      <div className="galaxy-account-detail-content">
        {tab==='overview'&&<div className="galaxy-account-overview-grid">
          <section className="galaxy-account-panel"><h2>账户资料</h2>{detail.profile.bio&&<p className="galaxy-profile-bio">{detail.profile.bio}</p>}<dl className="galaxy-account-facts"><dt>邮箱</dt><dd><Email account={detail.account}/></dd><dt>创建时间</dt><dd>{dateTime(detail.account.createdAt)}</dd><dt>最近公开参与</dt><dd>{summary.value?.usage.lastActivityAt?dateTime(summary.value.usage.lastActivityAt):'未记录'}</dd><dt>公开查询</dt><dd>{detail.profile.publicQuery.enabled?'已开放':'未开放'}</dd><dt>关联 ID</dt><dd>{detail.account.links.activeCount} 个生效关联</dd></dl></section>
          <section className="galaxy-account-panel"><h2>关联 ID</h2>{detail.linkedIds.items.length?<ul className="galaxy-account-links">{detail.linkedIds.items.map(item=><li key={item.subjectId+item.linkedAt}><code>{item.subjectId}</code><span>{item.state==='active'?'已关联':'已解除'} · {dateTime(item.linkedAt)}</span></li>)}</ul>:<p className="galaxy-account-empty-copy">没有关联记录</p>}{detail.linkedIds.nextAfter&&<Link className="galaxy-account-text-action" href={pageLink({tab:'overview',linksAfter:detail.linkedIds.nextAfter})}>更多关联</Link>}</section>
          {canChangeType&&<section className="galaxy-account-panel galaxy-account-type-editor"><h2 ref={typeHeading} tabIndex={-1}>主体类型更正</h2><form onSubmit={event=>{event.preventDefault();if(!nextType||typeReason.trim().length<8||basis.trim().length<8)return;mutate('type-change',{expectedRevision:draft.profileRevision,subjectType:nextType,reason:typeReason.trim(),basis:basis.trim(),preserveHistory:true});}}><fieldset disabled={disabled}><div className="galaxy-account-form-row"><label>更正为<select value={nextType??''} onChange={event=>setNextType(event.target.value as Exclude<AccountType,null>)}>{nextType===null&&<option value="" disabled>选择主体类型</option>}<option value="person">个人</option><option value="organization">组织</option><option value="agent">Agent</option></select></label><p className="galaxy-account-form-note">当前：{typeLabel(detail.account.subjectType)}</p></div><div className="galaxy-account-form-row"><label>更正原因<textarea value={typeReason} onChange={event=>setTypeReason(event.target.value)} required minLength={8} maxLength={2000}/></label><label>相应依据<textarea value={basis} onChange={event=>setBasis(event.target.value)} required minLength={8} maxLength={4000}/></label></div>{typeStale&&<div className="galaxy-account-draft-review" role="status"><p>账户类型资料已有更新，请核对后继续；当前更正原因和依据已保留。</p>{businessUserReviewType(draft,detail)?<button type="button" onClick={()=>reviewType()}>按当前资料继续</button>:<div className="galaxy-account-form-actions"><button type="button" onClick={()=>reviewType('mine')}>保留我的更正</button><button type="button" onClick={()=>reviewType('current')}>采用当前主体类型</button></div>}</div>}<div className="galaxy-account-form-actions"><button type="submit" disabled={typeStale||nextType===null||nextType===detail.account.subjectType}>保存类型更正</button><button type="button" className="is-secondary" onClick={()=>cancel('type')}>取消</button></div></fieldset></form></section>}
        </div>}
        {tab==='profile'&&(canReadAnalytics?<AccountProfile summary={summary.value} days={period} loading={summary.loading} error={summary.error} onRetry={()=>void summary.read()} usageAnalysis={<AccountUsageAnalysis value={summary.value?.usageAnalysis} accountId={detail.account.accountId} loading={summary.loading}/>}/>:<p role="alert">当前没有读取账户汇总的权限。</p>)}
        {tab==='restrictions'&&<div className="galaxy-account-restrictions-grid"><section className="galaxy-account-panel"><h2 ref={restrictionHeading} tabIndex={-1}>社区参与</h2><AccountState account={detail.account}/>{detail.account.restriction.active?<><dl className="galaxy-account-facts"><dt>生效至</dt><dd>{dateTime(detail.account.restriction.until)}</dd><dt>处理说明</dt><dd>{detail.account.restriction.reason||'未记录'}</dd></dl></>:<p className="galaxy-account-empty-copy">当前没有生效的参与限制。</p>}<p className="galaxy-account-restriction-scope">限制涵盖帖子发布与修订、回复、任务发布、评论、邀请、聊天发送与编辑及相关上传。不会关闭登录或删除已有内容；读取、撤回和退出仍按各自权限执行。</p>{(detail.account.restriction.active?canRelease:canRestrict)&&<form onSubmit={event=>{event.preventDefault();if(restrictionReason.trim().length<3)return;mutate(detail.account.restriction.active?'restriction-release':'restriction-set',{expectedRevision:draft.restrictionRevision,reason:restrictionReason.trim(),...(!detail.account.restriction.active?{until:new Date(Date.now()+Number(days)*86400000).toISOString()}:{})});}}><fieldset disabled={disabled}><label>处理说明<textarea required minLength={3} maxLength={2000} value={restrictionReason} onChange={event=>setRestrictionReason(event.target.value)}/></label>{!detail.account.restriction.active&&<label className="galaxy-account-duration">持续时间<select value={days} onChange={event=>setDays(event.target.value)}><option value="1">1 天</option><option value="7">7 天</option><option value="30">30 天</option></select></label>}{restrictionStale&&<div className="galaxy-account-draft-review" role="status"><p>参与状态已有更新，请核对当前状态后继续；处理说明已保留。</p><button type="button" onClick={reviewRestriction}>按当前状态继续</button></div>}<div className="galaxy-account-form-actions"><button type="submit" disabled={restrictionStale}>{detail.account.restriction.active?'解除参与限制':'暂停社区参与'}</button><button type="button" className="is-secondary" onClick={()=>cancel('restriction')}>取消</button></div></fieldset></form>}</section></div>}
        {tab==='history'&&<div className="galaxy-account-history-grid"><section className="galaxy-account-panel"><h2>处理记录</h2>{auditError?<p className="galaxy-error" role="alert">{auditError}<button type="button" onClick={refresh}>重新读取</button></p>:audit?.items.length?<ol className="galaxy-account-history">{audit.items.map(item=><li key={item.id}><strong>{actionLabels[item.action]??item.action}</strong>{typeof item.selection?.reason==='string'&&<p>{item.selection.reason}</p>}<span><HistoryOperator id={item.operatorId} name={item.operatorDisplayName}/>{item.actorKind==='operations-executor'?'':item.operatorRole==='administrator'?' · 管理身份':item.operatorRole==='reader'?' · 后台成员身份':''} · {dateTime(item.createdAt)}</span></li>)}</ol>:<p className="galaxy-account-empty-copy">{audit?'没有处理记录':'尚未取得处理记录'}</p>}{audit?.nextAfter&&<Link className="galaxy-account-text-action" href={pageLink({tab:'history',auditAfter:audit.nextAfter})}>更早的处理记录</Link>}</section><section className="galaxy-account-panel"><h2>主体类型变更</h2>{detail.typeHistory.length?<ol className="galaxy-account-history">{detail.typeHistory.map(item=><li key={item.revision}><strong>{typeLabel(item.previousType)} / {typeLabel(item.nextType)}</strong><p>{item.reason}</p><p>{item.basis}</p><span>{item.actorKind==='business-operator'?'运营更正':'账户类型记录'} · {dateTime(item.createdAt)}</span></li>)}</ol>:<p className="galaxy-account-empty-copy">没有类型变更记录</p>}{detail.typeHistoryNextAfter!=null&&<Link className="galaxy-account-text-action" href={pageLink({tab:'history',historyAfter:String(detail.typeHistoryNextAfter)})}>更早的类型记录</Link>}</section></div>}
      </div>
    </>:<div className="galaxy-account-directory-grid"><div className="galaxy-account-directory-main">
      <div className="galaxy-account-directory-tools"><GuardedGetForm key={[query,subjectType,restriction,period].join(':')} method="get" action="/admin/operations/users" className="galaxy-account-filters"><input type="hidden" name="subjectType" value={subjectType}/><label><span className="galaxy-account-sr-only">参与状态</span><select name="restriction" defaultValue={restriction}><option value="">全部状态</option><option value="normal">正常参与</option><option value="restricted">限制中</option></select></label><label><span className="galaxy-account-sr-only">统计时间</span><select name="days" defaultValue={String(period)}><option value="7">近7天</option><option value="28">近28天</option></select></label><label className="galaxy-account-search"><span className="galaxy-account-sr-only">查找账户</span><input type="search" name="query" defaultValue={query} maxLength={200} placeholder="UID、用户名或邮箱"/></label><button type="submit">查询</button></GuardedGetForm><AdminTabs ariaLabel="主体类型" className="galaxy-account-type-filter" active={subjectType||'all'} items={[{id:'all',label:'全部',href:pageLink({subjectType:null,after:null})},{id:'person',label:'个人',href:pageLink({subjectType:'person',after:null})},{id:'agent',label:'Agent',href:pageLink({subjectType:'agent',after:null})},{id:'organization',label:'组织',href:pageLink({subjectType:'organization',after:null})},{id:'unknown',label:'未设置',href:pageLink({subjectType:'unknown',after:null})}]}/></div>
      <DirectoryMetrics value={overview.value} days={period}/>{overview.error&&<p className="galaxy-account-inline-error" role="status">{overview.error}<button type="button" onClick={()=>void overview.read()}>重试统计</button></p>}
      {account&&<section className="galaxy-account-selected-activity"><header><h2>近{period}天公开参与</h2><span>{summary.value?.usage.publicContributions!=null?countLabel(summary.value.usage.publicContributions)+' 条':periodLabel(summary.value?.period)}</span></header>{summary.error?<p className="galaxy-account-inline-error" role="status">{summary.error}<button type="button" onClick={()=>void summary.read()}>重新读取</button></p>:summary.loading&&!summary.value?<p className="galaxy-account-read-status" role="status">正在读取公开参与统计…</p>:canReadAnalytics?<AccountActivityChart items={summary.value?.usage.dailyActivity??[]} compact/>:<p className="galaxy-account-read-status">当前没有读取账户汇总的权限。</p>}</section>}
      {list&&<><div className="galaxy-account-table-scroll"><table><thead><tr><th>用户</th><th>主体类型</th><th>UID</th><th>状态</th><th>关联 ID</th></tr></thead><tbody>{list.items.map(item=><tr key={item.accountId} className={account?.accountId===item.accountId?'is-selected':''}><th><button type="button" className="galaxy-account-select" onClick={()=>setPicked(item.accountId)} aria-pressed={account?.accountId===item.accountId}><Avatar account={item}/><span>{item.displayName||item.uid}</span></button></th><td><span className={'galaxy-account-type type-'+(item.subjectType??'unknown')}>{typeLabel(item.subjectType)}</span></td><td className="galaxy-account-uid">{item.uid}</td><td><AccountState account={item}/></td><td>{item.links.activeCount}</td></tr>)}</tbody></table>{!list.items.length&&<div className="galaxy-account-table-empty"><h2>{query||subjectType||restriction?'没有相符的账户':'暂无账户'}</h2>{(query||subjectType||restriction)&&<Link href={pageLink({query:null,subjectType:null,restriction:null,after:null})}>清除筛选</Link>}</div>}</div><nav className="galaxy-account-pagination" aria-label="账户分页">{search.get('after')&&<Link href={pageLink({after:null})}>返回首批账户</Link>}{list.nextAfter&&<Link href={pageLink({after:list.nextAfter})}>更多账户</Link>}</nav></>}
    </div>{account?<AccountCard account={current?.account.accountId===account.accountId?current.account:account} detail={current?.account.accountId===account.accountId?current:null} summary={summary.value} loading={preview.loading} error={preview.error} href={accountLink} retry={()=>void preview.read()}/>:<aside className="galaxy-account-card galaxy-account-card-empty"><h2>账户详情</h2><p>选择账户后查看资料与参与状态。</p></aside>}</div>}
  </section>;
}

function BusinessDraftState({dirty,pending}:{dirty:boolean;pending:boolean}){useSettingsDraftState(dirty,pending);return null;}
export function BusinessUsers(props:Props){return props.embedded?<BusinessUsersContent {...props}/>:<SettingsDraftBoundary scope="/admin/operations/users" resetKey={props.csrfToken}><BusinessUsersContent {...props}/></SettingsDraftBoundary>;}
