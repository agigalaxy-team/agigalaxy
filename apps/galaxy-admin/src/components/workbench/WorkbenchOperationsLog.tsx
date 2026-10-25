'use client';

import Link from 'next/link';
import {AdminTabs} from '../AdminTabs';
import {useWorkbenchInteraction} from './WorkbenchInteraction';
import {workbenchTime,type WorkbenchRecord} from '../../lib/workbench-view-model';
import type {AutonomyTask} from '../autonomy-types';
import {autonomyDomains,autonomyStates,autonomyTaskHref,autonomyTaskTitle} from '../../lib/autonomy-view-model';

export function WorkbenchOperationsLog({records,available,loading,aiState,denied=false,aiDenied=false,aiTasks=[]}:{records:WorkbenchRecord[];available:boolean;loading:boolean;aiState:'connected'|'not-connected'|'unavailable'|'loading';denied?:boolean;aiDenied?:boolean;aiTasks?:AutonomyTask[]}){
  const {source,setSource,setActionsTarget}=useWorkbenchInteraction();
  const ended=aiTasks.filter(task=>!['running','queued','waiting-human','awaiting-human'].includes(task.state));
  return <section className="wb-operation-log"><header className="wb-section-heading"><h2>最近处理记录</h2>{source!=='actions'&&!(source==='ai'?aiDenied:denied)&&<Link prefetch={false} href={source==='ai'?'/admin/operations/ai-runs':'/admin/operations/audit'} className="wb-text-link">全部记录</Link>}</header><AdminTabs items={[{id:'actions',label:'AI操作'},{id:'ai',label:'AI处理日志'},{id:'operations',label:'业务处理'}]} active={source} onChange={setSource} ariaLabel="处理记录来源" className="wb-log-tabs"/>
    <div className="wb-actions-pane" hidden={source!=='actions'} role="region" aria-label="AI操作记录"><div className="wb-actions-mount" ref={setActionsTarget}/></div>
    <div hidden={source==='actions'} className="wb-operation-log-scroll" tabIndex={0} role="region" aria-label={source==='operations'?'最近管理操作':'AI处理日志'}>{source==='ai'?aiDenied?<p className="wb-inline-empty">没有任务与运行的查看权限。</p>:ended.length?<ul className="wb-ai-log-records">{ended.map(task=><li key={task.id}><Link prefetch={false} href={autonomyTaskHref(task)}><span className="wb-ai-log-summary"><strong>{autonomyTaskTitle(task)}</strong><span>{autonomyStates[task.state]??'状态待核对'}</span></span><span className="wb-ai-log-meta"><span>{autonomyDomains[task.domain]}</span><time dateTime={task.updatedAt}>{workbenchTime(task.updatedAt)}</time></span></Link></li>)}</ul>:<p className="wb-inline-empty">{loading?'正在读取处理记录':aiState==='unavailable'?'运行记录暂时无法取得':'近期暂无已结束的任务。'}</p>:denied?<p className="wb-inline-empty">没有业务审计的查看权限。</p>:records.length?<table><thead><tr><th scope="col">时间</th><th scope="col">来源</th><th scope="col">处理</th></tr></thead><tbody>{records.map(record=><tr key={record.id}><td><time dateTime={record.createdAt}>{workbenchTime(record.createdAt)}</time></td><td>{record.source}</td><td><Link prefetch={false} href={record.href}>{record.label}</Link></td></tr>)}</tbody></table>:<p className="wb-inline-empty">{available?'暂无处理记录':loading?'正在读取处理记录':'处理记录暂时无法取得'}</p>}</div>
  </section>;
}
