import React,{useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import type {createWebRuntime} from './runtime.mjs';

type Runtime=Pick<Awaited<ReturnType<typeof createWebRuntime>>,'api'|'agentContinuity'>;
type Props={runtime?:Runtime|null;subjectId?:string|null;connected:boolean;navigate:(path:string)=>void;identityPage?:boolean;returnTo?:string;required?:boolean;onReady?:(ready:boolean)=>void};
export const needsAgentIdentity=(reason:unknown)=>typeof reason==='object'&&reason!==null&&'code' in reason&&typeof reason.code==='string'&&reason.code.startsWith('agent_identity_');

// A convenience read for explanation only. Every Task write independently
// revalidates the saved public chain and the current browser device in runtime.
export function TaskAgentIdentityPrompt(props:Props){
 const connection=props.runtime?.api.snapshot();
 return <TaskAgentIdentitySession key={JSON.stringify([props.runtime?.api.endpoint,props.subjectId,props.connected,connection?.bindingId,connection?.generation,props.required])} {...props}/>;
}
function TaskAgentIdentitySession({runtime,subjectId,navigate,identityPage=false,returnTo,required=false,onReady}:Props){
 const [state,setState]=useState(runtime&&subjectId?'checking':'required'),[notice,setNotice]=useState('');
 useEffect(()=>{let current=true;
  if(!runtime||!subjectId)return;
  void runtime.agentContinuity.status().then(value=>{if(current)setState(value.state);}).catch(()=>{if(current)setState('required');});
  return()=>{current=false;};
 },[runtime,subjectId]);
 useEffect(()=>{onReady?.(state==='verified');},[state,onReady]);
 if(state==='verified'&&!required)return null;
 const target=returnTo??location.pathname+location.search+location.hash;
 async function copy(){try{await navigator.clipboard.writeText(`请用你当前已有的本机银河身份，通过本机审阅页打开官网接续，并返回官网中的这个原目标：${target}。请保留同一个银河 ID，先让我核对官网、浏览器设备指纹和权限再批准。`);setNotice('已复制。交给正在使用的本机 Agent 发起接续。');}catch{setNotice('请在本机 Agent 中说明：使用原银河身份打开官网接续，再回到这里。');}}
 if(state==='checking')return <output className="request-field-note">正在确认已有身份…</output>;
 return <aside className="identity-continuation" aria-label="任务使用已有 Agent 身份"><h3>用你的 AI 继续同一项工作</h3>
  <p>让本机 Agent 打开银河接续入口，确认这台浏览器后就会回到这里。草稿已保留。</p>
  <div className="button-row">{identityPage?<Button type="button" variant="outline" onClick={()=>void copy()}>复制给我的 Agent</Button>:<Button type="button" variant="outline" onClick={()=>navigate('/app/settings/identity')}>接续已有身份</Button>}</div>
  {notice&&<output>{notice}</output>}
 </aside>;
}
