import * as z from 'zod/v4';
import {randomUUID,createHash} from 'node:crypto';
import {contactEventV2Schema} from '../../packages/galaxy-official/src/shared/contacts-schema-v2.mjs';
import {queryContextV2Schema,opportunityRefV2Schema} from '../../packages/galaxy-official/src/shared/discovery-schema-v2.mjs';
import {readProfileDisplayNames} from "../../packages/galaxy-official/src/accounts/profile-display-names.mjs";

const digest=text=>createHash('sha256').update(text).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const titles={send:'发起联系',accept:'接受这次交流',decline:'谢绝这次交流',withdraw:'撤回这次联系'};
const prepareSchema=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('send'),context:queryContextV2Schema,opportunityRef:opportunityRefV2Schema,
  purpose:z.enum(['conversation','reuse','collaboration','recruitment']),note:z.string().trim().min(1).max(2000),roomTitle:z.string().trim().min(1).max(120).optional()}),
 z.strictObject({action:z.enum(['accept','decline','withdraw']),contactId:z.uuid(),note:z.string().trim().max(2000).default('')}),
]);

// Retain the exact independent Contact and Consent on this device. Discovery
// is a read; sending creates no Task, membership, or recipient acceptance.
export function createNativeContactWork(runtime){
 const flights=new Map(),prefix='native-contact-work:'+runtime.api.endpoint+':';let queue=Promise.resolve();
 const fingerprint=()=>{const c=runtime.api.snapshot();return JSON.stringify([runtime.api.endpoint,c?.subjectId,c?.bindingId,c?.generation]);};
 async function lease(){const original=runtime.receiptStatus.captureLease();original.assertCurrent();const status=await runtime.status();original.assertCurrent();
  if(!status.identity||!status.connected)fail('native_connection_choice_required');const owner=fingerprint();
  return{subjectId:status.identity,owner,assert(){original.assertCurrent();if(owner!==fingerprint())fail('contact_work_identity_changed');}};}
 const key=(l,id)=>prefix+l.subjectId+':'+id;
 async function call(l,path,input,options){l.assert();try{const result=await runtime.api.call(path,input,options);l.assert();return result;}catch(error){l.assert();throw error;}}
 async function save(l,row){l.assert();await runtime.store.put(key(l,row.handle),row);l.assert();}
 async function load(handle,{readOnly=false}={}){const l=await lease(),row=await runtime.store.get(key(l,handle));l.assert();
  if(!row||row.subjectId!==l.subjectId||digest(row.payloadJson)!==row.payloadHash)fail('contact_work_unavailable');
  if(!readOnly&&row.owner!==l.owner)fail('contact_work_identity_changed');return{l,row};}
 async function current(l,row){const payload=JSON.parse(row.payloadJson);
  if(payload.kind==='send')return(await call(l,'/v2/discovery/detail',{context:payload.context,purposes:[payload.purpose],opportunityRef:payload.opportunityRef,experienceLimit:1})).opportunity;
  const contact=await call(l,'/v2/contacts/'+payload.contactId,undefined,{method:'GET'});
  const role=payload.kind==='withdraw'?contact.initiatorId:contact.recipientId;
  if(role!==l.subjectId||contact.state!=='sent'||contact.revision!==payload.expectedRevision)fail('contact_work_source_changed');return contact;
 }
 async function prepare(input){const l=await lease();const invoke=async()=>{l.assert();let payload,recipient;
   if(input.action==='send'){
    const opportunity=(await call(l,'/v2/discovery/detail',{context:input.context,purposes:[input.purpose],opportunityRef:input.opportunityRef,experienceLimit:1})).opportunity;
    recipient=opportunity.subjectId;
    payload=contactEventV2Schema.parse({kind:'send',operationId:randomUUID(),contactId:randomUUID(),expectedRevision:0,
     recipientId:recipient,context:input.context,opportunityRef:input.opportunityRef,purpose:input.purpose,note:input.note,
     roomTitle:input.roomTitle??opportunity.project.title});
   }else{
    const original=await call(l,'/v2/contacts/'+input.contactId,undefined,{method:'GET'});
    if(original.state!=='sent'||(input.action==='withdraw'?original.initiatorId:original.recipientId)!==l.subjectId)fail('contact_work_source_changed');
    recipient=original.initiatorId===l.subjectId?original.recipientId:original.initiatorId;
    payload=contactEventV2Schema.parse({kind:input.action,operationId:randomUUID(),contactId:original.contactId,expectedRevision:original.revision,note:input.note});
   }
   const index=await runtime.store.get(key(l,'index'))??[];l.assert();
   for(const id of index){const old=await runtime.store.get(key(l,id));l.assert();if(old&&!['acknowledged','stopped','canceled'].includes(old.state)&&JSON.parse(old.payloadJson).contactId===payload.contactId)fail('contact_work_original_pending');}
   const payloadJson=JSON.stringify(payload),row={handle:randomUUID(),subjectId:l.subjectId,owner:l.owner,action:input.action,state:'prepared',
    title:titles[input.action],payloadJson,payloadHash:digest(payloadJson),consentRequestId:randomUUID(),visibility:'Private',viewers:[recipient],expiresAt:Date.now()+30*60000,consentExpiresAt:runtime.now()+2591900};
   await save(l,row);await runtime.store.put(key(l,'index'),[...index,row.handle]);l.assert();return previewWithin(l,row);
  };const next=queue.then(invoke,invoke);queue=next.catch(()=>{});return next;}
 async function previewWithin(l,row){let relatedContact;
  if(row.state==='prepared'){if(row.expiresAt<=Date.now())fail('contact_work_preview_expired');const selected=await current(l,row);if(row.action!=='send'){
   const original=selected.events?.find(e=>e.kind==='send');if(row.action==='accept'&&(!original||original.contentUnavailable))fail('contact_work_source_changed');
   relatedContact=original&&!original.contentUnavailable?{title:original.roomTitle,note:original.note,purpose:selected.purpose}:undefined;
  }}
  const names=await readProfileDisplayNames((path,input,options)=>call(l,path,input,options),row.viewers,{authenticated:true});l.assert();
  return{handle:row.handle,state:row.state,action:row.action,title:row.title,payloadJson:row.payloadJson,visibility:row.visibility,viewers:row.viewers,
   recipientNames:names.map(item=>item.displayName??item.subjectId),expiresAt:row.expiresAt,relatedContact,consentExpiresAt:row.consentExpiresAt};}
 async function preview(handle){const{l,row}=await load(handle);return previewWithin(l,row);}
 async function reconcileWithin(l,row){if(row.state==='canceled')return{state:'canceled',handle:row.handle,title:row.title,sideEffect:false};
  const p=JSON.parse(row.payloadJson);let contact;
  try{contact=await call(l,'/v2/contacts/'+p.contactId,undefined,{method:'GET'});}catch(error){if(error.status!==404&&error.code!=='contact_not_found')throw error;return{state:row.state==='prepared'?'prepared':'unknown',handle:row.handle,title:row.title};}
  const event=contact.events?.find(e=>e.operationId===p.operationId&&e.subjectId===l.subjectId&&e.kind===p.kind&&e.revision===p.expectedRevision+1);
  if(!event)return{state:row.state==='prepared'?'prepared':'unknown',handle:row.handle,title:row.title};
  row.state='acknowledged';row.receipt={contactId:p.contactId,operationId:p.operationId,appliedRevision:event.revision};await save(l,row);
  return{state:'acknowledged',handle:row.handle,title:row.title,receipt:row.receipt,contact};
 }
 async function execute(handle,{resume=false}={}){if(flights.has(handle))return flights.get(handle);
  const operation=(async()=>{const{l,row}=await load(handle),payload=JSON.parse(row.payloadJson);
   if(resume&&row.state==='prepared')fail('contact_work_original_choice_required');
   if(row.state==='canceled')return reconcileWithin(l,row);
   if(row.state==='acknowledged')return reconcileWithin(l,row);
   if(row.state!=='prepared'){
    const checked=await reconcileWithin(l,row);if(checked.state==='acknowledged'||!resume)return checked;
    if(row.approved!==true)fail('contact_work_original_choice_required');
   }else{await previewWithin(l,row);row.approved=true;}
   row.state='authorizing';await save(l,row);
   try{await runtime.authorize({requestId:row.consentRequestId,action:'contact.write',objectId:payload.operationId,
     payloadJson:row.payloadJson,visibility:row.visibility,viewers:row.viewers,expiresAt:row.consentExpiresAt},{confirmed:true});l.assert();row.state='sending';await save(l,row);
    await call(l,'/v2/contacts',{consentId:row.consentRequestId,payloadJson:row.payloadJson});return reconcileWithin(l,row);
   }catch(error){l.assert();row.state='unknown';await save(l,row);try{return await reconcileWithin(l,row);}catch{throw error;}}
  })();flights.set(handle,operation);try{return await operation;}finally{flights.delete(handle);}}
 // A declined Native choice is local cancellation, not a recipient's Contact
 // response. Archive only an untouched prepared draft and retain its exact
 // bytes, operation and Consent locator. An in-flight/unknown approved action
 // must finish or reconcile rather than being relabeled as canceled.
 async function cancelPrepared(handle){if(flights.has(handle))return flights.get(handle);
  const operation=(async()=>{const{l,row}=await load(handle);
   if(row.state==='prepared'&&row.approved!==true){row.state='canceled';row.choice={state:'declined',recordedAt:Date.now()};await save(l,row);}
   return reconcileWithin(l,row);
  })();flights.set(handle,operation);try{return await operation;}finally{flights.delete(handle);}}
 async function status(handle){const{l,row}=await load(handle,{readOnly:true});return reconcileWithin(l,row);}
 async function pending(){const l=await lease(),index=await runtime.store.get(key(l,'index'))??[],items=[];l.assert();
  for(const id of index){const row=await runtime.store.get(key(l,id));l.assert();if(row&&!['acknowledged','stopped','canceled'].includes(row.state))items.push({handle:id,action:row.action,title:row.title,state:row.state});}return{items};}
 return{prepare,preview,execute,status,pending,cancelPrepared,resume:handle=>execute(handle,{resume:true})};
}

