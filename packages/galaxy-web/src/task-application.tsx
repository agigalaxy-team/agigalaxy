import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/textarea';
import {QualificationPermissionCollector} from './qualification-permission-workspace';
import {BudgetFields,TaskTerms} from './task-budget-fields';
import {applicationFromDraft,budgetText,evidenceFromSelection,qualificationState,taskWriteError,qualificationEvaluationInput,qualificationEvaluationView} from './task-bounty-client.mjs';

const kinds:Record<string,string>={participation:'本人实际参与与被接受的交付','external-review':'外部工作／挑战的当前限定审核',calculation:'现存本任务私有计算许可','capsule-use':'本人真实 Capsule 应用',proof:'本人 CI 证明','legacy-assistance':'本人原版协助经历'};
const reasons:Record<string,string>={'insufficient-related-accepted-history':'缺少当前相关且已接受或经限定审核的实际经历','insufficient-current-reviewed-experience':'缺少当前有效的相关审核经历','insufficient-policy-matched-proof':'缺少符合本规则的 CI 证明','no-current-visible-accepted-delivery':'尚无当前可见的已接受交付','synthetic-excluded':'演示或合成资料不能授予实际资格','source-under-review':'这项来源处于待复核状态','qualification_source_unavailable':'原来源或授权当前不可用','source-unavailable':'原来源或授权当前不可用'};
export function QualificationSummary({value}:{value:any}){if(!value)return null;return <div className="message"><strong>{qualificationState(value)}</strong><p>这只是当前本任务的限定条件核对，选择和确认参与时会再次计算。</p>
 {(value.missing??value.reasons??[]).map((v:any,i:number)=><p key={i}>{v.condition==='relevant-reviewed-experience'?`相关且已接受或经限定审核的实际经历：当前可计入 ${v.available} 项，需要 ${v.required} 项。`:v.condition==='policy-matched-ci-observations'?`符合本规则的 CI 证明：当前 ${v.available} 项，需要 ${v.required} 项。`:reasons[typeof v==='string'?v:v.code]??'仍有一项条件缺少充分依据；请检查相关经历、许可和当前版本。'}</p>)}
 {value.calculation&&<p>依据本任务私有计算许可返回限定结论，未取得旧任务原文或第三方身份的阅读授权。</p>}
 {(value.sourceStatuses??[]).map((s:any,i:number)=><p key={i}>{reasons[s.reason]??'一项所选材料当前不足以计入，请检查其状态或授权。'}</p>)}
 {value.state!=='satisfied'&&<p>缺少资料不等于没有能力。可以继续开放协助，或提交经限定审核的外部工作／挑战资料。</p>}</div>;}
export function ApplicationTerms({application,request}:{application:any;request:any}){const e=application.qualificationEvidence??{},states:Record<string,string>={pending:'等待回应',selected:'已提出参与安排',withdrawn:'申请者已撤回'};return <div><p>申请状态：{states[application.state]??application.state??'待核对'}</p>
 {request.collaboration==='basic-bounty'&&<><p>申请报价：{application.quote?budgetText(application.quote):'未单独报价，需核对任务预算与申请范围'}。</p><p className="muted">这是此人的私有申请条件，仍需双方明确约定；接受参与或交付不会触发支付。</p></>}
 {request.qualification&&<p>所选依据：{(e.assistanceIds??[]).length} 项原版协助、{(e.participationIds??[]).length} 项实际参与、{(e.externalReviewRefs??[]).length} 项精确版本外部审核、{(e.proofIds??[]).length} 项 CI 证明；{e.calculationGrantId?'使用本任务限定计算许可。':'原文可见权限保留原状。'}</p>}</div>;}

