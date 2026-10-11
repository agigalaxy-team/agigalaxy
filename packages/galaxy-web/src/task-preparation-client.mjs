import {withholdTaskMaterialTree} from './task-material-client.mjs';
import {sha256Hex} from '../../galaxy-official/src/shared/web-primitives.mjs';
import {contactCandidates} from './task-contact-client.mjs';
import {taskOriginReturn} from './help-origin-client.mjs';

const stable=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])])):value;
const payloadBody=({taskId:_taskId,operationId:_operationId,...payload})=>payload;
export function createTaskPreparationClient(runtime){
 const owner=runtime.api.snapshot(),endpoint=runtime.api.endpoint,lease=owner?runtime.receiptStatus?.captureLease?.():null;
 let closed=false;
 const check=()=>{lease?.assertCurrent();const value=runtime.api.snapshot();if(closed||!owner||runtime.api.endpoint!==endpoint||['subjectId','bindingId','generation'].some(key=>owner[key]!==value?.[key]))throw Error('身份或连接已改变，请重新打开并核对协助准备。');};
 const wait=async action=>{check();try{const value=await action();check();return value;}catch(error){check();throw error;}};
 const call=(path,input)=>wait(()=>runtime.api.call(path,input,{authenticated:true}));
 const fingerprint=payload=>wait(()=>sha256Hex(JSON.stringify(stable(payloadBody(payload)))));
 const own=record=>{if(record&&(record.ownerId!==owner.subjectId||record.endpoint!==endpoint))throw Error('这份协助准备不属于当前身份。');return record;};
 /** @param {{keyword?:string,functions?:string[],capabilityId?:string}} input */
 async function query({keyword='',functions=[],capabilityId=''}){
  check();const input={keyword:keyword.trim(),functions:[...functions],capabilityId:capabilityId.trim()};
  const requests=[{type:'history',query:{query:input.keyword,...(input.capabilityId?{capabilityId:input.capabilityId}:{}),timeWindow:{kind:'all-visible'},limit:8,after:null}}];
  if(input.functions.length)requests.push({type:'opportunity',query:{context:{kind:'ephemeral',title:input.keyword||'寻找明确功能的协助',functions:input.functions},purposes:['conversation','collaboration'],limit:8,after:null}});
  const pages=await wait(()=>Promise.all(requests.map(async search=>{try{return{...await call('/v2/search/query',search),search,error:null};}catch{check();return{type:search.type,items:[],search,error:'此来源暂未读取成功，可稍后重试。'};}})));
  return {ownerId:owner.subjectId,endpoint,input,pages,candidates:contactCandidates(pages,owner.subjectId),selected:[],preparedAt:new Date().toISOString()};
 }
 /** @param {any} payload @param {any} preparation @param {{taskId:string,returnTo:string}|null} originReturn */
 async function freeze(payload,preparation,originReturn=null){
  if(originReturn&&(originReturn.taskId!==payload.parentTaskId||!taskOriginReturn(originReturn.taskId,originReturn.returnTo)))throw Error('原工作返回位置与这份请求不一致。');
  const hash=await fingerprint(payload);const record={ownerId:owner.subjectId,endpoint,payloadHash:hash,preparation:preparation?withholdTaskMaterialTree(own(preparation),undefined,{all:true}):null,
   ...(originReturn?{originReturn:{taskId:originReturn.taskId,returnTo:taskOriginReturn(originReturn.taskId,originReturn.returnTo)}}:{})};
  await wait(()=>runtime.putLocal(`task-preparation-payload:${hash}`,record));return hash;
 }
 async function attach(task){
  check();if(task.requesterId!==owner.subjectId)throw Error('只能接续本人发布的协助准备。');
  const hash=await fingerprint(task.rootRequest??task.request),record=own(await wait(()=>runtime.getLocal(`task-preparation-payload:${hash}`)));
  if(!record||record.payloadHash!==hash)return null;
  const fixed={...record,taskId:task.taskId,preparation:record.preparation?withholdTaskMaterialTree(record.preparation,undefined,{all:true}):null};await wait(()=>runtime.putLocal(`task-preparation:${task.taskId}`,fixed));return fixed;
 }
 async function resume(task){
  check();let record=own(await wait(()=>runtime.getLocal(`task-preparation:${task.taskId}`)));
  if(!record)record=await attach(task);
  if(!record?.preparation)return null;
  if(record.taskId!==task.taskId||task.requesterId!==owner.subjectId)throw Error('原准备与当前任务不一致。');
  const prepared=record.preparation,pages=[];let withheld=0;
  // Recheck every exact version before private source bodies reach the page.
  for(const page of prepared.pages){const items=[];for(const item of page.items){
    try{const current=await call('/v2/search/reference',{search:page.search,ref:item.ref});if(current.state==='current'&&current.item)items.push(current.item);else withheld++;}catch{check();withheld++;}
   }pages.push({...page,items});}
  const candidates=contactCandidates(pages,owner.subjectId).map(candidate=>{const old=prepared.candidates.find(item=>item.subjectId===candidate.subjectId);return{...candidate,help:old?.help??'',basis:old?.basis??'',conditions:old?.conditions??candidate.conditions};});
  return{...prepared,pages,candidates,selected:prepared.selected.filter(id=>candidates.some(item=>item.subjectId===id)),withheld};
 }
 return Object.freeze({check,query,freeze,attach,resume,close:()=>{closed=true;}});
}
