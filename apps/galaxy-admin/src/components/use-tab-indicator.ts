'use client';
import {useLayoutEffect,type RefObject} from 'react';

export function useTabIndicator(rail:RefObject<HTMLElement|null>,active:string){
 useLayoutEffect(()=>{
  const node=rail.current;if(!node)return;let frame=0;
  const measure=()=>{
   const item=node.querySelector<HTMLElement>('[aria-selected="true"],[aria-current="page"]');
   if(!item){delete node.dataset.indicatorReady;return;}
   const bounds=item.getBoundingClientRect(),parent=node.getBoundingClientRect();
   node.style.setProperty('--tab-marker-x',String(bounds.left-parent.left+node.scrollLeft)+'px');node.style.setProperty('--tab-marker-width',String(bounds.width)+'px');node.dataset.indicatorReady='true';
   frame=requestAnimationFrame(()=>{node.dataset.indicatorLive='true';});
  };
  const observer=new ResizeObserver(measure);observer.observe(node);for(const child of node.querySelectorAll<HTMLElement>('.galaxy-admin-tab'))observer.observe(child);measure();
  return()=>{cancelAnimationFrame(frame);observer.disconnect();};
 },[rail,active]);
}
