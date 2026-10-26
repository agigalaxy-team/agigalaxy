import React,{useEffect,useEffectEvent,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {verifyTrustPackage} from "../../../../galaxy-official/src/verification/trust-package.mjs";
import {trustContainerSchema} from "../../../../galaxy-official/src/shared/trust-package-schema.mjs";
import {TrustPackageReading} from './trust-package-workspace';
import {LoadingFeedback} from "../../shared/feedback/interaction-feedback";
import type {HubRuntime} from "../hubs/hub-workspace-types";
import type {TrustContainer,TrustOnline,TrustReport} from './trust-package-state';
import './content-share-flow.css';

type Props={file?:Blob;runtime?:HubRuntime|null;subjectId?:string;connected?:boolean;returnTo?:string;navigate?:(path:string)=>void;onClose?:()=>void};
type Reading={container:TrustContainer;report:TrustReport;name:string};

/** A file already read under its attachment permission is opened locally, never uploaded again. */
export function ReceivedPackageReader({file,runtime=null,subjectId,connected=false,returnTo,navigate,onClose}:Props){
  const [reading,setReading]=useState<Reading|null>(null),[online,setOnline]=useState<TrustOnline|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const sequence=useRef(0),alive=useRef(true);
  const invalidateRequest=useEffectEvent(()=>{sequence.current++;});
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;invalidateRequest();};},[]);
  async function open(selected:Blob){const token=++sequence.current;setBusy(true);setError('');setReading(null);setOnline(null);
    try{if(selected.size>4500000)throw Error('这份文件超过可读取的资料包大小。');const text=await selected.text(),container=trustContainerSchema.parse(JSON.parse(text)),report=await verifyTrustPackage(text);
      if(alive.current&&token===sequence.current)setReading({container,report,name:'name'in selected&&typeof selected.name==='string'?selected.name:'收到的资料'});
    }catch{if(alive.current&&token===sequence.current)setError('这份文件不是可读取的银河资料包，或文件签名未通过。可以保留原文件并向发送者索取。');}
    finally{if(alive.current&&token===sequence.current)setBusy(false);}
  }
  const openCurrent=useEffectEvent(open);
  useEffect(()=>{if(file)void openCurrent(file);},[file]);
  useEffect(()=>{if(!reading||!runtime||!connected||!subjectId)return;let active=true;const token=sequence.current;
    const read=async()=>{try{const lease=runtime.receiptStatus.captureLease();lease.assertCurrent();if(lease.subjectId!==subjectId)throw Error('trust_identity_changed');const result=await runtime.trustPackages.checkOnline(reading.container,{selectedEndpoint:runtime.api.endpoint});lease.assertCurrent();if(active&&token===sequence.current)setOnline(result.online);}
      catch{if(active&&token===sequence.current)setOnline({checkedAt:Math.floor(Date.now()/1000),items:[],unavailable:true});}};
    void read();const poll=window.setInterval(()=>{if(!document.hidden)void read();},15000);return()=>{active=false;window.clearInterval(poll);};
  },[reading,runtime,connected,subjectId]);
  const close=()=>{if(onClose)onClose();else if(returnTo)navigate?.(returnTo);};
  return <section className="content-share-flow received-package-reader" aria-label="阅读收到的资料">
    <header className="content-share-heading"><h2>{reading?.name??'打开收到的资料'}</h2>{(onClose||returnTo)&&<Button variant="ghost" onClick={close}>返回原内容</Button>}</header>
    {!file&&<label className="received-package-file">选择银河资料文件<input type="file" accept=".json,application/json" disabled={busy} onChange={event=>{const selected=event.target.files?.[0];if(selected)void open(selected);event.target.value='';}}/></label>}
    {busy&&<LoadingFeedback label="正在打开资料…"/>}{error&&<p className="message error" role="alert">{error}</p>}
    {reading&&<><p className="record-meta">{reading.report.integrity==='valid'?'文件签名有效':'文件签名未通过'}{reading.report.temporalState==='expired'?' · 文件已超过声明的有效期':reading.report.temporalState==='future-signer-declared-time'?' · 尚未到声明的生效时间':''}</p><TrustPackageReading files={reading.container.files}/>
      {online&&<section className="package-permission-status"><h3>来源当前状态</h3>{online.unavailable?<p>原服务暂时无法读取，当前展示的是文件中已保存的内容。</p>:online.items.map((item,index)=><p key={index}>材料 {index+1}：{({active:'当前许可有效',revoked:'许可已停止',expired:'许可已到期','source-or-control-unavailable':'原材料目前不可读取','not-checked':'尚未取得当前许可'} as Record<string,string>)[item.status]??'当前状态不可读取'}</p>)}</section>}
    </>}
  </section>;
}
