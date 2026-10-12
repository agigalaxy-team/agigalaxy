import * as z from 'zod/v4';
import {readWorkContinuationLink,workContinuationPath} from './work-continuation-link.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const text=value=>typeof value==='string'?value.trim():'';
const lines=(heading,values)=>values.filter(value=>typeof value==='string'&&value.trim()).length?[heading,...values.filter(value=>typeof value==='string'&&value.trim())].join('\n'):'';
const reasonOf=error=>['access_denied','binding_revoked','invalid_session','session_expired','unauthorized','receipt_status_authority_changed','native_connection_selection_changed','native_runtime_closed'].includes(error?.code??error?.message)?'connection-changed'
 :error?.status===403?'not-permitted':error?.status===404?'source-unavailable':error?.status===410?'source-expired':'temporarily-unavailable';
const reasons={'not-permitted':'当前身份不能读取这份资料。','source-unavailable':'这份资料目前不可读。','source-expired':'这份资料的可读期限已结束。','temporarily-unavailable':'暂时无法核对这份资料，连接恢复后可以继续。'};
const reportedOutcomes={succeeded:'报告完成',partial:'部分完成',failed:'未完成',inconclusive:'暂不能得出结论',conflicting:'观察有冲突'};
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value??{},key)).map(key=>[key,value[key]]));

