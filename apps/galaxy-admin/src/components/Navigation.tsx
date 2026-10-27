'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {usePathname,useSearchParams} from 'next/navigation';
import {useAuth} from '@payloadcms/ui';
import {Brand} from './Brand';
import {AdminNavigationMotion,AdminNavigationPending} from './AdminNavigationMotion';
import {SignOut} from './SignOut';
import {AdminIcon} from './AdminIcons';
import type {AdminIconName} from './AdminIcons';
import type {OperatorUser} from '../lib/access';
import {useActiveNavigation} from './use-active-navigation';
import './operations.css';

export type AdminArea='workbench'|'users'|'governance'|'content'|'messages'|'analytics'|'strategy'|'permissions'|'settings'|'maintenance';
type NavigationItem={id:AdminArea;label:string;icon:AdminIconName;href?:string};
export const adminNavigation:readonly NavigationItem[]=[
  {id:'workbench',label:'工作台',icon:'workspace',href:'/admin'},
  {id:'users',label:'用户与账户',icon:'users',href:'/admin/operations/users'},
  {id:'governance',label:'社区治理',icon:'governance',href:'/admin/operations/community?tab=reports'},
  {id:'content',label:'内容与发现',icon:'content',href:'/admin/operations/community'},
  {id:'messages',label:'公告与消息',icon:'messages',href:'/admin/operations/messaging'},
  {id:'analytics',label:'数据分析',icon:'analytics',href:'/admin/operations/analytics'},
  {id:'strategy',label:'策略与AI',icon:'strategy',href:'/admin/operations/autonomy'},
  {id:'permissions',label:'权限与审计',icon:'permissions',href:'/admin/operations/permissions?tab=roles'},
  {id:'settings',label:'系统设置',icon:'settings',href:'/admin/operations/system-settings'},
  {id:'maintenance',label:'系统维护',icon:'maintenance',href:'/admin/operations/maintenance'},
];

export function currentAdminArea(pathname:string,tab:string|null):AdminArea{
  if(pathname==='/admin/operations/system-settings')return 'settings';
  if(pathname.startsWith('/admin/operations/smtp'))return 'settings';
  if(['/admin/operations/users','/admin/operations/management-accounts','/admin/operations/ai-work-accounts'].some(path=>pathname.startsWith(path)))return 'users';
  if(pathname.startsWith('/admin/operations/community'))return tab==='reports'?'governance':'content';
  if(['/admin/operations/recommendation','/admin/operations/search-quality'].some(path=>pathname.startsWith(path)))return 'content';
  if(['/admin/operations/chat-reports','/admin/operations/resources','/admin/operations/files','/admin/operations/feedback'].some(path=>pathname.startsWith(path)))return 'governance';
  if(['/admin/operations/messaging','/admin/operations/notices'].some(path=>pathname.startsWith(path)))return 'messages';
  if(pathname.startsWith('/admin/operations/permissions')||pathname.startsWith('/admin/operations/audit')||pathname.startsWith('/admin/collections/operators')||pathname==='/admin/account')return 'permissions';
  if(['/admin/operations/maintenance','/admin/operations/jobs','/admin/operations/search-recovery','/admin/operations/retention'].some(path=>pathname.startsWith(path)))return 'maintenance';
  if(pathname==='/admin/operations/analytics')return 'analytics';
  if(pathname==='/admin/operations/autonomy'||pathname==='/admin/operations/strategy'||pathname.startsWith('/admin/operations/rules')||pathname.startsWith('/admin/operations/ai-runs')||pathname==='/admin/operations/models')return 'strategy';
  if(pathname.startsWith('/admin/globals/')||pathname.startsWith('/admin/collections/')||pathname==='/admin/site-publication')return 'settings';
  return 'workbench';
}

export function Navigation(){
  const pathname=usePathname(),search=useSearchParams(),{user}=useAuth<OperatorUser>();
  const [query,setQuery]=useState(()=>pathname.startsWith('/admin/operations/users')?search.get('query')??'':'');
  const searchLink=useRef<HTMLAnchorElement>(null);
  const [searchIntent,setSearchIntent]=useState<{query:string}|null>(null);
  const searchHref='/admin/operations/users?'+new URLSearchParams({query:searchIntent?.query??query}).toString();
  // Preserve native typing before hydration. Submit reads the actual form and
  // waits for the matching Link props to commit, keeping the shared leave guard.
  useEffect(()=>{if(searchIntent&&searchLink.current){searchLink.current.click();setSearchIntent(null);}},[searchIntent]);
  const active=currentAdminArea(pathname,search.get('tab'));
  const rail=useActiveNavigation(active,'both');
  const name=user?.displayName?.trim()||'管理账户';
  const role=user?.role==='administrator'?'运营管理员':user?.role==='reader'?'运营成员':'管理账户';
  if(!user||pathname==='/admin/login')return null;
  return <>
    <AdminNavigationMotion/>
    <a className="galaxy-admin-skip" href="#galaxy-admin-main" onClick={event=>{const target=document.getElementById('galaxy-admin-main')??document.querySelector<HTMLElement>('.template-default__wrap');if(target){event.preventDefault();target.tabIndex=-1;target.focus();}}}>跳到主要内容</a>
    <header className="galaxy-admin-topbar">
      <Link href="/admin" className="galaxy-admin-home" prefetch={false}><Brand/><AdminNavigationPending/></Link>
      <span className="galaxy-admin-location">{adminNavigation.find(item=>item.id===active)?.label}</span>
      <form className="galaxy-admin-search" action="/admin/operations/users" role="search" onSubmit={event=>{if(searchLink.current){event.preventDefault();const value=new FormData(event.currentTarget).get('query');const submitted=typeof value==='string'?value:'';setQuery(submitted);setSearchIntent({query:submitted});}}}>
        <AdminIcon name="search" size={18}/><input aria-label="查找用户、UID或邮箱" name="query" type="search" maxLength={200} placeholder="查找用户、UID或邮箱" defaultValue={query} onChange={event=>setQuery(event.target.value)}/><button type="submit">查找</button>
        {/* Keep soft navigation behind the existing document-level anchor leave guard. */}
        <Link ref={searchLink} href={searchHref} prefetch={false} hidden aria-hidden="true" tabIndex={-1}>查找用户</Link>
      </form>
      <Link className="galaxy-admin-operator" href="/admin/account" prefetch={false} aria-label={'管理账户：'+name}>
        <span className="galaxy-admin-avatar" aria-hidden="true">{name.slice(0,1)}</span><span><strong>{name}</strong><small>{role}</small></span>
      </Link>
      <SignOut/>
    </header>
    <aside ref={rail} className="galaxy-admin-sidebar">
      <nav className="galaxy-admin-navigation" aria-label="运营导航">
        {adminNavigation.map(item=>item.href?<Link key={item.id} href={item.href} prefetch={false} aria-current={active===item.id?'page':undefined}><AdminIcon name={item.icon}/><span>{item.label}</span><AdminNavigationPending/></Link>:<span key={item.id} className="galaxy-admin-navigation-unavailable" aria-disabled="true"><AdminIcon name={item.icon}/><span>{item.label}</span><small>未接入</small></span>)}
      </nav>
    </aside>
  </>;
}
