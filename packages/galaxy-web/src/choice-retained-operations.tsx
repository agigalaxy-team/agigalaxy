import React,{useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {Button} from '@/components/ui/button';
import {createChoiceSyncClient} from './choice-sync-client.mjs';

export type ChoiceViewLease={subjectId:string;deviceId:string;endpoint:string;bindingId:string|null;generation:number|null;assertCurrent:()=>void};
type LeaseRuntime={receiptStatus:{captureLease:()=>ChoiceViewLease}};
type Client=ReturnType<typeof createChoiceSyncClient>;
type Receipt=Awaited<ReturnType<Client['reconcileRetained']>>;
type OriginalOperation={snapshotId:string;versionId:string;requestHash:string;originalState:string;location:string};
let nextView=0;

// Observe the runtime's synchronous reference fence; no status call, session,
// proof request or network discovery is needed to invalidate a local view.
export function useChoiceViewLease(runtime:LeaseRuntime|null,subjectId?:string){
 const store=useMemo(()=>createLeaseViewStore(runtime,subjectId),[runtime,subjectId]);
 return useSyncExternalStore(store.subscribe,store.read,store.read);
}
function createLeaseViewStore(runtime:LeaseRuntime|null,subjectId?:string){
  const id=++nextView;let revision=0,snapshot:{key:string;lease:ChoiceViewLease|null}={key:`${id}:0`,lease:null};
  const read=()=>{if(snapshot.lease){try{snapshot.lease.assertCurrent();return snapshot;}catch{/* Re-capture only after invalidation. */}}
   let lease:ChoiceViewLease|null=null;try{const value=runtime?.receiptStatus.captureLease();if(value?.subjectId===subjectId&&value)lease=value;}catch{/* No current local owner. */}
   if(!snapshot.lease&&!lease)return snapshot;
   snapshot={key:`${id}:${++revision}`,lease};return snapshot;
  };
  return{read,subscribe:(changed:()=>void)=>{let prior=read();const refresh=()=>{const next=read();if(next!==prior){prior=next;changed();}};
   const timer=window.setInterval(refresh,250);document.addEventListener('visibilitychange',refresh);
   return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};}};
}

const stateLabel:Record<string,string>={'local-pending':'等待保存结果',unknown:'暂未确认',acknowledged:'已收到',absent:'未查到接收记录',conflict:'记录需要核对'};
const storedLabel:Record<string,string>={current:'原版本已保存',conflict:'与另一版本一同保留',superseded:'后来已有更新版本',expired:'副本已到期',deleted:'副本已删除',invalidated:'来源已失效'};
function failure(error:unknown){
 const code=typeof error==='object'&&error!==null?Reflect.get(error,'code')??Reflect.get(error,'message'):null;
 const messages:Record<string,string>={'receipt_status_access_denied':'当前身份或设备暂时无法读取保存结果。','receipt_status_authority_changed':'身份或连接已变化，请重新打开这份记录。','choice_original_operation_changed':'本机记录存在冲突，暂时无法确认。'};
 return typeof code==='string'&&messages[code]||'暂时无法读取保存结果，原记录仍保留。';
}

type RetainedProps={client:Client;lease:ChoiceViewLease;titles?:Record<string,string>;onResolved?:()=>void};
export function ChoiceRetainedOperations(props:RetainedProps){
 const {lease}=props,key=JSON.stringify([lease.endpoint,lease.subjectId,lease.deviceId,lease.bindingId,lease.generation]);
 return <RetainedOperations key={key} {...props}/>;
}
function RetainedOperations({client,lease,titles={},onResolved}:RetainedProps){
 const [rows,setRows]=useState<OriginalOperation[]>([]),[open,setOpen]=useState(false),[limit,setLimit]=useState(6),[receipts,setReceipts]=useState<Record<string,Receipt>>({});
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),epoch=useRef(0),working=useRef(false),refreshRef=useRef<()=>Promise<void>>(async()=>{}),onResolvedRef=useRef(onResolved);
 useLayoutEffect(()=>{onResolvedRef.current=onResolved;});
 const valid=(token:number)=>{if(epoch.current!==token)return false;try{lease.assertCurrent();return true;}catch{return false;}};
 async function refresh(){if(working.current)return;const token=epoch.current;if(!valid(token))return;working.current=true;setBusy(true);setError('');
  try{const items=await client.retainedReceiptOperations();if(!valid(token))return;setRows(items);if(!open)return;
   let resolved=false;for(const row of items.slice(0,limit)){const result=await client.reconcileRetained(row.snapshotId,{versionId:row.versionId});if(!valid(token))return;setReceipts(old=>({...old,[row.versionId]:result}));if(row.originalState==='local-pending'&&result.state==='acknowledged')resolved=true;}
   if(resolved)onResolvedRef.current?.();
  }catch(e){if(valid(token))setError(failure(e));}finally{working.current=false;if(valid(token))setBusy(false);}
 }
 useLayoutEffect(()=>{refreshRef.current=refresh;});
 useEffect(()=>{const viewEpoch=epoch;viewEpoch.current++;void refreshRef.current();const observe=()=>{if(!document.hidden)void refreshRef.current();};const timer=window.setInterval(observe,20000);document.addEventListener('visibilitychange',observe);return()=>{viewEpoch.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',observe);};},[client,lease]);
 useEffect(()=>{if(open)void refreshRef.current();},[open,limit]);
 if(!rows.length&&!error)return null;
 return <details className="choice-retained" open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary>查看以前的保存结果</summary>
  {busy&&<p className="muted">正在读取…</p>}{error&&<p role="alert">{error}<button className="text-link" disabled={busy} onClick={()=>void refreshRef.current()}>重试</button></p>}
  {rows.slice(0,limit).map(row=>{const result=receipts[row.versionId],receipt=result?.state==='acknowledged'?result.receipt:null;return <article className="choice-retained-row" key={row.versionId}>
   <header><strong>{titles[row.snapshotId]??'参考记录 '+row.snapshotId.slice(-4)}</strong><span>{stateLabel[result?.state??row.originalState]??'暂未确认'}</span></header>
   {receipt?<p>{storedLabel[receipt.storedState]??'原保存已收到'} · {new Date(receipt.acceptedAt).toLocaleString('zh-CN')}</p>:result?.state==='absent'?<p>暂未查到这次保存的记录，可能未收到或记录已经清理。</p>:result?.state==='conflict'?<p>记录信息不一致，原内容没有重新发送。</p>:null}
   <details><summary>记录详情</summary><dl><dt>参考记录</dt><dd>{row.snapshotId}</dd><dt>原版本</dt><dd>{row.versionId}</dd><dt>校验值</dt><dd>{row.requestHash}</dd>{receipt&&<><dt>副本期限</dt><dd>{new Date(receipt.contentExpiresAt).toLocaleString('zh-CN')}</dd></>}</dl></details>
  </article>;})}
  {rows.length>limit&&<Button variant="ghost" disabled={busy} onClick={()=>setLimit(v=>v+6)}>更早的保存</Button>}
  <p className="muted">这里仅记录是否收到过保存，不代表原内容现在仍可读取。</p>
 </details>;
}
