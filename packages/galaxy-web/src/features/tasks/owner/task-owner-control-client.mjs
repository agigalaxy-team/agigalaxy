import {sha256Hex} from "../../../../../galaxy-official/src/shared/web-primitives.mjs";
import {taskOwnerControlEnvelopeV2Schema,taskOwnerControlPreviewV2Schema,taskOwnerControlResultV2Schema} from "../../../../../galaxy-official/src/shared/task-owner-control-v2-schema.mjs";
import {taskEnvelopeV2Schema,participationProposalV2Schema,participationEventV2Schema} from "../../../../../galaxy-official/src/shared/task-schema-v2.mjs";

const clients=new WeakMap(),copy=value=>structuredClone(value),equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const uuid=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value??'');
const legacyKinds=new Set(['suggest-contacts','invite','invitation-reply','revoke-invitation','apply','withdraw-application','cancel','close','stop-enrollment','extend-enrollment',
 'propose','requester-feedback','confirm','decline','withdraw','propose-scope','confirm-scope','decline-scope','deliver','accept','dispute','propose-resolution','confirm-resolution']);
const changed=()=>fail('task_owner_control_connection_changed','身份或连接已变化，原操作已保留，请重新核对原回执。');
const invalid=()=>fail('task_owner_control_record_invalid','原任务操作或准确授权范围不一致，请保留原记录并核对。');
const blocked=()=>fail('task_owner_control_pending','请先核对原任务操作的回执；未知结果不会另建取消或关闭。');

/** An explicit local control journal, separate from read permits and Task state.
 * Queue entry captures the caller's lease; restart never resumes a write.
 */
