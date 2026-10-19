import {ReadingDetails,ReadingSummary} from './reading-details';
import React,{useEffect,useEffectEvent,useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Bot,X} from 'lucide-react';
import {readableTime} from './conversation-ui';
import {createChatAgentClient} from './chat-agent-client.mjs';
import {useChoiceViewLease,type ChoiceViewLease} from './choice-retained-operations';
import {useGovernanceDraft} from './governance-presentation';
import {agentAuthorizationActionEvent,agentParticipationChangedEvent} from './agent-participants';
import './agent-participants.css';
import {chatErrorCode,type ChatRuntime,type ChatRoom} from './chat-workspace-types';
import {emptyAgentForm,hasAgentGrantInput,agentGrantEditorInput,grantRef,sameGrant,sameAgentOperation,retainedAgentExpiry,readAgentAction,type AgentBinding,type AgentGrant,type AgentGrantRef,type AgentGrantInput,type AgentOperation,type AgentForm,type AgentAttempt,type AgentSelection,type AgentPreview,type AgentDisplay,type AgentClient,type AgentResult} from './chat-agent-types';

const grantLabels:Record<string,string>={active:'当前可用',revoked:'已撤销',expired:'已到期','binding-unavailable':'客户端已不可用','room-inactive':'对话已停止新增内容'};
const modeLabels:Record<string,string>={read:'只读取消息',draft:'读取消息并准备草稿',respond:'读取消息并回复'};
const modeDetails:Record<string,string>={read:'只读取这段对话中已经获准查看的消息。',draft:'读取获准的消息并准备草稿，由你决定是否发送。',respond:'读取获准的消息、准备草稿，并在这段对话中发送回复。'};
function agentError(error:unknown){const code=chatErrorCode(error)??'';return({receipt_status_authority_changed:'身份或连接已改变，请重新打开这次参与设置。',access_denied:'当前连接或权限已失效，请重新连接后继续。',chat_access_denied:'当前身份不能调整这段对话的参与授权。',connection_required:'请连接当前银河身份后继续。',chat_room_read_only:'这段对话当前不能调整参与授权。',chat_agent_not_authorized:'所选客户端当前不能取得这项参与授权，请重新选择。'} as Record<string,string>)[code]??(typeof code==='string'&&/[\u3400-\u9fff]/.test(code)?code:'这次参与设置暂未完成，你的选择已保留。');}
type ChatAgentProps={runtime:ChatRuntime;room:ChatRoom;navigate:(path:string)=>void};
export function ChatAgentWorkspace(props:ChatAgentProps){
 const subjectId=props.runtime.api.snapshot()?.subjectId,scope=useChoiceViewLease(props.runtime,subjectId);
 return <ChatAgentView key={JSON.stringify([props.room.roomId,props.runtime.api.endpoint,scope.key])} {...props} lease={scope.lease}/>;
}
function ChatAgentView({runtime,room,navigate,lease}:ChatAgentProps&{lease:ChoiceViewLease|null}){
 const [owner]=useState<{subjectId?:string;bindingId?:string;generation?:number;endpoint:string}>(()=>({...runtime.api.snapshot(),endpoint:runtime.api.endpoint}));
 const client=useMemo<AgentClient>(()=>createChatAgentClient(runtime),[runtime]);
 const initial=emptyAgentForm,fieldId=useId();
 const draft=useGovernanceDraft<AgentForm,AgentAttempt>(runtime,owner.subjectId,!!lease,'chat-agent-input:v1:'+JSON.stringify([owner.endpoint,owner.subjectId,room.roomId]),initial);
 const draftApi=useRef(draft);
 const [bindings,setBindings]=useState<AgentBinding[]>([]),[bindingNext,setBindingNext]=useState<string|null>(null),[grants,setGrants]=useState<AgentGrant[]>([]);
 const [busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[message,setMessage]=useState(''),[readError,setReadError]=useState(''),[pending,setPending]=useState<AgentOperation|null>(null),[pendingReason,setPendingReason]=useState(''),[preview,setPreview]=useState<AgentPreview|null>(null);
 const [roomState,setRoomState]=useState(room.state),[now,setNow]=useState(()=>Math.floor(Date.now()/1000));
 const storedForm={...initial,...draft.value},restoredExpiry=retainedAgentExpiry(storedForm,pending,owner,room.roomId);
 const form:AgentForm={...storedForm,expiresAt:restoredExpiry,fixedExpiry:storedForm.fixedExpiry||storedForm.expiresAt!==restoredExpiry},formRef=useRef(form);
 const mounted=useRef(true),working=useRef(false),reading=useRef(false),revision=useRef(0),bindingPages=useRef(1),dialog=useRef<HTMLDialogElement>(null),editor=useRef<HTMLFormElement>(null),resuming=useRef<Promise<AgentResult>|null>(null),previewRef=useRef(preview);
 useLayoutEffect(()=>{draftApi.current=draft;formRef.current=form;previewRef.current=preview;});
 const actionProgress=useRef({kind:'',revoked:false,grantAttempted:false,grantAccepted:false});
 const current=()=>{try{if(!lease)return false;lease.assertCurrent();const value=runtime.api.snapshot();return mounted.current&&runtime.api.endpoint===owner.endpoint&&value?.subjectId===owner.subjectId&&value?.bindingId===owner.bindingId&&value?.generation===owner.generation;}catch{return false;}};
 const assertCurrent=()=>{if(!current())throw Error('身份或连接已改变，请重新打开参与设置。');};
 const bindingName=(id?:string)=>{if(!id)return'尚未选择客户端';if(id===owner.bindingId)return'当前客户端';const value=bindings.find(item=>item.bindingId===id),created=Date.parse(value?.createdAt??'');return(Number.isFinite(created)?'连接于 '+new Date(created).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'客户端')+' · '+id.slice(-4);};
 const available=bindings.filter(item=>item.state==='active'&&item.scopes?.includes('binding')).sort((left,right)=>{const priority=(item:AgentBinding)=>item.bindingId===owner.bindingId?0:item.bindingId===form.bindingId?1:2;return priority(left)-priority(right)||(Date.parse(right.createdAt)||0)-(Date.parse(left.createdAt)||0);});
 const pendingBlocks=!!pending&&!pending.canStartNewSelection,writable=!['archived','owner-succession'].includes(roomState);
 function change(patch:Partial<AgentForm>){const activeDraft=draftApi.current;if(!current()||!activeDraft.ready)return;formRef.current={...formRef.current,...patch};activeDraft.change(patch);}
 function notify(){if(current())window.dispatchEvent(new CustomEvent(agentParticipationChangedEvent,{detail:{roomId:room.roomId,subjectId:owner.subjectId,endpoint:owner.endpoint}}));}
 async function exactGrant(id:string){const result=await client.list(room.roomId,{grantId:id,limit:1});assertCurrent();const value=result.items?.find((item)=>item.grantId===id);if(value&&(value.subjectId!==owner.subjectId||value.roomId!==room.roomId))throw Error('这项授权不属于当前身份与对话。');return value??null;}
 async function exactBinding(id:string){const result:{items:AgentBinding[];nextAfter:string|null}=await runtime.api.call('/v1/bindings/query',{bindingId:id,limit:1});assertCurrent();const value=result.items?.find((item)=>item.bindingId===id);if(value)setBindings(old=>[value,...old.filter(item=>item.bindingId!==id)]);return value??null;}
 async function readWritableRoom(){const value:ChatRoom=await runtime.api.call('/v2/chat/rooms/'+room.roomId+'/read',{});assertCurrent();if(value.roomId!==room.roomId)throw Error('当前对话暂时无法核对。');setRoomState(value.state);if(['archived','owner-succession'].includes(value.state))throw Error('这段对话当前不能调整参与授权。');return value;}
 async function settleDraft(){
  if(!draftApi.current.ready)return;
  await draftApi.current.settle(async(locator)=>{
   if(locator?.kind!=='grant'||!locator.grantId)return{state:'unknown'};
   const value=await exactGrant(locator.grantId);
   return value&&value.bindingId===locator.bindingId&&value.mode===locator.mode&&value.expiresAt===locator.expiresAt?{state:'acknowledged'}:{state:'unknown'};
  });
 }
 async function refresh(){
  const version=++revision.current;let reason='';const savedOperation=await client.pending(room.roomId);assertCurrent();
  if(savedOperation&&!working.current&&!previewRef.current){
   const restoring=client.resumePending(room.roomId);resuming.current=restoring;
   try{const result=await restoring;reason=result.reason??'';}catch{reason='unconfirmed';}finally{if(resuming.current===restoring)resuming.current=null;}
  }
  assertCurrent();let after:string|undefined;const bound:AgentBinding[]=[];
  for(let page=0;page<bindingPages.current;page++){
   const result:{items:AgentBinding[];nextAfter:string|null}=await runtime.api.call('/v1/bindings/query',{...(after?{after}:{}),limit:20});assertCurrent();
   for(const item of result.items)if(!bound.some(old=>old.bindingId===item.bindingId))bound.push(item);
   const more=result.nextAfter??undefined;if(more&&more===after)throw Error('客户端列表暂时不能继续读取。');after=more;if(!after)break;
  }
  for(const id of new Set([owner.bindingId,formRef.current.bindingId].filter((id):id is string=>!!id))){
   if(bound.some(item=>item.bindingId===id))continue;
   const value:{items:AgentBinding[]}=await runtime.api.call('/v1/bindings/query',{bindingId:id,limit:1});assertCurrent();bound.push(...value.items);
  }
  const [allowed,saved]=await Promise.all([client.list(room.roomId),client.pending(room.roomId)]);assertCurrent();
  if(version!==revision.current)return;
  setBindings(bound);setBindingNext(after??null);setGrants(allowed.items);setPending(saved);setPendingReason(reason);setLoaded(true);setReadError('');
  await settleDraft();assertCurrent();if(savedOperation&&!saved)notify();
  const view=previewRef.current;
  if(view?.kind==='inspect'){const grant=await exactGrant(view.grant.grantId);if(version===revision.current&&previewRef.current===view)setPreview(grant?{...view,grant}:{kind:'unavailable'});}
 }
 async function run(action:()=>Promise<void>,refreshAfter=true){
  if(working.current||!current())return;working.current=true;revision.current++;setBusy(true);setMessage('');actionProgress.current={kind:'',revoked:false,grantAttempted:false,grantAccepted:false};
  try{if(resuming.current)await resuming.current.catch(()=>{});assertCurrent();await action();assertCurrent();if(refreshAfter)await refresh();}
  catch(error:unknown){if(current()){const progress=actionProgress.current;setMessage(progress.grantAccepted?'参与范围已保存，当前列表暂未重新读取。':progress.kind==='revoke'&&progress.revoked?'这项授权已撤销，当前列表暂未重新读取。':(progress.kind==='grant'&&progress.revoked?'原授权已撤销。'+(progress.grantAttempted?'新范围的提交结果还未确认。':'新范围尚未提交。'):'')+agentError(error));try{const saved=await client.pending(room.roomId);if(current())setPending(saved);}catch{}if(current()&&previewRef.current?.kind!=='changed')setPreview(null);}}
  finally{working.current=false;if(current())setBusy(false);}
 }
 function focusEditor(){
  const element=editor.current;if(!element)return;
  const panel=element.closest<HTMLDialogElement>('.conversation-panel');
  if(panel){const header=panel.querySelector<HTMLElement>(':scope > header'),offset=(header?.getBoundingClientRect().height??0)+12;panel.scrollTo({top:Math.max(0,panel.scrollTop+element.getBoundingClientRect().top-panel.getBoundingClientRect().top-offset),behavior:'auto'});}
  else element.scrollIntoView({block:'start',inline:'nearest'});
  element.querySelector<HTMLElement>('select,input')?.focus({preventScroll:true});
 }
 function selectEditor(next:Partial<AgentForm>){
  const value=formRef.current;
  if(value.editing==='grant'&&next.editing==='grant'&&value.originalGrant?.grantId&&value.originalGrant.grantId===next.originalGrant?.grantId){focusEditor();return;}
  if(hasAgentGrantInput(value)||value.childTitle.trim()){setPreview({kind:'switch-editor',next});return;}
  change(next);
 }
 async function checkSelection(input:AgentGrantInput,original:AgentGrantRef|null){
  await readWritableRoom();
  if(!['read','draft','respond'].includes(input.mode)||!Number.isInteger(input.expiresAt)||input.expiresAt<=Math.floor(Date.now()/1000))throw Error('所选参与期限已经过去，请重新选择期限。');
  const binding=await exactBinding(input.bindingId);if(!binding||binding.state!=='active'||!binding.scopes?.includes('binding'))throw Error('这个客户端当前不能参与，请重新选择。');
  if(original){const fresh=await exactGrant(original.grantId);if(!fresh||fresh.state!=='active'||!sameGrant(original,fresh)){setPreview({kind:'changed',grant:fresh,original});return false;}}
  return true;
 }
 async function submitGrant(){
  const first=await draftApi.current.snapshot();assertCurrent();const saved={...initial,...first.value},value={...saved,expiresAt:retainedAgentExpiry(saved,pending,owner,room.roomId)};
  if(typeof value.expiresAt!=='number'||!Number.isInteger(value.expiresAt)||value.expiresAt<=now)throw Error('请选择这次授权的到期时间后继续。');
  // Persist the exact selected deadline before either revoke or grant can write.
  // A failed journal write must not turn the next attempt into a fresh duration.
  change({expiresAt:value.expiresAt,fixedExpiry:true});
  const snapshot=await draftApi.current.snapshot();assertCurrent();const selected={...initial,...snapshot.value};
  if(typeof selected.expiresAt!=='number'||!Number.isInteger(selected.expiresAt))throw Error('请重新核对所选到期时间。');
  const input:AgentGrantInput={bindingId:selected.bindingId,mode:selected.mode,primaryResponder:selected.mode==='respond'&&!!selected.primary,expiresAt:selected.expiresAt};
  await confirmGrant({input,original:selected.originalGrant,draftRevision:snapshot.revision});
 }
 async function attachGrant(input:AgentGrantInput,id:string,selectedRevision:string|null){if(!id)return;await draftApi.current.attach({kind:'grant',grantId:id,bindingId:input.bindingId,mode:input.mode,expiresAt:input.expiresAt},selectedRevision);}
 async function confirmGrant(chosen:AgentSelection){
  actionProgress.current.kind='grant';
  if(!await checkSelection(chosen.input,chosen.original))return;
  let savedRevision=chosen.draftRevision;
  if(chosen.original){
   const result=await client.revoke(room.roomId,chosen.original.grantId,{confirmed:true});assertCurrent();
   if(!result?.revoked&&result?.state!=='revoked')throw Error('正在确认原授权是否已经撤销。新的参与范围尚未提交。');
   actionProgress.current.revoked=true;notify();
   change({originalGrant:null,keepExpiry:false,expiresAt:chosen.input.expiresAt,fixedExpiry:true});
   const saved=await draftApi.current.snapshot();assertCurrent();savedRevision=saved.revision;
  }
  if(chosen.input.expiresAt<=Math.floor(Date.now()/1000))throw Error('新的参与期限已经过去，请重新选择后继续。');
  let result;
  try{actionProgress.current.grantAttempted=true;result=await client.grant(room.roomId,chosen.input,{confirmed:true});assertCurrent();}
  catch(error){if(current()){const original=await client.pending(room.roomId);assertCurrent();if(original?.kind==='grant'&&original.input.bindingId===chosen.input.bindingId&&original.input.mode===chosen.input.mode&&original.input.primaryResponder===chosen.input.primaryResponder&&original.input.expiresAt===chosen.input.expiresAt)await attachGrant(chosen.input,original.input.grantId,savedRevision);}throw error;}
  if(!result?.grantId||['unconfirmed','stopped-local'].includes(result.state??''))throw Error('正在确认这次参与授权，你的选择仍保留。');
  actionProgress.current.grantAccepted=true;
  await attachGrant(chosen.input,result.grantId,savedRevision);await settleDraft();assertCurrent();notify();setPreview(null);setMessage('已保存这次 AI 参与范围。');
 }
 async function confirmRevoke(chosen:{grant:AgentGrantRef}){
  actionProgress.current.kind='revoke';
  await readWritableRoom();const fresh=await exactGrant(chosen.grant.grantId);
  if(fresh?.state==='revoked'){actionProgress.current.revoked=true;notify();setPreview(null);setMessage('这项授权已经撤销。');return;}
  if(!fresh||!sameGrant(chosen.grant,fresh)||fresh.state!=='active'){setPreview({kind:'changed',grant:fresh,original:chosen.grant,action:'revoke'});return;}
  const result=await client.revoke(room.roomId,fresh.grantId,{confirmed:true});assertCurrent();if(!result?.revoked&&result?.state!=='revoked')throw Error('正在确认这次撤销，原记录仍保留。');actionProgress.current.revoked=true;notify();setPreview(null);setMessage('已撤销这项 AI 参与授权。');
 }
 async function continueOriginal(chosen:Extract<AgentPreview,{kind:'retry'}>){
  const actual=await client.reviewPending(room.roomId);assertCurrent();
  if(actual?.state==='acknowledged'){setPreview(null);await settleDraft();notify();setMessage('上次操作已收到。');return;}
  if(!sameAgentOperation(actual,chosen.record)){setPreview(actual?{kind:'retry',record:actual}:null);setMessage('待确认的操作已经变化，请核对当前显示的记录后再继续。');return;}
  const result=await client.retry(room.roomId,{confirmed:true});assertCurrent();
  if(['unconfirmed','stopped-local'].includes(result?.state??'')){setPendingReason(result.reason??result.state??'unconfirmed');throw Error('原操作暂未完成，原参与范围与期限仍保留。');}
  await settleDraft();notify();setPreview(null);setMessage('上次参与设置已收到，当前状态已重新读取。');
 }
 async function createChild(){
  const snapshot=await draftApi.current.snapshot();assertCurrent();
  const title=snapshot.value.childTitle.trim();if(!title)throw Error('请填写这段讨论的名称。');
  await readWritableRoom();
  const created=await runtime.chat.create({title,kind:'ai-subzone',parentRoomId:room.roomId,retentionDays:room.retentionDays,taskRefs:[]},{confirmed:true});
  assertCurrent();change(initial);navigate('/app/rooms/'+created.roomId);
 }
 const refreshLatest=useEffectEvent(refresh);
 const readFailure=useEffectEvent((error:unknown)=>{if(current()){setBindings([]);setGrants([]);setReadError(agentError(error));setLoaded(true);if(previewRef.current?.kind==='inspect')setPreview({kind:'unavailable'});}});
 const dispatchAction=useEffectEvent((event:Event)=>{
  const value=readAgentAction(event instanceof CustomEvent?event.detail:null);
  if(!value||value.roomId!==room.roomId||value.endpoint!==owner.endpoint||value.subjectId!==owner.subjectId||!current())return;
  void run(async()=>{
   if(!draftApi.current.ready)throw Error('正在恢复你的选择，请稍后再试。');
   const grant=await exactGrant(value.grantId);if(!grant)throw Error('这项授权当前无法读取。');
   if(value.kind==='inspect'){setPreview({kind:'inspect',grant});return;}
   const observed=value.observed;
   if(grant.state!=='active'||observed&&(grant.mode!==observed.mode||grant.primaryResponder!==observed.primaryResponder||grant.expiresAt!==observed.expiresAt||grant.state!==observed.state)){setPreview({kind:'changed',grant,action:value.kind});notify();return;}
   if(value.kind==='revoke'){await confirmRevoke({grant});await refresh();return;}
   await exactBinding(grant.bindingId);selectEditor({editing:'grant',bindingId:grant.bindingId,mode:grant.mode,primary:!!grant.primaryResponder,hours:24,keepExpiry:true,expiresAt:grant.expiresAt,fixedExpiry:false,originalGrant:grantRef(grant)});
  },false);
 });
 const reloadLatest=useEffectEvent(()=>{
  if(document.hidden||working.current||reading.current||!current())return;reading.current=true;
  void refreshLatest().catch(readFailure).finally(()=>{reading.current=false;});
 });
 useEffect(()=>{
  const life=mounted,sequence=revision;life.current=true;reloadLatest();
  const update=()=>{if(!document.hidden){setNow(Math.floor(Date.now()/1000));reloadLatest();}};
  const timer=window.setInterval(update,20000);document.addEventListener('visibilitychange',update);window.addEventListener(agentAuthorizationActionEvent,dispatchAction);
  return()=>{life.current=false;sequence.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',update);window.removeEventListener(agentAuthorizationActionEvent,dispatchAction);};
 },[runtime,room.roomId]);
 const settleLatest=useEffectEvent(()=>{if(!working.current)void settleDraft().catch(error=>{if(current())setReadError(agentError(error));});});
 useEffect(()=>{if(draft.ready)settleLatest();},[draft.ready]);
 const previewOpen=preview!==null;
 useEffect(()=>{if(previewOpen)dialog.current?.showModal();else dialog.current?.close();},[previewOpen]);
 const focusLatest=useEffectEvent(focusEditor),editingGrantId=form.originalGrant?.grantId;
 useEffect(()=>{if(form.editing!=='grant')return;const frame=requestAnimationFrame(focusLatest);return()=>cancelAnimationFrame(frame);},[form.editing,editingGrantId]);
 const selected:AgentDisplay|undefined=preview?.kind==='retry'?preview.record.input:preview&&'grant' in preview?preview.grant??undefined:undefined;
 const isRevoke=preview?.kind==='retry'&&preview.record.kind==='revoke';
 const expiredRetry=preview?.kind==='retry'&&preview.record.kind==='grant'&&typeof selected?.expiresAt==='number'&&selected.expiresAt<=now;
 const validRetry=preview?.kind!=='retry'||isRevoke||!!selected?.bindingId&&['read','draft','respond'].includes(selected?.mode??'')&&Number.isInteger(selected?.expiresAt);
 const records=(grant:AgentDisplay|undefined|null)=><ReadingDetails className="agent-record-details"><ReadingSummary>记录信息</ReadingSummary><dl><dt>对话</dt><dd>{room.roomId}</dd>{grant?.grantId&&<><dt>授权记录</dt><dd>{grant.grantId}</dd></>}{grant?.bindingId&&<><dt>客户端绑定</dt><dd>{grant.bindingId}</dd></>}{grant?.createdAt&&<><dt>建立时间</dt><dd>{readableTime(grant.createdAt)}</dd></>}{grant?.revokedAt&&<><dt>撤销时间</dt><dd>{readableTime(grant.revokedAt)}</dd></>}</dl><p>此记录表示已授权的范围，宿主运行状态未核实。</p></ReadingDetails>;
 const scope=(grant:AgentDisplay|undefined|null)=><div className="agent-scope-summary"><strong>{bindingName(grant?.bindingId)}</strong><p>{modeLabels[grant?.mode??'']??'参与方式暂不可读'}{grant?.primaryResponder?' · 主要回复者':''}</p>{grant?.expiresAt&&<p>有效至 {readableTime(grant.expiresAt*1000)}</p>}</div>;
 return <section className="chat-agent-controls agent-authorization">
  {message&&<output className="message">{message}</output>}{readError&&<output className="message error">{readError} <button className="text-link" disabled={busy} onClick={()=>void run(refresh,false)}>重新读取</button></output>}
  {pending&&<div className="agent-pending"><div><strong>上次参与设置仍待确认</strong><p>{pendingReason==='authorization-expired'?'原期限已过，可以重新选择参与方式。':pending.state==='stopped-local'?'本机已停止继续发送，原记录仍保留。':'原客户端、参与范围和期限已保留。'}</p></div><button className="text-link" disabled={busy} onClick={()=>void run(async()=>{const record=await client.reviewPending(room.roomId);assertCurrent();if(record?.state==='acknowledged'){await settleDraft();notify();setMessage('上次操作已收到。');}else if(record){const target=record.kind==='revoke'?await exactGrant(record.input.grantId):null;assertCurrent();setPreview({kind:'retry',record,target});}},false)}>查看原选择 </button></div>}
  {!form.editing&&<div className="agent-setup-entry"><Button variant="outline" disabled={busy||pendingBlocks||!writable||!draft.ready} onClick={()=>{const value=formRef.current,next=agentGrantEditorInput(value,Math.floor(Date.now()/1000));if(hasAgentGrantInput(value))change(next);else selectEditor(next);}}><Bot size={16}/>{hasAgentGrantInput(form)?'继续设置我的 AI':grants.some(grant=>grant.state==='active')?'添加 AI 客户端':'让我的 AI 参与'}</Button></div>}
  {form.editing==='grant'&&<form ref={editor} className="workspace-form agent-permission-editor" onSubmit={event=>{event.preventDefault();void run(()=>submitGrant());}}>
   <header><div><p className="eyebrow">只适用于这段对话</p><h4>{form.originalGrant?'调整我的 AI 参与方式':'让我的 AI 参与'}</h4></div><button type="button" className="icon-button" aria-label="返回参与方式" disabled={busy} onClick={()=>change({editing:null})}><X size={18}/></button></header>
   <div className="agent-form-context">{room.title&&<p>对话：{room.title}</p>}{form.originalGrant&&<p>原参与范围：{modeLabels[form.originalGrant.mode]}{form.originalGrant.primaryResponder?' · 主要回复者':''}</p>}</div>
   <fieldset disabled={busy||!draft.ready}>
    <label>选择我的客户端<select required value={form.bindingId} disabled={!!form.originalGrant} onChange={event=>change({bindingId:event.target.value})}><option value="">请选择客户端</option>{available.map(binding=><option key={binding.bindingId} value={binding.bindingId}>{bindingName(binding.bindingId)}</option>)}{form.bindingId&&!available.some(binding=>binding.bindingId===form.bindingId)&&<option value={form.bindingId}>{bindingName(form.bindingId)}（当前不可用）</option>}</select></label>
    {loaded&&!available.length&&<p className="muted">当前没有可以选择的客户端。可以在身份设置中连接客户端。</p>}
    {bindingNext&&!form.originalGrant&&<button type="button" className="text-link" onClick={()=>void run(async()=>{bindingPages.current++;await refresh();},false)}>更多客户端</button>}
    <fieldset className="agent-mode-options"><legend>{form.originalGrant?'调整后，我的 AI 可以做什么':'我的 AI 可以做什么'}</legend>{(['read','draft','respond'] as const).map(value=><label aria-label={modeLabels[value]} key={value} className={form.mode===value?'selected':''}><input type="radio" name={'agent-mode-'+room.roomId} value={value} checked={form.mode===value} onChange={()=>change({mode:value,primary:false})}/><span><strong>{modeLabels[value]}</strong><small>{modeDetails[value]}</small></span></label>)}</fieldset>
    {form.mode==='respond'&&<label className="agent-primary-choice"><input type="checkbox" checked={form.primary} onChange={event=>change({primary:event.target.checked})}/><span>设为我在这段对话中的主要回复 AI<small>会替换你当前指定的主要回复 AI。</small></span></label>}
    <label>这次授权持续多久<select required value={!Number.isInteger(form.expiresAt)?'':form.fixedExpiry?'fixed':form.keepExpiry?'keep':String(form.hours)} onChange={event=>{const selected=event.target.value;if(selected==='fixed')return;change(selected==='keep'?{keepExpiry:true,fixedExpiry:false,expiresAt:form.originalGrant?.expiresAt??null}:{keepExpiry:false,fixedExpiry:false,hours:Number(selected),expiresAt:Math.floor(Date.now()/1000)+Number(selected)*3600});}}>{!Number.isInteger(form.expiresAt)&&<option value="">请重新选择期限</option>}{form.fixedExpiry&&<option value="fixed">保持已选的到期时间</option>}{form.originalGrant&&<option value="keep">保留原到期时间</option>}<option value="24">24 小时</option><option value="168">7 天</option><option value="720">30 天</option></select>{typeof form.expiresAt==='number'&&Number.isInteger(form.expiresAt)?<small className="agent-expiry-note">有效至 {new Date(form.expiresAt*1000).toLocaleString('zh-CN')}{form.expiresAt<=now&&'；所选期限已过，请重新选择。'}</small>:<small className="agent-expiry-note">此前未保存准确的到期时间，请重新选择。</small>}</label>
    {form.bindingId&&<ReadingDetails className="agent-record-details"><ReadingSummary>核对所选客户端</ReadingSummary><dl>{bindings.find(binding=>binding.bindingId===form.bindingId)?.createdAt&&<><dt>连接建立于</dt><dd>{new Date(bindings.find(binding=>binding.bindingId===form.bindingId)?.createdAt??'').toLocaleString('zh-CN')}</dd></>}<dt>安装标识</dt><dd>{bindings.find(binding=>binding.bindingId===form.bindingId)?.installationId??'暂未读取'}</dd><dt>绑定标识</dt><dd>{form.bindingId}</dd></dl></ReadingDetails>}
   </fieldset>
   {!draft.ready&&draft.status&&<output>{draft.status}</output>}{draft.ready&&draft.status&& !['草稿已保存在本机。','已恢复本机草稿。','正在保存…'].includes(draft.status)&&<p className="message error">{draft.status}</p>}
   <footer><Button type="submit" disabled={busy||pendingBlocks||!form.bindingId||!writable||!draft.ready||typeof form.expiresAt!=='number'||!Number.isInteger(form.expiresAt)||form.expiresAt<=now}>{busy?'正在保存…':form.originalGrant?'保存修改':'允许参与'}</Button><button type="button" className="text-link" disabled={busy} onClick={()=>change({editing:null})}>稍后继续</button></footer>
  </form>}
  {room.kind==='ordinary'?<ReadingDetails className="agent-child-entry" mode="inline"><ReadingSummary>单独讨论 AI 进展</ReadingSummary><p>建立与这段对话关联的 AI 子区。创建后先由你加入，再邀请其他参与者。</p>{form.editing==='child'?<form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(createChild,false);}}><label htmlFor={fieldId+"-child"}>AI 子区名称<Input id={fieldId+"-child"} required maxLength={120} value={form.childTitle} disabled={busy} onChange={event=>change({childTitle:event.target.value})}/></label><div className="button-row"><Button type="submit" disabled={busy||!writable||!draft.ready}>{busy?'正在创建…':'创建 AI 子区'}</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>change({editing:null})}>返回</Button></div></form>:<Button variant="outline" disabled={busy||!writable||!draft.ready} onClick={()=>selectEditor({...initial,editing:'child',childTitle:form.childTitle})}>创建 AI 子区</Button>}</ReadingDetails>:room.parentRoomId&&<button className="text-link" onClick={()=>navigate('/app/rooms/'+room.parentRoomId)}>返回关联主对话</button>}
  <dialog ref={dialog} className="galaxy-dialog agent-permission-dialog" onCancel={event=>{event.preventDefault();if(!busy)setPreview(null);}}>
   {preview&&<><button className="dialog-close" aria-label="关闭参与设置预览" disabled={busy} onClick={()=>setPreview(null)}><X size={19}/></button>
    {preview.kind==='inspect'&&<><p className="eyebrow">我的参与授权记录</p><h3>{grantLabels[preview.grant.state]??'状态暂不可读'}</h3>{scope(preview.grant)}{records(preview.grant)}<Button variant="outline" onClick={()=>setPreview(null)}>返回参与列表</Button></>}
    {preview.kind==='unavailable'&&<><h3>这项授权当前无法读取</h3><p>请稍后从参与列表重新查看。</p><Button variant="outline" onClick={()=>setPreview(null)}>返回参与列表</Button></>}
    {preview.kind==='changed'&&<><h3>原参与范围已有变化</h3>{preview.grant?<><p>{grantLabels[preview.grant.state]??'当前状态暂不可读'}</p>{scope(preview.grant)}</>:<p>原记录当前无法读取。</p>}<p>你的选择仍保留，请按当前状态核对后继续。</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>setPreview(null)}>返回设置</Button>{preview.action==='revoke'&&preview.grant?.state==='active'&&<Button disabled={busy} onClick={()=>void run(()=>preview.grant?confirmRevoke({grant:preview.grant}):Promise.resolve())}>撤销当前这项授权</Button>}{preview.action!=='revoke'&&form.originalGrant&&preview.grant?.state==='active'&&<Button disabled={busy} onClick={()=>{change({originalGrant:preview.grant?grantRef(preview.grant):null,keepExpiry:false,fixedExpiry:true});setPreview(null);}}>按当前范围继续调整</Button>}{preview.action!=='revoke'&&form.originalGrant&&preview.grant&&['revoked','expired','binding-unavailable'].includes(preview.grant.state)&&<Button disabled={busy} onClick={()=>{change({originalGrant:null,keepExpiry:false,fixedExpiry:true});setPreview(null);}}>保留选择，重新授权</Button>}</div></>}
    {preview.kind==='retry'&&<><p className="eyebrow">上次未完成的参与设置</p><h3>{isRevoke?'撤销原授权':'原来的授权选择'}</h3>{isRevoke?<>{preview.target?scope(preview.target):<p>原授权的当前参与范围暂不可读。</p>}<p>继续撤销原记录中的这一项授权。</p></>:scope(selected)}{records(isRevoke&&preview.target?preview.target:selected)}{expiredRetry&&<p>原期限已经过去。重新授权需要再次选择并确认新的期限。</p>}{!validRetry&&<p>原记录缺少必要内容，暂时不能继续。</p>}<div className="button-row">{expiredRetry?<Button disabled={busy} onClick={()=>{setPreview(null);change({...initial,editing:'grant',bindingId:selected?.bindingId??'',mode:selected?.mode??'draft'});}}>重新选择参与方式</Button>:<Button disabled={busy||!validRetry||preview.record.state==='stopped-local'} onClick={()=>void run(()=>continueOriginal(preview))}>{busy?'正在确认…':isRevoke?'继续原撤销':'按原选择继续'}</Button>}<Button variant="outline" disabled={busy} onClick={()=>setPreview(null)}>返回</Button></div></>}
    {preview.kind==='switch-editor'&&<><h3>切换这次参与设置？</h3><p>当前尚未提交的选择将被替换。</p><div className="button-row"><Button variant="outline" onClick={()=>setPreview(null)}>继续当前设置</Button><Button onClick={()=>{change(preview.next);setPreview(null);}}>切换</Button></div></>}
   </>}
  </dialog>
 </section>;
}
