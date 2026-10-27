import {ReadingDetails,ReadingSummary} from "../../shared/reading/reading-details";
import React,{useCallback,useEffect,useEffectEvent,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {ciRequestV2Schema,ciProofV2Schema} from "../../../../galaxy-official/src/shared/ci-observation-v2-schema.mjs";
import {sha256Hex} from "../../../../galaxy-official/src/shared/web-primitives.mjs";
import {ciSourceFromEvidence,getCiClient} from './ci-client.mjs';
import {CiProofView,CiSourceView,ciConclusion,ciTime} from './ci-proof-view';
import {useGovernanceDraft} from "../governance/governance-presentation";
import {ciPreviewPayload,ciProofPreview,ciRequestPreview,ciReceiptDone,ciReason,currentCiView,readCiLocal,readCiOriginal,readCiReceipt,readCiView} from './ci-workspace-state';
import type {CiEvidence,CiInput,CiLocal,CiLocator,CiPreview,CiResult,CiView} from './ci-workspace-state';
import {errorField,operationSessionKey} from "../tasks/operations/task-operation-state";
import type {OperationRuntime} from "../tasks/operations/task-operation-state";
import "../../shared/styles/peering-ci.css";
import {nativeQueryScope} from '../../application/query-scope';
import {useServiceQuery} from '../../shared/runtime/use-service-query';
type Props={runtime:OperationRuntime;connected:boolean;subjectId?:string;caseId:string;results:CiResult[];evidence:CiEvidence[]};
const names:Record<string,string>={pending:'等待读取运行记录',observed:'已取得运行观察',unavailable:'运行来源暂不可用',revoked:'已停止',stale:'观察已到期','source-unavailable':'来源当前不可读','read-unavailable':'暂时无法读取','proof-expired':'证明已到期',active:'当前可读',recorded:'已保存'};
const initial:CiInput={selected:'',resultId:'',visibility:'Private'};
const recoveryText=(reason?:string)=>({
  'proof-preview-expired':'原证明预览已到期，不能再把它作为一份新证明提交。原操作仍保留，可继续核对是否已接收。',
  'authorization-expired':'原许可已到期，原内容和原操作仍保留；不会自动延长许可。',
  'authorization-review-required':'连接或授权已变化，请查看原内容和范围后继续。',
  'authorization-evidence-required':'原授权资料尚不完整，请查看原内容后继续。',
  'original-binding-changed':'连接已变化，请查看原内容和范围后继续。',
  'original-binding-unavailable':'原连接依据尚不完整，请查看原内容后继续。',
  'original-deadline-unavailable':'原许可期限暂时无法核对，请查看原内容后选择后续处理。',
} as Record<string,string>)[reason??'']??'这次操作的原内容已保留，页面正在核对接收结果。';
const ciError=(error:unknown)=>({
  ci_source_unavailable:'选定的来源或相关工作现在不可读，请核对当前记录。',
  ci_source_author_required:'只能为本人提供的来源和本人结果发起观察。',
  ci_profile_mismatch:'来源中的仓库、运行次数或提交版本不完整，请先更正来源记录。',
  ci_task_mismatch:'这份来源与结果不属于同一求助，请重新选择。',
  ci_participation_mismatch:'这份来源与结果不属于同一次参与，请重新选择。',
  ci_scope_mismatch:'这次参与范围已经变化，请重新核对来源和结果。',
  ci_observation_unavailable:'当前还没有可用的完整运行观察，页面会继续读取。',
  ci_proof_unavailable:'这份证明当前无法读取，可能已撤销、到期或来源已变化。',
  ci_proof_stale:'这份证明预览已经到期，请返回重新读取。',
  ci_proof_conflict:'这次证明的接收结果需要继续核对，原内容已保留。',
  consent_reauthorization_required:'原操作需要重新确认，请查看其原内容和范围后继续。',
  ci_proof_preview_expired:recoveryText('proof-preview-expired'),
} as Record<string,string>)[errorField(error,'code')||errorField(error,'message')]??(/[\u3400-\u9fff]/.test(errorField(error,'message'))?errorField(error,'message'):'暂时无法完成这次操作，已输入的内容仍保留。');

export function CiWorkspace(props:Props){
  const {runtime,subjectId,connected,caseId}=props;
  const connectionKey=useCallback(()=>operationSessionKey(runtime,subjectId,connected,caseId),[runtime,subjectId,connected,caseId]);
  const [,setObserved]=useState(connectionKey);
  useEffect(()=>{const read=()=>setObserved(connectionKey()),timer=window.setInterval(read,1000);document.addEventListener('visibilitychange',read);return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',read);};},[connectionKey]);
  if(!props.connected||!props.subjectId)return null;
  return <CiSession key={connectionKey()} {...props} subjectId={props.subjectId}/>;
}
function CiSession({runtime,connected,subjectId,caseId,results,evidence}:Props&{subjectId:string}){
  const eventRefresh=useRef<(reset:boolean)=>void>(()=>{});
  const reads=useServiceQuery(nativeQueryScope(runtime,subjectId),'ci',reset=>eventRefresh.current(reset));
  const lease=useMemo(()=>{const value=runtime.receiptStatus.captureLease();if(value.subjectId!==subjectId)throw Error('当前 CI 身份已变化。');return value;},[runtime,subjectId]),client=useMemo(()=>getCiClient(runtime,subjectId),[runtime,subjectId]);
  const draft=useGovernanceDraft<CiInput,CiLocator>(runtime,subjectId,connected,'ci-input:v1:'+JSON.stringify([runtime.api.endpoint,subjectId,caseId]),initial),input=draft.value;
  const [local,setLocal]=useState<CiLocal|null>(null),[views,setViews]=useState<Record<string,CiView>>({}),[preview,setPreview]=useState<CiPreview|null>(null),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[recovery,setRecovery]=useState<string|null>(null),[stoppedStatus,setStoppedStatus]=useState<Record<string,string>>({}),[now,setNow]=useState(()=>Date.now());
  const session=useRef({generation:0,readSerial:0,working:false,reading:false,refreshAgain:false,active:false}),dialog=useRef<HTMLDialogElement>(null);
  const check=()=>{lease.assertCurrent();if(!session.current.active)throw Error('页面身份或工作已变化，请重新打开。');};
  const choices=evidence.filter(item=>item.record?.reportedBy===subjectId&&item.record?.evidenceType==='ci-result'&&item.referenceStatus==='current');
  const ownResults=[...results.filter(item=>item.actorId===subjectId).reduce((map:Map<string,CiResult>,item)=>{const previous=map.get(item.id);if(!previous||item.version>previous.version)map.set(item.id,item);return map;},new Map<string,CiResult>()).values()];
  const sourceView=choices.find(item=>item.id+':'+item.version===input.selected),source=ciSourceFromEvidence(sourceView),result=ownResults.find(item=>item.id+':'+item.version===input.resultId);
  const requests=(local?.requests??[]).filter(item=>item.caseId===caseId),proofs=(local?.proofs??[]).filter(item=>requests.some(request=>request.id===item.requestId));
  async function call(path:string,payload:object):Promise<unknown>{const token=session.current.generation;check();const value:unknown=path.endsWith('/read')?await reads.read([caseId,path,payload],()=>runtime.api.call(path,payload)):await runtime.api.call(path,payload);check();if(token!==session.current.generation)throw Error('页面身份或工作已变化，请重新打开。');return value;}
  async function settleDraft(){if(!draft.ready)return;await draft.settle(async attempt=>{const value=readCiReceipt(await call('/v2/ci/receipts',{type:attempt.type,id:attempt.id}));if(value.state==='recorded'&&value.payloadHash!==attempt.payloadHash)throw Error('原操作的内容不匹配，请保留记录后核对。');return{state:value.state==='recorded'?'acknowledged':value.state};});}
  async function refresh(resume=false){
    if(session.current.reading){session.current.refreshAgain=true;return;}session.current.reading=true;const token=session.current.generation,serial=++session.current.readSerial;
    try{
      check();let state=readCiLocal(await client.local());check();if(token!==session.current.generation)return;
      if(resume&&state.pending){try{const resumed:unknown=await client.resumePending();check();if(token!==session.current.generation)return;setRecovery(ciReason(resumed));if(ciReceiptDone(resumed))setMessage('上次的 CI 内容已保存。');}catch(e){check();if(token!==session.current.generation)return;setRecovery(ciReason(e));}state=readCiLocal(await client.local());check();}
      const selectedRequests=state.requests.filter(item=>item.caseId===caseId),selectedProofs=state.proofs.filter(item=>selectedRequests.some(request=>request.id===item.requestId)),updated:Record<string,CiView>={};
      const targets=[...selectedRequests.map(item=>({id:item.id,type:'request'})),...selectedProofs.map(item=>({id:item.id,type:'proof'}))];
      for(let start=0;start<targets.length;start+=4){await Promise.all(targets.slice(start,start+4).map(async item=>{try{updated[item.id]=readCiView(await call(item.type==='request'?'/v2/ci/requests/read':'/v2/ci/proofs/read',{id:item.id}));}catch{check();updated[item.id]=item.type==='request'?{state:'read-unavailable'}:{status:'read-unavailable'};}}));if(token!==session.current.generation)return;}
      const stopped:Record<string,string>={};for(const item of state.stopped??[]){try{stopped[item.id]=readCiReceipt(await client.reconcileStopped({type:item.type,id:item.id,payloadHash:item.payloadHash})).state;}catch{check();stopped[item.id]='unknown';}}
      if(token===session.current.generation&&serial===session.current.readSerial){setLocal(state);setViews(updated);setStoppedStatus(stopped);setLoaded(true);if(!state.pending)setRecovery(null);}
      await settleDraft();
    }finally{session.current.reading=false;if(session.current.refreshAgain&&token===session.current.generation&&session.current.active){session.current.refreshAgain=false;void refresh().catch(()=>{});}}
  }
  const readCurrent=useEffectEvent(()=>refresh(true));
  eventRefresh.current=reset=>{if(reset)setViews({});if(!document.hidden&&!session.current.working)void refresh().catch(reason=>setError(ciError(reason)));};
  const settleCurrent=useEffectEvent(()=>settleDraft());
  useEffect(()=>{session.current.active=true;session.current.generation++;const token=session.current.generation;const read=()=>{if(document.hidden||session.current.working||session.current.reading)return;void readCurrent().catch(e=>{if(session.current.active&&token===session.current.generation)setError(ciError(e));});};read();const timer=window.setInterval(read,20000);document.addEventListener('visibilitychange',read);const state=session.current;return()=>{state.active=false;state.generation++;state.readSerial++;window.clearInterval(timer);document.removeEventListener('visibilitychange',read);};},[session,client,caseId]);
  useEffect(()=>{if(draft.ready&&draft.attempt)void settleCurrent().catch(()=>{});},[draft.ready,draft.attempt]);
  useEffect(()=>{if(preview)dialog.current?.showModal();else dialog.current?.close();},[preview]);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer);},[]);
  async function run(action:()=>Promise<void>){if(session.current.working)return;const token=session.current.generation;session.current.working=true;setBusy(true);setError('');setMessage('');try{check();await action();check();}
    catch(e){if(session.current.active&&token===session.current.generation){setError(ciError(e));try{const state=readCiLocal(await client.local());check();if(token===session.current.generation&&state.pending){setLocal(state);setPreview(old=>(old?.kind==='request'||old?.kind==='proof')&&old.payload.id===state.pending?.payload.id?null:old);}}catch{}}}finally{if(session.current.active&&token===session.current.generation){try{await refresh();}catch{}setBusy(false);}session.current.working=false;}}
  function change(patch:Partial<CiInput>){setError('');setMessage('');draft.change(patch);}
  async function prepareRequest(){await run(async()=>{if(!source||!sourceView||!result)throw Error('请先选择当前的本人来源和结果。');const saved=await draft.snapshot(),payload=ciRequestV2Schema.parse({id:crypto.randomUUID(),schemaVersion:2,kind:'observe',purpose:'observe-selected-ci-source-and-prepare-bounded-proof',caseId,evidenceRef:{id:sourceView.id,version:sourceView.version},resultRef:{id:result.id,version:result.version},source});setPreview({kind:'request',payload,revision:saved.revision,sourceSummary:sourceView.record?.summary??'选定的 CI 来源',resultSummary:result.summary});});}
  async function prepareProof(request:{id:string}){await run(async()=>{const value=await call('/v2/ci/proofs/preview',{id:crypto.randomUUID(),requestId:request.id});if(typeof value!=='object'||value===null||!('payloadJson' in value)||typeof value.payloadJson!=='string')throw Error('这份证明预览暂时无法读取。');const payload=ciProofV2Schema.parse(JSON.parse(value.payloadJson));setPreview({kind:'proof',payload,requestId:request.id});});}
  async function reviewOriginal(){await run(async()=>{const value:unknown=await client.reviewPending();check();if(ciReceiptDone(value)){await settleDraft();setMessage('上次的内容已保存。');return;}if(typeof value!=='object'||value===null||!('payload' in value)){setMessage('当前没有可继续的原操作。');return;}const authorization:unknown=await client.reviewAuthorization();check();if(ciReceiptDone(authorization)){await settleDraft();setMessage('上次的内容已保存。');return;}const review=readCiOriginal(typeof authorization==='object'&&authorization!==null&&'payload' in authorization?authorization:value);setPreview({kind:'recovery',review,continuation:review.state==='reauthorization-required'?'reauthorize':'reuse'});});}
  async function confirmPreview(){await run(async()=>{
    const chosen=preview;if(!chosen)return;if(chosen.kind==='revoke-request'||chosen.kind==='revoke-proof'){await call(chosen.kind==='revoke-request'?'/v2/ci/requests/revoke':'/v2/ci/proofs/revoke',{id:chosen.id});setPreview(null);setMessage(chosen.kind==='revoke-request'?'这次观察已停止，相关证明也不再有效。':'这份证明已撤销。');return;}
    if(chosen.kind==='stop-local'){const stopped:unknown=await client.stopPending({id:chosen.review.id??chosen.review.payload.id,payloadHash:chosen.review.payloadHash},{confirmed:true});if(ciReceiptDone(stopped)){await settleDraft();setMessage('原操作已被服务接收。');}else setMessage('已停止本机发送，仍会只读核对原操作是否到达。');setPreview(null);return;}
    if(chosen.kind==='recovery'){const resumed:unknown=chosen.continuation==='reauthorize'?await client.reauthorize(chosen.review,{confirmed:true}):await client.reconcile({retry:true,confirmed:true});await settleDraft();setPreview(null);setRecovery(ciReason(resumed));setMessage(ciReceiptDone(resumed)?'原来的 CI 内容已保存。':recoveryText(ciReason(resumed)??undefined));return;}
    if(chosen.kind!=='request'&&chosen.kind!=='proof')return;const type=chosen.kind,payload=chosen.kind==='proof'?chosen.payload:ciRequestV2Schema.parse(chosen.payload);
    if(type==='proof'){const proof=ciProofV2Schema.parse(chosen.payload);if(proof.preparedAt+300<=Date.now()/1000||proof.expiresAt<=Date.now()/1000)throw Error('这份证明预览已经到期，请返回重新读取。');}
    const snapshot=type==='request'?{revision:chosen.revision}:await draft.snapshot(),payloadHash=await sha256Hex(JSON.stringify(payload));
    if(snapshot.revision)await draft.attach({type,id:payload.id,payloadHash},snapshot.revision);
    await client.submit(type,payload,{confirmed:true,visibility:type==='proof'?input.visibility:'Private'});check();await settleDraft();setPreview(null);setMessage(type==='proof'?'这份证明已保存。':'已排队读取这次 CI 运行，页面会自动显示进展。');
  });}
  const recoveryExpired=preview?.kind==='recovery'&&preview.continuation!=='reauthorize'&&['proof-preview-expired','authorization-expired'].includes(preview.review.reason??'');
  const proofExpired=preview?.kind==='proof'&&(preview.payload.preparedAt+300<=now/1000||preview.payload.expiresAt<=now/1000);
  const requestInfo=(request:CiLocal['requests'][number])=>{const selectedEvidence=evidence.find(item=>item.id===request.evidenceRef.id&&item.version===request.evidenceRef.version),selectedResult=results.find(item=>item.id===request.resultRef.id&&item.version===request.resultRef.version);return{evidence:selectedEvidence,result:selectedResult,source:ciSourceFromEvidence(selectedEvidence)};};
  const requestPreview=ciRequestPreview(preview),proofPreview=ciProofPreview(preview),previewPayload=ciPreviewPayload(preview);
  return <section className="fact-panel ci-workspace">
    <header className="ci-heading"><div><h3>CI 运行观察</h3><p>为本人记录的 GitHub Actions 来源读取实际运行结果，再决定是否分享这份观察证明。</p></div></header>
    {error&&<p role="alert">{error}</p>}{message&&<p><output>{message}</output></p>}
    {local?.pending&&<section className="ci-recovery"><p>{recoveryText(recovery??local.pending.reason??undefined)}</p><Button variant="outline" disabled={busy} onClick={reviewOriginal}>查看原内容并继续</Button></section>}
    {!draft.ready?<p><output>{draft.status||'正在读取你的选择…'}</output></p>:<form className="workspace-form" onSubmit={event=>{event.preventDefault();void prepareRequest();}}>
      <label>已记录的 CI 来源<select value={input.selected} onChange={event=>change({selected:event.target.value})}><option value="">选择来源</option>{choices.map(item=><option key={item.id+':'+item.version} value={item.id+':'+item.version}>{item.record?.summary} · 第 {item.version} 版</option>)}{input.selected&&!sourceView&&<option value={input.selected}>此前选择的来源，当前无法读取</option>}</select></label>
      <label>对应的本人结果<select value={input.resultId} onChange={event=>change({resultId:event.target.value})}><option value="">选择结果</option>{ownResults.map(item=><option key={item.id+':'+item.version} value={item.id+':'+item.version}>{item.summary} · 第 {item.version} 版</option>)}{input.resultId&&!result&&<option value={input.resultId}>此前选择的结果，当前版本已变化</option>}</select></label>
      {!choices.length&&<p className="empty-state">先在这项工作的来源区记录本人的 CI 来源，再选择对应结果。</p>}{choices.length>0&&!ownResults.length&&<p className="empty-state">这项工作还没有本人记录的结果。</p>}{sourceView&&!source&&<p role="alert">这份来源尚未包含完整的 GitHub 仓库、运行次数和提交版本，请先更正来源记录。</p>}{source&&<CiSourceView source={source}/>}
      {draft.status&&<p className="ci-draft-note"><output>{draft.status}</output></p>}<Button type="submit" disabled={busy||!!local?.pending||!source||!result}>预览这次观察</Button>
    </form>}
    <section className="peering-section"><h4>观察进展</h4>{!loaded&&<p><output>正在读取已有记录…</output></p>}{loaded&&!requests.length&&<p className="empty-state">尚未为这项工作发起 CI 观察。</p>}
      <div className="ci-record-list">{requests.map(request=>{const value=currentCiView(views[request.id],now),info=requestInfo(request),observation=value?.observation;
        return <article className="ci-record" key={request.id}><h4>{info.evidence?.record?.summary??'此前选择的 CI 来源'}</h4>{info.result?.summary&&<p>对应结果：{info.result.summary}</p>}<p><strong>{names[value?.state??'']??'正在读取状态'}</strong>{value?.state==='pending'?'，完成后会自动更新。':''}</p>{observation&&<p>{ciConclusion[observation.conclusion??'']??(observation.completed?'这次外部运行已结束':'这次外部运行尚未结束')} · 采集于 {ciTime(observation.collectedAt)}</p>}
          {info.source&&<ReadingDetails><ReadingSummary>查看这次运行范围</ReadingSummary><CiSourceView source={info.source}/><p>结果第 {request.resultRef.version} 版 · 来源第 {request.evidenceRef.version} 版</p></ReadingDetails>}{value?.synthetic&&<p className="browse-note">这是合成演示资料。</p>}
          <div className="button-row"><Button disabled={busy||!!local?.pending||value?.state!=='observed'||!observation?.completed} onClick={()=>prepareProof(request)}>查看可分享的证明</Button>{value?.state!=='revoked'&&<Button variant="ghost" disabled={busy} onClick={()=>setPreview({kind:'revoke-request',id:request.id,source:info.source,title:info.evidence?.record?.summary})}>停止这次观察</Button>}</div>
        </article>;})}</div>
    </section>
    {!!proofs.length&&<section className="peering-section"><h4>已保存的证明</h4>{proofs.map(proof=>{const value=currentCiView(views[proof.id],now);return <article className="ci-record" key={proof.id}><p><strong>{proof.visibility==='Public'?'公开证明':'仅自己可见的证明'}</strong> · {names[value?.status??'']??'正在核对'}</p>{value?.data&&<CiProofView value={value}/>}<Button variant="outline" disabled={busy||value?.status==='revoked'} onClick={()=>setPreview({kind:'revoke-proof',id:proof.id,proof:value?.data,visibility:proof.visibility})}>撤销这份证明</Button></article>;})}</section>}
    {!!local?.stopped?.length&&<ReadingDetails className="technical-details"><ReadingSummary>已停止本机发送的 CI 记录</ReadingSummary>{local.stopped.map(item=><article key={item.type+item.id}><p>{item.type==='request'?'观察请求':'证明'} · {stoppedStatus[item.id]==='recorded'?'服务已接收原操作':stoppedStatus[item.id]==='absent'?'本次查询尚未找到接收记录':'接收结果仍待核对'}</p><p className="record-meta">{item.id}</p></article>)}<p>页面只查询这些原操作的接收结果，不会再次发送。</p></ReadingDetails>}
    <dialog ref={dialog} className="ci-dialog" aria-labelledby="ci-preview-title" onCancel={event=>{event.preventDefault();if(!busy)setPreview(null);}}>{preview&&<>
      <p className="eyebrow">{preview.kind==='recovery'?'继续原来的内容':'确认本次选择'}</p><h2 id="ci-preview-title">{preview.kind==='request'?'读取这次 CI 运行':preview.kind==='proof'?'保存这份运行证明':preview.kind==='recovery'?'核对原 CI 操作':preview.kind==='stop-local'?'停止本机发送':preview.kind==='revoke-request'?'停止这次观察':'撤销这份证明'}</h2>
      {requestPreview&&<><h3>{preview.kind==='request'?preview.sourceSummary:'原来选定的 CI 来源'}</h3><CiSourceView source={requestPreview.source}/>{preview.kind==='request'&&preview.resultSummary&&<p>对应结果：{preview.resultSummary}</p>}<p>来源第 {requestPreview.evidenceRef.version} 版，结果第 {requestPreview.resultRef.version} 版。服务将读取公共 GitHub 上这一次运行的实际记录。</p><p className="permission-line">观察请求仅本人可见。观察完成后，再分别选择是否公开证明。</p></>}
      {proofPreview&&<><CiProofView value={proofPreview}/><p>证明中包含仓库、运行和提交版本；原工作、求助和证据正文不在这份证明中。</p>{preview.kind==='proof'?<label>这份证明给谁看<select value={input.visibility} onChange={event=>change({visibility:event.target.value==='Public'?'Public':'Private'})}><option value="Private">仅自己</option><option value="Public">公开</option></select></label>:(preview.kind==='recovery'||preview.kind==='stop-local')&&<p>原可见范围：{preview.review.visibility==='Public'?'公开':'仅自己'}。</p>}</>}
      {preview.kind==='recovery'&&<>{preview.continuation==='reauthorize'?<>{preview.review.originalExpiresAt?<p>原许可截止时间：{ciTime(preview.review.originalExpiresAt)}。</p>:<p>原许可期限当前无法核对。</p>}<p>本次重新确认后，同一内容的许可截止时间为 {ciTime(preview.review.expiresAt)}。</p></>:preview.review.expiresAt&&<p>原许可至 {ciTime(preview.review.expiresAt)}。</p>}<p>{recoveryText(preview.review.reason??undefined)}</p></>}
      {preview.kind==='stop-local'&&<p>确认后停止在本机继续发送这份内容，仍保留原操作定位并查询接收结果。已经到达服务的请求或证明不会被这一步撤销。</p>}
      {preview.kind==='revoke-request'&&<>{preview.title&&<h3>{preview.title}</h3>}<CiSourceView source={preview.source}/><p>确认后停止这次观察，由它生成的证明也会失效。</p></>}
      {preview.kind==='revoke-proof'&&<>{preview.proof&&<CiProofView value={preview.proof} technical={false}/>}<p>确认后撤销这份{preview.visibility==='Public'?'公开':'私有'}证明。原 CI 来源和其他单独保存的证明不随这次操作删除。</p></>}
      {proofExpired&&<p role="alert">这份预览已到期，请返回并重新读取证明。</p>}{error&&<p role="alert">{error}</p>}
      <ReadingDetails className="technical-details"><ReadingSummary>精确记录</ReadingSummary><pre>{JSON.stringify(previewPayload??((preview.kind==='revoke-request'||preview.kind==='revoke-proof')?{id:preview.id}:null),null,2)}</pre></ReadingDetails>
      <div className="button-row"><Button disabled={busy||proofExpired||recoveryExpired} onClick={confirmPreview}>{busy?'正在处理…':preview.kind==='request'?'确认读取运行记录':preview.kind==='proof'?'确认并保存证明':preview.kind==='recovery'?(preview.continuation==='reauthorize'?'确认重新授权并继续':'确认并继续'):preview.kind==='stop-local'?'确认停止本机发送':preview.kind==='revoke-request'?'确认停止观察':'确认撤销证明'}</Button>{preview.kind==='recovery'&&<Button variant="ghost" disabled={busy} onClick={()=>setPreview({...preview,kind:'stop-local'})}>停止本机发送</Button>}<Button variant="outline" disabled={busy} onClick={()=>setPreview(null)}>返回</Button></div>
    </>}</dialog>
  </section>;
}
