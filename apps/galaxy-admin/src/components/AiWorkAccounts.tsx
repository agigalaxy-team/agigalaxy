'use client';

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useSearchParams} from 'next/navigation';
import {AdminTabs} from './AdminTabs';
import {AiDelegation} from './AiDelegation';
import type {AiDelegationDraft} from './ai-delegation-types';
import {AiWorkDuty,AiWorkDutyHistory} from './AiWorkDuty';
import {AutonomyState,AutonomyTaskList} from './AutonomyShared';
import {useAutonomyCommand} from '../lib/use-autonomy-command';
import {autonomyAccountState,autonomyBase,autonomyConfigBody,autonomyDate,autonomyDomains,autonomyModes,autonomyNumber,autonomySchedule,autonomyRoute} from '../lib/autonomy-view-model';
import type {AutonomyConfig,AutonomyConfigRead,AutonomyConfigSave,AutonomyDutyDraft,AutonomyOperation,AutonomyOverview} from './autonomy-types';
import {permissionConditionReason} from '../lib/permissions-view-model';
import {AccountRolePicker} from './AccountRolePicker';
import {HistoryOperator} from './HistoryOperator';
import {ReadStatus} from './OperationControls';
import {SettingsDraftBoundary,useSettingsDraftState} from './SettingsDraftBoundary';
import {useOperationsRead} from '../lib/use-operations-read';
import {useSettingsDraftMemory} from '../lib/use-settings-draft-memory';
import {settingsAiWorkReceiptPath,type SettingsDraftSession,type SettingsPendingReceipt} from '../lib/settings-draft-memory';
import {operationsRequest,OperationsRequestError} from '../lib/operations-client';
import {hasOperatorPermission,operatorPermissionLabel,type OperatorBusinessAuthorization} from '../lib/access';
import {aiWorkBase,aiWorkDate,aiWorkErrors,aiWorkHref,aiWorkLabel,aiWorkLocation,aiWorkPrepareLabels,aiWorkPermissionUse,aiWorkRoleImpact,aiWorkProfile,aiWorkProfileMerge,aiWorkReceiptMatches,aiWorkRestoredReceiptMatches,aiWorkRoute,aiWorkTabs,aiWorkWorkbench} from '../lib/ai-work-accounts-view-model';
import type {AiWorkAccount,AiWorkCommandKind,AiWorkDetail,AiWorkDomain,AiWorkGrant,AiWorkHistory,AiWorkLocation,AiWorkPage,AiWorkProfileDraft,AiWorkReceipt,AiWorkRuntimeRead,AiWorkTab} from './ai-work-accounts-types';
import './ai-work-accounts.css';
import './autonomy.css';

type Props={operatorId:string;csrfToken:string;businessAuthorization:OperatorBusinessAuthorization|null;initialLocation:AiWorkLocation;initialPage:AiWorkPage|null;initialDetail:AiWorkDetail|null;initialHistory?:AiWorkHistory|null;initialError?:string;initialDetailError?:string;initialHistoryError?:string};
type IntentSource={accountId:string;version:number;authorizationVersion:number;objectVersion:number;roleVersion:number|null};
type Intent={operationId:string;kind:AiWorkCommandKind;domain:AiWorkDomain;path:string;body:Record<string,unknown>;readOnly:boolean;attempted:boolean;source:IntentSource|null;rejection?:string};
type Choices=Partial<Record<'name'|'description','mine'|'current'>>;

function intentSource(detail:AiWorkDetail|null,intent:Intent):IntentSource|null{
 if(!detail||detail.account.domain!==intent.domain||detail.readExpiresAt*1000<=Date.now())return null;
 const assignment=intent.kind==='assignment-save'?detail.assignments.find(row=>row.roleId===intent.body.roleId):null;
 if(intent.kind==='assignment-save'&&(intent.body.id??null)!==(assignment?.id??null))return null;
 return{accountId:detail.account.id,version:detail.account.version,authorizationVersion:detail.account.authorizationVersion,objectVersion:intent.kind==='assignment-save'?assignment?.version??0:detail.account.version,roleVersion:intent.kind==='assignment-save'?detail.roles.find(role=>role.id===intent.body.roleId)?.version??null:null};
}
function sameIntentSource(detail:AiWorkDetail|null,intent:Intent){
 const source=intentSource(detail,intent),original=intent.source;
 return !!source&&!!original&&source.accountId===original.accountId&&source.version===original.version&&source.authorizationVersion===original.authorizationVersion&&source.objectVersion===original.objectVersion&&source.objectVersion===intent.body.expectedVersion&&source.roleVersion===original.roleVersion;
}
function canSubmitIntent(detail:AiWorkDetail|null,intent:Intent){return !!detail&&detail.account.domain===intent.domain&&detail.readExpiresAt*1000>Date.now()&&(intent.kind==='profile-save'?detail.capabilities.canEditProfile:intent.kind==='state-save'?detail.capabilities.canChangeState:detail.capabilities.canAssignRoles&&(intent.body.enabled===false||detail.roles.some(role=>role.id===intent.body.roleId&&role.canAssign)));}

