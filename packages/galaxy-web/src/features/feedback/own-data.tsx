import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {ReadingSurface} from '../../reading-details';
import {createFeedbackOwnDataClient,feedbackOwnDataError,feedbackOwnDataIntentSchema} from './own-data-client.mjs';
import './own-data.css';

type Intent={accountId:string;operationId:string;kind:'export'|'delete'};
type Receipt={state:'recorded';operationId:string;kind:'export'|'delete';phase:'ready'|'pending'|'completed'|'attention';feedbackCount:number;attachmentCount:number;metadataDeleted:boolean;attachments:{pending:number;removed:number;resultUnknown:number;objectRemoved:boolean|null;physicalBlocksReleased:null}};
type Transport={call:(path:string,input:unknown,options?:{method?:string;signal?:AbortSignal})=>Promise<unknown>;transfer:(path:string,input:unknown,options?:{method?:string;signal?:AbortSignal})=>Promise<Response>};
type Props=Transport&{accountId:string;available:boolean};
const readIntent=(key:string,accountId:string):Intent|null=>{try{const value=feedbackOwnDataIntentSchema.safeParse(JSON.parse(sessionStorage.getItem(key)??'null'));return value.success&&value.data.accountId===accountId?value.data:null;}catch{return null;}};

export function FeedbackOwnData(props:Props){return <FeedbackOwnDataSession key={props.accountId} {...props}/>;}
function FeedbackOwnDataSession({accountId,available,call,transfer}:Props){
 const key='galaxy:web:feedback-own-data:v1:'+accountId;
 const [intent,setIntent]=useState<Intent|null>(()=>readIntent(key,accountId)),[result,setResult]=useState<Receipt|null>(null),[confirm,setConfirm]=useState(false),[phase,setPhase]=useState(''),[error,setError]=useState(''),[progress,setProgress]=useState({records:0,attachments:0}),[downloaded,setDownloaded]=useState<{records:number;attachments:number;unavailableAttachments:number}|null>(null);
 const latest=useRef({available,call,transfer}),current=useRef(intent),mounted=useRef(true),working=useRef(false),controller=useRef<AbortController|null>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null),retry=useRef(0),bundle=useRef<Blob|null>(null),urls=useRef(new Set<string>());
 useLayoutEffect(()=>{latest.current={available,call,transfer};if(!available){controller.current?.abort();bundle.current=null;setResult(null);setDownloaded(null);setPhase('');}},[available,call,transfer]);
 useLayoutEffect(()=>{const allocatedUrls=urls.current;mounted.current=true;return()=>{mounted.current=false;controller.current?.abort();if(timer.current)clearTimeout(timer.current);for(const url of allocatedUrls)URL.revokeObjectURL(url);allocatedUrls.clear();bundle.current=null;};},[]);
 const client=useMemo(()=>createFeedbackOwnDataClient({accountId,call:(...args)=>latest.current.call(...args),transfer:(...args)=>latest.current.transfer(...args),assertCurrent:()=>{if(!mounted.current||!latest.current.available)throw Object.assign(Error('official_account_session_expired'),{code:'official_account_session_expired'});}}),[accountId]);
 const remember=useCallback((value:Intent|null)=>{current.current=value;setIntent(value);try{if(value)sessionStorage.setItem(key,JSON.stringify(value));else sessionStorage.removeItem(key);}catch{/* The in-memory intent is still used while this page remains open. */}},[key]);
 function startDownload(blob:Blob){if(!mounted.current||!latest.current.available)return;const url=URL.createObjectURL(blob);urls.current.add(url);const anchor=document.createElement('a');anchor.href=url;anchor.download='银河使用反馈.zip';anchor.click();setTimeout(()=>{URL.revokeObjectURL(url);urls.current.delete(url);},60000);}
 const continueIntent=useRef<()=>void>(()=>{});
 function schedule(delay:number){if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>continueIntent.current(),delay);}
 const resume=useCallback(async()=>{
  const original=current.current;if(!original||working.current||!latest.current.available||navigator.onLine===false||document.hidden)return;
  working.current=true;const request=new AbortController();controller.current=request;setError('');
  try{
   let value=await client.lookup(original,{signal:request.signal});
   if(value.state==='not-recorded')value=await client.start(original,{signal:request.signal});
   if(!mounted.current||request.signal.aborted||current.current!==original)return;
   if(value.state!=='recorded')throw Error('account_feedback_data_response_invalid');
   if(value.kind!==original.kind)throw Error('account_feedback_data_response_invalid');
   setResult(value);retry.current=0;
   if(original.kind==='export'){
    setPhase('exporting');const exported=await client.exportBundle(original.operationId,{signal:request.signal,onProgress:value=>{if(mounted.current&&!request.signal.aborted)setProgress(value);}});
    if(!mounted.current||request.signal.aborted||current.current!==original||!latest.current.available)return;
    bundle.current=exported.blob;setDownloaded(exported);setPhase('');remember(null);startDownload(exported.blob);
   }else if(value.phase==='completed'){setPhase('');remember(null);}
   else{setPhase(value.phase==='attention'?'attention':'deleting');schedule(value.phase==='attention'?30000:2500);}
  }catch(reason){
   if(!mounted.current||current.current!==original)return;
   const code=reason&&typeof reason==='object'&&'code'in reason?String(reason.code):'';
   if(['official_account_session_expired','official_account_changed','account_csrf_invalid'].includes(code)){setError(feedbackOwnDataError(reason));setPhase('');return;}
   if(request.signal.aborted)return;
   setError(feedbackOwnDataError(reason));setPhase('reconnecting');schedule(Math.min(30000,1500*2**Math.min(retry.current++,4)));
  }finally{working.current=false;if(controller.current===request)controller.current=null;}
 },[client,remember]);
 continueIntent.current=()=>{void resume();};
 useEffect(()=>{
  const refresh=()=>{if(latest.current.available&&!document.hidden&&navigator.onLine!==false)void resume();};
  const offline=()=>{controller.current?.abort();if(current.current){setPhase('reconnecting');setError('暂时离线，联网后继续。');}};
  refresh();window.addEventListener('online',refresh);window.addEventListener('focus',refresh);window.addEventListener('offline',offline);document.addEventListener('visibilitychange',refresh);
  return()=>{window.removeEventListener('online',refresh);window.removeEventListener('focus',refresh);window.removeEventListener('offline',offline);document.removeEventListener('visibilitychange',refresh);};
 },[resume,available]);
 function begin(kind:'export'|'delete'){
  if(current.current||!available)return;bundle.current=null;setDownloaded(null);setResult(null);setError('');setProgress({records:0,attachments:0});setPhase(kind==='export'?'exporting':'deleting');retry.current=0;
  remember({accountId,operationId:crypto.randomUUID(),kind});setConfirm(false);void resume();
 }
 const pending=!!intent;
 return <section className="feedback-own-data" aria-labelledby="feedback-own-data-title"><div><h2 id="feedback-own-data-title">我的使用反馈</h2><p>导出或删除自己已提交的反馈内容和附件。</p></div>
  <div className="button-row"><Button variant="outline" disabled={!available||pending} onClick={()=>begin('export')}>导出反馈资料</Button><Button variant="ghost" disabled={!available||pending} onClick={()=>setConfirm(true)}>删除已提交资料</Button></div>
  <div className="feedback-own-data-status" aria-live="polite">
   {phase==='exporting'&&<p>正在准备反馈资料{progress.records?'，已整理 '+progress.records+' 条反馈、'+progress.attachments+' 个附件':''}…</p>}
   {phase==='deleting'&&<p>{result?.metadataDeleted?'反馈内容已删除，正在清除附件'+(result.attachmentCount?'（'+result.attachments.removed+' / '+result.attachmentCount+'）':'')+'。':'正在删除已提交的反馈资料…'}</p>}
   {phase==='attention'&&<p>反馈内容已删除，仍有附件的清除结果尚未确认。<button type="button" className="text-link" disabled={!available||working.current} onClick={()=>void resume()}>刷新结果</button></p>}
   {error&&<p ><output>{error}</output></p>}
   {!phase&&result?.kind==='delete'&&result.phase==='completed'&&<p>{result.feedbackCount?'已删除 '+result.feedbackCount+' 条反馈内容'+(result.attachmentCount?'，'+result.attachments.removed+' 个附件已从文件仓库移除。':'。'):'没有需要删除的已提交反馈。'}</p>}
   {downloaded&&<p>下载已开始，包含 {downloaded.records} 条反馈、{downloaded.attachments} 个可读取附件。{downloaded.unavailableAttachments>0?'另有 '+downloaded.unavailableAttachments+' 个附件当前不可读取，资料中已注明。':''}<button type="button" className="text-link" disabled={!available} onClick={()=>{if(bundle.current)startDownload(bundle.current);}}>重新下载</button></p>}
  </div>
  {confirm&&<ReadingSurface open title="删除已提交的反馈资料" onClose={()=>setConfirm(false)}><p>删除本次操作前已提交的反馈内容和附件？删除后无法恢复，尚未提交的草稿保留。</p><div className="button-row"><Button variant="outline" onClick={()=>setConfirm(false)}>取消</Button><Button disabled={!available||pending} onClick={()=>begin('delete')}>删除资料</Button></div></ReadingSurface>}
 </section>;
}
