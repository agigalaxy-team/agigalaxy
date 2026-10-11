import {independentTaskLabel} from './task-material-client.mjs';
import React, { useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ArrowLeft, ArrowUp, ArrowUpRight, FileText, MessageCircle, MoreHorizontal, Plus, Search, Send, X } from 'lucide-react';
import { PersonalSummaryWorkspace } from './personal-summary-workspace';
import { ChatAgentWorkspace } from './chat-agent-workspace';
import { AgentParticipants } from './agent-participants';
import { ChatAttachmentComposer, ChatAttachmentFiles } from './chat-attachments-workspace';
import { OutcomeMaterialWorkspace } from './outcome-material-workspace';
import { ContactOriginWorkspace } from './contact-origin-workspace';
import { AccountVerificationPrompt, needsAccountVerification } from './account-verification-prompt';
import { MemberAvatar, memberName, useMemberNames, MessageNavigation, readableTime } from './conversation-ui';
import {ConversationInvite} from './conversation-invite';
import {useChoiceViewLease,type ChoiceViewLease} from './choice-retained-operations';
import {chatErrorCode,chatMessageAvailable,availableChatMessages,nextChatMessageExpiry,type ChatRuntime,type ChatRoom,type ChatDecision,type ChatMessage,type ChatPending,type ChatHistory,type ChatProposal,type ChatLinkedTask,type ChatAttachmentReference,type ChatAction} from './chat-workspace-types';

