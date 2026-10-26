import { ReadingDetails, ReadingSummary } from "../../../shared/reading/reading-details";
import React, { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { createContextClientV2 } from "../../../../../galaxy-official/src/clients/context-v2.mjs";
import { MemberAvatar, memberName, readableTime, useMemberNames } from "../../../shared/people/conversation-ui";
import {checkedContextDraft,recordErrorField} from "../../work-records/record-workspace-types";
import {contextMaterialMatchesWork} from './task-context-reading.mjs';
import type {ContextClient,ContextComposeInput,ContextEvent,ContextGrantChoice,ContextMaterialInput,ContextPending,ContextPreview,ContextReceipt,ContextRenewal,ContextTask,ContextView,RecordRuntime} from "../../work-records/record-workspace-types";
type Props={task:ContextTask;runtime:RecordRuntime;subjectId?:string;connected:boolean;initialGrantId?:string|null;onReadingChange?:(grantId:string|null)=>void};

const statusNames: Record<string, string> = {
  pending: '等待接收', accepted: '已接收', declined: '已婉拒', revoked: '已撤回', expired: '已到期',
  'source-erased': '原文已清除', 'scope-changed': '参与范围已改变', 'participation-inactive': '本次参与已停止',
  'participation-unavailable': '当前无法核对参与范围', 'source-permission-unavailable': '材料授权当前不可用',
  'source-deletion-pending': '来源正在申请删除', 'acceptance-permission-unavailable': '接收授权当前不可用',
};
const errorText = (error: unknown) => ({
  context_connection_required: '请先连接当前银河身份。', context_identity_changed: '连接已变化，请重新打开材料。',
  context_original_material_deadline_expired: '这次材料已经到期。原操作仍可核对，如需重新提供，请重新选择资料与时间。',
  consent_reauthorization_required: '原发送需要你重新确认，请审阅保留的材料与接收者。',
  context_local_retry_stopped: '本机已停止发送，可以继续核对原结果。',
  context_payload_too_large: '选定的文字过长，请减少一些片段后再预览。',
} as Record<string,string>)[recordErrorField(error,'code')] ?? (recordErrorField(error,'name') === 'ZodError' ? '请补全材料名称、文字和本次接收范围。' : recordErrorField(error,'message') || '材料暂未处理完成，请稍后重试。');
const material = () => ({ id: crypto.randomUUID(), label: '', mediaType: 'text/plain' as const, content: '' });
const roleName = (role: string) => ({contribution:'一起参与',diagnosis:'分析问题',advice:'提供建议',context:'提供背景',tool:'提供工具',patch:'提供修改',review:'审阅',verification:'验证检查',takeover:'接续完成','main-responsible':'主要负责人'} as Record<string,string>)[role] ?? role;
const currentMaterial=(view:ContextView):ContextView=>view.contextAccessGranted&&view.metadata.expiresAt<=Date.now()/1000?{...view,contextAccessGranted:false,materials:[],state:'expired'}:view;

export function ContextWorkspace(props:Props) {
  const connection = props.runtime?.api.snapshot();
  return <ContextSession key={JSON.stringify([props.runtime?.api.endpoint, props.subjectId, connection?.bindingId, connection?.generation, props.task.taskId])} {...props}/>;
}
function ContextSession({ task, runtime, subjectId, connected, initialGrantId=null, onReadingChange }:Props) {
  const client = useMemo<ContextClient|null>(() => connected && runtime && subjectId ? createContextClientV2({ api: runtime.api, getLocal: runtime.getLocal, putLocal: runtime.putLocal }) : null, [runtime, subjectId, connected]);
  const [items, setItems] = useState<ContextView[]>([]), [pending, setPending] = useState<ContextPending[]>([]), [nextAfter, setNextAfter] = useState<string|null>(null), [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false), [step, setStep] = useState(0), [selected, setSelected] = useState<string[]>([]), [materials, setMaterials] = useState<ContextMaterialInput[]>([]), [minutes, setMinutes] = useState('60');
  const [preview, setPreview] = useState<ContextPreview|null>(null), [renewal, setRenewal] = useState<ContextRenewal|null>(null), [opened, setOpened] = useState<ContextView|null>(null), [openedId, setOpenedId] = useState<string|null>(initialGrantId);
  const [operationErrors, setOperationErrors] = useState<Record<string,string>>({});
  const lifecycle = useRef({generation:0,reading:0,working:false}), openId = useRef<string|null>(initialGrantId);
  const confirmation = useRef<HTMLDialogElement>(null), reader = useRef<HTMLDialogElement>(null), editor = useRef<HTMLElement>(null);
  const owner = task.requesterId === subjectId;
  const eligible = (task.participations ?? []).filter((p):p is NonNullable<ContextTask['participations']>[number]&{agreedScope:string;scopeEventId:string} => p.subjectId !== subjectId && p.scopeAvailable !== false && !!p.agreedScope && !!p.scopeEventId && ['active','delivered','accepted'].includes(p.state));
  const names = useMemberNames(runtime, subjectId, connected, [...eligible.map(p => p.subjectId), ...items.flatMap(item => [item.metadata.ownerId,item.metadata.participantId]), ...pending.map(op => op.recipientId)]);
  const name = (id: string) => names[id] ?? memberName(id);
  const waiting = pending.filter(op => op.taskId === task.taskId), activePending = waiting.filter(op => op.state !== 'stopped-local');
  const draftKey='context-compose:v1:'+task.taskId,draftLease=useMemo(()=>client&&owner?runtime.receiptStatus.captureLease():null,[runtime,client,owner]);
  const draftHead=useRef<string|null>(null),draftQueue=useRef<Promise<void>>(Promise.resolve()),draftActive=useRef({active:true}),draftFailed=useRef(false),draftStarted=useRef(false);
  const draftInput=useRef<ContextComposeInput>({materials,selected,minutes,step}),materialFieldId=useId(),minutesId=useId();
  const [loadedDraft,setDraftReady]=useState(false),[draftStatus,setDraftStatus]=useState('');
  const draftReady=!draftLease||loadedDraft;
  const checkDraft=()=>{if(!draftLease)throw Error('当前身份不能编写这项工作的材料。');draftLease.assertCurrent();};
  const checkedDraft=checkedContextDraft;
  function showDraft(input:ContextComposeInput){draftInput.current=structuredClone(input);setMaterials(input.materials);setSelected(input.selected);setMinutes(input.minutes);setStep(input.step);}
  async function settleDraft(){if(!draftLease)return null;await draftQueue.current;checkDraft();const saved=checkedDraft(await runtime.getLocal(draftKey,subjectId));checkDraft();
    if(!saved?.attempt?.length)return saved;
    for(const locator of saved.attempt){const result:ContextReceipt=await runtime.api.call('/v2/context/receipt',locator);checkDraft();if(result.grantId!==locator.grantId||result.eventId!==locator.eventId||result.payloadHash!==locator.payloadHash)throw Error('材料发送回执与草稿引用不一致，请保留原记录。');if(result.state!=='acknowledged')return saved;}
    let removed=false;const remaining=checkedDraft(await runtime.updateLocal(draftKey,(value:unknown)=>{checkDraft();const current=checkedDraft(value);if(current?.revision===saved.revision&&JSON.stringify(current.attempt)===JSON.stringify(saved.attempt)){removed=true;return null;}return current;},subjectId));checkDraft();
    if(removed&&draftHead.current===saved.revision){draftHead.current=remaining?.revision??null;draftStarted.current=!!remaining;if(draftActive.current.active){setDraftStatus('');if(JSON.stringify(draftInput.current)===JSON.stringify(saved.value)){showDraft({materials:[],selected:[],minutes:'60',step:0});setCreating(false);}}}return remaining;
  }
  const restoreDraft=useEffectEvent(()=>settleDraft());
  const applyDraft=useEffectEvent((saved:ReturnType<typeof checkedContextDraft>)=>{draftHead.current=saved?.revision??null;draftStarted.current=!!saved;if(saved){showDraft(saved.value);setCreating(true);setDraftStatus('已恢复本机草稿。');}setDraftReady(true);});
  useEffect(()=>{const availability=draftActive.current;availability.active=true;let active=true;
    if(draftLease)void restoreDraft().then(saved=>{if(active)applyDraft(saved??null);}).catch((reason:unknown)=>{draftFailed.current=true;if(active)setDraftStatus(recordErrorField(reason,'message')||'材料草稿暂未读取成功，请保留本页输入。');});
    return()=>{active=false;availability.active=false;};
  },[draftLease,draftKey]);
  function changeDraft(patch:Partial<ContextComposeInput>,inputChange=true){
    const value={...draftInput.current,...patch};showDraft(value);if(inputChange)draftStarted.current=true;if(!draftReady||draftFailed.current||!draftStarted.current)return;setDraftStatus('正在保存本机草稿…');
    const next=draftQueue.current.then(async()=>{checkDraft();const expected=draftHead.current;const saved=checkedDraft(await runtime.updateLocal(draftKey,(input:unknown)=>{checkDraft();const current=checkedDraft(input);if((current?.revision??null)!==expected)throw Error('另一页已修改这份材料草稿，当前输入仍在本页，请重新打开后核对。');return{version:1,revision:crypto.randomUUID(),value};},subjectId));checkDraft();if(!saved)throw Error('材料草稿暂未保存，请保留本页输入。');draftHead.current=saved.revision;if(draftActive.current.active&&JSON.stringify(draftInput.current)===JSON.stringify(value))setDraftStatus('草稿已保存在本机。');});
    draftQueue.current=next;void next.catch((reason:unknown)=>{draftFailed.current=true;if(draftActive.current.active)setDraftStatus(recordErrorField(reason,'message')||'草稿暂未保存，请保留本页输入。');});
  }
  async function markDraftAttempt(chosen:Extract<ContextPreview,{kind:'grants'}>){await draftQueue.current;checkDraft();const revision=chosen.draftRevision;if(!revision)return;
    const attempt=chosen.drafts.map(draft=>({grantId:draft.prepared.grantId,eventId:draft.prepared.operationId,payloadHash:draft.prepared.payloadHash}));
    await runtime.updateLocal(draftKey,(input:unknown)=>{checkDraft();const current=checkedDraft(input);return current?.revision===revision?{...current,attempt}:current;},subjectId);checkDraft();
  }
  useEffect(() => { if (preview || renewal) confirmation.current?.showModal(); else confirmation.current?.close(); }, [preview,renewal]);
  useEffect(() => { if (openedId) reader.current?.showModal(); else reader.current?.close(); }, [openedId]);
  useEffect(() => { if (!creating) return; const frame=requestAnimationFrame(() => { editor.current?.querySelector<HTMLElement>('h4')?.focus({preventScroll:true}); editor.current?.scrollIntoView({block:'start'}); }); return () => cancelAnimationFrame(frame); }, [creating,step]);
  useEffect(() => { if (!opened?.metadata?.expiresAt||!opened.contextAccessGranted) return;let timer:number;const expire=()=>{const remaining=opened.metadata.expiresAt*1000-Date.now();if(remaining<=0)setOpened({...opened,contextAccessGranted:false,materials:[],state:'expired'});else timer=window.setTimeout(expire,Math.min(remaining,2147483647));};expire();return()=>window.clearTimeout(timer); }, [opened]);

  async function load(after?: string) {
    if (!client) return;
    const token=lifecycle.current.generation,ticket=++lifecycle.current.reading,currentOpen=openId.current;
    if (currentOpen) setOpened(null);
    const page=await client.query({taskId:task.taskId,...(after?{after}:{}),limit:20});
    if (token!==lifecycle.current.generation || ticket!==lifecycle.current.reading || !navigator.onLine || document.hidden) return;
    setItems(previous => after ? [...previous.filter(x=>!page.items.some(y=>y.metadata.grantId===x.metadata.grantId)),...page.items] : page.items);
    setNextAfter(page.nextAfter??null); setLoaded(true);
    const local=await client.pending();
    if (token!==lifecycle.current.generation || ticket!==lifecycle.current.reading || !navigator.onLine || document.hidden) return;
    setPending(local);
    if (currentOpen && openId.current===currentOpen) {
      const view=await client.get(currentOpen);
      if(token===lifecycle.current.generation&&ticket===lifecycle.current.reading&&openId.current===currentOpen&&navigator.onLine&&!document.hidden)setOpened(checkedMaterial(view));
    }
  }
  function checkedMaterial(view:ContextView){if(!contextMaterialMatchesWork(view,task.taskId,subjectId))throw Error('这份材料不属于当前工作或当前身份，请回到材料列表。');return currentMaterial(view);}
  async function reconcilePending(valid:()=>boolean) {
    if (!client) return;
    const local=await client.pending(); if(!valid())return;
    for(const op of local.filter(op=>op.taskId===task.taskId)) {
      try {
        const result=await client.resumePending(op.operationId);
        if(!valid())return;
        if(result.state==='acknowledged')setOperationErrors(old=>{const next={...old};delete next[op.operationId];return next;});
        else if(result.state==='absent'&&result.reason!=='stopped-local')setOperationErrors(old=>({...old,[op.operationId]:result.reason==='authorization-expired'&&op.kind==='grant'?'这次材料的阅读时间已到期。可以核对原结果，重新交接时请重新选择资料。':'请重新审阅这次材料操作，再决定是否继续。'}));
      } catch(reason:unknown) { if(!valid())return;setOperationErrors(old=>({...old,[op.operationId]:errorText(reason)})); }
    }
    if(draftLease&&draftHead.current)await settleDraft();
  }
  async function run(fn:(valid:()=>boolean)=>Promise<void>) {
    if(!client||lifecycle.current.working)return;
    const token=lifecycle.current.generation,valid=()=>token===lifecycle.current.generation;
    lifecycle.current.working=true;setBusy(true);setError('');setNotice('');
    try { await fn(valid); } catch(reason) { if(valid())setError(errorText(reason)); }
    finally { if(valid()){try{const local=await client.pending();if(valid())setPending(local);}catch{}setBusy(false);}lifecycle.current.working=false; }
  }
  const refreshOnTick=useEffectEvent(()=>{if(!client||document.hidden||!navigator.onLine||lifecycle.current.working)return;void run(async valid=>{await reconcilePending(valid);if(valid())await load();});});
  useEffect(() => {
    const control=lifecycle.current;control.generation++;
    const refresh=()=>refreshOnTick();
    refresh();const timer=setInterval(refresh,20000);document.addEventListener('visibilitychange',refresh);
    return()=>{control.generation++;control.reading++;clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[client,task.taskId]);
  useEffect(()=>{
    const control=lifecycle.current,hide=()=>{control.reading++;setOpened(null);},resume=()=>{hide();refreshOnTick();};
    window.addEventListener('offline',hide);window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);
    return()=>{window.removeEventListener('offline',hide);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);};
  },[client]);
  const readVersion=useEffectEvent(()=>{if(client&&!lifecycle.current.working)void run(()=>load());});
  useEffect(()=>{readVersion();},[task.version]);
  const readLocation=useEffectEvent((id:string|null)=>{if(openId.current===id)return;openId.current=id;lifecycle.current.reading++;setOpenedId(id);setOpened(null);if(id)refreshOnTick();});
  useEffect(()=>{readLocation(initialGrantId);},[initialGrantId]);
  function closeReader(){openId.current=null;lifecycle.current.reading++;setOpenedId(null);setOpened(null);onReadingChange?.(null);}
  async function openMaterial(id:string,valid:()=>boolean){const ticket=++lifecycle.current.reading;openId.current=id;setOpenedId(id);setOpened(null);onReadingChange?.(id);const view=await client!.get(id);if(valid()&&ticket===lifecycle.current.reading&&openId.current===id&&navigator.onLine&&!document.hidden)setOpened(checkedMaterial(view));}
  function begin(){setCreating(true);setPreview(null);if(!materials.length)showDraft({materials:[material()],selected:[],minutes:'60',step:0});}
  async function prepare(valid:()=>boolean,clock:()=>number,send=false) {
    await draftQueue.current;checkDraft();if(!valid())return;const draftRevision=draftHead.current;
    const recipients=eligible.filter(p=>selected.includes(p.participationId));
    if(!recipients.length)throw Error('请选择至少一位已经确认工作范围的参与者。');
    if(!materials.length||materials.some(m=>!m.label.trim()||!m.content.trim())){setStep(0);throw Error('请填写材料名称与要交接的文字。');}
    const duration=Number(minutes);if(!Number.isInteger(duration)||duration<5||duration>43200)throw Error('可阅读时间须在 5 分钟到 30 天之间。');
    const expiresAt=Math.floor(clock()/1000)+duration*60,drafts:ContextGrantChoice[]=[];
    for(const p of recipients){
      const payload:ContextGrantChoice['payload']={schemaVersion:2,id:crypto.randomUUID(),taskId:task.taskId,participationId:p.participationId,participantId:p.subjectId,scopeVersion:p.scopeVersion,scopeEventId:p.scopeEventId,expiresAt,materials:structuredClone(materials)};
      const prepared=await client!.prepareGrant(payload);if(!valid())return;drafts.push({prepared,payload,recipient:p});
    }
    if(valid()){const chosen:ContextPreview={kind:'grants',drafts,draftRevision};if(send)await commit(valid,chosen);else setPreview(chosen);}
  }
  async function prepareEvent(item:ContextView,kind:ContextEvent['kind'],valid:()=>boolean,execute=false) {
    const current=await client!.get(item.metadata.grantId,{metadataOnly:true});if(!valid())return;
    if(kind!=='revoke'&&current.state!=='pending')throw Error('这份材料的状态已改变，请查看当前结果。');
    const prepared=await client!.prepareEvent(kind,current.metadata);
    if(valid()){const chosen:ContextPreview={kind,drafts:[{prepared,metadata:current.metadata,materials:current.materials}]};if(execute){if(kind==='accept'){openId.current=current.metadata.grantId;setOpenedId(current.metadata.grantId);setOpened(null);}await commit(valid,chosen);}else setPreview(chosen);}
  }
  async function commit(valid:()=>boolean,chosen=preview) {
    if(!chosen)return;let completed=0;const failures:string[]=[];
    if(chosen.kind==='grants'){await markDraftAttempt(chosen);if(!valid())return;}
    for(const draft of chosen.drafts){
      try{await client!.execute(draft.prepared,{confirmed:true});completed++;}
      catch(reason){failures.push(errorText(reason));}
      if(!valid())return;
    }
    setPreview(null);
    if(chosen.kind==='grants')await settleDraft();
    await load();if(!valid())return;
    setNotice(chosen.kind==='grants'?completed?'已向 '+completed+' 位参与者发送资料，等待各自接收。':'发送暂未完成，正在保留本次资料。':chosen.kind==='accept'?'已接收，正在打开获准正文。':chosen.kind==='decline'?'已婉拒这份材料。':'已撤回这份材料。');
    if(failures.length)setError([...new Set(failures)].join('；'));
    if(chosen.kind==='accept'&&completed>0&&!failures.length&&valid()&&openId.current===chosen.drafts[0].metadata.grantId)await openMaterial(chosen.drafts[0].metadata.grantId,valid);
  }
  async function reviewOperation(op:ContextPending,valid:()=>boolean){
    const review=await client!.reviewAuthorization(op.operationId);if(!valid())return;
    if(review.state==='reauthorization-required')setRenewal(review);
    else{
      if(review.state!=='acknowledged'&&review.state!=='stopped-local'){await client!.retry(op.operationId,{confirmed:true});if(!valid())return;}
      await load();
    }
  }
  if(!client||!connected)return null;
  return <section className="material-workspace" aria-label="工作材料">
    {error&&<p className="message error" role="alert">{error}{!loaded&&<button className="text-link" onClick={()=>run(()=>load())}>重新读取</button>}</p>}
    {notice&&<p className="message"><output>{notice}</output></p>}
    {!creating&&<>
      <div className="section-heading"><p>{owner?'对方先确认接收，再打开本次交接的文字。':'先核对材料目录，接收后即可打开正文。'}</p>{owner&&task.state==='open'&&eligible.length>0&&<Button disabled={busy||activePending.length>0||!draftReady} onClick={begin}>{materials.length?'继续整理资料':'交接资料'}</Button>}</div>
      {draftStatus&&<p className="record-meta"><output>{draftStatus}</output></p>}
      {owner&&!eligible.length&&<p className="empty-state">有参与者确认工作范围后，可以在这里向其提供资料。</p>}
      {!items.length&&!(!eligible.length&&owner)&&<p className="empty-state">{loaded?'这里还没有共享材料。':'正在读取共享材料…'}</p>}
      <div className="material-list">{items.map(item=>{
        const m=item.metadata,title=(item.materials??[]).map(x=>x.label).join('、')||'工作材料';
        return <article key={m.grantId} className="material-row">
          <div className="member-line"><MemberAvatar subjectId={owner?m.participantId:m.ownerId}/><div><h4>{title}</h4><p>{owner?'给 '+name(m.participantId):'来自 '+name(m.ownerId)} · {statusNames[item.state]??'当前不可用'}</p></div></div>
          <p className="record-meta">{['pending','accepted'].includes(item.state)?'可阅读至':'原定有效至'} {readableTime(m.expiresAt)}</p>
          <div className="button-row">{m.participantId===subjectId&&item.state==='pending'&&<><Button disabled={busy||activePending.length>0} onClick={()=>run(valid=>prepareEvent(item,'accept',valid,true))}>接收并阅读</Button><button className="text-link" disabled={busy} onClick={()=>run(valid=>prepareEvent(item,'decline',valid,true))}>婉拒</button></>}
          {(m.ownerId===subjectId||item.state==='accepted')&&['pending','accepted'].includes(item.state)&&<Button variant="outline" disabled={busy} onClick={()=>run(valid=>openMaterial(m.grantId,valid))}>打开材料</Button>}
          {m.ownerId===subjectId&&!['revoked','source-erased'].includes(item.state)&&<button className="text-link" disabled={busy} onClick={()=>run(valid=>prepareEvent(item,'revoke',valid))}>撤回</button>}</div>
          <ReadingDetails className="technical-details"><ReadingSummary>交接范围与准确引用</ReadingSummary><p>参与范围第 {m.scopeVersion} 版；提供者 {m.ownerId}；接收者 {m.participantId}。</p><p>材料 {m.grantId}；摘要 {m.materialsHash}</p></ReadingDetails>
        </article>;
      })}</div>
      {nextAfter&&<Button variant="outline" disabled={busy} onClick={()=>run(()=>load(nextAfter))}>更多材料</Button>}
    </>}
    {creating&&<section className="material-editor" ref={editor} style={{scrollMarginTop:'6rem'}}>
      <button className="back-link" onClick={()=>setCreating(false)}> 回到材料列表</button>
      {draftStatus&&<p className="record-meta"><output>{draftStatus}</output></p>}
      <form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(valid=>prepare(valid,()=>Date.now(),true));}}>
        <h4 tabIndex={-1}>把这次需要的资料交给对方</h4>
        {materials.map((m,index)=><fieldset disabled={busy} key={m.id}><legend>材料 {index+1}</legend><label htmlFor={materialFieldId+'-'+m.id+'-name'}>材料名称<Input id={materialFieldId+'-'+m.id+'-name'} required maxLength={160} value={m.label} onChange={event=>changeDraft({materials:materials.map(x=>x.id===m.id?{...x,label:event.target.value}:x)})}/></label><label htmlFor={materialFieldId+'-'+m.id+'-text'}>要交接的文字<Textarea id={materialFieldId+'-'+m.id+'-text'} required maxLength={4000} value={m.content} onChange={event=>changeDraft({materials:materials.map(x=>x.id===m.id?{...x,content:event.target.value}:x)})}/></label>{materials.length>1&&<button type="button" className="text-link" onClick={()=>changeDraft({materials:materials.filter(x=>x.id!==m.id)})}>移除这份材料</button>}</fieldset>)}{materials.length<8&&<Button type="button" variant="outline" disabled={busy} onClick={()=>changeDraft({materials:[...materials,material()]})}>添加另一份材料</Button>}
        <fieldset disabled={busy}>
          <fieldset><legend>接收者</legend>{eligible.map(p=><label className="material-recipient check-label" key={p.participationId}><input type="checkbox" checked={selected.includes(p.participationId)} onChange={event=>changeDraft({selected:event.target.checked?[...selected,p.participationId]:selected.filter(id=>id!==p.participationId)})}/><MemberAvatar subjectId={p.subjectId}/><span><strong>{name(p.subjectId)}</strong><small>{roleName(p.role)} · {p.agreedScope}</small></span></label>)}</fieldset>
          <p className="record-meta">所选的人分别收到同一组材料，各自确认接收。</p>
          <label>可阅读多久<select value={['60','1440','10080'].includes(minutes)?minutes:'custom'} onChange={event=>changeDraft({minutes:event.target.value==='custom'?'120':event.target.value})}><option value="60">1 小时</option><option value="1440">1 天</option><option value="10080">7 天</option><option value="custom">自定时间</option></select></label>
          {!['60','1440','10080'].includes(minutes)&&<label htmlFor={minutesId}>分钟数<Input id={minutesId} type="number" required min={5} max={43200} value={minutes} onChange={event=>changeDraft({minutes:event.target.value})}/></label>}
          <p className="record-meta">到期或参与范围改变后，这里的正文停止读取；对方已另行保存的副本不在此删除。</p>
        </fieldset>
        <div className="button-row"><Button type="button" variant="ghost" disabled={busy||activePending.length>0||!draftReady} onClick={()=>void run(valid=>prepare(valid,()=>Date.now()))}>预览</Button><Button type="submit" disabled={busy||activePending.length>0||!draftReady}>发送给所选参与者</Button></div>
      </form>
    </section>}
    {waiting.length>0&&<section className="operation-status" aria-label="材料发送状态">{waiting.map(op=><article key={op.operationId}>
      <p>{op.state==='stopped-local'?'这次发送已在本机停止。':operationErrors[op.operationId]??'上次材料操作已保留，可以继续核对。'}</p>
      {op.state!=='stopped-local'&&<Button variant="outline" disabled={busy} onClick={()=>run(valid=>reviewOperation(op,valid))}>继续这次材料操作</Button>}
      <ReadingDetails><ReadingSummary>查看本次发送记录</ReadingSummary><p>操作 {op.operationId} · 接收者 {name(op.recipientId)}</p><button className="text-link" disabled={busy} onClick={()=>run(async valid=>{await client.reconcile(op.operationId);if(valid())await load();})}>核对结果</button>{op.state!=='stopped-local'&&<><p>停止本机发送不会撤回可能已经送达的材料。</p><button className="text-link" disabled={busy} onClick={()=>run(async valid=>{await client.abandon(op.operationId,{confirmed:true});if(valid())await load();})}>停止本机发送</button></>}</ReadingDetails>
    </article>)}</section>}
    <dialog ref={confirmation} className="workspace-dialog material-dialog" onCancel={event=>{if(busy)event.preventDefault();else{setPreview(null);setRenewal(null);}}}>
      {(preview||renewal)&&<><header className="dialog-heading"><span>{renewal?'重新确认材料范围':preview?.kind==='grants'?'预览资料交接':preview?.kind==='accept'?'接收这份材料':preview?.kind==='decline'?'婉拒这份材料':'撤回这份材料'}</span><button className="icon-button" disabled={busy} aria-label="关闭材料预览" onClick={()=>{setPreview(null);setRenewal(null);}}>×</button></header>
        {renewal?<><h3>{{grant:'发送原材料',accept:'接收原材料',decline:'婉拒原材料',revoke:'撤回原材料'}[('kind' in renewal.payload?renewal.payload.kind:'grant')]}</h3><p>本次操作的另一方：{name(renewal.recipientId)}</p><p>{'materials' in renewal.payload?'原材料可阅读至':'本次操作授权至'} {readableTime(renewal.expiresAt)}。</p>{('materials' in renewal.payload?renewal.payload.materials:[]).map(m=><article key={m.id}><h3>{m.label}</h3><p className="reading-prose">{m.content}</p></article>)}<ReadingDetails className="technical-details"><ReadingSummary>原操作的准确引用</ReadingSummary><p>操作 {renewal.operationId} · 材料 {renewal.grantId} · 参与范围第 {renewal.payload.scopeVersion} 版</p><p>摘要 {renewal.payloadHash}</p></ReadingDetails></>:preview?.drafts.map((draft,index)=><article key={index}>
          {draft.payload?<><h3>给 {name(draft.payload.participantId)}</h3><p className="record-meta">{draft.recipient.agreedScope} · 可阅读至 {readableTime(draft.payload.expiresAt)}</p>{draft.payload.materials.map(m=><section key={m.id}><h4>{m.label}</h4><p className="reading-prose">{m.content}</p></section>)}</>:<><p>提供者：{name(draft.metadata.ownerId)} · 接收者：{name(draft.metadata.participantId)}</p><p>可阅读至 {readableTime(draft.metadata.expiresAt)}</p><ul>{(draft.materials??[]).map(m=><li key={m.id}>{m.label}</li>)}</ul></>}
        </article>)}
        <p className="permission-line">{preview?.kind==='revoke'?'撤回后，这份材料不再通过本次授权读取。':preview?.kind==='decline'?'婉拒只影响这次材料接收。':'仅提供者与所选接收者可见，接收者确认后才能打开正文。'}</p>
        {error&&<p className="message error" role="alert">{error}</p>}
        <div className="button-row"><Button disabled={busy} onClick={()=>run(async valid=>{if(renewal){await client.reauthorize(renewal.operationId,renewal,{confirmed:true});if(valid()){setRenewal(null);await load();}}else await commit(valid);})}>{renewal?'确认继续':preview?.kind==='grants'?'发送资料':preview?.kind==='accept'?'确认接收':preview?.kind==='decline'?'确认婉拒':'确认撤回'}</Button><Button variant="outline" disabled={busy} onClick={()=>{setPreview(null);setRenewal(null);}}>返回</Button></div>
      </>}
    </dialog>
    <dialog ref={reader} className="workspace-dialog material-dialog" onCancel={closeReader}>{openedId&&<>
      <header className="dialog-heading"><span>工作材料</span><button className="icon-button" aria-label="关闭工作材料" onClick={closeReader}>×</button></header>
      {opened?<><p className="record-meta">{statusNames[opened.state]??'当前不可用'}</p>{opened.contextAccessGranted?(opened.materials??[]).map(m=><article key={m.id}><h3>{m.label}</h3><p className="reading-prose">{m.content}</p></article>):<p>当前没有读取正文的授权。</p>}</>:<p>{navigator.onLine?'正在核对当前材料与可读范围…':'当前离线，连接恢复后会重新读取获准材料。'}</p>}
      {error&&<p className="message error" role="alert">{error}</p>}
    </>}</dialog>
  </section>;
}
