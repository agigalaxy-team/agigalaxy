import React,{useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {useChoiceViewLease} from './choice-retained-operations';
import {sha256Hex} from '../../galaxy-official/src/shared/web-primitives.mjs';
import type {CapsuleAuthorClient,CapsuleAuthorLease,CapsuleAuthorRuntime,CapsuleInputGateProps,CapsuleLocator,CapsuleReceipt} from './capsule-authoring-types';

export const capsuleAuthoringDraftKey=(endpoint:string,subjectId:string,mode:string,capsuleId?:string)=>'capsule-authoring:'+endpoint+':'+subjectId+':'+(mode==='revision'?capsuleId:'new');
export const capsuleInputDraftKey=(endpoint:string,subjectId:string,mode:string,id?:string)=>'capsule-input:v1:'+JSON.stringify([endpoint,subjectId,mode,id??null]);
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
const isCapsuleInputRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const message=(error:unknown)=>isCapsuleInputRecord(error)&&typeof error.message==='string'&&/[\u3400-\u9fff]/.test(error.message)?error.message:'本机草稿暂时无法读取，原内容仍保留。';
const legacyImport=(value:unknown)=>{const metadata=isCapsuleInputRecord(value)&&isCapsuleInputRecord(value.legacyImport)?value.legacyImport:null;return{sourceKey:typeof metadata?.sourceKey==='string'?metadata.sourceKey:null,sourceHash:typeof metadata?.sourceHash==='string'?metadata.sourceHash:null};};
const isCapsuleLocator=(value:unknown):value is CapsuleLocator=>isCapsuleInputRecord(value)&&typeof value.operationId==='string'&&typeof value.payloadHash==='string'&&typeof value.endpoint==='string'&&typeof value.subjectId==='string'&&(value.type==='publication'||value.type==='use'||value.type==='permission');

/** Import into a separate CAS slot. The old slot is never rewritten or deleted. */
export async function prepareCapsuleInput<T extends object>(runtime:CapsuleAuthorRuntime,lease:CapsuleAuthorLease,subjectId:string,key:string,legacyKeys:string[],normalize:(value:unknown)=>T|null){
 const check=()=>{lease.assertCurrent();if(lease.subjectId!==subjectId||lease.endpoint!==runtime.api.endpoint)throw Error('身份或服务已改变，请重新打开草稿。');};
 const read=async(name:string):Promise<unknown>=>{check();const value:unknown=await runtime.getLocal(name,subjectId);check();return value;};
 const markKey=key+':legacy-import',current=await read(key),mark=await read(markKey);
 if(current&&!(isCapsuleInputRecord(current)&&current.version===1&&typeof current.revision==='string'&&isCapsuleInputRecord(current.value)))throw Error('本机草稿格式暂不能核对，原内容仍保留。');
 if(isCapsuleInputRecord(mark)&&mark.version===1&&mark.checked)return;
 let imported=current;let {sourceKey,sourceHash}=legacyImport(current);
 if(!current){
  for(const oldKey of legacyKeys){
   const old=await read(oldKey);if(!old)continue;
   const value=normalize(old);if(value===null)continue;
   sourceKey=oldKey;sourceHash=await sha256Hex(JSON.stringify(old));check();
   imported=await runtime.updateLocal(key,(saved:unknown)=>{check();if(saved!==null&&saved!==undefined)return saved;return{version:1,revision:crypto.randomUUID(),value:structuredClone(value),legacyImport:{sourceKey,sourceHash}};},subjectId);
   check();break;
  }
 }
 // The marker is written before editing is enabled, so clearing a later exact
 // draft cannot resurrect an untouched legacy slot on the next visit.
 const importedFrom=legacyImport(imported);
 await runtime.updateLocal(markKey,(saved:unknown)=>{check();return isCapsuleInputRecord(saved)&&saved.version===1&&saved.checked?saved:{version:1,checked:true,sourceKey:importedFrom.sourceKey??sourceKey,sourceHash:importedFrom.sourceHash??sourceHash};},subjectId);check();
}

export function CapsuleInputGate<T extends object>({runtime,subjectId,draftKey,legacyKeys=[],normalize,children}:CapsuleInputGateProps<T>){
 const view=useChoiceViewLease(runtime,subjectId);
 if(!view.lease)return <output className="method-input-status">连接当前身份后继续编辑，原草稿仍保留。</output>;
 return <CapsuleInputLoad key={view.key+':'+draftKey} {...{runtime,subjectId,draftKey,legacyKeys,normalize,children}} lease={view.lease}/>;
}
function CapsuleInputLoad<T extends object>({runtime,subjectId,draftKey,legacyKeys,normalize,children,lease}:CapsuleInputGateProps<T>&{lease:CapsuleAuthorLease}){
 const [migration]=useState(()=>({legacyKeys:legacyKeys??[],normalize})),[result,setResult]=useState({retry:0,ready:false,error:''}),[retry,setRetry]=useState(0);
 const ready=result.retry===retry&&result.ready,error=result.retry===retry?result.error:'';
 useEffect(()=>{let live=true;void prepareCapsuleInput(runtime,lease,subjectId,draftKey,migration.legacyKeys,migration.normalize).then(()=>{if(live)setResult({retry,ready:true,error:''});}).catch(error=>{if(live)setResult({retry,ready:false,error:message(error)});});return()=>{live=false;};},[runtime,lease,subjectId,draftKey,retry,migration]);
 if(!ready)return <div className="method-input-status" aria-live="polite">{error?<><p role="alert">{error}</p><Button type="button" variant="outline" onClick={()=>setRetry(value=>value+1)}>重新读取草稿</Button></>:<p>正在接续你的草稿…</p>}</div>;
 return children;
}

/** Used only when the matching editor is not mounted; compare exact revision and locator. */
export async function settleCapsuleInput(runtime:CapsuleAuthorRuntime,subjectId:string,key:string,client:Pick<CapsuleAuthorClient,'receiptFor'>,receipt:CapsuleReceipt){
 const lease=runtime.receiptStatus.captureLease(),check=()=>{lease.assertCurrent();if(lease.subjectId!==subjectId)throw Error('草稿身份已变化。');};
 check();const saved:unknown=await runtime.getLocal(key,subjectId);check();
 if(!isCapsuleInputRecord(saved))return false;const original=saved.attempt;if(!isCapsuleLocator(original)||original.endpoint!==runtime.api.endpoint||original.subjectId!==subjectId||original.operationId!==(receipt.operationId??receipt.eventId))return false;
 const current=await client.receiptFor(original);check();if(current.state!=='acknowledged')return false;
 let cleared=false;await runtime.updateLocal(key,(value:unknown)=>{check();if(isCapsuleInputRecord(value)&&value.revision===saved.revision&&same(value.attempt,original)){cleared=true;return null;}return value;},subjectId);check();return cleared;
}
