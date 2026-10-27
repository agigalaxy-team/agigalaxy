import {animateContent} from './shared/feedback/content-motion';
import {createContext,useContext,useLayoutEffect,useState,type RefObject} from 'react';

type ContentEntry={route:string;pathname:string;animate:boolean;animateReady:boolean;deferPrimary:boolean;takeReady:()=>boolean};
export const SiteContentTransitionContext=createContext<ContentEntry|null>(null);
function contentEntry(route:string,deferPrimary:boolean,previous:ContentEntry|null):ContentEntry{
 const pathname=route.split('?')[0],animateReady=!!previous&&previous.pathname!==pathname;
 let revealed=false;
 return{route,pathname,animate:!!previous&&previous.route!==route,animateReady,deferPrimary,takeReady:()=>{
  if(revealed)return false;revealed=true;return animateReady;
 }};
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
  return animateContent(target.current);
 },[target,route,entry]);
 return entry;
}

/** Reveal a deferred primary result once; renewals and local panels stay still. */
export function useSiteContentReadyTransition(target:RefObject<HTMLElement|null>,ready:boolean){
 const entry=useContext(SiteContentTransitionContext);
 useLayoutEffect(()=>{
  if(!entry?.deferPrimary||!ready||!target.current||!entry.takeReady())return;
  return animateContent(target.current);
 },[target,entry,ready]);
}
