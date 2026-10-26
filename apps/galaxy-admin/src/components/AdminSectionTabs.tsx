'use client';

import {usePathname,useSearchParams} from 'next/navigation';
import {AdminTabs} from './AdminTabs';
import type {AdminTabItem} from './AdminTabs';
import {adminNavigation,currentAdminArea} from './Navigation';
import type {AdminArea} from './Navigation';
import {maintenanceHref,maintenanceLocation,maintenanceTabs} from '../lib/maintenance-view-model';
import {systemSettingsHref,systemSettingsLocation,systemSettingsTabs} from "../lib/system-settings/system-settings-view-model";

const sectionItems:Partial<Record<AdminArea,readonly AdminTabItem[]>>={
  users:[
    {id:'users',label:'用户账户',href:'/admin/operations/users'},
    {id:'management-accounts',label:'管理账户',href:'/admin/operations/management-accounts'},
    {id:'ai-accounts',label:'AI工作账户',href:'/admin/operations/ai-work-accounts'},
  ],
  governance:[
    {id:'reports',label:'举报与申诉',href:'/admin/operations/community?tab=reports'},
    {id:'chat-reports',label:'私聊举报',href:'/admin/operations/chat-reports'},
    {id:'resources',label:'项目与方法',href:'/admin/operations/resources'},
    {id:'files',label:'文件处理',href:'/admin/operations/files'},
    {id:'feedback',label:'使用反馈',href:'/admin/operations/feedback'},
  ],
  content:[
    {id:'sections',label:'版块与分类',href:'/admin/operations/community'},
    {id:'posts',label:'公开内容',href:'/admin/operations/community?tab=posts'},
    {id:'recommendation',label:'推荐运营',href:'/admin/operations/recommendation'},
    {id:'search-quality',label:'搜索质量',href:'/admin/operations/search-quality'},
  ],
  messages:[
    {id:'messaging',label:'消息计划',href:'/admin/operations/messaging'},
    {id:'notices',label:'站内信记录',href:'/admin/operations/notices'},
  ],
  strategy:[
    {id:'autonomy',label:'自动运行',href:'/admin/operations/autonomy'},
    {id:'strategy',label:'目标与策略',href:'/admin/operations/strategy'},
    {id:'rules',label:'业务规则',href:'/admin/operations/rules'},
    {id:'ai-runs',label:'任务与运行',href:'/admin/operations/ai-runs'},
    {id:'models',label:'模型与用量',href:'/admin/operations/models'},
  ],
  analytics:[
    {id:'analytics',label:'核心使用分析',href:'/admin/operations/analytics'},
  ],
  maintenance:[
    {id:'jobs',label:'运行任务',href:'/admin/operations/jobs'},
    {id:'search-recovery',label:'检索维护',href:'/admin/operations/search-recovery'},
    {id:'retention',label:'到期清理',href:'/admin/operations/retention'},
  ],
  permissions:[
    {id:'roles',label:'业务角色',href:'/admin/operations/permissions?tab=roles'},
    {id:'personnel',label:'人员授权',href:'/admin/operations/permissions?tab=personnel'},
    {id:'automatic',label:'自动执行授权',href:'/admin/operations/permissions?tab=automatic'},
    {id:'audit',label:'业务审计',href:'/admin/operations/audit'},
  ],
  settings:[
    {id:'site-settings',label:'站点设置',href:'/admin/globals/site-settings'},
    {id:'site-pages',label:'页面内容',href:'/admin/collections/site-pages'},
    {id:'media',label:'媒体',href:'/admin/collections/media'},
    {id:'publication',label:'官网发布',href:'/admin/site-publication'},
  ],
};

export function AdminSectionTabs(){
  const pathname=usePathname(),search=useSearchParams();
  const area=currentAdminArea(pathname,search.get('tab')),maintenance=pathname==='/admin/operations/maintenance'?maintenanceLocation(Object.fromEntries(search)):null;
  const system=pathname==='/admin/operations/system-settings'?systemSettingsLocation(Object.fromEntries(search)):null;
  const items=system?systemSettingsTabs.map(item=>({...item,href:systemSettingsHref(system,{tab:item.id})})):maintenance?maintenanceTabs.map(item=>({...item,href:maintenanceHref(maintenance,{tab:item.id})})):sectionItems[area];
  if(!items)return null;
  const active=system?system.tab:area==='users'?(pathname.startsWith('/admin/operations/ai-work-accounts')?'ai-accounts':pathname.startsWith('/admin/operations/management-accounts')?'management-accounts':'users')
    :area==='content'?(pathname.startsWith('/admin/operations/search-quality')?'search-quality':pathname.startsWith('/admin/operations/recommendation')?'recommendation':search.get('tab')==='posts'?'posts':'sections')
    :area==='governance'?(pathname.startsWith('/admin/operations/community')?'reports':pathname.split('/').at(-1)??'reports')
    :area==='messages'?pathname.split('/').at(-1)??'messaging'
    :area==='strategy'?(pathname==='/admin/operations/autonomy'?'autonomy':pathname.startsWith('/admin/operations/rules')?'rules':pathname==='/admin/operations/models'?'models':pathname==='/admin/operations/strategy'?'strategy':'ai-runs')
    :area==='analytics'?'analytics'
    :area==='maintenance'?maintenance?.tab??pathname.split('/').at(-1)??'jobs'
    :area==='permissions'?(pathname.startsWith('/admin/operations/permissions')?(['personnel','automatic'].includes(search.get('tab')??'')?search.get('tab')!:'roles'):'audit')
    :pathname==='/admin/site-publication'?'publication':pathname.split('/').at(-1)??'rules';
  return <AdminTabs items={items} active={active} ariaLabel={(adminNavigation.find(item=>item.id===area)?.label??'运营')+'栏目'} className="galaxy-admin-section-tabs"/>;
}
