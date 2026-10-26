import React, { useId } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ReadingDetails, ReadingSummary } from "../../../shared/reading/reading-details";
import { readableTime } from "../../../shared/people/conversation-ui";
import type { OriginalProjectOperation, ProjectForm, RecruitmentForm } from '../contracts';

export const purposeNames: Record<string,string> = {
  conversation: '普通交流',
  reuse: '了解复用',
  collaboration: '共同协作',
  recruitment: '了解招募',
};
const operationKindNames:Record<string,string>={create:'新增',revise:'更新介绍','grant-role':'授予协作角色','revoke-role':'撤销协作角色','offer-transfer':'邀请接手管理','accept-transfer':'接受管理转交','cancel-transfer':'取消管理转交',archive:'归档',restore:'恢复',send:'发起联系',accept:'接受交流',decline:'拒绝联系',withdraw:'撤回联系',renew:'续期招募',pause:'暂停招募',close:'关闭招募','link-task':'关联已有求助'};
export function SavedOperationContent({review,name}:{review:OriginalProjectOperation;name:(id:string)=>string}){
 const value=review.payload,document='document' in value?value.document:'patch' in value?value.patch:null;
 const context='context' in value&&value.context.kind==='ephemeral'?value.context:null;
 const role=document&&'role' in document&&typeof document.role==='string'?document.role:'',conditions=document&&'conditions' in document&&typeof document.conditions==='string'?document.conditions:'';
 return <><p>{operationKindNames[value.kind]??'提交这次内容'} · {({project:'项目',recruitment:'持续招募',contact:'联系邀请'} as Record<string,string>)[review.type]}</p>
  {document&&<><h3>{document.title??'原项目内容'}</h3>{document.summary&&<p className="reading-prose">{document.summary}</p>}{role&&<p>角色：{role}</p>}{document.functions&&<p>方向：{document.functions.join('、')}</p>}{(document.technologies?.length??0)>0&&<p>工具与技术：{document.technologies?.join('、')}</p>}{conditions&&<p className="reading-prose">{conditions}</p>}{'sourceUrl' in document&&typeof document.sourceUrl==='string'&&document.sourceUrl&&<p>来源地址：{document.sourceUrl}</p>}{'discoverable' in document&&typeof document.discoverable==='boolean'&&<p>{document.discoverable?'允许参与发现':'不参与新的发现'}</p>}</>}
  {'context' in value&&<><h3>{context?.title??'交流背景'}</h3><p>{context?.functions.join('、')}</p>{!!context?.technologies.length&&<p>{context.technologies.join('、')}</p>}</>}
  {'recipientId' in value&&<p>接收者：{name(value.recipientId)}</p>}{'purpose' in value&&<p>交流目的：{purposeNames[value.purpose]??value.purpose}</p>}{'note' in value&&value.note&&<p className="reading-prose">{value.note}</p>}{'roomTitle' in value&&<p>对方接受后的聊天名称：{value.roomTitle}</p>}
  {'subjectId' in value&&<p>参与者：{name(value.subjectId)} · {value.role==='editor'?'资料编辑':'对外代表'}</p>}{'toSubjectId' in value&&<p>邀请接手者：{name(value.toSubjectId)}</p>}{'taskId' in value&&<p>关联求助：{value.taskId}</p>}{'expiresAt' in value&&<p>有效至 {readableTime(value.expiresAt*1000)}</p>}
  <p>{review.visibility==='Public'?'公开分享':'分享给你'+(review.viewers.length?'和 '+review.viewers.map(name).join('、'):'')}</p>
  <ReadingDetails className="technical-details"><ReadingSummary>原内容与准确记录</ReadingSummary><p>{review.operationId} · {review.payloadHash}</p><pre>{JSON.stringify(value,null,2)}</pre></ReadingDetails>
 </>;
}
export function ProjectTextField({label,value,onChange,multiline=false,disabled,required,maxLength}:{label:string;value:string;onChange:(value:string)=>void;multiline?:boolean;disabled:boolean;required:boolean;maxLength:number}){
 const id=useId();return <label htmlFor={id}>{label}{multiline?<Textarea id={id} disabled={disabled} required={required} maxLength={maxLength} value={value} onChange={event=>onChange(event.target.value)}/>:<Input id={id} disabled={disabled} required={required} maxLength={maxLength} value={value} onChange={event=>onChange(event.target.value)}/>}</label>;
}

// Controlled fields render the caller's draft; they do not own editing or submission state.
export function ProjectIntroductionFields({form,onChange,disabled}:{form:ProjectForm;onChange:(form:ProjectForm)=>void;disabled:boolean}) {
  return <><label>类别<select value={form.kind} onChange={event=>onChange({...form,kind:event.target.value})}><option value="project">作品或项目</option><option value="module">可复用模块</option></select></label><ProjectTextField label="名称" value={form.title??''} disabled={disabled} required={true} maxLength={120} onChange={value=>onChange({...form,title:value})}/><ProjectTextField label="作品介绍与当前进展" value={form.summary??''} disabled={disabled} required={true} maxLength={2000} multiline onChange={value=>onChange({...form,summary:value})}/><ProjectTextField label="内容与涉及方向（逗号分隔）" value={form.functions??''} disabled={disabled} required={true} maxLength={2000} onChange={value=>onChange({...form,functions:value})}/><ProjectTextField label="使用的工具与技术（可选）" value={form.technologies??''} disabled={disabled} required={false} maxLength={2000} onChange={value=>onChange({...form,technologies:value})}/><ProjectTextField label="HTTPS 作品来源（可选）" value={form.sourceUrl??''} disabled={disabled} required={false} maxLength={2000} onChange={value=>onChange({...form,sourceUrl:value})}/></>;
}
export function RecruitmentWorkFields({form,onChange,disabled}:{form:RecruitmentForm;onChange:(form:RecruitmentForm)=>void;disabled:boolean}) {
  return <><ProjectTextField label="招募名称" value={form.title??''} disabled={disabled} required={true} maxLength={120} onChange={value=>onChange({...form,title:value})}/><ProjectTextField label="希望找到的角色" value={form.role??''} disabled={disabled} required={true} maxLength={500} onChange={value=>onChange({...form,role:value})}/><ProjectTextField label="具体工作" value={form.summary??''} disabled={disabled} required={true} maxLength={3000} multiline onChange={value=>onChange({...form,summary:value})}/><ProjectTextField label="相关功能（逗号分隔）" value={form.functions??''} disabled={disabled} required={true} maxLength={2000} onChange={value=>onChange({...form,functions:value})}/></>;
}
export function RecruitmentConditionFields({form,onChange,disabled,fieldId}:{form:RecruitmentForm;onChange:(form:RecruitmentForm)=>void;disabled:boolean;fieldId:string}) {
  return <><ProjectTextField label="参与条件与时间（可选）" value={form.conditions??''} disabled={disabled} required={false} maxLength={2000} multiline onChange={value=>onChange({...form,conditions:value})}/><ProjectTextField label="使用的技术（可选）" value={form.technologies??''} disabled={disabled} required={false} maxLength={2000} onChange={value=>onChange({...form,technologies:value})}/><label htmlFor={fieldId+'-days'}>发布后有效天数<Input id={fieldId+'-days'} type="number" min={1} max={30} required value={form.days} onChange={event=>onChange({...form,days:Number(event.target.value)})}/></label><p className="record-meta">招募以公开项目及当前代表权为基础。具体参与内容由你与回应者进一步商定。</p></>;
}
