'use client';

import {SettingsDraftBoundary,useSettingsDraftState} from "../SettingsDraftBoundary";
import {useSettingsDraftMemory} from "../../lib/use-settings-draft-memory";
import {SettingsReceiptNotice,useSettingsReceiptRecovery} from "../../lib/use-settings-receipt-recovery";

import {useCallback,useEffect,useRef,useState} from 'react';
import type {FormEvent,ReactNode} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useOperationsRead} from "../../lib/use-operations-read";
import {operationsRequest,OperationsRequestError} from "../../lib/operations-client";
import {smtpCode,smtpConfiguration,smtpDraft,smtpErrors,smtpFieldLabels,smtpHref,smtpMerge,smtpMergeValue,smtpPageChange,smtpPageQuery,smtpOperationReceipt,smtpOperationReceiptPath,validateSmtpTestOutcome,smtpState,smtpTabs,smtpTime,selectSmtpCredential} from "../../lib/smtp-view-model";
import type {SmtpDraft,SmtpLocation,SmtpMergeChoices} from "../../lib/smtp-view-model";
import type {SmtpBounces,SmtpCredential,SmtpDomains,SmtpHistory,SmtpQueue,SmtpSaveOutcome,SmtpSettings,SmtpTest,SmtpTestOutcome,SmtpTests} from './smtp-types';
import {AdminTabs} from "../AdminTabs";
import {AdminIcon} from "../AdminIcons";
import {AccountPicker} from "../AccountPicker";
import {AccountReference,CommandFeedback,ReadStatus} from "../OperationControls";
import {useOperationCommand} from "../../lib/use-operation-command";
import './smtp.css';

const fields=[['connectionTimeoutMs','连接超时（毫秒）',100,120000],['greetingTimeoutMs','握手超时（毫秒）',100,120000],['socketTimeoutMs','通信超时（毫秒）',100,300000],['maxConnections','并发连接',1,32],['rateLimit','窗口提交上限',1,100000],['rateWindowSeconds','限速窗口（秒）',1,86400]] as const;
function Panel({title,children,className=''}:{title:string;children:ReactNode;className?:string}){return <section className={'galaxy-smtp-panel '+className}><h2>{title}</h2>{children}</section>;}
function Empty({children}:{children:ReactNode}){return <p className="galaxy-smtp-empty">{children}</p>;}
function IdentityTable({settings}:{settings:SmtpSettings|null}){
 return settings?<div className="galaxy-smtp-table-wrap"><table><thead><tr><th>发件身份</th><th>发件地址</th><th>回复地址</th><th>正常来信</th></tr></thead><tbody>{settings.identities.map(identity=><tr key={identity.key}><th>{identity.name}</th><td>{identity.address}</td><td>{identity.replyTo}</td><td>{identity.receiving==='team-only'?'仅团队接收':'仅发信'}</td></tr>)}</tbody></table></div>:<Empty>发件身份暂未取得。</Empty>;
}
function TestRecord({test,available,loading}:{test:SmtpTest|undefined;available:boolean;loading:boolean}){
 return test?<div className="galaxy-smtp-test-result"><strong data-state={test.state}>{smtpState(test.state)}</strong><span>配置版本 {test.configurationVersion} · {smtpTime(test.finishedAt||test.startedAt)}</span>{test.code&&<p>{smtpCode(test.code)}</p>}{test.kind==='delivery'&&test.state==='submitted'&&<p>SMTP已接受；真实送达尚无回执。</p>}</div>:loading?null:<Empty>{available?'尚无这类测试记录。':'测试记录暂未取得。'}</Empty>;
}
function DomainRecords({domains,loading,error,read,offline=false}:{domains:SmtpDomains|null;loading:boolean;error:string;read:()=>Promise<unknown>;offline?:boolean}){
 return <><ReadStatus loading={loading} error={offline?'':error} retry={read}/>{domains?<><dl className="galaxy-smtp-domain-facts">{(['spf','dkim','dmarc'] as const).map(key=><div key={key}><dt>{key.toUpperCase()}</dt><dd>{domains[key].state==='record-found'?'已找到记录':domains[key].state==='not-found'?'未找到记录':domains[key].state==='selector-not-configured'?'未设置选择器':'暂不可查询'}</dd></div>)}</dl><p className="galaxy-smtp-muted">{domains.domain} · {smtpTime(new Date(domains.checkedAt*1000).toISOString())}</p><p className="galaxy-smtp-muted">真实邮件的域名对齐尚未取得。</p></>:offline?<Empty>域名记录暂未取得。</Empty>:!loading&&!error&&<Empty>打开域名与验证后读取当前DNS记录。</Empty>}</>;
}
function QueueTable({queue,compact=false}:{queue:SmtpQueue|null;compact?:boolean}){
 if(!queue)return <Empty>发送记录暂未取得。</Empty>;
 const rows=compact?queue.items.slice(0,5):queue.items;
 return rows.length?<div className="galaxy-smtp-table-wrap"><table><thead><tr><th>收件账户</th><th>状态</th><th>尝试次数</th><th>更新时间（上海）</th>{!compact&&<th>执行记录</th>}</tr></thead><tbody>{rows.map(item=><tr key={item.id}><td><AccountReference id={item.accountId} label={item.uid?'UID '+item.uid:'查看账户'}/></td><td><span className="galaxy-smtp-state" data-state={item.state}>{smtpState(item.state)}</span>{item.code&&<small>{smtpCode(item.code)}</small>}</td><td>{item.attemptCount}</td><td>{smtpTime(item.updatedAt)}</td>{!compact&&<td><Link href={'/admin/operations/messaging?run='+item.runId}>查看执行</Link></td>}</tr>)}</tbody></table></div>:<Empty>尚无消息计划的邮件投递记录。</Empty>;
}

