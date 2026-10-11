import * as z from 'zod/v4';
import {randomUUID,createHash} from 'node:crypto';
import {capsuleVersionV2Schema,capsuleUseV2Schema} from '../../packages/galaxy-official/src/shared/capsule-v2-schema.mjs';
import {factReferenceSchema} from '../../packages/galaxy-official/src/shared/cases-schema.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
const ref=value=>({id:value.id,version:value.version});
const same=(a,b)=>a?.id===b?.id&&a?.version===b?.version;
const purposeName=action=>({publish:'方法保存',apply:'实际应用',reverify:'再次验证',reference:'方法引用'}[action]);
const fail=code=>{throw Object.assign(Error(code),{code});};
const fingerprint=runtime=>{const a=runtime.api.snapshot();return JSON.stringify([runtime.api.endpoint,a?.subjectId,a?.bindingId,a?.generation]);};
const latest=rows=>[...new Map(rows.filter(r=>!r.supersededInVisibleHistory).sort((a,b)=>a.version-b.version).map(r=>[r.id,r])).values()];
function originOf(view,result){return view[result.origin?.kind==='attempt'?'attempts':'interventions']?.find(f=>same(f,result.origin)&&f.actorId===result.actorId);}
function currentResults(view,subjectId,action){return latest(view.results??[]).filter(r=>r.provenance==='native-v2'
 &&(action==='publish'?r.reportedOutcome==='succeeded':r.actorId===subjectId)&&originOf(view,r));}
function matchingVerificationRefs(records,result){return(records??[]).filter(v=>v.type==='verification'&&v.record
 &&v.referenceStatus!=='unavailable'&&v.record.target?.type==='result'&&same(v.record.target,result)).map(ref);}
const methodSchema=z.strictObject(Object.fromEntries(['title','problemPattern','environment','solutionStrategy','tools','skills','mcpRefs',
 'verificationMethod','limitations','capabilityId','applicableScope','license'].map(key=>[key,capsuleVersionV2Schema.shape[key]])));
const audience={visibility:z.enum(['Private','Public']).default('Private'),viewers:z.array(z.string().regex(/^GUID[0-9A-Z]{28}$/)).max(16).default([])};
const prepareSchema=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('publish'),caseId:z.uuid(),resultRef:factReferenceSchema,taskId:z.uuid().optional(),
  capsuleId:z.uuid().optional(),method:methodSchema,...audience}),
 z.strictObject({action:z.enum(['apply','reverify']),caseId:z.uuid(),resultRef:factReferenceSchema,taskId:z.uuid().optional(),
  capsuleId:z.uuid(),versionId:z.uuid(),note:z.string().trim().min(1).max(1600).optional(),adoptedParts:z.array(z.string().trim().min(1).max(1600)).min(1).max(16).optional(),
  environmentDifference:z.string().trim().min(1).max(1600).optional(),configurationRef:factReferenceSchema.optional(),
  verificationRefs:z.array(factReferenceSchema).max(16).default([]),...audience}),
 z.strictObject({action:z.literal('reference'),caseId:z.uuid(),taskId:z.uuid().optional(),capsuleId:z.uuid(),versionId:z.uuid(),
  note:z.string().trim().min(1).max(1600),...audience}),
]);

