'use client';

import {useCallback,useContext,useEffect,useState} from 'react';
import Link from 'next/link';
import {AccountPicker} from '../AccountPicker';
import {CommandFeedback,ReadStatus} from '../OperationControls';
import {useOperationCommand} from '../../lib/use-operation-command';
import {useOperationsRead} from '../../lib/use-operations-read';
import {operationsRequest,OperationsRequestError} from '../../lib/operations-client';
import {SettingsDraftMemoryContext} from '../../lib/use-settings-draft-memory';
import {SettingsReceiptNotice,useSettingsReceiptRecovery} from '../../lib/use-settings-receipt-recovery';
import {smtpCode,smtpErrors,smtpFieldLabels,smtpPageQuery,smtpOperationReceipt,smtpOperationReceiptPath,validateSmtpTestOutcome,smtpState,smtpTime} from '../../lib/smtp-view-model';
import type {SmtpBounces,SmtpDomains,SmtpHistory,SmtpQueue,SmtpSettings,SmtpTestOutcome,SmtpTests} from "../smtp/smtp-types";

/** Existing operations SMTP read/test contracts, without a second connection editor. */
export function SystemSettingsMailOperations({active,canRead,csrfToken,configurationLocked,configurationDirty,onPendingChange}:{active:boolean;canRead:boolean;csrfToken:string;configurationLocked:boolean;configurationDirty:boolean;onPendingChange:(value:boolean)=>void}){
 const session=useContext(SettingsDraftMemoryContext),[cursors,setCursors]=useState<Record<'tests'|'history',string[]>>({tests:[''],history:['']});
 const [recipient,setRecipient]=useState<string[]>([]),[sender,setSender]=useState(''),[activeKind,setActiveKind]=useState<'connection'|'delivery'|null>(null);
 const enabled=canRead&&(active||!!session?.pending('smtp'));
 const settings=useOperationsRead<SmtpSettings>({path:enabled?'/v1/operations/smtp':null,clearOnOffline:true,failureMessage:'运营邮件状态暂时无法读取。'});
 const queue=useOperationsRead<SmtpQueue>({path:enabled?'/v1/operations/smtp/queue?limit=1':null,clearOnOffline:true,failureMessage:'投递状态暂时无法读取。'});
 const tests=useOperationsRead<SmtpTests>({path:enabled?'/v1/operations/smtp/tests?'+smtpPageQuery(cursors.tests.at(-1)??''):null,clearOnOffline:true,failureMessage:'测试记录暂时无法读取。'});
 const history=useOperationsRead<SmtpHistory>({path:enabled?'/v1/operations/smtp/history?'+smtpPageQuery(cursors.history.at(-1)??''):null,clearOnOffline:true,failureMessage:'连接变更记录暂时无法读取。'});
 const domains=useOperationsRead<SmtpDomains>({path:enabled?'/v1/operations/smtp/domains':null,clearOnOffline:true,failureMessage:'域名记录暂时无法读取。'});
 const bounces=useOperationsRead<SmtpBounces>({path:enabled?'/v1/operations/smtp/bounces':null,clearOnOffline:true,failureMessage:'退信状态暂时无法读取。'});
 const current=settings.available?settings.value:null;
 const refresh=useCallback(async()=>{await Promise.all([settings.read(),queue.read(),tests.read(),history.read(),domains.read(),bounces.read()]);},[settings.read,queue.read,tests.read,history.read,domains.read,bounces.read]);
 const clearReadState=useCallback(()=>{settings.clear();queue.clear();tests.clear();history.clear();domains.clear();bounces.clear();setRecipient([]);},[settings.clear,queue.clear,tests.clear,history.clear,domains.clear,bounces.clear]);
 const recover=useCallback(async(intent:Readonly<{path:string;body:Record<string,unknown>}>,{signal}:{signal:AbortSignal})=>{
  try{
   const receipt=smtpOperationReceipt(intent,await operationsRequest<unknown>(smtpOperationReceiptPath(intent),{signal}));
   if(receipt.kind==='settings')throw Error('Different original mail test');
   return {state:'recorded' as const,value:{source:'original-receipt' as const,receipt}};
  }catch(error){if(error instanceof OperationsRequestError&&[401,403].includes(error.status)){clearReadState();throw error;}throw Error('Original mail test result unavailable');}
 },[clearReadState]);
 const canWrite=canRead&&!!current&&(activeKind?current.capabilities[activeKind==='connection'?'test.connection':'test.delivery']:current.capabilities['test.connection']||current.capabilities['test.delivery']);
 const command=useOperationCommand<SmtpTestOutcome>({csrfToken,canWrite,canRecover:canRead&&!!current&&settings.verified,onCommitted:refresh,onConflict:()=>void refresh(),errorMessages:smtpErrors,recover,validateResult:validateSmtpTestOutcome});
 useEffect(()=>{if(!command.locked)setActiveKind(null);},[command.locked]);
 const live=command.pending?{operationId:String(command.pending.body.operationId),kind:command.pending.path.endsWith('/connection')?'test.connection':'test.delivery'}:null;
 const recovery=useSettingsReceiptRecovery({scope:'smtp',live,ready:!!current,denied:!!settings.error&&/登录|权限/.test(settings.error),refresh,onRecorded:refresh,onDenied:clearReadState});
 const ownPending=canRead&&(command.locked||recovery.pending);
 useEffect(()=>{onPendingChange(ownPending);return()=>onPendingChange(false);},[ownPending,onPendingChange]);
 const locked=configurationLocked||ownPending;
 const ready=!!current&&current.version>0&&current.status.credentialAvailable&&Object.entries(current.configuration).every(([key,value])=>key==='dkimSelector'||value!==null);
 const credential=current?.credentials.find(row=>row.ref===current.configuration.credentialRef),senders=current?.identities.filter(row=>credential?.purposes.includes(row.key))??[];
 const replyCounts=new Map<string,number>();for(const row of current?.identities??[])replyCounts.set(row.replyTo,(replyCounts.get(row.replyTo)??0)+1);
 let commonReplyTo:string|null=null,commonReplyCount=1;for(const[address,count]of replyCounts)if(count>commonReplyCount){commonReplyTo=address;commonReplyCount=count;}
 const page=(key:'tests'|'history',after?:string)=>{if(locked)return;setCursors(previous=>({...previous,[key]:after?[...previous[key],after].slice(-30):previous[key].length>1?previous[key].slice(0,-1):['']}));};
 const pageButtons=(key:'tests'|'history',next:string|null|undefined)=><div className="ss-actions ss-mail-pagination">{cursors[key].length>1&&<button type="button" disabled={locked} onClick={()=>page(key)}>上一批</button>}{next&&<button type="button" disabled={locked} onClick={()=>page(key,next)}>下一批</button>}</div>;
 async function test(kind:'connection'|'delivery'){
  if(!current||!ready||locked||configurationDirty||!current.capabilities['test.'+kind as 'test.connection'|'test.delivery'])return;
  if(kind==='delivery'&&(!current.capabilities.canChooseRecipient||recipient.length!==1||!senders.some(row=>row.key===sender)))return;
  setActiveKind(kind);
  await command.submit('/v1/operations/smtp/tests/'+kind,{expectedVersion:current.version,...(kind==='delivery'?{accountId:recipient[0],senderKey:sender}:{})},kind==='connection'?'运营发信连接测试已完成。':'投递测试已处理，请查看提交结果。');
 }
 return <div className="ss-mail-operations" hidden={!active}>
  <section className="ss-panel"><header><h2>官方发件身份</h2>{canRead&&<button type="button" disabled={command.busy} onClick={()=>void refresh()}>更新状态</button>}</header>
   {!canRead?<p className="ss-muted">当前没有查看邮件运行状态的权限。</p>:<><ReadStatus loading={settings.loading} error={settings.error} retry={settings.read}/>{current&&<>{commonReplyTo&&<div className="ss-mail-common-reply"><span className="ss-muted">共同回复地址</span><span className="ss-mail-address">{commonReplyTo}</span>{commonReplyCount<current.identities.length&&<p className="ss-muted">未单独注明的身份均使用此回复地址。</p>}</div>}<ul className="ss-mail-identities" aria-label="官方发件身份">{current.identities.map(row=><li key={row.key}><div className="ss-mail-identity-heading"><strong>{row.name}</strong><span className="ss-mail-receiving">{row.receiving==='team-only'?'接收正常来信':'仅发信'}</span></div><span className="ss-mail-address">{row.address}</span>{row.replyTo!==commonReplyTo&&<div className="ss-mail-row-reply"><span className="ss-muted">回复地址</span><span className="ss-mail-address">{row.replyTo}</span></div>}</li>)}</ul></>}</>}
  </section>
  {canRead&&<><section className="ss-panel"><header><h2>运营发信测试</h2></header><SettingsReceiptNotice recovery={recovery}/><CommandFeedback command={command}/>{configurationDirty&&<p className="ss-muted">先保存并应用连接更改，再测试当前运营连接。</p>}
   {current&&<div className="ss-form">{current.capabilities['test.connection']&&<div className="ss-actions"><button type="button" disabled={!ready||locked||configurationDirty} onClick={()=>void test('connection')}>测试运营发信连接</button><span className="ss-muted">仅检查连接和认证。</span></div>}
    {current.capabilities['test.delivery']&&current.capabilities.canChooseRecipient?<fieldset disabled={!ready||locked||configurationDirty}><div className="ss-form"><label>测试发件身份<select aria-label="测试发件身份" value={sender} onChange={event=>{const value=event.currentTarget.value;setSender(value);}}><option value="">选择发件身份</option>{senders.map(row=><option key={row.key} value={row.key}>{row.name} · {row.address}</option>)}</select></label><AccountPicker selected={recipient} onChange={setRecipient} maxSelected={1} canSearchEmail={false} clearOnOffline disabled={!ready||locked||configurationDirty}/><div className="ss-actions"><button type="button" disabled={recipient.length!==1||!senders.some(row=>row.key===sender)} onClick={()=>void test('delivery')}>发送一封测试邮件</button><span className="ss-muted">仅向所选账户提交本次测试。</span></div></div></fieldset>:current.capabilities['test.delivery']?<p className="ss-muted">当前没有查找测试收件账户的权限。</p>:!current.capabilities['test.connection']?<p className="ss-muted">当前权限仅可查看测试记录。</p>:null}
   </div>}
   <ReadStatus loading={tests.loading} error={tests.error} retry={tests.read}/>{current&&tests.available&&tests.value?.items.length?<div className="ss-table-scroll"><table><thead><tr><th>测试</th><th>连接版本</th><th>结果</th><th>时间（上海）</th></tr></thead><tbody>{tests.value.items.map(row=><tr key={row.id}><td>{row.kind==='connection'?'连接与认证':'邮件提交'}</td><td>{row.configurationVersion}</td><td>{smtpState(row.state)}{row.code&&<p className="ss-muted">{smtpCode(row.code)}</p>}{row.state==='submitted'&&<p className="ss-muted">SMTP已接受，真实送达尚无回执。</p>}</td><td>{smtpTime(row.finishedAt||row.startedAt)}</td></tr>)}</tbody></table></div>:current&&tests.available&&<p className="ss-muted">尚无测试记录。</p>}{pageButtons('tests',current&&tests.available?tests.value?.nextAfter:null)}
  </section>
  <section className="ss-panel"><header><h2>投递状态</h2><Link href="/admin/operations/messaging?channel=email&view=runs" prefetch={false}>消息执行记录</Link></header><ReadStatus loading={queue.loading} error={queue.error} retry={queue.read}/>{current&&queue.verified&&queue.value&&<><dl className="ss-mail-counts">{(['pending','submitting','submitted','unknown'] as const).map(state=><div key={state}><dt>{smtpState(state)}</dt><dd>{queue.value!.counts[state]===undefined?'未取得':queue.value!.counts[state]!.toLocaleString('zh-CN')}</dd></div>)}</dl><p className="ss-muted">邮件提交与最终送达分别记录。</p></>}
  </section>
  <section className="ss-panel"><header><h2>域名与验证</h2></header><ReadStatus loading={domains.loading} error={domains.error} retry={domains.read}/>{current&&domains.verified&&domains.value&&<><p className="ss-muted">{domains.value.domain} · {smtpTime(new Date(domains.value.checkedAt*1000).toISOString())}</p>{(['spf','dkim','dmarc'] as const).map(key=><section className="ss-mail-domain" key={key}><h3>{key.toUpperCase()} · {domains.value![key].state==='record-found'?'已找到记录':domains.value![key].state==='not-found'?'未找到记录':domains.value![key].state==='selector-not-configured'?'未设置选择器':'暂不可查询'}</h3>{domains.value![key].records.map((row,index)=><code key={index}>{row}</code>)}</section>)}<p className="ss-muted">真实邮件的域名对齐尚未取得。</p></>}<ReadStatus loading={bounces.loading} error={bounces.error} retry={bounces.read}/>{current&&bounces.verified&&bounces.value&&<p className="ss-muted">退信回执尚未接入，数量未知。</p>}
  </section>
  <section className="ss-panel"><header><h2>运营连接变更记录</h2></header><ReadStatus loading={history.loading} error={history.error} retry={history.read}/>{current&&history.available&&history.value?.items.length?<ol className="ss-mail-history">{history.value.items.map(row=><li key={row.id}><strong>连接版本 {row.version}</strong><p>{row.changedFields.map(key=>smtpFieldLabels[key]).filter(Boolean).join('、')||'配置已保存'}</p><time>{smtpTime(row.createdAt)}</time></li>)}</ol>:current&&history.available&&<p className="ss-muted">尚无连接变更记录。</p>}{pageButtons('history',current&&history.available?history.value?.nextAfter:null)}
  </section></>}
 </div>;
}

