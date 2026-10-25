import { ReadingDetails, ReadingSummary } from "./reading-details";
import React,{useEffect,useMemo,useRef,useSyncExternalStore} from 'react';
import {Button} from '@/components/ui/button';
import {HistoryFields} from "./features/work-records/history";
import {memberName} from "./conversation-ui";

type Pending={operationId:string;state:string};
type Receipt={state:string;reason?:string};
type Review=Receipt&{state:'reauthorization-required';operationId:string;visibility:string;viewers?:string[];expiresAt:number;payload:unknown};
type Client={
 pending:()=>Promise<Pending[]>;resumePending:()=>Promise<Receipt>;
 reviewAuthorization:(id:string)=>Promise<Receipt|Review>;
 stopLocalRetry:(id:string,options:{confirmed:true})=>Promise<unknown>;
 reauthorize:(id:string,review:Review,options:{confirmed:true})=>Promise<Receipt>;
};
type Props={client:Client|null;connected:boolean;scopeKey:string;onComplete?:(receipt:Receipt)=>void|Promise<void>};
type View={pending:Pending[];review:Review|null;busy:boolean;error:string;reason:string};
const isReview=(value:Receipt|Review):value is Review=>value.state==='reauthorization-required'&&'operationId' in value;
function createJournalView(client:Client|null,connected:boolean){
 const listeners=new Set<()=>void>();
 let snapshot:View={pending:[],review:null,busy:false,error:'',reason:''},active=false,generation=0,timer:number|null=null;
 let callback:Props['onComplete'];
 const publish=(patch:Partial<View>)=>{snapshot={...snapshot,...patch};for(const listener of listeners)listener();};
 async function complete(receipt:Receipt){await callback?.(receipt);}
 async function resume(valid:()=>boolean){
  if(!client)return;
  const receipt=await client.resumePending();if(!valid())return;publish({reason:receipt.reason??''});
  const pending=await client.pending();if(!valid())return;publish({pending});
  if(receipt.state==='acknowledged'){publish({review:null});await complete(receipt);}
 }
 async function run(action:(valid:()=>boolean)=>Promise<void>){
  if(!active||!client||!connected||snapshot.busy)return;
  const token=generation,valid=()=>active&&token===generation;publish({busy:true,error:''});
  try{await action(valid);}catch(reason){if(valid())publish({error:reason instanceof Error?reason.message:'上次提交暂未完成，原内容仍保留。'});}
  finally{if(valid()){try{const pending=await client.pending();if(valid())publish({pending});}catch{}if(valid())publish({busy:false});}}
 }
 const tick=()=>{if(document.visibilityState==='visible')void run(resume);};
 return{read:()=>snapshot,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
  callbacks:(next:Props['onComplete'])=>{callback=next;},
  start:()=>{active=true;generation++;publish({pending:[],review:null,busy:false,error:'',reason:''});tick();timer=window.setInterval(tick,12000);document.addEventListener('visibilitychange',tick);},
  close:()=>{active=false;generation++;if(timer!==null)window.clearInterval(timer);timer=null;document.removeEventListener('visibilitychange',tick);},
  dismiss:()=>publish({review:null}),review:(next:Receipt|Review)=>{if(isReview(next))publish({review:next});},clearReason:()=>publish({reason:''}),complete,run,resume};
}
export function JournalRecovery(props:Props){return <JournalRecoverySession key={props.scopeKey} {...props}/>;}
function JournalRecoverySession({client,connected,onComplete}:Props){
 const view=useMemo(()=>createJournalView(client,connected),[client,connected]),{pending,review,busy,error,reason}=useSyncExternalStore(view.subscribe,view.read,view.read);
 const {run,resume}=view,dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{view.callbacks(onComplete);},[view,onComplete]);
 useEffect(()=>{view.start();return view.close;},[view]);
 useEffect(()=>{if(review)dialog.current?.showModal();else dialog.current?.close();},[review]);
  const active=pending.find(op=>op.state!=='stopped-local'),stopped=pending.filter(op=>op.state==='stopped-local');
  const needsReview=['authorization-expired','original-binding-changed','original-binding-unavailable'].includes(reason);
  const explanation=reason==='authorization-expired'?'上次授权已到期，核对原内容与本次期限后可以继续。':reason==='original-binding-changed'?'当前连接与上次不同，核对原内容后可以用当前连接继续。':reason==='original-binding-unavailable'?'上次记录缺少原连接依据，核对原内容后可以继续。':'上次提交正在确认，原内容已经保留。';
  if(!active&&!stopped.length&&!review&&!error)return null;
  return <aside className="operation-status" aria-label="继续上次提交">
    {active&&<><p>{explanation}</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>void run(async valid=>{if(needsReview){const next=await client!.reviewAuthorization(active.operationId);if(!valid())return;if(next.state==='reauthorization-required')view.review(next);else if(next.state==='acknowledged'){view.dismiss();await view.complete(next);}else await resume(valid);}else await resume(valid);})}>{needsReview?'核对原内容':'继续原提交'}</Button><Button variant="ghost" disabled={busy} onClick={()=>void run(async valid=>{await client!.stopLocalRetry(active.operationId,{confirmed:true});if(valid())view.dismiss();})}>停止重试</Button></div></>}
    {stopped.length>0&&<ReadingDetails className="technical-details"><ReadingSummary>已停止的提交（{stopped.length}）</ReadingSummary><p>只查询接收状态，已经移除的原文不会重发。</p>{stopped.map(op=><p key={op.operationId}><code>{op.operationId}</code></p>)}<Button variant="ghost" disabled={busy} onClick={()=>void run(resume)}>检查接收状态</Button></ReadingDetails>}
    {error&&<p role="alert">{error}</p>}
    <dialog ref={dialog} className="workspace-dialog" onCancel={event=>{if(busy)event.preventDefault();else view.dismiss();}}>{review&&<><header className="dialog-heading"><h2>继续这份原内容</h2><button className="icon-button" aria-label="关闭原内容预览" disabled={busy} onClick={()=>view.dismiss()}>×</button></header><p>{review.visibility==='Public'?'公开':review.viewers?.length?review.viewers.map((id:string)=>memberName(id)).join('、'):'仅自己'}可见；本次授权有效至 {new Date(review.expiresAt*1000).toLocaleString()}。</p><p>{reason==='authorization-expired'?'原授权已经到期，请核对这次授权期限。':reason==='original-binding-changed'?'这次会使用当前连接继续原内容，保留原定期限。':'请核对原内容、可见范围与授权期限。'}</p><HistoryFields value={review.payload}/>{error&&<p role="alert">{error}</p>}<div className="button-row"><Button disabled={busy} onClick={()=>void run(async valid=>{const receipt=await client!.reauthorize(review.operationId,review,{confirmed:true});if(!valid())return;view.dismiss();view.clearReason();if(receipt.state==='acknowledged')await view.complete(receipt);})}>确认内容并继续</Button><Button variant="outline" disabled={busy} onClick={()=>view.dismiss()}>暂不继续</Button></div></>}</dialog>
  </aside>;
}
