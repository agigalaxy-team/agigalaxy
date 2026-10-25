'use client';
import {useCallback} from 'react';
import {CommandFeedback} from './OperationControls';
import {useAutonomyCommand} from '../lib/use-autonomy-command';
import {autonomyBase} from '../lib/autonomy-view-model';
import type {AutonomyControl,AutonomyControlSave,AutonomyTask,AutonomyHumanDecision} from './autonomy-types';
import './autonomy.css';

const labels:Record<AutonomyControl,string>={pause:'暂停任务',resume:'沿原任务继续',stop:'停止任务',takeover:'人工接管',reconcile:'核对原结果'};
const decisionLabels:Record<AutonomyHumanDecision,string>={rejected:'拒绝这项请求',cancelled:'取消这项请求','no-action':'本项无需办理'};
type Props={task:AutonomyTask;csrfToken:string;onChanged:(task?:AutonomyTask)=>void|Promise<void>};
export function AutonomyTaskControls(props:Props){return <TaskControls key={props.task.id} {...props}/>;}
function TaskControls({task,csrfToken,onChanged}:Props){
 const completed=useCallback(async(value:AutonomyControlSave)=>{await onChanged(value.task);},[onChanged]);
 const command=useAutonomyCommand<AutonomyControlSave>({csrfToken,canWrite:task.availableControls.length>0,onCommitted:completed,onConflict:()=>void onChanged()});
 const pending=task.availableControls.length>0&&task.state==='waiting-human'&&task.source!=='workbench'&&task.humanDecision?.kind!=='takeover'?(task.pendingCalls??[]).filter(call=>!task.continuation?.decisions.some(decision=>decision.callId===call.callId)):[];
 return <>{pending.length>0&&<section className="auto-task-feedback"><h3>待人工决定</h3>{pending.map((call,index)=><div className="auto-pending-call" key={call.callId}><p>请求 {index+1} · {call.tool==='manage-ai-role'?'AI 角色管理':call.tool==='execute-operation'?'业务办理':call.tool==='prepare-operation'?'准备业务处理':'待人工处理'}</p><div className="auto-task-controls">{(Object.keys(decisionLabels) as AutonomyHumanDecision[]).map(decision=><button type="button" key={decision} disabled={command.locked} onClick={()=>void command.submit(autonomyBase+'/tasks/'+encodeURIComponent(task.id)+'/decisions',{expectedRevision:task.revision,callId:call.callId,decision},decision==='rejected'?'人工拒绝已记录。':decision==='cancelled'?'人工取消已记录。':'无需办理的决定已记录。')}>{decisionLabels[decision]}</button>)}</div></div>)}</section>}<div className="auto-task-controls">{task.availableControls.map(kind=><button key={kind} type="button" disabled={command.locked} onClick={()=>void command.submit(autonomyBase+'/tasks/'+encodeURIComponent(task.id)+'/control',{expectedRevision:task.revision,kind},kind==='takeover'?'已由人工接管。':kind==='stop'?'任务已停止。':kind==='pause'?'任务已暂停。':kind==='resume'?'已沿原任务接续。':'正在核对原结果。')}>{labels[kind]}</button>)}</div><CommandFeedback command={command}/></>;
}
