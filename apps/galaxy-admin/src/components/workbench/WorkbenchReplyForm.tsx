'use client';

import {useId,useMemo,useState,type FormEvent} from 'react';

import {readReplyForm} from './workbench-answer-guards';

export function WorkbenchReplyForm({source,onDraft}:{source:string;onDraft?:(text:string)=>void}){
  const form=useMemo(()=>readReplyForm(source),[source]),id=useId(),[draft,setDraft]=useState<{source:string;values:Record<string,string>}>({source,values:{}});
  const values=draft.source===source?draft.values:{};
  const setValue=(field:string,value:string)=>setDraft(previous=>({source,values:{...(previous.source===source?previous.values:{}),[field]:value}}));
  if(!form)return <pre tabIndex={0}><code>{source}</code></pre>;
  const complete=form.fields.every(field=>field.type==='select'?field.options!.includes(values[field.id]):(values[field.id]??'').trim());
  const submit=(event:FormEvent)=>{event.preventDefault();if(complete&&onDraft)onDraft(form.title+'\n'+form.fields.map(field=>field.label+'：'+values[field.id].trim()).join('\n'));};
  return <form className="wb-reply-form" onSubmit={submit}><strong>{form.title}</strong><div className="wb-reply-form-fields">{form.fields.map(field=><label key={field.id} htmlFor={id+'-'+field.id}><span>{field.label}</span>{field.type==='select'?<select id={id+'-'+field.id} value={values[field.id]??''} onChange={event=>setValue(field.id,event.target.value)}><option value="">请选择</option>{field.options!.map(option=><option key={option}>{option}</option>)}</select>:<input id={id+'-'+field.id} maxLength={500} value={values[field.id]??''} onChange={event=>setValue(field.id,event.target.value)}/>}</label>)}</div><div className="wb-reply-form-footer"><span>填写后可继续补充，不会直接办理业务。</span><button type="submit" disabled={!complete||!onDraft}>填入提问</button></div></form>;
}