export function TaskApplication({task,runtime,subjectId,connected,navigate,refresh,onNeedIdentity}:any){
 const blank=()=>({proposal:'',scope:'',quoteMode:'task',budgetMode:'fixed',amount:'',minimum:'',maximum:'',unit:task.request.budget?.unit??'CNY',selected:[]});
 const [draft,setDraft]=useState<any>(blank),[loaded,setLoaded]=useState(false),[kind,setKind]=useState('participation'),[items,setItems]=useState<any[]>([]),[next,setNext]=useState<string|null>(null),[searched,setSearched]=useState(false);
 const [preview,setPreview]=useState<any>(null),[evaluation,setEvaluation]=useState<any>(null),[pending,setPending]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const epoch=useRef(0),working=useRef(false),key=`task-application-draft:${task.taskId}`;
 useEffect(()=>{const token=++epoch.current;working.current=false;setBusy(false);setLoaded(false);setItems([]);setNext(null);setSearched(false);setPreview(null);setEvaluation(null);setPending(null);setError('');
  if(runtime)Promise.all([runtime.getLocal(key),runtime.getLocal(`task-event:${task.taskId}`)]).then(([d,p])=>{if(token===epoch.current){setDraft({...blank(),...d});setPending(p);setLoaded(true);}}).catch((e:any)=>{if(token===epoch.current)setError(taskWriteError(e));});return()=>{epoch.current++;};},[runtime,task.taskId,subjectId,connected]);
 useEffect(()=>{setPreview(null);setEvaluation(null);},[task.version]);
 useEffect(()=>{setKind(task.request.qualification?.profile==='facts-v2'?'participation':'legacy-assistance');setItems([]);setNext(null);setSearched(false);},[task.taskId,task.request.qualification?.profile]);
 useEffect(()=>runtime?.onTaskOperationStopped((event:any)=>{if(event.scopeTaskId===task.taskId)setPending(null);}),[runtime,task.taskId]);
 useEffect(()=>{
  if(!runtime)return;
  let active=true,reading=false;
  const reload=()=>{if(!active||reading||working.current||document.visibilityState!=='visible')return;reading=true;
   runtime.getLocal(`task-event:${task.taskId}`).then((value:any)=>{if(active&&!working.current)setPending(value);}).catch(()=>{}).finally(()=>{reading=false;});};
  const timer=window.setInterval(reload,20000);document.addEventListener('visibilitychange',reload);
  return()=>{active=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',reload);};
 },[runtime,task.taskId,subjectId,connected]);
 const writable=connected&&subjectId&&task.requesterId!==subjectId,open=task.enrollmentOpen??(task.state==='open'&&task.request.enrollmentExpiresAt>Date.now()/1000),paid=task.request.collaboration==='basic-bounty';
 const alreadyPending=task.contacts?.responses?.applications?.some((a:any)=>a.subjectId===subjectId&&a.state==='pending');
 async function run(fn:(valid:()=>boolean)=>Promise<void>){if(working.current)return;const token=epoch.current,valid=()=>token===epoch.current;working.current=true;setBusy(true);setError('');setNotice('');let committed=false;try{await fn(valid);committed=true;}catch(e){if(valid())setError(committed?'申请已收到服务回执，但页面状态暂未刷新；请查询原操作，不要重复提交。':taskWriteError(e));}finally{if(valid()){try{const p=await runtime.getLocal(`task-event:${task.taskId}`);if(valid())setPending(p);}catch{}if(valid()){working.current=false;setBusy(false);}}}}
 function change(field:string,value:any){const d={...draft,[field]:value};setDraft(d);setPreview(null);setEvaluation(null);const token=epoch.current;runtime.putLocal(key,d).catch((e:any)=>{if(token===epoch.current)setError(taskWriteError(e));});}
 async function candidates(valid:()=>boolean,after?:string){const r=await runtime.api.call('/v2/qualification/candidates',{taskId:task.taskId,kind,limit:12,...(after?{after}:{})},{authenticated:true});if(valid()){setItems(old=>after?[...old,...r.items]:r.items);setNext(r.nextAfter);setSearched(true);}}
 async function evaluate(valid:()=>boolean){const q=qualificationEvaluationInput(task,subjectId,draft.selected);const r=await runtime.api.call(q.path,q.input,{authenticated:true});if(valid())setEvaluation(qualificationEvaluationView(r));}
 if(task.schemaVersion!==2||task.requesterId===subjectId)return null;
 return <section className="task-body" aria-busy={busy}><h2>申请提供帮助</h2><TaskTerms request={task.request}/>
 {error&&<div className="message error" role="alert">{error}</div>}{notice&&<output className="message">{notice}</output>}
 {!connected&&<div className="message">连接身份后可提交私有申请，申请不等于正式承接。<Button type="button" onClick={()=>onNeedIdentity?onNeedIdentity():navigate('/app/settings/identity')}>连接身份</Button></div>}
 {!open&&<p className="message">征集已结束。已有参与可以继续，新的申请须等待请求者明确延长征集。</p>}
 {pending&&<p className="message">此任务有一项原操作结果待核对。下方草稿保留；请使用本页“查询原操作／重试原操作”恢复同一编号，不能用新草稿替换在途申请。</p>}
 {alreadyPending&&<p className="message">已经有一份待回应申请。可在协作进程中撤回后另行申请，原申请历史仍保留。</p>}
 {loaded&&<form className="workspace-form" onSubmit={e=>{e.preventDefault();run(async()=>setPreview(applicationFromDraft(draft,task)));}}><fieldset disabled={busy||!writable}><legend>我的帮助和约定范围</legend>
 <label>能提供的帮助<Textarea required maxLength={1500} value={draft.proposal} onChange={e=>change('proposal',e.target.value)}/></label><label>工作范围、交付时间与必要条件<Textarea required maxLength={1500} value={draft.scope} onChange={e=>change('scope',e.target.value)} placeholder="说明愿意承担的工作、边界与交付安排，避免把征集截止当作交付时间。"/></label>
 {paid&&<label>报价选择<select value={draft.quoteMode} onChange={e=>change('quoteMode',e.target.value)}><option value="task">不另报金额，按任务预算进一步约定</option><option value="own">提交我的固定／区间／待协商报价</option></select></label>}</fieldset>
 {paid&&draft.quoteMode==='own'&&<BudgetFields draft={draft} disabled={busy||!writable} onChange={change}/>}
 {task.request.qualification&&<fieldset disabled={busy||!writable}><legend>选择这一次申请的资格依据</legend><p>只提交明确选择的引用和报价。旧任务、配置、上下文或其他成员的原文不会自动向请求者开放。读取 Capsule 或自报成功不等于受认可的实际复用经历。</p>
 <label>材料来源<select value={kind} onChange={e=>{setKind(e.target.value);setItems([]);setNext(null);setSearched(false);}}>{Object.entries(kinds).filter(([value])=>task.request.qualification.profile==='facts-v2'?value!=='legacy-assistance':['legacy-assistance','proof'].includes(value)).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><Button type="button" variant="outline" onClick={()=>run(v=>candidates(v))}>读取我的当前材料</Button>
 {searched&&!items.length&&<p className="empty-state">这一类没有当前可供选择的材料，或来源授权已变化。没有历史的参与者仍可从开放协助开始。</p>}
 {items.map(item=><label className="task-card" key={`${item.kind}:${item.id}`}><input type="checkbox" checked={draft.selected.some((s:any)=>s.kind===item.kind&&s.id===item.id)} onChange={e=>change('selected',e.target.checked?[...draft.selected,item]:draft.selected.filter((s:any)=>s.kind!==item.kind||s.id!==item.id))}/>{item.label}{item.version?` · 版本 ${item.version}`:''}{item.synthetic?' · 合成资料，不计实际资格':''}<small>{reasons[item.sourceStatus]??'选定后仍由当前规则核对'}</small></label>)}
 {next&&<Button type="button" variant="ghost" onClick={()=>run(v=>candidates(v,next))}>下一页材料</Button>}
 {!!draft.selected.length&&<div className="message"><h3>本次已选材料</h3>{draft.selected.map((s:any)=><p key={`${s.kind}:${s.id}`}>{s.label}{s.version?` / 版本 ${s.version}`:''}<Button type="button" variant="ghost" onClick={()=>change('selected',draft.selected.filter((v:any)=>v.kind!==s.kind||v.id!==s.id))}>移除此项</Button></p>)}</div>}
 <Button type="button" variant="outline" onClick={()=>run(evaluate)}>核对本人所选材料</Button><QualificationSummary value={evaluation}/>
 <p className="muted">本人能读的材料，请求者未必能读。需要仅披露限定结论时，可使用下方的逐作者许可收集；原材料不会自动公开。</p></fieldset>}
 {task.request.qualification?.profile==='facts-v2'&&<QualificationPermissionCollector runtime={runtime} subjectId={subjectId} connected={connected} task={task} selected={draft.selected} navigate={navigate} onCompute={(item:any)=>change('selected',[item])}/>}
 {task.request.qualification&&task.request.qualification.profile!=='facts-v2'&&<p className="message">此任务使用原版资格规则。目录只列本人原版协助与 Proof，并按原规则核对；新版 Participation 不会被静默转换成旧履历。</p>}
 <Button type="submit" disabled={busy||!writable||!open||alreadyPending||!!pending}>预览我的私有申请</Button></form>}
 {preview&&<article className="message"><h3>确认申请内容</h3><p>{preview.proposal}</p><p>{preview.scope}</p><ApplicationTerms application={{...preview,state:'pending'}} request={task.request}/><p>仅向请求者 {task.requesterId} 提交本申请。资格材料不足仍可表达意愿，但在满足条件前不能确认赏金参与。邀请、选择和付款不会自动发生。</p>
 <div className="button-row"><Button type="button" disabled={busy||!writable||!open||!!pending||alreadyPending} onClick={()=>run(async valid=>{await runtime.taskEvent(task.taskId,preview,{viewers:[task.requesterId],confirmed:true});if(valid()){await runtime.putLocal(key,null);setDraft(blank());setPreview(null);setNotice('申请已送达；对方拟定范围后仍需你明确确认。');await refresh();}})}>确认提交这份申请</Button><Button type="button" variant="outline" onClick={()=>setPreview(null)}>继续修改</Button></div></article>}
 </section>;
}
