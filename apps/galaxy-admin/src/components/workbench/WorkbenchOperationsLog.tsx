'use client';

import {useId} from 'react';
import Link from 'next/link';
import {AdminIcon,type AdminIconName} from '../AdminIcons';
import {AdminTabs} from '../AdminTabs';
import {useWorkbenchInteraction} from './WorkbenchInteraction';
import {workbenchTime,type WorkbenchRecord} from "../../lib/workbench/workbench-view-model";
import type {AutonomyTask} from "../autonomy/autonomy-types";
import {autonomyDomains,autonomyStates,autonomyTaskHref,autonomyTaskTitle} from "../../lib/autonomy/autonomy-view-model";
import './workbench-records.css';

function RecordLink({title,href,source,createdAt,icon,state}:{title:string;href:string;source:string;createdAt:string;icon:AdminIconName;state?:string}){
 return <li><Link prefetch={false} href={href} className="wb-record-link"><span className="wb-record-icon" aria-hidden="true"><AdminIcon name={icon} size={16}/></span><span className="wb-record-content"><span className="wb-record-heading"><strong title={title}>{title}</strong>{state&&<span className="wb-record-state">{state}</span>}</span><span className="wb-record-meta"><span>{source}</span><time dateTime={createdAt}>{workbenchTime(createdAt)}</time></span></span></Link></li>;
}

export function WorkbenchOperationsLog({records,available,loading,aiState,denied=false,aiDenied=false,aiTasks=[]}:{records:WorkbenchRecord[];available:boolean;loading:boolean;aiState:'connected'|'not-connected'|'unavailable'|'loading';denied?:boolean;aiDenied?:boolean;aiTasks?:AutonomyTask[]}){
 const {source,setSource,setActionsTarget}=useWorkbenchInteraction(),id=useId();
 const loggedTasks=aiTasks.filter(task=>!['running','queued','waiting-human','awaiting-human'].includes(task.state));
 return <section className="wb-operation-log"><header className="wb-section-heading"><h2>最近处理记录</h2>{source!=='actions'&&!(source==='ai'?aiDenied:denied)&&<Link prefetch={false} href={source==='ai'?'/admin/operations/ai-runs':'/admin/operations/audit'} className="wb-text-link">全部记录</Link>}</header><AdminTabs items={[{id:'actions',label:'AI操作',panelId:id+'-actions'},{id:'ai',label:'AI处理日志',panelId:id+'-ai'},{id:'operations',label:'业务处理',panelId:id+'-operations'}]} active={source} onChange={setSource} ariaLabel="处理记录来源" className="wb-log-tabs"/>
  <div id={id+'-actions'} className="wb-actions-pane" hidden={source!=='actions'} role="tabpanel" aria-label="AI操作记录"><div className="wb-actions-mount" ref={setActionsTarget}/></div>
  <div id={id+'-ai'} hidden={source!=='ai'} className="wb-record-panel" role="tabpanel" aria-label="AI处理日志"><div className="wb-record-caption"><span>任务记录</span>{!aiDenied&&<span>{loggedTasks.length} 条</span>}</div><div className="wb-operation-log-scroll" tabIndex={0} role="region" aria-label="AI处理日志列表">{aiDenied?<p className="wb-inline-empty">没有任务与运行的查看权限。</p>:loggedTasks.length?<ul className="wb-record-list">{loggedTasks.map(task=><RecordLink key={task.id} title={autonomyTaskTitle(task)} href={autonomyTaskHref(task)} source={autonomyDomains[task.domain]} createdAt={task.updatedAt} state={autonomyStates[task.state]??'状态待核对'} icon="activity"/>)}</ul>:<p className="wb-inline-empty">{loading?'正在读取处理记录':aiState==='unavailable'?'运行记录暂时无法取得':'近期暂无可显示的任务记录。'}</p>}</div></div>
  <div id={id+'-operations'} hidden={source!=='operations'} className="wb-record-panel" role="tabpanel" aria-label="业务处理"><div className="wb-record-caption"><span>最近管理操作</span>{!denied&&available&&<span>{records.length} 条</span>}</div><div className="wb-operation-log-scroll" tabIndex={0} role="region" aria-label="业务处理列表">{denied?<p className="wb-inline-empty">没有业务审计的查看权限。</p>:records.length?<ul className="wb-record-list">{records.map(record=><RecordLink key={record.id} title={record.label} href={record.href} source={record.source} createdAt={record.createdAt} icon="history"/>)}</ul>:<p className="wb-inline-empty">{available?'暂无处理记录':loading?'正在读取处理记录':'处理记录暂时无法取得'}</p>}</div></div>
 </section>;
}
