import {createHash} from 'node:crypto';
import * as z from 'zod/v4';
import {browserScopes} from '../../packages/galaxy-official/src/browser-client.mjs';
import {navigationSchema} from '../../packages/galaxy-edge-mcp/src/native-v2/navigation.mjs';
import {createWebIdentityHandoff,isWebIdentityTargetPath} from '../../packages/galaxy-edge-mcp/src/native-v2/web-identity-handoff.mjs';
import {nativeResult} from '../../packages/galaxy-edge-mcp/src/native-v2/choice.mjs';

export const webIdentityDefaultScopes=Object.freeze(['binding','consent','case-teaser','history','assistance','context']);
export const webIdentityConnectSchema=z.strictObject({...navigationSchema.shape,requestId:z.uuid(),
 continueWith:z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('capsule'),id:z.uuid(),versionId:z.uuid()}),
  z.strictObject({kind:z.literal('method-search'),query:z.string().trim().min(1).max(200).refine(value=>!/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value))})
 ]).optional(),
 scopes:z.array(z.enum(browserScopes)).min(1).max(browserScopes.length).refine(values=>values.includes('binding')&&new Set(values).size===values.length).default([...webIdentityDefaultScopes])})
 .refine(input=>!input.continueWith||input.object.kind==='task','Method continuation requires the original Task')
 .refine(input=>input.continueWith?.kind!=='method-search'||input.scopes.includes('capsules'),'Method search requires its requested method-reading scope');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const codeOf=reason=>/^[a-z0-9_-]{1,100}$/.test(reason?.code??reason?.message??'')?reason.code??reason.message:'web_identity_operation_failed';
const inputHash=input=>createHash('sha256').update(JSON.stringify(input)).digest('hex');