// A purpose flow over existing v2 APIs. Original bytes and their operation are
// retained locally; the existing Native user-choice gate supplies authority.
export function createNativeCapsuleWork(runtime){
 const flights=new Map(),storePrefix='native-capsule-work:'+runtime.api.endpoint+':';
 async function lease(){await runtime.ensureConnection?.();const capture=runtime.receiptStatus.captureLease();capture.assertCurrent();const status=await runtime.status();capture.assertCurrent();
  if(!status.connected||!status.identity)fail('native_connection_choice_required');const owner=fingerprint(runtime);
  return{subjectId:status.identity,owner,assert(){capture.assertCurrent();if(owner!==fingerprint(runtime))fail('capsule_work_identity_changed');}};}
 async function readWithin(l,path,input){l.assert();try{const data=await runtime.api.call(path,input);l.assert();return data;}catch(e){l.assert();throw e;}}
 const key=(subjectId,id)=>storePrefix+subjectId+':'+id;
 async function load(handle,{readOnly=false}={}){const l=await lease(),row=await runtime.store.get(key(l.subjectId,handle));l.assert();
  if(!row||row.subjectId!==l.subjectId)fail('capsule_work_unavailable');if(!readOnly&&row.owner!==l.owner)fail('capsule_work_identity_changed');return{l,row};}
 async function save(l,row){l.assert();await runtime.store.put(key(l.subjectId,row.handle),row);l.assert();}
 async function sources({action,after=null}){const l=await lease(),page=await readWithin(l,'/v2/history/query',{subjectId:l.subjectId,limit:7,after});
  const items=(page.items??[]).filter(w=>w.kind==='case-history'&&w.caseId).map(w=>({caseId:w.caseId,title:w.title??'当前工作',summary:w.summary??'',synthetic:w.synthetic,
   results:currentResults(w,l.subjectId,action).map(r=>({...ref(r),summary:r.summary,reportedOutcome:r.reportedOutcome,
    verificationRefs:matchingVerificationRefs(w.verificationRecords,r)}))})).filter(w=>action==='reference'||w.results.length);
  return{items,nextCursor:page.nextCursor??null,subjectId:l.subjectId};}
 async function work({caseId,taskId}){const l=await lease(),view=await readWithin(l,'/v2/cases/'+caseId+'/read',taskId?{taskId}:{});
  return{...view,subjectId:l.subjectId,title:view.events?.find(e=>e.kind==='case-created')?.title??'当前工作',summary:view.events?.find(e=>e.kind==='case-created')?.summary??''};}
 async function originalWithin(l,input,result,origin){let after;do{const page=await readWithin(l,'/v2/capsules/uses/query',{capsuleId:input.capsuleId,versionId:input.versionId,caseId:input.caseId,limit:20,...(after?{after}:{})});
   const match=(page.items??[]).find(u=>u.subjectId===l.subjectId&&u.kind==='apply'&&u.sourceStatus==='current'&&same(u.record?.resultRef,result)
    &&u.record?.originRef?.kind===origin.kind&&same(u.record.originRef,origin));if(match)return match;after=page.nextAfter;
  }while(after);fail('capsule_application_required');}
 async function originalApplication(input){const l=await lease(),view=await readWithin(l,'/v2/cases/'+input.caseId+'/read',{}),result=currentResults(view,l.subjectId,'reverify').find(r=>same(r,input.resultRef));
  if(!result)fail('capsule_work_current_result_required');return originalWithin(l,input,result,{kind:result.origin.kind,...ref(originOf(view,result))});}
 async function prepare(input){const l=await lease(),view=await readWithin(l,'/v2/cases/'+input.caseId+'/read',input.taskId?{taskId:input.taskId}:{});
  let payload;
  if(input.action==='publish'){
   const result=currentResults(view,l.subjectId,'publish').find(r=>same(r,input.resultRef));if(!result)fail('capsule_work_current_success_required');
   const origin=originOf(view,result),source={kind:result.origin.kind,...ref(origin),caseId:input.caseId};
   if(typeof view.synthetic!=='boolean')fail('capsule_work_native_source_required');
   let previous=null,management=null;if(input.capsuleId){previous=await readWithin(l,'/v2/capsules/read',{capsuleId:input.capsuleId});
    if(previous.authorId!==l.subjectId||previous.version?.schemaVersion!==2)fail('capsule_work_author_required');
    management=(await readWithin(l,'/v2/capsules/versions',{capsuleId:input.capsuleId,limit:1})).management;}
   // Only an already granted, current permission that names selected sources
   // can be reused. Its actual license and allowed public scope must match.
   const permissions=[];let after;
   do{const page=await readWithin(l,'/v2/capsules/permissions/query',{view:'granted',limit:20,...(after?{after}:{})});
    for(const p of page.items??[])if(!p.revoked&&!p.expired&&p.sourceStatus==='current'&&p.payload?.license===input.method.license
     &&(input.visibility!=='Public'||p.payload.allowPublic)&&p.payload.sources?.some(s=>s.caseId===input.caseId
      &&(s.kind===source.kind&&same(s,source)||s.kind==='result'&&same(s,result))))permissions.push(p.permissionId);
    after=page.nextAfter;}while(after&&permissions.length<64);
   payload=capsuleVersionV2Schema.parse({schemaVersion:2,id:randomUUID(),capsuleId:input.capsuleId??randomUUID(),kind:'version',
    expectedRevision:management?.revision??0,version:(management?.publishedVersionCount??0)+1,publicationClass:'formal-source-success',synthetic:view.synthetic,
    ...input.method,contributors:[],sourceResolution:{caseId:input.caseId,resultId:result.id,resultVersion:result.version},
    sourceRefs:[source],permissionRefs:[...new Set(permissions)].slice(0,64),attributionRefs:[],externalReferences:[],redactionConfirmed:true});
   const preview=await readWithin(l,'/v2/capsules/preview',{payload});
   if(!preview.readyForPublicPublication&&!(input.visibility==='Private'&&preview.reason==='capsule_publication_not_permitted'))fail(preview.reason??'capsule_work_source_unavailable');
  }else{
   const capsule=await readWithin(l,'/v2/capsules/read',{capsuleId:input.capsuleId,versionId:input.versionId});
   const data={schemaVersion:2,id:randomUUID(),kind:input.action,capsuleId:input.capsuleId,versionId:input.versionId,
    caseId:input.caseId,attribution:capsule.authorId,note:input.note};
   if(input.action==='reference'){if(input.taskId)data.taskId=input.taskId;payload=capsuleUseV2Schema.parse(data);}
   else{
    if(capsule.newApplicationAllowed!==true||capsule.version?.schemaVersion!==2)fail('capsule_not_applicable');
    if(input.caseId===capsule.version.sourceResolution.caseId)fail('capsule_new_case_required');
    const result=currentResults(view,l.subjectId,input.action).find(r=>same(r,input.resultRef));if(!result)fail('capsule_work_current_result_required');
    const origin=originOf(view,result);if(!origin||origin.actorId!==l.subjectId)fail('capsule_application_author_required');
    const selectedOrigin={kind:result.origin.kind,...ref(origin)},prior=input.action==='reverify'?await originalWithin(l,input,result,selectedOrigin):null;
    if(input.action==='apply'&&(!input.note||!input.adoptedParts?.length))fail('capsule_actual_use_description_required');
    const configurationRef=prior?.record.configurationRef??input.configurationRef;
    let environment=result.origin.kind==='attempt'&&origin.environment?.name&&origin.environment?.version?origin.environment:{name:'unknown',version:'unknown'};
    if(configurationRef){if(result.origin.kind!=='intervention'||!origin.sourceRefs?.some(r=>r.kind==='configuration'&&same(r,configurationRef)))fail('capsule_configuration_not_in_origin');
     const cfg=await readWithin(l,'/v2/configurations/read',configurationRef);if(!cfg.contentAvailable||!cfg.record)fail('capsule_configuration_source_unavailable');
     environment={name:cfg.record.conditions.environment.name??'unknown',version:cfg.record.conditions.environment.version??'unknown'};data.configurationRef=configurationRef;}
    Object.assign(data,{originRef:selectedOrigin,resultRef:ref(result),environment,note:input.note??prior?.record.note,
     environmentDifference:input.environmentDifference??prior?.record.environmentDifference??`本次记录环境：${environment.name} ${environment.version}；方法适用环境：${capsule.version.environment.name} ${capsule.version.environment.version}。兼容性未由这些记录独立确认。`,
     adoptedParts:prior?.record.adoptedParts??input.adoptedParts,outcome:result.reportedOutcome,...(result.taskId?{taskId:result.taskId}:{}),...(result.participationId?{participationId:result.participationId}:{})});
    if(input.action==='reverify'){
     if(!input.verificationRefs.length)fail('capsule_work_verification_required');
     for(const r of input.verificationRefs){const v=await readWithin(l,'/v2/verification-records/read',{type:'verification',...r});
      if(!v.record||v.record.target?.type!=='result'||!same(v.record.target,result))fail('capsule_verification_mismatch');}
     data.priorUseId=prior.eventId;data.verificationRefs=input.verificationRefs;
    }
    payload=capsuleUseV2Schema.parse(data);
   }
  }
  const handle=randomUUID(),payloadJson=JSON.stringify(payload),row={handle,subjectId:l.subjectId,owner:l.owner,state:'prepared',
   action:input.action,payloadJson,payloadHash:hash(payloadJson),consentRequestId:randomUUID(),visibility:input.visibility,viewers:input.viewers,
   title:input.action==='publish'?payload.title:'当前方法的'+({apply:'实际应用',reverify:'再次验证',reference:'引用'}[input.action]),expiresAt:Date.now()+30*60000};
  await save(l,row);const indexKey=key(l.subjectId,'index'),index=await runtime.store.get(indexKey)??[];l.assert();
  await runtime.store.put(indexKey,[...new Set([...index,handle])].slice(-64));l.assert();
  return{handle,state:row.state,action:row.action,title:row.title,payloadJson,visibility:row.visibility,viewers:row.viewers,expiresAt:row.expiresAt};
 }
 async function reconcileWithin(l,row){const receipt=await readWithin(l,'/v2/capsules/receipt',{type:row.action==='publish'?'publication':'use',operationId:JSON.parse(row.payloadJson).id,payloadHash:row.payloadHash});
  if(receipt.state==='acknowledged'){row.state='acknowledged';row.receipt=receipt;await save(l,row);}
  return{state:receipt.state==='absent'?'unknown':receipt.state,handle:row.handle,title:purposeName(row.action),receipt,currentReadPermissionConfirmed:false};}
 async function execute(handle){const{l,row}=await load(handle);if(row.state==='acknowledged')return{state:row.state,handle,title:purposeName(row.action),receipt:row.receipt};
  if(row.state!=='prepared')return reconcileWithin(l,row);if(row.expiresAt<=Date.now())fail('capsule_work_preview_expired');
  if(flights.has(handle))return flights.get(handle);
  const operation=(async()=>{const payload=JSON.parse(row.payloadJson);row.state='authorizing';await save(l,row);
   try{await runtime.authorize({requestId:row.consentRequestId,action:row.action==='publish'?'capsule.publish':'capsule.use',objectId:payload.id,
    payloadJson:row.payloadJson,visibility:row.visibility,viewers:row.viewers},{confirmed:true});l.assert();
    row.state='sending';await save(l,row);await readWithin(l,row.action==='publish'?'/v2/capsules/events':'/v2/capsules/uses',{consentId:row.consentRequestId,payloadJson:row.payloadJson});
    return reconcileWithin(l,row);
   }catch(e){l.assert();row.state='unknown';await save(l,row);try{return await reconcileWithin(l,row);}catch{throw e;}}
  })();flights.set(handle,operation);try{return await operation;}finally{flights.delete(handle);}
 }
 async function status(handle){const{l,row}=await load(handle,{readOnly:true});if(row.state==='prepared')return{state:'prepared',handle,title:purposeName(row.action)};return reconcileWithin(l,row);}
 async function pending(){const l=await lease(),index=await runtime.store.get(key(l.subjectId,'index'))??[],items=[];l.assert();
  for(const handle of index){const row=await runtime.store.get(key(l.subjectId,handle));l.assert();if(row&&row.state!=='acknowledged'&&(row.state!=='prepared'||row.expiresAt>Date.now()))
   items.push({handle,action:row.action,state:row.state,title:purposeName(row.action)});}return{items};}
 async function preview(handle){const{l,row}=await load(handle);l.assert();if(row.state==='prepared'){
  const p=JSON.parse(row.payloadJson);if(row.action==='publish'){const check=await readWithin(l,'/v2/capsules/preview',{payload:p});
   if(!check.readyForPublicPublication&&!(row.visibility==='Private'&&check.reason==='capsule_publication_not_permitted'))fail(check.reason??'capsule_source_unavailable');
  }else{const capsule=await readWithin(l,'/v2/capsules/read',{capsuleId:p.capsuleId,versionId:p.versionId});if(!capsule.version)fail('capsule_source_unavailable');
   if(row.action!=='reference'){if(!capsule.newApplicationAllowed)fail('capsule_not_applicable');const view=await readWithin(l,'/v2/cases/'+p.caseId+'/read',p.taskId?{taskId:p.taskId}:{});
    if(!currentResults(view,l.subjectId,row.action).some(r=>same(r,p.resultRef)))fail('capsule_work_current_result_required');}}
 }return{...row};}
 return{sources,work,prepare,execute,status,preview,pending,originalApplication};
}

