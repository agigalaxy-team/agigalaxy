import React,{useId,useState} from 'react';
import {Button} from '@/components/ui/button';
import {TrustPackageWorkspace} from './trust-package-workspace';
import type {HubRuntime} from "../hubs/hub-workspace-types";
import type {ContentShareContext} from './trust-package-state';
import './content-share-flow.css';

export type {ContentShareContext} from './trust-package-state';
type Props={runtime?:HubRuntime|null;subjectId?:string;connected?:boolean;nativeConnected?:boolean;context:ContentShareContext;onClose:()=>void;navigate?:(path:string)=>void};
function contentLink(context:ContentShareContext){
  try{const url=new URL(context.href??context.returnTo,window.location.origin);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}
}

/** The originating content owns selection. Merely opening this flow grants no data access. */
export function ContentShareFlow(props:Props){
  return <ContentShareSession key={JSON.stringify([props.context.kind,props.context.id,props.subjectId??null,props.runtime?.api.endpoint??null])} {...props}/>;
}
function ContentShareSession({runtime=null,subjectId,connected=false,nativeConnected=false,context,onClose,navigate}:Props){
  const [mode,setMode]=useState<'link'|'file'>('link'),[copied,setCopied]=useState(false),[manual,setManual]=useState(false),field=useId();
  const link=contentLink(context),go=navigate??(()=>{});
  async function copy(){if(!link)return;try{await navigator.clipboard.writeText(link);setCopied(true);setManual(false);}catch{setManual(true);}}
  return <section className="content-share-flow" aria-label={'分享'+context.title}>
    <header className="content-share-heading"><div><h2>{mode==='file'?'导出可携带文件':'分享内容'}</h2><p>{context.title}</p></div><Button variant="ghost" onClick={onClose}>返回原内容</Button></header>
    {mode==='link'?<div className="content-share-actions">
      {link&&<><Button onClick={()=>void copy()}>{copied?'链接已复制':'复制内容链接'}</Button>{manual&&<label htmlFor={field}>复制链接<input id={field} readOnly value={link} onFocus={event=>event.currentTarget.select()}/></label>}</>}
      <Button variant="outline" onClick={()=>setMode('file')}>导出可携带文件</Button>
    </div>:<>
      <Button variant="ghost" onClick={()=>setMode('link')}>分享链接</Button>
      {runtime&&subjectId&&nativeConnected?<TrustPackageWorkspace runtime={runtime} subjectId={subjectId} connected={connected} nativeConnected navigate={go} context={context}/>
        :<div className="content-share-local"><p>可携带文件需要由本人在本机银河签署。</p>{link&&<Button onClick={()=>void copy()}>{copied?'链接已复制':'先分享内容链接'}</Button>}<Button variant="outline" onClick={()=>go('/app/account?section=access&returnTo='+encodeURIComponent(context.returnTo))}>在本机银河中继续</Button>{manual&&link&&<label htmlFor={field}>复制链接<input id={field} readOnly value={link} onFocus={event=>event.currentTarget.select()}/></label>}</div>}
    </>}
  </section>;
}
