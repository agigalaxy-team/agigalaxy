import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ArrowLeft, Send, RefreshCw } from 'lucide-react';
import {PersonalSummaryWorkspace} from './personal-summary-workspace';
import {ChatAgentWorkspace} from './chat-agent-workspace';
import {AgentParticipants} from './agent-participants';
import {ChatAttachmentComposer,ChatAttachmentFiles} from './chat-attachments-workspace';

const labels: Record<string, string> = { invite: '邀请成员', remove: '移除成员', retention: '修改后续消息期限', 'become-owner': '设立房主',
  'transfer-owner': '房主接任', persistent: '长期房间设置', dissolve: '解散房间', pending: '等待共同决定', approved: '已同意，等待目标方回应',
  applied: '已生效', rejected: '已拒绝', cancelled: '已取消', stale: '成员变化，原提议失效', expired: '已过期' };
type Props = { runtime: any; roomId?: string; connected: boolean; subjectId?: string; navigate: (path: string) => void; needIdentity: () => void };

export function ChatWorkspace(props: Props) {
 return <ChatWorkspaceSession key={`${props.runtime?.api.endpoint}:${props.subjectId}:${props.connected}:${props.roomId??'directory'}`} {...props}/>;
}
function ChatWorkspaceSession({ runtime, roomId, connected, subjectId, navigate, needIdentity }: Props) {
  const [rooms, setRooms] = useState<any[]>([]), [invitations, setInvitations] = useState<any[]>([]), [room, setRoom] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]), [decisions, setDecisions] = useState<any[]>([]), [pending, setPending] = useState<any>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [title, setTitle] = useState(''), [text, setText] = useState(''), [target, setTarget] = useState('');
  const [retention, setRetention] = useState(90), [after, setAfter] = useState('0'), [previous, setPrevious] = useState<string[]>([]);
  const [next, setNext] = useState<string | null>(null), [scanned, setScanned] = useState('0'), [keyword, setKeyword] = useState(''), [filter, setFilter] = useState('');
  const [action, setAction] = useState<any>(null), [reply, setReply] = useState<any>(null), [edit, setEdit] = useState<any>(null);
  const [selectedSharedId,setSelectedSharedId]=useState<string|undefined>(),[locatedMessage,setLocatedMessage]=useState<string|undefined>();
  const [selectedAttachments,setSelectedAttachments]=useState<any[]>([]);
  const [linkedTasks,setLinkedTasks]=useState<any[]>([]);
  const [roomNext, setRoomNext] = useState<string | null>(null), [draftReady, setDraftReady] = useState(false), [readRefresh, setReadRefresh] = useState(0);
  const active = useRef(0), working = useRef(false);
  const roomPath = `/v2/chat/rooms/${roomId}`;
  const message = (reason: any) => ({ chat_transport_unavailable: '通信服务暂时不可用。原发送操作保留在本机，可恢复后重试。',
    chat_access_denied: '你目前没有这个房间的访问权限。', connection_required: '请重新连接银河身份。', account_verification_required: '创建或加入房间需要验证账号，请前往身份与设置。',
    chat_revision_conflict: '房间已变化，请刷新后重新提出。', chat_two_party_removal_forbidden: '两方房间不能单方面移除另一方，可以明确退出。' } as Record<string, string>)[reason?.message] ?? reason?.message ?? '操作未完成。';
  async function reload(appendAfter?: string) {
    if (!runtime || !connected) return;
    const lease = active.current;
    if (!roomId) {
      const [list, invites, saved] = await Promise.all([runtime.api.call('/v2/chat/rooms/query', appendAfter ? { after: appendAfter } : {}),
        runtime.api.call('/v2/chat/invitations/query', {}), runtime.chat.pending(null)]);
      if (lease !== active.current) return;
      setRooms(old => appendAfter ? [...old, ...list.rooms] : list.rooms); setRoomNext(list.next); setInvitations(invites.invitations); setPending(saved);
    } else {
      const [current, choices, saved] = await Promise.all([runtime.api.call(roomPath + '/read', {}), runtime.api.call(roomPath + '/decisions', {}), runtime.chat.pending(roomId)]).catch(reason=>{if(lease===active.current){setRoom(null);setLinkedTasks([]);setMessages([]);setDecisions([]);}throw reason;});
      if (lease !== active.current) return;
      setRoom(current); setDecisions(choices.decisions); setPending(saved);
      const linked = await Promise.all((current.taskRefs ?? []).map(async (id: string) => {
        try { const task = await runtime.api.call(`/v2/tasks/${id}`,null,{method:'GET',authenticated:true}); return {id,title:task.request.title,available:true}; }
        catch { return {id,available:false}; }
      }));
      if (lease !== active.current) return;
      setLinkedTasks(linked);
      const page = await runtime.api.call(roomPath + '/history', { after, limit: 50, ...(filter ? { keyword: filter } : {}) });
      if (lease !== active.current) return;
      setMessages(page.messages); setNext(page.next); setScanned(page.scannedThrough);
    }
  }
  async function run(operation: () => Promise<any>, refreshAfter = true) {
    if (working.current) return; working.current = true; setBusy(true); setError(''); setNotice('');
    const lease=active.current;let completed=false;
    try { await operation(); completed=true;if(lease===active.current&&refreshAfter)await reload(); }
    catch (reason) { if(lease===active.current){if(completed)setNotice('上一步已返回，但最新房间状态暂未刷新。请查询原操作，避免重复发送或创建。');else setError(message(reason));} }
    finally {
      if(lease===active.current){try {const saved=await runtime?.chat.pending(roomId??null);if(lease===active.current)setPending(saved);} catch {if(lease===active.current)setError('暂时无法读取本机恢复记录，请保留当前页面并稍后刷新。');}}
      working.current=false;if(lease===active.current)setBusy(false);
    }
  }
  useEffect(() => { active.current++; setRoom(null); setLinkedTasks([]); setMessages([]); setDecisions([]); setError(''); setNotice(''); setAction(null); setEdit(null); setReply(null);
    setSelectedSharedId(undefined);setLocatedMessage(undefined);
    setSelectedAttachments([]);
    setAfter('0'); setPrevious([]); setFilter(''); setKeyword(''); setDraftReady(false);
    let mounted = true;
    if (runtime && roomId) runtime.getLocal(`chat-draft:${roomId}`).then((draft: any) => { if (mounted) { setText(draft ?? ''); setDraftReady(true); } });
    return () => { mounted = false; active.current++; };
  }, [runtime, roomId, subjectId]);
  useEffect(()=>{if(locatedMessage)document.getElementById('chat-message-'+locatedMessage)?.scrollIntoView({block:'center',behavior:'smooth'});},[messages,locatedMessage]);
  useEffect(() => { if (runtime && roomId && draftReady) runtime.putLocal(`chat-draft:${roomId}`, text).catch((reason: any) => setError(message(reason))); }, [text, draftReady, roomId, runtime]);
  useEffect(() => {
    let stopped = false;
    const update = () => { if (!stopped && !working.current && !document.hidden) reload().catch(reason => { if (!stopped) setError(message(reason)); }); };
    update(); const timer = setInterval(update, 7000); document.addEventListener('visibilitychange', update);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', update); active.current++; };
  }, [runtime, connected, roomId, after, filter, readRefresh]);
  async function propose(input: any) { await runtime.chat.propose(roomId, { expectedRevision: room.revision, ...input }, { confirmed: true }); setNotice('提议已记录。仍需其他控制方及被邀请者按各自步骤确认。'); }
  async function send() {
    const result = await runtime.chat.send(roomId, text, { confirmed: true, replyTo: reply?.messageId ?? null,attachments:selectedAttachments });
    setSelectedAttachments([]);
    setText(''); setReply(null); setNotice(result.state === 'accepted' ? '房间存档已接受，不代表对方已读。' : '发送状态已更新。');
  }
  if (!connected) return <><h1 className="small">聊天</h1><p className="lead">连接身份后查看自己的房间与邀请。普通交流无需任务。</p><Button disabled={!runtime} onClick={needIdentity}>连接我的身份</Button></>;
  return <section className="chat-workspace" aria-busy={busy}>
    {roomId && <button className="back-link" onClick={() => navigate('/app/rooms')}><ArrowLeft size={16}/>我的聊天</button>}
    <h1 className="small">{roomId ? room?.title ?? '正在读取房间' : '聊天'}</h1>
    {error && <div className="message error" role="alert">{error}</div>}{notice && <div className="message" role="status">{notice}</div>}
    <Button variant="ghost" disabled={busy} onClick={() => run(() => reload(),false)}><RefreshCw size={16}/>刷新</Button>
    {pending && <div className="message"><p>本机保留了一次未确认的操作。恢复使用原标识和内容，避免重复发送或创建。</p><div className="button-row">
      <Button disabled={busy} onClick={() => run(async () => { const result = await runtime.chat.retry(roomId ?? null, { confirmed: true }); if (!roomId && result.roomId) navigate(`/app/rooms/${result.roomId}`); setNotice('原操作已恢复。请查看当前状态。'); })}>查询并重试原操作</Button>
      <Button variant="outline" onClick={() => setAction({ kind: 'stop-retry' })}>停止本机重试</Button></div></div>}
    {!roomId && <>
      <p className="lead">先交流，也可以随后关联工作。打开房间不会自动接受任务，关掉页面也不会退出房间。</p>
      {invitations.length > 0 && <div className="result-list"><h2>等待你的回应</h2>{invitations.map(invite => <article className="task-card" key={invite.decisionId}><h3>{invite.title}</h3><p>{labels[invite.action]}：接受后可读取房间仍获准保留的完整共享历史。</p><div className="button-row">
        <Button disabled={busy} onClick={() => run(async () => { await runtime.api.call(`/v2/chat/rooms/${invite.roomId}/accept`, { decisionId: invite.decisionId, accept: true }); navigate(`/app/rooms/${invite.roomId}`); })}>接受并进入</Button>
        <Button variant="outline" disabled={busy} onClick={() => run(() => runtime.api.call(`/v2/chat/rooms/${invite.roomId}/accept`, { decisionId: invite.decisionId, accept: false }))}>婉拒</Button></div></article>)}</div>}
      <div className="result-list">{rooms.map(item => <button className="task-card" key={item.roomId} onClick={() => navigate(`/app/rooms/${item.roomId}`)}><h2>{item.title}</h2><p>{item.kind === 'ai-subzone' ? 'AI 子区' : '普通聊天'} · {item.members.length} 个成员身份 · 后续消息保留 {item.retentionDays} 天</p><span className="text-link">进入聊天 →</span></button>)}</div>
      {rooms.length === 0 && !error && <div className="empty-state">还没有房间。可以创建普通聊天，再邀请愿意交流的人。</div>}
      {roomNext && <Button variant="outline" disabled={busy} onClick={() => run(() => reload(roomNext),false)}>更多房间</Button>}
      <form className="workspace-form" onSubmit={event => { event.preventDefault(); run(async () => { const created = await runtime.chat.create({ title, retentionDays: retention }, { confirmed: true }); setTitle(''); navigate(`/app/rooms/${created.roomId}`); }); }}>
        <h2>开始普通聊天</h2><label>聊天名称<Input required maxLength={120} value={title} onChange={e => setTitle(e.target.value)}/></label>
        <label>后续消息的保留时间<select value={retention} onChange={e => setRetention(Number(e.target.value))}><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option></select></label>
        <p className="muted">新房间默认共同治理，没有预设房主。只有你一人等待邀请时，不会要求解散。</p><Button type="submit" disabled={busy || !!pending}>创建聊天</Button>
      </form>
    </>}
    {room && <>
      <p className="muted">{room.members.length} 个成员身份 · {room.independentMemberCount} 个已知独立控制方 · {room.kind === 'ai-subzone' ? 'AI 子区独立授权' : '普通房间'} · 后续消息保留 {room.retentionDays} 天</p>
      <div className="button-row"><Button variant="outline" onClick={()=>navigate('/app/governance?targetType=room&targetId='+room.roomId)}>举报与处理</Button></div>
      {!!room.taskRefs?.length && <section><h2>关联任务</h2><p className="muted">每个入口按当前任务权限核对。房间成员资格不会自动开放任务、Context 或报价。</p>{linkedTasks.map(item=>item.available?<Button variant="outline" key={item.id} onClick={()=>navigate(`/app/tasks/${item.id}`)}>返回任务：{item.title}</Button>:<p key={item.id}>一项关联任务当前不可读取。请刷新后重试，或向发起者了解授权。</p>)}</section>}
      <AgentParticipants runtime={runtime} roomId={room.roomId}/>
      <ChatAgentWorkspace key={room.roomId} runtime={runtime} room={room} navigate={navigate}/>
      <details open={!!selectedSharedId}><summary>个人背景摘要、关键消息与成员分享</summary><PersonalSummaryWorkspace runtime={runtime} room={room} subjectId={subjectId} connected={connected} navigate={navigate} messages={messages} selectedSharedId={selectedSharedId} onLocate={source=>{setAfter(String(BigInt(source.sequence)>0n?BigInt(source.sequence)-1n:0n));setPrevious([]);setFilter('');setKeyword('');setLocatedMessage(source.messageId);setReadRefresh(v=>v+1);}}/></details>
      {!room.transportAvailable && <div className="message">通信当前不可用。已保存的待发送操作可以稍后恢复。</div>}
      {room.decisionRequired && <div className="message">其他控制方已明确退出。你可以继续等待、提议成为房主或解散；关闭此提示不改变任务。<div className="button-row"><Button variant="outline" onClick={() => run(() => runtime.api.call(roomPath + '/dismiss', {}))}>继续等待并关闭提示</Button><Button variant="outline" disabled={busy || !!pending} onClick={() => run(() => propose({ action: 'become-owner', targetSubjectId: subjectId }))}>提议成为房主</Button></div></div>}
      <form className="search-row" onSubmit={e => { e.preventDefault(); setAfter('0'); setPrevious([]); setFilter(keyword); setReadRefresh(v => v + 1); }}><Input placeholder="查找仍保留的消息" aria-label="搜索房间消息" value={keyword} onChange={e => setKeyword(e.target.value)}/><Button type="submit" variant="outline">搜索</Button></form>
      <div className="chat-history" aria-label="当前消息页">{messages.map(item => <article id={'chat-message-'+item.messageId} className={`chat-message ${item.subjectId === subjectId ? 'own' : ''}`} key={item.messageId}>
        <header><code>{item.subjectId === subjectId ? '我' : item.subjectId}</code><span>{item.actorKind === 'agent' ? 'Agent' : '聊天'} · {new Date(item.sentAt).toLocaleString()}{item.editedAt ? ' · 已编辑' : ''}</span></header>
        {item.replyTo && <p className="muted">回复消息 {item.replyTo}</p>}<p>{item.state === 'retracted' ? '此消息已撤回。' : item.text}</p>
        <ChatAttachmentFiles runtime={runtime} items={item.attachments}/>
        {item.sharedSummaryId&&<Button variant="outline" onClick={()=>setSelectedSharedId(item.sharedSummaryId)}>查看这次共享的背景与关键消息</Button>}
        <div className="chat-message-actions">{item.text && <><button onClick={() => setReply(item)}>回复</button><button onClick={() => run(() => runtime.api.call(`${roomPath}/messages/${item.messageId}/hide`, { hidden: true }))}>仅对我隐藏</button></>}
          {item.subjectId === subjectId && item.text && <>{!item.sharedSummaryId&&<button onClick={() => setEdit({ ...item, draft: item.text })}>编辑</button>}<button onClick={() => setAction({ kind: 'retract', messageId: item.messageId })}>撤回</button></>}
        </div></article>)}</div>
      {!messages.length && <div className="empty-state">当前页没有仍可见的消息。筛选或删除可能形成空页，有下一页时可以继续查看。</div>}
      <div className="button-row"><Button variant="outline" disabled={!previous.length} onClick={() => { setAfter(previous.at(-1)!); setPrevious(previous.slice(0, -1)); }}>上一页</Button><Button variant="outline" disabled={!next} onClick={() => { setPrevious([...previous, after]); setAfter(next!); }}>下一页</Button>
        <Button variant="ghost" disabled={busy || scanned === '0'} onClick={() => run(async () => { await runtime.api.call(roomPath + '/cursor', { kind: 'human', sequence: scanned }); setNotice('仅更新你的阅读位置，不改变 Agent 处理位置。'); })}>我已读完至此</Button></div>
      <p className="muted">从最早仍保留的记录分页查看完整共享历史；本页自动刷新，不自动标记已读。</p>
      {edit ? <form className="workspace-form" onSubmit={e => { e.preventDefault(); run(async () => { await runtime.chat.edit(roomId, edit.messageId, { expectedRevision: edit.revision, text: edit.draft }, { confirmed: true }); setEdit(null); }); }}><h2>编辑自己的消息</h2><Textarea required maxLength={16000} value={edit.draft} onChange={e => setEdit({ ...edit, draft: e.target.value })}/><p className="muted">24 小时内可编辑并显示标识；超过期限请另发纠正。</p><div className="button-row"><Button type="submit" disabled={busy || !!pending}>保存编辑</Button><Button type="button" variant="ghost" onClick={() => setEdit(null)}>取消编辑</Button></div></form> :
        <form className="workspace-form chat-compose" onSubmit={e => { e.preventDefault(); run(send); }}>{reply && <div className="message">回复 {reply.subjectId === subjectId ? '自己的消息' : reply.subjectId}<Button type="button" variant="ghost" onClick={() => setReply(null)}>取消回复</Button></div>}
          <label>消息<Textarea required maxLength={16000} disabled={room.state === 'archived' || room.state === 'owner-succession'} value={text} onChange={e => setText(e.target.value)} placeholder="说说想法，无需先创建任务。"/></label>
          <ChatAttachmentComposer key={roomId} runtime={runtime} roomId={roomId!} disabled={busy||!!pending||['archived','owner-succession'].includes(room.state)} selected={selectedAttachments} onChange={setSelectedAttachments}/>
          <Button type="submit" disabled={busy || !!pending || !text.trim() || ['archived', 'owner-succession'].includes(room.state)}><Send size={16}/>发送</Button><p className="muted">草稿留在本机。发送才会进入房间存档，服务确认不等于对方阅读。</p>
        </form>}
      <details className="room-settings"><summary>成员与共同设置</summary><ul>{room.members.map((member: any) => <li key={member.subjectId}><code>{member.subjectId}</code>{member.subjectId === room.ownerSubjectId ? ' · 房主' : ''}</li>)}</ul>
        <form className="workspace-form" onSubmit={e => { e.preventDefault(); run(async () => { await propose({ action: 'invite', targetSubjectId: target }); setTarget(''); }); }}><label>邀请的银河 ID<Input required pattern="GUID[A-Z0-9]{28}" value={target} onChange={e => setTarget(e.target.value.trim())}/></label><Button type="submit" disabled={busy || !!pending}>提议邀请</Button><p className="muted">现有控制方同意后，被邀请者仍可拒绝。邀请不等于承接任务。</p></form>
        <div className="button-row"><select aria-label="新的后续消息期限" value={retention} onChange={e => setRetention(Number(e.target.value))}><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option></select><Button variant="outline" disabled={busy || !!pending} onClick={() => run(() => propose({ action: 'retention', retentionDays: retention }))}>提议期限</Button>
          <Button variant="outline" disabled={busy || !!pending} onClick={() => run(() => propose({ action: 'persistent', persistent: !room.persistent }))}>{room.persistent ? '提议关闭长期存在' : '提议长期存在'}</Button>
          <Button variant="outline" disabled={busy || !!pending} onClick={() => setAction({ kind: 'dissolve' })}>提议解散</Button><Button variant="outline" disabled={busy} onClick={() => setAction({ kind: 'leave' })}>明确退出房间</Button></div>
        <h2>当前提议</h2>{decisions.map(decision => <article className="task-card" key={decision.decisionId}><h3>{labels[decision.action]} · {labels[decision.state] ?? decision.state}</h3><p>{decision.payload.targetSubjectId}{decision.payload.retentionDays ? `后续消息 ${decision.payload.retentionDays} 天` : ''}{typeof decision.payload.persistent === 'boolean' ? decision.payload.persistent ? '启用长期存在' : '取消长期存在' : ''}</p>
          <p className="muted">已记录 {decision.votes.length} 方选择，共需 {decision.requiredPartyCount} 方判断。未回应不等于同意。</p>{decision.state === 'pending' && <div className="button-row">{[['approve', '同意'], ['reject', '不同意'], ['cancel', '撤回我的提议']].map(([choice, label]) => <Button key={choice} variant="outline" disabled={busy} onClick={() => run(() => runtime.api.call(roomPath + '/vote', { decisionId: decision.decisionId, choice }))}>{label}</Button>)}</div>}
          {decision.state === 'approved' && decision.payload.targetSubjectId === subjectId && <Button disabled={busy} onClick={() => run(() => runtime.api.call(roomPath + '/accept', { decisionId: decision.decisionId, accept: true }))}>确认接受</Button>}
        </article>)}
      </details>
    </>}
    {action && <div className="message" role="region" aria-label="确认操作"><p>{action.kind === 'leave' ? '确认退出这个房间？以后查看共享历史需要重新获邀。任务参与不受影响。' : action.kind === 'retract' ? '确认撤回自己的消息？成员将不能继续读取原文，存档删除失败时系统保留重试状态。' : action.kind === 'dissolve' ? '提出解散这个房间，由所需控制方共同决定；此动作不取消任何关联任务。' : '仅删除本机的重试记录。已经送达的消息或已完成的设置仍然存在，请先刷新查看。'}</p><div className="button-row">
      <Button disabled={busy} onClick={() => run(async () => { if (action.kind === 'leave') { await runtime.api.call(roomPath + '/leave', {}); navigate('/app/rooms'); }
        else if (action.kind === 'retract') await runtime.api.call(`${roomPath}/messages/${action.messageId}/retract`, {});
        else if (action.kind === 'dissolve') await propose({ action: 'dissolve' });
        else await runtime.chat.stopRetry(roomId ?? null, { confirmed: true }); setAction(null); })}>确认此操作</Button><Button variant="outline" onClick={() => setAction(null)}>取消</Button></div></div>}
  </section>;
}