function useAiWorkCommand({owner,csrfToken,canRead,detail,canSubmit,onResult,onConflict}:{owner:string;csrfToken:string;canRead:boolean;detail:AiWorkDetail|null;canSubmit:(intent:Intent)=>boolean;onResult:(value:AiWorkReceipt)=>void;onConflict:()=>void}){
 const [pending,setPending]=useState<Intent|null>(null),[requesting,setRequesting]=useState(false),[attempt,setAttempt]=useState(0),[error,setError]=useState(''),[wake,setWake]=useState(0),[retryRead,setRetryRead]=useState<{operationId:string;expiresAt:number}|null>(null);
 const original=useRef<Intent|null>(null),missing=useRef<typeof retryRead>(null),active=useRef<AbortController|null>(null),alive=useRef(false),busy=useRef(false),latest=useRef({owner,csrfToken,canRead,detail,canSubmit,onResult,onConflict});
 const rememberMissing=(value:typeof retryRead)=>{missing.current=value;setRetryRead(value);};
 useLayoutEffect(()=>{latest.current={owner,csrfToken,canRead,detail,canSubmit,onResult,onConflict};});
 useLayoutEffect(()=>{alive.current=true;setPending(null);original.current=null;rememberMissing(null);return()=>{alive.current=false;active.current?.abort();active.current=null;busy.current=false;original.current=null;missing.current=null;};},[owner,csrfToken]);
 const send=useCallback(async(first=false,manual=false)=>{
  const intent=original.current,identity=latest.current;if(!intent||busy.current||!alive.current||!identity.canRead||!navigator.onLine||document.hidden)return;
  if(manual&&(intent.readOnly||!intent.attempted||!intent.source||missing.current?.operationId!==intent.operationId||missing.current.expiresAt<=Date.now()||!identity.canSubmit(intent)||!sameIntentSource(identity.detail,intent)))return;
  const controller=new AbortController();active.current=controller;busy.current=true;setRequesting(true);
  const current=()=>alive.current&&!controller.signal.aborted&&original.current===intent&&latest.current.owner===identity.owner&&latest.current.csrfToken===identity.csrfToken;
  let posting=false;
  try{
   let value:AiWorkReceipt|undefined;
   if(!first||intent.attempted||intent.readOnly){
    const result=await operationsRequest<AiWorkReceipt>(aiWorkBase+'/operations/'+intent.operationId,{signal:controller.signal});if(!current())return;
    if(result.state==='recorded'){rememberMissing(null);value=result;}
    else if(result.state!=='not-recorded'||result.operationId!==intent.operationId)throw Error('Original result unavailable');
    else if(intent.rejection){original.current=null;setPending(null);rememberMissing(null);setError(aiWorkErrors[intent.rejection]??'当前记录已有变化，请查看后继续。');latest.current.onConflict();return;}
    else{if(!Number.isFinite(result.readExpiresAt)||result.readExpiresAt*1000<=Date.now())throw Error('Original result lease unavailable');rememberMissing({operationId:intent.operationId,expiresAt:result.readExpiresAt*1000});}
   }
   if(!value){
    // A missing receipt cannot prove that an attempted request had no effect.
    // Automatic recovery is GET-only after the first request. A manual retry
    // needs the retained body and fresh, unchanged source and authority.
    if((intent.attempted&&!manual)||intent.readOnly||!latest.current.canSubmit(intent)){setError('尚未取得这次处理的结果，系统会继续查询。');return;}
    if(manual){
     if(missing.current?.operationId!==intent.operationId||missing.current.expiresAt<=Date.now())return;
     const fresh=await operationsRequest<AiWorkDetail>(aiWorkBase+'/'+intent.domain,{signal:controller.signal});if(!current())return;
     if(!sameIntentSource(fresh,intent)){setError('这项资料已有更新，原操作结果仍在查询。');rememberMissing(null);latest.current.onConflict();return;}
     if(!canSubmitIntent(fresh,intent)||!latest.current.canRead||!latest.current.canSubmit(intent)){setError('当前不能办理这次操作，原结果仍在查询。');rememberMissing(null);latest.current.onConflict();return;}
    }
    if(!current()||!navigator.onLine||document.hidden)return;
    rememberMissing(null);intent.attempted=true;posting=true;setPending({...intent});
    value=await operationsRequest<AiWorkReceipt>(intent.path,{body:intent.body,csrfToken:identity.csrfToken,signal:controller.signal});
   }
   if(!current())return;
   const valid=intent.readOnly?aiWorkRestoredReceiptMatches(value,intent):aiWorkReceiptMatches(value,intent);
   if(!valid)throw Error('Unbound AI account result');
   original.current=null;setPending(null);rememberMissing(null);setError('');latest.current.onResult(value);
  }catch(failure){
   if(!current())return;
   rememberMissing(null);
   if(posting&&!intent.readOnly&&failure instanceof OperationsRequestError&&failure.status>=400&&failure.status<500&&![408,429].includes(failure.status)&&['invalid_operations_ai_work_request','operations_ai_work_version_changed','operations_ai_work_assignment_changed','operations_ai_work_operation_conflict','operations_ai_work_role_denied','operations_ai_work_not_initialized','operations_role_not_found','operations_permission_denied','business_admin_denied'].includes(failure.code)){intent.rejection=failure.code;setPending({...intent});}
   setError(failure instanceof OperationsRequestError&&[401,403].includes(failure.status)?'当前无法读取这次处理的结果。':attempt>=2?'连接暂时中断，系统正在恢复。':'');
  }finally{if(active.current===controller){active.current=null;busy.current=false;if(alive.current){setRequesting(false);setAttempt(value=>value+1);}}}
 },[attempt]);
 useEffect(()=>{const resume=()=>{if(!document.hidden&&navigator.onLine)setWake(value=>value+1);};window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);return()=>{window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);};},[]);
 useEffect(()=>{if(!pending||requesting||!canRead)return;const timer=setTimeout(()=>void send(),Math.min(10000,1500*2**Math.min(attempt,3)));return()=>clearTimeout(timer);},[pending,requesting,canRead,attempt,wake,send]);
 const retryState=pending&&!pending.readOnly&&pending.attempted&&retryRead?.operationId===pending.operationId&&retryRead.expiresAt>Date.now()&&canRead&&detail?(sameIntentSource(detail,pending)?canSubmit(pending)?'ready':'unavailable':'changed'):null;
 return{pending,error,locked:pending!==null,requesting,retryState,retry:()=>void send(false,true),
  submit:(domain:AiWorkDomain,kind:AiWorkCommandKind,body:Record<string,unknown>)=>{if(original.current)return false;const operationId=crypto.randomUUID(),intent:Intent={operationId,domain,kind,path:aiWorkBase+'/'+domain+(kind==='assignment-save'?'/assignments':'/commands'),body:{...structuredClone(body),operationId},readOnly:false,attempted:false,source:null};if(!latest.current.canSubmit(intent))return false;intent.source=intentSource(latest.current.detail,intent);original.current=intent;setPending({...intent});setAttempt(0);setError('');rememberMissing(null);void send(true);return true;},
  resume:(locator:SettingsPendingReceipt)=>{const path=settingsAiWorkReceiptPath(locator);if(!path||!locator.domain||original.current||!latest.current.canRead)return;const intent:Intent={operationId:locator.operationId,domain:locator.domain,kind:locator.kind as AiWorkCommandKind,path,body:{},readOnly:true,attempted:true,source:null};original.current=intent;setPending({...intent});setAttempt(0);setError('');rememberMissing(null);void send();},
 };
}