export function registerNativeCapsuleWorkTools(server,{runtime,review}){
 const flow=createNativeCapsuleWork(runtime);
 const register=(name,schema,description,run,write=false)=>server.registerTool(name,{inputSchema:schema,description,annotations:{readOnlyHint:!write}},async(input,ctx)=>{
  try{return{content:[{type:'text',text:JSON.stringify(await run(input,ctx))}]};}
  catch(e){return{isError:true,content:[{type:'text',text:JSON.stringify({error:e.code??'capsule_work_unavailable',reconcileOriginal:write})}]};}});
 register('galaxy_capsule_work_sources',z.strictObject({action:z.enum(['publish','apply','reverify','reference']),after:z.string().nullable().optional()}),
  'Choose currently readable existing work and exact reported results. No IDs need to be typed by a person; v1 history is never relabeled as v2.',flow.sources);
 register('galaxy_capsule_work_read',z.strictObject({caseId:z.uuid(),taskId:z.uuid().optional()}),'Read the selected existing v2 work before using its exact results and original origin.',flow.work);
 register('galaxy_capsule_work_application',z.strictObject({caseId:z.uuid(),resultRef:factReferenceSchema,capsuleId:z.uuid(),versionId:z.uuid()}),
  'Read the current exact original application for reverification. Reuse adopted parts and original references without another application declaration.',flow.originalApplication);
 register('galaxy_capsule_work_prepare',prepareSchema,'Prepare a local method publication, actual application or reverification from selected real work. Reuse current source permissions; creates no Consent, publication or reuse.',flow.prepare,true);
 register('galaxy_capsule_work_status',z.strictObject({handle:z.uuid()}),'Reconcile the exact original method operation without resending, exposing old source text, or granting body access.',({handle})=>flow.status(handle));
 register('galaxy_capsule_work_pending',z.strictObject({}),'Choose an original locally retained method operation for read-only reconciliation; no source text or user-entered operation ID is required.',flow.pending);
 server.registerTool('galaxy_capsule_work_execute',{inputSchema:z.strictObject({handle:z.uuid()}),description:'Perform the selected method purpose through the existing actual Native user choice. Preserve this same handle after an unknown result.',annotations:{readOnlyHint:false}},async({handle},ctx)=>{
  try{const preview=await flow.preview(handle);if(preview.state!=='prepared')return{content:[{type:'text',text:JSON.stringify(await flow.status(handle))}]};
   return await review('galaxy_capsule_work_execute',{handle,preview},ctx,()=>flow.execute(handle));
  }catch(e){return{isError:true,content:[{type:'text',text:JSON.stringify({error:e.code??'capsule_work_unavailable',handle,reconcileOriginal:true})}]};}
 });return flow;
}
