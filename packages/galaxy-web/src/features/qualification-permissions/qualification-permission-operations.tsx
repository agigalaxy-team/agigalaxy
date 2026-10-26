import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
const names:Record<string,string>={request:'发送材料使用请求',decline:'拒绝使用',cancel:'取消使用请求','source-permission':'允许使用所选材料',compute:'使用所选材料计算','record-permission':'关联已有许可',revoke:'停止材料许可'};
type PendingOperation={operationId:string;state:string};
type OperationResult={state:string;operationId?:string};
type PermissionReview={state:'reauthorization-required';operationId:string;viewers:string[];expiresAt:number;payload:{kind?:string;sourceRefs?:unknown[];reason?:string}};
type PermissionClient={
 reconcile:(operationId:string)=>Promise<OperationResult>;
 reviewAuthorization:(operationId:string)=>Promise<OperationResult|PermissionReview>;
 retry:(operationId:string,options:{confirmed:true})=>Promise<OperationResult>;
 stopLocalRetry:(operationId:string,options:{confirmed:true})=>Promise<OperationResult>;
 reauthorize:(operationId:string,review:PermissionReview,options:{confirmed:true})=>Promise<OperationResult>;
};
type Props={client:PermissionClient;pending:PendingOperation[];busy:boolean;run:(action:()=>Promise<unknown>)=>Promise<unknown>;onComplete?:(result:OperationResult)=>unknown};
export function QualificationPermissionOperations({client,pending,busy,run,onComplete}:Props){
 const [review,setReview]=useState<PermissionReview|null>(null),dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const node=dialog.current;if(review&&node&&!node.open)node.showModal();return()=>{node?.close();};},[review]);
 async function continueOriginal(item:PendingOperation){if(item.state==='stopped-local'){await onComplete?.(await client.reconcile(item.operationId));return;}const checked=await client.reviewAuthorization(item.operationId);if(checked.state==='reauthorization-required'&&'payload'in checked){setReview(checked);return;}if(checked.state==='acknowledged'){await onComplete?.(checked);return;}await onComplete?.(await client.retry(item.operationId,{confirmed:true}));}
 return <>{!!pending.length&&<section className="permission-pending" aria-label="未完成的使用操作">{pending.map(item=><div key={item.operationId}><p>{item.state==='stopped-local'?'已暂停这次处理。':'这次操作还没有得到结果。'}</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>void run(()=>continueOriginal(item))}>{item.state==='stopped-local'?'查看处理结果':'继续处理'}</Button>{item.state!=='stopped-local'&&<Button variant="ghost" disabled={busy} onClick={()=>void run(async()=>onComplete?.(await client.stopLocalRetry(item.operationId,{confirmed:true})))}>暂不继续</Button>}</div><p className="privacy-footnote">暂停后，已送达服务的操作仍可能完成。已经给出的许可可在许可列表中停止。</p></div>)}</section>}
  {review&&<dialog ref={dialog} className="permission-dialog" onCancel={event=>{event.preventDefault();setReview(null);}} aria-labelledby="resume-permission-title"><header><h2 id="resume-permission-title">在当前连接继续原来的选择</h2><button type="button" onClick={()=>setReview(null)} aria-label="关闭">×</button></header><h3>{names[review.payload.kind??'']??'原来的材料使用操作'}</h3><dl className="permission-scope"><dt>接收范围</dt><dd>{review.viewers.length?review.viewers.map((id:string)=>'成员 '+id.slice(-6)).join('、'):'仅本人'}</dd><dt>使用截止</dt><dd>{new Date(review.expiresAt*1000).toLocaleString()}</dd>{review.payload?.sourceRefs&&<><dt>所选材料</dt><dd>{review.payload.sourceRefs.length} 项原来选定的版本</dd></>}{review.payload?.reason&&<><dt>说明</dt><dd>{review.payload.reason}</dd></>}</dl><p>内容和范围保持这次原有选择。确认后使用当前连接继续提交。</p><Button variant="ghost" onClick={()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(review.payload,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='galaxy-original-material-choice.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>保存完整范围</Button><div className="button-row"><Button disabled={busy} onClick={()=>void run(async()=>{const result=await client.reauthorize(review.operationId,review,{confirmed:true});setReview(null);await onComplete?.(result);})}>继续原来的选择</Button><Button variant="outline" onClick={()=>setReview(null)}>暂不继续</Button></div></dialog>}
 </>;
}
