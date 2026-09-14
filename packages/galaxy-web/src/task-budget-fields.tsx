import React from 'react';
import {Input} from '@/components/ui/input';
import {budgetText} from './task-bounty-client.mjs';
export function BudgetFields({draft,onChange,disabled=false}:{draft:any;onChange:(field:string,value:string)=>void;disabled?:boolean}){
 return <fieldset disabled={disabled} className="workspace-form"><legend>金额条件</legend><label>预算方式<select value={draft.budgetMode} onChange={e=>onChange('budgetMode',e.target.value)}><option value="fixed">固定金额</option><option value="range">金额区间</option><option value="quote">请协商报价</option></select></label>
 {draft.budgetMode==='fixed'&&<label>金额<Input required inputMode="decimal" value={draft.amount} onChange={e=>onChange('amount',e.target.value)} placeholder="例如 500"/></label>}
 {draft.budgetMode==='range'&&<><label>最低金额<Input required inputMode="decimal" value={draft.minimum} onChange={e=>onChange('minimum',e.target.value)}/></label><label>最高金额<Input required inputMode="decimal" value={draft.maximum} onChange={e=>onChange('maximum',e.target.value)}/></label></>}
 <label>币种或约定单位<Input required maxLength={24} value={draft.unit} onChange={e=>onChange('unit',e.target.value)} placeholder="例如 CNY"/></label><p className="muted">银河记录双方所述条件，不提供自动支付、托管、退款或报酬保证。</p></fieldset>;
}
export function TaskTerms({request}:{request:any}){return <div className="message"><strong>{request.collaboration==='basic-bounty'?'赏金协助':'开放协助'}</strong>
 {request.budget&&<p>任务整体预算：{budgetText(request.budget)}。每份申请的报价另行列示，不自动平分或承诺付款。</p>}
 {request.qualification&&<p>资格规则：{request.qualification.policyId} / {request.qualification.policyVersion}；范围：{request.capabilityId}。选择与确认参与时仍核对当前来源。</p>}
 <p>征集截止：{new Date(request.enrollmentExpiresAt*1000).toLocaleString()}。交付时间应写入双方确认的范围，不由征集截止推断。</p></div>;}