// Each reader uses the existing service projection. In particular Task reads
// use current strings, not signed rootRequest/materialBodies or a local cache.
async function readSource(api,object){
 switch(object.kind){
  case 'task':return api.call('/v2/tasks/'+object.id,undefined,{method:'GET'});
  case 'room':return api.call('/v2/chat/rooms/'+object.id+'/read',{});
  case 'project':return api.call('/v2/projects/'+object.id,undefined,{method:'GET'});
  case 'person':return api.call('/v1/history/query',{subjectId:object.id,limit:1});
  case 'post':return api.call('/v2/community/posts/'+object.id+(object.versionId?'/versions/'+object.versionId:''),undefined,{method:'GET'});
  case 'capsule':return api.call('/v2/capsules/read',{capsuleId:object.id,versionId:object.versionId});
  case 'context':return api.call('/v2/context/'+object.id,undefined,{method:'GET'});
 }
}
function sourceReading(object,data){
 if(object.kind==='task'){
  if(data?.taskId!==object.id||!data.request)fail('work_continuation_source_mismatch');const r=data.request;
  return{title:text(r.title)||'这项求助',content:[lines('需要的帮助',[text(r.summary)]),lines('目标',[text(r.workContext?.goal)]),lines('当前情况',[text(r.workContext?.currentSituation)]),lines('希望取得',[text(r.expectedOutcome)])].filter(Boolean).join('\n\n'),
   notes:['只使用这次服务返回的当前正文；这是阅读，不代表已参与或已完成。'],availableUntil:currentTaskDeadline(data),deadlineReason:'temporarily-unavailable'};
 }
 if(object.kind==='project'){
  if(data?.projectId!==object.id)fail('work_continuation_source_mismatch');const d=data.document;if(!d)return null;
  return{title:text(d.title)||'这个项目',content:text(d.summary),notes:[Array.isArray(d.functions)&&d.functions.length?'适用方向：'+d.functions.join('、'):''].filter(Boolean),availableUntil:null};
 }
 if(object.kind==='person'){
  if(data?.subjectId!==object.id)fail('work_continuation_source_mismatch');const d=data.selfDeclared;if(!d||!text(d.displayName)&&!text(d.about))return null;
  return{title:text(d.displayName)||'这位作者',content:text(d.about),notes:[Array.isArray(d.claimedCapabilities)&&d.claimedCapabilities.length?'本人介绍的方向：'+d.claimedCapabilities.join('、'):''].filter(Boolean),availableUntil:data.selfDeclaredReadExpiresAt??null,deadlineReason:'temporarily-unavailable'};
 }
 if(object.kind==='post'){
  if(data?.locator?.postId!==object.id||object.versionId&&data.locator.versionId!==object.versionId)fail('work_continuation_source_mismatch');
  if(data.availability!=='available'||!data.payload)return null;
  return{title:text(data.payload.title)||'这篇帖子',content:text(data.payload.body),notes:[],availableUntil:data.publishedUntil??null,deadlineReason:'source-expired'};
 }
 if(object.kind==='context'){
  if(data?.metadata?.grantId!==object.id)fail('work_continuation_source_mismatch');if(data.contextAccessGranted!==true)return null;
  return{title:'本次选定的工作材料',content:(data.materials??[]).map(material=>lines(text(material.label)||'所选材料',[text(material.content)])).filter(Boolean).join('\n\n'),notes:['材料只按现有许可读取，不附带执行或再次分享授权。'],availableUntil:data.metadata.expiresAt??null};
 }
 if(object.kind==='capsule'){
  if(data?.capsuleId!==object.id||data.version?.id!==object.versionId&&data.versionId!==object.versionId)fail('work_continuation_source_mismatch');
  const d=data.version?.payload??data.version;if(!d||data.sourceStatus==='source-unavailable')return null;
  const source=capsuleSourceReading(data.sourceReading);
  return{title:text(d.title)||'这份方法',content:[lines('适用问题',[text(d.problemPattern)]),lines('解决方法',[text(d.solutionStrategy)]),lines('适用范围',[text(d.applicableScope)]),lines('验证方式',[text(d.verificationMethod)]),lines('限制',Array.isArray(d.limitations)?d.limitations:[]),
   source?.case.status==='available'?lines('方法来自的工作',[text(source.case.title),text(source.case.summary)]):source?'方法来自的工作当前不可读。':'',
   source?.result.status==='available'?lines('原工作结果 · '+(reportedOutcomes[source.result.reportedOutcome]??'原作者的结果说明'),[text(source.result.summary),text(source.result.limitations)]):source?'原工作结果当前不可读，保持未知。':''].filter(Boolean).join('\n\n'),
   notes:[Number.isSafeInteger(d.version)?'方法第 '+d.version+' 版':'',data.deprecated?'这一版本已弃用。':'',data.securityIssue?'这一版本有尚未处理的安全问题。':'',text(d.license)?'许可证：'+d.license:'','阅读或下载不表示这次已成功复用。'].filter(Boolean),availableUntil:data.availableUntil??data.readExpiresAt??null,deadlineReason:'temporarily-unavailable'};
 }
 if(object.kind==='room'){
  if(data?.roomId!==object.id)fail('work_continuation_source_mismatch');
  // A room link selects its context, not every message or another member's
  // files. Message material must be chosen separately in the existing flow.
  return{title:text(data.title)||'这段对话',content:'已定位这段对话。请只按当前问题和已有对话授权取得所需消息；这次链接没有选择完整历史或附件。',notes:[],availableUntil:null};
 }
 return null;
}
function capsuleSourceReading(value){
 if(!value)return null;
 const reference=ref=>pick(ref,['kind','id','version','caseId']);
 const reading=(item,fields)=>item?.status==='available'?{status:'available',ref:reference(item.ref),...pick(item,fields)}:{status:'unavailable',...(item?.ref?{ref:reference(item.ref)}:{})};
 // The method API already checks these two exact sources as this reader.
 // Do not replace them with publisher authority or fetch an entire Case.
 return{case:reading(value.case,['authorId','title','summary']),result:reading(value.result,['authorId','summary','reportedOutcome','limitations','currentness'])};
}
function currentTaskDeadline(data){
 const values=Object.values(data?.textView?.fields??{}).flatMap(field=>typeof field?.availableUntil==='number'&&Number.isFinite(field.availableUntil)?[field.availableUntil]:[]);
 return values.length?Math.min(...values):null;
}
function currentSourceData(object,data){
 if(object.kind==='task')return{...pick(data,['schemaVersion','taskId','caseId','requesterId','version','state','enrollmentOpen','paused','textView']),
  request:{...pick(data.request,['title','summary','expectedOutcome','intent','visibility','enrollmentExpiresAt']),
   workContext:pick(data.request.workContext,['goal','currentSituation','attemptRefs'])},
  participations:(data.participations??[]).map(participation=>({...pick(participation,['participationId','subjectId','state','role','scopeVersion','scopeAvailable','agreedScope']),
   deliveries:(participation.deliveries??[]).map(delivery=>({...pick(delivery,['deliveryId','summary','resultRef','interventionRefs','evidenceRefs']),acceptance:delivery.acceptance?pick(delivery.acceptance,['eventId','summary']):null}))}))};
 if(object.kind==='person')return{subjectId:data.subjectId,selfDeclared:pick(data.selfDeclared,['displayName','about','claimedCapabilities','projects']),
  ...pick(data,['selfDeclaredSource','selfDeclaredRevision','selfDeclaredReadExpiresAt','checkedAt'])};
 if(object.kind==='context')return pick(data,['metadata','state','materials','contextAccessGranted','originalContentErased']);
 if(object.kind==='post')return pick(data,['locator','payload','availability','topic','createdAt','versionCreatedAt','publishedUntil','readExpiresAt']);
 if(object.kind==='project')return pick(data,['projectId','ownerId','creatorId','revision','state','visibility','document','source']);
 if(object.kind==='capsule')return{...pick(data,['capsuleId','versionId','authorId','version','revision','sourceStatus','permissions','attributions','deprecated','securityIssue','notices','newApplicationAllowed','synthetic','readingIsReuse']),...(data.sourceReading?{sourceReading:capsuleSourceReading(data.sourceReading)}:{})};
 if(object.kind==='room')return pick(data,['roomId','title','kind','state','members','taskRefs']);
 return null;
}
async function currentWorkResults(api,task,lease){
 if(!task.caseId)return{state:'not-recorded',results:[]};
 try{
  const view=await api.call('/v2/cases/'+task.caseId+'/read',{taskId:task.taskId});lease.assertCurrent();if(view.caseId!==task.caseId)fail('work_continuation_source_mismatch');
  return{state:'current',caseId:view.caseId,version:view.version,scopeVersion:view.scopeVersion,
   results:(view.results??[]).map(result=>pick(result,['id','version','actorId','participationId','scopeVersion','origin','summary','reportedOutcome','limitations','deliverableRefs'])),
   resolution:view.resolution?pick(view.resolution,['id','status','scopeVersion','summary','remainingGoals','resultRefs','reconfirmationRequired','currentDecisionAvailable']):null,
   coverage:pick(view.coverage,['complete','reasons'])};
 }catch(error){lease.assertCurrent();if((error.code??error.message)==='work_continuation_source_mismatch')throw error;
  const reason=reasonOf(error);if(reason==='connection-changed')fail('work_continuation_connection_changed');return{state:'unavailable',reason,results:[]};
 }
}
function taskResultReading(task,work){
 const deliveries=(task.participations??[]).flatMap(participant=>(participant.deliveries??[]).map(delivery=>({summary:text(delivery.summary),accepted:!!delivery.acceptance,resultRef:delivery.resultRef}))).filter(delivery=>delivery.summary);
 const output=[];
 if(work.state==='current')for(const result of work.results)output.push(lines('已有工作结果 · '+(reportedOutcomes[result.reportedOutcome]??'原作者的结果说明'),[text(result.summary),text(result.limitations)]));
 for(const delivery of deliveries)output.push(lines(delivery.accepted?'已经接收的交付说明':'已经提交的交付说明',[delivery.summary]));
 if(work.state==='unavailable')output.push('已有工作结果目前无法核对，保持未知；不能据此判断工作没有结果。');
 else if(!work.results.length&&!deliveries.length)output.push('目前没有读到已记录的结果。希望取得的结果仍是目标，不是完成事实。');
 return output.join('\n\n');
}
function readableState(data){
 const state=data?.state??data?.availability;
 return ['expired','source-expired'].includes(state)?'source-expired':'source-unavailable';
}