export function Smtp(props:Parameters<typeof SmtpSettings>[0]){return <SettingsDraftBoundary scope="/admin/operations/smtp" resetKey={props.csrfToken}><SmtpSettings {...props}/></SettingsDraftBoundary>;}
function SmtpSettings({location,csrfToken}:{location:SmtpLocation;csrfToken:string}){
 const router=useRouter();
 const [online,setOnline]=useState(true);
 useEffect(()=>{const update=()=>setOnline(navigator.onLine);update();window.addEventListener('online',update);window.addEventListener('offline',update);return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};},[]);
 const settings=useOperationsRead<SmtpSettings>({path:'/v1/operations/smtp',clearOnOffline:true,failureMessage:'发信配置暂时无法取得。'});
 const queue=useOperationsRead<SmtpQueue>({path:'/v1/operations/smtp/queue?'+smtpPageQuery(location.queueAfter),clearOnOffline:true,failureMessage:'发送队列暂时无法取得。'});
 const tests=useOperationsRead<SmtpTests>({path:location.tab==='configuration'?'/v1/operations/smtp/tests?'+smtpPageQuery(location.testsAfter):null,clearOnOffline:true,failureMessage:'测试记录暂时无法取得。'});
 const history=useOperationsRead<SmtpHistory>({path:location.tab==='configuration'?'/v1/operations/smtp/history?'+smtpPageQuery(location.historyAfter):null,clearOnOffline:true,failureMessage:'配置变更暂时无法取得。'});
 const domains=useOperationsRead<SmtpDomains>({path:location.tab==='domains'?'/v1/operations/smtp/domains':null,clearOnOffline:true,failureMessage:'域名记录暂时无法取得。'});
 const bounces=useOperationsRead<SmtpBounces>({path:'/v1/operations/smtp/bounces',clearOnOffline:true,failureMessage:'退信状态暂时无法取得。'});
 const current=settings.verified?settings.value:null,currentQueue=current&&queue.verified?queue.value:null;
 const [draft,setDraft]=useState<SmtpDraft|null>(null),[base,setBase]=useState<{version:number;draft:SmtpDraft;credentials:SmtpCredential[]}|null>(null),[formError,setFormError]=useState('');
 const [mergeChoices,setMergeChoices]=useState<SmtpMergeChoices>({}),[savedReadVersion,setSavedReadVersion]=useState<number|null>(null);
 const mergeVersion=useRef<number|null>(null);
 const [recipient,setRecipient]=useState<string[]>([]),[senderKey,setSenderKey]=useState('');
 const mainScroll=useRef<HTMLDivElement|null>(null),asideScroll=useRef<HTMLElement|null>(null),positions=useRef<Record<string,{main:number;aside:number}>>({});
 const memory=useSettingsDraftMemory({scope:'smtp',ready:!!current&&settings.verified,denied:!!settings.error&&/登录|权限/.test(settings.error),snapshot:()=>({draft,base,choices:mergeChoices,positions:positions.current}),restore:value=>{setDraft(value.draft);setBase(value.base);setMergeChoices(value.choices);positions.current=value.positions;},discard:()=>{setDraft(null);setBase(null);setMergeChoices({});}});
 useEffect(()=>{if(memory.initialized&&current&&draft===null){const value=smtpDraft(current.configuration);setDraft(value);setBase({version:current.version,draft:value,credentials:current.credentials});}},[memory.initialized,current,draft]);
 useEffect(()=>{if(current&&mergeVersion.current!==current.version){mergeVersion.current=current.version;setMergeChoices({});}},[current?.version]);
 useEffect(()=>{if(mainScroll.current)mainScroll.current.scrollTop=positions.current[location.tab]?.main??0;if(asideScroll.current)asideScroll.current.scrollTop=positions.current[location.tab]?.aside??0;},[location.tab]);
 const parsed=draft?smtpConfiguration(draft):{value:null,error:''},dirty=!!draft&&!!base&&JSON.stringify(draft)!==JSON.stringify(base.draft);
 const baseVersion=base?.version??null,changed=!!current&&baseVersion!==null&&baseVersion!==current.version,mergeCredentials=[...(current?.credentials??[]),...(base?.credentials??[])];
 const merged=changed&&base&&draft&&current?smtpMerge(base.draft,draft,smtpDraft(current.configuration),mergeVersion.current===current.version?mergeChoices:{},mergeCredentials):null;
 const credential=current?.credentials.find(value=>value.ref===current.configuration.credentialRef),testIdentities=current?.identities.filter(value=>credential?.purposes.includes(value.key))??[];
 const ready=!!current&&current.version>0&&current.status.credentialAvailable&&Object.entries(current.configuration).every(([key,value])=>key==='dkimSelector'||value!==null);
 const refresh=useCallback(async()=>{await Promise.all([settings.read(),queue.read(),tests.read(),history.read(),domains.read(),bounces.read()]);},[settings.read,queue.read,tests.read,history.read,domains.read,bounces.read]);
 const clearReadState=useCallback(()=>{settings.clear();queue.clear();tests.clear();history.clear();domains.clear();bounces.clear();setDraft(null);setBase(null);setSavedReadVersion(null);setRecipient([]);},[settings.clear,queue.clear,tests.clear,history.clear,domains.clear,bounces.clear]);
 const readOriginal=useCallback(async(intent:Readonly<{path:string;body:Record<string,unknown>}>,{signal}:{signal:AbortSignal})=>{
  try{return smtpOperationReceipt(intent,await operationsRequest<unknown>(smtpOperationReceiptPath(intent),{signal}));}
  catch(error){if(error instanceof OperationsRequestError&&[401,403].includes(error.status)){clearReadState();throw error;}throw Error('Original SMTP result unavailable');}
 },[clearReadState]);
 const recoverSave=useCallback(async(intent:Readonly<{path:string;body:Record<string,unknown>}>,options:{signal:AbortSignal})=>{const receipt=await readOriginal(intent,options);if(receipt.kind!=='settings')throw Error('Different original SMTP save');return {state:'recorded' as const,value:{source:'original-receipt' as const,receipt}};},[readOriginal]);
 const recoverTest=useCallback(async(intent:Readonly<{path:string;body:Record<string,unknown>}>,options:{signal:AbortSignal})=>{const receipt=await readOriginal(intent,options);if(receipt.kind==='settings')throw Error('Different original SMTP test');return {state:'recorded' as const,value:{source:'original-receipt' as const,receipt}};},[readOriginal]);
 const saved=useCallback(async(value:SmtpSaveOutcome)=>{
  if('source' in value){setSavedReadVersion(value.receipt.result.version);await refresh();return;}
  const next=smtpDraft(value.configuration);setDraft(next);setBase({version:value.version,draft:next,credentials:current?.credentials??[]});setMergeChoices({});setFormError('');await refresh();
 },[refresh,current?.credentials]);
 const committedTest=useCallback(async()=>{await refresh();},[refresh]);
 const conflict=useCallback(()=>{void settings.read();void tests.read();},[settings.read,tests.read]);
 const canRecover=!!current&&settings.verified;
 const save=useOperationCommand<SmtpSaveOutcome>({csrfToken,canWrite:!!current?.capabilities.configure&&!settings.loading,canRecover,recover:recoverSave,onCommitted:saved,onConflict:conflict,errorMessages:smtpErrors});
 const connection=useOperationCommand<SmtpTestOutcome>({csrfToken,canWrite:!!current?.capabilities['test.connection']&&!settings.loading,canRecover,recover:recoverTest,validateResult:validateSmtpTestOutcome,onCommitted:committedTest,onConflict:conflict,errorMessages:smtpErrors});
 const delivery=useOperationCommand<SmtpTestOutcome>({csrfToken,canWrite:!!current?.capabilities['test.delivery']&&!settings.loading,canRecover,recover:recoverTest,validateResult:validateSmtpTestOutcome,onCommitted:committedTest,onConflict:conflict,errorMessages:smtpErrors});
 const live=save.pending?{operationId:String(save.pending.body.operationId),kind:'settings'}:connection.pending?{operationId:String(connection.pending.body.operationId),kind:'test.connection'}:delivery.pending?{operationId:String(delivery.pending.body.operationId),kind:'test.delivery'}:null;
 const recovery=useSettingsReceiptRecovery({scope:'smtp',refresh:refresh,live,ready:!!current&&settings.verified,denied:!!settings.error&&/登录|权限/.test(settings.error),onRecorded:refresh,onDenied:clearReadState});
 const locked=save.locked||connection.locked||delivery.locked||recovery.pending||savedReadVersion!==null;
 useEffect(()=>{
  if(savedReadVersion===null||!current||!settings.verified||current.version<savedReadVersion)return;
  // Only a complete current read can supply the new baseline; the receipt has no configuration.
  const next=smtpDraft(current.configuration);setDraft(next);setBase({version:current.version,draft:next,credentials:current.credentials});setMergeChoices({});setFormError('');setSavedReadVersion(null);
 },[savedReadVersion,current,settings.verified]);
 useEffect(()=>{if(current&&changed&&merged?.draft&&merged.unresolved===0&&!locked){setDraft(merged.draft);setBase({version:current.version,draft:smtpDraft(current.configuration),credentials:current.credentials});setMergeChoices({});setFormError('');}},[current,changed,merged,locked]);
 function navigate(patch:Partial<SmtpLocation>){if(!locked)router.push(smtpHref(location,patch),{scroll:false});}
 function input(key:keyof SmtpDraft,value:string|boolean){setFormError('');setMergeChoices(previous=>{const next={...previous};delete next[key==='host'||key==='port'||key==='tls'||key==='credentialRef'?'connection':key];return next;});setDraft(previous=>previous?{...previous,[key]:value}:previous);}
 async function saveConfiguration(){if(!current||baseVersion===null||changed||locked||!current.capabilities.configure)return;if(!parsed.value){setFormError(parsed.error);return;}await save.submit('/v1/operations/smtp/settings',{expectedVersion:baseVersion,configuration:parsed.value},'发信配置已保存。');}
 function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();void saveConfiguration();}
 function revertLocal(){if(!current||locked)return;const next=smtpDraft(current.configuration);setDraft(next);setBase({version:current.version,draft:next,credentials:current.credentials});setMergeChoices({});setFormError('');}
 async function testConnection(){if(!current||!ready||dirty||locked||!current.capabilities['test.connection'])return;await connection.submit('/v1/operations/smtp/tests/connection',{expectedVersion:current.version},'连接测试请求已记录。');}
 async function testDelivery(event:FormEvent<HTMLFormElement>){event.preventDefault();if(!current||!ready||dirty||locked||!current.capabilities['test.delivery']||!current.capabilities.canChooseRecipient||recipient.length!==1||!testIdentities.some(identity=>identity.key===senderKey))return;await delivery.submit('/v1/operations/smtp/tests/delivery',{expectedVersion:current.version,accountId:recipient[0],senderKey},'投递测试请求已记录。');}
 function page(kind:'queue'|'tests'|'history',nextAfter?:string){navigate(smtpPageChange(location,kind,nextAfter));}
 const shownTests=current&&tests.verified?tests.value:null,shownHistory=current&&history.verified?history.value:null;
 const status=current?(current.status.state!=='configured'?(current.version?'配置待补齐或凭据不可用':'发信服务尚未配置'):current.status.enabled?'日常发信配置已启用':'配置已保存，日常发信未启用'):settings.loading?'正在读取配置':'发信配置暂未取得';
 const latestConnection=shownTests?.items.find(test=>test.kind==='connection'),latestDelivery=shownTests?.items.find(test=>test.kind==='delivery');
 const conflictPanel=changed&&current&&<section className="galaxy-smtp-conflict" aria-label="发信配置版本变化"><p>配置已有新版本，你的修改已保留。</p>{merged?.draft?<><p>选择有冲突的设置，其余更改自动保留。</p>{merged.conflicts.map(item=><fieldset className="galaxy-smtp-conflict-options" key={item.key}><legend>{item.label}</legend>{(['current','mine'] as const).map(choice=><label key={choice}><input type="radio" name={'smtp-merge-'+item.key} checked={mergeChoices[item.key]===choice} onChange={()=>setMergeChoices(previous=>({...previous,[item.key]:choice}))}/><span>{choice==='current'?'当前配置':'我的修改'}：{smtpMergeValue(item[choice],mergeCredentials)}</span></label>)}</fieldset>)}</>:<p>发信连接信息暂未完整取得，重新读取后可合并。</p>}</section>;
 useSettingsDraftState(dirty,locked);
 return <section className="galaxy-smtp" aria-label="发信服务与身份">
  <header className="galaxy-smtp-heading"><div><h1>发信服务与身份</h1><p>SMTP设置与当前发送记录</p><ReadStatus loading={false} error={online?'':'网络已断开，恢复后会更新配置与发送记录。'} retry={refresh}/></div><button type="button" className="galaxy-smtp-secondary" disabled={save.busy||connection.busy||delivery.busy} onClick={()=>void refresh()}><AdminIcon name="refresh" size={15}/>刷新</button></header>
  <AdminTabs active={location.tab} items={smtpTabs.map(tab=>({...tab,disabled:locked}))} onChange={tab=>navigate({tab:tab as SmtpLocation['tab']})} ariaLabel="发信服务栏目"/>
  <div className="galaxy-smtp-workspace">
   <div ref={mainScroll} className="galaxy-smtp-main" onScroll={event=>{positions.current[location.tab]={main:event.currentTarget.scrollTop,aside:asideScroll.current?.scrollTop??0};}}>
    <SettingsReceiptNotice recovery={recovery}/><ReadStatus loading={settings.loading} error={online?settings.error:''} retry={settings.read}/>
    {location.tab==='configuration'&&<>
     <Panel title="发信服务配置">
      <div className="galaxy-smtp-configuration-status"><span className="galaxy-smtp-dot" data-enabled={current?.status.state==='configured'&&current.status.enabled}/><strong>{status}</strong><span>{current?(current.version?'配置版本 '+current.version:'尚无配置版本'):'配置版本暂未取得'}</span></div>
      {draft?<form onSubmit={event=>void submit(event)}><fieldset disabled={!current?.capabilities.configure||locked||settings.loading}>
       {conflictPanel}
       <div className="galaxy-smtp-form-grid"><label className="galaxy-smtp-wide">SMTP主机<input value={draft.host} maxLength={253} autoComplete="off" onChange={event=>input('host',event.target.value)}/></label><label>端口<input inputMode="numeric" value={draft.port} maxLength={5} onChange={event=>input('port',event.target.value)}/></label><label>连接安全<select value={draft.tls} onChange={event=>input('tls',event.target.value)}><option value="">尚未设置</option><option value="implicit">隐式TLS</option><option value="starttls">必须STARTTLS</option></select></label></div>
       <label>批准的凭据引用<select value={draft.credentialRef} onChange={event=>{setFormError('');setMergeChoices(previous=>{const next={...previous};delete next.connection;return next;});setDraft(previous=>previous?selectSmtpCredential(previous,event.target.value,current?.credentials??[]):previous);}}><option value="">尚未选择</option>{current?.credentials.map(credential=><option key={credential.ref} value={credential.ref} disabled={!credential.available}>{credential.label} · {credential.host}:{credential.port}</option>)}</select></label>
       {!current?.credentials.length&&<p className="galaxy-smtp-muted">尚无注入的发信凭据。可先保存非秘密配置。</p>}
       <div className="galaxy-smtp-parameters">{fields.map(([key,label,minimum,maximum])=><label key={key}>{label}<input inputMode="numeric" value={draft[key]} min={minimum} max={maximum} maxLength={6} onChange={event=>input(key,event.target.value)}/></label>)}</div>
       <p className="galaxy-smtp-muted">并发与限速按每个发信进程计算。</p>
       <label className="galaxy-smtp-check"><input type="checkbox" checked={draft.enabled} onChange={event=>input('enabled',event.target.checked)}/>启用日常发信</label>
       {formError&&<p className="galaxy-error" role="alert">{formError}</p>}
       {current?.capabilities.configure&&<div className="galaxy-smtp-actions"><button type="submit" disabled={changed||!dirty}>{draft.enabled&&!current.configuration.enabled?'保存并启用发信':'保存配置'}</button>{dirty&&<button type="button" className="galaxy-smtp-secondary" disabled={locked} onClick={revertLocal}>撤销本地修改</button>}</div>}
      </fieldset></form>:!settings.loading&&<Empty>重新读取后可以查看发信配置。</Empty>}
      <CommandFeedback command={save}/>
     </Panel>
     <Panel title="发信测试">
      {dirty&&<p className="galaxy-smtp-muted">先保存配置更改，再测试已保存的版本。</p>}
      {current?.capabilities['test.connection']&&<div className="galaxy-smtp-actions"><button type="button" className="galaxy-smtp-secondary" disabled={!ready||dirty||locked} onClick={()=>void testConnection()}>连接测试</button><span className="galaxy-smtp-muted">仅检查连接与认证。</span></div>}
      <CommandFeedback command={connection}/>
      {current?.capabilities['test.delivery']&&current.capabilities.canChooseRecipient?<form onSubmit={event=>void testDelivery(event)}><fieldset disabled={!ready||dirty||locked}><label>测试发件身份<select value={senderKey} onChange={event=>setSenderKey(event.target.value)} required><option value="">选择发件身份</option>{testIdentities.map(identity=><option key={identity.key} value={identity.key}>{identity.name} · {identity.address}</option>)}</select></label><AccountPicker selected={recipient} onChange={setRecipient} maxSelected={1} canSearchEmail={false} clearOnOffline disabled={!ready||dirty||locked}/><div className="galaxy-smtp-actions"><button type="submit" disabled={recipient.length!==1||!testIdentities.some(value=>value.key===senderKey)}>投递测试</button><span className="galaxy-smtp-muted">向所选账户提交一封测试邮件。</span></div></fieldset></form>:current?.capabilities['test.delivery']&&<p className="galaxy-smtp-muted">当前没有查找收件账户的权限。</p>}
      <CommandFeedback command={delivery}/>
      {!current?.capabilities['test.connection']&&!current?.capabilities['test.delivery']&&current&&<Empty>当前权限仅可查看测试记录。</Empty>}
      <ReadStatus loading={tests.loading} error={online?tests.error:''} retry={tests.read}/>
      <div className="galaxy-smtp-test-results"><section><h3>连接测试记录</h3><TestRecord test={latestConnection} available={!!shownTests} loading={tests.loading}/></section><section><h3>投递测试记录</h3><TestRecord test={latestDelivery} available={!!shownTests} loading={tests.loading}/></section></div>
      {shownTests?.items.length? <div className="galaxy-smtp-table-wrap"><table><thead><tr><th>测试</th><th>配置版本</th><th>结果</th><th>时间（上海）</th></tr></thead><tbody>{shownTests.items.map(test=><tr key={test.id}><td>{test.kind==='connection'?'连接与认证':'邮件提交'}</td><td>{test.configurationVersion}</td><td>{smtpState(test.state)}</td><td>{smtpTime(test.finishedAt||test.startedAt)}</td></tr>)}</tbody></table></div>:null}
      <div className="galaxy-smtp-pagination">{location.testsAfter&&<button type="button" className="galaxy-smtp-secondary" disabled={locked} onClick={()=>page('tests')}>较新的测试</button>}{shownTests?.nextAfter&&<button type="button" className="galaxy-smtp-secondary" disabled={locked} onClick={()=>page('tests',shownTests.nextAfter!)}>较早的测试</button>}</div>
     </Panel>
     <Panel title="发件身份"><IdentityTable settings={current}/></Panel>
     <Panel title="配置变更"><ReadStatus loading={history.loading} error={online?history.error:''} retry={history.read}/>{shownHistory?.items.length?<ol className="galaxy-smtp-history">{shownHistory.items.map(item=><li key={item.id}><strong>配置版本 {item.version}</strong><span>{item.changedFields.map(key=>smtpFieldLabels[key]).filter(Boolean).join('、')||'配置已保存'}</span><time>{smtpTime(item.createdAt)}</time></li>)}</ol>:shownHistory&&<Empty>尚无配置变更记录。</Empty>}<div className="galaxy-smtp-pagination">{location.historyAfter&&<button type="button" className="galaxy-smtp-secondary" disabled={locked} onClick={()=>page('history')}>较新的变更</button>}{shownHistory?.nextAfter&&<button type="button" className="galaxy-smtp-secondary" disabled={locked} onClick={()=>page('history',shownHistory.nextAfter!)}>较早的变更</button>}</div></Panel>
    </>}
    {location.tab==='identities'&&<Panel title="官方发件身份"><IdentityTable settings={current}/><p className="galaxy-smtp-muted">前四类仅发信；只有团队地址接正常来信。</p></Panel>}
    {location.tab==='queue'&&<Panel title="系统邮件发送队列"><ReadStatus loading={queue.loading} error={online?queue.error:''} retry={queue.read}/><QueueTable queue={currentQueue}/><div className="galaxy-smtp-pagination">{location.queueAfter&&<button type="button" className="galaxy-smtp-secondary" disabled={locked} onClick={()=>page('queue')}>较新的记录</button>}{currentQueue?.nextAfter&&<button type="button" className="galaxy-smtp-secondary" disabled={locked} onClick={()=>page('queue',currentQueue.nextAfter!)}>较早的记录</button>}</div></Panel>}
    {location.tab==='bounces'&&<Panel title="退信记录"><ReadStatus loading={bounces.loading} error={online?bounces.error:''} retry={bounces.read}/>{current&&bounces.value&&<Empty>退信回执尚未接入。</Empty>}</Panel>}
    {location.tab==='domains'&&<><Panel title="域名DNS记录"><DomainRecords domains={current&&domains.verified?domains.value:null} loading={domains.loading} error={domains.error} read={domains.read} offline={!online}/>{current&&domains.value&&<div className="galaxy-smtp-domain-records">{(['spf','dkim','dmarc'] as const).map(key=><section key={key}><h3>{key.toUpperCase()}</h3>{domains.value![key].records.map((record,index)=><code key={index}>{record}</code>)}</section>)}</div>}</Panel><Panel title="DKIM选择器">{conflictPanel}{draft?<label>已知选择器<input value={draft.dkimSelector} maxLength={63} disabled={!current?.capabilities.configure||locked} onChange={event=>input('dkimSelector',event.target.value)}/></label>:<Empty>当前配置暂未取得。</Empty>}<p className="galaxy-smtp-muted">与当前未保存的发信参数一起保存。</p>{formError&&<p className="galaxy-error" role="alert">{formError}</p>}{current?.capabilities.configure&&dirty&&<div className="galaxy-smtp-actions"><button type="button" disabled={locked||changed} onClick={()=>void saveConfiguration()}>保存配置</button><button type="button" className="galaxy-smtp-secondary" disabled={locked} onClick={revertLocal}>撤销本地修改</button></div>}<CommandFeedback command={save}/></Panel></>}
   </div>
   <aside ref={asideScroll} className="galaxy-smtp-aside" aria-label="当前运行状态" onScroll={event=>{positions.current[location.tab]={main:mainScroll.current?.scrollTop??0,aside:event.currentTarget.scrollTop};}}>
    <Panel title="当前发送状态"><div className="galaxy-smtp-metrics">{(['pending','submitting','submitted','unknown'] as const).map(state=><div key={state}><span>{smtpState(state)}</span><strong>{currentQueue?(currentQueue.counts[state]??0).toLocaleString('zh-CN'):'未取得'}</strong></div>)}</div><p className="galaxy-smtp-muted">消息计划邮件账本 · SMTP提交不等于真实送达。</p></Panel>
    {location.tab!=='queue'&&<Panel title="发送队列"><ReadStatus loading={queue.loading} error={online?queue.error:''} retry={queue.read}/><QueueTable queue={currentQueue} compact/><button type="button" className="galaxy-smtp-text" disabled={locked} onClick={()=>navigate({tab:'queue'})}>查看发送队列</button></Panel>}
    {location.tab!=='domains'&&<Panel title="域名与验证"><DomainRecords domains={current&&domains.verified?domains.value:null} loading={domains.loading} error={domains.error} read={domains.read} offline={!online}/><button type="button" className="galaxy-smtp-text" disabled={locked} onClick={()=>navigate({tab:'domains'})}>查看域名与验证</button></Panel>}
    {location.tab!=='bounces'&&<Panel title="退信回执"><ReadStatus loading={bounces.loading} error={online?bounces.error:''} retry={bounces.read}/><Empty>{current&&bounces.value?'回执尚未接入，退信数量未知。':'退信状态暂未取得。'}</Empty></Panel>}
   </aside>
  </div>
 </section>;
}
