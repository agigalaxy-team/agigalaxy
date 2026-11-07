'use client';

import {useCallback,useRef,useState} from 'react';
import {CommandFeedback} from '../OperationControls';
import {ActionCardDetails} from '../workbench/WorkbenchActionCards';
import {useAutonomyCommand} from '../../lib/autonomy/use-autonomy-command';
import {autonomyBase} from '../../lib/autonomy/autonomy-view-model';
import {communityParameterAreas,communityParameterKind,readCommunityParameterReceipt,type CommunityParameterProposal} from '../../lib/community-parameters';
import type {AutonomyControl,AutonomyControlSave,AutonomyTask,AutonomyHumanDecision} from './autonomy-types';
import './autonomy.css';

const labels:Record<AutonomyControl,string>={pause:'暂停任务',resume:'沿原任务继续',stop:'停止任务',takeover:'人工接管',reconcile:'核对原结果',retry:'重试本任务'};
const decisions=['rejected','cancelled','no-action'] as const;
const decisionLabels={rejected:'拒绝这项请求',cancelled:'取消这项请求','no-action':'本项无需办理'};
const decisionMessages={approved:'',rejected:'人工拒绝已记录。',cancelled:'人工取消已记录。','no-action':'无需办理的决定已记录。'};
type Props={task:AutonomyTask;csrfToken:string;onChanged:(task?:AutonomyTask)=>void|Promise<void>;communityParametersOnly?:boolean;allowActions?:boolean};

function CommunityParameterDetails({proposal}:{proposal:CommunityParameterProposal}){
  const scope=proposal.scope==='global'?'全站':proposal.target.label;
  const receipt=readCommunityParameterReceipt(proposal.receipt,proposal.operationId);
  return <>
    <h4>{proposal.title}</h4>
    <ActionCardDetails view={{
      changes:proposal.changes,
      details:[{label:'调整范围',value:scope+' · '+communityParameterAreas[proposal.area]},...proposal.basis, ...proposal.impact.map(value=>({label:'预计影响',value}))],
      warnings:[],
    }}/>
    {receipt?<p role="status">实际采用版本 {receipt.version}</p>:proposal.decision?<p role="status">{proposal.decision==='approved'?'采用结果待核对':proposal.decision==='rejected'?'已拒绝':proposal.decision==='cancelled'?'已取消':'无需办理'}</p>:null}
  </>;
}

export function AutonomyTaskControls(props:Props){return <TaskControls key={props.task.id} {...props}/>;}

function TaskControls({task,csrfToken,onChanged,communityParametersOnly=false,allowActions=true}:Props){
  const [outcome,setOutcome]=useState('');
  const confirming=useRef<string|null>(null);
  const canControl=task.availableControls.length>0;
  const pending=task.state==='waiting-human'&&task.source!=='workbench'&&task.humanDecision?.kind!=='takeover'?(task.pendingCalls??[]).filter(call=>{
    const macro=call.communityParameterProposal?.kind===communityParameterKind;
    return (!communityParametersOnly||macro)&&(canControl||macro)&&!task.continuation?.decisions.some(decision=>decision.callId===call.callId);
  }):[];
  const history=task.communityParameterProposals?.filter(proposal=>!pending.some(call=>call.callId===proposal.callId))??[];
  const completed=useCallback(async(value:AutonomyControlSave)=>{
    const operationId=confirming.current;
    const receipt=operationId?readCommunityParameterReceipt(value.communityParameterReceipt,operationId):null;
    confirming.current=null;
    setOutcome(value.applied===false?(value.outcome==='human-review-waiting'?'本次暂停未应用：任务正在等待人工决定。':'本次暂停未应用：原运行已结束。'):(receipt?'已采用社区参数 · 版本 '+receipt.version:''));
    await onChanged(value.task);
  },[onChanged]);
  const command=useAutonomyCommand<AutonomyControlSave>({
    csrfToken,canWrite:allowActions&&(canControl||pending.some(call=>call.communityParameterProposal?.canApprove===true)),
    onCommitted:completed,onConflict:()=>void onChanged(),
  });
  const taskPath=autonomyBase+'/tasks/'+encodeURIComponent(task.id);
  function decide(callId:string,decision:AutonomyHumanDecision,operationId?:string){
    if(command.locked||!allowActions)return;
    setOutcome('');
    confirming.current=decision==='approved'?operationId??null:null;
    void command.submit(taskPath+'/decisions',{expectedRevision:task.revision,callId,decision},decisionMessages[decision]);
  }

  return <>
    {!communityParametersOnly&&<>
      {task.previousAttempt&&<p>本任务已开始新一次运行；此前运行失败记录保留。此前运行 {task.previousAttempt.nativeRunId??'未知'}（{task.previousAttempt.status}），当前运行 {task.nativeRunId??'等待分配'}。</p>}
      {task.manualPause?.phase==='ended'&&task.manualPause.outcome==='native-ended'&&<p role="status">暂停请求未应用，原运行已结束。</p>}
      {task.manualPause?.phase==='requested'&&<p role="status">正在暂停，等待当前运行到达可暂停的位置。</p>}
      {task.manualPause?.phase==='resuming'&&<p role="status">正在接续。</p>}
    </>}
    {pending.length>0&&<section className="auto-task-feedback">
      <h3>待人工决定</h3>
      {pending.map((call,index)=>{
        const proposal=call.communityParameterProposal;
        return <article className="auto-pending-call" key={call.callId}>
          {proposal?<CommunityParameterDetails proposal={proposal}/>:<p>请求 {index+1} · {call.tool==='manage-ai-role'?'AI 角色管理':call.tool==='execute-operation'?'业务办理':call.tool==='prepare-operation'?'准备业务处理':'待人工处理'}</p>}
          <div className="auto-task-controls">
            {proposal?.canApprove===true&&<button type="button" disabled={command.locked||!allowActions} onClick={()=>decide(call.callId,'approved',proposal.operationId)}>确认采用</button>}
            {canControl&&decisions.map(decision=><button type="button" key={decision} disabled={command.locked||!allowActions} onClick={()=>decide(call.callId,decision)}>{decisionLabels[decision]}</button>)}
          </div>
        </article>;
      })}
    </section>}
    {history.length>0&&<section className="auto-task-feedback">
      <h3>参数调整记录</h3>
      {history.map(proposal=><article className="auto-pending-call" key={proposal.callId}><CommunityParameterDetails proposal={proposal}/></article>)}
    </section>}
    {!communityParametersOnly&&<div className="auto-task-controls">{task.availableControls.map(kind=><button key={kind} type="button" disabled={command.locked} onClick={()=>{
      setOutcome('');
      confirming.current=null;
      const expected=(kind==='pause'||kind==='resume')&&task.controlRevision!=null?{expectedControlRevision:task.controlRevision,expectedNativeRunId:task.nativeRunId??null,expectedNativeAttemptId:task.nativeAttemptId??null}:{expectedRevision:task.revision};
      void command.submit(taskPath+'/control',{...expected,kind},kind==='takeover'?'已由人工接管。':kind==='stop'?'任务已停止。':kind==='pause'?'暂停请求已记录。':kind==='resume'?'接续请求已记录。':kind==='retry'?'已安排本任务的新一次运行。':'正在核对原结果。');
    }}>{labels[kind]}</button>)}</div>}
    <CommandFeedback command={{...command,message:outcome||command.message}}/>
  </>;
}
