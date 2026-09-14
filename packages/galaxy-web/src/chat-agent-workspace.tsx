import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createChatAgentClient } from './chat-agent-client.mjs';
const grantLabels:Record<string,string>={active:'权限有效',revoked:'已撤销',expired:'已到期','binding-unavailable':'客户端绑定已不可用','room-inactive':'房间当前不可写'};
function agentError(error:any){return typeof error?.message==='string'&&error.message.trim()?error.message:'Agent 权限操作暂未完成，请查询原操作后再继续。';}

type ChatAgentProps={runtime:any;room:any;navigate:(path:string)=>void};
export function ChatAgentWorkspace(props:ChatAgentProps) {
  const session=props.runtime.api.snapshot();
  return <ChatAgentView key={JSON.stringify([props.room.roomId,session?.subjectId,session?.bindingId])} {...props}/>;
}
function ChatAgentView({runtime,room,navigate}:ChatAgentProps) {
  const client=useMemo(()=>createChatAgentClient(runtime),[runtime]);
  const [bindings,setBindings]=useState<any[]>([]),[bindingNext,setBindingNext]=useState<string|null>(null),[grants,setGrants]=useState<any[]>([]),[grantNext,setGrantNext]=useState<string|null>(null);
  const [bindingId,setBindingId]=useState(''),[mode,setMode]=useState('draft'),[primary,setPrimary]=useState(false),[hours,setHours]=useState(24);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[pending,setPending]=useState<any>(null),[preview,setPreview]=useState<any>(null),[childTitle,setChildTitle]=useState('');
  const mounted=useRef(true), working=useRef(false), reading=useRef(false), revision=useRef(0);
  async function refresh() {
    const version=++revision.current;
    const [bound,allowed,saved]=await Promise.all([runtime.api.call('/v1/bindings/query',{}),client.list(room.roomId),client.pending(room.roomId)]);
    if(!mounted.current||version!==revision.current)return;
    setBindings(bound.items);setBindingNext(bound.nextAfter);setGrants(allowed.items);setGrantNext(allowed.next);setPending(saved);
  }
 async function run(action:()=>Promise<void>,refreshAfter=true){if(working.current)return;working.current=true;revision.current++;setBusy(true);setMessage('');let committed=false;try{await action();committed=true;if(refreshAfter)await refresh();}catch(e:any){if(mounted.current)setMessage(committed?'Agent权限操作已收到服务回执，但列表暂未刷新；请查询原操作，不要重复授权。':agentError(e));}finally{working.current=false;if(mounted.current)setBusy(false);}}
  useEffect(()=>{
    setPreview(null);setBindingId('');setChildTitle('');let active=true;mounted.current=true;
    const reload=()=>{if(!active||document.visibilityState!=='visible'||working.current||reading.current)return;reading.current=true;const attempt=revision.current+1;refresh().catch(e=>{if(active&&attempt===revision.current)setMessage(agentError(e));}).finally(()=>{reading.current=false;});};
    reload();const timer=window.setInterval(reload,20000);document.addEventListener('visibilitychange',reload);
    return()=>{active=false;mounted.current=false;revision.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',reload);};
  },[runtime,room.roomId]);
  return <details className="room-settings"><summary>我的 Agent 与 AI 子区</summary>
    <p>这里选择本人的客户端在这个房间能做什么。授权不启动模型；模型是否在线、是否支持后台运行，由对应宿主报告。银河不会代替离线客户端运行模型。</p>
    {message&&<p className="message" role="status">{message}</p>}
    {pending&&<div className="message"><p>本机有一项未确认的 Agent 权限操作，先查询原结果。</p><Button disabled={busy} onClick={()=>run(async()=>{const result=await client.retry(room.roomId,{confirmed:true});setMessage(`原操作状态：${result.state??'已登记'}；宿主运行状态未确认。`);})}>查询并继续原操作</Button></div>}
    <div className="result-list">{grants.map(grant=><article className="task-card" key={grant.grantId}><h3>{grant.mode==='respond'?'允许回应':grant.mode==='draft'?'读取并草拟':'只读'}{grant.primaryResponder?' · 本方主要响应 Agent':''}</h3>
      <p>客户端绑定：<code>{grant.bindingId}</code></p><p>状态：{grantLabels[grant.state]??grant.state}；至 {new Date(grant.expiresAt*1000).toLocaleString()}</p>
      <p className="muted">宿主运行状态尚未确认。</p>{grant.state==='active'&&<Button variant="outline" disabled={busy||!!pending} onClick={()=>setPreview({kind:'revoke',grant})}>撤销银河房间权限</Button>}</article>)}</div>
    {grantNext&&<Button variant="ghost" disabled={busy} onClick={()=>run(async()=>{const page=await client.list(room.roomId,{after:grantNext});setGrants(old=>[...old,...page.items]);setGrantNext(page.next);},false)}>更多授权</Button>}
    <form className="workspace-form" onSubmit={event=>{event.preventDefault();setPreview({kind:'grant',input:{bindingId,mode,primaryResponder:mode==='respond'&&primary,expiresAt:Math.floor(Date.now()/1000)+hours*3600}});}}>
      <h3>授权一个已连接的客户端</h3><label>我的客户端<select required value={bindingId} onChange={e=>setBindingId(e.target.value)}><option value="">选择安装标识和绑定</option>{bindings.filter(b=>b.state==='active'&&b.scopes.includes('binding')).map(b=><option key={b.bindingId} value={b.bindingId}>{b.installationId} · {b.bindingId}</option>)}</select></label>
      {bindingNext&&<Button type="button" variant="ghost" onClick={()=>run(async()=>{const page=await runtime.api.call('/v1/bindings/query',{after:bindingNext});setBindings(old=>[...old,...page.items]);setBindingNext(page.nextAfter);},false)}>更多客户端</Button>}
      <label>参与方式<select value={mode} onChange={e=>{setMode(e.target.value);setPrimary(false);}}><option value="draft">按需读取并草拟，由我决定发送</option><option value="read">只读授权历史</option><option value="respond">允许在此房间回应</option></select></label>
      {mode==='respond'&&<label><input type="checkbox" checked={primary} onChange={e=>setPrimary(e.target.checked)}/>作为本控制方的主要响应 Agent</label>}
      <label>授权期限<select value={hours} onChange={e=>setHours(Number(e.target.value))}><option value={24}>24 小时</option><option value={168}>7 天</option><option value={720}>30 天</option></select></label>
      <p className="muted">仅作用于此房间。主聊天与 AI 子区分别授权；草拟不会自动发送，允许回应也不授权无限循环。</p><Button type="submit" disabled={busy||!!pending||!bindingId||['archived','owner-succession'].includes(room.state)}>查看这次授权</Button>
    </form>
    {room.kind==='ordinary'?<form className="workspace-form" onSubmit={event=>{event.preventDefault();run(async()=>{const created=await runtime.chat.create({title:childTitle,kind:'ai-subzone',parentRoomId:room.roomId,retentionDays:room.retentionDays,taskRefs:[]},{confirmed:true});navigate(`/app/rooms/${created.roomId}`);});}}>
      <h3>创建关联的 AI 子区</h3><label>子区名称<Input required maxLength={120} value={childTitle} onChange={e=>setChildTitle(e.target.value)}/></label><p className="muted">新子区先只有你，成员随后按共同规则邀请。只展示获准进展、工件、问题和来源，不要求或收集内部思维链；主房间的全部成员不会自动加入。</p><Button type="submit" disabled={busy||room.state==='archived'}>创建 AI 子区</Button>
    </form>:room.parentRoomId&&<Button variant="outline" onClick={()=>navigate(`/app/rooms/${room.parentRoomId}`)}>返回关联主聊天</Button>}
    {preview&&<div className="message"><p>{preview.kind==='revoke'?'撤销后该 Agent 不能继续使用这项银河权限。网页不会假称已终止外部宿主进程；需要在宿主里停止仍在运行的模型。':`确认授权所选客户端在本房间${preview.input.mode==='respond'?'回应':preview.input.mode==='draft'?'读取并草拟':'只读'}，有效至 ${new Date(preview.input.expiresAt*1000).toLocaleString()}？`}</p>
      <div className="button-row"><Button disabled={busy} onClick={()=>run(async()=>{if(preview.kind==='revoke')await client.revoke(room.roomId,preview.grant.grantId,{confirmed:true});else await client.grant(room.roomId,preview.input,{confirmed:true});setPreview(null);setMessage('银河权限已更新；宿主运行状态仍需对应客户端提供。');})}>确认这项权限操作</Button><Button variant="ghost" disabled={busy} onClick={()=>setPreview(null)}>取消</Button></div></div>}
  </details>;
}
