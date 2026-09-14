import {taskRequestV2Schema,taskEnvelopeV2Schema} from '../../galaxy-official/src/shared/task-schema-v2.mjs';
import {qualificationEvidenceV2Schema} from '../../galaxy-official/src/shared/qualification-v2-schema.mjs';

export const budgetText=b=>!b?'未单独报价':b.mode==='quote'?`待报价 · ${b.unit}`:b.mode==='range'?`${b.minimum}—${b.maximum} ${b.unit}`:`${b.amount} ${b.unit}`;
export const policyKey=p=>`${p.id}@${p.version}`;
export function localDateTime(seconds){const date=new Date(seconds*1000);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}
export function taskDraft(value={},now=Math.floor(Date.now()/1000)){
 // Keep unknown legacy/local fields rather than replacing the user's draft.
 return {title:'',summary:'',goal:'',situation:'',visibility:'Public',intent:'collaboration',expectedOutcome:'',
  collaboration:'open-assistance',budgetMode:'fixed',amount:'',minimum:'',maximum:'',unit:'CNY',policyKey:'',capabilityId:'',
  enrollmentLocal:localDateTime(now+7*86400),...value};
}
export function formBudget(d){const unit=d.unit.trim();return d.budgetMode==='quote'?{mode:'quote',unit}:
 d.budgetMode==='range'?{mode:'range',minimum:d.minimum.trim(),maximum:d.maximum.trim(),unit}:{mode:'fixed',amount:d.amount.trim(),unit};}
export function publicationFromDraft(d,policies,now=Math.floor(Date.now()/1000)){
 const expires=Math.floor(Date.parse(d.enrollmentLocal)/1000);
 if(!Number.isSafeInteger(expires)||expires<=now)throw Error('请设置将来的征集截止时间；这不是交付截止时间。');
 const paid=d.collaboration==='basic-bounty',policy=policies.find(p=>policyKey(p)===d.policyKey&&p.collaboration==='basic-bounty'&&p.notBefore<=now&&p.notAfter>now);
 if(paid&&!policy)throw Error('请选择服务当前启用的赏金资格规则；目录为空时可以先保留本地草稿。');
 const input={title:d.title.trim(),summary:d.summary.trim(),intent:d.intent,visibility:d.visibility,collaboration:d.collaboration,
  caseId:null,workContext:{goal:d.goal.trim(),currentSituation:d.situation.trim(),attemptRefs:[]},enrollmentExpiresAt:expires,
  ...(d.expectedOutcome.trim()?{expectedOutcome:d.expectedOutcome.trim()}:{}),
  ...(paid?{budget:formBudget(d),capabilityId:policy.capabilityId,qualification:{policyId:policy.id,policyVersion:policy.version,profile:'facts-v2'}}:
   d.capabilityId.trim()?{capabilityId:d.capabilityId.trim()}:{})};
 const {operationId,taskId,...validated}=taskRequestV2Schema.parse({...input,operationId:'00000000-0000-4000-8000-000000000001',taskId:'00000000-0000-4000-8000-000000000002'});
 return validated;
}
export function evidenceFromSelection(items){
 const computation=items.filter(i=>i.kind==='calculation');
 if(computation.length){if(items.length!==1)throw Error('本任务限定计算许可已包含固定来源，请单独选择它，不能混入其他材料。');return qualificationEvidenceV2Schema.parse(computation[0].evidence);}
 const combined={participationIds:[],externalReviewRefs:[],capsuleUseIds:[],proofIds:[],assistanceIds:[]};
 for(const item of items)for(const field of Object.keys(combined))for(const value of item.evidence?.[field]??[]){
  if(!combined[field].some(v=>JSON.stringify(v)===JSON.stringify(value)))combined[field].push(value);}
 return qualificationEvidenceV2Schema.parse(combined);
}
export function applicationFromDraft(d,task){
 const event={kind:'apply',expectedTaskVersion:task.version,proposal:d.proposal.trim(),scope:d.scope.trim(),
  ...(task.request.collaboration==='basic-bounty'&&d.quoteMode==='own'?{quote:formBudget(d)}:{}),
  ...(task.request.qualification?{qualificationEvidence:task.request.qualification.profile==='facts-v2'?evidenceFromSelection(d.selected??[]):legacyEvidenceFromSelection(d.selected??[])}:{})};
 // Shape validation only: runtime creates and persists the real ID exactly once.
 const parsed=taskEnvelopeV2Schema.parse({taskId:task.taskId,event:{...event,eventId:'00000000-0000-4000-8000-000000000001'}});
 const {eventId,...data}=parsed.event;return data;
}
export function legacyEvidenceFromSelection(items){if(items.some(i=>!['legacy-assistance','proof'].includes(i.kind)))throw Error('旧规则只接受旧协助与 Proof；请移除其他来源，不能自动转换。');
 const e=evidenceFromSelection(items);return{proofIds:e.proofIds,assistanceIds:e.assistanceIds};}
export function qualificationEvaluationInput(task,subjectId,items){return task.request.qualification?.profile==='facts-v2'?
 {path:'/v2/qualification/evaluate',input:{taskId:task.taskId,subjectId,evidence:evidenceFromSelection(items),includeSimulation:false}}:
 {path:'/v1/qualification/evaluate',input:{subjectId,policyId:task.request.qualification.policyId,policyVersion:task.request.qualification.policyVersion,capabilityId:task.request.capabilityId,evidence:legacyEvidenceFromSelection(items)}};}
export const qualificationEvaluationView=r=>r.state?r:{...r,state:r.eligible?'satisfied':'insufficient-evidence',missing:r.reasons??[]};
export const qualificationState=q=>!q?'尚未核对':q.state==='satisfied'?'当前满足本任务条件':q.state==='not-satisfied'?'当前不满足限定条件':'当前材料不足';
export const taskWriteError=e=>e?.issues?.length?'请检查内容是否完整，金额须为非负十进制文本，区间下限不能大于上限，单位和当前规则不能为空。':({qualification_required:'当前材料不足以开始这项赏金参与。查看本任务资格结果；开放协助仍可开始。',qualification_policy_unavailable:'该资格规则当前未启用或已到期，请刷新目录。',enrollment_closed:'征集已结束；只有请求者明确延长后才能继续征集。',task_version_conflict:'任务已被其他操作更新。先核对原操作状态；不要重签一个不同的申请。',pending_task_event:'同一任务有待确认原操作，请先恢复它。',pending_task_publication:'还有一项原发布结果待核对，请先恢复它。',connection_required:'请先连接当前银河身份。',account_verification_required:'公开发布需要先完成账号验证。',verified_account_required:'公开发布需要先完成账号验证。'}[e?.code??e?.message]??e?.message??'操作未完成。');
