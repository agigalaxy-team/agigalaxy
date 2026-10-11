import React, { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {createTaskPreparationClient} from './task-preparation-client.mjs';
import { MemberAvatar, memberName, readableTime, useMemberNames } from './conversation-ui';
import {
  createTaskContactClient,
  contactCandidates,
} from './task-contact-client.mjs';

import type {ProjectRuntime} from './project-workspace-types';
import type {TaskContactTask,TaskContactClient,ContactCandidate,ContactSearchPage,InvitationBatch,RoomBatch,TaskRoom,RoomProgress,TaskPreparation,SearchType} from './help-contact-view-types';
import {contactMessage} from './help-contact-view-types';
type Props = {
  task: TaskContactTask;
  runtime: ProjectRuntime;
  subjectId: string;
  connected: boolean;
  navigate: (path: string) => void;
  refresh: () => Promise<unknown>;
  section?: 'contacts' | 'rooms';
};
const roleLabels:Record<string,string>={unknown:'未说明',human:'人类参与者',agent:'Agent',attempt:'尝试者',intervention:'参与调整','verification-reporter':'报告验证结果'};
const labels: Record<string, string> = {
  queued: '尚未发送',
  sending: '正在发送',
  acknowledged: '服务已记录',
  'result-unknown': '结果待核对',
  'stopped-unsent': '已取消未发送项',
  'stopped-local': '已停止本机重试，服务端取消未确认',
  creating: '房间创建待核对',
  'waiting-for-members': '等待已邀者回应后按当前成员继续',
};
export function TaskContactWorkspace(props:Props){
 const connection=props.runtime.api.snapshot();
 const key=JSON.stringify([props.runtime.api.endpoint,props.subjectId,props.connected,connection?.subjectId,connection?.bindingId,connection?.generation,props.task.taskId]);
 return <TaskContactSession key={key} {...props}/>;
}
function TaskContactSession({
  task,
  runtime,
  subjectId,
  connected,
  navigate,
  refresh,
  section = 'contacts',
}: Props) {
  const client:TaskContactClient = useMemo(
    () => createTaskContactClient(runtime, task.taskId),
    [runtime, task.taskId],
  );
  const preparationClient=useMemo(()=>createTaskPreparationClient(runtime),[runtime]);
  const [pages, setPages] = useState<ContactSearchPage[]>([]),
    [candidates, setCandidates] = useState<ContactCandidate[]>([]),
    [selected, setSelected] = useState<string[]>([]);
  const [keyword, setKeyword] = useState(''),
    [functions, setFunctions] = useState<string>(
      task.request.capabilityId ?? '',
    );
  const [batch, setBatch] = useState<InvitationBatch|null>(null),
    [roomBatch, setRoomBatch] = useState<RoomBatch|null>(null);
  const [roomProgress, setRoomProgress] = useState<RoomProgress[]>([]);
  const [contactView, setContactView] = useState<'current'|'saved'>('current');
  const [savedSelected, setSavedSelected] = useState<string[]>([]);
  const [roomCreating, setRoomCreating] = useState(false);
  const [inviteReview, setInviteReview] = useState(false), [roomReview, setRoomReview] = useState(false);
  const inviteDialog = useRef<HTMLDialogElement>(null), roomDialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [queried, setQueried] = useState(false);
  const [roomChoices, setRoomChoices] = useState<string[]>([]),
    [mode, setMode] = useState(''),
    [rooms, setRooms] = useState<TaskRoom[]>([]);
  const [scan, setScan] = useState(0),
    [next, setNext] = useState<string | null>(null),
    [roomsLoaded, setRoomsLoaded] = useState(false);
  const active = useRef(0),
    working = useRef(0),
    lookedUp = useRef(false);
  const operationSequence = useRef(0);
  const batchIntent = useRef(0), batchRead = useRef(0), displayedBatch = useRef<InvitationBatch|null>(null);
  const roomIntent = useRef(0), roomRead = useRef(0), displayedRoomBatch = useRef<RoomBatch|null>(null);
  const currentView = (lease:number)=>lease===active.current;
  const fieldId=useId();
  function displayBatch(value: InvitationBatch|null) {
    batchRead.current++;
    displayedBatch.current = value;
    setBatch(value);
  }
  function displayRoomBatch(value: RoomBatch|null) {
    roomRead.current++;
    displayedRoomBatch.current = value;
    setRoomBatch(value);
  }
  const requester = task.requesterId === subjectId;
  const saved = task.contacts?.suggestions.items ?? [];
  const interested = [
    ...new Set<string>([
      ...(task.contacts?.responses.applications ?? [])
        .filter(a => a.state === 'pending')
        .map(a => a.subjectId),
      ...(task.contacts?.responses.invitations ?? [])
        .filter(i => i.state === 'interested')
        .map(i => i.recipientId),
      ...(task.participations ?? [])
        .filter(p =>
          ['active', 'delivered', 'accepted', 'disputed'].includes(p.state),
        )
        .map(p => p.subjectId),
      ...((task.participations ?? []).some(
        p =>
          p.subjectId === subjectId &&
          ['active', 'delivered', 'accepted', 'disputed'].includes(p.state),
      )
        ? [task.requesterId]
        : []),
    ]),
  ].filter((id) => id !== subjectId);
  const names=useMemberNames(runtime,subjectId,connected,[...candidates.map(item=>item.subjectId),...saved.map(item=>item.subjectId),...interested,...(batch?.items??[]).map(item=>item.subjectId),...rooms.flatMap(room=>(room.members??[]).map(member=>member.subjectId)),...roomProgress.flatMap(progress=>progress.unavailable?[]:[...progress.current.members.map(member=>member.subjectId),...progress.invitations.map(item=>item.subjectId)])]);
  const name=(id:string)=>names[id]??candidates.find(item=>item.subjectId===id)?.displayName??memberName(id);
  useEffect(()=>{if(inviteReview&&batch)inviteDialog.current?.showModal();else inviteDialog.current?.close();},[inviteReview,batch]);
  useEffect(()=>{if(roomReview&&roomBatch)roomDialog.current?.showModal();else roomDialog.current?.close();},[roomReview,roomBatch]);
  const toggled = (items: string[], id: string) =>
    items.includes(id) ? items.filter((value) => value !== id) : [...items, id];
  async function reloadLocal(lease = active.current) {
    const intent = batchIntent.current, ticket = ++batchRead.current;
    const roomsIntent = roomIntent.current, roomsTicket = ++roomRead.current;
    const [a, b] = await Promise.all([client.pending(), client.pendingRooms()]);
    if (currentView(lease)) {
      if (intent === batchIntent.current && ticket === batchRead.current) displayBatch(a);
      if (roomsIntent === roomIntent.current && roomsTicket === roomRead.current) displayRoomBatch(b);
    }
  }
  async function run(fn: (lease: number) => Promise<unknown>) {
    if (working.current) return;
    const lease = active.current;
    const operation = ++operationSequence.current;
    working.current = operation;
    let actionFailed = false;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn(lease);
      if (currentView(lease)) {
        await reloadLocal(lease);
        if (currentView(lease)) await refresh();
      }
    } catch (reason:unknown) {
      actionFailed = true;
      if (currentView(lease))
        setError(contactMessage(reason,'联系操作暂未完成，请查询原操作后再继续。'));
    } finally {
      try {
        if (currentView(lease)) await reloadLocal(lease);
      } catch (reason: unknown) {
        const message = reason !== null && (typeof reason === 'object' || typeof reason === 'function') && 'message' in reason ? reason.message : undefined;
        if (currentView(lease) && !actionFailed)
          setError(typeof message === 'string' && message.trim() ? message : '联系人回执暂未读取成功，请查询原操作后再继续。');
      } finally {
        // A pending read may finish after a task or binding change. Only this
        // exact operation can release its lock; the new view owns its own work.
        if (working.current === operation) {
          working.current = 0;
          if (currentView(lease)) setBusy(false);
        }
      }
    }
  }
  async function lookup(lease: number, type: SearchType | null = null) {
    const old = pages.find((page) => page.type === type),
      functionsList = functions
        .split(/[,，\n]/)
        .map((value) => value.trim())
        .filter(Boolean);
    const result = await client.search(task, {
      keyword,
      functions: functionsList,
      only: type,
      after: type && old?.nextCursor ? { [type]: old.nextCursor } : {},
    });
    if (!currentView(lease)) return;
    const merged = type
      ? pages.map((page) =>
          page.type === type
            ? { ...result[0], items: [...page.items, ...result[0].items] }
            : page,
        )
      : result;
    setPages(merged);
    const nextCandidates:ContactCandidate[]=contactCandidates(merged,subjectId);
    setCandidates(previous=>nextCandidates.map(item=>{
      const draft=type&&previous.find(old=>old.subjectId===item.subjectId);
      return draft?{...item,help:draft.help,basis:draft.basis,conditions:draft.conditions}:item;
    }));
    setSelected(previous=>type?previous.filter(id=>nextCandidates.some(item=>item.subjectId===id)):[]);
    setQueried(true);
  }
  async function loadRooms(lease: number, after = '') {
    let result;
    try {
      result = await client.rooms(after);
    } catch (reason) {
      if (currentView(lease)) {
        setRooms([]);
        setRoomProgress([]);
        setRoomsLoaded(false);
      }
      throw reason;
    }
    if (!currentView(lease)) return;
    setRooms((old) =>
      after
        ? [
            ...new Map(
              [...old, ...result.rooms].map((room) => [room.roomId, room]),
            ).values(),
          ]
        : result.rooms,
    );
    setScan((old) => (after ? old + result.scanned : result.scanned));
    setNext(result.next);
    setRoomsLoaded(true);
    const progress = await client.roomProgress();
    if (currentView(lease)) setRoomProgress(progress);
  }
  const loadLocal=useEffectEvent((lease:number)=>reloadLocal(lease));
  const showReadError=useEffectEvent((reason:unknown,lease:number)=>{if(currentView(lease))setError(contactMessage(reason,'任务联系人状态暂未读取成功，请稍后重试。'));});
  useEffect(()=>{
    const epoch=active;epoch.current++;
    const lease=epoch.current;if(connected)void loadLocal(lease).catch(reason=>showReadError(reason,lease));
    return()=>{epoch.current++;client.close();preparationClient.close();};
  },[client,preparationClient,connected]);
  useEffect(()=>runtime.onTaskOperationStopped((event:{scopeTaskId:string})=>{
    if(event.scopeTaskId===task.taskId){const lease=active.current;void loadLocal(lease).catch(reason=>showReadError(reason,lease));}
  }),[runtime,task.taskId]);
  const restoreContacts=useEffectEvent(async()=>{
    if(!connected||section!=='contacts'||!requester||lookedUp.current)return;lookedUp.current=true;
    const lease=active.current;
    try{
      const prepared:TaskPreparation|null=await preparationClient.resume(task);
      if(!currentView(lease))return;
      if(!prepared){await lookup(lease);return;}
      setKeyword(prepared.input.keyword);setFunctions(prepared.input.functions.join(','));
      setPages(prepared.pages);setCandidates(prepared.candidates);setSelected(prepared.selected);setQueried(true);
      setNotice(`已接回发布前在这台设备准备的候选与理由，当前可读来源已重新核对。${prepared.withheld?`有 ${prepared.withheld} 条来源已变化或不可读取，未展示原正文。`:''}尚未保存建议或发出邀请。`);
    }catch(reason){showReadError(reason,lease);}
  });
  useEffect(()=>{void restoreContacts();},[connected,requester,section]);
  const restoreRooms=useEffectEvent(()=>{const lease=active.current;return loadRooms(lease).catch(reason=>showReadError(reason,lease));});
  useEffect(()=>{if(connected&&section==='rooms')void restoreRooms();},[connected,section]);
  useEffect(()=>{
    if(!connected)return;let mounted=true,reading=false;
    const refresh=()=>{
      if(!mounted||reading||working.current||document.visibilityState!=='visible'||active.current<1)return;
      reading=true;const lease=active.current;
      void loadLocal(lease).catch(reason=>{if(mounted)showReadError(reason,lease);}).finally(()=>{reading=false;});
    };
    const timer=window.setInterval(refresh,20000);document.addEventListener('visibilitychange',refresh);
    return()=>{mounted=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[connected,section]);
  function update(id: string, field: 'help'|'basis'|'conditions', value: string) {
    setCandidates((items) =>
      items.map((item) =>
        item.subjectId === id ? { ...item, [field]: value } : item,
      ),
    );
  }
  async function prepare(items: {subjectId:string;help:string}[]) {
    const lease = active.current, intent = ++batchIntent.current;
    const prepared = await client.prepareInvites(
      items.map((item) => ({ subjectId: item.subjectId, note: item.help })),
    );
    if (currentView(lease) && intent === batchIntent.current) {
      displayBatch(prepared);
      setInviteReview(true);
    }
  }
  async function sendInvitations(lease:number){
    if(!batch)return;const shownId=batch.batchId,intent=++batchIntent.current;
    const result=await client.sendInvites({confirmed:true,batchId:shownId});
    if(currentView(lease)&&intent===batchIntent.current&&displayedBatch.current?.batchId===shownId){displayBatch(result);setInviteReview(false);setNotice('邀请结果已更新，可以查看每位参与者的状态。');}
  }
  async function prepareRoomPlan(lease:number){
    const intent=++roomIntent.current,prepared=await client.prepareRooms(mode,roomChoices);
    if(currentView(lease)&&intent===roomIntent.current){displayRoomBatch(prepared);setRoomReview(true);}
  }
  async function sendRoomPlan(lease:number){
    if(!roomBatch)return;const shownId=roomBatch.batchId,intent=++roomIntent.current,result=await client.sendRooms({confirmed:true,batchId:shownId});
    if(currentView(lease)&&intent===roomIntent.current&&displayedRoomBatch.current?.batchId===shownId){displayRoomBatch(result);setRoomReview(false);setRoomCreating(false);await loadRooms(lease);}
  }
  async function refreshRoomPlan(roomId:string,lease:number){
    const intent=++roomIntent.current,prepared=await client.refreshRoomPlan(roomId);
    if(currentView(lease)&&intent===roomIntent.current){displayRoomBatch(prepared);setRoomReview(true);}
  }
  // Hide the previous scope at the first DOM commit, before passive effects
  // clear its private drafts and receipts. Async guards alone cannot do this.
  if (!connected) return null;
  return <section className="task-contact-workspace">
    {error&&<p className="message error" role="alert">{error}</p>}
    {notice&&<output className="message">{notice}</output>}
    {requester&&section==='contacts'&&<>
      <p>查看已有经历或本人公开的交流意愿，再决定向谁发出邀请。</p>
      {!!saved.length&&<nav className="workspace-tabs" aria-label="联系建议"><button aria-current={contactView==='current'?'page':undefined} onClick={()=>setContactView('current')}>当前可见的人</button><button aria-current={contactView==='saved'?'page':undefined} onClick={()=>setContactView('saved')}>已保存的选择（{saved.length}）</button></nav>}
      {contactView==='current'?<>
        <form className="workspace-form contact-search" onSubmit={event=>{event.preventDefault();void run(lease=>lookup(lease));}}>
          <label htmlFor={fieldId+'-keyword'}>经历关键词<Input id={fieldId+'-keyword'} maxLength={200} value={keyword} onChange={event=>setKeyword(event.target.value)} placeholder="例如：手机端阅读、测试"/></label>
          <label htmlFor={fieldId+'-functions'}>想交流的功能<Input id={fieldId+'-functions'} value={functions} onChange={event=>setFunctions(event.target.value)} placeholder="例如：自动化测试、任务协作"/></label>
          <Button type="submit" disabled={busy}>查找</Button>
        </form>
        <p className="record-meta">关键词与功能都可留空；多个词用逗号分开。{task.request.capabilityId?'当前经历范围：'+task.request.capabilityId+'。':''}</p>
        {pages.filter(page=>page.error).map(page=><p key={page.type} className="message error">{page.type==='history'?'工作经历':'交流意愿'}暂未读取：{page.error}</p>)}
        {queried&&!candidates.length&&<p className="empty-state">当前可见范围没有找到联系人。可以换一组词，或继续等待这次求助的参与申请。</p>}
        <div className="contact-candidate-list">{candidates.map(candidate=><article className="contact-candidate" key={candidate.subjectId}>
          <label className="contact-choice"><input type="checkbox" checked={selected.includes(candidate.subjectId)} onChange={()=>setSelected(toggled(selected,candidate.subjectId))}/><MemberAvatar subjectId={candidate.subjectId}/><span><strong>{name(candidate.subjectId)}</strong><small>{candidate.willingness??'是否愿意参加这次工作，需要本人回应。'}</small></span></label>
          {(task.contacts?.responses.applications??[]).some(item=>item.subjectId===candidate.subjectId)&&<p className="record-meta">已经申请参与这次求助，可以在参与申请中查看。</p>}
          <div className="contact-source-list">{candidate.sources.map(source=><section key={source.item.type+source.item.id}>
            <h4>{source.item.title}</h4><p className="reading-prose">{source.item.summary}</p>
            <details className="technical-details"><summary>查看原始记录与版本</summary><p>来源中的角色：{candidate.roles.map((role:string)=>(roleLabels[role]??role)).join('、')}</p><p>{source.item.ref.id} · 第 {source.item.ref.version} 版</p><pre className="code-block">{JSON.stringify(source.item.record,null,2)}</pre></details>
          </section>)}</div>
          {selected.includes(candidate.subjectId)&&<div className="workspace-form contact-note-editor">
            <label htmlFor={fieldId+'-help-'+candidate.subjectId}>想请对方帮什么<Textarea id={fieldId+'-help-'+candidate.subjectId} maxLength={1500} value={candidate.help} onChange={event=>update(candidate.subjectId,'help',event.target.value)}/></label>
            <label htmlFor={fieldId+'-basis-'+candidate.subjectId}>为什么选择这个人<Textarea id={fieldId+'-basis-'+candidate.subjectId} maxLength={1500} value={candidate.basis} onChange={event=>update(candidate.subjectId,'basis',event.target.value)}/></label>
            <label htmlFor={fieldId+'-conditions-'+candidate.subjectId}>还需要确认什么<Textarea id={fieldId+'-conditions-'+candidate.subjectId} maxLength={1500} value={candidate.conditions} onChange={event=>update(candidate.subjectId,'conditions',event.target.value)}/></label>
          </div>}
        </article>)}</div>
        {pages.filter(page=>page.nextCursor).map(page=><Button key={page.type} variant="outline" disabled={busy} onClick={()=>void run(lease=>lookup(lease,page.type))}>更多{page.type==='history'?'工作经历':'交流意愿'}</Button>)}
        {!!selected.length&&<div className="button-row contact-selection-actions"><Button disabled={busy} onClick={()=>run(()=>prepare(candidates.filter(item=>selected.includes(item.subjectId))))}>预览邀请（{selected.length}）</Button><Button variant="outline" disabled={busy} onClick={()=>run(async lease=>{await client.saveSuggestions(candidates.filter(item=>selected.includes(item.subjectId)),{confirmed:true});if(currentView(lease))setNotice('已保存所选联系人与理由，只有你能看到。');})}>保存选择与理由</Button></div>}
      </>:<>
        <p className="record-meta">这是你保存时的选择依据；对方当前是否愿意参与，以本人回应为准。</p>
        <div className="contact-candidate-list">{saved.map(item=><article className="contact-candidate" key={item.subjectId}>
          <label className="contact-choice"><input type="checkbox" checked={savedSelected.includes(item.subjectId)} onChange={()=>setSavedSelected(toggled(savedSelected,item.subjectId))}/><MemberAvatar subjectId={item.subjectId}/><strong>{name(item.subjectId)}</strong></label>
          <h4>希望获得的帮助</h4><p className="reading-prose">{item.help}</p><h4>选择理由</h4><p className="reading-prose">{item.basis}</p><h4>仍需确认</h4><p className="reading-prose">{item.conditions}</p>
          <details className="technical-details"><summary>保存时的准确引用</summary><ul>{item.sourceRefs.map((ref:string)=><li key={ref}><code>{ref}</code></li>)}</ul></details>
        </article>)}</div>
        {!!savedSelected.length&&<Button disabled={busy} onClick={()=>run(()=>prepare(saved.filter(item=>savedSelected.includes(item.subjectId))))}>预览邀请（{savedSelected.length}）</Button>}
      </>}
      {batch&&<section className="operation-status">
        <h4>这次邀请</h4>{batch.items.map(item=><p key={item.eventId}>{name(item.subjectId)} · {labels[item.state]??item.state}{item.error?' · '+item.error:''}</p>)}
        <Button variant="outline" disabled={busy} onClick={()=>setInviteReview(true)}>查看邀请内容与结果</Button>
      </section>}
    </>}
    {section==='rooms'&&<>
      {!roomCreating?<section>
        {interested.length>0&&<div className="section-heading"><Button disabled={busy} onClick={()=>setRoomCreating(true)}>邀请参与者讨论</Button></div>}
        <div className="reading-list">{rooms.map(room=><article className="reading-list-item task-room-row" key={room.roomId}><button className="reading-title-link" onClick={()=>navigate('/app/rooms/'+room.roomId)}>{room.title}</button><p className="record-meta">{room.members.length} 位成员 · {room.members.map(member=>name(member.subjectId)).join('、')}</p></article>)}</div>
        {!rooms.length&&<p className="empty-state">{roomsLoaded?'这里还没有你可以进入的任务讨论。':'正在读取任务讨论…'}</p>}
        <div className="button-row">{next&&<Button variant="outline" disabled={busy} onClick={()=>run(lease=>loadRooms(lease,next))}>更多讨论</Button>}<button className="text-link" onClick={()=>navigate('/app/rooms')}>查看全部消息</button></div>
        <details className="technical-details"><summary>当前读取范围</summary><p>已核对本人 {scan} 个成员讨论。{next?'还有下一页。':roomsLoaded?'当前列表已读完。':'正在核对访问范围。'}</p><button className="text-link" disabled={busy} onClick={()=>run(lease=>loadRooms(lease))}>重新读取</button></details>
      </section>:<section className="workspace-form room-arrangement-editor">
        <button className="back-link" onClick={()=>setRoomCreating(false)}>← 回到任务讨论</button><h3>与谁开始讨论？</h3>
        <fieldset><legend>选择参与者</legend>{interested.map(id=><label className="contact-choice" key={id}><input type="checkbox" checked={roomChoices.includes(id)} onChange={()=>setRoomChoices(toggled(roomChoices,id))}/><MemberAvatar subjectId={id}/><strong>{name(id)}</strong></label>)}</fieldset>
        <label>沟通方式<select value={mode} onChange={event=>setMode(event.target.value)}><option value="">选择沟通方式</option><option value="separate">分别交流</option><option value="together">一起讨论</option></select></label>
        <p>{mode==='together'?'新讨论只包含以后在这里发送的内容。受邀者自行决定是否加入，后续邀请还需要当前成员共同同意。':mode==='separate'?'你与每位受邀者各自建立讨论，互相看不到其他讨论的内容。':'可以各自交流，也可以一起讨论。'}</p>
        <Button disabled={busy||!mode||!roomChoices.length} onClick={()=>run(prepareRoomPlan)}>预览讨论安排</Button>
      </section>}
      {roomBatch&&<section className="operation-status" data-room-batch-id={roomBatch.batchId}><h4>当前讨论安排</h4>{roomBatch.rooms.map(entry=><article key={entry.input.roomId}><p>{entry.input.title} · {labels[entry.state]??entry.state}</p>{entry.created&&<button className="text-link" onClick={()=>navigate('/app/rooms/'+entry.input.roomId)}>打开讨论</button>}{entry.error&&<p className="message error">{entry.error}</p>}</article>)}<Button variant="outline" disabled={busy} onClick={()=>setRoomReview(true)}>查看安排与邀请</Button></section>}
      {roomProgress.length>0&&<section className="room-invitation-progress"><h4>邀请进展</h4>{roomProgress.map(progress=><article className="contact-candidate" key={progress.roomId}>{progress.unavailable?<p>这项讨论当前不可读取。</p>:<><p>{rooms.find(room=>room.roomId===progress.roomId)?.title??'任务讨论'}</p><p className="record-meta">当前成员：{progress.current.members.map(member=>name(member.subjectId)).join('、')}</p>{progress.invitations.map(invitation=><p key={invitation.subjectId}>{name(invitation.subjectId)} · {invitation.joined?'已加入':invitation.state==='members-changed'?'成员已变化，需重新确认邀请':invitation.state==='rejected'?'已婉拒':invitation.state==='pending'?'等待当前成员同意':invitation.state==='approved'?'等待本人接受':invitation.state}</p>)}{progress.invitations.some(invitation=>!invitation.joined&&invitation.state!=='rejected')&&<Button variant="outline" disabled={busy} onClick={()=>run(lease=>refreshRoomPlan(progress.roomId,lease))}>查看下一步邀请</Button>}</>}</article>)}</section>}
    </>}
    <dialog ref={inviteDialog} className="workspace-dialog" onCancel={event=>{if(busy)event.preventDefault();else setInviteReview(false);}}>
      {inviteReview&&batch&&<><header className="dialog-heading"><span>逐人邀请</span><button className="icon-button" aria-label="关闭邀请预览" disabled={busy} onClick={()=>setInviteReview(false)}>×</button></header><p>每位受邀者分别收到下面对应的内容，自行决定是否参与。</p>
        {batch.items.map(item=><article className="invite-preview-row" key={item.eventId}><div className="member-line"><MemberAvatar subjectId={item.subjectId}/><h3>{name(item.subjectId)}</h3></div><p className="reading-prose">{item.note}</p><p className="record-meta">{labels[item.state]??item.state} · 有效至 {readableTime(item.expiresAt)}</p>{item.error&&<p className="message error">{item.error}</p>}{item.state==='queued'&&<button className="text-link" disabled={busy} onClick={()=>run(async lease=>{const shownId=batch.batchId,intent=++batchIntent.current,stopped=await client.stopUnsent(item.eventId);if(currentView(lease)&&intent===batchIntent.current&&displayedBatch.current?.batchId===shownId)displayBatch(stopped);})}>取消这位尚未发送的邀请</button>}</article>)}
        {error&&<p className="message error" role="alert">{error}</p>}
        {batch.items.some(item=>!['acknowledged','stopped-unsent','stopped-local'].includes(item.state))&&<Button disabled={busy} onClick={()=>run(sendInvitations)}>{batch.confirmed?'继续这次邀请':'发送以上邀请'}</Button>}
        <Button variant="outline" disabled={busy} onClick={()=>setInviteReview(false)}>返回</Button>
      </>}
    </dialog>
    <dialog ref={roomDialog} className="workspace-dialog" onCancel={event=>{if(busy)event.preventDefault();else setRoomReview(false);}}>
      {roomReview&&roomBatch&&<><header className="dialog-heading"><span>{roomBatch.mode==='separate'?'分别交流':'一起讨论'}</span><button className="icon-button" aria-label="关闭讨论安排预览" disabled={busy} onClick={()=>setRoomReview(false)}>×</button></header>
        {roomBatch.rooms.map(entry=><article className="invite-preview-row" key={entry.input.roomId}><h3>{entry.input.title}</h3><p className="record-meta">{labels[entry.state]??entry.state}</p>{entry.invitations.map(invitation=><p key={invitation.decisionId}>{name(invitation.subjectId)} · {labels[invitation.state]??invitation.state}{invitation.receipt?'，等待本人决定是否加入':''}</p>)}{entry.error&&<p className="message error">{entry.error}</p>}</article>)}
        <p>这次安排使用上面列出的讨论和参与者。每个人接受邀请后才会加入。</p>
        {error&&<p className="message error" role="alert">{error}</p>}
        <div className="button-row">{roomBatch.rooms.some(entry=>entry.state!=='acknowledged')&&<Button disabled={busy} onClick={()=>run(sendRoomPlan)}>确认并继续邀请</Button>}<Button variant="outline" disabled={busy} onClick={()=>setRoomReview(false)}>返回</Button></div>
        {roomBatch.rooms.every(entry=>!entry.created&&entry.state==='queued'&&entry.invitations.every(invitation=>invitation.state==='queued'&&!invitation.input))&&<button className="text-link" disabled={busy} onClick={()=>run(async lease=>{const shownId=roomBatch.batchId,intent=++roomIntent.current;await client.cancelPreparedRooms({batchId:shownId});if(currentView(lease)&&intent===roomIntent.current&&displayedRoomBatch.current?.batchId===shownId){displayRoomBatch(null);setRoomReview(false);setNotice('已取消这次尚未发送的安排。');}})}>取消这次尚未发送的安排</button>}
      </>}
    </dialog>
  </section>;
}
