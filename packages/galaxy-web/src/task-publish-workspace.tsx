import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {TaskOperationRecovery} from './task-operation-recovery';
import {BudgetFields,TaskTerms} from './task-budget-fields';
import {taskDraft,publicationFromDraft,policyKey,taskWriteError} from './task-bounty-client.mjs';

type Props={runtime:any;subjectId?:string;connected:boolean;navigate:(path:string)=>void;onNeedIdentity?:()=>void};
export function TaskPublishWorkspace({runtime,subjectId,connected,navigate,onNeedIdentity}:Props){
 const [draft,setDraft]=useState<any>(()=>taskDraft()),[loaded,setLoaded]=useState(false),[policies,setPolicies]=useState<any[]>([]),[catalogLoaded,setCatalogLoaded]=useState(false);
 const [preview,setPreview]=useState<any>(null),[pending,setPending]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const epoch=useRef(0),working=useRef(false);
 useEffect(()=>{const token=++epoch.current;working.current=false;setBusy(false);setLoaded(false);setPreview(null);setPending(null);setPolicies([]);setCatalogLoaded(false);setError('');
  if(runtime)Promise.all([runtime.getLocal('task-draft'),runtime.getLocal('task-publication')]).then(([d,p])=>{if(token===epoch.current){setDraft(taskDraft(d??{}));setPending(p);setLoaded(true);}}).catch((e:any)=>{if(token===epoch.current)setError(taskWriteError(e));});
  const reload=()=>{if(document.visibilityState!=='visible'||working.current||!runtime)return;runtime.getLocal('task-publication').then((p:any)=>{if(token===epoch.current)setPending(p);}).catch((e:any)=>{if(token===epoch.current)setError(taskWriteError(e));});};
  const timer=window.setInterval(reload,15000);const onVisible=()=>reload();document.addEventListener('visibilitychange',onVisible);
  return()=>{epoch.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',onVisible);};},[runtime,subjectId,connected]);
 async function run(fn:(valid:()=>boolean)=>Promise<void>){if(working.current)return;const token=epoch.current,valid=()=>token===epoch.current;working.current=true;setBusy(true);setError('');setNotice('');try{await fn(valid);}catch(e){if(valid())setError(taskWriteError(e));}finally{if(valid()){try{const p=await runtime.getLocal('task-publication');if(valid())setPending(p);}catch{}if(valid()){working.current=false;setBusy(false);}}}}
 function change(field:string,value:string){const next={...draft,[field]:value};setDraft(next);setPreview(null);const token=epoch.current;runtime.putLocal('task-draft',next).catch((e:any)=>{if(token===epoch.current)setError(taskWriteError(e));});}
 async function catalog(valid:()=>boolean){const result=await runtime.api.call('/v1/qualification/policies',{}, {authenticated:true});if(valid()){setPolicies(result.policies);setCatalogLoaded(true);setPreview(null);}}
 async function finish(receipt:any){const id=receipt.taskId??receipt.result?.taskId;if(id){setPreview(null);navigate(`/app/tasks/${id}`);}}
 async function submit(valid:()=>boolean){const receipt=await runtime.publishTask(preview,{confirmed:true});if(valid()){await runtime.putLocal('task-draft',null);await finish(receipt);}}
 const paid=draft.collaboration==='basic-bounty',policy=policies.find(p=>policyKey(p)===draft.policyKey);
 return <section aria-busy={busy}><div className="eyebrow">明确需要的帮助，由参与者分别确认</div><h1 className="small">发布任务</h1><p className="lead">可以是新的目标、诊断、评审或遇到的困难，无需先失败或建立案例。普通聊天也可以单独开始。</p>
 {error&&<div className="message error" role="alert">{error}</div>}{notice&&<output className="message">{notice}</output>}
 {pending&&<div className="message"><h2>原发布结果待核对</h2><p>继续提交会保留原任务编号、原金额和原征集截止，不使用下方正在编辑的草稿。</p><p>{pending.payload?.title}</p>{pending.payload&&<TaskTerms request={pending.payload}/>}
 <div className="button-row"><Button type="button" disabled={busy||!connected} onClick={()=>run(async valid=>{const result=await runtime.reconcilePublication();if(valid()){if(result.state==='acknowledged')await finish(result);else setNotice('尚未确认原发布结果，可重试同一项操作。');}})}>查询原发布</Button><Button type="button" disabled={busy||!connected} onClick={()=>run(async valid=>{const result=await runtime.reconcilePublication({retry:true});if(valid())await finish(result);})}>重试原发布</Button></div>
 </div>}
 <TaskOperationRecovery runtime={runtime} connected={connected} onComplete={finish} onStopped={()=>{setPending(null);setPreview(null);setNotice("已停止本机重试，原服务端结果仍可查询；下方草稿保留。");}}/>
 {!connected&&<div className="message">内容先留在此浏览器。连接身份后核对内容再发布；匿名草稿在身份页面按明确选择采用。<Button type="button" onClick={()=>onNeedIdentity?onNeedIdentity():navigate('/app/settings/identity')}>连接身份</Button></div>}
 {loaded&&<form className="workspace-form" onSubmit={e=>{e.preventDefault();run(async()=>{setPreview(publicationFromDraft(draft,policies));setNotice('请核对下方范围和条件。此预览尚未发布。');});}}><fieldset disabled={busy}><legend>任务内容</legend>
 <label>标题<Input required maxLength={120} value={draft.title} onChange={e=>change('title',e.target.value)}/></label>
 <label>需要什么帮助<select value={draft.intent} onChange={e=>change('intent',e.target.value)}><option value="collaboration">一起完成工作</option><option value="stuck">处理遇到的困难</option><option value="proactive-review">主动评审</option><option value="diagnosis">诊断问题</option><option value="delegation">委托明确工作</option></select></label>
 <label>目标<Textarea required maxLength={10000} value={draft.goal} onChange={e=>change('goal',e.target.value)}/></label><label>当前情况与必要环境<Textarea required maxLength={10000} value={draft.situation} onChange={e=>change('situation',e.target.value)} placeholder="说明当前情况；未尝试时可以如实填写，不需要编写失败史。"/></label>
 <label>帮助请求说明<Textarea required maxLength={10000} value={draft.summary} onChange={e=>change('summary',e.target.value)} placeholder="提供哪些帮助最有价值，哪些原文暂不分享。"/></label><label>预期交付或判断方式（可选）<Textarea maxLength={1500} value={draft.expectedOutcome} onChange={e=>change('expectedOutcome',e.target.value)}/></label>
 <label>协助方式<select value={draft.collaboration} onChange={e=>change('collaboration',e.target.value)}><option value="open-assistance">开放协助 · 新参与者可以开始</option><option value="basic-bounty">赏金协助 · 按当前相关资格筛选</option></select></label></fieldset>
 {paid?<><BudgetFields draft={draft} disabled={busy} onChange={change}/><fieldset disabled={busy}><legend>参与资格</legend><Button type="button" variant="outline" disabled={!connected} onClick={()=>run(catalog)}>读取当前启用的规则</Button>
 <label>相关工作条件<select required value={draft.policyKey} onChange={e=>change('policyKey',e.target.value)}><option value="">选择服务中真实启用的策略</option>{policies.filter(p=>p.collaboration==='basic-bounty').map(p=><option key={policyKey(p)} value={policyKey(p)}>{p.title} · {p.capabilityId} · {p.version}</option>)}</select></label>
 {catalogLoaded&&!policies.some(p=>p.collaboration==='basic-bounty')&&<p className="message">当前服务没有启用赏金资格规则。草稿可以保留；不能自行编造一个规则发布赏金任务。</p>}
 {policy&&<p>至少 {policy.minAcceptedCollaborations} 项相关且当前有效的实际经历；{policy.minProofs} 项限定 CI 证明。材料窗口 {Math.floor(policy.historyWindowSeconds/86400)} 天。外部工作或挑战仅在经过当前登记审核者的限定核对后计入；挑战不冒充生产履历。</p>}
 <p className="muted">审核按具体任务条件进行，不是永久身份等级。是否符合条件会在选择和确认参与时重新计算。</p></fieldset></>:
 <label>相关能力范围标识（可选）<Input maxLength={128} value={draft.capabilityId} onChange={e=>change('capabilityId',e.target.value)} placeholder="如已明确 software-debugging；不填不影响开放参与"/></label>}
 <fieldset disabled={busy}><legend>发布范围与征集时间</legend><label>可见范围<select value={draft.visibility} onChange={e=>change('visibility',e.target.value)}><option value="Public">公开此任务请求</option><option value="Private">仅本人私有记录</option></select></label>
 <p className="muted">公开只包含本页任务条件，不包含申请人的私有报价、联系建议或未选聊天背景。仅本人私有记录无法被其他人查询和申请。</p>
 <label>征集截止（本机时区）<Input required type="datetime-local" value={draft.enrollmentLocal} onChange={e=>change('enrollmentLocal',e.target.value)}/></label><p>征集截止只控制新申请与参与提议。已有参与、交付与争议仍各自继续；截止不会自动取消工作。</p></fieldset>
 <div className="button-row"><Button type="submit" disabled={busy||!!pending}>预览任务与条件</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>navigate('/app/match')}>保留草稿，返回发现</Button><Button type="button" variant="ghost" onClick={()=>navigate('/app/rooms')}>普通聊天</Button></div></form>}
 {preview&&<article className="task-body"><h2>确认这次发布</h2><h3>{preview.title}</h3><p>{preview.summary}</p><p>目标：{preview.workContext.goal}</p><p>当前情况：{preview.workContext.currentSituation}</p>{preview.expectedOutcome&&<p>预期交付：{preview.expectedOutcome}</p>}<TaskTerms request={preview}/><p>{preview.visibility==='Public'?'任何人可查看这些任务条件；申请和实际参与由本人分别确认。':'此版本仅本人可读；不会自动邀请其他身份。'}</p><div className="button-row"><Button type="button" disabled={busy||!connected||!!pending} onClick={()=>run(submit)}>确认并发布这份任务</Button><Button type="button" variant="outline" disabled={busy} onClick={()=>setPreview(null)}>返回修改</Button></div></article>}
 </section>;
}