export function continuationResultText(data){
 const output=[lines('接着当前事情',[data.purpose])];
 for(const source of data.sources){
  if(source.state==='available')output.push(lines(source.role==='current'?'当前内容：'+source.title:'所选资料：'+source.title,[source.content,...source.notes,...(source.url?['来源：'+source.url]:[])]));
  else output.push((source.role==='current'?'当前内容':'所选资料')+'：'+(reasons[source.reason]??reasons['source-unavailable']));
 }
 output.push('继续处理：围绕上面的目的整理可用内容与下一步；尚未取得的材料和结果保持未知。');
 output.push('回到原页面继续：\n'+data.returnUrl);
 return output.filter(Boolean).join('\n\n');
}

/** Read-only continuation: a chosen link never widens permission or submits a business action. */
export function createWorkContinuationReader(runtime){
 return async({link})=>{
  const request=readWorkContinuationLink(link);
  if(request.website!==runtime.website||request.endpoint!==runtime.api.endpoint)fail('work_continuation_service_mismatch');
  const status=await runtime.status({restoreSelected:true});
  if(status.identity!==request.subjectId)fail('work_continuation_identity_mismatch');
  if(!status.connected)fail('work_continuation_connection_required');
  const lease=runtime.receiptStatus.captureLease();lease.assertCurrent();
  const refs=[request.object,...request.selectedMaterials],seen=new Set(),sources=[];
  for(const ref of refs){
   const key=JSON.stringify(ref);if(seen.has(key))continue;seen.add(key);lease.assertCurrent();let data,reading,reason;
   let machine=null;
   try{data=await readSource(runtime.api,ref);lease.assertCurrent();reading=sourceReading(ref,data);reason=reading?null:readableState(data);
    if(reading){machine=currentSourceData(ref,data);if(ref.kind==='task'){
     const work=await currentWorkResults(runtime.api,data,lease);reading.content=[reading.content,taskResultReading(data,work)].filter(Boolean).join('\n\n');machine.workResults=work;
    }}
   }
   catch(error){lease.assertCurrent();if((error.code??error.message)==='work_continuation_source_mismatch')throw error;reason=reasonOf(error);if(reason==='connection-changed')fail('work_continuation_connection_changed');}
   sources.push({role:sources.length?'selected':'current',object:ref,url:workContinuationPath(ref)?new URL(workContinuationPath(ref),runtime.website).href:null,
    state:reading?'available':'unavailable',reason,title:reading?.title??null,content:reading?.content??null,notes:reading?.notes??[],availableUntil:reading?.availableUntil??null,deadlineReason:reading?.deadlineReason??'source-expired',data:machine});
  }
  lease.assertCurrent();const now=runtime.now?.()??Math.floor(Date.now()/1000);
  // A readable window can end while later selected sources are loading.
  // Clear it before returning rather than sending stale body to the host.
  for(const source of sources)if(source.availableUntil!==null&&source.availableUntil<=now){source.state='unavailable';source.reason=source.deadlineReason;source.title=null;source.content=null;source.notes=[];source.data=null;}
  return {kind:'galaxy-work-continuation',purpose:request.purpose,subjectId:lease.subjectId,endpoint:runtime.api.endpoint,
   sources,returnUrl:request.returnUrl,currentSourceUrl:request.sourceUrl,checkedAt:now,
   availableActions:[{kind:'return-to-page',label:'回到原页面继续',url:request.returnUrl}],
   permissionExpanded:false,businessMutation:false,modelStarted:false,reuseOutcomeRecorded:false};
 };
}
export function registerWorkContinuationTools(server,{runtime}){
 const read=createWorkContinuationReader(runtime);
 server.registerTool('galaxy_work_continue',{inputSchema:z.strictObject({link:z.string().min(20).max(18000)}),
  description:'Continue the user-selected website content in this same current Galaxy identity. Paste the generated link directly; do not ask the user for IDs or tool JSON. Re-read exact selected sources under current permission; keep unavailable content unknown. Returns useful authored text, permitted structured facts and the original web position. Reading is not a new grant, message, Task participation, model call or successful method reuse.',annotations:{readOnlyHint:true}},async input=>{
  try{const data=await read(input);return{content:[{type:'text',text:continuationResultText(data)}],structuredContent:data};}
  catch(error){const code=/^work_continuation_[a-z_]+$/.test(error.code??error.message??'')?error.code??error.message:'work_continuation_unavailable';
   return{isError:true,content:[{type:'text',text:code==='work_continuation_identity_mismatch'?'当前客户端使用的身份与网页选择不同。请回到原身份继续；没有读取所选正文。':code==='work_continuation_service_mismatch'?'这个链接不属于当前选定的银河服务。请在对应服务继续；没有读取所选正文。':'暂时无法接回这份内容。原页面和选择保留，恢复当前连接后可以继续同一链接。'}],structuredContent:{error:code,bodyDisclosed:false,permissionExpanded:false,businessMutation:false}};
  }
 });
 return{read};
}
