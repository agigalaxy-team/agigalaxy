import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { createChatAgentClient } from './chat-agent-client.mjs';

const states: Record<string,string> = {active:'授权有效',revoked:'已撤销',expired:'已到期','binding-unavailable':'授权客户端已不可用','room-inactive':'房间当前不可写'};
const modes: Record<string,string> = {read:'读取本房间获准历史',draft:'读取并准备草稿',respond:'读取、草拟并在本房间回应'};

export function AgentParticipants({runtime,roomId}:{runtime:any;roomId:string}) {
 const client=useMemo(()=>createChatAgentClient(runtime),[runtime]);
 const generation=useRef(0),[items,setItems]=useState<any[]>([]),[next,setNext]=useState<string|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function load(after?:string){const epoch=generation.current;setBusy(true);setError('');
  if(!after){setItems([]);setNext(null);}
  try{const page=await client.participants(roomId,{...(after?{after}:{}),limit:20});if(epoch!==generation.current)return;
   setItems(old=>after?[...old.filter(x=>!page.items.some((y:any)=>y.grantId===x.grantId)),...page.items]:page.items);setNext(page.next);
  }catch(e:any){if(epoch===generation.current){setItems([]);setNext(null);setError(typeof e?.message==='string'&&e.message.trim()?e.message:'Agent 参与范围暂未读取成功，请稍后重试。');}}
  finally{if(epoch===generation.current)setBusy(false);}
 }
 useEffect(()=>{generation.current++;setItems([]);setNext(null);setError('');void load();return()=>{generation.current++;};},[client,roomId]);
 return <details className="workspace-panel"><summary>房间里的 Agent 参与范围</summary>
  <p className="muted">这里说明成员允许自己的 Agent 做什么。授权有效不代表模型在线或正在运行；本地文件和其他房间的权限另行管理。</p>
  {error&&<p role="alert" className="error">{error}</p>}
  <Button variant="outline" disabled={busy} onClick={()=>void load()}>刷新参与范围</Button>
  {!busy&&!error&&!items.length&&<p>当前没有可显示的 Agent 房间授权。</p>}
  <div className="result-list">{items.map(item=><article className="task-card" key={item.grantId}>
   <h4>{modes[item.mode]??'有限房间参与'}{item.primaryResponder?' · 本方主要响应 Agent':''}</h4>
   <p>代表成员：<code>{item.subjectId}</code></p>
   <p>{states[item.state]??'当前不可使用'}；有效至 {new Date(item.expiresAt*1000).toLocaleString()}</p>
   <p className="muted">运行状态未确认。{item.state!=='active'?'此授权目前不允许新增动作。':'实际处理与判断由该成员自己的模型完成。'}</p>
  </article>)}</div>
  {next&&<Button variant="ghost" disabled={busy} onClick={()=>void load(next)}>继续查看</Button>}
 </details>;
}
