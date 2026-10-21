'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import type {ChatScope,ReportDetail,ReportResource} from './chat-report-types';
import {reportCategories,reportStates,scopeLabels} from './chat-report-types';
import {timeLabel} from './business-types';
type Action='review'|'pause'|'resume'|'resolve';
type Intent={operationId:string;reportId:string;expectedVersion:number;kind:Action;summary:string;[key:string]:unknown};
const eventNames:Record<string,string>={report:'举报',supplement:'补充材料',appeal:'申诉','withdraw-report':'撤回举报',review:'开始处理',pause:'临时限制',resume:'解除限制',resolve:'处理结果'};
const errors:Record<string,string>={chat_report_version_changed:'案件已有新记录，请读取后继续。',chat_report_target_changed:'对话状态已变化，请读取后继续。',chat_report_moderation_denied:'当前账户不能处理这份举报。',chat_report_state:'案件状态已变化，请读取后继续。',chat_report_restriction_invalid:'请选择有效的限制内容和期限。',chat_report_operation_conflict:'原操作内容不一致，请读取当前记录。',chat_report_materials_expired:'案件材料已到保存期限。',operations_login_required:'管理登录已到期，请重新登录。'};
const detailOf=(value:ReportResource|null):ReportDetail|null=>value&&'reportId'in value?value:null;
function MaterialAuthor({value}:{value:string}){const match=/^account:([0-9a-f-]{36})$/i.exec(value);return match?<Link href={'/admin/operations/users?account='+match[1]}>查看发送账户</Link>:<code>{value}</code>;}
export function ChatReports({initial,initialError,path,reportId,filter,csrfToken}:{initial:ReportResource|null;initialError:string;path:string;reportId:string|null;filter:string;csrfToken:string}){
  const [resource,setResource]=useState(initial),[loading,setLoading]=useState(false),[error,setError]=useState(initialError),[busy,setBusy]=useState(false),[pending,setPending]=useState<Intent|null>(null);
  const [action,setAction]=useState<Action>('review'),[summary,setSummary]=useState(''),[rule,setRule]=useState(''),[verdict,setVerdict]=useState('dismissed'),[withRestriction,setWithRestriction]=useState(false),[scopes,setScopes]=useState<ChatScope[]>([]),[days,setDays]=useState('1'),[download,setDownload]=useState('');
  const activeRead=useRef<AbortController|null>(null),mutationBusy=useRef(false),alive=useRef(true);
  const read=useCallback(async()=>{
    activeRead.current?.abort();const controller=new AbortController();activeRead.current=controller;setLoading(true);
    try{const response=await fetch(path,{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});if(!response.ok)throw Error(response.status===401?'operations_login_required':'read_failed');const value:ReportResource=await response.json();if(controller.signal.aborted)return;setResource(value);setError('');}
    catch(error){if(!controller.signal.aborted){setResource(null);setError(error instanceof Error&&errors[error.message]?errors[error.message]:'举报记录暂时无法取得。');}}
    finally{if(!controller.signal.aborted)setLoading(false);}
  },[path]);
  useEffect(()=>{
    alive.current=true;
    const offline=()=>{activeRead.current?.abort();setResource(null);setLoading(false);setError('网络已断开，恢复后继续读取。');};
    const visible=()=>{if(document.visibilityState==='visible'&&navigator.onLine)void read();};
    window.addEventListener('offline',offline);window.addEventListener('online',visible);window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
    if(!initial&&navigator.onLine)void read();
    return()=>{alive.current=false;activeRead.current?.abort();window.removeEventListener('offline',offline);window.removeEventListener('online',visible);window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);};
  },[initial,read]);
  useEffect(()=>{
    if(!resource)return;
    const timer=setTimeout(()=>{setResource(null);if(navigator.onLine&&document.visibilityState==='visible')void read();},Math.max(0,resource.readExpiresAt*1000-Date.now()));
    return()=>clearTimeout(timer);
  },[resource,read]);
  const detail=detailOf(resource),list=resource&&'items'in resource?resource:null;
  async function send(intent:Intent){
    if(mutationBusy.current)return;mutationBusy.current=true;setBusy(true);setPending(intent);setError('');
    try{
      const response=await fetch('/v1/operations/chat-reports/'+intent.reportId+'/event',{method:'POST',headers:{'Content-Type':'application/json','X-Galaxy-Operator-CSRF':csrfToken},body:JSON.stringify(intent),signal:AbortSignal.timeout(20000)});
      if(!response.ok){const value=await response.json().catch(()=>null);if(response.status<500)setPending(null);throw Error(typeof value?.error==='string'?value.error:typeof value?.error?.code==='string'?value.error.code:'unknown');}
      await response.json();if(!alive.current)return;setPending(null);setSummary('');setRule('');await read();
    }catch(error){if(alive.current){const code=error instanceof Error?error.message:'';setError(errors[code]??'处理结果暂未确认，重试会继续原操作。');}}
    finally{mutationBusy.current=false;if(alive.current)setBusy(false);}
  }
  function submit(){
    if(!detail?.canModerate||busy||pending)return;
    const intent:Intent={operationId:crypto.randomUUID(),reportId:detail.reportId,expectedVersion:detail.version,kind:action,summary};
    if(action==='pause'||action==='resolve'){
      if(!detail.currentTarget)return;intent.targetVersion=detail.currentTarget.version;intent.rule=rule;
      const restriction={scopes,until:Math.floor(Date.now()/1000)+Number(days)*86400};
      if(action==='pause'){intent.scopes=restriction.scopes;intent.until=restriction.until;}
      else{intent.verdict=verdict;intent.restriction=verdict==='upheld'&&withRestriction?restriction:null;}
    }
    void send(intent);
  }
  async function downloadMaterial(attachmentId:string,name:string){
    if(!detail||download||!navigator.onLine)return;setDownload(attachmentId);setError('');
    try{const response=await fetch('/v1/operations/chat-reports/'+detail.reportId+'/attachments/'+attachmentId+'/content',{method:'POST',headers:{'Content-Type':'application/json','X-Galaxy-Operator-CSRF':csrfToken},body:'{}',signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error();const blob=await response.blob();if(!alive.current)return;const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
    catch{if(alive.current){setError('附件暂不可下载，请重新读取这份材料。');void read();}}finally{if(alive.current)setDownload('');}
  }
  const terminal=detail?.state==='resolved'||detail?.state==='withdrawn',needsScope=action==='pause'||action==='resolve'&&verdict==='upheld'&&withRestriction;
  return <section className="galaxy-business-users galaxy-chat-reports"><header><h1>{reportId?'私聊举报记录':'私聊举报'}</h1>{reportId&&<Link href={'/admin/operations/chat-reports'+(filter?'?state='+encodeURIComponent(filter):'')}>返回举报列表</Link>}</header>
    {error&&<p role="alert" className="galaxy-error">{error}{pending?<button type="button" disabled={busy} onClick={()=>void send(pending)}>继续原操作</button>:<button type="button" disabled={loading} onClick={()=>void read()}>重新读取</button>}</p>}
    {loading&&!resource&&<p role="status">正在读取…</p>}
    {!reportId&&<form method="get" className="galaxy-user-search"><label>处理状态<select name="state" defaultValue={filter}><option value="">全部</option>{Object.entries(reportStates).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label><button type="submit">查看</button></form>}
    {list&&<><div className="galaxy-table-scroll"><table><thead><tr><th>举报类型</th><th>状态</th><th>提交时间</th><th>最近更新</th></tr></thead><tbody>{list.items.map(item=><tr key={item.reportId}><th><Link href={'/admin/operations/chat-reports?'+new URLSearchParams({report:item.reportId,...(filter?{state:filter}:{})})}>{reportCategories[item.category]}</Link></th><td>{reportStates[item.state]}</td><td>{timeLabel(item.createdAt)}</td><td>{timeLabel(item.updatedAt)}</td></tr>)}</tbody></table></div>{!list.items.length&&<p>没有相符的举报。</p>}{list.nextAfter&&<Link href={'/admin/operations/chat-reports?'+new URLSearchParams({after:list.nextAfter,...(filter?{state:filter}:{})})}>下一页</Link>}</>}
    {detail&&<><section><h2>{reportCategories[detail.category]} · {reportStates[detail.state]}</h2><p>提交于 {timeLabel(detail.createdAt)}</p>{detail.reporterAccountId&&<Link href={'/admin/operations/users?account='+detail.reporterAccountId}>查看举报账户</Link>}{detail.ownRestriction&&<p>{detail.ownRestriction.scopes.map(scope=>scopeLabels[scope]).join('、')}，至 {timeLabel(detail.ownRestriction.until)}</p>}</section>
      <section><h2>选定消息</h2>{detail.materials.map(material=><article className="galaxy-case-message" key={material.eventId+':'+material.messageId}><header><MaterialAuthor value={material.authorRef}/><span>{timeLabel(material.sentAt)}</span><span>消息版本 {material.revision}</span></header>{material.state==='available'?<><p>{material.text}</p>{material.attachments.map(file=><div key={file.attachmentId}>{file.contentAvailable&&file.name?<button type="button" disabled={!!download} onClick={()=>void downloadMaterial(file.attachmentId,file.name!)}>{download===file.attachmentId?'正在下载…':file.name}</button>:<span>附件不可用</span>}</div>)}</>:<p>这条消息已不可查看。</p>}</article>)}{!detail.materials.length&&<p>{detail.materialsExpired?'材料已到保存期限。':'没有可查看的选定材料。'}</p>}</section>
      <section><h2>处理记录</h2><ol className="galaxy-records">{detail.events.map(event=><li key={event.eventId}><strong>{eventNames[event.kind]??event.kind}</strong><p>{event.summary??'这条记录的内容不可查看。'}</p>{event.decision&&<p>{event.decision.verdict==='upheld'?'举报成立':event.decision.verdict==='dismissed'?'举报不成立':'临时处理'} · {event.decision.rule}</p>}<span>{event.actorKind==='business-operator'?'运营处理':'当事人提交'} · {timeLabel(event.at)}</span></li>)}</ol></section>
      {detail.canModerate&&!detail.materialsExpired&&<section><h2>处理这份举报</h2><form onSubmit={event=>{event.preventDefault();submit();}}><fieldset disabled={busy||pending!==null}><label>操作<select value={action} onChange={event=>setAction(event.target.value as Action)}><option value="review" disabled={terminal}>记录处理进展</option><option value="pause" disabled={terminal||!detail.currentTarget}>临时限制</option><option value="resume" disabled={!detail.ownRestriction}>解除限制</option><option value="resolve" disabled={terminal||!detail.currentTarget}>记录处理结果</option></select></label><label>处理说明<textarea value={summary} onChange={event=>setSummary(event.target.value)} maxLength={1600} required/></label>{(action==='pause'||action==='resolve')&&<label>适用规则<input value={rule} onChange={event=>setRule(event.target.value)} maxLength={120} required/></label>}{action==='resolve'&&<><label>结果<select value={verdict} onChange={event=>setVerdict(event.target.value)}><option value="dismissed">举报不成立</option><option value="upheld">举报成立</option></select></label>{verdict==='upheld'&&<label className="galaxy-checkbox-label"><input type="checkbox" checked={withRestriction} onChange={event=>setWithRestriction(event.target.checked)}/>同时限制此对话参与</label>}</>}{needsScope&&<><div className="galaxy-scope-choices">{Object.entries(scopeLabels).map(([scope,label])=><label className="galaxy-checkbox-label" key={scope}><input type="checkbox" checked={scopes.includes(scope as ChatScope)} onChange={event=>setScopes(previous=>event.target.checked?[...previous,scope as ChatScope]:previous.filter(value=>value!==scope))}/>{label}</label>)}</div><label>持续时间<select value={days} onChange={event=>setDays(event.target.value)}><option value="1">1 天</option><option value="7">7 天</option>{action==='resolve'&&<option value="30">30 天</option>}</select></label></>}<button type="submit" disabled={needsScope&&!scopes.length||action==='review'&&terminal||action==='resume'&&!detail.ownRestriction||(action==='pause'||action==='resolve')&&(!detail.currentTarget||terminal)}>保存处理记录</button></fieldset></form></section>}
    </>}
  </section>;
}
