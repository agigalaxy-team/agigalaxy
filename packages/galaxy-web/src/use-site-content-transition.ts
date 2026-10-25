import {createContext,useContext,useLayoutEffect,useState,type RefObject} from 'react';

function durationMilliseconds(value:string){
 const match=/^(\d+(?:\.\d*)?|\.\d+)(ms|s)$/i.exec(value.trim());
 const duration=match?Number(match[1])*(match[2].toLowerCase()==='s'?1000:1):NaN;
 return Number.isFinite(duration)&&duration>0?duration:null;
}
type ContentEntry={route:string;pathname:string;animate:boolean;animateReady:boolean;deferPrimary:boolean;takeReady:()=>boolean};
export const SiteContentTransitionContext=createContext<ContentEntry|null>(null);
function contentEntry(route:string,deferPrimary:boolean,previous:ContentEntry|null):ContentEntry{
 const pathname=route.split('?')[0],animateReady=!!previous&&previous.pathname!==pathname;
 let revealed=false;
 return{route,pathname,animate:!!previous&&previous.route!==route,animateReady,deferPrimary,takeReady:()=>{
  if(revealed)return false;revealed=true;return animateReady;
 }};
}

function playTransition(node:HTMLElement|null){
 if(!node||typeof node.animate!=='function'||typeof window.matchMedia!=='function')return;
 const preference=window.matchMedia('(prefers-reduced-motion: reduce)');if(preference.matches)return;
 const style=getComputedStyle(node),duration=durationMilliseconds(style.getPropertyValue('--g-page-transition-duration'));
 if(duration===null)return;
 let animation:Animation;
 try{animation=node.animate([{opacity:0.84},{opacity:1}],{duration,easing:style.getPropertyValue('--g-page-transition-easing').trim()||'ease-out'});}
 catch{return;}
 void animation.finished.catch(()=>{});
 const reduced=()=>{if(preference.matches)animation.cancel();};
 preference.addEventListener('change',reduced);
 return()=>{preference.removeEventListener('change',reduced);animation.cancel();};
}

/** Presentation only: keep the committed content, focus and route ownership. */
export function useSiteContentTransition(target:RefObject<HTMLElement|null>,route:string,{deferPrimary=false}:{deferPrimary?:boolean}={}){
 const [entry,setEntry]=useState<ContentEntry>(()=>contentEntry(route,deferPrimary,null));
 // Set this component's presentation entry before its children commit, including cached content.
 if(entry.route!==route||entry.deferPrimary!==deferPrimary){
  setEntry(contentEntry(route,deferPrimary,entry));
 }
 useLayoutEffect(()=>{
  if(entry.route!==route||!entry.animate||entry.deferPrimary)return;
  return playTransition(target.current);
 },[target,route,entry]);
 return entry;
}

/** Reveal a deferred primary result once; renewals and local panels stay still. */
export function useSiteContentReadyTransition(target:RefObject<HTMLElement|null>,ready:boolean){
 const entry=useContext(SiteContentTransitionContext);
 useLayoutEffect(()=>{
  if(!entry?.deferPrimary||!ready||!target.current||!entry.takeReady())return;
  return playTransition(target.current);
 },[target,entry,ready]);
}
