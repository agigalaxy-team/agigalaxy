'use client';
import {useLayoutEffect,type RefObject} from 'react';

/** Presentation only. The owning router or page retains selection and focus. */
export function useSelectionIndicator(rail:RefObject<HTMLElement|null>,active:string){
 useLayoutEffect(()=>{
  const node=rail.current;if(!node)return;let frame=0;
  const measure=()=>{
   const selected=node.querySelector<HTMLElement>('[aria-selected="true"],[aria-current="page"]');
   if(!selected){delete node.dataset.indicatorReady;return;}
   const bounds=selected.getBoundingClientRect(),parent=node.getBoundingClientRect();
   node.style.setProperty('--selection-x',`${bounds.left-parent.left+node.scrollLeft-node.clientLeft}px`);
   node.style.setProperty('--selection-width',`${bounds.width}px`);node.dataset.indicatorReady='true';
   cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{node.dataset.indicatorLive='true';});
  };
  const resize=new ResizeObserver(measure),observe=()=>{resize.disconnect();resize.observe(node);for(const child of node.children)if(child instanceof HTMLElement&&!child.matches('[data-selection-marker]'))resize.observe(child);measure();};
  const changes=new MutationObserver(observe);changes.observe(node,{childList:true});observe();
  return()=>{cancelAnimationFrame(frame);resize.disconnect();changes.disconnect();};
 },[rail,active]);
}
