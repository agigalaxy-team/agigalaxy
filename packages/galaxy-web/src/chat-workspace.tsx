import {independentTaskLabel} from './task-material-client.mjs';
import React, { useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FileText, MessageCircle, MoreHorizontal, Plus, Search, X } from 'lucide-react';
import { PersonalSummaryWorkspace } from './personal-summary-workspace';
import { ChatAgentWorkspace } from './chat-agent-workspace';
import {AgentWorkContinuation} from './agent-work-continuation';
import { AgentParticipants } from './agent-participants';
import { ChatAttachmentComposer, ChatAttachmentFiles } from './chat-attachments-workspace';
import { OutcomeMaterialWorkspace } from './outcome-material-workspace';
import { ContactOriginWorkspace } from './contact-origin-workspace';
import { AccountVerificationPrompt, needsAccountVerification } from './account-verification-prompt';
import { MemberAvatar, MemberLink, memberName, useMemberNames, MessageNavigation, readableTime } from './conversation-ui';
import {ConversationInvite} from './conversation-invite';
import {ConversationStart} from './conversation-start';
import {ChatDraftRecovery,useChatComposeDraft} from './chat-compose-ui';
import type {ChatMessageLocator} from './chat-compose-draft';
import {chatReadingState,chatSearchParams,chatSearchString} from './chat-reading-position';
import {useChoiceViewLease,type ChoiceViewLease} from './choice-retained-operations';
import {chatErrorCode,chatMessageAvailable,availableChatMessages,nextChatMessageExpiry,type ChatRuntime,type ChatRoom,type ChatDirectoryRoom,type ChatDirectory,type ChatContext,type ChatDecision,type ChatMessage,type ChatPending,type ChatHistory,type ChatProposal,type ChatLinkedTask,type ChatAttachmentReference,type ChatAction} from './chat-workspace-types';
import {chatDay,continuesChatMessage} from './chat-content-visuals';
import './chat-workspace.css';
import './selected-messages.css';
import {ReadingDetails,ReadingSummary} from './reading-details';

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
  if(reason==='account_verification_required')return '关联银河账户后即可接受。';
  if(reason==='chat_room_read_only')return '对话目前不能更改设置。';
  if(reason==='chat_succession_unavailable')return '接任期限已过。';
  if(reason==='chat_membership_changed')return '成员已变化，这次请求不再生效。';
  if(reason==='chat_decision_expired'||reason==='chat_invitation_expired')return '这次请求已过期。';
  if(!decision.actionReasons)return '暂时无法读取可执行的操作。';
  return '当前条件已变化，暂时无法同意这次请求。';
}
function messagePreview(item:ChatMessage|null|undefined,now:number){if(!item)return '先前的消息';if(!chatMessageAvailable(item,now))return '原消息已到期，当前不可读取';if(item.state==='retracted')return '这条消息已撤回';if(item.sharedSummaryId)return '分享了一份交流笔记';if(item.kind&&item.kind!=='text')return '暂不支持这种消息类型';return typeof item.text==='string'?item.text:'消息当前不可读';}
function rejectionMessage(code?:string){return({chat_revision_conflict:'原消息已在别处更新，修改文字仍保留。',chat_edit_window_closed_use_correction:'这条消息已超过可编辑时间，可以把修改作为新消息发出。',chat_message_unavailable:'原消息目前不能修改，输入仍保留。',chat_access_denied:'你目前不能执行这项操作，输入仍保留。',chat_room_read_only:'这段对话目前不能发送或修改消息。',account_verification_required:'关联银河账户后可以继续这次操作。',chat_edit_pending_reconcile_first:'刚才的修改还在确认，原文字仍保留。'} as Record<string,string>)[code??'']??'这次操作尚未完成，原内容仍保留。';}
function readDeadline(value:number|undefined){if(typeof value!=='number'||!Number.isFinite(value)||value<=0)throw Error('暂时无法确认消息的读取范围，请稍后再试。');return value;}
function ConversationSidebar({runtime,subjectId,lease,roomId,navigate}:{runtime:ChatRuntime;subjectId:string;lease:ChoiceViewLease;roomId:string;navigate:(path:string)=>void}){
 const [rows,setRows]=useState<ChatDirectoryRoom[]>([]),[next,setNext]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[query,setQuery]=useState(''),[clock,setClock]=useState(()=>Date.now());
 const pages=useRef(1),live=useRef(false),inFlight=useRef<number|null>(null),version=useRef(0),readAgain=useRef<()=>void>(()=>{});
 const names=useMemberNames(runtime,subjectId,true,rows.flatMap(item=>[...item.members.map(member=>member.subjectId),item.latestMessage?.subjectId]));
 const title=(item:ChatDirectoryRoom)=>item.title==='对话'?(item.members.filter(member=>member.subjectId!==subjectId).map(member=>memberName(member.subjectId,subjectId,names[member.subjectId]??undefined)).slice(0,3).join('、')||'新的对话'):item.title;
 const canRead=useCallback(()=>{try{lease.assertCurrent();return live.current;}catch{return false;}},[lease]);
 const read=useCallback(async(cursor?:string)=>{
  if(!canRead()||inFlight.current!==null||navigator.onLine===false)return;
  const token=++version.current;inFlight.current=token;setBusy(true);
  try{
   const first:ChatDirectory=await runtime.chat.directory(cursor?{cursor}:{});if(!canRead()||token!==version.current)return;
   const values=[...first.rooms];let after=first.nextCursor;const seen=new Set<string>();
   if(!cursor)for(let page=1;page<pages.current&&after;page++){if(seen.has(after))throw Error('对话列表暂时无法继续读取。');seen.add(after);const more:ChatDirectory=await runtime.chat.directory({cursor:after});if(!canRead()||token!==version.current)return;values.push(...more.rooms);after=more.nextCursor;}
   const now=Date.now(),available=values.filter(item=>readDeadline(item.readExpiresAt)*1000>now);
   if(cursor)pages.current++;
   setRows(previous=>cursor?[...new Map([...previous.filter(item=>item.readExpiresAt*1000>now),...available].map(item=>[item.roomId,item])).values()]:available);setNext(after);setError('');setClock(now);
  }catch{if(canRead()&&token===version.current){setRows([]);setNext(null);setError('对话列表暂时未读到。');}}
  finally{if(inFlight.current===token)inFlight.current=null;if(canRead()&&token===version.current)setBusy(false);}
 },[runtime,canRead]);
 useEffect(()=>{
  const life=live,sequence=version,flight=inFlight;life.current=true;
  const refresh=()=>{if(!document.hidden)void read();};
  const lost=()=>{sequence.current++;flight.current=null;setRows([]);setNext(null);setBusy(false);setError('连接恢复后重新读取对话。');};
  readAgain.current=refresh;
  const initial=window.setTimeout(refresh,0),timer=window.setInterval(refresh,30000);
  window.addEventListener('online',refresh);window.addEventListener('offline',lost);document.addEventListener('visibilitychange',refresh);
  return()=>{life.current=false;sequence.current++;flight.current=null;window.clearTimeout(initial);window.clearInterval(timer);window.removeEventListener('online',refresh);window.removeEventListener('offline',lost);document.removeEventListener('visibilitychange',refresh);};
 },[read]);
 useEffect(()=>{if(!rows.length)return;const deadlines=rows.map(item=>item.readExpiresAt*1000).filter(value=>value>clock),messageExpiry=nextChatMessageExpiry(rows.map(item=>item.latestMessage).filter((item):item is ChatMessage=>!!item),clock);if(messageExpiry!==null)deadlines.push(messageExpiry);if(!deadlines.length)return;const timer=window.setTimeout(()=>{const now=Date.now();setClock(now);setRows(previous=>previous.filter(item=>item.readExpiresAt*1000>now));readAgain.current();},Math.min(2147483647,Math.max(0,Math.min(...deadlines)-Date.now()+1)));return()=>window.clearTimeout(timer);},[rows,clock]);
 const shown=rows.filter(item=>!query.trim()||title(item).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 return <aside className="selected-conversation-directory" aria-label="对话列表"><header><h2>消息</h2><button type="button" onClick={()=>navigate('/app/rooms?compose=conversation')}>发起对话</button></header><MessageNavigation active="rooms" navigate={navigate}/><label className="selected-conversation-search"><Search size={17}/><input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="查找对话" aria-label="查找已读取的对话"/></label>{error&&<p role="alert">{error}<button type="button" onClick={()=>void read()}>重试</button></p>}<div className="conversation-list">{shown.map(item=><a key={item.roomId} href={'/app/rooms/'+item.roomId} aria-current={item.roomId===roomId?'page':undefined} onClick={event=>{if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate('/app/rooms/'+item.roomId);}}}><MemberAvatar subjectId={item.members.find(member=>member.subjectId!==subjectId)?.subjectId??item.roomId} name={names[item.members.find(member=>member.subjectId!==subjectId)?.subjectId??'']??undefined}/><div><div className="conversation-row-heading"><h3>{title(item)}</h3><time>{readableTime(item.lastActivityAt)}</time></div><p className="conversation-last-message">{item.latestMessage?messagePreview(item.latestMessage,clock):'暂无可读消息预览'}</p></div>{!!item.unreadHumanCount&&<span className="conversation-unread">{item.unreadHumanCount>99?'99+':item.unreadHumanCount}</span>}</a>)}</div>{busy&&!rows.length&&<output>正在读取对话…</output>}{!busy&&!error&&!shown.length&&<p className="selected-directory-empty">{query?'已读取的对话中没有这个名称。':'还没有其他对话。'}</p>}{query&&next&&<p className="selected-directory-empty">当前仅查找已读取的对话。</p>}{next&&<button type="button" className="text-link" disabled={busy} onClick={()=>void read(next)}>更多对话</button>}</aside>;
}