// Preparation opens only the configured local user surface. Device approval
// is never a model-provided boolean: it happens in that surface's explicit POST.
export function registerNativeIdentityWebConnectTools(server,{runtime}){
 const entries=new Map(),building=new Map();let closed=false;
 const key=id=>'web-identity-connect-request:'+runtime.api.endpoint+':'+id;
 const publicStatus=(row,url=null)=>({handoffId:row.handoffId,navigationId:row.navigationId,subjectId:row.subjectId,targetPath:row.targetPath,
  expiresAt:row.expiresAt,state:row.state,operationId:row.operationId??null,deviceAuthorizationVerified:row.deviceAuthorizationVerified===true,
  webConnectionReported:row.webConnectionReported===true,websiteConnectionIndependentlyVerified:false,transportAvailable:url!==null&&row.transportClosed!==true,url:row.transportClosed?null:url,
  publicPacketsOnly:true,originalWorkRef:'native-local-only',returnMode:'galaxy_return'});
 function captureLease(){
  if(closed)fail('web_identity_transport_closed');
  if(typeof runtime.receiptStatus?.captureLease!=='function')fail('web_identity_owner_lease_required');
  return runtime.receiptStatus.captureLease();
 }
 async function current(lease){
  if(closed)fail('web_identity_transport_closed');lease.assertCurrent();
  const status=await runtime.status();lease.assertCurrent();if(closed)fail('web_identity_transport_closed');
  if(!status.identity||status.identity!==lease.subjectId)fail('native_identity_required');return status;
 }
 async function prepare(raw){
  const input=webIdentityConnectSchema.parse(raw),lease=captureLease(),hash=inputHash(input),id=input.requestId,status=await current(lease);
  const existing=entries.get(id);
  if(existing){if(existing.hash!==hash||existing.subjectId!==status.identity)fail('web_identity_request_changed');
   existing.owner.assertCurrent();return publicStatus(existing.bridge.status(),existing.bridge.url);}
  const inProgress=building.get(id);
  if(inProgress){if(inProgress.hash!==hash||inProgress.subjectId!==status.identity)fail('web_identity_request_changed');
   const result=await inProgress.promise;lease.assertCurrent();return result;}
  const start=(async()=>{
   const retained=await runtime.store.get(key(id));await current(lease);
   if(retained){
    if(retained.inputHash!==hash||retained.subjectId!==status.identity)fail('web_identity_request_changed');
    const saved=await runtime.store.get('web-identity-handoff:'+id);lease.assertCurrent();
    return{...publicStatus(saved??retained),state:saved?.state??'transport-unavailable',originalJournalPreserved:true,
     transportRestarted:false,nextAction:'query-original-device-operation'};
   }
   const owner=await runtime.prepareWebIdentityContext(input.scopes);lease.assertCurrent();owner.assertCurrent();
   const navigation=await runtime.navigation.prepare({object:input.object,...(input.origin?{origin:input.origin}:{})});owner.assertCurrent();
   const originalReturn='/app/tasks/'+input.object.id+'?section=collaboration';
   const targetPath=input.continueWith?.kind==='method-search'?'/app/search?'+new URLSearchParams({q:input.continueWith.query,sourceTask:input.object.id,returnTo:originalReturn}).toString()
    :input.continueWith?'/app/capsules/'+input.continueWith.id+'/versions/'+input.continueWith.versionId+'?'
     +new URLSearchParams({sourceTask:input.object.id,returnTo:originalReturn}).toString():navigation.targetPath;
   if(!isWebIdentityTargetPath(targetPath))fail('web_identity_target_required');
   const beforeApprove=async()=>{
    owner.assertCurrent();const original=await runtime.navigation.resume(navigation.navigationId);owner.assertCurrent();
    if(original.state==='unavailable'||JSON.stringify(original.object)!==JSON.stringify(input.object))fail('web_identity_original_target_unavailable');
   };
   await runtime.store.put(key(id),{handoffId:id,navigationId:navigation.navigationId,subjectId:owner.context.subjectId,targetPath,
    inputHash:hash,state:'preparing',operationId:null});owner.assertCurrent();
   let bridge;
   try{
    bridge=await createWebIdentityHandoff({handoffId:id,navigationId:navigation.navigationId,context:owner.context,targetPath,
     store:runtime.store,assertCurrent:owner.assertCurrent,assertControl:owner.assertControl,readControl:owner.readControl,signContext:owner.signContext,
     previewOffer:runtime.device.previewOffer,approveOffer:offer=>runtime.device.approve(offer,{scopes:offer.scopes,confirmed:true}),beforeApprove,
     now:runtime.now,...(owner.openBrowser?{openBrowser:owner.openBrowser}:{})});
    if(closed){await bridge.close();fail('web_identity_transport_closed');}owner.assertCurrent();
    entries.set(id,{bridge,owner,hash,subjectId:owner.context.subjectId});await bridge.open();owner.assertCurrent();
    return publicStatus(bridge.status(),bridge.url);
   }catch(reason){if(bridge)await bridge.close();throw reason;}
  })();
  building.set(id,{hash,subjectId:status.identity,promise:start});
  try{const result=await start;lease.assertCurrent();return result;}finally{building.delete(id);}
 }
 async function status({handoffId}){
  const lease=captureLease(),native=await current(lease),entry=entries.get(handoffId);
  if(entry){if(entry.subjectId!==native.identity)fail('web_identity_request_changed');entry.owner.assertCurrent();return publicStatus(entry.bridge.status(),entry.bridge.url);}
  const retained=await runtime.store.get(key(handoffId));lease.assertCurrent();if(!retained||retained.subjectId!==native.identity)fail('web_identity_request_unavailable');
  const row=await runtime.store.get('web-identity-handoff:'+handoffId);lease.assertCurrent();return{...publicStatus(row??retained),originalJournalPreserved:true,transportRestarted:false};
 }
 const wrap=run=>async(input)=>{try{return nativeResult(await run(input));}catch(reason){return{isError:true,...nativeResult({error:codeOf(reason),originalOperationPreserved:true})};}};
 server.registerTool('galaxy_identity_web_connect',{inputSchema:webIdentityConnectSchema,
  description:'Prepare a temporary local user page to connect the website to this existing current Native identity and original object. An original Task may continue with an exact Capsule/version or a method-search query; both return to that same Task. Search uses only the approved query, not a private original workRef. The website generates its own device key; only the user can approve the shown device/scopes. Preserve requestId after unknown delivery. No key, recovery code, original workRef or bearer is copied.',
  annotations:{readOnlyHint:false}},wrap(prepare));
 server.registerTool('galaxy_identity_web_connect_status',{inputSchema:z.strictObject({handoffId:z.uuid()}),
  description:'Read this Native owner’s existing website-connect transport and original operation locator. Does not approve, create another identity, retry a remote operation or prove a website session.',annotations:{readOnlyHint:true}},wrap(status));
 async function close(){
  closed=true;
  const results=await Promise.allSettled([...entries.values()].map(entry=>entry.bridge.close()));
  await Promise.allSettled([...building.values()].map(entry=>entry.promise));
  const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
  if(errors.length)throw new AggregateError(errors,'web_identity_transport_cleanup_failed');
 }
 return{prepare,status,close};
}
