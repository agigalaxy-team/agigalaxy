import type {AiRecordedTime,AiRunDomain,AiRunEvent,AiRunLocation,AiRunMetadata,AiRunSpan,AiRunState,AiSpanRow} from "../../components/ai-runs/ai-runs-types";

export const aiRunDomains={overview:'工作台',governance:'内容治理',messaging:'公告与消息',discovery:'发现与推荐',maintenance:'运行维护'} as const;
export const aiRunStates={PENDING:'等待运行',RUNNING:'运行中',COMPLETED:'已完成',PAUSED:'已暂停',CANCELLED:'已停止',ERROR:'运行失败',REGENERATED:'已重新生成'} as const;
const opaque=/^[A-Za-z0-9_-]{1,128}$/;
const known=<T extends string>(value:string,values:Record<T,string>):T|''=>Object.hasOwn(values,value)?value as T:'';
export const aiRunsSearchKeys=['run','span','trace','page','domain','state','view','task','source','mode','archive'] as const;
export function aiRunsLocation(input:Record<string,string>):AiRunLocation{
 const run=opaque.test(input.run??'')?input.run:'',page=/^[1-9][0-9]{0,5}$/.test(input.page??'')&&Number(input.page)<=100000?Number(input.page):1;
 const task=opaque.test(input.task??'')?input.task:'',source=['workbench','routine','event','recovery'].includes(input.source)?input.source as NonNullable<AiRunLocation['source']>:'',mode=['code','ai','ai-human','human-ai'].includes(input.mode)?input.mode as NonNullable<AiRunLocation['mode']>:'';
 return {run,span:run&&opaque.test(input.span??'')?input.span:'',trace:run&&opaque.test(input.trace??'')?input.trace:'',page,domain:known(input.domain??'',aiRunDomains),state:known(input.state??'',aiRunStates),view:['io','feedback'].includes(input.view??'')?input.view as 'io'|'feedback':'process',...(task?{task}:{}),...(source?{source}:{}),...(mode?{mode}:{}),...(/^[a-z][a-z-]{0,39}$/.test(input.state??'')?{taskState:input.state}:{}),...(input.archive==='1'?{archive:true}:{})};
}
export function aiRunsHref(location:AiRunLocation,patch:Partial<AiRunLocation>={}){
 const value={...location,...patch},q=new URLSearchParams();
 for(const key of ['run','span','trace','domain','state','task','source','mode'] as const)if(value[key])q.set(key,value[key]);
 if(value.taskState)q.set('state',value.taskState);if(value.archive)q.set('archive','1');
 if(value.page>1)q.set('page',String(value.page));if(value.view!=='process')q.set('view',value.view);
 return '/admin/operations/ai-runs'+(q.size?'?'+q:'');
}
export function aiRunsPath(location:AiRunLocation){return '/v1/operations/agentos/runs?'+new URLSearchParams({page:String(location.page),limit:'25',...(location.domain?{domain:location.domain}:{}),...(location.state?{state:location.state}:{})});}
export function aiRunDetailPath(id:string){return opaque.test(id)?'/v1/operations/agentos/runs/'+id:null;}
export function autonomyRunsPath(location:AiRunLocation){return '/v1/operations/autonomy/tasks?'+new URLSearchParams({page:String(location.page),limit:'25',...(location.domain?{domain:location.domain}:{}),...(location.taskState?{state:location.taskState==='awaiting-human'?'waiting-human':location.taskState}:{}),...(location.source?{source:location.source}:{}),...(location.mode?{mode:location.mode}:{})});}
export function aiRecordedNumber(value:number|null|undefined){return typeof value==='number'&&Number.isFinite(value)&&value>=0?value.toLocaleString('zh-CN'):'未记录';}
export function aiDuration(value:number|null|undefined){
 if(typeof value!=='number'||!Number.isFinite(value)||value<0)return '未记录';
 if(value<1000)return new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(value)+' ms';
 return new Intl.NumberFormat('zh-CN',{maximumFractionDigits:3}).format(value/1000)+' s';
}
export function aiTimeMilliseconds(value:AiRecordedTime){
 if(value===null||value==='')return null;
 const time=typeof value==='number'?value*1000:Date.parse(value);
 return Number.isFinite(time)?time:null;
}
export function aiRunTime(value:AiRecordedTime){const time=aiTimeMilliseconds(value);return time===null?'未记录':new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(time);}
export function aiRunStateLabel(state:AiRunState|string|null){return state&&Object.hasOwn(aiRunStates,state)?aiRunStates[state as AiRunState]:'未记录';}
export function aiRunDomainLabel(domain:AiRunDomain|string|null){return domain&&Object.hasOwn(aiRunDomains,domain)?aiRunDomains[domain as AiRunDomain]:'未记录';}
export function aiRunTrigger(run:AiRunMetadata){return run.conversation?'工作台沟通':!run.executor?'未记录':run.executor.mode==='automatic'?'系统自动':'人员代办';}
export function aiRunTitle(run:AiRunMetadata){
 if(run.conversation)return aiRunDomainLabel(run.domain)+'沟通';
 if(run.componentId==='galaxy-prepared-review')return '已准备操作';
 if(run.componentId==='galaxy-p13-selected-content-v1')return '公开内容策略运行';
 if(run.domain&&run.componentId==='galaxy-'+run.domain)return aiRunDomainLabel(run.domain)+'执行';
 return 'AI运行';
}
export function aiRunInitiator(run:AiRunMetadata){
 if(run.conversation)return run.conversation.operatorDisplayName?.trim()||'管理账户';
 if(run.executor?.mode==='automatic')return '系统自动';
 if(run.executor?.onBehalfOf)return run.executor.onBehalfOfDisplayName?.trim()||'管理账户';
 return '未记录';
}
export function aiSpanKind(span:AiRunSpan){const labels:Record<string,string>={AGENT:'助手运行',CHAIN:'执行步骤',LLM:'模型调用',TOOL:'工具调用',RETRIEVER:'检索',EMBEDDING:'向量计算',RERANKER:'重新排序',GUARDRAIL:'规则检查',EVALUATOR:'结果评估'};return span.kind?labels[span.kind]??'调用步骤':'调用步骤';}
export function aiSpanLabel(span:AiRunSpan){
 if(span.kind==='TOOL'&&['current_summary','current_summary()'].includes(span.name))return '读取工作台摘要';
 return aiSpanKind(span);
}
export function aiRunError(run:AiRunMetadata){
 if(run.state!=='ERROR')return null;
 const labels:Record<string,string>={operations_authorization_unavailable:'运行授权服务暂时不可用，本次运行未完成。',operations_agentos_authority_changed:'本次运行的授权已变化，运行已停止。'};
 return run.errorCode&&Object.hasOwn(labels,run.errorCode)?labels[run.errorCode]:'本次运行失败。错误详情未记录。';
}
export function aiSpanState(value:string|null){const labels:Record<string,string>={OK:'已完成',ERROR:'步骤失败',UNSET:'状态未记录'};return value&&labels[value]?labels[value]:'未记录';}
export function aiSpanKey(span:Pick<AiRunSpan,'traceId'|'spanId'>){return span.traceId+':'+span.spanId;}
export function aiSpanRows(spans:AiRunSpan[]):AiSpanRow[]{
 const unique=new Map<string,AiRunSpan>();for(const span of spans)if(!unique.has(aiSpanKey(span)))unique.set(aiSpanKey(span),span);
 const sorted=[...unique.values()].sort((a,b)=>(aiTimeMilliseconds(a.startTime)??Number.MAX_SAFE_INTEGER)-(aiTimeMilliseconds(b.startTime)??Number.MAX_SAFE_INTEGER)||aiSpanKey(a).localeCompare(aiSpanKey(b)));
 const children=new Map<string,AiRunSpan[]>(),roots:AiRunSpan[]=[];
 for(const span of sorted){const parent=span.parentSpanId?unique.get(span.traceId+':'+span.parentSpanId):null;if(!parent||parent===span)roots.push(span);else{const key=aiSpanKey(parent);children.set(key,[...(children.get(key)??[]),span]);}}
 const visited=new Set<string>(),result:AiSpanRow[]=[];
 function visit(span:AiRunSpan,depth:number){const key=aiSpanKey(span);if(visited.has(key))return;visited.add(key);result.push({key,span,depth,orphan:!!span.parentSpanId&&!unique.has(span.traceId+':'+span.parentSpanId)});for(const child of children.get(key)??[])visit(child,depth+1);}
 for(const span of roots)visit(span,0);for(const span of sorted)if(!visited.has(aiSpanKey(span)))visit(span,0);
 return result;
}
export function aiTimelineRange(spans:AiRunSpan[]){
 const intervals=spans.map(span=>({start:aiTimeMilliseconds(span.startTime),end:aiTimeMilliseconds(span.endTime)})).filter((value):value is {start:number;end:number}=>value.start!==null&&value.end!==null&&value.end>=value.start);
 return intervals.length?{start:Math.min(...intervals.map(value=>value.start)),end:Math.max(...intervals.map(value=>value.end))}:null;
}
export function aiSpanInterval(span:AiRunSpan,range:{start:number;end:number}|null){
 const start=aiTimeMilliseconds(span.startTime),end=aiTimeMilliseconds(span.endTime);
 if(!range||start===null||end===null||end<start)return null;
 const total=range.end-range.start;if(total<=0)return {left:0,width:0,startMs:0,endMs:0};
 return {left:Math.max(0,Math.min(100,(start-range.start)/total*100)),width:Math.max(0,Math.min(100,(end-start)/total*100)),startMs:start-range.start,endMs:end-range.start};
}
export function aiEventLabel(event:AiRunEvent){
 const labels:Record<string,string>={RunStarted:'运行开始',RunCompleted:'运行结束',RunPaused:'运行暂停',RunContinued:'运行继续',RunCancelled:'运行停止',RunError:'运行错误',WorkflowStarted:'工作流开始',WorkflowCompleted:'工作流结束',WorkflowError:'工作流错误',WorkflowPaused:'工作流暂停',WorkflowContinued:'工作流继续',ToolCallStarted:'工具调用开始',ToolCallCompleted:'工具调用完成',ToolCallError:'工具调用错误',ModelRequestStarted:'模型请求开始',ModelRequestCompleted:'模型请求完成'};
 return labels[event.event]??'运行事件（'+event.event+'）';
}