export function registerNativeContactWorkTools(server,{runtime,review}){
 const flow=createNativeContactWork(runtime),register=(name,schema,description,run,write=false)=>server.registerTool(name,{inputSchema:schema,description,annotations:{readOnlyHint:!write}},async(input,ctx)=>{
  try{return{content:[{type:'text',text:JSON.stringify(await run(input,ctx))}]};}catch(error){return{isError:true,content:[{type:'text',text:JSON.stringify({error:error.code??'contact_work_unavailable',handle:input.handle,reconcileOriginal:write})}]};}});
 register('galaxy_contact_work_prepare',prepareSchema,'Prepare one independent contact or response from its exact currently readable opportunity. Private audience is the two actual participants; creates no Consent, Task, room, or acceptance.',flow.prepare,true);
 register('galaxy_contact_work_pending',z.strictObject({}),'Read this identity’s retained original contact operations without a user-entered identifier.',flow.pending);
 register('galaxy_contact_work_status',z.strictObject({handle:z.uuid()}),'Read the original independent contact event by its retained operation and actual author. Never creates a new contact or resends.',({handle})=>flow.status(handle));
 register('galaxy_contact_work_resume',z.strictObject({handle:z.uuid()}),'Continue only this previously user-approved exact Contact, with its original Consent and bytes. Read the original event first; no new invitation, room or choice is created.',({handle})=>flow.resume(handle),true);
 server.registerTool('galaxy_contact_work_execute',{inputSchema:z.strictObject({handle:z.uuid()}),description:'Perform the exact retained contact through the actual Native choice. After unknown delivery reconcile the same original operation; do not prepare a second invitation.',annotations:{readOnlyHint:false}},async({handle},ctx)=>{
  try{const preview=await flow.preview(handle);if(preview.state!=='prepared')return{content:[{type:'text',text:JSON.stringify(await flow.status(handle))}]};
   const result=await review('galaxy_contact_work_execute',{handle,preview},ctx,()=>flow.execute(handle));
   let decision=result.structuredContent;try{decision??=JSON.parse(result.content?.find(item=>item.type==='text')?.text);}catch{/* Input requests are not a completed choice. */}
   if(!result.isError&&decision?.state==='declined'&&decision.sideEffect===false)return{content:[{type:'text',text:JSON.stringify(await flow.cancelPrepared(handle))}]};
   return result;
  }catch(error){return{isError:true,content:[{type:'text',text:JSON.stringify({error:error.code??'contact_work_unavailable',handle,reconcileOriginal:true})}]};}
 });
 return flow;
}
