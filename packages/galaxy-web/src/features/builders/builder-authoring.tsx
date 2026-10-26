import {ReadingDetails,ReadingSummary} from "../../shared/reading/reading-details";
import React,{useCallback,useEffect,useEffectEvent,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {useGovernanceDraft} from "../governance/governance-presentation";
import {MemberAvatar,memberName,useMemberNames} from "../../shared/people/conversation-ui";
import {BuilderDeclarationView,BuilderSupportView,WorkerPackView,BuilderEventPreview,builderActionName} from './builder-details';
import {builderFormNames,BuilderDeclarationFields,BuilderSupportFields,BuilderPackFields,BuilderReportFields,BuilderMaintenanceFields} from './builder-form-fields';
import {builderField,builderInputSchema,builderLocatorSchema,builderContactsSchema,isBuilderFormKind,initialBuilderInput,builderBaseChanged,builderContentPatch,builderCurrentSourcePatch,builderContentFromImport,prepareBuilderPreview} from './builder-authoring-state';
import type {BuilderRuntime,BuilderClient,BuilderRead,BuilderEntry,BuilderPreview,BuilderReceipt,BuilderInput,BuilderLocator} from './builder-authoring-state';
import './builder-authoring.css';

type Props={runtime:BuilderRuntime;client:BuilderClient;subjectId:string;selected:BuilderRead|null;management:BuilderEntry|null;kind:string;pending:unknown;onKind:(kind:string)=>void;onClose:()=>void;onSaved:(builderId:string)=>Promise<void>;onPending:()=>Promise<void>};
export function builderAuthoringKey(endpoint:string,builderId?:string){return `${endpoint}:builder-authoring-input:${builderId??'new'}`;}
export function builderFormError(error:unknown){
  const known:Record<string,string>={builder_business_rejected:'服务未接受这次资料，已停止自动发送。输入仍保留。',builder_authorization_review_required:'连接或许可已变化，请核对原资料后继续。',builder_pending_operation:'上次资料仍在确认，输入已保留。',builder_revision_conflict:'登记已有变化，输入仍保留。请回到资料查看当前版本后继续。'};
  const message=builderField(error,'message'),code=builderField(error,'code')??message;if(typeof code==='string'&&known[code])return known[code];
  const issues=builderField(error,'issues');if(Array.isArray(issues)&&issues.length){const issuePath=builderField(issues[0],'path'),path=Array.isArray(issuePath)?issuePath.join('.'):'';
    if(path.includes('objectActions'))return'请至少选择一项实际支持的操作。';
    if(path.includes('proofIds'))return'已有证明记录需使用准确的记录编号；没有可留空。';
    if(/Hash|sha256|sourceCommit/.test(path))return'请核对文件哈希与源码 Commit，使用实际文件对应的完整值。';
    if(/policy|contact|artifact|source|endpoint|cardUrl|charter|url|licenseSource/.test(path))return'请核对资料链接，使用不含凭据、查询参数或片段的 HTTPS 地址。';
    if(/checks/.test(path))return'请为当前支持范围填写实际检查结果和观察依据。';
    return'部分资料尚未填完整或超出范围，请核对当前表单。';
  }
  return typeof message==='string'&&/[\u3400-\u9fff]/.test(message)?message:'暂时未能完成，输入仍保留。';
}
export function BuilderAuthoring({runtime,client,subjectId,selected,management,kind:requestedKind,pending,onKind,onClose,onSaved,onPending}:Props){
  const entry=selected?.entry??management,extensions=selected?.extensions,builderId=entry?.builderId;
  const [initial]=useState(()=>initialBuilderInput(selected,management,subjectId,requestedKind));
  const draft=useGovernanceDraft<BuilderInput,BuilderLocator>(runtime,subjectId,true,builderAuthoringKey(runtime.api.endpoint,builderId),initial);
  const [preview,setPreview]=useState<BuilderPreview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [updatedSource,setUpdatedSource]=useState<BuilderRead|null>(null);
  const [contacts,setContacts]=useState<string[]>([]),[contactAfter,setContactAfter]=useState<string|null>(null),[contactError,setContactError]=useState(''),[manualPerson,setManualPerson]=useState('');
  const active=useRef(true),working=useRef(false),previewStart=useRef<HTMLElement>(null),lease=useMemo(()=>{const current=runtime.receiptStatus.captureLease();if(current.subjectId!==subjectId||current.endpoint!==runtime.api.endpoint)throw Error('身份或连接已变化，请重新打开原资料。');return current;},[runtime,subjectId]);
  const decoded=builderInputSchema.safeParse(draft.value),value=decoded.success?decoded.data:initial,kind=value.kind,content=isBuilderFormKind(kind)?value.forms[kind]:undefined,names=useMemberNames(runtime,subjectId,true,[...contacts,...(value.viewers??[])]);
  const readingSource=updatedSource??selected,readingEntry=readingSource?.entry??entry,readingExtensions=readingSource?.extensions??extensions;
  const sourceChanged=draft.ready&&builderBaseChanged(value,readingSource,entry);
  const check=useCallback(()=>{lease.assertCurrent();if(!active.current)throw Error('页面已切换。');},[lease]);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  useEffect(()=>{if(preview){previewStart.current?.scrollIntoView({block:'start'});previewStart.current?.focus({preventScroll:true});}},[preview]);
  useEffect(()=>{if(draft.ready)onKind(kind);},[draft.ready,kind,onKind]);
  const loadContacts=useCallback((after?:string)=>{
    const read=async()=>{check();const page=builderContactsSchema.parse(await runtime.api.call('/v2/contacts/query',{direction:'both',limit:50,...(after?{after}:{})}));check();return page;};
    return read().then(page=>{const ids=page.items.map(item=>item.initiatorId===subjectId?item.recipientId:item.initiatorId);setContactError('');setContacts(old=>[...new Set(after?[...old,...ids]:ids)]);setContactAfter(page.nextAfter??null);}).catch(()=>{if(active.current)setContactError('联系人暂时无法读取，已有选择仍保留。');});
  },[check,runtime,subjectId]);
  useEffect(()=>{void loadContacts();},[loadContacts]);
  const settleDraft=useEffectEvent(async()=>{
    const receipt:{current:BuilderReceipt|null}={current:null};
    const removed=await draft.settle(async(locator:unknown)=>{check();receipt.current=await client.receiptFor(builderLocatorSchema.parse(locator));check();return receipt.current;});check();
    if(removed&&receipt.current?.state==='acknowledged')await onSaved(receipt.current.builderId);
  });
  useEffect(()=>{if(!draft.ready)return;let reading=false;
    const settle=async()=>{if(!active.current||working.current||reading||document.hidden)return;reading=true;try{await settleDraft();}catch{}finally{reading=false;}};
    void settle();const timer=window.setInterval(settle,12000);document.addEventListener('visibilitychange',settle);return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',settle);};
  },[draft.ready,lease]);
  function changeContent(next:unknown){setError('');setMessage('');draft.change(builderContentPatch(value,next));}
  const changeKind=(next:string)=>{setPreview(null);setError('');setMessage('');draft.change({kind:next});};
  async function perform(fn:()=>Promise<void>){if(working.current)return;working.current=true;setBusy(true);setError('');try{check();await fn();}catch(e){if(active.current)setError(builderFormError(e));}finally{working.current=false;if(active.current)setBusy(false);}}
  async function prepare(){await perform(async()=>{
    const snapshot=await draft.snapshot();check();const input=builderInputSchema.parse(snapshot.value);let currentEntry=entry,currentExtensions=extensions;
    if(builderId){
      if(selected){const current=await client.read(builderId,true);check();currentEntry=current.entry;currentExtensions=current.extensions;
        if(builderBaseChanged(input,current,entry)){setUpdatedSource(current);throw Error('项目资料已有更新。原输入仍保留，请阅读当前内容后选择如何继续。');}
      }else{currentEntry=await client.manage(builderId);check();}
    }
    setPreview(prepareBuilderPreview(input,snapshot.revision,currentEntry,currentExtensions,builderId));setMessage('');
  });}
  async function submit(){await perform(async()=>{const reviewed=preview;if(!reviewed)return;try{
    const receipt=await client.submit(reviewed.event,{visibility:reviewed.visibility,viewers:reviewed.viewers,confirmed:true,onJournal:async(locator)=>{check();await draft.attach(locator,reviewed.draftRevision);check();}});check();
    await draft.settle((locator:unknown)=>client.receiptFor(builderLocatorSchema.parse(locator)));check();setPreview(null);await onSaved(receipt.builderId??reviewed.event.builderId);
  }finally{if(active.current)await onPending();}});}
  const own=!!management||!builderId,canReport=!!extensions?.canSubmitReport&&!!extensions?.support?.record;
  const options=Object.keys(builderFormNames).filter(k=>k==='scope-report'?canReport:own&&(k==='declare'||(k==='maintenance'?!!entry:!!selected))&&(k!=='pack-manifest'||entry?.type==='worker'));
  if(!draft.ready)return <output>正在恢复本机输入… {draft.status}</output>;
  if(!decoded.success)return <section className="builder-authoring"><p className="message">本机原输入的格式暂时无法读取，原记录仍保留。请回到资料后核对。</p><Button variant="outline" onClick={onClose}>回到资料</Button></section>;
  if(!content||!options.includes(kind))return <section className="builder-authoring"><p className="message">{content?'当前身份或资料状态不再支持这项操作。原输入仍保存在本机。':'本机输入尚未准备好。'}</p><Button variant="outline" onClick={onClose}>回到资料</Button>{options.length>0&&<Button onClick={()=>changeKind(options[0])}>编写当前可用的资料</Button>}</section>;
  return <section className="builder-authoring">
    <button className="back-link" disabled={busy} onClick={onClose}> {selected?'回到项目资料':'回到目录'} · 保留输入</button>
    {error&&<p className="message error" role="alert">{error}</p>}{message&&<output className="message">{message}</output>}
    {sourceChanged&&<section className="builder-source-change"><h2>项目资料已有更新</h2><p>你之前的输入仍在下面。先阅读当前内容，再决定如何继续。</p><ReadingDetails mode="inline" open><ReadingSummary>当前项目资料 · {readingEntry?.declaration?.release?.version??'当前版本'}</ReadingSummary>{kind==='support-profile'||kind==='scope-report'?<BuilderSupportView value={readingExtensions?.support?.record}/>:kind==='pack-manifest'?<WorkerPackView value={readingExtensions?.pack?.record}/>:<BuilderDeclarationView value={readingEntry?.declaration}/>}</ReadingDetails><Button type="button" disabled={busy} variant="outline" onClick={()=>{
      if(!readingEntry)return;
      const patch=builderCurrentSourcePatch(value,readingEntry,readingExtensions);
      draft.change(patch);setError('');setMessage('已关联当前版本。原输入仍保留，请继续编辑并预览。');
    }}>{kind==='scope-report'?'使用当前范围，保留相同项目的检查':'基于当前版本继续这份输入'}</Button></section>}
    {preview?<section ref={previewStart} tabIndex={-1} className="builder-review-start" aria-label="资料预览">
      <p className="eyebrow">阅读后保存</p><BuilderEventPreview value={preview} names={names} subjectId={subjectId}/>
      {preview.event.kind==='declare'&&<p className="permission-line">保存即确认这份资料可按所选范围分享，已移除凭据与不应包含的私密内容。</p>}
      <div className="button-row"><Button disabled={busy||!!pending} onClick={submit}>{busy?'正在保存…':preview.visibility==='Public'?'保存并公开这份资料':'保存这份资料'}</Button><Button variant="outline" disabled={busy} onClick={()=>setPreview(null)}>继续修改</Button></div>
      <ReadingDetails className="technical-details"><ReadingSummary>精确版本与发送内容</ReadingSummary><pre>{JSON.stringify({event:preview.event,visibility:preview.visibility,viewers:preview.viewers},null,2)}</pre></ReadingDetails>
    </section>:<form onSubmit={e=>{e.preventDefault();void prepare();}}>
      <fieldset disabled={busy} className="builder-form-body">
        <div className="builder-editor-intro"><label className="builder-field"><span>这次要做什么</span><select value={kind} onChange={e=>changeKind(e.target.value)}>{options.map(k=><option key={k} value={k}>{builderFormNames[k]}</option>)}</select></label><p>填写自己的资料，再阅读完整预览。{builderId?'准确版本和原登记由系统关联。':'项目编号由系统生成。'}</p></div>
        {kind==='declare'&&value.forms.declare&&<BuilderDeclarationFields value={value.forms.declare} onChange={changeContent} typeLocked={!!builderId}/>}
        {kind==='support-profile'&&value.forms['support-profile']&&<BuilderSupportFields value={value.forms['support-profile']} onChange={changeContent}/>}
        {kind==='pack-manifest'&&value.forms['pack-manifest']&&<BuilderPackFields value={value.forms['pack-manifest']} onChange={changeContent}/>}
        {kind==='scope-report'&&value.forms['scope-report']&&<><BuilderReportFields value={value.forms['scope-report']} onChange={changeContent} support={readingExtensions?.support.record}/>{value.unmatchedChecks?.length>0&&<ReadingDetails className="builder-optional"><ReadingSummary>原支持范围中保留的检查说明</ReadingSummary><p>这些项目不属于当前支持范围，保留在本机供你查看，不随新报告发送。</p>{value.unmatchedChecks.map((c,i)=><article key={i}><h4>{builderActionName(c.action)}</h4><p>{c.detail}</p></article>)}</ReadingDetails>}</>}
        {kind==='maintenance'&&value.forms.maintenance&&<BuilderMaintenanceFields value={value.forms.maintenance} onChange={changeContent} allowedActions={management?.allowedActions}/>}
        {kind==='declare'?<section className="builder-form-section"><h3>谁可以阅读这份资料</h3><label className="builder-field"><span>可见范围</span><select value={value.visibility} onChange={e=>draft.change({visibility:e.target.value==='Public'?'Public':'Private'})}><option value="Private">本人及选择的人</option><option value="Public">公开</option></select></label>{value.visibility==='Private'&&<><p>未选择其他人时，仅本人可见；最多可选择 16 人。</p><div className="builder-people">{[...new Set<string>([...contacts,...value.viewers])].filter(id=>id!==subjectId).map(id=><label key={id}><input type="checkbox" checked={value.viewers.includes(id)} disabled={!value.viewers.includes(id)&&value.viewers.length>=16} onChange={e=>draft.change({viewers:e.target.checked?[...value.viewers,id]:value.viewers.filter((v:string)=>v!==id)})}/><MemberAvatar subjectId={id}/><span>{memberName(id,subjectId,names[id]??undefined)}</span></label>)}</div>{contactError&&<p>{contactError}<button type="button" className="text-link" onClick={()=>loadContacts()}>重新读取联系人</button></p>}{contactAfter&&<Button type="button" variant="ghost" onClick={()=>loadContacts(contactAfter)}>更多联系人</Button>}<ReadingDetails mode="inline" className="builder-optional"><ReadingSummary>通过准确身份添加其他人</ReadingSummary><label className="builder-field"><span>对方的银河身份</span><input value={manualPerson} maxLength={32} onChange={e=>setManualPerson(e.target.value)}/></label><Button type="button" variant="outline" onClick={()=>{const id=manualPerson.trim();if(!/^GUID[0-9A-Z]{28}$/.test(id)||id===subjectId){setError('请填写对方准确的银河身份。');return;}if(!value.viewers.includes(id)&&value.viewers.length>=16){setError('最多可指定 16 位查看者，请先调整选择。');return;}draft.change({viewers:[...new Set([...value.viewers,id])]});setManualPerson('');setError('');}}>加入可见范围</Button></ReadingDetails></>}</section>:<p className="permission-line">本次资料沿用当前声明的可见范围，预览中会显示具体接收人。</p>}
        <ReadingDetails mode="inline" className="builder-optional"><ReadingSummary>从已有资料文件导入</ReadingSummary><p>可以导入开发工具准备的 JSON 文件，随后在上方表单阅读和修改。系统仍会关联当前项目与版本。</p><input type="file" accept="application/json,.json" aria-label="导入资料 JSON 文件" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;void perform(async()=>{if(file.size>28000)throw Error('资料文件应小于 28 KB。');const parsed=JSON.parse(await file.text());check();changeContent(builderContentFromImport(kind,parsed,readingEntry,readingExtensions));setMessage('文件内容已载入表单，请阅读后预览。');});}}/></ReadingDetails>
      </fieldset>
      <div className="builder-save-bar"><output>{draft.status||'输入会保存在本机。'}{!!pending&&' 上次资料仍在确认，暂时保留当前输入。'}</output><Button type="submit" disabled={busy||!!pending||sourceChanged}>{busy?'正在准备…':'预览这份资料'}</Button></div>
    </form>}
  </section>;
}
