import {ReadingDetails,ReadingSummary} from "../../../shared/reading/reading-details";
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {createTaskOwnerReadClient} from './task-owner-read-client.mjs';
import {TaskOwnerControlWorkspace} from './task-owner-control-workspace';
import {errorField} from "../operations/task-operation-state";
import {ownerObject,ownerRecordBody,ownerText} from './task-owner-read-view-types';
import type {OwnerReadClient,OwnerReadProps,OwnerReadResult,OwnerReadScope} from './task-owner-read-view-types';
import './task-owner-reading.css';

const labels:Record<string,string>={publish:'发布请求',request:'发布请求','task-published':'发布请求','suggest-contacts':'保存帮助建议',invite:'发出邀请','invitation-reply':'回应邀请',apply:'申请参与','withdraw-application':'撤回申请','revoke-invitation':'撤回邀请',cancel:'取消请求',close:'终止整项请求','stop-enrollment':'结束征集','extend-enrollment':'延长征集',propose:'提出参与安排',confirm:'确认参与',deliver:'交付结果',accept:'验收交付','propose-scope':'调整参与范围','confirm-scope':'确认范围','decline-scope':'拒绝范围调整',withdraw:'退出参与',decline:'拒绝参与',dispute:'提出异议','propose-resolution':'提出处理建议','confirm-resolution':'确认处理建议','requester-feedback':'反馈协作体验'};
const errors:Record<string,string>={not_found:'当前身份没有可在这里读取的本人记录，或原请求不存在。',task_owner_read_source_unavailable:'原记录的授权已失效或正文已不再保留。可以保留这个工作地址。',task_owner_read_control_required:'连接当前有效设备后可以读取本人记录。',task_owner_read_preview_changed:'原记录已经变化，请重新读取可选范围。',task_owner_read_scope_mismatch:'本次授权与当前设备或所列记录不一致，请重新核对。',consent_required:'原读取授权尚未确认，可继续核对同一次授权。',invalid_task_owner_read:'本人记录的范围无效，请重新读取可选范围。',task_owner_read_authorization_expired:'这次读取授权已到期，正文已停止显示。重新选择当前可读记录后，可以再次授权。'};
const stamp=(value:string|number|undefined)=>{const date=new Date(typeof value==='number'?value*1000:value??NaN);return Number.isNaN(date.getTime())?'时间未提供':date.toLocaleString();};
const errorText=(value:unknown)=>{
 const message=errorField(value,'message');
 if(['Failed to fetch','NetworkError when attempting to fetch resource.','Load failed'].includes(message))return '暂时无法连接服务，请稍后再试。';
 return errors[errorField(value,'code')||message]||message||'本人记录暂时未能读取。';
};
const expires=(value:{expiresAt:number;readExpiresAt?:number})=>Math.min(value.expiresAt,value.readExpiresAt??Infinity);
const expired=()=>Object.assign(Error('task_owner_read_authorization_expired'),{code:'task_owner_read_authorization_expired'});
function budgetText(value:unknown){
 const budget=ownerObject(value);if(!budget)return '';
 const unit=ownerText(budget.unit);
 return budget.mode==='fixed'?ownerText(budget.amount)+' '+unit:budget.mode==='range'?ownerText(budget.minimum)+'–'+ownerText(budget.maximum)+' '+unit:budget.mode==='quote'?'由参与者报价（'+unit+'）':'';
}

