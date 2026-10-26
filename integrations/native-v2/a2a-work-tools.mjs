import {randomUUID,createHash} from 'node:crypto';
import * as z from 'zod/v4';
import {a2aPrepareSchema} from './a2a-tools.mjs';
import {createA2aFactsV2} from "../../packages/galaxy-a2a/src/facts/facts-v2.mjs";
import {workerPanelResult} from './compact-app/worker-result.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const id=z.uuid(),peerId=z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const titles={send:'交给所选服务处理',reply:'补充这次工作',cancel:'停止这次工作',result:'保留这次结果'};

// The optional host owns its pinned peer, authorization and durable journal.
// This layer supplies readable current work, exact review and read-only ACK
// recovery. It neither invents a Task locator nor resends an unknown send.
export function registerNativeA2aWorkTools(server,{host,runtime,review,toolMeta,render=workerPanelResult,now=()=>Date.now()}){
 const operations=new Map();let closed=false,preparing=0;
 const capture=()=>{if(closed)fail('a2a_host_closed');const l=runtime.receiptStatus.captureLease();l.assertCurrent();return l;};
 const current=async(l,fn)=>{l.assertCurrent();let v;try{v=await fn();}catch(e){l.assertCurrent();throw e;}l.assertCurrent();if(closed)fail('a2a_host_closed');return v;};
 const facts=createA2aFactsV2({readCase:(caseId,{signal,...input})=>runtime.api.call('/v2/cases/'+caseId+'/read',input,{signal}),
  readTask:(taskId,{signal})=>runtime.api.call('/v2/tasks/'+taskId,undefined,{method:'GET',signal})});
 const peers=()=>host.peers();
 const data=(l,fields={})=>({schemaVersion:1,kind:'galaxy-a2a-panel',viewId:randomUUID(),ownerScope:digest(JSON.stringify([l.subjectId,l.endpoint,l.bindingId,l.generation])),
  checkedAt:new Date(now()).toISOString(),availability:'ready',peers:peers(),associations:[],...fields});
 const prune=()=>{for(const[k,op]of operations)if(op.expiresAt<=now()&&op.state!=='running')operations.delete(k);};
 async function readable(l,p,id,poll=false){let link=await current(l,()=>host.read(p,'get',id)),receipt=null;
  if(link.resultImportV2&&link.resultImportV2.state!=='acknowledged'){receipt=await current(l,()=>host.read(p,'reconcile-result',id));link=await current(l,()=>host.read(p,'get',id));}
  let view;try{view=(await current(l,()=>facts.resolve({caseId:link.caseId,attemptId:link.attemptId,subjectId:l.subjectId,frozen:link.factContext}))).current;}
  catch{l.assertCurrent();return{association:{associationId:id,peerId:p,purpose:'原来的工作'},sourceUnavailable:true,
   ...(receipt?.state==='acknowledged'?{resultReceipt:receipt}:{}),originalOperationRetained:true};}
  if(poll&&link.peer?.taskId&&!['completed','failed','rejected','canceled'].includes(link.peer.state))link=await current(l,()=>host.read(p,'poll',id));
  const title=view.events?.find(e=>e.kind==='case-created')?.title??'当前工作',peer=peers().find(x=>x.id===p);
  return{association:{associationId:id,peerId:p,purpose:title,caseId:link.caseId,attempt:link.factContext?.attemptRef,taskId:link.factContext?.taskId??null},
   peer:link,peerName:peer?.name??p,...(receipt?{resultReceipt:receipt}:{})};
 }
 const register=(name,schema,description,readOnly,fn)=>server.registerTool(name,{inputSchema:schema,description,annotations:{readOnlyHint:readOnly},...(toolMeta?{_meta:toolMeta}:{})},async(input,ctx)=>{
  let l;try{l=capture();return await fn(input,ctx,l);}catch(error){let changed=false;try{l?.assertCurrent();}catch{changed=true;}
   return{isError:true,content:[{type:'text',text:'当前内容暂不可用。原工作和原操作仍保留。'}],structuredContent:{error:changed?'a2a_connection_changed':error.code??'a2a_operation_incomplete',
    ...(error.associationId?{associationId:error.associationId}:{}),originalOperationRetained:true,privateResultWithheld:changed}};
  }});
 register('galaxy_a2a_work_read',z.strictObject({action:z.enum(['list','get','poll']).default('list'),peerId:peerId.optional(),associationId:id.optional()}),
  'Read currently authorized A2A work and readable peer output. Reconcile an original import automatically. Unknown delivery stays unknown; no dispatch, inferred Task or automatic Result.',true,async(input,_ctx,l)=>{
   if(input.action!=='list'){if(!input.peerId||!input.associationId)fail('a2a_original_work_required');return render(data(l,{selected:await readable(l,input.peerId,input.associationId,input.action==='poll')}));}
   const rows=[];let more=false;for(const p of peers()){if(input.peerId&&p.id!==input.peerId)continue;const journal=await current(l,()=>host.read(p.id,'list'));
    for(const link of journal.slice(-32).reverse()){const view=await readable(l,p.id,link.id);rows.push({...view.association,state:view.peer?.peer?.state??view.peer?.status,sourceUnavailable:view.sourceUnavailable});}
    more ||=journal.length>32;}return render(data(l,{associations:rows.slice(0,32),earlierAssociationsAvailable:more||rows.length>32}));
  });
 register('galaxy_a2a_work_prepare',a2aPrepareSchema,
  'Prepare selected text from existing current work, a required follow-up, a cancellation, or a separately selected participant-reported Result. No peer send or cloud fact before a real Native choice.',false,async(input,_ctx,l)=>{
   prune();if(operations.size+preparing>=128)fail('a2a_preview_capacity');preparing++;try{
    const{peerId:p,action,...args}=input,original=await current(l,()=>host.prepare(p,action,args));
    if(original.state==='acknowledged')return render(data(l,{actionResult:{action,peerId:p,associationId:args.associationId,...original,remoteResent:false}}));
    const source=await current(l,()=>runtime.api.call('/v2/cases/'+(original.caseId??original.draft.event.caseId)+'/read',args.taskId?{taskId:args.taskId}:{}));
    const purpose=source.events?.find(e=>e.kind==='case-created')?.title??'当前工作';
    const payloadJson=action==='result'?original.authorization.payloadJson:original.payloadJson,payload=JSON.parse(payloadJson),peer=peers().find(x=>x.id===p);
    if(!peer)fail('a2a_configured_peer_required');
    const handle=randomUUID(),reviewData={action,associationId:original.associationId,peerId:p,peerName:peer.name??p,purpose,
     caseId:payload.caseId,attempt:payload.factContext?.attemptRef,visibility:action==='result'?original.authorization.visibility:'selected-peer',
     recipients:action==='result'?original.authorization.viewers:[payload.peerPrincipal],payloadHash:digest(payloadJson),
     exact:{payloadJson,payload,...(action==='result'?{source:original.draft.source}:{externalEndpoint:peer.endpoint,peerPrincipal:payload.peerPrincipal})}},expiresAt=now()+300000;
    operations.set(handle,{original,reviewData,l,expiresAt,state:'prepared'});return render(data(l,{preview:{handle,previewHash:digest(JSON.stringify(reviewData)),expiresAt:new Date(expiresAt).toISOString(),...reviewData}}));
   }finally{preparing--;}
  });
 register('galaxy_a2a_work_execute',z.strictObject({handle:id,previewHash:z.string().regex(/^[0-9a-f]{64}$/)}),
  'Continue this same exact Native user choice. A completed or unknown handle is read back without sending again. Approval is supplied only by the actual host choice surface.',false,async(input,ctx,l)=>{
   prune();const op=operations.get(input.handle);if(!op||op.expiresAt<=now()||digest(JSON.stringify(op.reviewData))!==input.previewHash)fail('a2a_preview_changed_or_expired');op.l.assertCurrent();
   const retained=()=>data(l,{actionResult:{action:op.reviewData.action,peerId:op.reviewData.peerId,associationId:op.reviewData.associationId,state:op.state,remoteResent:false,originalOperationRetained:true}});
   if(op.state!=='prepared')return render(retained());
   const result=await current(l,()=>review('galaxy_a2a_work_execute',{...input,expiresAt:op.expiresAt,preview:op.reviewData},ctx,async()=>{
    op.l.assertCurrent();if(op.expiresAt<=now())fail('a2a_preview_expired');if(op.state!=='prepared')return retained();op.state='running';
    try{await current(l,()=>host.execute(op.original,{confirmed:true}));op.state='completed';}
    catch(error){op.state='original-operation-needs-reconciliation';error.associationId=op.reviewData.associationId;throw error;}return retained();
   }));
   // Native URL/modern input-required response is preserved exactly; the panel
   // continues only this original handle after the user chooses on that surface.
   if(result?.state==='user-choice-needs-browser'||result?.resultType==='input_required'||result?.content&&!result.structuredContent)return result;
   const value=result.structuredContent??result;return value?.kind==='galaxy-a2a-panel'?render(value):result;
  });
 register('galaxy_a2a_work_abort_local',z.strictObject({handle:id}),
  'Cancel only this local A2A preview or wait. The durable original association remains; a remote CancelTask requires its own explicit current choice.',false,async(input,_ctx,l)=>{
   const op=operations.get(input.handle);if(!op)fail('a2a_preview_unavailable');op.l.assertCurrent();
   if(op.state!=='completed'){await current(l,()=>host.abort(op.original));if(op.state==='prepared')op.state='locally-stopped';}
   return render(data(l,{actionResult:{associationId:op.reviewData.associationId,peerId:op.reviewData.peerId,localStopped:op.state==='locally-stopped',remoteCanceled:false,originalOperationRetained:true}}));
  });
 return{close(){closed=true;for(const op of operations.values())if(op.state!=='completed')try{host.abort(op.original);}catch{}operations.clear();}};
}
