'use client';

import {useEffect,useLayoutEffect,useRef} from 'react';
import {usePathname,useSearchParams} from 'next/navigation';
import {useLinkStatus} from 'next/link';

const reduceMotion='(prefers-reduced-motion: reduce)';
// Payload can remount Navigation during a soft page transition. Retain only
// its last committed display location within this document, never page data.
const committedLocations=new WeakMap<Document,string>();
const excluded='nav,.galaxy-admin-tabs,.galaxy-admin-topbar,.galaxy-admin-sidebar,.galaxy-admin-skip,.app-header,script,style,[hidden],[aria-hidden="true"]';

function visibleContent(root:HTMLElement):HTMLElement[]{
 const result:HTMLElement[]=[];
 for(const child of root.children){
  if(!(child instanceof HTMLElement)||child.matches(excluded))continue;
  const style=getComputedStyle(child);if(style.display==='none'||style.visibility==='hidden')continue;
  if(style.display==='contents'){result.push(...visibleContent(child));continue;}
  const bounds=child.getBoundingClientRect();if(bounds.width&&bounds.height)result.push(child);
 }
 return result;
}
function motionOptions():KeyframeAnimationOptions{
 const style=getComputedStyle(document.documentElement),token=style.getPropertyValue('--admin-motion-content-duration').trim(),value=Number.parseFloat(token);
 return {duration:Number.isFinite(value)?value*(token.endsWith('ms')?1:1000):180,easing:style.getPropertyValue('--admin-motion-content-easing').trim()||'cubic-bezier(.2,.8,.2,1)'};
}

/** Observe committed App Router state. Never wrap, remount, hide or gate business content. */
export function AdminNavigationMotion(){
 const pathname=usePathname(),search=useSearchParams();
 const key=[pathname,search.get('tab')??'',search.get('view')??''].join('|');
 const animations=useRef<Animation[]>([]);
 const cancel=()=>{for(const animation of animations.current)animation.cancel();animations.current=[];};
 useEffect(()=>{
  const media=window.matchMedia(reduceMotion),change=()=>{if(media.matches)cancel();};
  media.addEventListener('change',change);return()=>{media.removeEventListener('change',change);cancel();};
 },[]);
 useLayoutEffect(()=>{
  const old=committedLocations.get(document);committedLocations.set(document,key);cancel();
  if(old===undefined||old===key||window.matchMedia(reduceMotion).matches)return;
  const root=document.getElementById('galaxy-admin-main')??document.querySelector<HTMLElement>('.template-default__wrap');
  if(!root)return;
  const options=motionOptions();
  for(const element of visibleContent(root)){
   if(typeof element.animate!=='function')continue;
   // Composited transform adds to any existing presentation; no inline state survives.
   const opacity=Number.parseFloat(getComputedStyle(element).opacity)||1;
   animations.current.push(element.animate([{opacity:opacity*.92},{opacity}],options),element.animate([{transform:'translateY(4px)'},{transform:'translateY(0px)'}],{...options,composite:'add'}));
  }
  return cancel;
 },[key]);
 return null;
}

/** This status belongs to the existing Next Link transition, after existing leave guards. */
export function AdminNavigationPending(){
 const {pending}=useLinkStatus();
 return pending?<span className="galaxy-admin-link-pending" role="status" aria-live="polite"><span className="galaxy-admin-motion-sr-only">正在打开页面…</span></span>:null;
}

