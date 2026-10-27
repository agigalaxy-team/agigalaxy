"use client";
import React,{useLayoutEffect,useRef,useState} from 'react';
import {attachCopyTarget,copyStatusText} from '../../../../../apps/galaxy-site/interaction-copy.mjs';
export function ReadingCode({attributes,children,text,scope,instanceId}:{attributes:Record<string,unknown>;children:React.ReactNode;text:string;scope:string;instanceId:string}){
  const pre=useRef<HTMLPreElement>(null),button=useRef<HTMLButtonElement>(null),copy=useRef<ReturnType<typeof attachCopyTarget>|null>(null);
  const [status,setStatus]=useState<keyof typeof copyStatusText>('idle');
  useLayoutEffect(()=>{
    if(!button.current||!pre.current)return;
    const target=attachCopyTarget({scope,instanceId,trigger:button.current,content:pre.current,onStatus:setStatus});copy.current=target;
    return()=>{if(copy.current===target)copy.current=null;target.dispose();};
  },[text,scope,instanceId]);
  const command=React.Children.toArray(children).some(child=>React.isValidElement<{className?:string}>(child)&&/language-(?:bash|sh|shell|powershell|ps1|cmd|console)\b/i.test(child.props.className??''));
  return <div className="guide-code-block"><div className="guide-code-actions"><button ref={button} type="button" className="guide-code-copy" onClick={()=>void copy.current?.copy()}>{command?'复制命令':'复制内容'}</button><output className="guide-code-status"  aria-live="polite">{copyStatusText[status]}</output></div><pre {...attributes} ref={pre}>{children}</pre></div>;
}
