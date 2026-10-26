import {contributionPublicationSchema} from "../../../../galaxy-official/src/shared/contribution-sharing-v2-schema.mjs";
import {sha256Hex} from "../../../../galaxy-official/src/shared/web-primitives.mjs";
/** @typedef {{retry?:boolean,reauthorize?:boolean,confirmed?:boolean,expectedOperationId?:string,expectedPayloadHash?:string}} ContributionRecoveryOptions */
const instances=new WeakMap();
export function getContributionClient(runtime,subjectId,{now=()=>Math.floor(Date.now()/1000)}={}){
  let map=instances.get(runtime);if(!map){map=new Map();instances.set(runtime,map);}if(map.has(subjectId))return map.get(subjectId);
  const endpoint=runtime.api.endpoint,key=`contribution-operations:${subjectId}`;let queue=Promise.resolve();
  const capture=()=>{const s=runtime.api.snapshot();return s?JSON.stringify([runtime.api.endpoint,s.subjectId,s.bindingId,s.generation,s.control?.epoch]):null;};
  const check=lease=>{if(!lease||runtime.api.endpoint!==endpoint||runtime.api.snapshot()?.subjectId!==subjectId||capture()!==lease)
    throw new Error('身份或连接已变化，请重新打开贡献页面并查询原操作。');};
  const guarded=async(lease,fn)=>{check(lease);const value=await fn();check(lease);return value;};
  // Capture the connection when the person requests the operation, including
  // work waiting behind another operation. A later connection needs a new call.
  const serial=fn=>{const lease=capture(),invoke=()=>guarded(lease,()=>fn(lease));const next=queue.then(invoke,invoke);queue=next.catch(()=>{});return next;};
  const load=async lease=>(await guarded(lease,()=>runtime.getLocal(key,subjectId)))??{pending:null,publications:[]};
  const update=async(lease,change)=>guarded(lease,async()=>{
    const apply=value=>{check(lease);return change(value??{pending:null,publications:[]});};
    if(runtime.updateLocal)try{return await runtime.updateLocal(key,apply,subjectId);}catch(error){if(error.message!=='local_atomic_update_unavailable')throw error;}
    const value=apply(await load(lease));await guarded(lease,()=>runtime.putLocal(key,value,subjectId));return value;
  });
  const pending=async(lease,record,{initial=false}={})=>update(lease,state=>{
    if(initial?!!state.pending:state.pending?.payload?.id!==record.payload.id)throw Error('contribution_original_replaced');return{...state,pending:record};
  });
  const stopped=record=>record.retryStopped||record.localRetryStopped||['stopped-local','locally-left','canceled'].includes(record.state);
  const canStartNew=record=>!!record&&(stopped(record)||record.blockedReason==='authorization-expired'||record.blockedReason==='original-deadline-unavailable');
  const locator=record=>({operationId:record.payload.id,publicationId:record.payload.publicationId??record.payload.id,kind:record.payload.kind,
    payloadHash:record.payloadHash,authorizationExpiresAt:record.authorizationExpiresAt??record.prepared?.intent?.expiresAt??null,
    endpoint,subjectId,reason:stopped(record)?'stopped-local':record.blockedReason??null});
  const historical=(state,record,result=null)=>{const prior=(state.previousOperations??[]).find(value=>value.operationId===record.payload.id),
    row={...prior,...locator(record),...(result?{receiptState:result.state,checkedAt:now()}:{} )};
    // An observed receipt updates metadata only; no archived request can send.
    if(result){row.receiptState=['revoked','expired'].includes(prior?.receiptState)&&result.state==='published'?prior.receiptState:result.state;row.checkedAt=now();}
    return[row,...(state.previousOperations??[]).filter(value=>value.operationId!==row.operationId)];};
  async function remember(lease,record,result){const id=record.payload.publicationId??record.payload.id;
    await update(lease,state=>{const prior=state.publications.find(p=>p.publicationId===id),
      value={...prior,publicationId:id,lastReceipt:result.state,sourceRefs:record.payload.sourceRefs??prior?.sourceRefs??[],expiresAt:record.payload.expiresAt??prior?.expiresAt??null};
      return{...state,pending:state.pending?.payload?.id===record.payload.id?null:state.pending,
        previousOperations:historical(state,record,result),publications:[value,...state.publications.filter(p=>p.publicationId!==id)]};});return result;
  }
  async function send(lease,record,{reauthorize=false}={}){
    check(lease);
    if(stopped(record))throw Error('contribution_original_stopped');
    if(!record.submission||reauthorize){
      const reconcile=!!record.prepared&&!reauthorize;
      if(!record.prepared||reauthorize){
        const previous=record.prepared,previousDeadline=record.authorizationExpiresAt??previous?.intent?.expiresAt;
        if(reauthorize)record.authorizationExpiresAt=Number.isSafeInteger(previousDeadline)&&previousDeadline>now()?previousDeadline
          :Math.min(now()+2591900,record.payload.kind==='publish'?Math.floor(Date.parse(record.payload.expiresAt)/1000):Infinity);
        const prepared=await guarded(lease,()=>runtime.api.prepareAuthorization(record.payloadJson,{action:'contribution.publish',objectId:record.payload.id,
          visibility:record.payload.kind==='publish'?'Public':'Private',confirmed:true,
          ...(record.authorizationExpiresAt?{expiresAt:record.authorizationExpiresAt}:{})}));
        if(reauthorize&&previous)record.authorizationHistory=[...(record.authorizationHistory??[]),{prepared:previous,submission:record.submission??null,
          reason:'business-and-consent-absent-user-confirmed'}];
        record.prepared=prepared;record.authorizationBindingId=prepared.intent.bindingId;record.submission=null;await pending(lease,record);
      }
      const submission=await guarded(lease,()=>runtime.api.submitAuthorization(record.prepared,{confirmed:true,reconcile}));
      record.submission=submission;await pending(lease,record);
    }
    record.attempted=true;await pending(lease,record);
    const receipt=await guarded(lease,()=>runtime.api.call('/v2/contributions/publish',record.submission));
    if(receipt.operationId!==record.payload.id||receipt.publicationId!==(record.payload.publicationId??record.payload.id))throw new Error('回执不匹配，请查询原操作。');
    return remember(lease,record,receipt);
  }
  const client={
    local:async()=>{const state=await load(capture());return{...state,pending:state.pending?{...state.pending,
      canStartNewSelection:!!canStartNew(state.pending)}:null};},
    submit:(input,{confirmed=false}={})=>{
      // The queued action also retains the exact fields the person confirmed.
      const selected=structuredClone(input);
      return serial(async lease=>{
        if(!confirmed)throw new Error('请先确认具体字段、用途和可见范围。');
        const payload=contributionPublicationSchema.parse({...selected,id:selected.id??crypto.randomUUID()}),payloadJson=JSON.stringify(payload);
        const prior=(await load(lease)).pending;
        if(prior){if(!canStartNew(prior))throw new Error('请先查询或恢复上一次贡献操作。');
          if(payload.id===prior.payload.id)throw Error('contribution_new_operation_required');
          await update(lease,state=>{if(state.pending?.payload?.id!==prior.payload.id)throw Error('contribution_original_replaced');
            return{...state,pending:null,previousOperations:historical(state,prior)};});
        }
        const payloadHash=await guarded(lease,()=>sha256Hex(payloadJson));
        const authorizationExpiresAt=Math.min(now()+2591900,payload.kind==='publish'?Math.floor(Date.parse(payload.expiresAt)/1000):Infinity);
        const record={payload,payloadJson,payloadHash,attempted:false,authorizationExpiresAt,authorizationBindingId:runtime.api.snapshot()?.bindingId};
        await pending(lease,record,{initial:true});return send(lease,record);
      });
    },
    reconcile:({retry=false,reauthorize=false,confirmed=false,expectedOperationId,expectedPayloadHash}= /** @type {ContributionRecoveryOptions} */ ({}))=>serial(async lease=>{
      const record=(await load(lease)).pending;
      if(expectedOperationId!==undefined&&record?.payload?.id!==expectedOperationId||expectedPayloadHash!==undefined&&record?.payloadHash!==expectedPayloadHash)
        throw Error('contribution_original_replaced');
      if(!record)return{state:'none'};
      const payload=contributionPublicationSchema.parse(JSON.parse(record.payloadJson));
      const hash=await guarded(lease,()=>sha256Hex(record.payloadJson));
      if(hash!==record.payloadHash||JSON.stringify(payload)!==JSON.stringify(record.payload))throw new Error('原操作记录不匹配，请保留记录并核对。');
      const status=await guarded(lease,()=>runtime.api.call('/v2/contributions/status',{publicationId:payload.publicationId??payload.id}));
      const matches=payload.kind==='publish'?status.payloadHash===hash:status.revokeOperationId===payload.id&&status.revokePayloadHash===hash;
      if(status.publicationId!==(payload.publicationId??payload.id))throw new Error('回执不匹配，请查询原操作。');
      if(matches)return remember(lease,record,status);
      if(payload.kind==='publish'&&status.state!=='absent'||payload.kind==='revoke'&&status.revokeOperationId)throw new Error('服务端存在不同操作，请保留原记录并核对。');
      if(!retry)return{state:'unconfirmed',currentState:status.state};
      if(!confirmed)throw new Error('请确认只重试原操作。');
      return send(lease,record,{reauthorize});
    }),
    // Only a prior confirmed submit owns this journal. Drafts and previews are
    // never considered; reconnecting preserves its bytes, purpose and expiry.
    resumePending:()=>serial(async lease=>{
      const record=(await load(lease)).pending;if(!record)return{state:'none'};
      const payload=contributionPublicationSchema.parse(JSON.parse(record.payloadJson)),hash=await guarded(lease,()=>sha256Hex(record.payloadJson));
      if(hash!==record.payloadHash||JSON.stringify(payload)!==JSON.stringify(record.payload))throw new Error('原操作记录不匹配，请保留记录并核对。');
      const status=await guarded(lease,()=>runtime.api.call('/v2/contributions/status',{publicationId:payload.publicationId??payload.id}));
      if(status.publicationId!==(payload.publicationId??payload.id))throw new Error('回执不匹配，请查询原操作。');
      const matches=payload.kind==='publish'?status.payloadHash===hash:status.revokeOperationId===payload.id&&status.revokePayloadHash===hash;
      if(matches)return remember(lease,record,status);
      if(payload.kind==='publish'&&status.state!=='absent'||payload.kind==='revoke'&&status.revokeOperationId)throw new Error('服务端存在不同操作，请保留原记录并核对。');
      const blocked=async reason=>{record.blockedReason=reason;await pending(lease,record);return{state:'unconfirmed',currentState:status.state,reason,operationId:payload.id};};
      if(stopped(record))return blocked('stopped-local');
      const deadline=record.authorizationExpiresAt??record.prepared?.intent?.expiresAt;
      if(!Number.isSafeInteger(deadline))return blocked('original-deadline-unavailable');
      if(deadline<=now()||payload.kind==='publish'&&Date.parse(payload.expiresAt)<=now()*1000)return blocked('authorization-expired');
      if(record.prepared){
        const intent=record.prepared.intent,visibility=payload.kind==='publish'?'Public':'Private';
        if(record.prepared.endpoint!==endpoint||record.prepared.payloadJson!==record.payloadJson||intent?.subjectId!==subjectId||intent.endpoint!==endpoint
          ||intent.action!=='contribution.publish'||intent.objectId!==payload.id||intent.payloadHash!==hash||intent.visibility!==visibility
          ||intent.purpose!==(visibility==='Public'?'public-profile':'operational')||intent.recipient!==endpoint||intent.viewers?.length
          ||JSON.stringify(intent.fields)!==JSON.stringify(Object.keys(payload))||intent.expiresAt!==deadline)throw Error('contribution_original_authorization_changed');
        if(record.submission&&(record.submission.consentId!==intent.id||record.submission.payloadJson!==record.payloadJson))throw Error('contribution_original_authorization_changed');
        const receipt=await guarded(lease,()=>runtime.api.reconcileAuthorization(record.prepared));
        if(receipt.state==='acknowledged'){
          record.submission={consentId:receipt.consentId,payloadJson:record.payloadJson};await pending(lease,record);
        }else if(receipt.state!=='absent')throw Error('contribution_original_authorization_changed');
        else if(intent.bindingId!==runtime.api.snapshot()?.bindingId)return blocked('original-binding-changed');
        else if(intent.issuedAt<now()-300){
          record.authorizationHistory=[...(record.authorizationHistory??[]),{prepared:record.prepared,submission:null,reason:'same-binding-signature-renewal'}];
          record.authorizationExpiresAt=deadline;record.authorizationBindingId=intent.bindingId;record.prepared=null;record.submission=null;await pending(lease,record);
        }
      }else if(record.submission)throw Error('contribution_original_authorization_changed');
      if(!record.prepared&&(!record.authorizationBindingId||record.authorizationBindingId!==runtime.api.snapshot()?.bindingId))
        return blocked(record.authorizationBindingId?'original-binding-changed':'original-binding-unavailable');
      return send(lease,record);
    }),
    previousOperations:()=>serial(async lease=>((await load(lease)).previousOperations??[]).filter(row=>row.endpoint===endpoint&&row.subjectId===subjectId)),
    reconcilePrevious:operationId=>serial(async lease=>{
      const record=((await load(lease)).previousOperations??[]).find(row=>row.operationId===operationId&&row.endpoint===endpoint&&row.subjectId===subjectId);
      if(!record)throw Error('contribution_original_locator_unavailable');
      const status=await guarded(lease,()=>runtime.api.call('/v2/contributions/status',{publicationId:record.publicationId}));
      if(status.publicationId!==record.publicationId)throw Error('contribution_original_receipt_mismatch');
      const matches=record.kind==='publish'?status.payloadHash===record.payloadHash:status.revokeOperationId===record.operationId&&status.revokePayloadHash===record.payloadHash;
      const state=matches?status.state:record.kind==='publish'?status.state==='absent'?'unconfirmed':'conflict':status.revokeOperationId?'conflict':'unconfirmed';
      await update(lease,current=>({...current,previousOperations:(current.previousOperations??[]).map(row=>row.operationId===operationId?{...row,receiptState:state,checkedAt:now()}:row)}));
      return{operationId,publicationId:record.publicationId,state,currentState:status.state,exactOperationConfirmed:matches};
    }),
    refresh:async()=>{const lease=capture(),state=await load(lease),items=[];
      for(const row of state.publications)items.push({...row,...await guarded(lease,()=>runtime.api.call('/v2/contributions/status',{publicationId:row.publicationId}))});
      check(lease);return items;
    },
  };map.set(subjectId,client);return client;
}
