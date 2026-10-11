import React,{useEffect,useEffectEvent,useMemo,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,BookOpen,Globe2,Share2} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {getContributionClient} from './contribution-client.mjs';
import {HistoryWorkspace} from './history-workspace';
import {recordErrorField} from './record-workspace-types';
import type {ContributionClient,ContributionCursor,ContributionLocal,ContributionPrevious,ContributionPreview,ContributionPreviewData,ContributionProjection,ContributionPurpose,ContributionReceipt,ContributionSelectedRef,ContributionSelection,ContributionSourceItem,ContributionSourcesPage,ContributionStatus,ContributionWork,ContributionWorksPage,ContributionWorkView,RecordRuntime,RequesterPage,RequesterRecord} from './record-workspace-types';
import './profile-settings.css';
type Props={runtime:RecordRuntime|null;connected:boolean;subjectId?:string;navigate:(path:string)=>void};
const labels:Record<string,string>={'case-created':'记录一项工作',intervention:'参与工作','result-recorded':'记录结果','task-created':'发起求助','participation-proposed':'提出参与范围',confirm:'开始参与',deliver:'提供成果',accept:'接收成果','requester-feedback':'对本次参与的反馈',diagnosis:'诊断',verification:'验证',advice:'建议',patch:'修复',review:'复核','context-addition':'补充背景','tool-introduction':'引入工具',takeover:'接续工作',partial:'部分完成',failed:'未成功',succeeded:'报告成功',inconclusive:'尚无定论',clear:'清楚','partly-clear':'部分清楚',unclear:'不够清楚',published:'正在公开',revoked:'已停止公开',expired:'已到期','source-unavailable':'来源暂不可用','authorization-unavailable':'许可暂不可用',absent:'尚未读到公开记录'};
const name=(value:string|null|undefined)=>labels[value??'']??(value??'');
const workKey=(value:ContributionWork|null)=>value?.taskId?'task:'+value.taskId:value?.caseId?'case:'+value.caseId:'';
const fieldNames={role:'参与角色',interventionTypes:'实际做的事',reportedOutcome:'记录的结果',feedback:'我的反馈',scope:'工作范围',summary:'说明',title:'标题',time:'时间'};
type DisplayField=keyof typeof fieldNames;
const displayFields=Object.keys(fieldNames) as DisplayField[];
const purposeChoices:readonly [ContributionPurpose,string][]=[['honor','展示相关贡献认可'],['requester-history','展示我发起工作的过程']];
const readable=(error:unknown)=>({connection_required:'请使用自己的身份继续。',contribution_source_unavailable:'这份资料已变化或暂时不可用，请重新选择。',contribution_source_author_required:'只能选择本人提供的记录。',consent_reauthorization_required:'上次的公开操作需要重新确认。',honor_sources_changed_retry:'资料已更新，请重试。'} as Record<string,string>)[recordErrorField(error,'code')||recordErrorField(error,'message')]??'这部分资料暂时不可读取，请稍后重试。';
function projectedText(value:ContributionProjection,key:DisplayField){
 const field=value[key];
 if(key==='feedback')return value.feedback?name(value.feedback.descriptionClarity)+'；'+(value.feedback.scopeMatched?'工作范围相符':'工作范围有差异')+'（本人反馈）':'';
 if(key==='time')return typeof field==='string'?new Date(field).toLocaleString():'';
 if(Array.isArray(field))return field.map(name).join('、');
 if(typeof field==='object'&&field!==null)return recordErrorField(field,'summary')||recordErrorField(field,'description')||'见完整工作记录';
 return name(field);
}
function FactSnippet({value}:{value:ContributionProjection}){return <div className="contribution-snippet">{value.title&&<h3>{value.title}</h3>}{value.summary&&<p>{value.summary}</p>}<dl>{displayFields.filter(key=>!['title','summary'].includes(key)&&value[key]!=null).map(key=><div key={key}><dt>{fieldNames[key]}</dt><dd>{projectedText(value,key)}</dd></div>)}</dl></div>;}
function RequesterRecords({runtime,connected,subjectId,viewerId}:{runtime:RecordRuntime;connected:boolean;subjectId:string;viewerId?:string}){
 const [page,setPage]=useState<RequesterPage|null>(null),[selected,setSelected]=useState<RequesterRecord|null>(null),[detail,setDetail]=useState<RequesterRecord|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState('');
 const lifecycle=useRef({token:0,active:true});
 async function call(path:string,input:object){const current=runtime.api.snapshot(),lease=connected?runtime.receiptStatus.captureLease():null;lease?.assertCurrent();const value=await runtime.api.call(path,input,{authenticated:connected});lease?.assertCurrent();if((await runtime.status()).identity?.subjectId!==viewerId||current?.generation!==runtime.api.snapshot()?.generation)throw Error('identity_changed');return value;}
 function readPage(after?:string|null){const control=lifecycle.current,attempt=++control.token;return call('/v2/requester-history/query',{subjectId,limit:8,...(after?{after}:{})}).then((value:RequesterPage)=>{if(control.active&&attempt===control.token)setPage(old=>after&&old?{...value,items:[...old.items,...value.items]}:value);},error=>{if(control.active&&attempt===control.token){setPage(null);setDetail(null);setError(readable(error));}}).finally(()=>{if(control.active&&attempt===control.token)setBusy(false);});}
 function read(after?:string|null){setBusy(true);setError('');return readPage(after);}
 const initialRead=useEffectEvent(()=>readPage());
 useEffect(()=>{const control=lifecycle.current;control.active=true;void initialRead();return()=>{control.active=false;control.token++;};},[runtime,connected,subjectId,viewerId]);
 async function open(item:RequesterRecord,after?:string|null){const control=lifecycle.current,attempt=++control.token;setBusy(true);setError('');if(!after){setSelected(item);setDetail(null);}try{const value:RequesterRecord=await call('/v2/requester-history/facts',{rootEventId:item.source.id,limit:20,...(after?{after}:{})});if(control.active&&attempt===control.token)setDetail(old=>after&&old?{...value,facts:[...old.facts,...value.facts]}:value);}catch(error){if(control.active&&attempt===control.token){setDetail(null);setError(readable(error));}}finally{if(control.active&&attempt===control.token)setBusy(false);}}
 return <section aria-busy={busy}><header className="history-heading"><div><h2>发起的工作</h2><p>了解发起过的事情和参与者得到的回应。</p></div></header>{error&&<p role="alert">{error}<Button variant="ghost" onClick={()=>read()}>重试</Button></p>}{busy&&!page&&<p><output>正在读取…</output></p>}
  {selected?<><button type="button" className="history-back" onClick={()=>{lifecycle.current.token++;setBusy(false);setSelected(null);setDetail(null);}}><ArrowLeft size={16}/>返回工作记录</button><FactSnippet value={selected.projection}/>{detail?.facts.map(item=><article className="history-fact-item" key={item.source.id}><FactSnippet value={item.projection}/>{item.feedbackState&&<p className="fact-note">{item.feedbackState==='current'?'当事人当前反馈':'此前反馈，已有更正'}</p>}</article>)}{detail?.nextAfter&&<Button disabled={busy} variant="outline" onClick={()=>open(selected,detail.nextAfter)}>查看更多过程</Button>}</>:<>{page&&!page.items.length&&<div className="history-empty"><BookOpen size={32}/><h3>暂时没有可查看的记录</h3></div>}<ol className="history-list">{page?.items.map(item=><li key={item.id}><button type="button" className="history-open" onClick={()=>open(item)}><BookOpen size={19}/><div><h3>{item.projection.title??'发起的工作'}</h3>{item.projection.summary&&<p>{item.projection.summary}</p>}<div className="history-meta">{item.counts?.acceptances>0&&<span>接收过 {item.counts.acceptances} 项交付</span>}{item.counts?.currentFeedback>0&&<span>{item.counts.currentFeedback} 条反馈</span>}</div></div><ArrowRight size={17}/></button></li>)}</ol>{page?.nextAfter&&<Button disabled={busy} variant="outline" onClick={()=>read(page.nextAfter)}>查看更多工作</Button>}</>}
 </section>;
}
export function ContributionWorkspace({runtime,connected,subjectId,navigate}:Props){
 const params=new URLSearchParams(window.location.search),target=params.get('subjectId')??params.get('subject')??subjectId,view=params.get('view')??'history';
 const own=!!subjectId&&target===subjectId,context=runtime?.api.snapshot?.();
 const [,observeConnection]=useState('');useEffect(()=>{const read=()=>observeConnection(JSON.stringify(runtime?.api?.snapshot?.()??{})),timer=window.setInterval(read,1000);document.addEventListener('visibilitychange',read);return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',read);};},[runtime]);
 const key=`${runtime?.api.endpoint}:${subjectId}:${context?.bindingId}:${context?.generation}:${connected}`;
 const url=(next:string)=>'/app/history'+(next==='history'?'': '?view='+next)+(target&&target!==subjectId?(next==='history'?'?':'&')+'subjectId='+encodeURIComponent(target):'');
 return <section className="contribution-page"><header className="profile-heading"><h1 className="small">经历与贡献</h1>{own&&view!=='sharing'&&<Button variant="outline" onClick={()=>navigate(url('sharing'))}><Share2 size={16}/>公开设置</Button>}</header>
  {view==='sharing'&&own?<ContributionSharing key={key} runtime={runtime} connected={connected} subjectId={subjectId} navigate={navigate}/>:<><nav className="work-filter-links" aria-label="经历内容">{[['history','工作经历'],['requests','发起的工作']].map(([value,text])=><a key={value} href={url(value)} aria-current={view===value?'page':undefined} onClick={event=>{event.preventDefault();navigate(url(value));}}>{text}</a>)}</nav>{view==='requests'&&runtime&&target?<RequesterRecords key={key+target} runtime={runtime} connected={connected} viewerId={subjectId} subjectId={target}/>:<HistoryWorkspace key={key+target} runtime={runtime} connected={connected} subjectId={subjectId} targetSubjectId={target} navigate={navigate}/>}</>}
 </section>;
}
function ContributionSharing({runtime,connected,subjectId,navigate}:Props){
 const client=useMemo<ContributionClient|null>(()=>runtime&&subjectId?getContributionClient(runtime,subjectId):null,[runtime,subjectId]);
 const [tasks,setTasks]=useState<ContributionWork[]>([]),[taskMore,setTaskMore]=useState<Partial<Record<ContributionWorkView,string|null>>>({}),[task,setTask]=useState<ContributionWork|null>(null),[sources,setSources]=useState<ContributionSourceItem[]>([]),[sourceMore,setSourceMore]=useState<ContributionCursor[]>([]);
 const [chosen,setChosen]=useState<Record<string,ContributionSelectedRef['fields']>>({}),[purposes,setPurposes]=useState<ContributionPurpose[]>(['honor']),[days,setDays]=useState('7'),[preview,setPreview]=useState<ContributionPreview|null>(null);
 const [publications,setPublications]=useState<ContributionStatus[]>([]),[local,setLocal]=useState<ContributionLocal>({pending:null}),[selectedPublication,setSelectedPublication]=useState<ContributionStatus|null>(null),[publicationPreview,setPublicationPreview]=useState<ContributionPreviewData|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loaded,setLoaded]=useState(false),[recoveryId,setRecoveryId]=useState(''),[previous,setPrevious]=useState<ContributionPrevious[]|null>(null);
 const lifecycle=useRef({epoch:0,working:false}),selectedPublicationRef=useRef<ContributionStatus|null>(null),publicationRead=useRef(0),updateRead=useRef(0),writable=!!(client&&connected);
 async function call(path:string,input:object){if(!runtime)throw Error('connection_required');const token=lifecycle.current.epoch,lease=runtime.receiptStatus.captureLease();lease.assertCurrent();const value=await runtime.api.call(path,input);lease.assertCurrent();if(token!==lifecycle.current.epoch)throw Error('identity_changed');return value;}
 async function refreshSelectedPublication(){
  const selected=selectedPublicationRef.current;if(!selected)return;
  const token=lifecycle.current.epoch,read=++publicationRead.current;
  const current=()=>token===lifecycle.current.epoch&&read===publicationRead.current&&selectedPublicationRef.current?.publicationId===selected.publicationId;
  try{
   const status:ContributionStatus=await call('/v2/contributions/status',{publicationId:selected.publicationId});if(!current())return;
   const latest={...selected,...status};selectedPublicationRef.current=latest;setSelectedPublication(latest);
   if(!['published','revoked','expired'].includes(status.state)||!latest.sourceRefs?.length){setPublicationPreview(null);return;}
   const value:ContributionPreviewData=await call('/v2/contributions/preview',{sourceRefs:latest.sourceRefs,purposes:latest.purposes?.length?latest.purposes:['honor']});if(current())setPublicationPreview(value);
  }catch(error){if(current())setPublicationPreview(null);throw error;}
 }
 async function update(){if(!client)return;const token=lifecycle.current.epoch,read=++updateRead.current;const results=await Promise.allSettled([client.local(),client.refresh(),refreshSelectedPublication()]);if(token!==lifecycle.current.epoch||read!==updateRead.current)return;
  if(results[0].status==='fulfilled')setLocal(results[0].value);
  if(results[1].status==='fulfilled'){const shared=results[1].value;setPublications(old=>[...shared,...old.filter(item=>!shared.some(current=>current.publicationId===item.publicationId))]);}
  const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
 }
 async function run(action:()=>Promise<void>){if(lifecycle.current.working)return;const token=lifecycle.current.epoch;lifecycle.current.working=true;setBusy(true);setError('');setNotice('');try{await action();}catch(error){if(token===lifecycle.current.epoch){setError(readable(error));setPreview(null);setPublicationPreview(null);}}finally{if(token===lifecycle.current.epoch){try{await update();}catch{}lifecycle.current.working=false;setBusy(false);}}}
 const initialRead=useEffectEvent((token:number)=>{if(!writable||!client)return;void run(async()=>{await client.resumePending();const [requested,participating,history]:ContributionWorksPage[]=await Promise.all([call('/v2/tasks/query',{view:'requested',limit:20}),call('/v2/tasks/query',{view:'participating',limit:20}),call('/v2/history/query',{subjectId,limit:20})]);if(token!==lifecycle.current.epoch)return;const cases=history.items.filter(item=>item.kind==='case-history');setTasks([...new Map([...requested.items,...participating.items,...cases].map(item=>[workKey(item),item])).values()]);setTaskMore({requested:requested.nextAfter,participating:participating.nextAfter,history:history.nextAfter});setLoaded(true);});});
 const restorePending=useEffectEvent(()=>{if(document.hidden||lifecycle.current.working||!writable||!client)return;const token=lifecycle.current.epoch;void (async()=>{try{await client.resumePending();}finally{await update();}})().catch(error=>{if(token===lifecycle.current.epoch)setError(readable(error));});});
 useEffect(()=>{const control=lifecycle.current,token=++control.epoch;control.working=false;initialRead(token);const restore=()=>restorePending(),timer=window.setInterval(restore,20000);document.addEventListener('visibilitychange',restore);return()=>{control.epoch++;control.working=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',restore);};},[client,connected]);
 async function moreTasks(view:ContributionWorkView){const value:ContributionWorksPage=await call(view==='history'?'/v2/history/query':'/v2/tasks/query',{...(view==='history'?{subjectId}:{view}),after:taskMore[view],limit:20});const items=view==='history'?value.items.filter(item=>item.kind==='case-history'):value.items;setTasks(old=>[...new Map([...old,...items].map(item=>[workKey(item),item])).values()]);setTaskMore(old=>({...old,[view]:value.nextAfter}));}
 async function readSources(selected:ContributionWork|null,cursor?:ContributionCursor){if(!selected)return;if(!cursor){setTask(selected);setSources([]);setChosen({});setPreview(null);setSourceMore([]);}
  const queries:ContributionCursor[]=cursor?[cursor]:[...(selected.taskId?[{kind:'task-event' as const,parentId:selected.taskId}]:[]),...(selected.caseId?[{kind:'case-event' as const,parentId:selected.caseId}]:[])];
  const pages=await Promise.all(queries.map(async query=>{const page:ContributionSourcesPage=await call('/v2/contributions/sources',{...query,limit:30});return page;})),items=pages.flatMap(page=>page.items);
  const projection:ContributionPreviewData=items.length?await call('/v2/contributions/preview',{sourceRefs:items.map(item=>({...item.source,fields:item.availableFields})),purposes:['honor','requester-history']}):{items:[]};
  const values=items.map(item=>({...item,projection:projection.items.find(value=>value.ref.id===item.source.id)?.projection}));
  setSources(old=>cursor?[...old,...values]:values);setSourceMore(old=>[...(cursor?old.filter(item=>item.kind!==cursor.kind):[]),...pages.flatMap((page,i)=>page.nextAfter?[{...queries[i],after:page.nextAfter}]:[])]);
 }
 const invalidate=()=>setPreview(null);
 async function prepare(){const sourceRefs=sources.filter(item=>chosen[item.source.id]).map(item=>({...item.source,fields:chosen[item.source.id]}));if(!sourceRefs.length||!purposes.length)return;
  const payload:ContributionSelection={kind:'publish',sourceRefs,purposes,purpose:'public-contribution-projections-only',expiresAt:new Date(Date.now()+Number(days)*86400000).toISOString(),redactionConfirmed:true,publicationScope:'selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged'};
  const data:ContributionPreviewData=await call('/v2/contributions/preview',{sourceRefs,purposes});setPreview({payload,data});
 }

 async function previewOriginal(){
  if(!runtime||!client)return;const token=lifecycle.current.epoch,lease=runtime.receiptStatus.captureLease();lease.assertCurrent();
  await client.resumePending();const saved=await client.local();lease?.assertCurrent();if(token!==lifecycle.current.epoch)return;
  setLocal(saved);const original=saved.pending;
  if(!original){setNotice('上次操作已变化，请查看当前分享记录。');return;}
  if(original.canStartNewSelection||!['original-binding-changed','original-binding-unavailable'].includes(original.blockedReason??''))return;
  const payload=original.payload;
  let sourceRefs:ContributionSelectedRef[]=payload.kind==='publish'?payload.sourceRefs:[],selectedPurposes:ContributionPurpose[]=payload.kind==='publish'?payload.purposes:['honor'];
  if(payload.kind==='revoke'){
   const current:ContributionStatus=await call('/v2/contributions/status',{publicationId:payload.publicationId});
   sourceRefs=current.sourceRefs??publications.find(item=>item.publicationId===payload.publicationId)?.sourceRefs??[];
   selectedPurposes=current.purposes??['honor'];
  }
  const data:ContributionPreviewData=sourceRefs?.length?await call('/v2/contributions/preview',{sourceRefs,purposes:selectedPurposes}):{items:[]};
  lease?.assertCurrent();if(token!==lifecycle.current.epoch)return;
  setPreview({payload,data,original:{id:payload.id,payloadJson:original.payloadJson,payloadHash:original.payloadHash,deadline:original.authorizationExpiresAt,lease}});
 }
 async function submitPreview(){
  const selected=preview,token=lifecycle.current.epoch;if(!selected||!client)return;
  let receipt:ContributionReceipt;
  if(selected.original){
   selected.original.lease?.assertCurrent();const saved=await client.local(),original=saved.pending;
   selected.original.lease?.assertCurrent();if(token!==lifecycle.current.epoch)return;
   if(!original){
    const previous=await client.reconcilePrevious(selected.original.id);selected.original.lease?.assertCurrent();if(token!==lifecycle.current.epoch)return;
    setPreview(null);setNotice(previous.exactOperationConfirmed===true?(previous.state==='published'?'上次选择的经历已公开。':previous.state==='revoked'?'已停止这份分享。':previous.state==='expired'?'原分享期限已结束。':'原提交已收到，当前可见情况见分享记录。'):'上次操作已变化，请重新查看当前分享记录。');return;
   }
   if(original.payload.id!==selected.original.id||original.payloadJson!==selected.original.payloadJson||original.payloadHash!==selected.original.payloadHash||original.authorizationExpiresAt!==selected.original.deadline)throw Error('contribution_original_replaced');
   selected.original.lease?.assertCurrent();if(token!==lifecycle.current.epoch)return;
   receipt=await client.reconcile({retry:true,reauthorize:true,confirmed:true,expectedOperationId:selected.original.id,expectedPayloadHash:selected.original.payloadHash});
  }else receipt=await client.submit(selected.payload,{confirmed:true});
  if(token!==lifecycle.current.epoch)return;
  setPreview(null);setChosen({});setNotice(receipt?.state==='expired'?'原分享期限已结束。':receipt?.state==='revoked'||selected.payload.kind==='revoke'?'已停止这份分享。':receipt?.state==='published'?'选中的经历已公开。':'上次提交已收到，当前可见情况见分享记录。');
 }
 async function inspectPublication(item:ContributionStatus){selectedPublicationRef.current=item;setSelectedPublication(item);setPublicationPreview(null);await refreshSelectedPublication();}
 function closePublication(){publicationRead.current++;selectedPublicationRef.current=null;setSelectedPublication(null);setPublicationPreview(null);}
 async function stopPublication(item:ContributionStatus){if(!client)return;await client.submit({kind:'revoke',publicationId:item.publicationId,reason:'本人停止公开这份经历'},{confirmed:true});setNotice('已停止这份分享。');}
 const publicationRow=(item:ContributionStatus)=><article key={item.publicationId}><button type="button" className="sharing-publication" disabled={busy} onClick={()=>run(()=>inspectPublication(item))}><span><strong>{name(item.state)}</strong><small>{item.sourceRefs?.length??0} 个经历片段{item.expiresAt?' · 至 '+new Date(item.expiresAt).toLocaleDateString():''}</small></span><ArrowRight size={16}/></button></article>;
 return <div className="contribution-sharing" aria-busy={busy}><button type="button" className="history-back" onClick={()=>navigate('/app/history')}><ArrowLeft size={16}/>返回经历</button><header className="history-heading"><div><h2>选择公开的经历</h2><p>只公开你选中的本人记录，原工作中的其他资料保持原来的范围。</p></div></header>
  {error&&<p className="message error" role="alert">{error}<Button variant="ghost" disabled={busy} onClick={()=>run(update)}>重试</Button></p>}{notice&&<p><output>{notice}</output></p>}
  {!writable?<div className="personal-empty"><Share2 size={30}/><h3>由你选择分享什么</h3><p>使用自己的身份后，选择经历中可公开的内容。</p><Button onClick={()=>navigate('/app/settings/identity')}>继续使用</Button></div>:<>
  {local.pending&&<div className="message"><p>{local.pending.canStartNewSelection?'上次操作的记录仍保留，可以重新选择本次要公开的内容。':['original-binding-changed','original-binding-unavailable'].includes(local.pending.blockedReason??'')?'请用当前客户端确认上次选择的内容与范围。':'上次的公开设置还在处理中，系统会继续核对结果。'}</p>{!local.pending.canStartNewSelection&&['original-binding-changed','original-binding-unavailable'].includes(local.pending.blockedReason??'')&&<Button variant="outline" disabled={busy||!!preview?.original} onClick={()=>run(previewOriginal)}>查看上次选择</Button>}</div>}
  <section className="sharing-choose"><h3>从哪件事开始</h3><label>选择工作<select value={workKey(task)} disabled={busy} onChange={event=>{const value=tasks.find(item=>workKey(item)===event.target.value);if(value)void run(()=>readSources(value));}}><option value="">选择我的工作或经历</option>{tasks.map(item=><option key={workKey(item)} value={workKey(item)}>{item.request?.title??item.title??'工作记录'}</option>)}</select></label>{loaded&&!tasks.length&&<p className="muted">还没有可选工作。已有经历仍可在返回后的经历页查看。</p>}{(['requested','participating','history'] as const).filter(view=>taskMore[view]).map(view=><Button key={view} variant="ghost" disabled={busy} onClick={()=>run(()=>moreTasks(view))}>更多{view==='history'?'经历':view==='requested'?'我发起的工作':'我参与的工作'}</Button>)}
  {sources.map(item=><article className="sharing-source" key={item.source.id}><label className="sharing-source-choice"><input type="checkbox" checked={!!chosen[item.source.id]} disabled={busy} onChange={event=>{setChosen(old=>{const next={...old};if(event.target.checked)next[item.source.id]=['eventType','actorId',...displayFields.filter(key=>item.projection?.[key]!=null)];else delete next[item.source.id];return next;});invalidate();}}/><span>{name(item.eventType)}</span></label><FactSnippet value={item.projection??{}}/>{chosen[item.source.id]&&<fieldset className="sharing-fields"><legend>公开哪些内容</legend>{displayFields.filter(key=>item.projection?.[key]!=null).map(field=><label key={field}><input type="checkbox" checked={chosen[item.source.id].includes(field)} disabled={busy} onChange={event=>{setChosen(old=>({...old,[item.source.id]:event.target.checked?[...old[item.source.id],field]:old[item.source.id].filter(key=>key!==field)}));invalidate();}}/>{fieldNames[field]}</label>)}</fieldset>}</article>)}
  {task&&!busy&&!sources.length&&<p className="continuity-empty">这件事暂时没有可公开的本人片段。</p>}{sourceMore.map(cursor=><Button variant="ghost" disabled={busy} key={cursor.kind} onClick={()=>run(()=>readSources(task,cursor))}>查看更多{cursor.kind==='case-event'?'过程':'参与'}记录</Button>)}
  </section>
  {!!Object.keys(chosen).length&&<section className="sharing-options"><h3>公开后可用于</h3><fieldset>{purposeChoices.map(([value,title])=><label key={value}><input type="checkbox" checked={purposes.includes(value)} onChange={event=>{setPurposes(event.target.checked?[...purposes,value]:purposes.filter(item=>item!==value));invalidate();}}/>{title}</label>)}</fieldset><label>公开多久<select value={days} onChange={event=>{setDays(event.target.value);invalidate();}}><option value="1">1 天</option><option value="7">7 天</option><option value="29">29 天</option></select></label><Button disabled={busy||!purposes.length||!!local.pending&&!local.pending.canStartNewSelection} onClick={()=>run(prepare)}>预览公开内容</Button></section>}
  {preview&&<section className="sharing-preview"><h3><Globe2 size={20}/>{preview.payload.kind==='revoke'?'停止公开这些经历':'公众将看到这些内容'}</h3>{preview.data.items.map(item=><FactSnippet key={item.ref.id} value={item.projection}/>)}{preview.payload.kind==='revoke'?<p className="muted">此份分享将停止，原始工作记录仍然保留。</p>:<><p>用于{preview.payload.purposes.map(value=>value==='honor'?'展示相关贡献认可':'展示我发起工作的过程').join('、')}。</p><p className="muted">内容会署在你的银河身份下，公开至 {new Date(preview.payload.expiresAt).toLocaleString()}，到期不自动延长。</p></>}<div className="button-row"><Button disabled={busy||!preview.original&&!!local.pending&&!local.pending.canStartNewSelection} onClick={()=>run(submitPreview)}>{preview.payload.kind==='revoke'?'继续停止公开':'公开这些内容'}</Button><Button variant="ghost" disabled={busy} onClick={()=>setPreview(null)}>{preview.original?'暂不继续':'返回调整'}</Button></div></section>}
  <section className="sharing-current"><h3>正在分享的经历</h3>{!publications.some(item=>!['revoked','expired','absent'].includes(item.state))?<p className="muted">这里暂时没有正在公开的经历。</p>:publications.filter(item=>!['revoked','expired','absent'].includes(item.state)).map(publicationRow)}
  {selectedPublication&&<div className="sharing-preview"><h4>{name(selectedPublication.state)}</h4>{publicationPreview?.items.map(item=><FactSnippet key={item.ref.id} value={item.projection}/>)}{['published','source-unavailable','authorization-unavailable'].includes(selectedPublication.state)&&<Button variant="outline" disabled={busy||!!local.pending&&!local.pending.canStartNewSelection} onClick={()=>run(()=>stopPublication(selectedPublication))}>停止公开</Button>}<Button variant="ghost" onClick={closePublication}>收起</Button></div>}
  {publications.some(item=>['revoked','expired','absent'].includes(item.state))&&<details className="sharing-recover"><summary>此前的分享</summary>{publications.filter(item=>['revoked','expired','absent'].includes(item.state)).map(publicationRow)}</details>}
  <details className="sharing-recover" onToggle={event=>{if(event.currentTarget.open&&!previous)void run(async()=>{const token=lifecycle.current.epoch,rows=await client!.previousOperations();const values=await Promise.all(rows.map(async row=>{try{const current=await client!.reconcilePrevious(row.operationId);return {...row,receiptState:current.state,exactOperationConfirmed:current.exactOperationConfirmed};}catch{return row;}}));if(token===lifecycle.current.epoch)setPrevious(values);});}}><summary>过往公开操作</summary>{previous&&!previous.length&&<p>本机没有需要单独保留的旧操作。</p>}{previous?.map(item=><article key={item.operationId}><p>{item.kind==='revoke'?'停止公开':'公开经历'} · {item.exactOperationConfirmed?'当时的提交已收到':item.receiptState==='absent'?'未查到当时的提交':'尚未确认接收结果'}</p><small>原分享编号 {item.publicationId}</small></article>)}</details>
  <details className="sharing-recover"><summary>接回其他设备上的分享记录</summary><p>使用原分享记录中的编号查找。</p><form className="search-row" onSubmit={event=>{event.preventDefault();void run(async()=>{const value:ContributionStatus=await call('/v2/contributions/status',{publicationId:recoveryId.trim()});setPublications(old=>[value,...old.filter(item=>item.publicationId!==value.publicationId)]);await inspectPublication(value);});}}><Input aria-label="原分享记录编号" required value={recoveryId} onChange={event=>setRecoveryId(event.target.value)}/><Button disabled={busy} type="submit">接回记录</Button></form></details></section>
  </>}
 </div>;
}