type Props = { runtime: ChatRuntime|null; roomId?: string; search?:string; connected: boolean; subjectId?: string; navigate: (path: string) => void; needIdentity: () => void; registerShellNavigation?:(lease:ChoiceViewLease,handler:(path:string)=>void,leaveAction:(action:()=>void)=>void)=>()=>void };
export function ChatWorkspace(props: Props) {
  const scope=useChoiceViewLease(props.runtime,props.subjectId);
  if(!props.runtime||!props.connected||!props.subjectId||!scope.lease)return <section className="messages-page selected-message-guest"><h2 className="message-module-title">消息</h2><MessageNavigation active="rooms" navigate={props.navigate} /><h1 className="small message-page-title">{props.roomId?'对话详情':new URLSearchParams(props.search??'').get('compose')==='conversation'?'发起对话':'全部对话'}</h1><div className="conversation-empty"><MessageCircle size={36} /><h2>接着上一次交流</h2><p>用本机银河接回对话与邀请。</p><Button disabled={!props.runtime} onClick={props.needIdentity}>继续对话</Button></div></section>;
  return <ChatWorkspaceSession key={JSON.stringify([scope.key,props.roomId??'directory'])} {...props} runtime={props.runtime} subjectId={props.subjectId} lease={scope.lease}/>;
}
type SessionProps=Omit<Props,'runtime'|'subjectId'>&{runtime:ChatRuntime;subjectId:string;lease:ChoiceViewLease};
function ChatWorkspaceSession({ runtime, roomId, search='', connected, subjectId, navigate, lease: viewLease, registerShellNavigation }: SessionProps) {
  const [reading]=useState(()=>chatReadingState(runtime.api.endpoint,subjectId,roomId));
  const initialParams=chatSearchParams(search),searchRef=useRef(search),restorePosition=useRef(reading.read(search)),locateOnce=useRef(true);
  const contextWindows=useRef<string[]>(reading.read(search)?.contexts?.filter(value=>typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value))??[]);
  const draft=useChatComposeDraft(runtime,subjectId,roomId??'directory');
  const text=draft.value.text,selectedAttachments=draft.value.attachments,replyLocator=draft.value.reply,editDraft=draft.value.edit;
  const setText=(value:string)=>draft.change({text:value}),setSelectedAttachments=(value:ChatAttachmentReference[])=>draft.change({attachments:value});
  const [rooms, setRooms] = useState<ChatDirectoryRoom[]>([]), [invitations, setInvitations] = useState<ChatDecision[]>([]), [room, setRoom] = useState<ChatRoom|null>(null);
  const [messageReading, setMessageReading] = useState<ChatMessage[]>([]), [decisions, setDecisions] = useState<ChatDecision[]>([]), [pending, setPending] = useState<ChatPending|null>(null);
  const [references,setReferences]=useState<Record<string,ChatMessage|null>>({}),[offline,setOffline]=useState(()=>navigator.onLine===false);
  const [readExpiresAt,setReadExpiresAt]=useState<number|null>(null),[targetState,setTargetState]=useState<string>('available');
  const [clock,setClock]=useState(()=>Date.now());
  const messages=availableChatMessages(messageReading,clock);
  const reply=replyLocator?references[replyLocator.messageId]??messages.find(item=>item.messageId===replyLocator.messageId):null;
  const edit=editDraft?references[editDraft.messageId]??messages.find(item=>item.messageId===editDraft.messageId):null;
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setErrorMessage] = useState(''), [notice, setNotice] = useState('');
  const [verificationRequired, setVerificationRequired] = useState(false);
  const [retention, setRetention] = useState<7|30|90>(90);
  const [keyword, setKeyword] = useState(()=>reading.read(search)?.keyword??initialParams.keyword), [filter, setFilter] = useState(initialParams.keyword), [after, setAfter] = useState(initialParams.after), [next, setNext] = useState<string | null>(null);
  const [earlier, setEarlier] = useState<string | null>(null);
  const [action, setAction] = useState<ChatAction|null>(null);
  const [panel, setPanel] = useState<'members' | 'shared' | 'search' | null>(null), [createOpen, setCreateOpen] = useState(()=>new URLSearchParams(search).get('compose')==='conversation');
  const [selectedSharedId, setSelectedSharedId] = useState<string | undefined>(), [locatedMessage, setLocatedMessage] = useState<string | undefined>(initialParams.message);
  const [linkedTasks, setLinkedTasks] = useState<ChatLinkedTask[]>([]);
  const [attachmentsReady,setAttachmentsReady]=useState(false);
  const [roomNext, setRoomNext] = useState<string | null>(null), [readRefresh, setReadRefresh] = useState(0);
  const active = useRef(0), readEpoch = useRef(0), working = useRef(false), recovering = useRef(false), scrollEnd = useRef(true), firstRead = useRef(true);
  const historyBox = useRef<HTMLDivElement>(null), composer = useRef<HTMLTextAreaElement>(null), panelDialog = useRef<HTMLDialogElement>(null), actionDialog = useRef<HTMLDialogElement>(null);
  const prepend = useRef<{ height: number; top: number } | null>(null), readCursor = useRef('0'),readMessageIds=useRef(new Set<string>());
  const roomPages=useRef(1),oldestLoaded = useRef<string | null>(reading.read(search)?.floor??null), earlierRequested = useRef(false), hasEarlier = useRef(false);
  const roomPath = `/v2/chat/rooms/${roomId}`, fieldId=useId();
  const mounted=useRef(false);
  const current=useCallback((token=active.current)=>{try{viewLease.assertCurrent();return mounted.current&&token===active.current;}catch{return false;}},[viewLease]);
  const rememberPosition=useCallback(()=>{
    const box=historyBox.current;if(!box)return;const bounds=box.getBoundingClientRect(),item=Array.from(box.querySelectorAll<HTMLElement>('[data-message-id]')).find(element=>element.getBoundingClientRect().bottom>bounds.top+5);
    reading.write(searchRef.current,{floor:oldestLoaded.current,anchor:item?{messageId:item.dataset.messageId!,offset:item.getBoundingClientRect().top-bounds.top}:null,top:box.scrollTop,keyword,contexts:contextWindows.current});
  },[reading,keyword]);
  function leaveTo(destination:string|(()=>void)){rememberPosition();const token=active.current;void draft.flush().then(()=>{if(current(token)){if(typeof destination==='string')navigate(destination);else destination();}}).catch(()=>{if(current(token)){setErrorMessage('本机暂时无法保存这份输入，请留在本页重新保存后继续。');composer.current?.focus({preventScroll:true});}});}
  const navigationHandler=useRef<(destination:string|(()=>void))=>void>(()=>{});
  useLayoutEffect(()=>{navigationHandler.current=leaveTo;});
  useLayoutEffect(()=>draft.ready?registerShellNavigation?.(viewLease,path=>navigationHandler.current(path),action=>navigationHandler.current(action)):undefined,[registerShellNavigation,viewLease,roomId,search,draft.ready]);
  function changeView(nextSearch:string,remember=true){rememberPosition();if(remember&&nextSearch!==searchRef.current)reading.remember(nextSearch,searchRef.current);navigate(`/app/rooms/${roomId}${nextSearch}`);}
  function locateMessage(messageId:string){changeView(chatSearchString({keyword:filter,after,message:messageId}));setPanel(null);}
  function returnReading(){const previous=reading.back(searchRef.current);changeView(previous??(locatedMessage&&filter?chatSearchString({keyword:filter,after}):''),false);}
  useLayoutEffect(()=>{
    if(searchRef.current===search)return;const params=chatSearchParams(search);searchRef.current=search;restorePosition.current=reading.read(search);locateOnce.current=true;oldestLoaded.current=restorePosition.current?.floor??null;earlierRequested.current=false;hasEarlier.current=false;firstRead.current=true;scrollEnd.current=!params.keyword&&!params.message&&!restorePosition.current;readEpoch.current++;
    contextWindows.current=restorePosition.current?.contexts??[];setFilter(params.keyword);setKeyword(restorePosition.current?.keyword??params.keyword);setAfter(params.after);setLocatedMessage(params.message);setMessageReading([]);setLoading(true);setReadRefresh(value=>value+1);
  },[search,reading]);
  useEffect(()=>{const save=()=>rememberPosition();window.addEventListener('pagehide',save);return()=>{window.removeEventListener('pagehide',save);};},[rememberPosition]);
  function setError(reason: unknown) {
    if(navigator.onLine===false){setErrorMessage('已离线。输入仍保留，连接恢复后会继续。');return;}
    const code = chatErrorCode(reason)??'';
    setErrorMessage(typeof reason === 'string' ? reason : ({ chat_transport_unavailable: '暂时无法发送，消息已保留，连接恢复后会继续。', chat_access_denied: '你目前无法查看这段对话或进行这项操作。', connection_required: '连接已到期，请重新连接后继续。', account_verification_required: '开始或加入对话前，需要关联银河账户。', chat_revision_conflict: '设置刚刚发生变化，请按最新内容重试。', chat_membership_changed:'成员已变化，请按当前成员重新提出请求。', chat_decision_expired:'这次请求已过期。', chat_invitation_expired:'这份邀请已过期。', chat_decision_unavailable:'这次请求已处理或当前不能继续。', chat_two_party_removal_forbidden: '两人对话不能移除另一方，可以退出对话。' } as Record<string, string>)[code] ?? (/[\u3400-\u9fff]/.test(code)?code:'暂时无法完成，请稍后重试。'));
    setVerificationRequired(needsAccountVerification(reason));
  }
  function clearControlled(){setMessageReading([]);setReferences({});setRooms([]);setInvitations([]);setDecisions([]);setLinkedTasks([]);setRoom(null);setReadExpiresAt(null);}
  async function reload(appendAfter?: string) {
    if (!connected||!current()) return;
    const lease = active.current, ticket=++readEpoch.current;
    if (!roomId) {
      const [list, invites, saved]:[ChatDirectory,{invitations:ChatDecision[]},ChatPending|null] = await Promise.all([runtime.chat.directory(appendAfter?{cursor:appendAfter}:{}), runtime.api.call('/v2/chat/invitations/query', {}), runtime.chat.pending(null)]);
      if (!current(lease) || ticket!==readEpoch.current) return;
      const rows=[...list.rooms];let roomCursor=list.nextCursor;const cursors=new Set<string>();
      if(appendAfter)roomPages.current++;else for(let page=1;page<roomPages.current&&roomCursor;page++){
        if(cursors.has(roomCursor))throw Error('暂时无法继续读取更早的对话。');cursors.add(roomCursor);
        const more:ChatDirectory=await runtime.chat.directory({cursor:roomCursor});if(!current(lease)||ticket!==readEpoch.current)return;
        rows.push(...more.rooms);roomCursor=more.nextCursor;
      }
      setRooms(old => appendAfter ? [...new Map([...old, ...rows].map(item => [item.roomId, item])).values()] : rows);
      setRoomNext(roomCursor); setInvitations(invites.invitations); setPending(saved);setReadExpiresAt(rows.length?Math.min(...rows.map(item=>readDeadline(item.readExpiresAt))):null);
    } else {
      const [currentRoom, choices, saved]: [ChatRoom,{decisions:ChatDecision[]},ChatPending|null] = await Promise.all([runtime.api.call(roomPath + '/read', {}), runtime.api.call(roomPath + '/decisions', {}), runtime.chat.pending(roomId)]).catch(reason => { if (current(lease) && ticket === readEpoch.current) { setRoom(null); setMessageReading([]); setLinkedTasks([]); } throw reason; });
      if (!current(lease) || ticket!==readEpoch.current) return;
      setRoom(currentRoom); setDecisions(choices.decisions); setPending(saved);
      const links = await Promise.all<ChatLinkedTask>((currentRoom.taskRefs ?? []).map(async (id: string) => { try { const task = await runtime.api.call(`/v2/tasks/${id}`, null, { method: 'GET', authenticated: true }); return { id, title: independentTaskLabel(task), caseId:task.caseId, available: true }; } catch { return { id, available: false }; } }));
      if (!current(lease) || ticket!==readEpoch.current) return;
      setLinkedTasks(links);
      let freshMessages:ChatMessage[]=[],expiresAt:number|null=null;
      if(locatedMessage){
        const ids=[...new Set([locatedMessage,...contextWindows.current])],pages:ChatContext[]=await Promise.all(ids.map(id=>runtime.chat.context(roomId,id,{limit:50})));if(!current(lease)||ticket!==readEpoch.current)return;
        freshMessages=[...new Map(pages.flatMap(page=>page.messages).map(item=>[item.messageId,item])).values()].sort((left,right)=>BigInt(left.sequence)<BigInt(right.sequence)?-1:1);
        const ordered=[...pages].sort((left,right)=>BigInt(left.after??'0')<BigInt(right.after??'0')?-1:1);
        expiresAt=Math.min(...pages.map(page=>readDeadline(page.readExpiresAt)));setTargetState(pages[0].targetState);setMessageReading(freshMessages);setEarlier(ordered[0].previous??null);setNext(ordered[ordered.length-1].next);
      }else if (!filter && runtime.chat.latestHistory) {
        const minimum=oldestLoaded.current,wantsEarlier=earlierRequested.current;
        let page:ChatHistory=await runtime.chat.latestHistory(roomId,{limit:50});if(!current(lease)||ticket!==readEpoch.current)return;
        const pages=[page];
        while(minimum&&page.previous&&BigInt(page.previous)>BigInt(minimum)){
          page=await runtime.chat.latestHistory(roomId,{before:page.previous,limit:50});pages.push(page);
          if(!current(lease)||ticket!==readEpoch.current)return;
        }
        let floor=minimum??pages[0].messages[0]?.sequence??null,more=!!pages[pages.length-1].previous;
        if(wantsEarlier&&minimum){const previous:ChatHistory=await runtime.chat.latestHistory(roomId,{before:minimum,limit:50});pages.push(previous);floor=previous.messages[0]?.sequence??minimum;more=!!previous.previous;}
        if (!current(lease) || ticket!==readEpoch.current) return;
        const values = [...new Map(pages.flatMap(page => page.messages).filter((item)=>!floor||BigInt(item.sequence)>=BigInt(floor)).map((item) => [item.messageId, item])).values()];
        values.sort((left, right) => BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1);
        oldestLoaded.current=floor;hasEarlier.current=more;earlierRequested.current=false;
        freshMessages=values;expiresAt=Math.min(...pages.map(item=>readDeadline(item.readExpiresAt)));setMessageReading(values); setEarlier(more?floor:null); setNext(null);
      } else {
        const page:ChatHistory = await runtime.api.call(roomPath + '/history', { after, limit: 50, ...(filter ? { keyword: filter } : {}) });
        if (!current(lease) || ticket!==readEpoch.current) return;
        freshMessages=page.messages;expiresAt=readDeadline(page.readExpiresAt);setMessageReading(page.messages); setNext(page.next); setEarlier(null);
      }
      const selected=[draft.value.reply,draft.value.edit,draft.other?.reply,draft.other?.edit].filter((item):item is ChatMessageLocator=>!!item),ids=[...new Set(selected.map(item=>item.messageId))],nextReferences:Record<string,ChatMessage|null>={};
      await Promise.all(ids.map(async id=>{const present=freshMessages.find(item=>item.messageId===id);if(present){nextReferences[id]=present;return;}try{const value=await runtime.chat.context(roomId,id,{limit:10});nextReferences[id]=value.targetState==='available'?value.target:null;expiresAt=expiresAt===null?value.readExpiresAt:Math.min(expiresAt,value.readExpiresAt);}catch{nextReferences[id]=null;}}));
      if(!current(lease)||ticket!==readEpoch.current)return;setReferences(nextReferences);setReadExpiresAt(expiresAt);
    }
    if (current(lease)&&ticket===readEpoch.current) { setLoading(false);setClock(()=>Date.now());setOffline(false);setErrorMessage(''); }
  }
  async function propose(input:ChatProposal) {
    if(!roomId||!room||!current())throw Error('请重新打开这段对话。');
    const token=active.current,result:ChatDecision=await runtime.chat.propose(roomId,{expectedRevision:room.revision,...input},{confirmed:true});
    if(current(token)&&input.action!=='invite')setNotice(['applied','accepted'].includes(result.state)?'设置已保存。':'已发出，等待相关成员回应。');return result;
  }
  async function resumePending(stillCurrent:()=>boolean=()=>true,explicitRetry=false){
    const token=active.current;if(!current(token)||!stillCurrent())return;
    const saved:ChatPending|null=await runtime.chat.pending(roomId??null);if(!current(token)||!stillCurrent())return;
    const result:{roomId?:string;room?:{roomId:string};state?:string;messageId?:string;revision?:number}=await runtime.chat.resumePending(roomId??null,{explicitRetry});if(!current(token)||!stillCurrent())return;
    if(!roomId&&(result.roomId||result.room?.roomId)){navigate(`/app/rooms/${result.roomId??result.room?.roomId}`);return;}
    if(roomId&&saved?.path.endsWith('/send')&&result.state==='accepted'&&saved.input.clientMessageId)await draft.settle(saved.input.clientMessageId);
    if(roomId&&saved?.path.endsWith('/edit')&&saved.input.operationId&&(result.state==='acknowledged'||result.messageId===saved.path.split('/').at(-2)&&typeof result.revision==='number'&&result.revision===(saved.input.expectedRevision??0)+1))await draft.settle(saved.input.operationId);
    if(roomId&&!saved&&draft.attempt?.requestHash){
      const attempt=draft.attempt,receipt=await runtime.chat.receiptFor(roomId,{kind:attempt.kind,roomId,requestHash:attempt.requestHash,...(attempt.kind==='send'?{clientMessageId:attempt.id}:{operationId:attempt.id,messageId:attempt.messageId})});
      if(current(token)&&stillCurrent()&&receipt.state==='acknowledged'&&receipt.exactOperationConfirmed)await draft.settle(attempt.id);
    }
  }
  function showLatest() {oldestLoaded.current=null;contextWindows.current=[];restorePosition.current=null;earlierRequested.current=false;hasEarlier.current=false;scrollEnd.current = true;firstRead.current=true;if(searchRef.current)changeView('',false);else setReadRefresh(value=>value+1);}
  async function send(selectedAt:number){
    if(!roomId||!current()||replyLocator&&!chatMessageAvailable(reply,selectedAt))return;const token=active.current,saved=await draft.snapshot(),selected=saved.value,existing=draft.attempt,clientMessageId=existing?.kind==='send'&&existing.draftRevision===saved.revision?existing.id:crypto.randomUUID();
    if(!current(token))return;await draft.attach({kind:'send',id:clientMessageId},saved.revision);if(!current(token))return;
    let journaled=false;
    try{await runtime.chat.send(roomId,selected.text,{confirmed:true,replyTo:selected.reply?.messageId??null,attachments:selected.attachments,clientMessageId,onJournal:(locator:{requestHash:string})=>{journaled=true;return draft.attach({kind:'send',id:clientMessageId,requestHash:locator.requestHash},saved.revision);}});}
    catch(reason){if(!journaled&&current(token)){try{if(!await runtime.chat.pending(roomId)&&!existing?.requestHash)await draft.release(clientMessageId);}catch{/* Keep the original association until it can be checked. */}}throw reason;}
    if(!current(token))return;await draft.settle(clientMessageId);if(!current(token))return;showLatest();composer.current?.focus({preventScroll:true});
  }
  async function saveEdit(){
    if(!roomId||!current()||!editDraft||!chatMessageAvailable(edit,Date.now())||edit.revision!==editDraft.revision)return;
    const token=active.current,saved=await draft.snapshot(),selected=saved.value.edit,existing=draft.attempt,operationId=existing?.kind==='edit'&&existing.draftRevision===saved.revision&&existing.messageId===selected?.messageId?existing.id:crypto.randomUUID();if(!selected||!current(token))return;
    await draft.attach({kind:'edit',id:operationId,messageId:selected.messageId},saved.revision);if(!current(token))return;
    let journaled=false;
    try{await runtime.chat.edit(roomId,selected.messageId,{expectedRevision:selected.revision,text:selected.text,operationId},{confirmed:true,onJournal:(locator:{requestHash:string})=>{journaled=true;return draft.attach({kind:'edit',id:operationId,messageId:selected.messageId,requestHash:locator.requestHash},saved.revision);}});}
    catch(reason){if(!journaled&&current(token)){try{if(!await runtime.chat.pending(roomId)&&!existing?.requestHash)await draft.release(operationId);}catch{/* Keep the original association until it can be checked. */}}throw reason;}
    if(current(token))await draft.settle(operationId);
  }
  async function returnToInput(){
    if(!roomId||!pending)return true;const saved=await runtime.chat.pending(roomId);if(!saved)return true;
    const kind=saved.path.endsWith('/edit')?'edit':saved.path.endsWith('/send')?'send':null,id=kind==='edit'?saved.input.operationId:saved.input.clientMessageId;
    if(!kind||!id||!saved.requestHash)throw Error('这次操作仍在确认，原输入继续保留。');
    const result=await runtime.chat.receiptFor(roomId,{kind,roomId,requestHash:saved.requestHash,...(kind==='send'?{clientMessageId:id}:{operationId:id})});if(!current())return false;
    if(result.state==='acknowledged'&&result.exactOperationConfirmed){await draft.settle(id);setNotice('刚才的内容已经保存。');return false;}
    if(!['absent','cancelled'].includes(result.receipt.state))throw Error('刚才的内容还在确认，请稍后继续。');
    await runtime.chat.stopRetry(roomId,{confirmed:true});if(!current())return false;await draft.release(id);return true;
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
  useLayoutEffect(()=>{const generation=active,life=mounted;life.current=true;generation.current++;return()=>{life.current=false;generation.current++;};},[]);
  const poll=useEffectEvent(async(stillCurrent:()=>boolean)=>{
    if(!current()||!stillCurrent()||!connected||working.current||document.hidden||navigator.onLine===false)return;
    try{
      if(!recovering.current){recovering.current=true;try{await resumePending(stillCurrent);}catch{/* The original retry remains available. */}finally{recovering.current=false;}}
      if(current()&&stillCurrent())await reload();
    }catch(reason){if(current()&&stillCurrent()){clearControlled();setError(reason);setLoading(false);}}
  });
  useEffect(()=>{
    const lost=()=>{readEpoch.current++;setOffline(true);clearControlled();setLoading(false);setErrorMessage('已离线。输入保留在本机，连接恢复后会重新读取对话。');};
    const restored=()=>{setOffline(false);setLoading(true);setReadRefresh(value=>value+1);};
    window.addEventListener('offline',lost);window.addEventListener('online',restored);if(navigator.onLine===false)lost();return()=>{window.removeEventListener('offline',lost);window.removeEventListener('online',restored);};
  },[]);
  useEffect(()=>{if(readExpiresAt===null)return;const timer=window.setTimeout(()=>{clearControlled();if(navigator.onLine!==false)setReadRefresh(value=>value+1);},Math.min(2147483647,Math.max(0,readExpiresAt*1000-Date.now())));return()=>window.clearTimeout(timer);},[readExpiresAt]);
  useEffect(()=>{
    let stopped=false,reading=false;const epoch=readEpoch;
    const update=async()=>{if(stopped||reading)return;reading=true;try{await poll(()=>!stopped);}finally{reading=false;}};
    void update();const timer=setInterval(update,7000);document.addEventListener('visibilitychange',update);
    return()=>{stopped=true;clearInterval(timer);document.removeEventListener('visibilitychange',update);epoch.current++;};
  },[runtime,connected,roomId,filter,after,locatedMessage,readRefresh,replyLocator?.messageId,editDraft?.messageId,draft.other?.reply?.messageId,draft.other?.edit?.messageId,draft.ready]);
  useEffect(() => {
    const box = historyBox.current; if (!box||loading||!messages.length) return;
    if(restorePosition.current){const position=restorePosition.current,item=position.anchor?document.getElementById('chat-message-'+position.anchor.messageId):null;box.scrollTop=item&&position.anchor?box.scrollTop+item.getBoundingClientRect().top-box.getBoundingClientRect().top-position.anchor.offset:position.top;restorePosition.current=null;locateOnce.current=false;firstRead.current=false;scrollEnd.current=box.scrollHeight-box.scrollTop-box.clientHeight<90;}
    else if (prepend.current) { box.scrollTop = prepend.current.top + box.scrollHeight - prepend.current.height; prepend.current = null; }
    else if (locatedMessage&&locateOnce.current) {const target=document.getElementById('chat-message-' + locatedMessage);if(target){box.scrollTop+=target.getBoundingClientRect().top-box.getBoundingClientRect().top-box.clientHeight/2+Math.min(target.clientHeight,box.clientHeight)/2;locateOnce.current=false;firstRead.current=false;scrollEnd.current=false;}}
    else if (!filter && (firstRead.current || scrollEnd.current)) { box.scrollTop = box.scrollHeight; firstRead.current = false; }
  }, [messages, locatedMessage, filter,loading]);
  useEffect(() => {
    if (!room || panel || action || document.hidden || !historyBox.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible=new Map<string,string>();
    const token=active.current;
    const flush = () => { if (document.hidden||!current(token)) return;const visibleMessageIds=[...visible.keys()].filter(id=>!readMessageIds.current.has(id)).slice(0,100),sequence=[...visible.values()].reduce((max,value)=>BigInt(value)>BigInt(max)?value:max,readCursor.current);if(!visibleMessageIds.length&&BigInt(sequence)<=BigInt(readCursor.current))return;runtime.api.call(roomPath + '/cursor', { kind: 'human', sequence,...(visibleMessageIds.length?{visibleMessageIds}:{}) }).then(() => {if(!current(token))return;visibleMessageIds.forEach(id=>readMessageIds.current.add(id));if(BigInt(sequence)>BigInt(readCursor.current))readCursor.current=sequence;}).catch(() => {}); };
    const observer = new IntersectionObserver(entries => { for (const entry of entries) { const {readSequence:sequence,readMessageId:id}=(entry.target as HTMLElement).dataset;if(sequence&&id){if(entry.isIntersecting)visible.set(id,sequence);else visible.delete(id);}}if(timer)clearTimeout(timer);timer=setTimeout(flush,750); }, { root: historyBox.current, threshold: 1 });
    historyBox.current.querySelectorAll('[data-read-sequence]').forEach(item => observer.observe(item));
    return () => { observer.disconnect(); if (timer) clearTimeout(timer); };
  }, [messages, room, runtime, roomPath, panel, action, current]);
  function openMembers(){if(room)setRetention(room.retentionDays);setPanel('members');}
  useEffect(() => {if(panel){panelDialog.current?.showModal();if(panel==='search')panelDialog.current?.querySelector<HTMLInputElement>('input')?.focus();}else panelDialog.current?.close();},[panel]);
  useEffect(() => { if (action) actionDialog.current?.showModal(); else actionDialog.current?.close(); }, [action]);
  const replyExpired=!!replyLocator&&!chatMessageAvailable(reply,clock),editExpired=!!editDraft&&!chatMessageAvailable(edit,clock),editChanged=!!editDraft&&!!edit&&editDraft.revision!==edit.revision;
  useEffect(()=>{const expiresAt=nextChatMessageExpiry([...messageReading,reply,edit],clock);if(expiresAt===null)return;const timer=window.setTimeout(()=>setClock(Date.now()),Math.min(2147483647,Math.max(0,expiresAt-Date.now()+1)));return()=>window.clearTimeout(timer);},[messageReading,reply,edit,clock]);
  const disabled = busy || !!pending || !draft.ready || draft.conflict || (!editDraft&&(replyExpired||selectedAttachments.length>0&&!attachmentsReady)) || editExpired || editChanged || (!room&&!offline) || ['archived', 'owner-succession'].includes(room?.state??'');
  const displayNames=useMemberNames(runtime,subjectId,connected,[...(room?.members??[]).map((item)=>item.subjectId),...rooms.flatMap(item=>[...item.members.map(member=>member.subjectId),item.latestMessage?.subjectId]),...messages.map(item=>item.subjectId),...invitations.flatMap(item=>[item.proposerSubjectId,item.payload?.targetSubjectId]),...decisions.flatMap(item=>[item.payload?.targetSubjectId,item.proposerSubjectId,item.myVote?.subjectId]),replyLocator?.subjectId,editDraft?.subjectId,draft.other?.reply?.subjectId]);
  const name = (id?: string) => memberName(id, subjectId, id?displayNames[id]??undefined:undefined);
  const rejection=pending&&'businessRejection'in pending?pending.businessRejection as {code:string;status:number}:null;
  const roomLabel=(item:ChatRoom)=>item.title==='对话'?(item.members.filter(member=>member.subjectId!==subjectId).map(member=>name(member.subjectId)).slice(0,3).join('、')||'新的对话'):item.title;
  const referencePreview=(source:ChatMessageLocator)=>{const item=references[source.messageId]??messages.find(value=>value.messageId===source.messageId);return item?messagePreview(item,clock).slice(0,140):`与${name(source.subjectId)}的消息，原文当前未读取`;};
  const invitationId=chatSearchParams(search).invitation;
  useEffect(()=>{if(roomId||loading||!invitationId||!locateOnce.current)return;const item=document.getElementById('chat-invitation-'+invitationId);if(item){item.scrollIntoView({block:'center'});item.focus({preventScroll:true});locateOnce.current=false;}},[invitations,invitationId,roomId,loading]);
  const currentDecisions=decisions.filter(item=>['pending','approved'].includes(currentDecisionState(item))),previousDecisions=decisions.filter(item=>!['pending','approved'].includes(currentDecisionState(item)));
  const invitedPeople=currentDecisions.filter(item=>item.action==='invite'&&item.proposerSubjectId===subjectId&&currentDecisionState(item)==='approved').map(item=>name(item.payload.targetSubjectId));
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
      {accepting&&<>{decision.canAccept!==true&&<p>{decisionUnavailable(decision)}</p>}<AccountVerificationPrompt required={decision.actionReasons?.accept==='account_verification_required'} navigate={leaveTo}/><div className="button-row">
        {decision.canAccept===true&&<Button disabled={busy||!!pending} onClick={()=>run(()=>runtime.api.call(roomPath+'/accept',{decisionId:decision.decisionId,accept:true}))}>{decisionAcceptLabel(decision)}</Button>}
        {decision.canDecline===true&&<Button variant="ghost" disabled={busy||!!pending} onClick={()=>run(()=>runtime.api.call(roomPath+'/accept',{decisionId:decision.decisionId,accept:false}))}>婉拒</Button>}
      </div></>}
    </article>;
  };

  const sharedFiles=[...new Map(messages.flatMap(item=>item.attachments??[]).map(item=>[item.attachmentId,item])).values()];
  return <div className={'selected-messages-layout'+(roomId?' has-conversation':' directory-view')}>
    {roomId&&<ConversationSidebar runtime={runtime} subjectId={subjectId} lease={viewLease} roomId={roomId} navigate={leaveTo}/>}
    <section className={'messages-page' + (roomId ? ' conversation-page' : '')} aria-busy={busy}>
    {!roomId && <><div className="page-heading"><h2 className="message-module-title">消息</h2><Button onClick={() => setCreateOpen(true)}><Plus size={16} />发起对话</Button></div><MessageNavigation active="rooms" navigate={leaveTo} /><h1 className="small message-page-title">{createOpen?'发起对话':'全部对话'}</h1></>}
    {roomId && <header className="conversation-header"><button className="conversation-back" aria-label="返回对话列表" onClick={() => leaveTo('/app/rooms')}>对话列表</button><MemberAvatar subjectId={room?.members.find(member=>member.subjectId!==subjectId)?.subjectId??roomId} name={displayNames[room?.members.find(member=>member.subjectId!==subjectId)?.subjectId??'']??undefined}/><div className="conversation-title"><h1>{room?roomLabel(room):'对话详情'}</h1>{room && <button onClick={openMembers}>{room.members.length} 位成员 <span>· 查看成员</span></button>}</div><div className="conversation-tools"><button className="icon-button" aria-label="搜索对话" disabled={!room} onClick={() => setPanel('search')}><Search size={19} /></button><button className="icon-button" aria-label="共享资料" disabled={!room} onClick={() => setPanel('shared')}><FileText size={19} /></button><button className="icon-button" aria-label="对话设置" disabled={!room} onClick={openMembers}><MoreHorizontal size={22} /></button></div></header>}
    {error && <div className="message error" role="alert">{error}<AccountVerificationPrompt required={verificationRequired} navigate={leaveTo} /><Button variant="ghost" disabled={busy} onClick={() => setReadRefresh(value => value + 1)}>重试</Button></div>}
    {notice && <output className="conversation-notice">{notice}</output>}
    {pending&&<div className="conversation-notice"><output>{rejection?rejectionMessage(rejection.code):'正在确认刚才的操作，原内容已保留。'}</output><AccountVerificationPrompt required={needsAccountVerification(rejection?.code)&&!(error&&verificationRequired)} navigate={leaveTo}/><Button variant="ghost" disabled={busy} onClick={()=>run(()=>resumePending(()=>true,true))}>{rejection?'继续原操作':'重新核对'}</Button>{rejection&&roomId?<Button variant="ghost" disabled={busy} onClick={()=>run(returnToInput)}>返回修改</Button>:<Button variant="ghost" disabled={busy} onClick={()=>run(async(check)=>{await runtime.chat.stopRetry(roomId??null,{confirmed:true});if(check())setNotice('已停止本机重试；服务已收到的内容仍会显示。');})}>停止重试</Button>}</div>}
    {!roomId && <>
      {createOpen&&<ConversationStart runtime={runtime} subjectId={subjectId} busy={busy} blocked={!!pending} onClose={()=>setCreateOpen(false)} onStart={async input=>{const result=await run(async check=>{const roomId=input.inviteeSubjectId?(await runtime.chat.startConversation({inviteeSubjectId:input.inviteeSubjectId,...(input.title?{title:input.title}:{})},{confirmed:true})).room.roomId:(await runtime.chat.create({title:input.title??'对话'},{confirmed:true})).roomId;if(check())navigate(`/app/rooms/${roomId}`);return true;},false);return result===true;}}/>}
      {invitations.length > 0 && <section className="conversation-invitations"><h2>对话邀请</h2>{invitations.map(invite => <article id={'chat-invitation-'+invite.decisionId} tabIndex={-1} className={invite.decisionId===invitationId?'located':''} key={invite.decisionId}><MemberAvatar subjectId={invite.proposerSubjectId} name={displayNames[invite.proposerSubjectId]??undefined}/><div><h3>{invite.title==='对话'?`${name(invite.proposerSubjectId)}邀请你聊天`:invite.title}</h3><p>{invite.title!=='对话'&&`${name(invite.proposerSubjectId)}发来邀请。`}{invite.action==='invite'?'加入后可查看对话中仍保留的共享消息。':decisionAcceptLabel(invite)}</p>{invite.canAccept!==true&&<p>{decisionUnavailable(invite)}</p>}<AccountVerificationPrompt required={invite.actionReasons?.accept==='account_verification_required'} navigate={leaveTo}/><div className="button-row">{invite.canAccept===true&&<Button disabled={busy||!!pending} onClick={() => run(async (check) => { const result:{state:string;membershipActive?:boolean}=await runtime.api.call(`/v2/chat/rooms/${invite.roomId}/accept`, { decisionId: invite.decisionId, accept: true }); if(!check())return;if(result.state==='accepted'&&result.membershipActive!==false)navigate(`/app/rooms/${invite.roomId}`);else throw Error('这份邀请已处理，请查看当前对话。'); })}>{decisionAcceptLabel(invite)}</Button>}{invite.canDecline===true&&<Button variant="ghost" disabled={busy||!!pending} onClick={() => run(() => runtime.api.call(`/v2/chat/rooms/${invite.roomId}/accept`, { decisionId: invite.decisionId, accept: false }))}>婉拒</Button>}</div></div></article>)}</section>}
      {invitationId&&!loading&&!error&&!invitations.some(invite=>invite.decisionId===invitationId)&&<p className="conversation-notice">这份邀请当前不在待回应列表中，可能已处理或不再生效。你仍可打开已加入的对话。</p>}
      {loading && !rooms.length && <output className="reading-status">正在读取对话…</output>}
      <div className="conversation-list">{rooms.map(item => <a href={`/app/rooms/${item.roomId}`} key={item.roomId} onClick={event => {if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate(`/app/rooms/${item.roomId}`);}}><MemberAvatar subjectId={item.members.find(member=>member.subjectId!==subjectId)?.subjectId??item.roomId} name={displayNames[item.members.find(member=>member.subjectId!==subjectId)?.subjectId??'']??undefined}/><div><div className="conversation-row-heading"><h2>{roomLabel(item)}</h2><time dateTime={item.lastActivityAt}>{readableTime(item.lastActivityAt)}</time></div><p className="conversation-last-message">{item.latestMessage?`${name(item.latestMessage.subjectId)}：${messagePreview(item.latestMessage,clock)}`:item.contentUnavailableReason?'最近消息暂时无法读取':'暂无可读消息预览'}</p><p className="conversation-members">{item.members.length>2?`${item.members.length} 位成员 · `:''}{item.members.filter(member=>member.subjectId!==subjectId).map(member=>name(member.subjectId)).slice(0,3).join('、')||'可以邀请愿意交流的人'}{item.kind==='ai-subzone'?' · AI 对话':''}</p></div>{!!item.unreadHumanCount&&<span className="conversation-unread" aria-label={item.unreadHumanCount+' 条未读消息'}>{item.unreadHumanCount>99?'99+':item.unreadHumanCount}</span>}</a>)}</div>
      {!loading && rooms.length === 0 && !error && !createOpen && <div className="conversation-empty"><MessageCircle size={36} /><h2>还没有对话</h2><p>从一个想法开始，邀请愿意交流的人。</p><Button variant="outline" onClick={() => setCreateOpen(true)}>发起第一段对话</Button></div>}
      {roomNext && <Button variant="outline" disabled={busy} onClick={() => run(() => reload(roomNext), false)}>查看更早的对话</Button>}
    </>}
    {roomId && <>
      {invitedPeople.length>0&&<p className="conversation-notice">已邀请{invitedPeople.join('、')}，等待对方接受后加入。</p>}
      {!!linkedTasks.length && <div className="conversation-context">{linkedTasks.map(item => item.available ? <a key={item.id} href={`/app/tasks/${item.id}`} onClick={event => { event.preventDefault(); leaveTo(`/app/tasks/${item.id}`); }}>继续：{item.title}</a> : <span key={item.id}>关联工作当前不可读取</span>)}</div>}
      {room&&!room.transportAvailable && <div className="conversation-notice">暂时无法发送消息，已有草稿会保留。</div>}
      {(filter || locatedMessage) && <div className="conversation-search-result"><span>{locatedMessage?'相关消息的前后文':`搜索：${filter}`}</span><div><button onClick={returnReading}>{locatedMessage&&filter?'返回搜索结果':'返回原处'}</button><button onClick={showLatest}>最新对话 <X size={14} /></button></div></div>}
      <div ref={historyBox} className="conversation-history" aria-label={filter&&!locatedMessage?'对话搜索结果':'对话消息'} onScroll={() => {const box=historyBox.current;if(box){scrollEnd.current=box.scrollHeight-box.scrollTop-box.clientHeight<90;rememberPosition();}}}>
        {locatedMessage&&targetState!=='available'&&!loading&&<p className="conversation-notice">{({hidden:'这条消息已被你隐藏。',retracted:'这条消息已撤回。',expired:'这条消息已超过保留时间。'} as Record<string,string>)[targetState]??'这条消息目前不可读取。'}<span>下方只显示当前仍可读取的对话。</span></p>}
        {earlier && <button className="conversation-earlier" disabled={busy} onClick={() => {const box=historyBox.current;if(box)prepend.current={height:box.scrollHeight,top:box.scrollTop};if(locatedMessage&&messages[0])contextWindows.current=[...new Set([...contextWindows.current,messages[0].messageId])];else earlierRequested.current=true;setReadRefresh(value=>value+1);}}>查看更早消息</button>}
        {filter&&!locatedMessage?messages.map(item=><button type="button" id={'chat-message-'+item.messageId} data-message-id={item.messageId} className="conversation-search-hit" key={item.messageId} onClick={()=>locateMessage(item.messageId)}><header><MemberAvatar subjectId={item.subjectId} name={displayNames[item.subjectId]??undefined}/><strong>{name(item.subjectId)}</strong><time dateTime={item.sentAt}>{readableTime(item.sentAt)}</time></header><p>{messagePreview(item,clock)}</p><span>查看前后文</span></button>):messages.map((item,index) => <React.Fragment key={item.messageId}>{chatDay(item.sentAt)!==chatDay(messages[index-1]?.sentAt??'')&&<div className="conversation-day"><span>{chatDay(item.sentAt)}</span></div>}<article aria-label={name(item.subjectId)+'的消息'} id={'chat-message-' + item.messageId} data-message-id={item.messageId} data-sequence={item.sequence} className={'conversation-message' + (item.subjectId === subjectId ? ' own' : '') + (item.messageId === locatedMessage ? ' located' : '')+(continuesChatMessage(messages[index-1],item)?' continued':'')} key={item.messageId}><MemberAvatar subjectId={item.subjectId} own={item.subjectId === subjectId} name={displayNames[item.subjectId]??undefined}/><div className="conversation-message-content"><header><span><MemberLink subjectId={item.subjectId} name={name(item.subjectId)} ownId={subjectId} navigate={leaveTo}/>{item.actorKind === 'agent' && <small>AI</small>}</span><time dateTime={item.sentAt}>{readableTime(item.sentAt)}{item.editedAt ? ' · 已编辑' : ''}</time></header><div className={'message-bubble' + (item.state === 'retracted' ? ' retracted' : '')}>{item.replyTo&&<button type="button" className="message-quote" onClick={()=>locateMessage(item.replyTo!)}>{messagePreview(messages.find(value=>value.messageId===item.replyTo),clock).slice(0,140)}<span>查看被回复的消息</span></button>}<p>{messagePreview(item,clock)}</p><ChatAttachmentFiles runtime={runtime} items={item.attachments??[]} />{item.sharedSummaryId && <button className="shared-message-link" onClick={() => { setSelectedSharedId(item.sharedSummaryId??undefined); setPanel('shared'); }}>打开交流笔记</button>}<span className="chat-read-marker" data-read-sequence={item.sequence} data-read-message-id={item.messageId} aria-hidden="true" /></div>{item.text && <div className="conversation-message-actions"><button onClick={() => {draft.change({reply:{messageId:item.messageId,sequence:item.sequence,subjectId:item.subjectId},edit:null});composer.current?.focus();}}>回复</button>{item.subjectId === subjectId && <>{!item.sharedSummaryId && <button onClick={() => {draft.change({edit:{messageId:item.messageId,sequence:item.sequence,subjectId:item.subjectId,revision:item.revision,text:item.text??''}});composer.current?.focus();}}>编辑</button>}<button onClick={() => setAction({ kind: 'retract', messageId: item.messageId })}>撤回</button></>}<button onClick={() => run(() => runtime.api.call(`${roomPath}/messages/${item.messageId}/hide`, { hidden: true }))}>隐藏</button></div>}</div></article></React.Fragment>)}
        {!messages.length && <div className="conversation-empty"><MessageCircle size={29} /><p>{offline?'连接恢复后重新读取消息。':loading?'正在读取消息…':!room?'当前消息暂时无法读取，已输入的文字仍保留。':filter?'没有找到这些内容，换一个词试试。':locatedMessage?'当前没有可读取的相关消息。':'开始说点什么吧。'}</p></div>}
        {filter&&!locatedMessage&&(next||after!=='0')&&<div className="conversation-result-pages">{after!=='0'&&<button className="text-link" onClick={()=>changeView(reading.back(searchRef.current)??chatSearchString({keyword:filter}),false)}>上一页结果</button>}{next&&<button className="text-link" onClick={()=>changeView(chatSearchString({keyword:filter,after:next}))}>下一页结果</button>}</div>}
        {locatedMessage&&next&&<button className="conversation-earlier" disabled={busy} onClick={()=>{const last=messages[messages.length-1];if(last)contextWindows.current=[...new Set([...contextWindows.current,last.messageId])];setReadRefresh(value=>value+1);}}>查看后面的消息</button>}
      </div>
      <form className="conversation-compose" onSubmit={event => {event.preventDefault();if(!disabled)void run(editDraft?saveEdit:()=>send(Date.now()));}}>
        <ChatDraftRecovery draft={draft} busy={busy} preview={referencePreview} onAction={action=>void run(action,false)}/>
        {(replyLocator || editDraft) && <div className="compose-context"><span>{editDraft?'编辑我的消息':`回复 ${name(replyLocator?.subjectId)}`}<small>{editDraft?(editExpired?'原消息当前不可读取；本机修改仍保留。':editChanged?'原消息已有更新：'+(edit?.text??''):edit?.text??'正在读取原消息…'):replyExpired?'正在核对被回复的消息；原文字与引用选择仍保留。':messagePreview(reply,clock).slice(0,180)}</small>{editChanged&&edit&&<button className="text-link" type="button" onClick={()=>void run(async()=>{if(await returnToInput())draft.change({edit:{...editDraft!,revision:edit.revision}});})}>按当前消息继续修改</button>}{editDraft&&(editExpired||rejection?.code==='chat_edit_window_closed_use_correction')&&!loading&&<button className="text-link" type="button" onClick={()=>void run(async()=>{if(await returnToInput())draft.change({text:[text,editDraft.text].filter(Boolean).join('\n'),edit:null});})}>保留为未发送消息</button>}</span><button type="button" aria-label={editDraft?'取消编辑':'取消回复'} onClick={()=>draft.change(editDraft?{edit:null}:{reply:null})}><X size={16}/></button></div>}
        <Textarea ref={composer} aria-label={editDraft?'编辑消息内容':'消息'} required maxLength={16000} disabled={!draft.ready||busy} value={editDraft?.text??text} onChange={event=>editDraft?draft.change({edit:{...editDraft,text:event.target.value}}):setText(event.target.value)} placeholder={room?.state==='archived'?'这段对话已结束':'写一条消息…'} onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();event.currentTarget.form?.requestSubmit();}}}/>
        <div className="compose-tools"><div>{!editDraft&&<ChatAttachmentComposer key={roomId} runtime={runtime} roomId={roomId} disabled={!draft.ready||busy||!!pending||draft.conflict||!room} selected={selectedAttachments} onChange={setSelectedAttachments} onValidityChange={setAttachmentsReady}/>}</div><span className="compose-shortcut">Ctrl / ⌘ + Enter 发送</span><Button type="submit" disabled={disabled||!(editDraft?.text??text).trim()}>{editDraft?'保存修改':busy?'发送中…':'发送'}</Button></div>
        {(!draft.ready||draft.status)&&<div className="compose-status" aria-live="polite"><span>{draft.status||'正在读取本机草稿…'}</span>{draft.ready&&draft.status&&!draft.conflict&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>void run(()=>draft.retrySave(),false)}>重新保存草稿</Button>}</div>}
      </form>
    </>}
    <dialog ref={panelDialog} className="conversation-panel" onClose={event => {if(event.target===event.currentTarget)setPanel(null);}} aria-labelledby="conversation-panel-title"><header><h2 id="conversation-panel-title">{panel === 'members' ? '成员与设置' : panel === 'shared' ? '共享资料' : '搜索对话'}</h2><button className="icon-button" aria-label="关闭面板" onClick={() => setPanel(null)}><X size={20} /></button></header>
      {panel==='search'&&<form className="conversation-search-form" onSubmit={event=>{event.preventDefault();changeView(chatSearchString({keyword:keyword.trim()}));setPanel(null);scrollEnd.current=false;}}><label htmlFor={fieldId+'-search'}>查找消息<Input id={fieldId+'-search'} value={keyword} onChange={event=>setKeyword(event.target.value)} placeholder="输入关键词"/></label><Button type="submit" disabled={!keyword.trim()}>搜索</Button></form>}
      {panel === 'shared' && room && <div className="conversation-shared"><nav className="panel-sections"><a href="#shared-background">背景与关键消息</a><a href="#shared-results">文件与结果</a></nav><section id="shared-background" aria-label="背景与关键消息"><PersonalSummaryWorkspace runtime={runtime} room={room} subjectId={subjectId} connected={connected} navigate={leaveTo} messages={messages} selectedSharedId={selectedSharedId} onLocate={source=>locateMessage(source.messageId)} /></section><section id="shared-results"><h3>文件与结果</h3><OutcomeMaterialWorkspace onReturnToConversation={()=>setPanel(null)} runtime={runtime} subjectId={subjectId} connected={connected} roomId={roomId} messages={messages} memberIds={room.members.map((member)=>member.subjectId)} linkedCases={linkedTasks.flatMap(item=>item.available&&item.caseId?[{caseId:item.caseId,taskId:item.id,title:item.title}]:[])} /></section><ContactOriginWorkspace runtime={runtime} subjectId={subjectId} connected={connected} navigate={leaveTo} roomId={room.roomId} /></div>}
      {panel === 'members' && room && <div className="conversation-settings"><section><h3>对话成员</h3><ul className="member-list">{room.members.map((member) => <li key={member.subjectId}><MemberAvatar subjectId={member.subjectId} name={displayNames[member.subjectId]??undefined}/><div><strong><MemberLink subjectId={member.subjectId} name={name(member.subjectId)} ownId={subjectId} navigate={leaveTo}/>{member.subjectId === room.ownerSubjectId ? ' · 房主' : ''}</strong><ReadingDetails className="technical-details"><ReadingSummary>银河 ID</ReadingSummary><small>{member.subjectId}</small></ReadingDetails></div></li>)}</ul>{subjectId&&<ConversationInvite runtime={runtime} subjectId={subjectId} room={room} decisions={decisions} externalError={error} disabled={busy||!!pending||['archived','owner-succession'].includes(room.state)} onInvite={async(targetSubjectId,decisionId)=>{return run(()=>propose({action:'invite',targetSubjectId,decisionId}));}}/>}</section>
        {error&&<p className="message error" role="alert">{error}</p>}
        {currentDecisions.length>0&&<section><h3>成员请求</h3>{currentDecisions.map(renderDecision)}</section>}
        {previousDecisions.length>0&&<section><ReadingDetails className="member-change-history"><ReadingSummary>以前的成员变更</ReadingSummary>{previousDecisions.map(renderDecision)}</ReadingDetails></section>}
        <section><h3>AI 参与</h3><AgentWorkContinuation runtime={runtime} subjectId={subjectId} object={{kind:'room',id:room.roomId}} title={roomLabel(room)} purpose="回到这段对话，按已有授权和当前问题继续处理；先确认需要使用的消息与材料"/><AgentParticipants runtime={runtime} roomId={room.roomId} /><ChatAgentWorkspace key={room.roomId} runtime={runtime} room={room} navigate={leaveTo} /></section>
        <section><h3>对话设置</h3><p>当前消息保留 {room.retentionDays} 天。更改只影响后续消息。</p><div className="button-row"><select aria-label="消息保留时间" value={retention} onChange={event => setRetention(event.target.value==='7'?7:event.target.value==='30'?30:90)}><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option></select><Button variant="outline" disabled={busy || !!pending} onClick={() => run(() => propose({ action: 'retention', retentionDays: retention }))}>更改保留时间</Button></div><Button variant="ghost" disabled={busy || !!pending} onClick={() => run(() => propose({ action: 'persistent', persistent: !room.persistent }))}>{room.persistent ? '关闭长期对话' : '设为长期对话'}</Button>{room.decisionRequired && <div className="message"><p>其他成员已退出。你可以保留这段对话。</p><Button variant="outline" disabled={busy} onClick={() => run(() => runtime.api.call(roomPath + '/dismiss', {}))}>继续保留</Button><Button variant="ghost" disabled={busy || !!pending} onClick={() => run(() => propose({ action: 'become-owner', targetSubjectId: subjectId }))}>成为房主</Button></div>}</section>
        <section className="conversation-leave"><Button variant="ghost" onClick={() => leaveTo('/app/governance?targetType=room&targetId=' + room.roomId)}>举报这段对话</Button><Button variant="ghost" disabled={busy || !!pending} onClick={() => setAction({ kind: 'dissolve' })}>发起解散</Button><Button variant="outline" disabled={busy} onClick={() => setAction({ kind: 'leave' })}>退出对话</Button></section>
      </div>}
    </dialog>
    <dialog ref={actionDialog} className="conversation-confirm" onClose={() => setAction(null)} aria-labelledby="conversation-confirm-title"><h2 id="conversation-confirm-title">{action?.kind === 'leave' ? '退出这段对话？' : action?.kind === 'retract' ? '撤回这条消息？' : '解散这段对话？'}</h2><p>{action?.kind === 'leave' ? '退出后，再次查看消息需要重新获得邀请。' : action?.kind === 'retract' ? '成员将无法继续读取这条消息。' : '这会向相关成员发出解散请求。'}</p><div className="button-row"><Button variant="ghost" onClick={() => setAction(null)}>取消</Button><Button disabled={busy} onClick={() => run(async (check) => {if(!action)return;const selected=action;if(selected.kind==='leave'){await runtime.api.call(roomPath+'/leave',{});if(check())leaveTo('/app/rooms');}else if(selected.kind==='retract')await runtime.api.call(`${roomPath}/messages/${selected.messageId}/retract`,{});else await propose({action:'dissolve'});if(check())setAction(value=>value===selected?null:value);})}>{action?.kind === 'leave' ? '退出对话' : action?.kind === 'retract' ? '撤回消息' : '发出请求'}</Button></div></dialog>
  </section>
    {!roomId&&<section className="selected-conversation-placeholder"><MessageCircle size={34}/><h2>从一段对话继续</h2><p>选择已有对话，或发起一次新的交流。</p></section>}
    {roomId&&room&&<aside className="selected-conversation-materials" aria-label="共享资料与成员"><header><h2>共享资料</h2><button type="button" className="text-link" onClick={()=>setPanel('shared')}>查看资料</button></header><section><h3>当前已读取的文件</h3>{sharedFiles.length?<ChatAttachmentFiles runtime={runtime} items={sharedFiles}/>:<p className="selected-materials-empty">已读取的消息中没有共享文件。</p>}</section><section><h3>对话成员</h3><ul className="selected-member-preview">{room.members.map(member=><li key={member.subjectId}><MemberAvatar subjectId={member.subjectId} own={member.subjectId===subjectId} name={displayNames[member.subjectId]??undefined}/><MemberLink subjectId={member.subjectId} name={name(member.subjectId)} ownId={subjectId} navigate={leaveTo}/></li>)}</ul><button type="button" className="text-link" onClick={openMembers}>成员与设置</button></section></aside>}
  </div>;
}