function AccessStatus({account}:{account:AiWorkAccount}){return <span className="aw-state" data-enabled={account.enabled}>{account.enabled?'启用':'停用'}</span>;}
function Grants({value,account}:{value:AiWorkDetail['automation'];account:AiWorkAccount}){
 const configure='/admin/operations/permissions?tab=automatic&id=new&aiAccount='+encodeURIComponent(account.id);
 return <section className="aw-panel"><header><h3>自动执行授权</h3>{value.canConfigure&&<Link href={configure} prefetch={false}>配置自动执行授权</Link>}</header>
  {value.state!=='available'?<p className="aw-muted">暂时无法读取关联授权。</p>:value.items.length?<ul className="aw-grants">{value.items.map(grant=><li key={grant.id}><strong>{grant.name}</strong><p>{grant.enabled?'已启用':'已停用'} · {grant.authorization?.effective===false?'授权当前无效':grant.authorization?.effective===true?'授权有效':'授权已保存'} · {grant.readiness?.ready===false?'执行未就绪':grant.readiness?.ready===true?'执行已就绪':''} · {grant.mode==='assisted'?'人工参与':'自动推进'} · {scopeLabel(grant)}</p><p>{grant.permissions.map(operatorPermissionLabel).join('、')||'未配置动作'}</p>{[...(grant.authorization?.reasons??[]),...(grant.readiness?.reasons??[])].length>0&&<ul className="aw-duty-readiness">{[...new Set([...(grant.authorization?.reasons??[]),...(grant.readiness?.reasons??[])].map(permissionConditionReason))].map(reason=><li key={reason}>{reason}</li>)}</ul>}<Link href={'/admin/operations/permissions?tab=automatic&id='+grant.id} prefetch={false}>查看授权</Link></li>)}</ul>:<p className="aw-muted">尚未配置自动执行授权。</p>}

 </section>;
}
function scopeLabel(grant:AiWorkGrant){return grant.resourceScope.kind==='eligible'?'全部符合条件对象（持续范围）':grant.resourceScope.kind==='selected'?'已选择 '+grant.resourceScope.resourceIds.length+' 个对象':'对象范围未明确';}
function Effective({detail}:{detail:AiWorkDetail}){
 return <section className="aw-panel"><header><h3>当前业务范围</h3></header>{detail.effective.state==='disabled'?<p className="aw-muted">岗位已停用，后续业务处理暂停。</p>:detail.effective.state==='unassigned'?<p className="aw-muted">尚未分配有效业务角色。</p>:<>
  <table className="aw-permissions"><thead><tr><th>角色授予权限</th><th>来源角色</th><th>当前用途</th></tr></thead><tbody>{detail.effective.permissions.map(code=><tr key={code}><td>{operatorPermissionLabel(code)}</td><td>{detail.effective.sources.filter(source=>source.permissions.includes(code)).map(source=>source.roleName).join('、')}</td><td>{aiWorkPermissionUse(detail,code)}</td></tr>)}</tbody></table>
  <p className="aw-muted aw-spaced">业务查询还受当次管理人员的权限限制。</p>
 </>}</section>;
}
function History({value}:{value:AiWorkDetail['history']}){return value.items.length?<ol className="aw-history">{value.items.map(row=><li key={row.operationId}><header><strong>{row.kind==='profile-save'?'资料已更新':row.kind==='state-save'?row.result?.account.enabled?'岗位已启用':'岗位已停用':row.result?.assignment?.enabled?'角色已分配':'角色已撤回'}</strong><time>{aiWorkDate(row.recordedAt)}</time></header><HistoryOperator id={row.operatorId} name={row.operatorDisplayName}/>{row.reason&&<p>{row.reason}</p>}</li>)}</ol>:<p className="aw-muted">暂无工作账户变更记录。</p>;}
function RoleImpact({detail,roleId,enabled}:{detail:AiWorkDetail;roleId:string;enabled:boolean}){
 const impact=aiWorkRoleImpact(detail,roleId,enabled);
 return <p className="aw-impact">{enabled?'分配':'撤回'}后：{impact.added.length?'新增 '+impact.added.length+' 项角色权限':''}{impact.added.length&&impact.removed.length?'；':''}{impact.removed.length?'移除 '+impact.removed.length+' 项角色权限':''}{!impact.added.length&&!impact.removed.length?'其他角色仍提供相同权限，范围不变':''}。{!detail.account.enabled?'岗位当前停用。':''}</p>;
}

