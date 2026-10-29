'use client';

import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {AdminIcon} from '../AdminIcons';
import {useProgressiveText} from '../../lib/workbench/use-progressive-text';
import {WorkbenchMarkdown} from './WorkbenchMarkdown';
import './workbench-reply.css';

export function replyProgressLabel(phase:'waiting'|'working'|'generating',finished=false){
 return finished?'正在整理资料':phase==='working'?'正在读取数据':phase==='generating'?'正在整理资料':'正在思考';
}

/** A narrow repeating highlight; its period is exactly one measured text width. */
export function WorkbenchReplyProgress({active,label}:{active:boolean;label:string}){
 const [words,setWords]=useState({label,previous:''});
 useLayoutEffect(()=>{
  if(!active)return;
  setWords(previous=>previous.label===label?previous:{label,previous:previous.label});
  const timer=setTimeout(()=>setWords(previous=>({...previous,previous:''})),220);return()=>clearTimeout(timer);
 },[label,active]);
 if(!active)return null;
 const size=Array.from(words.label).length;
 return <div className="wb-reply-progress" role="status" aria-live="polite" aria-atomic="true"><span className="wb-reply-words">{words.previous&&<span key={'old-'+words.previous} className="wb-reply-previous" aria-hidden="true">{words.previous}</span>}<span key={words.label} className="wb-reply-current"><span className="wb-reply-shimmer" ref={element=>{if(element)element.style.setProperty('--wb-sweep-size',element.getBoundingClientRect().width+'px');}} style={{'--wb-sweep-size':size+'em','--wb-sweep-duration':Math.max(1.2,size*.36)+'s'} as CSSProperties}>{words.label}</span></span></span></div>;
}

export function WorkbenchAnswer({content,binding,animate,streaming,onDraft,completedTime}:{content:string;binding:string;animate:boolean;streaming:boolean;onDraft?:(text:string)=>void;completedTime?:ReactNode}){
 const displayed=useProgressiveText(content,binding,animate);
 const [copy,setCopy]=useState<'idle'|'copying'|'copied'|'failed'>('idle'),attempt=useRef(0);
 useEffect(()=>{setCopy('idle');return()=>{attempt.current++;};},[binding,content]);
 useEffect(()=>{if(copy!=='copied')return;const timer=setTimeout(()=>setCopy('idle'),1600);return()=>clearTimeout(timer);},[copy]);
 const copyAnswer=async()=>{if(copy==='copying')return;const token=++attempt.current;setCopy('copying');try{await navigator.clipboard.writeText(content);if(attempt.current===token)setCopy('copied');}catch{if(attempt.current===token)setCopy('failed');}};
 const copyLabel=copy==='copied'?'已复制':copy==='failed'?'复制失败，请重试':'复制回复';
 return <div className={'wb-run-output'+(streaming?' wb-run-output--streaming':'')} aria-live="off"><strong className="wb-answer-author">运营助手</strong><WorkbenchMarkdown content={displayed} onDraft={onDraft} animate={animate}/>{!streaming&&displayed===content&&content.trim()&&<div className="wb-answer-actions"><button type="button" className="wb-answer-copy" aria-label={copyLabel} title={copyLabel} disabled={copy==='copying'} aria-busy={copy==='copying'} onClick={()=>void copyAnswer()}><AdminIcon name={copy==='copied'?'check':copy==='failed'?'warning':'copy'} size={16}/></button>{completedTime&&<span className="wb-answer-time">{completedTime}</span>}<span className="wb-visually-hidden" role="status">{copy==='copied'?'回复已复制':copy==='failed'?'复制未成功，请再次点击复制图标':''}</span></div>}</div>;
}
