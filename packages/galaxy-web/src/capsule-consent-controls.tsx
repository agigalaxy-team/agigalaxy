import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {memberName,useMemberNames,readableTime} from './conversation-ui';
import {createCapsuleVisibilityClient} from './capsule-visibility-client.mjs';
import {useChoiceViewLease,type ChoiceViewLease} from './choice-retained-operations';
import type {CapsuleAuthorRuntime,CapsuleRun} from './capsule-authoring-types';
import type {createWebRuntime} from './runtime.mjs';
import './capsule-authoring.css';

type ShareTarget={type:'publication'|'use';operationId:string;consentId:string;payloadHash:string};
type ShareReading={state:string;target:ShareTarget;visibility:'Private'|'Public';viewers:string[];expiresAt:number;reason?:string};
type Props={runtime:CapsuleAuthorRuntime&Pick<Awaited<ReturnType<typeof createWebRuntime>>,'putLocal'>;subjectId:string;targets:(ShareTarget&{label:string})[];busy:boolean;run:CapsuleRun;onChanged:()=>Promise<void>};
const stateLabels:Record<string,string>={revoked:'已停止这项分享',expired:'原展示授权已到期','result-unknown':'正在确认上次的停止结果','stopped-local':'已停止本机继续发送',active:'原展示授权仍有效'};
const reasonLabels:Record<string,string>={'business-rejected':'原操作未被接受。可以查看原范围，再决定是否继续停止。','original-binding-changed':'当前连接已变化。请查看原对象和范围，再明确继续。','original-binding-unavailable':'原连接暂时无法核对。请查看原对象和范围，再明确继续。'};
const stateText=(state:string)=>stateLabels[state]??'正在核对原授权';
const reasonText=(reason:string)=>reasonLabels[reason]??'';
export function CapsuleConsentControls(props:Props){
 const view=useChoiceViewLease(props.runtime,props.subjectId);
 return view.lease?<CapsuleConsentPanel key={view.key} {...props} lease={view.lease}/>:null;
}
function CapsuleConsentPanel({runtime,subjectId,targets,busy,run,onChanged,lease}:Props&{lease:ChoiceViewLease}){
 const client=useMemo(()=>createCapsuleVisibilityClient({api:runtime.api,getLocal:runtime.getLocal,putLocal:runtime.putLocal,updateLocal:runtime.updateLocal,subjectId}),[runtime,subjectId]);
 const [preview,setPreview]=useState<ShareReading|null>(null),[previewLabel,setPreviewLabel]=useState(''),[records,setRecords]=useState<ShareReading[]>([]),[results,setResults]=useState<Record<string,ShareReading>>({}),[message,setMessage]=useState(''),[error,setError]=useState('');
 const epoch=useRef(0),working=useRef(false),latest=useRef({busy,preview,onChanged}),completed=useRef(new Set<string>());
 useLayoutEffect(()=>{latest.current={busy,preview,onChanged};},[busy,preview,onChanged]);
 const options=[...new Map(targets.filter(Boolean).map(target=>[target.consentId,target])).values()],names=useMemberNames(runtime,subjectId,true,[...(preview?.viewers??[]),...records.flatMap(record=>record.viewers??[])]);
 const titleFor=(target:ShareTarget)=>options.find(item=>item.consentId===target.consentId)?.label??(target.type==='use'?'此前记录的方法使用':'此前发布的方法版本');
 const current=useCallback((token:number)=>{if(token!==epoch.current)return false;try{lease.assertCurrent();return true;}catch{return false;}},[lease]);
 const refresh=useCallback(async(token:number)=>{const value:ShareReading[]=await client.pending();if(current(token))setRecords(value);return value;},[client,current]);
 const finished=useCallback(async(result:ShareReading,token:number,announce=false)=>{
  if(!current(token))return;setResults(old=>({...old,[result.target.consentId]:result}));
  if(['revoked','expired'].includes(result.state)){
   const key=result.target.consentId+':'+result.state;
   if(!completed.current.has(key)){completed.current.add(key);if(announce)setMessage(result.state==='revoked'?'已停止这项分享，当前展示范围已更新。':'原展示授权已到期，当前范围已更新。');await latest.current.onChanged();}
  }
 },[current]);
 const resume=useCallback(async()=>{
  const token=epoch.current;if(working.current||latest.current.busy||latest.current.preview||!current(token))return;working.current=true;
  try{const pending=await refresh(token);for(const record of pending){if(!current(token)||latest.current.busy||latest.current.preview)return;if(['revoked','expired','stopped-local'].includes(record.state))continue;const result:ShareReading=await client.resumePending(record.target.consentId);await finished(result,token);}if(current(token))await refresh(token);if(current(token))setError('');}
  catch(error){if(current(token)){const text=error instanceof Error?error.message:'';setError(/[\u3400-\u9fff]/.test(text)?text:'上次的停止结果暂未读到，原操作仍保留。');}}
  finally{working.current=false;}
 },[client,current,finished,refresh]);
 useEffect(()=>{
  const viewEpoch=epoch;viewEpoch.current++;const initial=window.setTimeout(()=>void resume(),0),check=()=>{if(!document.hidden)void resume();};
  const timer=window.setInterval(check,12000);document.addEventListener('visibilitychange',check);
  return()=>{viewEpoch.current++;window.clearTimeout(initial);window.clearInterval(timer);document.removeEventListener('visibilitychange',check);};
 },[resume]);
 async function prepare(target:ShareTarget){const token=epoch.current;if(!current(token))return;const value:ShareReading=await client.prepare(target);if(!current(token))return;setPreview(value);setPreviewLabel(titleFor(target));setMessage('');setError('');}
 async function operate(){
  const token=epoch.current;if(!preview||!current(token))return;
  // execute must receive the exact client-created WeakMap token, without cloning.
  try{const result:ShareReading=await client.execute(preview,{confirmed:true});await finished(result,token,true);if(current(token))setPreview(null);}
  finally{if(current(token))await refresh(token);}
 }
 const pending=records.filter(record=>!['revoked','expired'].includes(record.state)),past=records.filter(record=>['revoked','expired'].includes(record.state));
 if(!options.length&&!records.length)return null;
 return <details className="room-settings method-consent-controls"><summary>管理我已分享的内容</summary>
  <p className="source-reading-note">停止选定版本或使用记录的当前展示。来源许可可在“来源许可”中单独管理。</p>
  {message&&<p className="message"><output>{message}</output></p>}{error&&<p role="alert" className="message error">{error}</p>}
  <fieldset disabled={busy}>
   <div className="method-consent-list">{options.map(target=><article className="method-consent-card" key={target.consentId}><p>{target.label}</p><Button type="button" variant="outline" onClick={()=>run(()=>prepare(target))}>查看分享范围</Button></article>)}</div>
   {preview&&<section className="method-form-section"><h3>{previewLabel}</h3><p>{preview.visibility==='Public'?'当前面向公众展示':preview.viewers.length?'当前向本人及 '+preview.viewers.map(id=>memberName(id,subjectId,names[id]??undefined)).join('、')+' 展示':'当前仅本人可读'}</p><p className="source-reading-note">{stateText(preview.state)}{preview.expiresAt?' · 原期限 '+readableTime(preview.expiresAt):''}</p>
    {preview.state==='active'&&<><p>确认后停止这项展示授权。已发生的工作保留，外部已保存的副本不会因此被收回。</p><Button type="button" onClick={()=>run(operate)}>确认停止这项分享</Button></>}
    <Button type="button" variant="ghost" onClick={()=>setPreview(null)}>{preview.state==='active'?'继续保留分享':'关闭'}</Button>
    <details className="source-reference-details"><summary>原授权记录</summary><p>{preview.target.operationId}</p><p>{preview.target.consentId}</p></details>
   </section>}
   {!!pending.length&&<section className="method-consent-list" aria-label="上次的停止操作">{pending.map(record=>{const result=results[record.target.consentId]??record;return <article className="method-consent-card" key={record.target.consentId}><h3>{titleFor(record.target)}</h3><p>{stateText(result.state)}</p>{result.reason&&<p>{reasonText(result.reason)}</p>}<Button type="button" variant="outline" onClick={()=>run(()=>prepare(record.target))}>查看原内容的分享范围</Button></article>;})}</section>}
   {!!past.length&&<details className="source-reference-details"><summary>已完成的展示变更</summary>{past.map(record=><p key={record.target.consentId}>{titleFor(record.target)} · {stateText(record.state)}</p>)}</details>}
  </fieldset>
 </details>;
}
