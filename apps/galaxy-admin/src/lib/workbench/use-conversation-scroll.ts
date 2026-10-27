'use client';
import {observeBottomFollow} from '../../../../../packages/galaxy-web/src/shared/reading/bottom-follow';
import {useCallback,useLayoutEffect,useRef,useState,type RefObject} from 'react';

type Position={top:number;follow:boolean};
/** Scroll state belongs to the reader, not to each arriving token or snapshot. */
export function useConversationScroll({viewport,content,scope,enabled,positions}:{viewport:RefObject<HTMLDivElement|null>;content:RefObject<HTMLDivElement|null>;scope:string;enabled:boolean;positions:RefObject<Record<string,Position>>}){
 const follow=useRef(true),scopeRef=useRef(scope),frame=useRef(0),programmatic=useRef(false),[following,setFollowing]=useState(true);
 const bottom=useCallback(()=>{const node=viewport.current;if(!node)return;programmatic.current=true;node.scrollTop=node.scrollHeight;positions.current[scopeRef.current]={top:node.scrollTop,follow:true};programmatic.current=false;},[viewport,positions]);
 const schedule=useCallback(()=>{cancelAnimationFrame(frame.current);frame.current=requestAnimationFrame(()=>{if(follow.current)bottom();});},[bottom]);
 const jumpToLatest=useCallback(()=>{follow.current=true;setFollowing(true);bottom();schedule();},[bottom,schedule]);
 useLayoutEffect(()=>{
  scopeRef.current=scope;const node=viewport.current;if(!enabled||!node)return;
  const saved=positions.current[scope];follow.current=saved?.follow??true;setFollowing(follow.current);
  if(follow.current)bottom();else node.scrollTop=saved?.top??0;
  let intentUntil=0,dragging=false;
  const intent=()=>{intentUntil=performance.now()+350;};
  const pointer=()=>{dragging=true;intent();},release=()=>{dragging=false;};
  const scroll=()=>{
   if(programmatic.current)return;
   const near=node.scrollHeight-node.clientHeight-node.scrollTop<=40;
   // Resize/Markdown reflow must not silently cancel an existing bottom lock.
   if(dragging||performance.now()<intentUntil){follow.current=near;setFollowing(near);}
   positions.current[scope]={top:node.scrollTop,follow:follow.current};
  };
  const key=(event:KeyboardEvent)=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))intent();};
  const stopResize=observeBottomFollow(node,content.current,()=>follow.current,bottom);
  node.addEventListener('wheel',intent,{passive:true});node.addEventListener('touchmove',intent,{passive:true});node.addEventListener('pointerdown',pointer);window.addEventListener('pointerup',release);node.addEventListener('keydown',key);node.addEventListener('scroll',scroll,{passive:true});schedule();
  return()=>{cancelAnimationFrame(frame.current);stopResize();node.removeEventListener('wheel',intent);node.removeEventListener('touchmove',intent);node.removeEventListener('pointerdown',pointer);window.removeEventListener('pointerup',release);node.removeEventListener('keydown',key);node.removeEventListener('scroll',scroll);};
 },[scope,enabled,viewport,content,positions,bottom,schedule]);
 useLayoutEffect(()=>{if(enabled&&follow.current)bottom();});
 return {following,jumpToLatest};
}