export function createTaskOwnerControlClient(runtime,taskId,{now=()=>Math.floor(Date.now()/1000)}={}){
 if(!uuid(taskId))invalid();
 const capture=()=>{const s=runtime.api.snapshot();return s&&{subjectId:s.subjectId,endpoint:runtime.api.endpoint,bindingId:s.bindingId,
  generation:s.generation,deviceId:s.control?.deviceId,controlEpoch:s.control?.epoch};};
 const initial=capture();if(!initial?.deviceId||!Number.isSafeInteger(initial.controlEpoch))changed();
 const owner={subjectId:initial.subjectId,endpoint:initial.endpoint},key='task-owner-control:'+JSON.stringify([owner.endpoint,taskId]);
 let registry=clients.get(runtime);if(!registry){registry=new Map();clients.set(runtime,registry);}
 const cacheKey=JSON.stringify([owner.endpoint,owner.subjectId,taskId]);let cell=registry.get(cacheKey);
 if(cell?.client&&!cell.closed)return cell.client;
 cell??={tail:Promise.resolve()};cell.closed=false;registry.set(cacheKey,cell);
 let closed=false;const previews=new Map();
 const check=lease=>{if(closed||!lease?.deviceId||lease.subjectId!==owner.subjectId||lease.endpoint!==owner.endpoint||!equal(lease,capture()))changed();};
 const wait=async(lease,fn)=>{check(lease);let value;try{value=await fn();}catch(error){check(lease);throw error;}check(lease);return value;};
 const serial=fn=>{const lease=copy(capture()),invoke=()=>wait(lease,()=>fn(lease));const operation=cell.tail.then(invoke,invoke);
  cell.tail=operation.catch(()=>{});return operation;};
 const empty=()=>({version:1,owner:copy(owner),pending:null,stopped:[],receipts:[]});
 const load=async lease=>{const value=await wait(lease,()=>runtime.getLocal(key));if(!value)return empty();
  if(value.version!==1||!equal(value.owner,owner)||!Array.isArray(value.stopped)||!Array.isArray(value.receipts))invalid();
  const metadataKeys=new Set(['taskId','eventId','payloadHash','operationId','kind','expectedTaskVersion','state','receiptState','localRetryStopped',
   'serverCancellationConfirmed','stoppedAt','version','checkedAt','currentAccessGranted']);
  for(const item of [...value.stopped,...value.receipts])if(!item||Object.keys(item).some(k=>!metadataKeys.has(k))
   ||item.taskId!==taskId||!uuid(item.operationId)||item.eventId!==item.operationId||!['cancel','close','stop-enrollment'].includes(item.kind)
   ||!Number.isSafeInteger(item.expectedTaskVersion)||item.expectedTaskVersion<1||!/^[a-f0-9]{64}$/.test(item.payloadHash))invalid();
  return value;};
 const save=(lease,value)=>wait(lease,()=>runtime.putLocal(key,value));
 const ref=record=>({taskId,eventId:record.operationId,payloadHash:record.payloadHash});
 const locator=record=>({...ref(record),operationId:record.operationId,kind:record.kind,expectedTaskVersion:record.expectedTaskVersion});
 async function validateRecord(lease,record){
  if(!record||!uuid(record.operationId)||!['cancel','close','stop-enrollment'].includes(record.kind)||typeof record.payloadJson!=='string')invalid();
  let parsed;try{parsed=taskOwnerControlEnvelopeV2Schema.parse(JSON.parse(record.payloadJson));}catch{invalid();}
  if(parsed.taskId!==taskId||parsed.event.eventId!==record.operationId||parsed.event.kind!==record.kind||parsed.event.expectedTaskVersion!==record.expectedTaskVersion
   ||await wait(lease,()=>sha256Hex(record.payloadJson))!==record.payloadHash)invalid();return parsed;
 }
 async function validatePreview(lease,value){
  if(!taskOwnerControlPreviewV2Schema.safeParse(value).success||value.taskId!==taskId||value.expiresAt<=now()
   ||value.authorization.recipient!==owner.endpoint||value.authorization.objectId!==value.operationId
   ||value.authorization.bindingId!==lease.bindingId||value.authorization.deviceId!==lease.deviceId||value.authorization.controlEpoch!==lease.controlEpoch
   ||value.expiresAt>value.source.expiresAt)invalid();
  await validateRecord(lease,value);return value;
 }
 function validateReceipt(record,receipt,exactVersion=true){
  const keys=new Set(['taskId','eventId','payloadHash','state','checkedAt','version','participationVersion','participationId','kind','authority']);
  if(!receipt||Object.keys(receipt).some(k=>!keys.has(k))||!['absent','acknowledged','conflict'].includes(receipt.state)
   ||receipt.taskId!==taskId||receipt.eventId!==record.operationId||receipt.payloadHash!==record.payloadHash
   ||receipt.authority!=='accepted-event-only; not-current-authorization'||!Number.isSafeInteger(receipt.checkedAt)
   ||receipt.state==='acknowledged'&&(!Number.isSafeInteger(receipt.version)||receipt.version<1
    ||exactVersion&&receipt.version!==record.expectedTaskVersion+1)
   ||receipt.kind!==undefined&&receipt.kind!==record.kind
   ||receipt.participationId!==undefined&&receipt.participationId!==null&&(!uuid(receipt.participationId)||['cancel','close','stop-enrollment'].includes(record.kind))
   ||receipt.participationVersion!==undefined&&receipt.participationVersion!==null&&(!Number.isSafeInteger(receipt.participationVersion)||receipt.participationVersion<1))invalid();return receipt;
 }
 const query=async(lease,record)=>validateReceipt(record,await wait(lease,()=>runtime.api.call('/v2/tasks/receipt',ref(record))));
 const legacyBlocked=()=>fail('task_owner_control_legacy_pending','请先查询原任务队列中的准确操作；未知或冲突不会另建授权。需要另起操作时，请先独立停止原本机重试并核对原回执。');
 async function legacyWithin(lease){
  const raw=await wait(lease,()=>runtime.getLocal('task-event:'+taskId));
  const stopped=await wait(lease,()=>runtime.stoppedTaskOperations?runtime.stoppedTaskOperations(taskId):runtime.getLocal('task-stopped-operations:'+taskId));
  if(stopped&&!Array.isArray(stopped))invalid();const rows=[];
  if(raw){
   if(raw.taskId!==taskId||!uuid(raw.eventId)||!/^[a-f0-9]{64}$/.test(raw.payloadHash)||typeof raw.payloadJson!=='string'
    ||await wait(lease,()=>sha256Hex(raw.payloadJson))!==raw.payloadHash)invalid();
   let payload,event;try{payload=JSON.parse(raw.payloadJson);
    if(!raw.path||raw.path===`/v2/tasks/${taskId}/events`){payload=taskEnvelopeV2Schema.parse(payload);if(payload.taskId!==taskId)invalid();event=payload.event;}
    else if(raw.path===`/v2/tasks/${taskId}/participations`)event=participationProposalV2Schema.parse(payload);
    else if(/^\/v2\/participations\/[0-9a-f-]{36}\/events$/i.test(raw.path))event=participationEventV2Schema.parse(payload);
    else invalid();
   }catch{invalid();}
   if(event.eventId!==raw.eventId)invalid();
   rows.push({taskId,eventId:raw.eventId,operationId:raw.eventId,payloadHash:raw.payloadHash,kind:event.kind,
    expectedTaskVersion:event.expectedTaskVersion,state:raw.state==='prepared'?'prepared':'unknown',source:'legacy-task-event',serverCancellationConfirmed:false,
    payloadJson:raw.payloadJson,event});
  }
  for(const item of stopped??[]){
   if(item?.taskId!==taskId||!uuid(item.eventId)||!/^[a-f0-9]{64}$/.test(item.payloadHash)||!legacyKinds.has(item.kind))invalid();
   rows.push({taskId,eventId:item.eventId,operationId:item.eventId,payloadHash:item.payloadHash,kind:item.kind,state:'stopped-local',
    source:'legacy-task-stopped',localRetryStopped:true,serverCancellationConfirmed:false});
  }
  return rows;
 }
 const publicLegacy=row=>({taskId,eventId:row.eventId,operationId:row.operationId,payloadHash:row.payloadHash,kind:row.kind,state:row.state,
  source:row.source,serverCancellationConfirmed:false,...(row.localRetryStopped?{localRetryStopped:true}:{})});
 const queryLegacy=async(lease,row)=>validateReceipt(row,await wait(lease,()=>runtime.api.call('/v2/tasks/receipt',ref(row))),false);
 async function legacyGate(lease,record,input){
  const rows=await legacyWithin(lease);let candidate=null;
  for(const row of rows){const receipt=await queryLegacy(lease,row);
   if(receipt.state==='conflict')legacyBlocked();
   if(receipt.state==='acknowledged'){
    if(row.source==='legacy-task-event')return{ack:receipt};continue;
   }
   if(row.source==='legacy-task-stopped')continue;
   // An original local stop can be between its archive write and queue release.
   // Do not resume that intent or clear either legacy store in this client.
   if(rows.some(other=>other.source==='legacy-task-stopped'&&other.eventId===row.eventId))legacyBlocked();
   if(!['cancel','close','stop-enrollment'].includes(row.kind)||row.kind!==input.kind||row.event.reason!==input.reason)legacyBlocked();
   if(record&&(record.operationId!==row.operationId||record.payloadHash!==row.payloadHash||record.payloadJson!==row.payloadJson))legacyBlocked();
   candidate=row;
  }
  return{candidate};
 }
 async function complete(lease,state,record,receipt){
  const saved={...locator(record),state:'acknowledged',version:receipt.version,checkedAt:receipt.checkedAt??now(),currentAccessGranted:false};
  state.receipts=[saved,...state.receipts.filter(item=>item.operationId!==record.operationId)];
  if(state.pending?.operationId===record.operationId)state.pending=null;
  state.stopped=state.stopped.map(item=>item.operationId===record.operationId?{...item,receiptState:'acknowledged',version:receipt.version}:item);
  await save(lease,state);previews.delete(record.operationId);return receipt;
 }
 function publicPending(record){return record&&{...locator(record),state:record.state,preview:copy(record.preview),
  consentId:record.prepared?.intent.id??null,serverCancellationConfirmed:false};}
 async function original(lease,state){const record=state.pending;if(!record)return null;await validateRecord(lease,record);return record;}
 async function receiptFirst(lease,state,record){const receipt=await query(lease,record);
  if(receipt.state==='acknowledged')return complete(lease,state,record,receipt);
  if(receipt.state==='conflict'){record.state='conflict';state.pending=record;await save(lease,state);blocked();}return receipt;}
 async function prepareWithin(lease,{kind,reason}){
  if(!['cancel','close','stop-enrollment'].includes(kind)||typeof reason!=='string'||!reason.trim()||reason.trim().length>1500)invalid();
  const state=await load(lease);let record=await original(lease,state);
  if(record){const receipt=await receiptFirst(lease,state,record);if(receipt.state==='acknowledged')return receipt;
   const event=JSON.parse(record.payloadJson).event;if(event.kind!==kind||event.reason!==reason.trim())blocked();
  }else if(state.stopped.some(item=>!['absent','acknowledged'].includes(item.receiptState)))blocked();
  const legacy=await legacyGate(lease,record,{kind,reason:reason.trim()});if(legacy.ack)return copy(legacy.ack);
  if(!record&&legacy.candidate){const candidate=legacy.candidate;
   record={operationId:candidate.operationId,kind:candidate.kind,expectedTaskVersion:candidate.expectedTaskVersion,
    payloadJson:candidate.payloadJson,payloadHash:candidate.payloadHash,state:'absent'};
  }
  const operationId=record?.operationId??crypto.randomUUID();
  const preview=await wait(lease,()=>runtime.api.call(`/v2/tasks/${taskId}/owner-control/prepare`,{operationId,kind,reason:reason.trim(),...(kind==='close'?{terminationIntent:'terminate-task'}:{})}));
  await validatePreview(lease,preview);
  if(record&&(preview.payloadHash!==record.payloadHash||preview.payloadJson!==record.payloadJson)){
   if(legacy.candidate)fail('task_owner_control_legacy_preview_changed','当前预览无法保留原队列的准确字节或版本。请在原流程独立停止本机重试并核对原回执，再明确审阅新操作；原队列保持不变。');
   fail('task_owner_control_preview_changed','原任务版本或准确字节已改变；原操作保留，不会自动替换。');
  }
  record={...record,operationId,kind,expectedTaskVersion:preview.expectedTaskVersion,payloadJson:preview.payloadJson,payloadHash:preview.payloadHash,
   preview:copy(preview),state:record?.state??'prepared'};
  state.pending=record;await save(lease,state);previews.set(operationId,{lease:copy(lease),preview:copy(preview)});return copy(preview);
 }
 const client={
  prepare:input=>{const selected=copy(input);return serial(lease=>prepareWithin(lease,selected));},
  pending:()=>serial(async lease=>{const state=await load(lease),record=await original(lease,state),legacy=await legacyWithin(lease);
   return{pending:publicPending(record),stopped:copy(state.stopped),receipts:copy(state.receipts),legacy:legacy.map(publicLegacy)};}),
  confirm:(reviewed,{confirmed=false}={})=>{const selected=copy(reviewed);return serial(async lease=>{
   if(!confirmed)fail('task_owner_control_confirmation_required','请查看准确取消或关闭范围，再明确确认。');
   const known=previews.get(selected?.operationId);if(!known||!equal(known.lease,lease)||!equal(known.preview,selected))invalid();
   await validatePreview(lease,selected);const state=await load(lease),record=await original(lease,state);
   if(!record||record.operationId!==selected.operationId||record.payloadHash!==selected.payloadHash||record.payloadJson!==selected.payloadJson)invalid();
   const receipt=await receiptFirst(lease,state,record);if(receipt.state==='acknowledged')return receipt;
   const legacyInput=JSON.parse(record.payloadJson).event;
   if(legacyInput.kind==='close'&&legacyInput.terminationIntent!=='terminate-task')fail('task_termination_intent_required','原关闭操作只可查询回执；终止整项求助需要新的明确意图。');
   const checkLegacy=async()=>{const legacy=await legacyGate(lease,record,legacyInput);
    if(legacy.ack){if(legacy.ack.eventId!==record.operationId||legacy.ack.payloadHash!==record.payloadHash)legacyBlocked();
     return complete(lease,state,record,legacy.ack);}return null;};
   const already=await checkLegacy();if(already)return already;
   const prior=record.prepared?.intent;
   if(!prior||prior.bindingId!==lease.bindingId||prior.expiresAt<=now()||prior.expiresAt!==selected.expiresAt){
    if(prior)record.authorizationHistory=[...(record.authorizationHistory??[]),{consentId:prior.id,bindingId:prior.bindingId,expiresAt:prior.expiresAt}];
    record.prepared=await wait(lease,()=>runtime.api.prepareAuthorization(record.payloadJson,{action:'assistance.publish',objectId:record.operationId,
     visibility:'Private',viewers:[],expiresAt:selected.expiresAt,confirmed:true}));record.submission=null;
    state.pending=record;await save(lease,state);
   }
   const intent=record.prepared?.intent;
   if(record.prepared?.payloadJson!==record.payloadJson||intent?.action!=='assistance.publish'||intent.objectId!==record.operationId
    ||intent.subjectId!==owner.subjectId||intent.bindingId!==lease.bindingId||intent.endpoint!==owner.endpoint||intent.recipient!==owner.endpoint
    ||intent.visibility!=='Private'||!equal(intent.viewers,[])||intent.purpose!=='operational'||!equal(intent.fields,['taskId','event'])
    ||intent.payloadHash!==record.payloadHash||intent.expiresAt!==selected.expiresAt)invalid();
   if(!record.submission){const accepted=await checkLegacy();if(accepted)return accepted;
    record.submission=await wait(lease,()=>runtime.api.submitAuthorization(record.prepared,{confirmed:true,reconcile:true}));
    if(record.submission?.consentId!==intent.id||record.submission.payloadJson!==record.payloadJson)invalid();state.pending=record;await save(lease,state);}
   record.state='unknown';state.pending=record;await save(lease,state);
   const accepted=await checkLegacy();if(accepted)return accepted;
   const result=await wait(lease,()=>runtime.api.call(`/v2/tasks/${taskId}/owner-control`,record.submission));
   if(!taskOwnerControlResultV2Schema.safeParse(result).success||result.taskId!==taskId||result.eventId!==record.operationId||result.payloadHash!==record.payloadHash
    ||result.version!==record.expectedTaskVersion+1||result.state!==(record.kind==='stop-enrollment'?'enrollment-stopped':record.kind==='cancel'?'canceled':'closed'))invalid();
   await complete(lease,state,record,{...ref(record),state:'acknowledged',version:result.version,checkedAt:now()});return copy(result);
  });},
  reconcile:({operationId}={})=>serial(async lease=>{const state=await load(lease),record=state.pending&&(!operationId||state.pending.operationId===operationId)
   ?await original(lease,state):state.stopped.find(item=>item.operationId===operationId);
   if(!record){const legacy=(await legacyWithin(lease)).find(row=>operationId?row.operationId===operationId:row.source==='legacy-task-event');
    return legacy?copy(await queryLegacy(lease,legacy)):{state:'none'};}
   const receipt=await query(lease,record);
   if(receipt.state==='acknowledged')return complete(lease,state,record,receipt);
   if(state.pending?.operationId===record.operationId){state.pending.state=receipt.state;state.pending.lastReceipt=copy(receipt);}
   else state.stopped=state.stopped.map(item=>item.operationId===record.operationId?{...item,receiptState:receipt.state,checkedAt:receipt.checkedAt}:item);
   await save(lease,state);return copy(receipt);
  }),
  stopRetry:(reviewed,{confirmed=false}={})=>{const selected=copy(reviewed);return serial(async lease=>{
   if(!confirmed)fail('task_owner_control_confirmation_required','请明确确认仅停止本机重试；服务端取消结果仍需原回执核对。');
   const state=await load(lease),record=await original(lease,state);if(!record)return{state:'none'};
   if(selected?.operationId!==record.operationId||selected.payloadHash!==record.payloadHash||selected.taskId!==taskId)invalid();
   let receipt;try{receipt=await query(lease,record);}catch(error){check(lease);if(error.code==='task_owner_control_record_invalid')throw error;receipt={state:'unknown'};}
   if(receipt.state==='acknowledged')return complete(lease,state,record,receipt);
   const stopped={...locator(record),state:'stopped-local',receiptState:receipt.state,localRetryStopped:true,serverCancellationConfirmed:false,stoppedAt:now()};
   state.stopped=[stopped,...state.stopped.filter(item=>item.operationId!==record.operationId)];state.pending=null;
   // One journal commit retains the original body-free locator before release;
   // stopped entries cannot sign or dispatch even when their receipt is absent.
   await save(lease,state);previews.delete(record.operationId);return copy(stopped);
  });},
  close(){closed=true;if(cell.client===client)cell.closed=true;previews.clear();},
 };
 cell.client=Object.freeze(client);return cell.client;
}