export function TaskOwnerReadWorkspace(props:OwnerReadProps){
 const value=props.runtime.api.snapshot(),key=JSON.stringify([props.runtime.api.endpoint,value?.subjectId,value?.bindingId,value?.generation,value?.control?.deviceId,value?.control?.epoch,props.taskId,props.connected]);
 return <OwnerRead key={key} {...props}/>;
}
function OwnerRead({runtime,taskId,connected}:OwnerReadProps){
 const lifecycle=useRef<{generation:number;active:boolean;working:boolean;client:OwnerReadClient|null;authorized:OwnerReadScope|null}>({generation:0,active:false,working:false,client:null,authorized:null});
 const [preview,setPreview]=useState<OwnerReadScope|null>(null),[result,setResult]=useState<OwnerReadResult|null>(null),[authorization,setAuthorization]=useState<OwnerReadScope|null>(null);
 const [message,setMessage]=useState(''),[busy,setBusy]=useState(connected),[prepared,setPrepared]=useState(false);
 const authorizeView=useCallback((scope:OwnerReadScope|null)=>{lifecycle.current.authorized=scope;setAuthorization(scope);},[]);
 const install=useCallback((value:OwnerReadResult,scope:OwnerReadScope)=>{
  if(expires(value)<=Date.now()/1000)throw expired();
  authorizeView(scope);setPreview(null);setResult(value);setMessage('');
 },[authorizeView]);
 const readFailure=useCallback(async(error:unknown,valid:()=>boolean)=>{
  if(!valid())return;setResult(null);
  const code=errorField(error,'code')||errorField(error,'message');
  if(['task_owner_read_preview_changed','task_owner_read_scope_mismatch','task_owner_read_authorization_expired','task_owner_read_source_unavailable','task_owner_read_control_required','not_found'].includes(code)){authorizeView(null);setPreview(null);}
  if(code==='task_owner_read_preview_changed'){
   try{const client=lifecycle.current.client;if(!client)return;const scope=await client.prepare();if(valid()){setPreview(scope);setPrepared(true);setMessage('');}return;}
   catch(next){if(valid())setMessage(errorText(next));return;}
  }
  setMessage(errorText(error));
 },[authorizeView]);
 useEffect(()=>{
  const view=lifecycle.current,lease=++view.generation;view.active=true;
  const valid=()=>view.active&&view.generation===lease;
  const current:OwnerReadClient|null=connected?createTaskOwnerReadClient(runtime,taskId):null;view.client=current;
  const initialize=async()=>{
   if(!current)return;view.working=true;
   try{
    const saved=await current.pending();if(!valid())return;
    if(saved?.authorizationState==='authorized'&&expires(saved)>Date.now()/1000){
     authorizeView(saved);const value=await current.read(saved,{confirmed:true});if(valid())install(value,saved);
    }else if(saved)setPreview(saved);
    else{const scope=await current.prepare();if(valid())setPreview(scope);}
    if(valid())setPrepared(true);
   }catch(error){await readFailure(error,valid);}
   finally{if(valid()){view.working=false;setBusy(false);}}
  };
  void initialize();
  return()=>{view.active=false;view.generation++;current?.close();if(view.client===current)view.client=null;view.authorized=null;};
 },[runtime,taskId,connected,authorizeView,install,readFailure]);
 async function run(action:(client:OwnerReadClient,valid:()=>boolean)=>Promise<void>){
  const view=lifecycle.current;if(!view.active||!view.client||view.working)return;
  const lease=view.generation,valid=()=>view.active&&lease===view.generation;view.working=true;setBusy(true);setMessage('');
  try{await action(view.client,valid);}catch(error){await readFailure(error,valid);}
  finally{if(valid()){view.working=false;setBusy(false);}}
 }
 useEffect(()=>{
  if(!result)return;const view=lifecycle.current,lease=view.generation;let timer:ReturnType<typeof setTimeout>;
  // Schedule the actual authorization deadline, including long-delay limits.
  const schedule=()=>{const remaining=expires(result)*1000-Date.now();if(!Number.isFinite(remaining))return;
   timer=setTimeout(()=>{if(!view.active||lease!==view.generation)return;if(expires(result)*1000>Date.now()){schedule();return;}
    setResult(null);setPreview(view.authorized?{...view.authorized,authorizationState:'expired'}:null);authorizeView(null);setMessage(errors.task_owner_read_authorization_expired);
   },Math.max(0,Math.min(remaining,2147483647)));
  };schedule();return()=>clearTimeout(timer);
 },[result,authorizeView]);
 useEffect(()=>{
  const view=lifecycle.current,lease=view.generation;let disposed=false;
  const valid=()=>!disposed&&view.active&&lease===view.generation;
  const update=async()=>{
   if(!valid()||view.working||document.hidden||!view.authorized||!view.client)return;
   const scope=view.authorized,client=view.client;view.working=true;
   try{if(expires(scope)<=Date.now()/1000)throw expired();const value=await client.read(scope,{confirmed:true});if(valid())install(value,scope);}
   catch(error){await readFailure(error,valid);}
   finally{if(valid())view.working=false;}
  };
  const timer=setInterval(()=>void update(),5000),visible=()=>{void update();};
  document.addEventListener('visibilitychange',visible);
  return()=>{disposed=true;clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[connected,install,readFailure]);
 const prepare=()=>run(async(client,valid)=>{authorizeView(null);setResult(null);setPreview(null);const value=await client.prepare();if(valid()){setPreview(value);setPrepared(true);}});
 const read=()=>run(async(client,valid)=>{if(!preview)return;const scope=preview,value=await client.read(scope,{confirmed:true});if(valid())install(value,scope);});
 const retryRead=()=>run(async(client,valid)=>{const scope=lifecycle.current.authorized;if(!scope)return;const value=await client.read(scope,{confirmed:true});if(valid())install(value,scope);});
 const download=()=>run(async(client,valid)=>{const scope=lifecycle.current.authorized;if(!scope)return;const value=await client.read(scope,{confirmed:true});if(!valid())return;install(value,scope);const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));try{const link=document.createElement('a');link.href=url;link.download='galaxy-my-work-records.json';link.click();}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}});
 return <section className="task-owner-reading" aria-busy={busy}>
  <header><p className="eyebrow">继续原来的工作</p><h1 className="small">我在这里留下的记录</h1><p>恢复身份后，仍可读取有有效授权、服务仍保留的本人内容。</p></header>
  {!connected&&<p className="message">连接当前有效设备后可以读取。</p>}
  {busy&&!result&&!preview&&!message&&<p className="owner-reading-loading"><output>正在读取可用记录…</output></p>}
  {message&&<div className="message error" role="alert"><p>{message}</p>{authorization?<Button variant="outline" disabled={busy} onClick={retryRead}>重新读取原记录</Button>:!preview&&connected&&<Button variant="outline" disabled={busy} onClick={prepare}>重新读取可选记录</Button>}</div>}
  {preview&&<section className="owner-read-scope" aria-label="本人记录读取范围"><h3>{preview.authorizationState==='expired'?'原读取范围已到期':'这些本人记录目前可以接回'}</h3><ul>{preview.events.map(event=><li key={event.eventId}><span>{labels[event.kind]??'本人提交的记录'}</span><time>{stamp(event.createdAt)}</time></li>)}</ul>
   <p>仅本人读取{preview.authorizationState==='expired'?'。':'，本次授权至 '+stamp(preview.expiresAt)+'。'}</p>
   <ReadingDetails className="owner-record-reference"><ReadingSummary>准确记录与读取范围</ReadingSummary><p>原工作：{taskId}</p>{preview.events.map(event=><p key={event.eventId}>{labels[event.kind]??event.kind} · 第 {event.version} 版<br/>{event.eventId}<br/>原文可读至 {stamp(event.readExpiresAt)}<br/>{event.payloadHash}</p>)}</ReadingDetails>
   {preview.authorizationState==='awaiting-receipt'&&<p className="record-meta">上次读取尚未确认完成，继续时会核对原来的同一次授权。</p>}
   <div className="button-row">{preview.authorizationState==='expired'?<Button disabled={busy} onClick={prepare}>重新选择当前可读记录</Button>:<Button disabled={busy} onClick={read}>{busy?'正在读取…':preview.authorizationState==='awaiting-receipt'?'继续读取这些记录':'授权并读取这些记录'}</Button>}</div>
  </section>}
  {result&&<div className="owner-authored-history" aria-label="本人保留记录"><p className="owner-read-boundary">以下是本人留下的内容。其他人的记录、引用资料及当前工作全貌，需要各自的读取权限。</p>{result.events.map((event,index)=>{const body=ownerRecordBody(event.payloadJson),title=ownerText(body.title),scope=authorization?.events.find(item=>item.eventId===event.eventId);return <article key={event.eventId} className="owner-authored-record"><header><span className="owner-record-number">{index+1}</span><div><h3>{title||labels[event.kind]||'本人提交的记录'}</h3><p>{title?(labels[event.kind]??'原记录')+' ':''}{scope?stamp(scope.createdAt):'第 '+event.version+' 版'}</p></div></header><OwnerRecordBody body={body}/><ReadingDetails className="owner-record-reference"><ReadingSummary>记录中的准确引用</ReadingSummary><p>{event.eventId} · 第 {event.version} 版</p><p>{event.payloadHash}</p>{Object.entries(body).filter(([key])=>/Id$|Ref$|Refs$/.test(key)).map(([key,value])=><p key={key}>{key}：{typeof value==='string'?value:JSON.stringify(value)}</p>)}</ReadingDetails></article>;})}
   <footer><p>当前读取有效至 {stamp(expires(result))}。</p><Button variant="outline" disabled={busy} onClick={download}>保存本人记录文件</Button><button type="button" className="text-link" disabled={busy} onClick={prepare}>查看当前可选范围</button></footer>
  </div>}
  {!preview&&!result&&prepared&&!message&&!busy&&<Button variant="outline" onClick={prepare}>查看当前可读记录</Button>}
  <ReadingDetails className="owner-control-entry"><ReadingSummary>取消原请求或结束征集</ReadingSummary><TaskOwnerControlWorkspace runtime={runtime} taskId={taskId} connected={connected}/></ReadingDetails>
 </section>;
}
function OwnerRecordBody({body}:{body:Record<string,unknown>}){
 const fields:Record<string,string>={summary:'记录内容',expectedOutcome:'希望取得的结果',note:'说明',message:'回应',proposal:'参与提议',scope:'范围',agreedScope:'约定范围',reason:'原因',error:'当时遇到的问题'};
 const intents:Record<string,string>={stuck:'遇到阻碍','proactive-review':'请人检查',diagnosis:'协助诊断',collaboration:'一起完成',delegation:'委托协作'};
 const responses:Record<string,string>={question:'希望进一步了解',interested:'愿意继续交流',declined:'暂不参与',close:'结束处理','resume-work':'继续工作'};
 const intent=ownerText(body.intent),context=ownerObject(body.workContext),response=ownerText(body.response),outcome=ownerText(body.outcome),budget=budgetText(body.budget??body.quote),clarity=ownerText(body.descriptionClarity);
 return <div className="owner-record-body">{intent&&<p className="record-meta">{intents[intent]??intent}</p>}{Object.entries(fields).map(([key,label])=>{const text=ownerText(body[key]);return text&&<section key={key}><h4>{label}</h4><p>{text}</p></section>;})}
  {context&&<><section><h4>当时要完成的事</h4><p>{ownerText(context.goal)}</p></section><section><h4>当时的情况</h4><p>{ownerText(context.currentSituation)}</p></section></>}
  {response&&<p>当时回应：{responses[response]??response}</p>}{outcome&&<p>处理建议：{responses[outcome]??outcome}</p>}
  {budget&&<p>{body.budget?'当时预算':'当时报价'}：{budget}</p>}{typeof body.enrollmentExpiresAt==='number'&&<p>当时征集至 {stamp(body.enrollmentExpiresAt)}</p>}
  {Array.isArray(body.items)&&body.items.map((value:unknown,index:number)=>{const item=ownerObject(value);if(!item)return null;const conditions=ownerText(item.conditions);return <section key={index}><h4>帮助建议 {index+1}</h4><p>{ownerText(item.help)}</p><p>{ownerText(item.basis)}</p>{conditions&&<p>适用条件：{conditions}</p>}<ReadingDetails className="owner-record-reference"><ReadingSummary>建议中的身份与来源</ReadingSummary><p>{ownerText(item.subjectId)}</p>{Array.isArray(item.sourceRefs)&&item.sourceRefs.filter((ref:unknown):ref is string=>typeof ref==='string').map(ref=><p key={ref}>{ref}</p>)}</ReadingDetails></section>;})}
  {clarity&&<p>描述清晰程度：{({clear:'清楚','partly-clear':'部分清楚',unclear:'不清楚'} as Record<string,string>)[clarity]??clarity}</p>}{typeof body.scopeMatched==='boolean'&&<p>实际范围与约定{body.scopeMatched?'一致':'存在差异'}</p>}
 </div>;
}
