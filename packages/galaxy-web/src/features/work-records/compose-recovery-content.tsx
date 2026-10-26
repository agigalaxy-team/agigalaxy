import React from 'react';
import {Button} from '@/components/ui/button';
import type {WorkComposeDraft} from './contracts';
import {actionTitles,downloadRecord} from './record-labels';

export function WorkComposeCard({saved,busy,pending,sourceUnavailable,composeError,onResume,onDiscard}:{saved:WorkComposeDraft;busy:boolean;pending:boolean;sourceUnavailable:boolean;composeError:string;onResume:(draft:WorkComposeDraft)=>void;onDiscard:(draft:WorkComposeDraft)=>Promise<void>}){
 return <div className="work-compose-resume"><p>{saved.submission==='stopped-local'?'已停止继续发送，原稿仍保留。':saved.eventId||saved.operationId?'正在确认上次提交，原稿仍保留。':saved.value.kind==='deliver'?'有一份尚未发送的交付草稿。':'有一份尚未发送的工作草稿。'}</p><div className="button-row">
  {!saved.operationId&&!saved.eventId&&<><Button disabled={busy||pending||sourceUnavailable} onClick={()=>onResume(saved)}>继续编辑</Button><button className="text-action" disabled={busy} onClick={()=>void onDiscard(saved)}>放弃这份草稿</button></>}
  {(saved.submission==='stopped-local'||composeError)&&<button className="text-action" onClick={()=>downloadRecord(saved.value,'galaxy-work-draft.json')}>保存原稿</button>}
  {saved.submission==='stopped-local'&&<button className="text-action" disabled={busy} onClick={()=>void onDiscard(saved)}>另写新内容</button>}
 </div></div>;
}
export function OriginalContent({item}:{item:{payloadJson:string}}){
 let value:unknown;try{value=JSON.parse(item.payloadJson);}catch{return <p>这份原内容需要在下载文件中核对。</p>;}
 if(!value||typeof value!=='object'||Array.isArray(value))return <p>这份原内容需要在下载文件中核对。</p>;
 const fields=[['title','标题'],['summary','内容'],['description','做过的事'],['strategy','方法'],['observedEffect','观察'],['limitations','限制'],['reason','原因'],['inputScopeSummary','使用的输入']],kind='kind' in value&&typeof value.kind==='string'?value.kind:'';
 const body=fields.flatMap(([key,label])=>{const field:unknown=Reflect.get(value,key);return typeof field==='string'&&field?[{key,label,text:field}]:[];});
 return <article className="original-work-content"><h4>{actionTitles[kind]??'工作背景'}</h4>{body.map(field=><div key={field.key}><small>{field.label}</small><p className="reading-prose">{field.text}</p></div>)}<button type="button" className="text-action" onClick={()=>downloadRecord(item.payloadJson,'galaxy-original-work.json')}>保存完整原文</button></article>;
}
