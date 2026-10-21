'use client';
import {useEffect} from 'react';
import Link from 'next/link';
import {useOperationsRead} from '../lib/use-operations-read';
import {queueLabels} from './operations-task-types';
import type {OperationQueue} from './operations-task-types';
import {ReadStatus} from './OperationControls';
export type OperationsSummary={communityReports:{pending:number;total:number};chatReports:{pending:number;total:number};sections:{active:number;archived:number};resources:{projects:number;methods:number};files:{scanPending:number;scanFailed:number;cleanupPending:number;cleanupFailed:number};jobs:{failed:number;byQueue:{queue:string;state:string;count:number}[]};search:{failed:number};checkedAt:number;readExpiresAt:number};
export function OperationsDashboard({initial,initialError}:{initial:OperationsSummary|null;initialError:string}){
  const page=useOperationsRead<OperationsSummary>({path:'/v1/operations/summary',initial,initialError,failureMessage:'待处理事项暂时无法取得。'}),value=page.value;
  useEffect(()=>{if(page.loading)return;const timer=setTimeout(()=>{if(navigator.onLine&&document.visibilityState==='visible')void page.read();},30000);return()=>clearTimeout(timer);},[page.loading,page.read,page.value]);
  return <section className="galaxy-operator-dashboard"><header><h1>运营工作台</h1>{value&&!page.error&&<small>更新于 {new Date(value.checkedAt*1000).toLocaleTimeString('zh-CN')}</small>}</header><ReadStatus loading={page.loading} error={page.error} retry={page.read}/>{value&&!page.error&&<div className="galaxy-dashboard-regions">
    <section className="galaxy-dashboard-region"><h2>社区举报</h2><p className="galaxy-dashboard-count">{value.communityReports.pending} <small>待处理</small></p><p><Link href="/admin/operations/community?tab=reports&state=pending">处理社区举报</Link></p><p><Link href="/admin/operations/community">维护版块归类</Link> · {value.sections.active} 个活动版块</p></section>
    <section className="galaxy-dashboard-region"><h2>私聊举报</h2><p className="galaxy-dashboard-count">{value.chatReports.pending} <small>待处理</small></p><p><Link href="/admin/operations/chat-reports">查看举报与选定材料</Link></p></section>
    <section className="galaxy-dashboard-region"><h2>文件处理</h2><dl className="galaxy-operational-facts"><dt>等待扫描</dt><dd>{value.files.scanPending}</dd><dt>扫描异常</dt><dd>{value.files.scanFailed}</dd><dt>等待清理</dt><dd>{value.files.cleanupPending}</dd><dt>清理异常</dt><dd>{value.files.cleanupFailed}</dd></dl><p><Link href="/admin/operations/files?processing=scan">查看扫描</Link> · <Link href="/admin/operations/files?processing=cleanup">查看清理</Link></p></section>
    <section className="galaxy-dashboard-region"><h2>任务与检索</h2><dl className="galaxy-operational-facts"><dt>失败任务</dt><dd>{value.jobs.failed}</dd><dt>检索失败</dt><dd>{value.search.failed}</dd></dl><p><Link href="/admin/operations/jobs">持续任务</Link> · <Link href="/admin/operations/search-recovery">检索恢复</Link></p>{value.jobs.byQueue.filter(item=>item.state==='failed'&&item.count>0).map(item=><p key={item.queue}><Link href={'/admin/operations/jobs?queue='+encodeURIComponent(item.queue)}>{queueLabels[item.queue as OperationQueue]??item.queue}</Link>：{item.count} 条失败</p>)}</section>
    <section className="galaxy-dashboard-region"><h2>用户与内容</h2><p><Link href="/admin/operations/users">查找用户与当前限制</Link></p><p><Link href="/admin/operations/resources?kind=projects&state=active">{value.resources.projects} 个活动项目</Link> · <Link href="/admin/operations/resources?kind=methods">{value.resources.methods} 个方法</Link></p></section>
    <section className="galaxy-dashboard-region"><h2>运营与记录</h2><p><Link href="/admin/operations/notices">服务通知</Link> · <Link href="/admin/operations/rules">运营规则</Link></p><p><Link href="/admin/operations/retention">到期清理</Link> · <Link href="/admin/operations/audit">操作审计</Link></p></section>
  </div>}</section>;
}