export function AiWorkAccounts(props:Props){return <section className="galaxy-ai-work-accounts"><SettingsDraftBoundary scope={aiWorkRoute} resetKey={props.csrfToken}><AiWorkContent {...props}/></SettingsDraftBoundary></section>;}

function AiWorkContent({operatorId,csrfToken,businessAuthorization,initialLocation,initialPage,initialDetail,initialHistory=null,initialError='',initialDetailError='',initialHistoryError=''}:Props){
 const search=useSearchParams(),browser=aiWorkLocation(Object.fromEntries(search.entries())),[pin,setPin]=useState<AiWorkLocation|null>(null),location=pin??browser;
 const list=useOperationsRead<AiWorkPage>({path:aiWorkBase,initial:initialPage,initialError,failureMessage:'AI工作账户暂时无法读取。',clearOnOffline:true});
 const detail=useOperationsRead<AiWorkDetail>({path:aiWorkBase+'/'+location.domain,initial:initialDetail?.account.domain===location.domain?initialDetail:null,initialError:initialLocation.domain===location.domain?initialDetailError:'',failureMessage:'当前岗位暂时无法读取。',clearOnOffline:true});
 const current=detail.verified&&detail.value?.account.domain===location.domain?detail.value:null,account=current?.account;
 const runtimeRead=useOperationsRead<AiWorkRuntimeRead>({path:aiWorkBase+'/'+location.domain+'/runtime',failureMessage:'运行状态暂时无法读取。',clearOnOffline:true});
 const runtime=runtimeRead.verified&&runtimeRead.value?.domain===location.domain?runtimeRead.value.runtime:null;
 const historyRead=useOperationsRead<AiWorkHistory>({path:location.tab==='history'&&location.after?aiWorkBase+'/'+location.domain+'/history?'+new URLSearchParams({after:location.after,limit:'30'}):null,initial:initialLocation.domain===location.domain&&initialLocation.after===location.after?initialHistory:null,initialError:initialLocation.domain===location.domain&&initialLocation.after===location.after?initialHistoryError:'',failureMessage:'变更记录暂时无法读取。',clearOnOffline:true});
 const canReadAutonomy=hasOperatorPermission({businessAuthorization},'autonomy.read');
 const autonomyRead=useOperationsRead<AutonomyOverview>({path:canReadAutonomy?autonomyBase+'/overview':null,failureMessage:'自动运行状态暂时无法读取。',clearOnOffline:true});
 const dutyRead=useOperationsRead<AutonomyConfigRead>({path:canReadAutonomy?autonomyBase+'/accounts/'+location.domain+'/config':null,failureMessage:'值守配置暂时无法读取。',clearOnOffline:true});
 const dutyValue=dutyRead.verified&&dutyRead.value?.config.domain===location.domain?dutyRead.value:null;
 const dutyAccount=autonomyRead.verified?autonomyRead.value?.accounts.find(item=>item.domain===location.domain)??null:null;
 const [delegationDraft,setDelegationDraft]=useState<AiDelegationDraft|null>(null),[delegationRestored,setDelegationRestored]=useState<SettingsPendingReceipt|null>(null),[delegationStatus,setDelegationStatus]=useState<{dirty:boolean;pending:boolean;operationId:string|null}>({dirty:false,pending:false,operationId:null});
 const onDelegationStatus=useCallback((value:{dirty:boolean;pending:boolean;operationId:string|null})=>setDelegationStatus(before=>before.dirty===value.dirty&&before.pending===value.pending&&before.operationId===value.operationId?before:value),[]);
 const [dutyDrafts,setDutyDrafts]=useState<Partial<Record<AiWorkDomain,AutonomyDutyDraft>>>({}),[dutyRestored,setDutyRestored]=useState<SettingsPendingReceipt|null>(null);
 const dutyRestoredRead=useOperationsRead<AutonomyOperation>({path:dutyRestored&&canReadAutonomy?settingsAiWorkReceiptPath(dutyRestored):null,failureMessage:'值守设置的保存结果暂时无法读取。',clearOnOffline:true,retryUnavailable:true});
 const dutyCommand=useAutonomyCommand<AutonomyConfigSave>({csrfToken,canWrite:!!dutyValue&&hasOperatorPermission({businessAuthorization},'autonomy.configure'),onCommitted:async value=>{setDutyDrafts(previous=>{const next={...previous};delete next[value.config.domain];return next;});await Promise.all([dutyRead.read(),autonomyRead.read()]);},onConflict:()=>void dutyRead.read()});
 const [drafts,setDrafts]=useState<Partial<Record<AiWorkDomain,AiWorkProfileDraft>>>({}),[editing,setEditing]=useState<Partial<Record<AiWorkDomain,boolean>>>({}),[roleChoice,setRoleChoice]=useState<Partial<Record<AiWorkDomain,string>>>({}),[choices,setChoices]=useState<{version:number;values:Choices}|null>(null),[message,setMessage]=useState('');
 const directory=useRef<HTMLDivElement|null>(null),positions=useRef(new Map<string,number>()),left=useRef<HTMLDivElement|null>(null),right=useRef<HTMLDivElement|null>(null);
 const canSubmit=useCallback((intent:Intent)=>canSubmitIntent(current,intent),[current]);
 const command=useAiWorkCommand({owner:operatorId,csrfToken,canRead:list.verified,detail:current,canSubmit,onConflict:()=>{void detail.read();},onResult:value=>{setMessage(value.kind==='profile-save'?'岗位资料已保存。':value.kind==='state-save'?value.result?.account.enabled?'岗位已启用。':'岗位已停用。':value.result?.assignment?.enabled?'业务角色已分配。':'业务角色已撤回。');if(value.kind==='profile-save'){setDrafts(previous=>{const next={...previous};delete next[location.domain];return next;});setEditing(previous=>({...previous,[location.domain]:false}));}setRoleChoice(previous=>({...previous,[location.domain]:''}));void detail.read();void list.read();}}),locked=command.locked||dutyCommand.locked||!!dutyRestored||delegationStatus.pending||!!delegationRestored;
 useEffect(()=>{if(!locked)setPin(null);},[locked]);
 const memory=useSettingsDraftMemory({scope:'ai-work',ready:list.verified,blocked:locked,denied:!!list.error&&/登录|权限/.test(list.error),snapshot:()=>({drafts,dutyDrafts,delegationDraft,editing,roleChoice,positions:[...positions.current]}),restore:value=>{setDrafts(value.drafts);setDutyDrafts(value.dutyDrafts??{});setDelegationDraft(value.delegationDraft??null);setEditing(value.editing);setRoleChoice(value.roleChoice);positions.current=new Map(value.positions);setChoices(null);},discard:()=>{setDrafts({});setDutyDrafts({});setDelegationDraft(null);setEditing({});setRoleChoice({});setChoices(null);}}),pendingSession=useRef<SettingsDraftSession|null>(null);
 useLayoutEffect(()=>{
  const session=memory.session;if(!session?.current()){pendingSession.current=null;return;}if(!list.verified||!memory.initialized)return;
  if(pendingSession.current!==session){pendingSession.current=session;const saved=session.pending('ai-work');if(saved&&settingsAiWorkReceiptPath(saved)&&saved.domain){setPin({...browser,domain:saved.domain,tab:saved.kind==='config-save'?'duty':'roles',after:''});if(saved.kind==='config-save')setDutyRestored(saved);else if(saved.kind==='delegation-save')setDelegationRestored(saved);else command.resume(saved);return;}}
  session.setPending('ai-work',delegationRestored??(delegationStatus.operationId?{operationId:delegationStatus.operationId,kind:'delegation-save',domain:'overview'}:dutyRestored??(dutyCommand.pending?{operationId:String(dutyCommand.pending.body.operationId),kind:'config-save',domain:location.domain}:command.pending?{operationId:command.pending.operationId,kind:command.pending.kind,domain:command.pending.domain}:null)));
 },[memory.session,memory.initialized,list.verified,command.pending,dutyCommand.pending,dutyRestored,delegationRestored,delegationStatus]);
 useEffect(()=>{if(!dutyRestored)return;const value=dutyRestoredRead.verified?dutyRestoredRead.value:null;if(value?.state==='recorded'&&'config' in value.result&&value.result.config.domain===dutyRestored.domain){setDutyDrafts(previous=>{const next={...previous};delete next[dutyRestored.domain!];return next;});setDutyRestored(null);setMessage('值守设置已保存。');void dutyRead.read();void autonomyRead.read();return;}const timer=setTimeout(()=>{if(navigator.onLine&&document.visibilityState==='visible')void dutyRestoredRead.read();},5000);return()=>clearTimeout(timer);},[dutyRestored,dutyRestoredRead.value,dutyRestoredRead.verified,dutyRestoredRead.read]);
 const readingKey=location.domain+':'+location.tab;
 useLayoutEffect(()=>{if(left.current)left.current.scrollTop=positions.current.get(readingKey+':left')??0;if(right.current)right.current.scrollTop=positions.current.get(readingKey+':right')??0;},[readingKey,!!current,memory.initialized]);
 useLayoutEffect(()=>{
  const element=directory.current;if(!element||!list.verified||!memory.initialized)return;
  const reveal=()=>{
   const row=element.querySelector<HTMLTableRowElement>('tbody tr[aria-selected="true"]');if(!row)return;
   const bounds=element.getBoundingClientRect(),selected=row.getBoundingClientRect(),top=Math.max(bounds.top,element.querySelector('thead')?.getBoundingClientRect().bottom??bounds.top);
   if(selected.bottom>bounds.bottom)element.scrollTop+=selected.bottom-bounds.bottom+1;
   else if(selected.top<top)element.scrollTop-=top-selected.top+1;
  };
  reveal();let width=element.clientWidth,height=element.clientHeight;
  const observer=new ResizeObserver(()=>{if(width===element.clientWidth&&height===element.clientHeight)return;width=element.clientWidth;height=element.clientHeight;reveal();});observer.observe(element);
  return()=>observer.disconnect();
 },[location.domain,!!list.value?.items.length,list.verified,memory.initialized]);
 const draft=account?drafts[location.domain]??aiWorkProfile(account):null,merge=draft&&account?aiWorkProfileMerge(draft,account,choices?.version===account.version?choices.values:{}):null,dirty=Object.values(drafts).some(draft=>draft.name!==draft.baseName||draft.description!==draft.baseDescription||!!draft.reason);
 useSettingsDraftState(dirty||Object.keys(dutyDrafts).length>0||!!delegationDraft,locked);
 function navigate(patch:Partial<AiWorkLocation>){if(locked)return;const href=aiWorkHref(location,patch);if(href===window.location.pathname+window.location.search)return;setMessage('');setChoices(null);window.history.pushState(null,'',href);}
 async function refresh(){void runtimeRead.read();await Promise.all([list.read(),detail.read(),dutyRead.read(),autonomyRead.read(),...(location.tab==='history'&&location.after?[historyRead.read()]:[])]);}
 function saveDuty(configuration:AutonomyConfig){if(locked||configuration.domain!==location.domain)return;setPin({...location});void dutyCommand.submit(autonomyBase+'/accounts/'+location.domain+'/config',autonomyConfigBody(configuration),'值守设置已保存。');}
 function submit(kind:AiWorkCommandKind,body:Record<string,unknown>){if(!current||locked)return;if(command.submit(location.domain,kind,body)){setPin({...location});setMessage('');}}
 function assign(roleId:string,enabled:boolean){if(!current||!current.capabilities.canAssignRoles)return;const old=current.assignments.find(row=>row.roleId===roleId);if(enabled&&!current.roles.some(role=>role.id===roleId&&role.canAssign))return;submit('assignment-save',{...(old?{id:old.id}:{}),expectedVersion:old?.version??0,roleId,enabled});}
 const active=current?.assignments.filter(row=>row.enabled)??[],available=current?.roles.filter(role=>!active.some(row=>row.roleId===role.id))??[],choice=roleChoice[location.domain]??'',canViewRoles=hasOperatorPermission({businessAuthorization},'permissions.read'),history=location.after?historyRead.value:current?.history,choiceAllowed=available.some(role=>role.id===choice&&role.enabled&&role.canAssign),refreshing=list.refreshing||detail.refreshing||historyRead.refreshing,selected=list.verified?list.value?.items.find(item=>item.domain===location.domain):null;
 return <>
  <header className="aw-heading"><h1>AI工作账户</h1><button type="button" disabled={locked||refreshing} onClick={()=>void refresh()}>{refreshing?'更新中…':'刷新'}</button></header>
  <div className="aw-status"><ReadStatus loading={list.loading} error={list.error} retry={list.read}/>{command.pending?<><p role="status">{command.retryState==='changed'?'这项资料已有更新，原操作结果仍在查询。':command.retryState==='unavailable'?'当前不能办理这次操作，原结果仍在查询。':command.error||'正在更新工作账户…'}</p>{command.retryState&&<button type="button" disabled={command.requesting||command.retryState!=='ready'} onClick={command.retry}>再试这次操作</button>}</>:command.error?<p role="alert" className="galaxy-error">{command.error}</p>:message?<p role="status">{message}</p>:null}</div>
  <div className="aw-workspace"><div className="aw-directory" ref={directory}><table><thead><tr><th>工作账户</th><th>领域</th><th>账户状态</th><th>业务角色</th><th>值守</th><th>上次有效巡检</th><th>下次计划</th></tr></thead><tbody>{list.value?.items.map(item=><tr key={item.id} className={item.domain===location.domain?'is-selected':undefined} aria-selected={item.domain===location.domain} data-selectable={!locked} onClick={event=>{if(!(event.target instanceof Element)||event.target.closest('button,a,input,select,textarea')||window.getSelection()?.toString())return;navigate({domain:item.domain,tab:location.tab,after:''});}}><th scope="row"><button type="button" disabled={locked} onClick={()=>navigate({domain:item.domain,tab:location.tab,after:''})}>{item.name}</button></th><td>{aiWorkLabel(item.domain)}</td><td><AccessStatus account={item}/></td><td>{item.roleNames.join('、')||'未分配角色'}</td><td>{autonomyRead.verified?(()=>{const state=autonomyRead.value?.accounts.find(row=>row.domain===item.domain);return state?<AutonomyState tone={state.config.enabled?state.readiness.ready?'active':'attention':'neutral'}>{autonomyAccountState(state)}</AutonomyState>:'尚未取得';})():'尚未取得'}</td><td>{autonomyRead.verified?autonomyDate(autonomyRead.value?.accounts.find(row=>row.domain===item.domain)?.lastValidAt,true):'—'}</td><td>{autonomyRead.verified?(()=>{const state=autonomyRead.value?.accounts.find(row=>row.domain===item.domain);return state?.config.enabled?autonomyDate(state.nextDueAt,true):state?'待启用':'—';})():'—'}</td></tr>)}</tbody></table>{list.value?.initialization.state==='pending'&&<p className="aw-empty">AI工作账户尚待初始化。</p>}</div>
   <section className="aw-detail" aria-busy={detail.loading}><ReadStatus loading={false} error={detail.error} retry={detail.read}/>{current&&account?<>
    <header className="aw-detail-heading"><div><h2>{account.name}</h2><p>{aiWorkLabel(account.domain)} · <AccessStatus account={account}/></p></div><div className="aw-actions">{current.capabilities.canEditProfile&&<button type="button" disabled={locked} onClick={()=>{setEditing(previous=>({...previous,[location.domain]:true}));setDrafts(previous=>({...previous,[location.domain]:previous[location.domain]??aiWorkProfile(account)}));navigate({tab:'overview',after:''});}}>编辑资料</button>}{current.capabilities.canChangeState&&<button type="button" disabled={locked} onClick={()=>submit('state-save',{kind:'state-save',expectedVersion:account.version,enabled:!account.enabled,reason:''})}>{account.enabled?'停用工作账户':'启用工作账户'}</button>}<Link href={'/admin/operations/ai-runs?domain='+location.domain} prefetch={false}>任务与运行</Link></div></header>
    <AdminTabs ariaLabel="AI工作账户详情" active={location.tab} items={aiWorkTabs.map(tab=>({...tab,disabled:locked&&tab.id!==location.tab}))} onChange={tab=>navigate({tab:tab as AiWorkTab,after:''})}/>
    <div className="aw-detail-body"><div className="aw-scroll" ref={left} onScroll={event=>positions.current.set(readingKey+':left',event.currentTarget.scrollTop)}>
     {location.tab==='overview'&&<section className="aw-panel">{editing[location.domain]&&draft&&merge?<form className="aw-form" onSubmit={event=>{event.preventDefault();if(merge.ready&&current.capabilities.canEditProfile&&merge.name.trim())submit('profile-save',{kind:'profile-save',expectedVersion:account.version,name:merge.name.trim(),description:merge.description.trim(),reason:draft.reason.trim()});}}><fieldset disabled={locked}><legend>岗位资料</legend><label>显示名称<input maxLength={100} required value={draft.name} onChange={event=>{const name=event.target.value;setDrafts(previous=>({...previous,[location.domain]:{...draft,name}}));}}/></label><label>职责说明<textarea maxLength={1000} value={draft.description} onChange={event=>{const description=event.target.value;setDrafts(previous=>({...previous,[location.domain]:{...draft,description}}));}}/></label>{merge.conflicts.map(conflict=><label key={conflict.field}>{conflict.field==='name'?'名称':'职责说明'}已有更新<span>我的修改：{conflict.mine||'空白'}；当前：{conflict.current||'空白'}</span><select value={choices?.version===account.version?choices.values[conflict.field]??'':''} onChange={event=>{const choice=event.target.value;if(choice==='mine'||choice==='current')setChoices(previous=>({version:account.version,values:{...(previous?.version===account.version?previous.values:{}),[conflict.field]:choice}}));}}><option value="">选择保留内容</option><option value="mine">保留我的修改</option><option value="current">使用当前资料</option></select></label>)}<label>修改说明（选填）<textarea maxLength={1000} value={draft.reason} onChange={event=>{const reason=event.target.value;setDrafts(previous=>({...previous,[location.domain]:{...draft,reason}}));}}/></label><div className="aw-actions"><button type="submit" className="aw-primary" disabled={!merge.ready||!current.capabilities.canEditProfile}>保存资料</button><button type="button" onClick={()=>{setEditing(previous=>({...previous,[location.domain]:false}));setDrafts(previous=>{const next={...previous};delete next[location.domain];return next;});}}>取消</button></div></fieldset></form>:<><header><h3>岗位概览</h3></header><p>{account.description||'尚未填写职责说明。'}</p><dl className="aw-facts"><dt>固定领域</dt><dd>{aiWorkLabel(account.domain)}</dd><dt>业务权限</dt><dd>{current.effective.state==='disabled'?'岗位停用':current.effective.state==='unassigned'?'尚未分配角色':current.effective.permissions.length+' 项'}</dd><dt>资料更新</dt><dd>{aiWorkDate(account.updatedAt)}</dd></dl></>}
     </section>}
     {location.tab==='roles'&&location.domain==='overview'&&hasOperatorPermission({businessAuthorization},'ai.delegation.read')&&<AiDelegation csrfToken={csrfToken} canConfigure={hasOperatorPermission({businessAuthorization},'ai.delegation.configure')} ownPermissions={businessAuthorization?.permissions??[]} draft={delegationDraft} onDraft={setDelegationDraft} restored={delegationRestored} onRestored={()=>setDelegationRestored(null)} onStatus={onDelegationStatus}/>}
     {location.tab==='roles'&&<><section className="aw-panel"><header><h3>已分配业务角色</h3><div className="aw-actions"><button type="button" disabled={locked||detail.refreshing} onClick={()=>void detail.read()}>{detail.refreshing?'更新中…':'刷新角色'}</button>{canViewRoles&&<Link href="/admin/operations/permissions?tab=roles" prefetch={false}>管理业务角色</Link>}</div></header>{active.length?<ul className="aw-roles">{active.map(row=><li key={row.id}><div><strong>{canViewRoles?<Link href={'/admin/operations/permissions?tab=roles&id='+row.roleId} prefetch={false}>{row.roleName}</Link>:row.roleName}</strong><p>{row.roleEnabled?'启用中':'角色已停用'} · {row.permissions.length} 项权限</p>{current.capabilities.canAssignRoles&&<RoleImpact detail={current} roleId={row.roleId} enabled={false}/>}</div>{current.capabilities.canAssignRoles&&<button type="button" disabled={locked} onClick={()=>assign(row.roleId,false)}>撤回</button>}</li>)}</ul>:<p className="aw-muted">尚未分配业务角色。</p>}{current.capabilities.canAssignRoles&&<form className="aw-assign" onSubmit={event=>{event.preventDefault();if(choiceAllowed)assign(choice,true);}}><AccountRolePicker roles={available} value={choice} disabled={locked} onChange={id=>setRoleChoice(previous=>({...previous,[location.domain]:id}))}/><button type="submit" className="aw-primary" disabled={locked||!choiceAllowed}>分配角色</button></form>}{choiceAllowed&&<RoleImpact detail={current} roleId={choice} enabled/>}</section><Effective detail={current}/></>}
     {location.tab==='duty'&&(canReadAutonomy?<AiWorkDuty key={location.domain} domain={location.domain} value={dutyValue} account={dutyAccount} loading={dutyRead.loading} error={dutyRead.error} refresh={dutyRead.read} canConfigure={hasOperatorPermission({businessAuthorization},'autonomy.configure')} canReadStrategies={hasOperatorPermission({businessAuthorization},'strategies.read')} draft={dutyDrafts[location.domain]??null} onDraft={value=>setDutyDrafts(previous=>{const next={...previous};if(value)next[location.domain]=value;else delete next[location.domain];return next;})} onSave={saveDuty} locked={locked} detail={current} command={dutyCommand}/>:<section className="aw-panel"><p className="aw-muted">当前没有值守配置的查看权限。</p></section>)}
     {location.tab==='history'&&<AiWorkDutyHistory value={dutyValue}/>}
     {location.tab==='history'&&<section className="aw-panel"><header><h3>工作账户变更记录</h3><Link href={'/admin/operations/ai-runs?domain='+location.domain} prefetch={false}>查看领域运行</Link></header><ReadStatus loading={historyRead.loading} error={historyRead.error} retry={historyRead.read}/>{history&&<History value={history}/>}<div className="aw-actions aw-spaced">{location.after&&<button type="button" disabled={locked} onClick={()=>navigate({after:''})}>最新记录</button>}{history?.nextAfter&&<button type="button" disabled={locked} onClick={()=>navigate({after:history.nextAfter!})}>更早记录</button>}</div></section>}
    </div><div className="aw-scroll" ref={right} onScroll={event=>positions.current.set(readingKey+':right',event.currentTarget.scrollTop)}>
     {location.tab==='roles'&&<Grants value={current.automation} account={account}/>}
     {location.tab==='overview'&&<section className="aw-panel"><header><h3>运行概况</h3>{canReadAutonomy&&<Link href={autonomyRoute} prefetch={false}>自动运行</Link>}</header>{dutyAccount?<><dl className="aw-facts"><dt>值守状态</dt><dd>{autonomyAccountState(dutyAccount)}</dd><dt>处理方式</dt><dd>{autonomyModes[dutyAccount.config.mode]}</dd><dt>值守计划</dt><dd>{autonomySchedule(dutyAccount.config)}</dd><dt>有效巡检</dt><dd>{autonomyDate(dutyAccount.lastValidAt)}</dd><dt>下次计划</dt><dd>{dutyAccount.config.enabled?autonomyDate(dutyAccount.nextDueAt):'待启用'}</dd><dt>应完成 / 已完成</dt><dd>{autonomyNumber(dutyAccount.expected)} / {autonomyNumber(dutyAccount.completed)}</dd><dt>积压 / 待人工</dt><dd>{autonomyNumber(dutyAccount.backlog)} / {autonomyNumber(dutyAccount.waitingHuman)}</dd><dt>提示词 / 计划</dt><dd>v{dutyAccount.config.promptVersion} / v{dutyAccount.config.planVersion}</dd></dl>{dutyAccount.readiness.reasons.length>0&&<ul className="aw-duty-readiness">{dutyAccount.readiness.reasons.map(reason=><li key={reason.code}>{reason.message}</li>)}</ul>}</>:<p className="aw-muted">{canReadAutonomy?'运行信息暂未取得。':'当前没有自动运行的查看权限。'}</p>}</section>}
     {(location.tab==='duty'||location.tab==='overview')&&<section className="aw-panel"><header><h3>有效权限来源</h3><Link href={aiWorkHref(location,{tab:'roles',after:''})} prefetch={false}>角色与权限</Link></header>{current.effective.sources.length?<ul className="aw-grants">{current.effective.sources.map(source=><li key={source.roleId}><strong>{source.roleName}</strong><p>{source.permissions.length} 项权限</p></li>)}</ul>:<p className="aw-muted">尚未分配有效业务角色。</p>}{dutyValue?.config.delegationVersion!==null&&dutyValue?.config.delegationVersion!==undefined&&<p className="aw-muted aw-spaced">总控委派 v{dutyValue.config.delegationVersion}</p>}</section>}
     {location.tab==='roles'&&<section className="aw-panel"><header><h3>管理人员使用权限</h3>{current.humanUse.directoryHref&&<Link href={current.humanUse.directoryHref} prefetch={false}>管理账户</Link>}</header><p>通过管理人员的业务角色授予{aiWorkLabel(location.domain)} AI 使用权限。</p></section>}
     {location.tab==='overview'&&<section className="aw-panel"><header><h3>最近处理</h3><Link href={'/admin/operations/ai-runs?domain='+location.domain} prefetch={false}>全部任务</Link></header><AutonomyTaskList items={autonomyRead.verified?autonomyRead.value?.recentTasks.filter(task=>task.domain===location.domain)??[]:[]} empty={autonomyRead.verified?'尚无已记录的处理事项。':'运行记录尚未取得。'}/></section>}
     {location.tab==='overview'&&<section className="aw-panel"><header><h3>模型</h3>{hasOperatorPermission({businessAuthorization},'models.read')&&<Link href="/admin/operations/models" prefetch={false}>模型与用量</Link>}</header><dl className="aw-facts"><dt>运行服务</dt><dd>{runtime?.state==='connected'?'已连接':runtime?.state==='not-connected'?'尚未连接':runtime?.state==='unavailable'?'暂时不可用':'尚未取得'}</dd><dt>领域模型</dt><dd>{runtime?.modelState==='configured'?'已配置':runtime?.modelState==='not-configured'?'未配置':'尚未取得'}</dd></dl>{runtimeRead.error&&<p className="aw-muted aw-spaced">{runtimeRead.error}</p>}</section>}
     {location.tab==='history'&&<section className="aw-panel"><header><h3>岗位身份</h3></header><dl className="aw-facts"><dt>工作账户</dt><dd>{account.name}</dd><dt>职责</dt><dd>{aiWorkLabel(account.domain)}</dd><dt>创建时间</dt><dd>{aiWorkDate(account.createdAt)}</dd><dt>资料更新</dt><dd>{aiWorkDate(account.updatedAt)}</dd></dl><Link className="aw-spaced" href={'/admin/operations/ai-runs?domain='+location.domain} prefetch={false}>查看任务与运行</Link></section>}
    </div></div>
   </>:<><header className="aw-detail-heading"><div><h2>{selected?.name??aiWorkLabel(location.domain)}</h2><p>{aiWorkLabel(location.domain)}</p></div></header><AdminTabs ariaLabel="AI工作账户详情" active={location.tab} items={aiWorkTabs.map(tab=>({...tab,disabled:locked&&tab.id!==location.tab}))} onChange={tab=>navigate({tab:tab as AiWorkTab,after:''})}/><div className="aw-empty" role={detail.loading?'status':undefined}>{detail.loading?'正在读取工作账户…':list.value?.initialization.state==='pending'?'岗位身份尚待初始化。':'当前岗位暂时无法读取。'}</div></>}</section>
  </div>
 </>;
}
