'use client';
import {useLayoutEffect,useRef,useState} from 'react';

/** Reveal only received text. Replacement, denial and completion never replay a stale answer. */
export function useProgressiveText(text:string,binding:string,active:boolean){
 const [view,setView]=useState({binding,text:''}),current=useRef({binding,text:''});
 useLayoutEffect(()=>{
  let frame=0,last=0;const media=window.matchMedia('(prefers-reduced-motion: reduce)');
  const apply=(value:string)=>{current.current={binding,text:value};setView(current.current);};
  if(!active||media.matches||!text){apply(text);return;}
  if(current.current.binding!==binding||!text.startsWith(current.current.text))apply('');
  const tick=(now:number)=>{
   if(now-last>=32){
    last=now;const previous=current.current.text.length,remaining=text.length-previous;
    let end=Math.min(text.length,previous+Math.max(1,Math.ceil(remaining/5)));
    if(end<text.length&&text.charCodeAt(end-1)>=0xD800&&text.charCodeAt(end-1)<=0xDBFF)end++;
    apply(text.slice(0,end));
   }
   if(current.current.text.length<text.length)frame=requestAnimationFrame(tick);
  };
  frame=requestAnimationFrame(tick);const reduce=()=>{if(media.matches){cancelAnimationFrame(frame);apply(text);}};media.addEventListener('change',reduce);
  return()=>{cancelAnimationFrame(frame);media.removeEventListener('change',reduce);};
 },[text,binding,active]);
 if(!active||!text)return text;
 return view.binding===binding&&text.startsWith(view.text)?view.text:'';
}
