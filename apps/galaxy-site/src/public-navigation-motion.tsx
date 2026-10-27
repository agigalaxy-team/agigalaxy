'use client';
import {useLayoutEffect,useRef} from 'react';
import {usePathname} from 'next/navigation';
import {animateContent} from '../../../packages/galaxy-web/src/shared/feedback/content-motion';

/** Public server-rendered pages use the same motion as the workspace, with one owner. */
export function PublicNavigationMotion(){
 const pathname=usePathname(),previous=useRef(pathname);
 useLayoutEffect(()=>{
  const old=previous.current;previous.current=pathname;
  if(old===pathname||pathname==='/app'||pathname.startsWith('/app/'))return;
  return animateContent(document.querySelector<HTMLElement>('main.home-shell,main.public-content'));
 },[pathname]);
 return null;
}
