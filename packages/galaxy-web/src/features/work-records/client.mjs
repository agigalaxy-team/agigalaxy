import {createFactSubmissions} from './fact-submissions.mjs';
import {caseEventV2Schema,caseTaskLinkSchema} from "../../../../galaxy-contracts/src/cases-schema.mjs";
import {verificationEventSchema,verificationOperationReceiptResultSchema} from "../../../../galaxy-contracts/src/verification-record-schema.mjs";
import {equalJson,sha256Hex,stableJson} from "../../../../galaxy-contracts/src/web-primitives.mjs";

const instances=new WeakMap(),copy=value=>structuredClone(value);
const uuid=value=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value??'');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const changed=()=>fail('fact_authority_changed','身份或连接已改变，原操作已保留，请先核对原回执。');
const invalid=()=>fail('fact_operation_invalid','原事实操作、字节或回执不匹配，请保留原记录。');
/** @typedef {{confirmed?:boolean,viewers?:string[],caseSummary?:string,synthetic?:boolean,composeRevision?:string}} FactWriteOptions */
/** @param {{id:string;version:number}} record */
export const exactFactRef=record=>({id:record.id,version:record.version});
/** @template {{id:string}} T @param {T[]} items @returns {T[]} */
export function latestFacts(items=[]){return [...new Map(items.map(item=>[item.id,item])).values()];}