const labels: Record<string, string> = { invite: '邀请成员', remove: '移除成员', retention: '修改消息保留时间', 'become-owner': '设立房主', 'transfer-owner': '房主接任', 'successor-owner':'接任房主', 'appoint-admin':'设置管理员', 'revoke-admin':'取消管理员', 'join-rule':'更改加入方式', persistent: '长期对话设置', dissolve: '解散对话', pending: '等待回应', approved: '等待本人接受', accepted: '已生效', applied: '已生效', rejected: '已拒绝', cancelled: '已取消', stale: '成员已变化', expired: '已过期' };
function currentDecisionState(decision:ChatDecision){return decision.effectiveState??decision.state;}
function decisionState(decision:ChatDecision){const state=currentDecisionState(decision);if(decision.action==='invite'&&state==='accepted')return '已加入';if(decision.action==='invite'&&state==='approved')return '等待对方回应';return labels[state]??'状态暂时无法显示';}
function decisionDescription(decision:ChatDecision,name:(id?:string)=>string){
  const target=name(decision.payload?.targetSubjectId);
  switch(decision.action){
    case 'invite':return `邀请${target}加入`;
    case 'remove':return `移出${target}`;
    case 'retention':return `消息保留 ${decision.payload.retentionDays} 天`;
    case 'persistent':return decision.payload.persistent?'设为长期对话':'关闭长期对话';
    case 'become-owner':return `由${target}担任房主`;
    case 'transfer-owner':case 'successor-owner':return `由${target}接任房主`;
    case 'appoint-admin':return `由${target}担任管理员`;
    case 'revoke-admin':return `取消${target}的管理员身份`;
    default:return labels[decision.action]??'对话调整';
  }
}
function decisionAcceptLabel(decision:ChatDecision){return decision.action==='invite'?'加入对话':decision.action==='appoint-admin'?'接受管理员邀请':decision.action==='become-owner'?'担任房主':'接任房主';}
function decisionUnavailable(decision:ChatDecision){
  const reason=currentDecisionState(decision)==='pending'?decision.actionReasons?.approve:decision.actionReasons?.accept;
  if(reason==='account_verification_required')return '验证账号后即可接受。';
  if(reason==='chat_room_read_only')return '对话目前不能更改设置。';
  if(reason==='chat_succession_unavailable')return '接任期限已过。';
  if(reason==='chat_membership_changed')return '成员已变化，这次请求不再生效。';
  if(reason==='chat_decision_expired'||reason==='chat_invitation_expired')return '这次请求已过期。';
  if(!decision.actionReasons)return '暂时无法读取可执行的操作。';
  return '当前条件已变化，暂时无法同意这次请求。';
}
function messagePreview(item:ChatMessage|null|undefined,now:number){if(!item)return '先前的消息';if(!chatMessageAvailable(item,now))return '原消息已到期，当前不可读取';if(item.state==='retracted')return '这条消息已撤回';if(item.sharedSummaryId)return '分享了一份交流笔记';if(item.kind&&item.kind!=='text')return '暂不支持这种消息类型';return typeof item.text==='string'?item.text:'消息当前不可读';}
type Props = { runtime: ChatRuntime|null; roomId?: string; connected: boolean; subjectId?: string; navigate: (path: string) => void; needIdentity: () => void };
export function ChatWorkspace(props: Props) {
  const scope=useChoiceViewLease(props.runtime,props.subjectId);
  if(!props.runtime||!props.connected||!props.subjectId||!scope.lease)return <section className="messages-page"><h1 className="small">消息</h1><MessageNavigation active="rooms" navigate={props.navigate} /><div className="conversation-empty"><MessageCircle size={36} /><h2>接着上一次交流</h2><p>登录后查看你的对话和邀请。</p><Button disabled={!props.runtime} onClick={props.needIdentity}>登录并继续</Button></div></section>;
  return <ChatWorkspaceSession key={JSON.stringify([scope.key,props.roomId??'directory'])} {...props} runtime={props.runtime} subjectId={props.subjectId} lease={scope.lease}/>;
}
type SessionProps=Omit<Props,'runtime'|'subjectId'>&{runtime:ChatRuntime;subjectId:string;lease:ChoiceViewLease};
function ChatWorkspaceSession({ runtime, roomId, connected, subjectId, navigate, lease: viewLease }: SessionProps) {
  const [rooms, setRooms] = useState<ChatRoom[]>([]), [invitations, setInvitations] = useState<ChatDecision[]>([]), [room, setRoom] = useState<ChatRoom|null>(null);
  const [messageReading, setMessageReading] = useState<ChatMessage[]>([]), [decisions, setDecisions] = useState<ChatDecision[]>([]), [pending, setPending] = useState<ChatPending|null>(null);
  const [clock,setClock]=useState(()=>Date.now());
  const messages=availableChatMessages(messageReading,clock);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setErrorMessage] = useState(''), [notice, setNotice] = useState('');
  const [verificationRequired, setVerificationRequired] = useState(false);
  const [title, setTitle] = useState(''), [text, setText] = useState(''), [retention, setRetention] = useState<7|30|90>(90);
  const [keyword, setKeyword] = useState(''), [filter, setFilter] = useState(''), [after, setAfter] = useState('0'), [next, setNext] = useState<string | null>(null);
  const [earlier, setEarlier] = useState<string | null>(null);
  const [action, setAction] = useState<ChatAction|null>(null), [reply, setReply] = useState<ChatMessage|null>(null), [edit, setEdit] = useState<(ChatMessage&{draft:string})|null>(null);
  const [panel, setPanel] = useState<'members' | 'shared' | 'search' | null>(null), [createOpen, setCreateOpen] = useState(false);
  const [selectedSharedId, setSelectedSharedId] = useState<string | undefined>(), [locatedMessage, setLocatedMessage] = useState<string | undefined>();
  const [selectedAttachments, setSelectedAttachments] = useState<ChatAttachmentReference[]>([]), [linkedTasks, setLinkedTasks] = useState<ChatLinkedTask[]>([]);
  const [roomNext, setRoomNext] = useState<string | null>(null), [draftReady, setDraftReady] = useState(false), [readRefresh, setReadRefresh] = useState(0);
  const active = useRef(0), readEpoch = useRef(0), working = useRef(false), recovering = useRef(false), scrollEnd = useRef(true), firstRead = useRef(true);
  const historyBox = useRef<HTMLDivElement>(null), composer = useRef<HTMLTextAreaElement>(null), panelDialog = useRef<HTMLDialogElement>(null), actionDialog = useRef<HTMLDialogElement>(null);
  const prepend = useRef<{ height: number; top: number } | null>(null), readCursor = useRef('0');
  const roomPages=useRef(1),oldestLoaded = useRef<string | null>(null), earlierRequested = useRef(false), hasEarlier = useRef(false);
  const roomPath = `/v2/chat/rooms/${roomId}`, fieldId=useId();
  const mounted=useRef(false),draftHead=useRef<unknown>(null),draftTail=useRef<Promise<unknown>>(Promise.resolve());
  const current=useCallback((token=active.current)=>{try{viewLease.assertCurrent();return mounted.current&&token===active.current;}catch{return false;}},[viewLease]);
  function setError(reason: unknown) {
    const code = chatErrorCode(reason)??'';
    setErrorMessage(typeof reason === 'string' ? reason : ({ chat_transport_unavailable: '暂时无法发送，消息已保留，连接恢复后会继续。', chat_access_denied: '你目前无法查看这段对话或进行这项操作。', connection_required: '连接已到期，请重新连接后继续。', account_verification_required: '开始或加入对话前，需要验证账号。', chat_revision_conflict: '设置刚刚发生变化，请按最新内容重试。', chat_membership_changed:'成员已变化，请按当前成员重新提出请求。', chat_decision_expired:'这次请求已过期。', chat_invitation_expired:'这份邀请已过期。', chat_decision_unavailable:'这次请求已处理或当前不能继续。', chat_two_party_removal_forbidden: '两人对话不能移除另一方，可以退出对话。' } as Record<string, string>)[code] ?? '暂时无法完成，请稍后重试。');
    setVerificationRequired(needsAccountVerification(reason));
  }
  async function reload(appendAfter?: string) {
    if (!connected||!current()) return;
    const lease = active.current, ticket=++readEpoch.current;
    if (!roomId) {
      const [list, invites, saved]: [{rooms:ChatRoom[];next:string|null},{invitations:ChatDecision[]},ChatPending|null] = await Promise.all([runtime.api.call('/v2/chat/rooms/query', appendAfter ? { after: appendAfter } : {}), runtime.api.call('/v2/chat/invitations/query', {}), runtime.chat.pending(null)]);
      if (!current(lease) || ticket!==readEpoch.current) return;
      const rows=[...list.rooms];let roomCursor=list.next;
      if(appendAfter)roomPages.current++;else for(let page=1;page<roomPages.current&&roomCursor;page++){
        const more:{rooms:ChatRoom[];next:string|null}=await runtime.api.call('/v2/chat/rooms/query',{after:roomCursor});if(!current(lease)||ticket!==readEpoch.current)return;
        if(more.next===roomCursor)throw Error('对话分页暂时无法继续，请保留当前位置。');rows.push(...more.rooms);roomCursor=more.next;
      }
      setRooms(old => appendAfter ? [...new Map([...old, ...rows].map(item => [item.roomId, item])).values()] : rows);
      setRoomNext(roomCursor); setInvitations(invites.invitations); setPending(saved);
    } else {
      const [currentRoom, choices, saved]: [ChatRoom,{decisions:ChatDecision[]},ChatPending|null] = await Promise.all([runtime.api.call(roomPath + '/read', {}), runtime.api.call(roomPath + '/decisions', {}), runtime.chat.pending(roomId)]).catch(reason => { if (current(lease) && ticket === readEpoch.current) { setRoom(null); setMessageReading([]); setLinkedTasks([]); } throw reason; });
      if (!current(lease) || ticket!==readEpoch.current) return;
      setRoom(currentRoom); setDecisions(choices.decisions); setPending(saved);
      const links = await Promise.all<ChatLinkedTask>((currentRoom.taskRefs ?? []).map(async (id: string) => { try { const task = await runtime.api.call(`/v2/tasks/${id}`, null, { method: 'GET', authenticated: true }); return { id, title: independentTaskLabel(task), caseId:task.caseId, available: true }; } catch { return { id, available: false }; } }));
      if (!current(lease) || ticket!==readEpoch.current) return;
      setLinkedTasks(links);
      if (!filter && !locatedMessage && runtime.chat.latestHistory) {
        const minimum=oldestLoaded.current,wantsEarlier=earlierRequested.current;
        let page:ChatHistory=await runtime.chat.latestHistory(roomId,{limit:50});if(!current(lease)||ticket!==readEpoch.current)return;
        const pages=[page];
        while(minimum&&page.previous&&BigInt(page.previous)>BigInt(minimum)){
          page=await runtime.chat.latestHistory(roomId,{before:page.previous,limit:50});pages.push(page);
          if(!current(lease)||ticket!==readEpoch.current)return;
        }
        let floor=minimum??pages[0].messages[0]?.sequence??null,more=minimum?hasEarlier.current:!!pages[0].previous;
        if(wantsEarlier&&minimum){const previous:ChatHistory=await runtime.chat.latestHistory(roomId,{before:minimum,limit:50});pages.push(previous);floor=previous.messages[0]?.sequence??minimum;more=!!previous.previous;}
        if (!current(lease) || ticket!==readEpoch.current) return;
        const values = [...new Map(pages.flatMap(page => page.messages).filter((item)=>!floor||BigInt(item.sequence)>=BigInt(floor)).map((item) => [item.messageId, item])).values()];
        values.sort((left, right) => BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1);
        oldestLoaded.current=floor;hasEarlier.current=more;earlierRequested.current=false;
        setMessageReading(values); setEarlier(more?floor:null); setNext(null);
      } else {
        const page:ChatHistory = await runtime.api.call(roomPath + '/history', { after, limit: 50, ...(filter ? { keyword: filter } : {}) });
        if (!current(lease) || ticket!==readEpoch.current) return;
        setMessageReading(page.messages); setNext(page.next); setEarlier(null);
      }
    }
    if (current(lease)&&ticket===readEpoch.current) { setLoading(false); setErrorMessage(''); }
  }
  async function propose(input:ChatProposal) {
    if(!roomId||!room||!current())throw Error('请重新打开这段对话。');
    const token=active.current,result:ChatDecision=await runtime.chat.propose(roomId,{expectedRevision:room.revision,...input},{confirmed:true});
    if(current(token)&&input.action!=='invite')setNotice(['applied','accepted'].includes(result.state)?'设置已保存。':'已发出，等待相关成员回应。');return result;
  }
  function clearSubmitted(saved:ChatPending['input']){
    setText(value=>value===saved.text?'':value);
    setReply(value=>value?.messageId===saved.replyTo?null:value);
    setSelectedAttachments(value=>JSON.stringify(value)===JSON.stringify(saved.attachments??[])?[]:value);
  }
  async function resumePending(stillCurrent:()=>boolean=()=>true){
    const token=active.current;if(!current(token)||!stillCurrent())return;
    const saved:ChatPending|null=await runtime.chat.pending(roomId??null);if(!current(token)||!stillCurrent())return;
    const result:{roomId?:string;state?:string}=await runtime.chat.resumePending(roomId??null);if(!current(token)||!stillCurrent())return;
    if(!roomId&&result.roomId){navigate(`/app/rooms/${result.roomId}`);return;}
    if(roomId&&saved?.path.endsWith('/send')&&result.state==='accepted')clearSubmitted(saved.input);
  }
  function showLatest() { setFilter(''); setKeyword(''); setLocatedMessage(undefined); oldestLoaded.current=null;earlierRequested.current=false;hasEarlier.current=false;scrollEnd.current = true; firstRead.current = true; setReadRefresh(value => value + 1); }
  async function send(selectedAt:number){
    if(!roomId||!current()||reply&&!chatMessageAvailable(reply,selectedAt))return;const token=active.current,selected={text,replyTo:reply?.messageId??null,attachments:selectedAttachments};
    await draftTail.current;if(!current(token))return;
    await runtime.chat.send(roomId,selected.text,{confirmed:true,replyTo:selected.replyTo,attachments:selected.attachments});
    if(!current(token))return;clearSubmitted(selected);showLatest();composer.current?.focus();
  }
  async function run<T>(operation: (check:()=>boolean) => Promise<T>, refreshAfter = true):Promise<T|undefined> {
    if (working.current||!current()) return;
    working.current = true; setBusy(true); setErrorMessage(''); setNotice(''); const token = active.current,check=()=>current(token);
    try {const result=await operation(check);if(check()&&refreshAfter)await reload();return check()?result:undefined;}
    catch(reason){if(check())setError(reason);return undefined;}
    finally{
      if(check()){try{const saved:ChatPending|null=await runtime.chat.pending(roomId??null);if(check())setPending(saved);}catch{/* Preserve the last pending state. */}}
      working.current=false;if(check())setBusy(false);
    }
  }
  const loadDraft=useEffectEvent(async()=>{
    if(!roomId||!current())return;const token=active.current;
    const draft:unknown=await runtime.getLocal(`chat-draft:${roomId}`,subjectId);if(!current(token))return;
      if(draft!==null&&draft!==undefined&&typeof draft!=='string')throw Error('本机草稿格式暂时无法读取，请保留原稿。');
      draftHead.current=draft;setText(draft??'');setDraftReady(true);
  });
  useLayoutEffect(()=>{const generation=active,life=mounted;life.current=true;generation.current++;return()=>{life.current=false;generation.current++;};},[]);
  const draftFailure=useEffectEvent((reason:unknown)=>{if(current())setError(reason);});
  useEffect(()=>{void loadDraft().catch(draftFailure);},[runtime,roomId,subjectId]);
  const saveDraft=useEffectEvent((value:string)=>{
    if(!roomId||!draftReady||!current())return;
    const token=active.current;
    const saving=draftTail.current.then(async()=>{
      viewLease.assertCurrent();const expected=draftHead.current;
      await runtime.updateLocal(`chat-draft:${roomId}`,(raw:unknown)=>{
        viewLease.assertCurrent();if(raw!==expected)throw Error('另一页面已修改这份草稿，请保留本页文字后重新核对。');return value;
      },subjectId);
      viewLease.assertCurrent();draftHead.current=value;
    });
    draftTail.current=saving;void saving.catch(reason=>{if(current(token))setError(reason);});
  });
  useEffect(()=>{saveDraft(text);},[text,draftReady]);
  const poll=useEffectEvent(async(stillCurrent:()=>boolean)=>{
    if(!current()||!stillCurrent()||!connected||working.current||document.hidden)return;
    try{
      if(!recovering.current){recovering.current=true;try{await resumePending(stillCurrent);}catch{/* The original retry remains available. */}finally{recovering.current=false;}}
      if(current()&&stillCurrent())await reload();
    }catch(reason){if(current()&&stillCurrent()){setError(reason);setLoading(false);}}
  });
  useEffect(()=>{
    let stopped=false,reading=false;const epoch=readEpoch;
    const update=async()=>{if(stopped||reading)return;reading=true;try{await poll(()=>!stopped);}finally{reading=false;}};
    void update();const timer=setInterval(update,7000);document.addEventListener('visibilitychange',update);
    return()=>{stopped=true;clearInterval(timer);document.removeEventListener('visibilitychange',update);epoch.current++;};
  },[runtime,connected,roomId,filter,after,locatedMessage,readRefresh]);
  useEffect(() => {
    const box = historyBox.current; if (!box) return;
    if (prepend.current) { box.scrollTop = prepend.current.top + box.scrollHeight - prepend.current.height; prepend.current = null; }
    else if (locatedMessage) document.getElementById('chat-message-' + locatedMessage)?.scrollIntoView({ block: 'center' });
    else if (!filter && (firstRead.current || scrollEnd.current)) { box.scrollTop = box.scrollHeight; firstRead.current = false; }
  }, [messages, locatedMessage, filter]);
  useEffect(() => {
    if (!room || panel || action || document.hidden || !historyBox.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible=new Set<string>();
    const token=active.current;
    const flush = () => { if (document.hidden||!current(token)) return; const sequence=[...visible].reduce((max,value)=>BigInt(value)>BigInt(max)?value:max,readCursor.current);if(BigInt(sequence)<=BigInt(readCursor.current))return;runtime.api.call(roomPath + '/cursor', { kind: 'human', sequence }).then(() => { if (current(token)&&BigInt(sequence) > BigInt(readCursor.current)) readCursor.current = sequence; }).catch(() => {}); };
    const observer = new IntersectionObserver(entries => { for (const entry of entries) { const sequence = (entry.target as HTMLElement).dataset.readSequence;if(sequence){if(entry.isIntersecting)visible.add(sequence);else visible.delete(sequence);}}if(timer)clearTimeout(timer);timer=setTimeout(flush,750); }, { root: historyBox.current, threshold: 1 });
    historyBox.current.querySelectorAll('[data-read-sequence]').forEach(item => observer.observe(item));
    return () => { observer.disconnect(); if (timer) clearTimeout(timer); };
  }, [messages, room, runtime, roomPath, panel, action, current]);
  useEffect(() => { if (panel) panelDialog.current?.showModal(); else panelDialog.current?.close(); }, [panel]);
  useEffect(() => { if (action) actionDialog.current?.showModal(); else actionDialog.current?.close(); }, [action]);
  const replyExpired=!!reply&&!chatMessageAvailable(reply,clock),editExpired=!!edit&&!chatMessageAvailable(edit,clock);
  useEffect(()=>{const expiresAt=nextChatMessageExpiry([...messageReading,reply,edit],clock);if(expiresAt===null)return;const timer=window.setTimeout(()=>setClock(Date.now()),Math.min(2147483647,Math.max(0,expiresAt-Date.now()+1)));return()=>window.clearTimeout(timer);},[messageReading,reply,edit,clock]);
  const disabled = busy || !!pending || !draftReady || replyExpired || editExpired || ['archived', 'owner-succession'].includes(room?.state??'');
  const displayNames=useMemberNames(runtime,subjectId,connected,[...(room?.members??[]).map((item)=>item.subjectId),...messages.map(item=>item.subjectId),...decisions.flatMap(item=>[item.payload?.targetSubjectId,item.proposerSubjectId,item.myVote?.subjectId])]);
  const name = (id?: string) => memberName(id, subjectId, id?displayNames[id]??undefined:undefined);
  const currentDecisions=decisions.filter(item=>['pending','approved'].includes(currentDecisionState(item))),previousDecisions=decisions.filter(item=>!['pending','approved'].includes(currentDecisionState(item)));
  const renderDecision=(decision:ChatDecision)=>{
    const state=currentDecisionState(decision),responding=state==='pending',accepting=state==='approved'&&decision.payload.targetSubjectId===subjectId;
    const voted=responding&&decision.myVote?.choice==='approve';
    return <article className="member-decision" key={decision.decisionId}>
      <strong>{decisionDescription(decision,name)}</strong><span>{decisionState(decision)}</span>
      {decision.proposerSubjectId&&<p className="member-request-meta">{name(decision.proposerSubjectId)}提出</p>}
      {voted&&<p>{name(decision.myVote?.subjectId)}已同意，等待其他成员回应。</p>}
      {responding&&!decision.actionReasons&&<p>{decisionUnavailable(decision)}</p>}
      {responding&&decision.canApprove===false&&decision.canReject===true&&!voted&&<p>{decisionUnavailable(decision)}</p>}
      {responding&&<div className="button-row">
        {decision.canApprove===true&&!voted&&<Button disabled={busy||!!pending} onClick={()=>run(()=>runtime.api.call(roomPath+'/vote',{decisionId:decision.decisionId,choice:'approve'}))}>同意</Button>}
        {decision.canReject===true&&decision.canCancel!==true&&<Button variant="outline" disabled={busy||!!pending} onClick={()=>run(()=>runtime.api.call(roomPath+'/vote',{decisionId:decision.decisionId,choice:'reject'}))}>{voted?'改为不同意':'不同意'}</Button>}
        {decision.canCancel===true&&<Button variant="ghost" disabled={busy||!!pending} onClick={()=>run(()=>runtime.api.call(roomPath+'/vote',{decisionId:decision.decisionId,choice:'cancel'}))}>撤回我的请求</Button>}
      </div>}
      {accepting&&<>{decision.canAccept!==true&&<p>{decisionUnavailable(decision)}</p>}<AccountVerificationPrompt required={decision.actionReasons?.accept==='account_verification_required'} navigate={navigate}/><div className="button-row">
        {decision.canAccept===true&&<Button disabled={busy||!!pending} onClick={()=>run(()=>runtime.api.call(roomPath+'/accept',{decisionId:decision.decisionId,accept:true}))}>{decisionAcceptLabel(decision)}</Button>}
        {decision.canDecline===true&&<Button variant="ghost" disabled={busy||!!pending} onClick={()=>run(()=>runtime.api.call(roomPath+'/accept',{decisionId:decision.decisionId,accept:false}))}>婉拒</Button>}
      </div></>}
    </article>;
  };

  return <section className={'messages-page' + (roomId ? ' conversation-page' : '')} aria-busy={busy}>
    {!roomId && <><div className="page-heading"><h1 className="small">消息</h1><Button onClick={() => setCreateOpen(value => !value)}><Plus size={16} />发起对话</Button></div><MessageNavigation active="rooms" navigate={navigate} /></>}
    {roomId && <header className="conversation-header"><button className="icon-button" aria-label="返回对话列表" onClick={() => navigate('/app/rooms')}><ArrowLeft size={20} /></button><MemberAvatar subjectId={roomId} /><div className="conversation-title"><h1>{room?.title ?? (loading ? '正在打开对话…' : '对话暂不可用')}</h1>{room && <button onClick={() => setPanel('members')}>{room.members.length} 位成员 <span>· 查看成员</span></button>}</div><div className="conversation-tools"><button className="icon-button" aria-label="搜索对话" onClick={() => setPanel('search')}><Search size={19} /></button><button className="icon-button" aria-label="共享资料" onClick={() => setPanel('shared')}><FileText size={19} /></button><button className="icon-button" aria-label="对话设置" onClick={() => setPanel('members')}><MoreHorizontal size={22} /></button></div></header>}
    {error && <div className="message error" role="alert">{error}<AccountVerificationPrompt required={verificationRequired} navigate={navigate} /><Button variant="ghost" disabled={busy} onClick={() => setReadRefresh(value => value + 1)}>重试</Button></div>}
    {notice && <output className="conversation-notice">{notice}</output>}
    {pending && <output className="conversation-notice">正在继续上次操作，内容已保留。<Button variant="ghost" disabled={busy} onClick={() => run(()=>resumePending())}>重试</Button><Button variant="ghost" disabled={busy} onClick={()=>run(async(check)=>{await runtime.chat.stopRetry(roomId??null,{confirmed:true});if(check())setNotice('已停止本机重试；服务已收到的内容仍会显示。');})}>停止重试</Button></output>}
    {!roomId && <>
      {createOpen && <form className="new-conversation-form" onSubmit={event => { event.preventDefault(); void run(async (check) => { const created:{roomId:string} = await runtime.chat.create({ title, retentionDays: retention }, { confirmed: true }); if(check())navigate(`/app/rooms/${created.roomId}`); }); }}><label htmlFor={fieldId+"-title"}>聊点什么<Input id={fieldId+"-title"} required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder="给这段对话起个名字" /></label><div className="conversation-create-footer"><label>消息保留<select value={retention} onChange={event => setRetention(event.target.value==='7'?7:event.target.value==='30'?30:90)}><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option></select></label><Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>取消</Button><Button type="submit" disabled={busy || !!pending}>创建对话</Button></div></form>}
      {invitations.length > 0 && <section className="conversation-invitations"><h2>对话邀请</h2>{invitations.map(invite => <article key={invite.decisionId}><MemberAvatar subjectId={invite.roomId} /><div><h3>{invite.title}</h3><p>{invite.action==='invite'?'加入后可查看对话中仍保留的共享消息。':decisionAcceptLabel(invite)}</p>{invite.canAccept!==true&&<p>{decisionUnavailable(invite)}</p>}<AccountVerificationPrompt required={invite.actionReasons?.accept==='account_verification_required'} navigate={navigate}/><div className="button-row">{invite.canAccept===true&&<Button disabled={busy||!!pending} onClick={() => run(async (check) => { const result:{state:string;membershipActive?:boolean}=await runtime.api.call(`/v2/chat/rooms/${invite.roomId}/accept`, { decisionId: invite.decisionId, accept: true }); if(!check())return;if(result.state==='accepted'&&result.membershipActive!==false)navigate(`/app/rooms/${invite.roomId}`);else throw Error('这份邀请已处理，请查看当前对话。'); })}>{decisionAcceptLabel(invite)}</Button>}{invite.canDecline===true&&<Button variant="ghost" disabled={busy||!!pending} onClick={() => run(() => runtime.api.call(`/v2/chat/rooms/${invite.roomId}/accept`, { decisionId: invite.decisionId, accept: false }))}>婉拒</Button>}</div></div></article>)}</section>}
      {loading && !rooms.length && <output className="reading-status">正在读取对话…</output>}
      <div className="conversation-list">{rooms.map(item => <a href={`/app/rooms/${item.roomId}`} key={item.roomId} onClick={event => { event.preventDefault(); navigate(`/app/rooms/${item.roomId}`); }}><MemberAvatar subjectId={item.roomId} /><div><h2>{item.title}</h2><p>{item.members.length} 位成员{item.kind === 'ai-subzone' ? ' · AI 对话' : ''}</p></div><ArrowUpRight size={18} /></a>)}</div>
      {!loading && rooms.length === 0 && !error && !createOpen && <div className="conversation-empty"><MessageCircle size={36} /><h2>还没有对话</h2><p>从一个想法开始，邀请愿意交流的人。</p><Button variant="outline" onClick={() => setCreateOpen(true)}>发起第一段对话</Button></div>}
      {roomNext && <Button variant="outline" disabled={busy} onClick={() => run(() => reload(roomNext), false)}>查看更早的对话</Button>}
    </>}
    {room && <>
      {!!linkedTasks.length && <div className="conversation-context">{linkedTasks.map(item => item.available ? <a key={item.id} href={`/app/tasks/${item.id}`} onClick={event => { event.preventDefault(); navigate(`/app/tasks/${item.id}`); }}>继续：{item.title}<ArrowUpRight size={14} /></a> : <span key={item.id}>关联工作当前不可读取</span>)}</div>}
      {!room.transportAvailable && <div className="conversation-notice">暂时无法发送消息，已有草稿会保留。</div>}
      {(filter || locatedMessage) && <div className="conversation-search-result"><span>{filter ? `搜索：${filter}` : '已定位相关消息'}</span><button onClick={showLatest}>返回最新对话 <X size={14} /></button></div>}
      <div ref={historyBox} className="conversation-history" aria-label="对话消息" onScroll={() => { const box = historyBox.current; if (box) scrollEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < 90; }}>
        {earlier && <button className="conversation-earlier" disabled={busy} onClick={() => { const box = historyBox.current; if (box) prepend.current = { height: box.scrollHeight, top: box.scrollTop }; earlierRequested.current=true;setReadRefresh(value=>value+1); }}><ArrowUp size={14} />查看更早消息</button>}
        {messages.map(item => <article id={'chat-message-' + item.messageId} data-sequence={item.sequence} className={'conversation-message' + (item.subjectId === subjectId ? ' own' : '') + (item.messageId === locatedMessage ? ' located' : '')} key={item.messageId}><MemberAvatar subjectId={item.subjectId} own={item.subjectId === subjectId} /><div className="conversation-message-content"><header><span>{name(item.subjectId)}{item.actorKind === 'agent' && <small>AI</small>}</span><time dateTime={item.sentAt}>{readableTime(item.sentAt)}{item.editedAt ? ' · 已编辑' : ''}</time></header><div className={'message-bubble' + (item.state === 'retracted' ? ' retracted' : '')}>{item.replyTo && <blockquote>{messagePreview(messages.find(value => value.messageId === item.replyTo),clock).slice(0,140)}</blockquote>}<p>{messagePreview(item,clock)}</p><ChatAttachmentFiles runtime={runtime} items={item.attachments??[]} />{item.sharedSummaryId && <button className="shared-message-link" onClick={() => { setSelectedSharedId(item.sharedSummaryId??undefined); setPanel('shared'); }}>打开交流笔记 <ArrowUpRight size={14} /></button>}{item.sharedSummaryId&&<details className="shared-message-origin"><summary>原始消息详情</summary><p>{item.text}</p><code>{item.sharedSummaryId}</code></details>}<span className="chat-read-marker" data-read-sequence={item.sequence} aria-hidden="true" /></div>{item.text && <div className="conversation-message-actions"><button onClick={() => { setReply(item); composer.current?.focus(); }}>回复</button>{item.subjectId === subjectId && <>{!item.sharedSummaryId && <button onClick={() => { setEdit({ ...item, draft: item.text??'' }); composer.current?.focus(); }}>编辑</button>}<button onClick={() => setAction({ kind: 'retract', messageId: item.messageId })}>撤回</button></>}<button onClick={() => run(() => runtime.api.call(`${roomPath}/messages/${item.messageId}/hide`, { hidden: true }))}>隐藏</button></div>}</div></article>)}
        {!messages.length && <div className="conversation-empty"><MessageCircle size={29} /><p>{loading ? '正在读取消息…' : filter ? '没有找到这些内容，换一个词试试。' : '开始说点什么吧。'}</p></div>}
        {next && <button className="conversation-earlier" onClick={() => setAfter(next)}>继续查看匹配消息</button>}
      </div>
      <form className="conversation-compose" onSubmit={event => { event.preventDefault(); void run(edit ? async (check) => { if(!roomId||!chatMessageAvailable(edit,Date.now()))return;const selected=edit;await runtime.chat.edit(roomId,selected.messageId,{expectedRevision:selected.revision,text:selected.draft},{confirmed:true});if(check())setEdit(value=>value===selected?null:value); } : ()=>send(Date.now())); }}>
        {(reply || edit) && <div className="compose-context"><span>{edit ? '编辑消息' : `回复 ${name(reply?.subjectId)}`}<small>{(editExpired?'原消息已到期；本机修改文字仍保留。':edit?.text??messagePreview(reply,clock)).slice(0,120)}</small></span><button type="button" aria-label={edit ? '取消编辑' : '取消回复'} onClick={() => { setReply(null); setEdit(null); }}><X size={16} /></button></div>}
        <Textarea ref={composer} aria-label={edit ? '编辑消息内容' : '消息'} required maxLength={16000} disabled={disabled} value={edit ? edit.draft : text} onChange={event => edit ? setEdit({ ...edit, draft: event.target.value }) : setText(event.target.value)} placeholder={room.state === 'archived' ? '这段对话已结束' : '写一条消息…'} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div className="compose-tools"><div>{!edit && <ChatAttachmentComposer key={roomId} runtime={runtime} roomId={roomId!} disabled={disabled} selected={selectedAttachments} onChange={setSelectedAttachments} />}</div><span className="compose-shortcut">Ctrl / ⌘ + Enter 发送</span><Button type="submit" disabled={disabled || !(edit?.draft ?? text).trim()}><Send size={16} />{edit ? '保存' : busy ? '发送中…' : '发送'}</Button></div>
      </form>
    </>}
    <dialog ref={panelDialog} className="conversation-panel" onClose={event => {if(event.target===event.currentTarget)setPanel(null);}} aria-labelledby="conversation-panel-title"><header><h2 id="conversation-panel-title">{panel === 'members' ? '成员与设置' : panel === 'shared' ? '共享资料' : '搜索对话'}</h2><button className="icon-button" aria-label="关闭面板" onClick={() => setPanel(null)}><X size={20} /></button></header>
      {panel === 'search' && <form className="conversation-search-form" onSubmit={event => { event.preventDefault(); setAfter('0'); setLocatedMessage(undefined); setFilter(keyword.trim()); setPanel(null); scrollEnd.current = false; }}><label htmlFor={fieldId+"-search"}>查找消息<Input id={fieldId+"-search"} value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="输入关键词" /></label><Button type="submit">搜索</Button></form>}
      {panel === 'shared' && room && <div className="conversation-shared"><nav className="panel-sections"><a href="#shared-background">背景与关键消息</a><a href="#shared-results">文件与结果</a></nav><section id="shared-background" aria-label="背景与关键消息"><PersonalSummaryWorkspace runtime={runtime} room={room} subjectId={subjectId} connected={connected} navigate={navigate} messages={messages} selectedSharedId={selectedSharedId} onLocate={source => { setAfter(String(BigInt(source.sequence) > 0n ? BigInt(source.sequence) - 1n : 0n)); setFilter(''); setKeyword(''); setLocatedMessage(source.messageId); setPanel(null); setReadRefresh(value => value + 1); }} /></section><section id="shared-results"><h3>文件与结果</h3><OutcomeMaterialWorkspace onReturnToConversation={()=>setPanel(null)} runtime={runtime} subjectId={subjectId} connected={connected} roomId={roomId} messages={messages} memberIds={room.members.map((member)=>member.subjectId)} linkedCases={linkedTasks.flatMap(item=>item.available&&item.caseId?[{caseId:item.caseId,taskId:item.id,title:item.title}]:[])} /></section><ContactOriginWorkspace runtime={runtime} subjectId={subjectId} connected={connected} navigate={navigate} roomId={room.roomId} /></div>}
      {panel === 'members' && room && <div className="conversation-settings"><section><h3>对话成员</h3><ul className="member-list">{room.members.map((member) => <li key={member.subjectId}><MemberAvatar subjectId={member.subjectId} /><div><strong>{name(member.subjectId)}{member.subjectId === room.ownerSubjectId ? ' · 房主' : ''}</strong><details className="technical-details"><summary>银河 ID</summary><small>{member.subjectId}</small></details></div></li>)}</ul>{subjectId&&<ConversationInvite runtime={runtime} subjectId={subjectId} room={room} decisions={decisions} externalError={error} disabled={busy||!!pending||['archived','owner-succession'].includes(room.state)} onInvite={async(targetSubjectId,decisionId)=>{return run(()=>propose({action:'invite',targetSubjectId,decisionId}));}}/>}</section>
        {error&&<p className="message error" role="alert">{error}</p>}
        {currentDecisions.length>0&&<section><h3>成员请求</h3>{currentDecisions.map(renderDecision)}</section>}
        {previousDecisions.length>0&&<section><details className="member-change-history"><summary>以前的成员变更</summary>{previousDecisions.map(renderDecision)}</details></section>}
        <section><h3>AI 参与</h3><AgentParticipants runtime={runtime} roomId={room.roomId} /><ChatAgentWorkspace key={room.roomId} runtime={runtime} room={room} navigate={navigate} /></section>
        <section><h3>对话设置</h3><p>当前消息保留 {room.retentionDays} 天。更改只影响后续消息。</p><div className="button-row"><select aria-label="消息保留时间" value={retention} onChange={event => setRetention(event.target.value==='7'?7:event.target.value==='30'?30:90)}><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option></select><Button variant="outline" disabled={busy || !!pending} onClick={() => run(() => propose({ action: 'retention', retentionDays: retention }))}>更改保留时间</Button></div><Button variant="ghost" disabled={busy || !!pending} onClick={() => run(() => propose({ action: 'persistent', persistent: !room.persistent }))}>{room.persistent ? '关闭长期对话' : '设为长期对话'}</Button>{room.decisionRequired && <div className="message"><p>其他成员已退出。你可以保留这段对话。</p><Button variant="outline" disabled={busy} onClick={() => run(() => runtime.api.call(roomPath + '/dismiss', {}))}>继续保留</Button><Button variant="ghost" disabled={busy || !!pending} onClick={() => run(() => propose({ action: 'become-owner', targetSubjectId: subjectId }))}>成为房主</Button></div>}</section>
        <section className="conversation-leave"><Button variant="ghost" onClick={() => navigate('/app/governance?targetType=room&targetId=' + room.roomId)}>举报这段对话</Button><Button variant="ghost" disabled={busy || !!pending} onClick={() => setAction({ kind: 'dissolve' })}>发起解散</Button><Button variant="outline" disabled={busy} onClick={() => setAction({ kind: 'leave' })}>退出对话</Button></section>
      </div>}
    </dialog>
    <dialog ref={actionDialog} className="conversation-confirm" onClose={() => setAction(null)} aria-labelledby="conversation-confirm-title"><h2 id="conversation-confirm-title">{action?.kind === 'leave' ? '退出这段对话？' : action?.kind === 'retract' ? '撤回这条消息？' : '解散这段对话？'}</h2><p>{action?.kind === 'leave' ? '退出后，再次查看消息需要重新获得邀请。' : action?.kind === 'retract' ? '成员将无法继续读取这条消息。' : '这会向相关成员发出解散请求。'}</p><div className="button-row"><Button variant="ghost" onClick={() => setAction(null)}>取消</Button><Button disabled={busy} onClick={() => run(async (check) => {if(!action)return;const selected=action;if(selected.kind==='leave'){await runtime.api.call(roomPath+'/leave',{});if(check())navigate('/app/rooms');}else if(selected.kind==='retract')await runtime.api.call(`${roomPath}/messages/${selected.messageId}/retract`,{});else await propose({action:'dissolve'});if(check())setAction(value=>value===selected?null:value);})}>{action?.kind === 'leave' ? '退出对话' : action?.kind === 'retract' ? '撤回消息' : '发出请求'}</Button></div></dialog>
  </section>;
}
