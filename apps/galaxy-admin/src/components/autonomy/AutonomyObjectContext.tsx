'use client';
import Link from 'next/link';
import {useOperationsRead} from "../../lib/use-operations-read";
import {useOperationsPageAccess} from "../OperationsPageAccess";
import {AutonomyTaskControls} from './AutonomyTaskControls';
import {AutonomyState} from './AutonomyShared';
import type {AutonomyTasksPage} from './autonomy-types';
import {autonomyBase,autonomyTaskHref,autonomyTaskTitle,autonomyStates,autonomyModes,autonomyTaskTone,autonomyBusinessStates} from "../../lib/autonomy/autonomy-view-model";
import './autonomy-object.css';

/** The owning business page stays primary; only actual linked tasks appear. */
export function AutonomyObjectContext({targetType,targetId,csrfToken,onChanged}:{targetType:string;targetId:string|null|undefined;csrfToken:string;onChanged?:()=>unknown|Promise<unknown>}){
 const permissions=useOperationsPageAccess(),allowed=permissions.includes('autonomy.read');
 const query=new URLSearchParams({targetType,targetId:targetId??'',limit:'5',page:'1'});
 const current=useOperationsRead<AutonomyTasksPage>({path:allowed&&targetId?autonomyBase+'/tasks?'+query:null,clearOnOffline:true,failureMessage:'关联处理记录暂时无法读取。'});
 const changed=async()=>{await current.read();await onChanged?.();};
 if(!allowed||!current.verified||!current.value?.items.length)return null;
 return <section className="auto-object-context" aria-label="关联自动处理"><header><h3>关联处理</h3><Link href="/admin/operations/ai-runs" prefetch={false}>任务与运行</Link></header>{current.value.items.map(task=><article key={task.id}><div><Link href={autonomyTaskHref(task)} prefetch={false}>{autonomyTaskTitle(task)}</Link><span>{autonomyModes[task.mode]} · {task.businessState?autonomyBusinessStates[task.businessState]??'结果待核对':'尚未办理'}</span>{task.strategyVersionId&&<small>采用已绑定策略版本</small>}</div><AutonomyState tone={autonomyTaskTone(task)}>{autonomyStates[task.state]??'状态待核对'}</AutonomyState><AutonomyTaskControls task={task} csrfToken={csrfToken} onChanged={changed}/>{task.workbenchHref==='/admin?taskId='+task.id&&<Link href={task.workbenchHref} prefetch={false}>到工作台接续</Link>}</article>)}</section>;
}
