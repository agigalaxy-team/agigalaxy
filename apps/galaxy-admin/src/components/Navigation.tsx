'use client';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {Brand} from './Brand';
import {SignOut} from './SignOut';
import './operations.css';
const groups=[
  {label:'用户与权限',links:[['/admin/operations/users','用户管理']]},
  {label:'社区治理',links:[['/admin/operations/community','版块与举报'],['/admin/operations/chat-reports','私聊举报']]},
  {label:'项目与资料',links:[['/admin/operations/resources','项目与方法'],['/admin/operations/files','文件处理']]},
  {label:'通知与规则',links:[['/admin/operations/notices','服务通知'],['/admin/operations/rules','运营规则']]},
  {label:'运行与审计',links:[['/admin/operations/jobs','持续任务'],['/admin/operations/search-recovery','检索恢复'],['/admin/operations/retention','到期清理'],['/admin/operations/audit','操作审计']]},
];
export function Navigation(){const pathname=usePathname();return <aside className="galaxy-admin-sidebar"><Link href="/admin" className="galaxy-admin-home"><Brand/></Link><nav className="galaxy-admin-navigation" aria-label="运营导航"><Link href="/admin" aria-current={pathname==='/admin'?'page':undefined}>工作台</Link>{groups.map(group=><section className="galaxy-navigation-group" key={group.label}><h2>{group.label}</h2>{group.links.map(([href,label])=><Link key={href} href={href} aria-current={pathname===href||pathname.startsWith(href+'/')?'page':undefined}>{label}</Link>)}</section>)}</nav><SignOut/></aside>;}