export function getFactClient(runtime,subjectId,{now=()=>Math.floor(Date.now()/1000)}={}){
 let owners=instances.get(runtime);if(!owners){owners=new Map();instances.set(runtime,owners);}
 if(owners.has(subjectId))return owners.get(subjectId);
 const endpoint=runtime.api.endpoint,key=id=>'task-fact-pending:'+subjectId+':'+id,
  archiveKey=id=>'task-fact-receipts:'+subjectId+':'+id,composeKey=id=>'task-fact-compose:'+subjectId+':'+id;
 let queue=Promise.resolve(),closed=false;const previews=new Map();
 const tag=()=>{const s=runtime.api.snapshot();return JSON.stringify([runtime.api.endpoint,s?.subjectId??null,s?.endpoint??null,
  s?.bindingId??null,s?.generation??null,s?.control?.deviceId??null,s?.control?.keyId??null,s?.control?.epoch??null]);};
 const capture=()=>{
  if(closed||runtime.api.endpoint!==endpoint)changed();
  const binding=runtime.api.snapshot();let original;
  try{original=runtime.receiptStatus?.captureLease?.();}catch{changed();}
  if(original&&(original.subjectId!==subjectId||original.endpoint!==endpoint||typeof original.assertCurrent!=='function')
   ||binding?.subjectId&&binding.subjectId!==subjectId||!binding&&!original)changed();
  const selected=tag();
  const check=()=>{try{original?.assertCurrent();}catch{changed();}if(closed||tag()!==selected)changed();};
  check();return{check,tag:selected,bindingId:binding?.bindingId??null};
 };
 const wait=async(lease,fn)=>{lease.check();let value;try{value=await fn();}catch(error){lease.check();throw error;}lease.check();return value;};
 // The selected connection is captured synchronously, before queue execution.
 const serial=fn=>{const lease=capture(),run=()=>wait(lease,()=>fn(lease)),next=queue.then(run,run);queue=next.catch(()=>{});return next;};
 const get=(lease,id)=>wait(lease,()=>runtime.getLocal(key(id),subjectId));
 const update=(lease,name,fn)=>wait(lease,async()=>{
  if(typeof runtime.updateLocal==='function')return runtime.updateLocal(name,current=>{lease.check();return fn(current);},subjectId);
  // Legacy single-client contract doubles expose only get/put. WebRuntime
  // always exposes updateLocal and fails closed if its store has no atomic API.
  const current=await wait(lease,()=>runtime.getLocal(name,subjectId)),next=fn(current);
  await wait(lease,()=>runtime.putLocal(name,next,subjectId));return next;
 });
 const sameOperation=(left,right)=>left&&right&&['operationId','payloadHash','kind','taskId','caseId'].every(k=>left[k]===right[k]);
 const put=(lease,id,value)=>update(lease,key(id),current=>{
  if(!sameOperation(current,value))fail('fact_pending_changed','本机原操作已变化，请保留当前记录并核对原回执。');
  return copy(value);
 });
 const claim=(lease,id,value)=>update(lease,key(id),current=>{
  if(current)fail('fact_pending','请先核对这项任务上一次事实操作。');return copy(value);
 });
 const clear=(lease,record)=>update(lease,key(record.taskId),current=>sameOperation(current,record)?null:current??null);
 const checkedDraft=current=>{
  if(current==null)return null;
  if(current.version!==1||!uuid(current.revision)||current.operationId!=null&&!uuid(current.operationId)
   ||current.value===null||typeof current.value!=='object'||Array.isArray(current.value))fail('fact_compose_draft_invalid','本机编写稿格式不可读取，请保留原记录。');
  return current;
 };
 const getDraft=(lease,id)=>wait(lease,async()=>checkedDraft(await runtime.getLocal(composeKey(id),subjectId)));
 const acceptedDraft=(current,record)=>current?.operationId===record.operationId&&(!record.composeRevision||current.revision===record.composeRevision)?null:current??null;
 const settleDraft=(lease,record)=>record.composeRevision?update(lease,composeKey(record.taskId),current=>acceptedDraft(current,record)):Promise.resolve();
 /** @param {string} taskId @param {any} input @param {{expectedRevision?:string|null}} options */
 const saveComposeDraft=(taskId,input,{expectedRevision}={})=>{
  const value=copy(input);
  if(!uuid(taskId)||!value||typeof value!=='object'||Array.isArray(value)
   ||typeof value.kind!=='string'||!value.kind
   ||['prepared','submission','authorization','payloadJson','signedIntent','proofJson','signature','confirmed'].some(key=>Object.hasOwn(value,key)))
   fail('fact_compose_draft_invalid','草稿只保存本机编写内容。');
  return serial(lease=>update(lease,composeKey(taskId),current=>{const prior=checkedDraft(current);
   if(expectedRevision!==undefined&&(prior?.revision??null)!==expectedRevision&&!(prior&&equalJson(prior.value,value)))
    fail('fact_compose_draft_changed','另一页面已修改本机编写稿，本页内容仍保留，请重新读取原稿。');
   return prior&&equalJson(prior.value,value)?prior:{version:1,revision:crypto.randomUUID(),value,operationId:null};
  }));
 };
 const readComposeDraft=taskId=>serial(async lease=>{
  const draft=await getDraft(lease,taskId);if(!draft)return null;
  const original=await get(lease,taskId),operationId=draft.operationId??(original?.composeRevision===draft.revision?original.operationId:null);
  const historical=operationId?(await archives(lease,taskId)).find(row=>row.operationId===operationId):null;
  if(historical?.state==='acknowledged'){
   const retained=await update(lease,composeKey(taskId),current=>current?.revision===draft.revision&&current.operationId===operationId?null:current??null);
   return retained?{value:copy(retained.value),revision:retained.revision,operationId:retained.operationId??null,
    submission:retained.operationId?'result-unknown':'draft'}:null;
  }
  return{value:copy(draft.value),revision:draft.revision,operationId,
   submission:operationId?historical?.localRetryStopped?'stopped-local':'result-unknown':'draft'};
 });
 /** @param {string} taskId @param {{revision?:string}} options */
 const clearComposeDraft=(taskId,{revision}={})=>serial(lease=>update(lease,composeKey(taskId),current=>revision&&current?.revision!==revision?current??null:null));
 const checkedArchives=(rows,id)=>{
  if(rows&&!Array.isArray(rows))invalid();
  const keys=new Set(['kind','taskId','caseId','operationId','payloadHash','state','currentAccessGranted','subjectId','endpoint',
   'receipt','queries','localRetryStopped','serverCancellationConfirmed','receiptState']);
  for(const r of rows??[]){if(!r||Object.keys(r).some(k=>!keys.has(k))||r.subjectId!==subjectId||r.endpoint!==endpoint
    ||r.taskId!==id||!uuid(r.operationId)||!uuid(r.caseId)||!['case-link','fact','verification'].includes(r.kind)
    ||!['acknowledged','stopped-local'].includes(r.state)||!/^[a-f0-9]{64}$/.test(r.payloadHash??'')||r.currentAccessGranted!==false)invalid();
   checkedQueries(r);
   if(r.state==='acknowledged'&&r.receipt?.state!=='acknowledged')invalid();
   if(r.receipt){
    const query=r.queries.find(q=>q.input.payloadHash===r.receipt.payloadHash);if(!query)invalid();
    checkedReceipt(r,query,r.receipt);
   }
  }
  return rows??[];
 };
 const archives=async(lease,id)=>checkedArchives(await wait(lease,()=>runtime.getLocal(archiveKey(id),subjectId)),id);
 const editArchives=(lease,id,fn)=>update(lease,archiveKey(id),current=>checkedArchives(fn(checkedArchives(current,id)),id).slice(-64));
 const appendArchive=(rows,entry)=>{
  const prior=rows.find(r=>r.operationId===entry.operationId);
  if(prior&&!sameOperation(prior,entry))invalid();
  if(prior?.state==='acknowledged'&&entry.state!=='acknowledged')return rows;
  return [...rows.filter(r=>r.operationId!==entry.operationId),entry];
 };
 const summary=record=>({kind:record.kind,taskId:record.taskId,caseId:record.caseId,operationId:record.operationId,
  payloadHash:record.payloadHash,state:record.state??'prepared',currentAccessGranted:false,
  ...(record.localRetryStopped?{localRetryStopped:true,serverCancellationConfirmed:false,receiptState:record.receiptState}:{})});
 const result=(record,receipt)=>({...summary(record),state:receipt.state,authority:'accepted-operation-only',
  payloadHash:receipt.payloadHash,...(record.localRetryStopped?{receiptState:receipt.state}:{}),receipt:copy(receipt)});
 const locator=(record,receipt)=>({...summary(record),subjectId,endpoint,state:'acknowledged',
  receipt:copy(receipt),queries:copy(record.queries)});
 async function originalRecord(lease,record){
  if(!record||!uuid(record.operationId)||!uuid(record.caseId)||!uuid(record.taskId)
   ||record.subjectId&&record.subjectId!==subjectId||record.endpoint&&record.endpoint!==endpoint
   ||!['case-link','fact','verification'].includes(record.kind)||!Array.isArray(record.items)
   ||record.items.length!==(record.kind==='case-link'?2:1)||!Array.isArray(record.viewers))invalid();
  const expectedPath=record.kind==='case-link'?'/v2/tasks/'+record.taskId+'/case':record.kind==='fact'?'/v2/cases/events':'/v2/verification-records/submit';
  if(record.path!==expectedPath)invalid();
  for(const item of record.items){
   const raw=item.payloadJson??item.submission?.payloadJson??item.authorization?.payloadJson??JSON.stringify(item.payload);
   if(typeof raw!=='string'||item.submission&&item.submission.payloadJson!==raw
    ||item.authorization&&item.authorization.payloadJson!==raw)invalid();
   const schema=record.kind==='verification'?verificationEventSchema:caseEventV2Schema;
   let payload;try{payload=schema.parse(JSON.parse(raw));}catch{invalid();}
   if(!equalJson(payload,item.payload)||payload.caseId!==record.caseId||payload.taskId!==record.taskId
    ||(payload.actorId??payload.reportedBy)!==subjectId
    ||item.action!==(record.kind==='verification'?'evidence.submit':'case.teaser.publish'))invalid();
   const hash=await wait(lease,()=>sha256Hex(raw));
   if(item.payloadHash&&item.payloadHash!==hash||item.authorization?.intent?.payloadHash&&item.authorization.intent.payloadHash!==hash)invalid();
   if(item.authorization?.intent){
    const intent=item.authorization.intent;
    if(intent.subjectId!==subjectId||intent.endpoint!==endpoint||intent.action!==item.action
     ||intent.objectId!==(payload.eventId??payload.operationId)||intent.visibility!=='Private'
     ||!equalJson(intent.viewers,record.viewers))invalid();
   }
   item.payloadJson=raw;item.payloadHash=hash;
  }
  if(record.kind==='case-link'){
   const root=record.items[0].payload,initial=record.items[1].payload;
   if(root.kind!=='case-created'||root.eventId!==record.caseId||!['intervention','attempt-start'].includes(initial.kind)
    ||!Number.isSafeInteger(record.expectedTaskVersion)||record.expectedTaskVersion<1)invalid();
   const intent={operationId:record.operationId,taskId:record.taskId,expectedTaskVersion:record.expectedTaskVersion,
    case:{payloadJson:record.items[0].payloadJson},initialFact:{payloadJson:record.items[1].payloadJson}};
   const hash=await wait(lease,()=>sha256Hex(stableJson(intent)));
   if(record.payloadHash&&record.payloadHash!==hash)invalid();record.payloadHash=hash;
   record.queries=[{path:'/v2/tasks/'+record.taskId+'/case-link/receipt',input:{taskId:record.taskId,operationId:record.operationId,payloadHash:hash}}];
   if(record.items.every(i=>i.submission)){
    const command=caseTaskLinkSchema.parse({...intent,case:record.items[0].submission,initialFact:record.items[1].submission});
    const oldHash=await wait(lease,()=>sha256Hex(JSON.stringify(command)));
    if(oldHash!==hash)record.queries.push({path:record.queries[0].path,input:{...record.queries[0].input,payloadHash:oldHash}});
   }
  }else{
   const item=record.items[0],payload=item.payload;
   if(record.operationId!==(payload.eventId??payload.operationId))invalid();
   if(record.payloadHash&&record.payloadHash!==item.payloadHash)invalid();record.payloadHash=item.payloadHash;
   record.queries=[record.kind==='fact'?{path:'/v2/cases/events/receipt',input:{caseId:record.caseId,eventId:record.operationId,payloadHash:record.payloadHash}}:
    {path:'/v2/verification-records/receipt',input:{type:payload.kind==='revoke'?payload.objectType:payload.kind,id:payload.id,
     operationId:record.operationId,payloadHash:record.payloadHash}}];
  }
  record.subjectId=subjectId;record.endpoint=endpoint;return record;
 }
 function checkedQuery(record,query){
  const input=query?.input,expected=record.kind==='case-link'?'/v2/tasks/'+record.taskId+'/case-link/receipt':
   record.kind==='fact'?'/v2/cases/events/receipt':'/v2/verification-records/receipt';
  const keys=record.kind==='case-link'?['operationId','payloadHash','taskId']:
   record.kind==='fact'?['caseId','eventId','payloadHash']:['id','operationId','payloadHash','type'];
  if(!query||Object.keys(query).sort().join(',')!=='input,path'||query.path!==expected||!input
   ||Object.keys(input).sort().join(',')!==keys.sort().join(',')||!/^[a-f0-9]{64}$/.test(input.payloadHash??'')
   ||record.kind!=='case-link'&&input.payloadHash!==record.payloadHash
   ||record.kind==='case-link'&&(input.taskId!==record.taskId||input.operationId!==record.operationId)
   ||record.kind==='fact'&&(input.caseId!==record.caseId||input.eventId!==record.operationId)
   ||record.kind==='verification'&&(!uuid(input.id)||!['evidence','verification'].includes(input.type)||input.operationId!==record.operationId))invalid();
 }
 function checkedQueries(record){
  if(!Array.isArray(record.queries)||!record.queries.length||record.queries.length>(record.kind==='case-link'?2:1)
   ||record.queries[0]?.input?.payloadHash!==record.payloadHash)invalid();
  const hashes=new Set();
  for(const query of record.queries){checkedQuery(record,query);if(hashes.has(query.input.payloadHash))invalid();hashes.add(query.input.payloadHash);}
 }
 function checkedReceipt(record,query,value){
  checkedQuery(record,query);
  if(record.kind==='verification'){
   const parsed=verificationOperationReceiptResultSchema.safeParse(value);if(!parsed.success)invalid();const v=parsed.data;
   if(Object.keys(query.input).some(k=>v[k]!==query.input[k]))invalid();
   if(v.state==='acknowledged'&&record.items&&v.receipt.version!==record.items[0].payload.expectedVersion+1)invalid();
   return v;
  }
  const ack=record.kind==='case-link'?['caseId','caseVersion','taskVersion','taskCaseLinkVersion']:['caseVersion','verification','acceptance','resolution'];
  const keys=new Set([...Object.keys(query.input),'state','checkedAt','authority','currentAccessGranted',...(value?.state==='acknowledged'?ack:[])]);
  if(!value||Object.keys(value).some(k=>!keys.has(k))||Object.keys(query.input).some(k=>value[k]!==query.input[k])
   ||!['acknowledged','absent','conflict'].includes(value.state)||value.authority!=='accepted-operation-only'
   ||value.currentAccessGranted!==false||typeof value.checkedAt!=='string'||!Number.isFinite(Date.parse(value.checkedAt)))invalid();
  if(value.state==='acknowledged'){
   if(!Number.isSafeInteger(value.caseVersion)||value.caseVersion<1)invalid();
   if(record.kind==='case-link'){
    if(value.caseId!==record.caseId||!Number.isSafeInteger(value.taskVersion)||value.taskVersion<1||value.taskCaseLinkVersion!==1
      ||record.items&&value.taskVersion!==record.expectedTaskVersion)invalid();
   }else if(value.verification!=='not-provided'||value.acceptance!=='not-provided'||value.resolution!=='separate'
    ||record.items&&value.caseVersion!==record.items[0].payload.expectedVersion+1)invalid();
  }
  return value;
 }
 async function queryOriginal(lease,record){
  checkedQueries(record);
  let receipt;
  for(const query of record.queries){
   const input=query.input;
   const wire=record.kind==='case-link'?{operationId:input.operationId,payloadHash:input.payloadHash}:input;
   receipt=checkedReceipt(record,query,await wait(lease,()=>runtime.api.call(query.path,wire)));
   if(receipt.state!=='conflict')return receipt;
  }
  return receipt;
 }
 async function remember(lease,record,receipt){
  await editArchives(lease,record.taskId,rows=>appendArchive(rows,locator(record,receipt)));
  await settleDraft(lease,record);
  await clear(lease,record);
  for(const [id,p] of previews)if(p.operationId===record.operationId)previews.delete(id);
  return result(record,receipt);
 }
 // A known late ACK is metadata only and can only enter the original owner key.
 // It never clears a replacement pending operation or returns an old body.
 async function rememberLate(record,receipt){
  const merge=current=>checkedArchives(appendArchive(checkedArchives(current,record.taskId),locator(record,receipt)),record.taskId).slice(-64);
  if(typeof runtime.updateLocal==='function')await runtime.updateLocal(archiveKey(record.taskId),merge,subjectId);
  else await runtime.putLocal(archiveKey(record.taskId),merge(await runtime.getLocal(archiveKey(record.taskId),subjectId)),subjectId);
  if(record.composeRevision){const settle=current=>acceptedDraft(current,record);
   if(typeof runtime.updateLocal==='function')await runtime.updateLocal(composeKey(record.taskId),settle,subjectId);
   else await runtime.putLocal(composeKey(record.taskId),settle(await runtime.getLocal(composeKey(record.taskId),subjectId)),subjectId);
  }
 }
 const readCase=async task=>{const lease=capture();if(!task.caseId)return null;return wait(lease,()=>runtime.api.call('/v2/cases/'+task.caseId+'/read',{taskId:task.taskId}));};
 const readRecord=async ref=>{const lease=capture();return wait(lease,()=>runtime.api.call('/v2/verification-records/read',copy(ref)));};
 // History already discovers these records under their current permissions.
 // Use only exact Case locators here; each body must still be read afresh by
 // readRecord, including after another device corrected or withdrew a source.
 async function discoverRecordRefs(task){
  const lease=capture();if(!task.caseId)return{refs:[]};
  if(!uuid(task.caseId))fail('fact_operation_invalid','当前工作关联不可用。');
  for(let attempt=0;attempt<2;attempt++){
   const refs=new Map(),cursors=new Set();let after=null;
   try{
    for(;;){
     const page=await wait(lease,()=>runtime.api.call('/v2/history/query',{subjectId,
      query:task.caseId,timeWindow:{kind:'all-visible'},limit:50,after}));
     if(!Array.isArray(page.items))fail('fact_operation_invalid','当前来源定位不可用。');
     for(const item of page.items){if(item.kind!=='case-history'||item.caseId!==task.caseId)continue;
      for(const ref of item.verificationRecords??[]){
       if(['evidence','verification'].includes(ref.type)&&uuid(ref.id))refs.set(ref.type+':'+ref.id,{type:ref.type,id:ref.id});
      }
     }
     if(page.nextCursor==null)return{refs:[...refs.values()]};
     if(typeof page.nextCursor!=='string'||!page.nextCursor||cursors.has(page.nextCursor))
      fail('fact_operation_invalid','当前来源分页已变化，请重新读取。');
     cursors.add(page.nextCursor);after=page.nextCursor;
    }
   }catch(error){lease.check();if(error.code!=='history_sources_changed_retry'||attempt>0)throw error;}
  }
  return{refs:[]};
 }
 function businessReceipt(record,response){
  const p=record.items.at(-1).payload,query=record.queries[0].input;
  if(record.kind==='verification'){
   if(response?.id!==p.id||response.operationId!==record.operationId||response.version!==p.expectedVersion+1)invalid();
   return{...query,state:'acknowledged',authority:'accepted-operation-only',audience:'owner-only',
    currentAccessGranted:false,contentReturned:false,sourceAccessChecked:false,
    receipt:{...query,version:response.version,acceptedAt:new Date().toISOString()}};
  }
  if(record.kind==='case-link'){
   if(response?.caseId!==record.caseId||response.taskId!==record.taskId||response.operationId!==record.operationId
    ||response.initialFact?.id!==p.eventId||response.payloadHash!==record.payloadHash)invalid();
   return{...query,state:'acknowledged',checkedAt:new Date().toISOString(),authority:'accepted-operation-only',currentAccessGranted:false,
    caseId:record.caseId,caseVersion:response.caseVersion,taskVersion:response.taskVersion,taskCaseLinkVersion:response.taskCaseLinkVersion};
  }
  if(response?.caseId!==record.caseId||response.eventId!==record.operationId||response.caseVersion!==p.expectedVersion+1)invalid();
  return{...query,state:'acknowledged',checkedAt:new Date().toISOString(),authority:'accepted-operation-only',currentAccessGranted:false,
   caseVersion:response.caseVersion,verification:'not-provided',acceptance:'not-provided',resolution:'separate'};
 }
 async function send(lease,record){
  try{
   await originalRecord(lease,record);
   for(const item of record.items)if(!item.submission){
    if(!item.authorization){
     item.authorization=await wait(lease,()=>runtime.api.prepareAuthorization(item.payloadJson,{action:item.action,
      objectId:item.payload.eventId??item.payload.operationId,visibility:'Private',viewers:record.viewers,
      ...(record.authorizationExpiresAt?{expiresAt:record.authorizationExpiresAt}:{}),confirmed:true}));
     await put(lease,record.taskId,record);
    }
    const reconcile=item.authorizationAttempted===true;item.authorizationAttempted=true;await put(lease,record.taskId,record);
    item.submission=await wait(lease,()=>runtime.api.submitAuthorization(item.authorization,{confirmed:true,reconcile}));
    if(item.submission.payloadJson!==item.payloadJson)invalid();await put(lease,record.taskId,record);
   }
   record.attempts=(record.attempts??0)+1;record.state='result-unknown';await put(lease,record.taskId,record);
   const body=record.kind==='case-link'?{operationId:record.operationId,taskId:record.taskId,expectedTaskVersion:record.expectedTaskVersion,
    case:record.items[0].submission,initialFact:record.items[1].submission}:record.items[0].submission;
   lease.check();const response=await runtime.api.call(record.path,body),receipt=businessReceipt(record,response);
   checkedReceipt(record,record.queries[0],receipt);
   try{lease.check();}catch(error){await rememberLate(record,receipt);throw error;}
   await remember(lease,record,receipt);return response;
  }catch(error){
   // Neither a late authority change nor a rejected old authorization may erase
   // the original uncertain operation. Only an exact receipt settles it.
   throw Object.assign(error,{resultUnknown:true,operationId:record.operationId});
  }
 }
 async function write(task,record,{confirmed=false,viewers=[],composeRevision}= /** @type {FactWriteOptions} */ ({})){
  const selected=copy(record),taskId=task.taskId,audience=copy(viewers);
  return serial(async lease=>{
   if(!confirmed)fail('fact_confirmation_required','请确认记录这次实际工作。');
   if(!lease.bindingId&&runtime.receiptStatus)fail('connection_required','请先连接当前设备。');
   if(await get(lease,taskId))fail('fact_pending','请先核对这项任务上一次事实操作。');
   if((await archives(lease,taskId)).some(r=>r.state==='stopped-local'&&!['acknowledged','absent'].includes(r.receiptState)))
    fail('fact_pending','已停止本机重试的原操作仍未知，请先核对回执。');
   Object.assign(selected,{taskId,viewers:[...new Set(audience.filter(id=>id!==subjectId))],state:'prepared',authorizationExpiresAt:now()+2591900,authorizationBindingId:lease.bindingId});
   const draft=composeRevision?await getDraft(lease,taskId):null;
   if(composeRevision&&(!uuid(composeRevision)||!draft||draft.revision!==composeRevision||draft.value.kind!==selected.items.at(-1).payload.kind))
    fail('fact_compose_draft_changed','本机编写稿已变化，请重新读取这次要提交的内容。');
   if(draft)selected.composeRevision=draft.revision;
   await originalRecord(lease,selected);await claim(lease,taskId,selected);
   if(draft)await update(lease,composeKey(taskId),current=>current?.revision===draft.revision?{...current,operationId:selected.operationId}:current??null);
   return send(lease,selected);
  });
 }
  const {submitFact,submitRecord}=createFactSubmissions({subjectId,write});
  async function reconcileWithin(lease,taskId,{retry=false,confirmed=false,operationId,automatic=false}={}){
   let record=await get(lease,taskId);
   if(record&&operationId&&record.operationId!==operationId)record=null;
   if(record)await originalRecord(lease,record);
   else{
    const prior=(await archives(lease,taskId)).filter(r=>!operationId||r.operationId===operationId).at(-1);
    if(!prior)return{state:'none'};
    if(prior.state==='acknowledged'){
     const query=prior.queries?.find(q=>q.input?.payloadHash===prior.receipt?.payloadHash);if(!query)invalid();
     return result(prior,checkedReceipt(prior,query,prior.receipt));
    }
    record=prior;
   }
   let receipt;
   try{receipt=await queryOriginal(lease,record);}catch(error){
    lease.check();if(error.code==='fact_operation_invalid')throw error;
    return{...summary(record),state:'result-unknown',authority:'accepted-operation-only',currentAccessGranted:false};
   }
   if(receipt.state==='acknowledged')return remember(lease,record,receipt);
   if(record.localRetryStopped){
    const rows=await editArchives(lease,taskId,current=>current.map(r=>r.operationId===record.operationId&&r.state!=='acknowledged'
     ?{...r,receiptState:receipt.state,receipt:copy(receipt)}:r));
    const accepted=rows.find(r=>r.operationId===record.operationId&&r.state==='acknowledged');
    if(accepted)return result(accepted,accepted.receipt);
    if(retry&&!automatic)fail('fact_retry_stopped','本机重试已停止；只查询原回执。');
    return result(record,receipt);
   }
   if(!retry||receipt.state==='conflict')return result(record,receipt);
   if(!confirmed)fail('fact_confirmation_required','请确认重试准确原载荷。');
   if(automatic){
    const savedDeadlines=record.items.map(item=>item.authorization?.intent?.expiresAt).filter(value=>value!=null),
     expiresAt=record.authorizationExpiresAt??(savedDeadlines.length===record.items.length&&new Set(savedDeadlines).size===1?savedDeadlines[0]:null);
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=now())return{...result(record,receipt),reason:'authorization-expired'};
    if(record.localRetryStopped)return{...result(record,receipt),reason:'stopped-local'};
    record.authorizationExpiresAt=expiresAt;
    for(const item of record.items){
     if(item.authorization){const a=item.authorization,i=a.intent;
      if(a.payloadJson!==item.payloadJson||!i||i.subjectId!==subjectId||i.endpoint!==endpoint||i.recipient!==endpoint
       ||i.action!==item.action||i.objectId!==(item.payload.eventId??item.payload.operationId)||i.payloadHash!==item.payloadHash
       ||i.purpose!=='operational'||i.visibility!=='Private'||!equalJson(i.viewers,record.viewers)
       ||!equalJson(i.fields,Object.keys(item.payload))||i.expiresAt!==expiresAt)invalid();
      if(item.submission){if(item.submission.consentId!==i.id||item.submission.payloadJson!==item.payloadJson)invalid();continue;}
      const accepted=await wait(lease,()=>runtime.api.reconcileAuthorization(a));
      if(accepted.state==='acknowledged')item.submission={consentId:accepted.consentId,payloadJson:accepted.payloadJson};
      else if(accepted.state!=='absent')invalid();
      else if(i.bindingId!==lease.bindingId){
       await put(lease,taskId,record);return{...result(record,receipt),reason:'original-binding-changed'};
      }else if(i.issuedAt<now()-300){
       // The original choice is still valid in its original binding. Only the
       // transport signature is stale; keep its exact scope and deadline.
       const replacement=await wait(lease,()=>runtime.api.prepareAuthorization(item.payloadJson,{action:item.action,
        objectId:i.objectId,visibility:i.visibility,viewers:record.viewers,expiresAt,confirmed:true}));
       item.authorizationHistory=[...(item.authorizationHistory??[]),{authorization:a,submission:null,reason:'same-binding-signature-renewal'}];
       item.authorization=replacement;item.authorizationAttempted=false;record.authorizationBindingId=i.bindingId;
      }
     }else{
      if(item.submission)invalid();
      // Confirmed new journals retain the binding of the original choice.
      // Legacy unsigned rows without that evidence need their existing review.
      if(!record.authorizationBindingId||record.authorizationBindingId!==lease.bindingId){
       await put(lease,taskId,record);return{...result(record,receipt),reason:record.authorizationBindingId?'original-binding-changed':'original-binding-unavailable'};
      }
     }
    }
    await put(lease,taskId,record);return send(lease,record);
   }
   // Compatibility: a missing ACK for the original, still-current Consent can
   // reconcile its receipt. Rebinding/expiry/revocation never auto-renews it.
   if(record.items.some(i=>!i.authorization||i.authorization.intent?.bindingId!==runtime.api.snapshot()?.bindingId
     ||i.authorization.intent?.expiresAt<=Math.floor(Date.now()/1000)))
    fail('fact_reauthorization_review_required','请预览原准确载荷并明确确认新的当前授权。');
   return send(lease,record);
  }
  const reconcile=async(taskId,options={})=>serial(lease=>reconcileWithin(lease,taskId,copy(options)));
  const resumePending=taskId=>serial(lease=>reconcileWithin(lease,taskId,{retry:true,confirmed:true,automatic:true}));
  const pending=async taskId=>serial(async lease=>{
   const record=await get(lease,taskId);
   if(record){await originalRecord(lease,record);return summary(record);}
   const stopped=(await archives(lease,taskId)).filter(r=>r.state==='stopped-local'&&!['acknowledged','absent'].includes(r.receiptState)).at(-1);
   return stopped?summary(stopped):null;
  });
  async function prepareRetry(taskId){
   return serial(async lease=>{
    const record=await get(lease,taskId);if(!record)fail('fact_retry_unavailable','没有待继续的原载荷。');
    await originalRecord(lease,record);
    const receipt=await queryOriginal(lease,record);
    if(receipt.state==='acknowledged')return remember(lease,record,receipt);
    if(receipt.state!=='absent')return result(record,receipt);
    const now=Math.floor(Date.now()/1000);
    for(const [id,p] of previews)if(p.expiresAt<=now)previews.delete(id);
    if(previews.size>=32)fail('fact_retry_preview_limit','待确认预览过多，请稍后重新打开。');
    const preview={...summary(record),state:'absent',previewId:crypto.randomUUID(),expiresAt:now+300,
     subjectId,endpoint,authorization:{bindingId:runtime.api.snapshot()?.bindingId??null,generation:runtime.api.snapshot()?.generation??null,
      deviceId:runtime.api.snapshot()?.control?.deviceId??null,keyId:runtime.api.snapshot()?.control?.keyId??null,epoch:runtime.api.snapshot()?.control?.epoch??null},
     visibility:'Private',viewers:copy(record.viewers),
     items:record.items.map(i=>({action:i.action,objectId:i.payload.eventId??i.payload.operationId,payloadJson:i.payloadJson,payloadHash:i.payloadHash}))};
    const saved={preview:copy(preview),operationId:record.operationId,lease,expiresAt:preview.expiresAt};
    previews.set(preview.previewId,saved);return preview;
   });
  }
  async function confirmRetry(preview,{confirmed=false}={}){
   const selected=copy(preview);
   return serial(async lease=>{
    if(!confirmed)fail('fact_confirmation_required','请明确确认这份准确原载荷和当前私有授权。');
    const saved=previews.get(selected?.previewId);
    if(!saved||saved.expiresAt<=Math.floor(Date.now()/1000)||!equalJson(selected,saved.preview))fail('fact_retry_preview_changed','原授权预览已变化，请重新预览。');
    saved.lease.check();if(saved.lease.tag!==lease.tag)changed();
    const record=await get(lease,selected.taskId);
    if(!record){
     const terminal=(await archives(lease,selected.taskId)).find(r=>r.operationId===selected.operationId&&r.state==='acknowledged');
     if(terminal)return result(terminal,terminal.receipt);
     fail('fact_retry_unavailable','原操作已停止或变化，请核对回执。');
    }
    await originalRecord(lease,record);
    if(record.operationId!==selected.operationId||record.payloadHash!==selected.payloadHash
     ||!equalJson(record.viewers,selected.viewers)||!equalJson(record.items.map(i=>({action:i.action,objectId:i.payload.eventId??i.payload.operationId,
      payloadJson:i.payloadJson,payloadHash:i.payloadHash})),selected.items))invalid();
    const receipt=await queryOriginal(lease,record);
    if(receipt.state==='acknowledged')return remember(lease,record,receipt);
    if(receipt.state!=='absent')return result(record,receipt);
    // This is the user's fresh precise review of the same business intent.
    // Business bytes, operation IDs, audiences and versions remain unchanged.
    for(const item of record.items){if(item.authorization)item.authorizationHistory=[...(item.authorizationHistory??[]),
     {authorization:item.authorization,submission:item.submission??null,reason:'business-receipt-absent-user-confirmed'}];
     delete item.submission;delete item.authorization;delete item.authorizationAttempted;}
    record.authorizationExpiresAt=now()+2591900;record.authorizationBindingId=lease.bindingId;
    await put(lease,record.taskId,record);previews.delete(selected.previewId);return send(lease,record);
   });
  }
  async function stopRetry(taskId,{confirmed=false}={}){
   return serial(async lease=>{
    if(!confirmed)fail('fact_confirmation_required','请确认只停止本机重试，云端事实不会被取消。');
    const record=await get(lease,taskId);if(!record)return{state:'none'};
    await originalRecord(lease,record);let receipt;
    try{receipt=await queryOriginal(lease,record);}catch(error){lease.check();if(error.code==='fact_operation_invalid')throw error;}
    if(receipt?.state==='acknowledged')return remember(lease,record,receipt);
    const stopped={...summary(record),subjectId,endpoint,state:'stopped-local',localRetryStopped:true,
     serverCancellationConfirmed:false,receiptState:receipt?.state??'result-unknown',queries:copy(record.queries)};
    const rows=await editArchives(lease,taskId,current=>appendArchive(current,stopped));
    await clear(lease,record);for(const [id,p] of previews)if(p.operationId===record.operationId)previews.delete(id);
    const accepted=rows.find(r=>r.operationId===record.operationId&&r.state==='acknowledged');
    return accepted?result(accepted,accepted.receipt):summary(stopped);
   });
  }
  const client={submitFact,submitRecord,readCase,readRecord,discoverRecordRefs,reconcile,resumePending,pending,prepareRetry,confirmRetry,stopRetry,
   readComposeDraft,saveComposeDraft,clearComposeDraft,
   close(){closed=true;previews.clear();}};
  owners.set(subjectId,client);return client;
}
