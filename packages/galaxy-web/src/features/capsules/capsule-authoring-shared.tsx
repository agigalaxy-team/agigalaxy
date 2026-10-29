import React,{useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {Button} from '@/components/ui/button';
import {capsuleCaseSources,capsuleRefKey} from './capsule-workspace-client.mjs';
import {capsuleSourceV2Schema} from "../../../../galaxy-contracts/src/capsule-v2-schema.mjs";
import {MemberAvatar,memberName,useMemberNames} from "../../shared/people/conversation-ui";
import {useChoiceViewLease} from "../../shared/operations/choice-retained-operations";
import type {CapsuleAuthorClient,CapsuleAuthorLease,CapsuleAuthorRuntime,CapsuleCaseHistory,CapsuleHistoryState,CapsuleInputDraft,CapsulePeople,CapsuleRegisterDraft,CapsuleSourceItem,CapsuleSourceRef} from './capsule-authoring-types';

export const sourceKind=(kind:string)=>({ 'case-root':'工作背景',attempt:'尝试',intervention:'协助过程',result:'实际结果',evidence:'证据',verification:'检查记录',configuration:'运行条件','selected-message':'对话原话','outcome-material':'成果材料' } as Record<string,string>)[kind]??'所选来源';
export const sourceLocator=(value:CapsuleSourceItem):CapsuleSourceItem=>{const source=value.ref,ref:CapsuleSourceRef='caseId' in source?{kind:source.kind,id:source.id,version:source.version,caseId:source.caseId}:{kind:source.kind,id:source.id,version:source.version};return{ref,...(value.authorId?{authorId:value.authorId}:{}),label:sourceKind(source.kind)};};
export const uniqueSources=<T extends CapsuleSourceItem,>(items:T[])=>[...new Map(items.map(item=>[capsuleRefKey(item.ref),item])).values()];
export const methodInputError=(error:unknown)=>{const value=typeof error==='object'&&error!==null?error:null,message=value&&'message' in value&&typeof value.message==='string'?value.message:'',code=value&&'code' in value&&typeof value.code==='string'?value.code:message;return({capsule_source_permission_required:'部分来源还没有覆盖本次范围的作者许可，请查看下方来源说明。',capsule_resolution_required:'所选来源结果当前不能支持新方法，请核对实际结果。',capsule_source_unavailable:'部分来源当前无法读取。自己的输入和选定版本仍保留。',configuration_content_unavailable:'所选运行配置已撤回或当前不可读取，自己的输入仍保留。',capsule_conflict:'方法已有更新，请先核对当前版本。'} as Record<string,string>)[code]??(/[\u3400-\u9fff]/.test(message)?message:'暂时无法核对，自己的输入和准确来源仍保留。');};
export function readableCaseSources(history:CapsuleCaseHistory|null|undefined,retained:CapsuleSourceItem[]=[]):CapsuleSourceItem[]{
 if(!history)return[];
 const items:CapsuleSourceItem[]=capsuleCaseSources(history).map(source=>{const item={...source,ref:capsuleSourceV2Schema.parse(source.ref)};return item.ref.kind==='case-root'?{...item,fact:history.events?.find(event=>event.eventId===item.ref.id)?.payload,body:history.summary??history.background??''}:item;});
 for(const [field,kind] of [['attempts','attempt'],['interventions','intervention'],['results','result']] as const){
  for(const fact of history[field]??[])if(retained.some(item=>item.ref.kind===kind&&item.ref.id===fact.id&&item.ref.version===fact.version)&&!items.some(item=>item.ref.kind===kind&&item.ref.id===fact.id&&item.ref.version===fact.version)){
   items.push({ref:{kind,id:fact.id,version:fact.version,caseId:history.caseId},authorId:fact.actorId==='unknown'?fact.reportedBy:fact.actorId,label:fact.summary??fact.description??fact.strategy??sourceKind(kind),fact,historical:true});
  }
 }
 return items;
}
export function sourceBody(item:CapsuleSourceItem){
 const value=item.reading??item.fact??item.view?.record??{};
 return item.body||value.text||value.solutionStrategy||value.strategy||value.description||value.summary||item.label||sourceKind(item.ref.kind);
}
export function SourceReading({item,subjectId,names,children,compact=false}:{item:CapsuleSourceItem;subjectId:string;names?:Record<string,string|null>;children?:ReactNode;compact?:boolean}){
 const expires=Date.parse(item.reading?.expiresAt??''),[clock,setClock]=useState(Date.now);
 useEffect(()=>{if(!Number.isFinite(expires))return;const timer=window.setTimeout(()=>setClock(Date.now()),Math.min(2147483647,Math.max(0,expires-Date.now()+10)));return()=>window.clearTimeout(timer);},[expires]);
 const expired=Number.isFinite(expires)&&expires<=clock,body=expired?'这条来源的可读期限已到，准确引用仍保留。':sourceBody(item),author=item.authorId??item.reading?.authorId;
 return <article className={'method-source-reading'+(compact?' is-compact':'')}>
  <header><span className="method-source-kind">{sourceKind(item.ref.kind)} · 第 {item.ref.version} 版{item.historical?' · 历史记录':''}</span>{author&&<span className="method-source-person"><MemberAvatar subjectId={author}/>{memberName(author,subjectId,names?.[author]??undefined)}</span>}</header>
  {!expired&&item.view?.record?.title&&<h4>{item.view.record.title}</h4>}
  <p className="reading-prose">{body}</p>
  {!expired&&item.fact?.summary&&item.fact.summary!==body&&<p className="reading-prose">{item.fact.summary}</p>}
  {item.fact?.reportedOutcome&&<p className="source-reading-note">{({succeeded:'报告达到目标',partial:'部分达到目标',failed:'未达到目标',inconclusive:'尚无定论',conflicting:'结论冲突'} as Record<string,string>)[item.fact.reportedOutcome]}</p>}
  {item.unavailable&&<p className="message">原内容当前无法读取，保留准确引用。请重新核对或明确移除。</p>}
  {children}
 </article>;
}
export function useCapsuleWorkHistory(client:CapsuleAuthorClient|null,caseId:string,paused=false):CapsuleHistoryState{
 const [view,setView]=useState<{client:CapsuleAuthorClient|null;items:CapsuleCaseHistory[];loaded:boolean;error:string;reading:boolean;next:string|null}>({client:null,items:[],loaded:false,error:'',reading:false,next:null});
 const {items,loaded,error,reading,next}=view.client===client?view:{items:[],loaded:false,error:'',reading:false,next:null};
 const active=useRef(true),ticket=useRef(0),pages=useRef(1),inFlight=useRef<Promise<CapsuleCaseHistory[]|undefined>|null>(null),latest=useRef({client,caseId,paused,next,items,reading});
 useLayoutEffect(()=>{latest.current={client,caseId,paused,next,items,reading};},[client,caseId,paused,next,items,reading]);
 const load=useCallback(async(more=false)=>{
  if(!client)return [];if(inFlight.current)await inFlight.current;
  if(!active.current||latest.current.client!==client)return;const turn=++ticket.current;setView(old=>old.client===client?{...old,reading:true}:{client,items:[],loaded:false,error:'',reading:true,next:null});
  const job=(async()=>{try{
   let cursor=more?latest.current.next:null,readPages=0,following:string|null=null;const rows:CapsuleCaseHistory[]=[],seen=new Set<string>();
   if(more&&!cursor)return;
   do{
    const value=await client.history(cursor?{after:cursor}:{});if(!active.current||turn!==ticket.current||latest.current.client!==client)return;
    rows.push(...value.items.filter(item=>item.kind==='case-history'));following=value.nextCursor??null;readPages++;
    if(!following)break;if(seen.has(following))throw Error('工作记录分页暂时无法继续，已选引用仍保留。');seen.add(following);cursor=following;
   }while(!more&&(readPages<pages.current||!!latest.current.caseId&&!rows.some(item=>item.caseId===latest.current.caseId)));
   if(!active.current||turn!==ticket.current)return;
   pages.current=more?pages.current+1:readPages;setView(old=>({client,items:uniqueHistory(more&&old.client===client?[...old.items,...rows]:rows),next:following,loaded:true,error:'',reading:false}));return rows;
  }catch(error){if(active.current&&turn===ticket.current&&latest.current.client===client)setView({client,items:[],loaded:false,next:null,error:methodInputError(error),reading:false});throw error;}
  finally{if(active.current&&turn===ticket.current&&latest.current.client===client)setView(old=>({...old,reading:false}));}})();
  inFlight.current=job;try{return await job;}finally{if(inFlight.current===job)inFlight.current=null;}
 },[client]);
 useEffect(()=>{active.current=true;const requests=ticket;requests.current++;pages.current=1;inFlight.current=null;const start=window.setTimeout(()=>void load().catch(()=>{}),0),refresh=()=>{if(!document.hidden&&!latest.current.paused)void load().catch(()=>{});};const timer=window.setInterval(refresh,15000);document.addEventListener('visibilitychange',refresh);return()=>{active.current=false;requests.current++;window.clearTimeout(start);window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[load]);
 useEffect(()=>{if(!caseId)return;const start=window.setTimeout(()=>{if(!inFlight.current&&!latest.current.items.some(item=>item.caseId===caseId))void load().catch(()=>{});},0);return()=>window.clearTimeout(start);},[caseId,load]);
 return{items,loaded,error,reading,next,load};
}
const uniqueHistory=(rows:CapsuleCaseHistory[])=>[...new Map(rows.map(row=>[row.caseId,row])).values()];

/** Current source reads only. Selected text is returned to the preview, never to the draft. */
export async function readCapsulePermissionSources(runtime:CapsuleAuthorRuntime,client:CapsuleAuthorClient,subjectId:string,selected:CapsuleSourceItem[],caseSources:CapsuleSourceItem[]){
 const lease=runtime.receiptStatus.captureLease(),check=()=>{lease.assertCurrent();if(lease.subjectId!==subjectId)throw Error('来源身份已改变。');};
 const call=async<T,>(path:string,input:Record<string,unknown>):Promise<T>=>{check();const value:T=await runtime.api.call(path,input);check();return value;};
 const found=new Map(caseSources.map(source=>[capsuleRefKey(source.ref),source])),missingCases=[...new Set(selected.flatMap(item=>'caseId' in item.ref&&!found.has(capsuleRefKey(item.ref))?[item.ref.caseId]:[]))];
 for(const caseId of missingCases){check();const facts=await client.caseFacts({caseId});check();for(const source of readableCaseSources(facts,selected))found.set(capsuleRefKey(source.ref),source);}
 for(const item of selected.filter(value=>value.ref.kind==='configuration')){check();const view=await client.configuration({id:item.ref.id,version:item.ref.version});check();if(!view.record)throw Error('所选运行配置当前不可读取，许可输入仍保留。');found.set(capsuleRefKey(item.ref),{...item,authorId:view.subjectId,view});}
 const messages=selected.filter(item=>item.ref.kind==='selected-message'),missing=new Map(messages.map(item=>[item.ref.id,item])),roomCursors=new Set<string>();let roomAfter:string|undefined;
 while(missing.size){
  const page=await call<{rooms:{roomId:string}[];next?:string}>('/v2/chat/rooms/query',{limit:30,...(roomAfter?{after:roomAfter}:{})});
  for(const room of page.rooms){
   if(!missing.size)break;let after='0';const cursors=new Set<string>();
   do{const history=await call<{messages:{messageId:string;revision:number;text?:string;sharedSummaryId?:string|null;subjectId:string;expiresAt?:string}[];next?:string}>('/v2/chat/rooms/'+room.roomId+'/history',{limit:30,after});
    for(const message of history.messages){
     const wanted=missing.get(message.messageId);if(!wanted)continue;
     if(message.revision!==wanted.ref.version||!message.text||message.sharedSummaryId)throw Error('所选原话已变化或现在不可读取，请重新核对准确片段。');
     found.set(capsuleRefKey(wanted.ref),{...wanted,authorId:message.subjectId,reading:{text:message.text,roomId:room.roomId,expiresAt:message.expiresAt,permission:'current-room-read-only',publicationPermission:false}});missing.delete(message.messageId);
    }
    if(!history.next||!missing.size)break;if(cursors.has(history.next))throw Error('消息分页暂时无法继续核对，原输入仍保留。');cursors.add(history.next);after=history.next;
   }while(missing.size>0);
  }
  roomAfter=page.next;if(!roomAfter)break;if(roomCursors.has(roomAfter))throw Error('对话分页暂时无法继续核对，原输入仍保留。');roomCursors.add(roomAfter);
 }
 if(missing.size)throw Error('部分选定原话当前不可读取，许可输入和准确引用仍保留。');
 check();return selected.map(item=>{const source=found.get(capsuleRefKey(item.ref));if(!source)throw Error('部分来源当前无法核对，请重新选择实际内容。');if(source.authorId!==subjectId)throw Error('这里只能许可本人创作的内容，请重新核对来源作者。');return source;});
}

export function WorkSelection({history,value,onChange,busy,label='方法来自哪件工作？'}:{history:CapsuleHistoryState;value:string;onChange:(value:string)=>void;busy:boolean;label?:string}){
 return <div className="method-work-choice">
  <label>{label}<select value={value} disabled={busy||history.reading} onChange={event=>onChange(event.target.value)}><option value="">选择已发生的工作</option>{history.items.map(item=><option value={item.caseId} key={item.caseId}>{item.title??'已发生的工作'}{item.synthetic?'（合成演示）':''}</option>)}{value&&!history.items.some(item=>item.caseId===value)&&<option value={value}>已选工作暂未读到，引用仍保留</option>}</select></label>
  {history.reading&&!history.loaded&&<output>正在读取实际工作…</output>}
  {history.error&&<p role="alert" className="message error">{history.error}<Button type="button" variant="ghost" disabled={busy||history.reading} onClick={()=>void history.load().catch(()=>{})}>重新读取</Button></p>}
  {history.loaded&&!history.items.length&&<p>当前没有可选工作。可以先回到原任务记录实际过程和结果。</p>}
  {history.next&&<Button type="button" variant="ghost" disabled={busy||history.reading} onClick={()=>void history.load(true).catch(()=>{})}>更多工作</Button>}
 </div>;
}
export function useCapsulePeople(runtime:CapsuleAuthorRuntime,subjectId:string,related:(string|null|undefined)[]):CapsulePeople{
 const {lease}=useChoiceViewLease(runtime,subjectId),[view,setView]=useState<{lease:CapsuleAuthorLease|null;contacts:string[];error:string}>({lease:null,contacts:[],error:''});
 const contacts=view.lease===lease?view.contacts:[],error=view.lease===lease?view.error:'';
 useEffect(()=>{if(!lease)return;let live=true;void(async()=>{const found:string[]=[],seen=new Set<string>();let after:string|undefined;do{lease.assertCurrent();const value:{items:{state:string;initiatorId:string;recipientId:string}[];nextAfter?:string}=await runtime.api.call('/v2/contacts/query',{direction:'both',limit:50,...(after?{after}:{})});lease.assertCurrent();if(!live)return;found.push(...value.items.filter(item=>item.state==='accepted').map(item=>item.initiatorId===subjectId?item.recipientId:item.initiatorId));after=value.nextAfter;if(after&&seen.has(after))throw Error('联系人列表暂时无法继续读取。');if(after)seen.add(after);}while(after);setView({lease,contacts:[...new Set(found)],error:''});})().catch(()=>{if(live)setView({lease,contacts:[],error:'联系人暂未读到，仍可选择这件工作中的人员。'});});return()=>{live=false;};},[lease,subjectId,runtime]);
 const ids=[...new Set([...related,...contacts])].filter((id):id is string=>typeof id==='string'&&id!==subjectId&&/^GUID[0-9A-Z]{28}$/.test(id)),names=useMemberNames(runtime,subjectId,true,[...ids,subjectId]);
 return{ids,names,error};
}
export function PeopleSelection({people,value,onChange,title,empty='当前没有其他可选人员。',subjectId}:{people:CapsulePeople;value:string[];onChange:(value:string[])=>void;title:string;empty?:string;subjectId:string}){
 return <fieldset className="method-people-select"><legend>{title}</legend>{people.error&&<p className="source-reading-note">{people.error}</p>}{!people.ids.length&&<p>{empty}</p>}<div>{people.ids.map((id:string)=><label key={id}><input type="checkbox" checked={value.includes(id)} onChange={event=>onChange(event.target.checked?[...value,id]:value.filter((other:string)=>other!==id))}/><MemberAvatar subjectId={id}/><span>{memberName(id,subjectId,people.names[id]??undefined)}</span></label>)}</div></fieldset>;
}
export const workPeople=(source:CapsuleCaseHistory|null|undefined)=>[source?.requesterId,...readableCaseSources(source).map(item=>item.authorId),...(source?.collaborations??[]).flatMap(item=>[item.requesterId,...(item.participation??[]).map(person=>person.subjectId)])].filter((id):id is string=>typeof id==='string'&&!!id);
export function useRegisteredCapsuleDraft<T>(draft:CapsuleInputDraft<T>,key:string,client:Pick<CapsuleAuthorClient,'receiptFor'>,registerDraft:CapsuleRegisterDraft|undefined){
 const draftRef=useRef(draft);useLayoutEffect(()=>{draftRef.current=draft;},[draft]);
 useEffect(()=>{if(!registerDraft)return;return registerDraft(key,async receipt=>draftRef.current.settle(async locator=>locator.operationId===(receipt.operationId??receipt.eventId)?client.receiptFor(locator):null));},[key,client,registerDraft]);
 useEffect(()=>{if(draft.ready&&draft.attempt)void draftRef.current.settle(client.receiptFor).catch(()=>{});},[draft.ready,draft.attempt,client,key]);
 return draftRef;
}
