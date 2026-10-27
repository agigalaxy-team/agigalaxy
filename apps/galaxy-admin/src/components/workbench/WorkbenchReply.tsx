'use client';

import {useEffect,useLayoutEffect,useState} from 'react';
import {useProgressiveText} from '../../lib/workbench/use-progressive-text';
import {WorkbenchMarkdown} from './WorkbenchMarkdown';
import './workbench-reply.css';

type ProgressProps={active:boolean;label:string;revised?:boolean};
/** One truthful status line. No timer invents work or a model's private reasoning. */
export function WorkbenchReplyProgress({active,label,revised=false}:ProgressProps){
 const [visible,setVisible]=useState(active),[words,setWords]=useState({label,previous:''});
 useEffect(()=>{if(active){setVisible(true);return;}const timer=setTimeout(()=>setVisible(false),220);return()=>clearTimeout(timer);},[active]);
 useLayoutEffect(()=>{
  if(!active)return;
  setWords(previous=>previous.label===label?previous:{label,previous:previous.label});
  const timer=setTimeout(()=>setWords(previous=>({...previous,previous:''})),240);return()=>clearTimeout(timer);
 },[label,active]);
 if(!visible&&!active)return null;
 return <div className="wb-reply-progress" data-active={active} role="status" aria-live="polite" aria-atomic="true"><span className="wb-reply-orbit" aria-hidden="true"/><span className="wb-reply-words">{words.previous&&<span key={'old-'+words.previous} className="wb-reply-previous" aria-hidden="true">{words.previous}</span>}<span key={words.label} className="wb-reply-current"><span className="wb-reply-shimmer">{words.label}</span></span></span>{revised&&<span className="wb-reply-detail">回复已调整</span>}</div>;
}

export function WorkbenchAnswer({content,binding,animate,streaming,onDraft}:{content:string;binding:string;animate:boolean;streaming:boolean;onDraft?:(text:string)=>void}){
 // The same component survives the pending→complete handoff and drains received
 // text at the same pace. Previously completion bypassed reveal altogether.
 const displayed=useProgressiveText(content,binding,animate);
 return <div className={'wb-run-output'+(streaming?' wb-run-output--streaming':'')} aria-live="off"><strong className="wb-answer-author">运营助手</strong><WorkbenchMarkdown content={displayed} onDraft={onDraft} animate={animate}/></div>;
}
