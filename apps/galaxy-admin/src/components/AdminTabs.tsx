'use client';

import type {KeyboardEvent,ReactNode} from 'react';
import Link from 'next/link';
import {useActiveNavigation} from './use-active-navigation';
import {AdminNavigationPending} from './AdminNavigationMotion';
import './operations.css';

export type AdminTabItem={id:string;label:ReactNode;href?:string;disabled?:boolean;panelId?:string};
export type AdminTabsProps={items:readonly AdminTabItem[];active:string;onChange?:(id:string)=>void;ariaLabel?:string;className?:string};

export function AdminTabs({items,active,onChange,ariaLabel='页面选项',className}:AdminTabsProps){
  const rail=useActiveNavigation(active);
  const inPage=!!onChange&&items.every(item=>!item.href);
  function handleKeys(event:KeyboardEvent<HTMLButtonElement>){
    const keys=['ArrowLeft','ArrowRight','Home','End'];
    if(!inPage||!keys.includes(event.key))return;
    const enabled=items.filter(item=>!item.disabled);
    if(!enabled.length)return;
    const index=enabled.findIndex(item=>item.id===event.currentTarget.dataset.tabId);
    const next=event.key==='Home'?0:event.key==='End'?enabled.length-1:(index+(event.key==='ArrowRight'?1:-1)+enabled.length)%enabled.length;
    event.preventDefault();
    const item=enabled[next];
    onChange?.(item.id);
    const buttons=event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[data-tab-id]');
    buttons?.forEach(button=>{if(button.dataset.tabId===item.id)button.focus({preventScroll:true});});
  }
  const first=items.find(item=>!item.disabled)?.id;
  const selected=items.some(item=>item.id===active&&!item.disabled)?active:first;
  return <nav ref={rail} className={['galaxy-admin-tabs',className].filter(Boolean).join(' ')} aria-label={ariaLabel} role={inPage?'tablist':undefined}>
    {items.map(item=>item.disabled?<span key={item.id} className="galaxy-admin-tab" aria-disabled="true">{item.label}</span>:item.href?<Link key={item.id} className="galaxy-admin-tab" href={item.href} prefetch={false} aria-current={active===item.id?'page':undefined}>{item.label}<AdminNavigationPending/></Link>:<button key={item.id} className="galaxy-admin-tab" type="button" data-tab-id={item.id} role={inPage?'tab':undefined} aria-selected={inPage?active===item.id:undefined} aria-controls={item.panelId} tabIndex={inPage&&selected!==item.id?-1:0} onKeyDown={handleKeys} onClick={()=>onChange?.(item.id)}>{item.label}</button>)}
  </nav>;
}
