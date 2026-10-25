import type {ForumReport} from './community-operations-types';

export type CaseRestrictionAction='keep'|'release'|'hide';
export type CaseDecision={id:string;version:number;actorKind:'identity'|'business-operator';actorId:string|null;operatorDisplayName?:string|null;resolution:'accepted'|'dismissed'|'needs-review'|null;restrictionAction:CaseRestrictionAction|null;effectUntil:string|null;createdAt:string};
export type CaseAccount={accountId:string;uid:string|null;displayName:string|null};
export type CaseEvent=NonNullable<ForumReport['events']>[number]&{restrictionAction?:CaseRestrictionAction|null};
export type CaseReport=Omit<ForumReport,'events'>&{title?:string|null;reporter?:CaseAccount|null;targetAuthor?:CaseAccount|null;events?:CaseEvent[];initialDecision?:CaseDecision|null;currentDecision?:CaseDecision|null;currentEffect?:{active:boolean;until:string|null;restrictionEventId:string|null;scope:'this-case-only';canKeep:boolean;canRelease:boolean;canHide:boolean};resultDelivery?:{channel:'original-case-read';state:'readable';notification:'not-connected'}};
export type CaseFilters={selected:string;state:string;after:string;trail:string;query:string;kind:''|'post-version'|'reply';view:'materials'|'source'|'history'};
export type CaseDraft={resolution:string;summary:string;restrictionAction:CaseRestrictionAction;seconds:string};
export const emptyCaseDraft:CaseDraft={resolution:'',summary:'',restrictionAction:'keep',seconds:'3600'};
export const caseStates:Record<string,string>={pending:'待处理',appealed:'申诉中',resolved:'已处理',withdrawn:'已撤回'};
export const caseResolutions:Record<string,string>={accepted:'采取处理',dismissed:'不予处理','needs-review':'需进一步复核'};
const knownLabel=(labels:Record<string,string>,key:string,fallback:string)=>Object.hasOwn(labels,key)?labels[key]:fallback;
export const caseStateLabel=(value:string)=>knownLabel(caseStates,value,'状态未记录');
export const caseResolutionLabel=(value:string|null|undefined)=>knownLabel(caseResolutions,value??'','结果未记录');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text=(value:unknown)=>typeof value==='string'?value:'';
export const caseId=(value:unknown)=>uuid.test(text(value))?text(value):'';
export function caseTrail(value:unknown){
 const parts=text(value).split('.');
 return parts.length<=32&&parts.every(part=>part==='0'||uuid.test(part))?parts.join('.'):'';
}
export function normalizeCaseFilters(input:Partial<Record<keyof CaseFilters,unknown>>):CaseFilters{
 const state=text(input.state),kind=text(input.kind),view=text(input.view);
 return {selected:caseId(input.selected),state:Object.hasOwn(caseStates,state)?state:'',after:caseId(input.after),trail:caseTrail(input.trail),query:text(input.query).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,160),kind:kind==='post-version'||kind==='reply'?kind:'',view:view==='source'||view==='history'?view:'materials'};
}
export function casesHref(filters:CaseFilters,change:Partial<CaseFilters>={}){
 const f=normalizeCaseFilters({...filters,...change}),q=new URLSearchParams({tab:'reports'});
 for(const [key,value] of Object.entries({state:f.state,after:f.after,trail:f.trail,id:f.selected,q:f.query,kind:f.kind,view:f.view==='materials'?'':f.view}))if(value)q.set(key,value);
 return '/admin/operations/community?'+q.toString();
}
export function casesReadPath(filters:CaseFilters){
 const f=normalizeCaseFilters(filters),q=new URLSearchParams({limit:'25'});
 if(f.state)q.set('state',f.state);if(f.after)q.set('after',f.after);
 return '/v1/operations/community/reports?'+q.toString();
}
export function casesNextHref(filters:CaseFilters,next:unknown){
 const id=caseId(next);if(!id)return casesHref(filters);
 const previous=filters.trail?filters.trail.split('.'):[];
 return casesHref(filters,{after:id,trail:[...previous,filters.after||'0'].slice(-32).join('.')});
}
export function casesPreviousHref(filters:CaseFilters){
 const previous=caseTrail(filters.trail).split('.').filter(Boolean),after=previous.pop();
 return casesHref(filters,{after:after&&after!=='0'?after:'',trail:previous.join('.')});
}
export function caseTargetLabel(report:CaseReport){return report.target.kind==='reply'?'回复':'帖子版本';}
export function caseTitle(report:CaseReport){return report.title||((report.source?.availability==='available'&&report.source.content?.title)?report.source.content.title:caseTargetLabel(report)+'举报');}
export function caseAccountLabel(account:CaseAccount|null|undefined){return account?.displayName||account?.uid||'查看账户';}
export function filterCases(items:CaseReport[],filters:CaseFilters){
 const q=filters.query.trim().toLocaleLowerCase();
 return items.filter(item=>(!filters.kind||item.target.kind===filters.kind)&&(!q||[item.id,caseTitle(item),caseTargetLabel(item),caseStateLabel(item.state),item.reporterAccountId??'',item.reporter?.uid??'',item.reporter?.displayName??'',item.target.postId,item.target.versionId??'',item.target.replyId??''].join(' ').toLocaleLowerCase().includes(q)));
}
export function caseEventLabel(event:CaseEvent){return knownLabel({report:'提交举报',supplement:'补充说明',appeal:'提出申诉',resolve:'记录处理结果',withdraw:'撤回举报'},event.kind,'治理记录');}
export function caseActorLabel(event:CaseEvent){return event.actorKind==='business-operator'?'运营管理身份':event.actorKind==='official-account'?'银河账户':event.actorKind==='identity'?'银河身份':'来源未记录';}
export function caseHasRestriction(report:CaseReport,now:number){
 const until=report.currentEffect?.until??report.restrictedUntil;
 return !!until&&Number.isFinite(Date.parse(until))&&Date.parse(until)>now*1000&&(report.currentEffect?report.currentEffect.active:true);
}
export function caseRestrictionActions(report:CaseReport,now:number):CaseRestrictionAction[]{
 if(!report.canModerate||!['pending','appealed'].includes(report.state))return [];
 const effect=report.currentEffect;
 if(effect)return effect.scope==='this-case-only'?([...(effect.canKeep?['keep']:[]),...(effect.canRelease&&caseHasRestriction(report,now)?['release']:[]),...(effect.canHide?['hide']:[])] as CaseRestrictionAction[]):[];
 // The legacy resolve endpoint replaces a prior restriction. Only an unrestricted
 // record can safely use it until explicit per-case capabilities are returned.
 return caseHasRestriction(report,now)?[]:['keep',...(caseHideDurations(report,now).length?['hide'] as const:[])];
}
export function caseRestrictionLabel(action:CaseRestrictionAction,active:boolean){return action==='keep'?(active?'维持本案隐藏':'保持当前显示'):action==='release'?'解除本案隐藏':'暂时隐藏相关内容';}
export function caseRecordedAction(action:string){return knownLabel({keep:'维持原处置',release:'解除本案隐藏',hide:'新设本案隐藏'},action,'未记录');}
export function caseHideDurations(report:CaseReport,now:number){
 if(report.source?.availability!=='available'||!report.source.content||!Number.isFinite(report.source.publishedUntil)||!Number.isFinite(report.maxHideSeconds))return [];
 const maximum=Math.floor(Math.min(report.maxHideSeconds,(report.source.publishedUntil??0)-now)/60)*60;
 return [900,3600,21600,maximum].filter((value,index,all)=>value>0&&value<=maximum&&all.indexOf(value)===index).sort((a,b)=>a-b);
}
export function caseDurationLabel(seconds:number){return seconds%3600===0?seconds/3600+' 小时':seconds%60===0?seconds/60+' 分钟':seconds+' 秒';}
export function caseDecisionBody(report:CaseReport,draft:CaseDraft,now:number){
 if(!caseRestrictionActions(report,now).includes(draft.restrictionAction)||!Object.hasOwn(caseResolutions,draft.resolution)||draft.summary.trim().length<3||[...draft.summary].length>1600)return null;
 const body:Record<string,unknown>={expectedVersion:report.version,resolution:draft.resolution,summary:draft.summary.trim()};
 if(report.currentEffect)body.restrictionAction=draft.restrictionAction;
 if(draft.restrictionAction==='hide'){
  if(draft.resolution!=='accepted')return null;
  const seconds=Number(draft.seconds);if(!caseHideDurations(report,now).includes(seconds))return null;
  body.hideUntil=now+seconds;
 }
 return body;
}
export function caseSourceLink(value:string){
 try{const url=new URL(value);return url.protocol==='https:'||url.protocol==='http:'?url.href:null;}catch{return null;}
}
