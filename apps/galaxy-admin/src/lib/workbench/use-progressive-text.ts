'use client';
import {useLayoutEffect,useRef,useState} from 'react';

/** Reveal received text only; short answers stay readable, larger buffers catch up faster. */
export function useProgressiveText(text:string,binding:string,active:boolean){
 const [view,setView]=useState({binding,text:''}),current=useRef({binding,text:''});
 const clock=useRef({binding,at:0,budget:0});
 useLayoutEffect(()=>{
  let frame=0;const media=window.matchMedia('(prefers-reduced-motion: reduce)');
  const apply=(value:string)=>{current.current={binding,text:value};setView(current.current);};
  const resetClock=()=>{clock.current={binding,at:0,budget:0};};
  if(!active||media.matches||!text){apply(text);resetClock();return;}
  if(current.current.binding!==binding){apply('');resetClock();}
  else if(!text.startsWith(current.current.text)){
   let common=0;while(common<text.length&&common<current.current.text.length&&text[common]===current.current.text[common])common++;
   if(common&&text.charCodeAt(common-1)>=0xD800&&text.charCodeAt(common-1)<=0xDBFF)common--;
   apply(text.slice(0,common));resetClock();
  }
  // A stream has no known final length. Recalculate against text actually received,
  // keeping the clock across arriving chunks instead of bursting 1/5 on every chunk.
  const count=Array.from(text).length;
  const duration=Math.min(count*65,Math.min(2600,Math.max(750,600+Math.sqrt(count)*55)));
  const rate=text.length/duration;
  const tick=(now:number)=>{
   const timer=clock.current;
   if(!timer.at)timer.at=now;
   if(now-timer.at>=32){
    timer.budget+=Math.min(80,now-timer.at)*rate;timer.at=now;
    const step=Math.floor(timer.budget),previous=current.current.text.length;
    if(step){
     let end=Math.min(text.length,previous+step);
     if(end<text.length&&text.charCodeAt(end-1)>=0xD800&&text.charCodeAt(end-1)<=0xDBFF)end++;
     timer.budget=Math.max(0,timer.budget-(end-previous));apply(text.slice(0,end));
    }
   }
   if(current.current.text.length<text.length)frame=requestAnimationFrame(tick);
   else resetClock();
  };
  frame=requestAnimationFrame(tick);const reduce=()=>{if(media.matches){cancelAnimationFrame(frame);apply(text);resetClock();}};media.addEventListener('change',reduce);
  return()=>{cancelAnimationFrame(frame);media.removeEventListener('change',reduce);};
 },[text,binding,active]);
 if(!active||!text)return text;
 return view.binding===binding&&text.startsWith(view.text)?view.text:'';
}
