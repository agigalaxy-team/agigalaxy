import * as z from 'zod/v4';
import {contextGrantV2Schema,contextEventV2Schema,contextQueryV2Schema} from "../../../galaxy-contracts/src/context-v2-schema.mjs";
import {sha256Hex} from "../../../galaxy-contracts/src/web-primitives.mjs";
const lanes=new Map();
const issue=(code)=>Object.assign(new Error(code),{code});
const uuid=value=>z.uuid().parse(value);

// Browser-compatible, no model calls and no raw-context harvesting. The local
// record is saved before either Consent or the material operation can be sent.
export function createContextClientV2({api,getLocal,putLocal,now=()=>Math.floor(Date.now()/1000),locks=globalThis.navigator?.locks}) {
  if(!api?.endpoint||!api.prepareAuthorization||!getLocal||!putLocal)throw new Error('Context client requires the existing identity and local storage.');
  const previews=new WeakMap(),index='context-v2:pending',endpoint=api.endpoint,resuming=new Map();
  const key=id=>`context-v2:operation:${uuid(id)}`;
  function actor(){const current=api.snapshot();if(!current?.scopes.includes('context'))throw issue('context_connection_required');return current;}
  function same(lease){const current=actor();if(api.endpoint!==endpoint||['subjectId','bindingId','generation','endpoint'].some(key=>current[key]!==lease[key]))throw issue('context_identity_changed');}
  function serial(lease,work){
    const name=`galaxy-context:${api.endpoint}:${lease.subjectId}`;
    if(locks?.request)return locks.request(name,{mode:'exclusive'},async()=>{same(lease);return work();});
    const prior=lanes.get(name)??Promise.resolve(),result=prior.catch(()=>{}).then(()=>{same(lease);return work();});
    lanes.set(name,result);return result.finally(()=>{if(lanes.get(name)===result)lanes.delete(name);});
  }
  async function save(lease,record){same(lease);await putLocal(key(record.operationId),record);same(lease);}
  async function load(lease,operationId){
    same(lease);const record=await getLocal(key(operationId));same(lease);
    if(!record||record.subjectId!==lease.subjectId||record.endpoint!==api.endpoint)throw issue('context_operation_unavailable');
    if(record.state!=='stopped-local'&&await sha256Hex(record.payloadJson)!==record.payloadHash)throw issue('context_saved_payload_changed');
    return record;
  }
  async function register(lease,record){
    await save(lease,record);const ids=await getLocal(index)??[];same(lease);
    if(!ids.includes(record.operationId)){await putLocal(index,[...ids,record.operationId]);same(lease);}
  }
  async function complete(lease,record,receipt){
    record.state='acknowledged';record.receipt=receipt;await save(lease,record);
    const ids=await getLocal(index)??[];same(lease);await putLocal(index,ids.filter(id=>id!==record.operationId));same(lease);
    // The accepted receipt is on the service. Do not keep a second local copy
    // of uploaded selected text after successful reconciliation.
    await putLocal(key(record.operationId),null);same(lease);return receipt;
  }
  async function prepareGrant(payload){return prepare(contextGrantV2Schema.parse(payload),'grant');}
  async function prepareEvent(kind,metadata){
    const payload=contextEventV2Schema.parse({schemaVersion:2,id:crypto.randomUUID(),kind,grantId:metadata.grantId,taskId:metadata.taskId,
      participationId:metadata.participationId,scopeVersion:metadata.scopeVersion,materialsHash:metadata.materialsHash});
    return prepare(payload,kind,metadata);
  }
  async function prepare(payload,kind,metadata){
    const lease=actor(),grant=kind==='grant',participantId=grant?payload.participantId:metadata.participantId,
      ownerId=grant?lease.subjectId:metadata.ownerId;
    if(lease.subjectId!==(grant||kind==='revoke'?ownerId:participantId))throw issue('context_actor_mismatch');
    const payloadJson=JSON.stringify(payload);if(new TextEncoder().encode(payloadJson).length>40000)throw issue('context_payload_too_large');
    const record={version:2,endpoint:api.endpoint,subjectId:lease.subjectId,operationId:payload.id,grantId:grant?payload.id:payload.grantId,
      taskId:payload.taskId,participationId:payload.participationId,kind,payloadJson,payloadHash:await sha256Hex(payloadJson),
      recipientId:grant||kind==='revoke'?participantId:ownerId,expiresAt:grant?payload.expiresAt:Math.max(now()+300,Math.min(metadata.expiresAt,now()+2591900)),state:'prepared'};
    same(lease);const preview=Object.freeze({endpoint:api.endpoint,subjectId:lease.subjectId,operationId:record.operationId,grantId:record.grantId,kind,
      payload:structuredClone(payload),recipientId:record.recipientId,expiresAt:record.expiresAt,payloadHash:record.payloadHash});
    previews.set(preview,{record,lease,used:false});return preview;
  }
  async function operationReceipt(lease,record){
    same(lease);const input={grantId:record.grantId,eventId:record.operationId,payloadHash:record.payloadHash};
    const receipt=await api.call('/v2/context/receipt',input);same(lease);
    if(receipt.grantId!==input.grantId||receipt.eventId!==input.eventId||receipt.payloadHash!==input.payloadHash
      ||!['absent','acknowledged','conflict'].includes(receipt.state))throw issue('context_receipt_mismatch');
    return receipt;
  }
  async function send(lease,record){
    const reconcile=!!record.preparedConsent;
    if(!record.preparedConsent){
      record.preparedConsent=await api.prepareAuthorization(record.payloadJson,{action:'context.grant',objectId:record.operationId,
        visibility:'Private',viewers:[record.recipientId],expiresAt:record.expiresAt,confirmed:true});same(lease);
      record.state='consent-result-unknown';await save(lease,record);
    }
    const submission=await api.submitAuthorization(record.preparedConsent,{confirmed:true,reconcile});same(lease);
    record.state='result-unknown';await save(lease,record);
    const result=await api.call(record.kind==='grant'?'/v2/context/grants':`/v2/context/${record.grantId}/events`,submission);same(lease);
    if(result.grantId!==record.grantId||result.eventId!==record.operationId
      ||!['recorded-awaiting-recipient-acceptance','accepted','declined','revoked','acknowledged'].includes(result.state))throw issue('context_result_unknown');
    return complete(lease,record,result);
  }
  function execute(preview,{confirmed=false}={}){
    const op=previews.get(preview);if(!confirmed||!op||op.used)throw issue('context_confirmation_required');
    if(JSON.stringify(preview.payload)!==op.record.payloadJson)throw issue('context_preview_changed');
    same(op.lease);op.used=true;
    return serial(op.lease,async()=>{await register(op.lease,op.record);return send(op.lease,op.record);});
  }
  async function pending(){
    const lease=actor(),ids=await getLocal(index)??[];same(lease);const items=[];
    for(const operationId of ids){const record=await getLocal(key(operationId));same(lease);
      if(record?.subjectId===lease.subjectId&&record.endpoint===api.endpoint&&record.state!=='acknowledged')
        items.push({operationId:record.operationId,grantId:record.grantId,taskId:record.taskId,participationId:record.participationId,
          kind:record.kind,state:record.state,payloadHash:record.payloadHash,recipientId:record.recipientId});}
    return items;
  }
  function reconcile(operationId){const lease=actor();return serial(lease,async()=>{
    const record=await load(lease,operationId),receipt=await operationReceipt(lease,record);
    return receipt.state==='acknowledged'?complete(lease,record,receipt):receipt;
  });}
  function retry(operationId,{confirmed=false}={}){
    if(!confirmed)throw issue('context_confirmation_required');const lease=actor();return serial(lease,async()=>{
      const record=await load(lease,operationId),receipt=await operationReceipt(lease,record);
      if(receipt.state==='acknowledged')return complete(lease,record,receipt);
      if(receipt.state!=='absent')throw issue('context_operation_conflict');
      if(record.state==='stopped-local')throw issue('context_local_retry_stopped');
      return send(lease,record);
    });
  }
  // Visible-page recovery only reuses the durable original signature. An
  // unsigned journal, changed binding or expired signature needs a new review;
  // the saved material period is never extended here.
  function resumePending(operationId){
    const lease=actor(),lane=JSON.stringify([lease.subjectId,lease.bindingId,lease.generation,uuid(operationId)]);
    if(resuming.has(lane))return resuming.get(lane);
    const next=serial(lease,async()=>{
      const record=await load(lease,operationId),receipt=await operationReceipt(lease,record);
      if(receipt.state==='acknowledged')return complete(lease,record,receipt);
      if(receipt.state!=='absent')return receipt;
      if(record.state==='stopped-local')return{...receipt,reason:'stopped-local',serverCancellationConfirmed:false};
      if(!Number.isSafeInteger(record.expiresAt)||record.expiresAt<=now())return{...receipt,reason:'authorization-expired'};
      const prepared=record.preparedConsent,intent=prepared?.intent;
      if(!prepared)return{...receipt,reason:'authorization-review-required'};
      if(prepared.endpoint!==endpoint||prepared.payloadJson!==record.payloadJson||typeof prepared.signedIntent!=='string'
        ||intent?.subjectId!==lease.subjectId||intent.endpoint!==endpoint||intent.action!=='context.grant'
        ||intent.objectId!==record.operationId||intent.payloadHash!==record.payloadHash||intent.visibility!=='Private'
        ||JSON.stringify(intent.viewers)!==JSON.stringify([record.recipientId])||intent.expiresAt!==record.expiresAt)
        throw issue('context_saved_authorization_changed');
      const authorization=await api.reconcileAuthorization(prepared);same(lease);
      if(authorization.state==='absent'){
        if(intent.bindingId!==lease.bindingId)return{...receipt,reason:'original-binding-changed'};
        if(intent.issuedAt<now()-300)return{...receipt,reason:'original-signature-expired'};
      }
      return send(lease,record);
    });resuming.set(lane,next);
    return next.finally(()=>{if(resuming.get(lane)===next)resuming.delete(lane);});
  }
  async function reviewWithin(lease,record){
    const receipt=await operationReceipt(lease,record);
    if(receipt.state==='acknowledged')return complete(lease,record,receipt);
    if(receipt.state!=='absent')throw issue('context_operation_conflict');
    if(record.state==='stopped-local')return {state:'stopped-local',operationId:record.operationId,serverCancellationConfirmed:false};
    if(!record.preparedConsent){
      if(record.kind==='grant'&&record.expiresAt<=now())throw issue('context_original_material_deadline_expired');
      return {state:'reauthorization-required',operationId:record.operationId,grantId:record.grantId,consentId:null,
        payloadHash:record.payloadHash,payload:JSON.parse(record.payloadJson),recipientId:record.recipientId,
        expiresAt:record.kind==='grant'?record.expiresAt:Math.max(now()+300,record.expiresAt)};
    }
    const authorization=await api.reconcileAuthorization(record.preparedConsent);same(lease);
    if(authorization.state!=='absent')return {state:'retry-original',operationId:record.operationId};
    const intent=record.preparedConsent.intent;
    if(intent.bindingId===lease.bindingId&&intent.issuedAt>=now()-300&&intent.expiresAt>now())return {state:'retry-original',operationId:record.operationId};
    if(record.kind==='grant'&&record.expiresAt<=now())throw issue('context_original_material_deadline_expired');
    return {state:'reauthorization-required',operationId:record.operationId,grantId:record.grantId,consentId:intent.id,
      payloadHash:record.payloadHash,payload:JSON.parse(record.payloadJson),recipientId:record.recipientId,
      expiresAt:record.kind==='grant'?record.expiresAt:Math.max(now()+300,record.expiresAt)};
  }
  function reviewAuthorization(operationId){const lease=actor();return serial(lease,async()=>reviewWithin(lease,await load(lease,operationId)));}
  function reauthorize(operationId,preview,{confirmed=false}={}){
    if(!confirmed)throw issue('context_confirmation_required');const lease=actor();return serial(lease,async()=>{
      const record=await load(lease,operationId),current=await reviewWithin(lease,record);
      if(current.state==='acknowledged')return current;
      if(current.state!=='reauthorization-required'||current.operationId!==preview?.operationId||current.consentId!==preview?.consentId
        ||current.payloadHash!==preview?.payloadHash||JSON.stringify(current.payload)!==JSON.stringify(preview?.payload)
        ||current.recipientId!==preview.recipientId||current.expiresAt!==preview.expiresAt)throw issue('context_authorization_preview_changed');
      const replacement=await api.prepareAuthorization(record.payloadJson,{action:'context.grant',objectId:record.operationId,
        visibility:'Private',viewers:[record.recipientId],expiresAt:current.expiresAt,confirmed:true});same(lease);
      record.previousAuthorizations=[...(record.previousAuthorizations??[]),...(record.preparedConsent?[record.preparedConsent]:[])];
      record.preparedConsent=replacement;record.expiresAt=current.expiresAt;record.state='consent-result-unknown';await save(lease,record);
      return send(lease,record);
    });
  }
  function abandon(operationId,{confirmed=false}={}){
    if(!confirmed)throw issue('context_confirmation_required');const lease=actor();return serial(lease,async()=>{
      const record=await load(lease,operationId),receipt=await operationReceipt(lease,record);
      if(receipt.state==='acknowledged')return complete(lease,record,receipt);
      if(receipt.state!=='absent')throw issue('context_operation_conflict');
      const {preparedConsent:_preparedConsent,previousAuthorizations:_previousAuthorizations,payloadJson:_payloadJson,...minimal}=record;
      await save(lease,{...minimal,state:'stopped-local'});
      return {state:'stopped-local',operationId,grantId:record.grantId,payloadHash:record.payloadHash,serverCancellationConfirmed:false};
    });
  }
  async function validateView(result,grantId,metadataOnly){
    if(result?.metadata?.grantId!==grantId||!Array.isArray(result.materials)||typeof result.contextAccessGranted!=='boolean'
      ||typeof result.metadata.materialsHash!=='string'||!/^[a-f0-9]{64}$/.test(result.metadata.materialsHash))throw issue('context_view_mismatch');
    if(metadataOnly&&result.contextAccessGranted||!result.contextAccessGranted&&result.materials.some(item=>Object.hasOwn(item,'content')))throw issue('context_unexpected_body');
    if(result.contextAccessGranted){
      const materials=result.materials.map(({id,label,mediaType,content})=>({id,label,mediaType,content}));
      if(materials.some(item=>typeof item.content!=='string')||await sha256Hex(JSON.stringify(materials))!==result.metadata.materialsHash)
        throw issue('context_material_hash_mismatch');
    }
    return result;
  }
  async function get(grantId,{metadataOnly=false}={}){
    uuid(grantId);const lease=actor();const result=await api.call(`/v2/context/${grantId}${metadataOnly?'/metadata':''}`,undefined,{method:'GET'});same(lease);
    const view=await validateView(result,grantId,metadataOnly);same(lease);return view;
  }
  async function query(input){
    const payload=contextQueryV2Schema.parse(input),lease=actor(),result=await api.call('/v2/context/query',payload);same(lease);
    if(!Array.isArray(result?.items)||result.items.length>payload.limit)throw issue('context_query_mismatch');
    for(const item of result.items){if(item.metadata?.taskId!==payload.taskId||payload.participationId&&item.metadata?.participationId!==payload.participationId)throw issue('context_query_mismatch');
      await validateView(item,item.metadata.grantId,true);}
    same(lease);return result;
  }
  return Object.freeze({prepareGrant,prepareEvent,execute,pending,reconcile,retry,resumePending,reviewAuthorization,reauthorize,abandon,get,query});
}
