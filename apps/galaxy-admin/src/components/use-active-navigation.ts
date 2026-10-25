'use client';

import {useLayoutEffect,useRef} from 'react';

/** Reveal only the active rail item; never move the page or its reading focus. */
export function useActiveNavigation(active:string,axis:'horizontal'|'both'='horizontal'){
 const reference=useRef<HTMLElement|null>(null);
 useLayoutEffect(()=>{
  const rail=reference.current;if(!rail)return;
  const reveal=()=>{
   const item=rail.querySelector<HTMLElement>('[aria-current="page"],[aria-selected="true"]');if(!item)return;
   const bounds=rail.getBoundingClientRect(),selected=item.getBoundingClientRect(),left=bounds.left+rail.clientLeft,top=bounds.top+rail.clientTop;
   if(rail.scrollWidth>rail.clientWidth){
    if(selected.left<left)rail.scrollLeft+=selected.left-left;
    else if(selected.right>left+rail.clientWidth)rail.scrollLeft+=selected.right-left-rail.clientWidth;
   }
   if(axis==='both'&&rail.scrollHeight>rail.clientHeight){
    if(selected.top<top)rail.scrollTop+=selected.top-top;
    else if(selected.bottom>top+rail.clientHeight)rail.scrollTop+=selected.bottom-top-rail.clientHeight;
   }
  };
  reveal();
  const observer=new ResizeObserver(reveal);observer.observe(rail);
  return()=>observer.disconnect();
 },[active,axis]);
 return reference;
}
