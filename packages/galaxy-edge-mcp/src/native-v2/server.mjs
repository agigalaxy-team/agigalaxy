import {McpServer} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {nativeHttpDefinitions} from './http-tools.mjs';
import {createNativeChoice,nativeResult} from './choice.mjs';
import {navigationSchema} from './navigation.mjs';
import {nativeWatchStartSchema,nativeWatchResumeSchema,createNativeWatch} from './watch.mjs';
import {createNativeWatchRuntime} from './watch-runtime.mjs';
import {registerNativeWatchControlTools} from './watch-control-tools.mjs';
import {consentSchema} from '../../../galaxy-official/src/shared/consents-schema.mjs';
import {createPersonalSummaryLocal} from '../../../galaxy-official/src/personal-summary-local.mjs';
import {createPersonalSummaryClient} from '../../../galaxy-official/src/personal-summary-client.mjs';
import {summaryContentSchema} from '../../../galaxy-official/src/shared/personal-summary-schema.mjs';
import {previewGalaxyIntegration} from '../../../galaxy-core/src/local-store.mjs';
import {registerHelpTools} from '../help-tools-v2.mjs';
import {registerNativeA2aTools} from '../../../../integrations/native-v2/a2a-tools.mjs';
import {registerNativeTrustTools} from '../../../../integrations/native-v2/trust-tools.mjs';
import {registerNativeIdentityGroupTools} from '../../../../integrations/native-v2/identity-group-tools.mjs';
import {registerNativeCompactApps} from '../../../../integrations/native-v2/compact-app/server.mjs';

export function createNativeToolServer(runtime,{a2aHost,compactArtifact}={}){
 let currentSubject='';const choice=createNativeChoice({identity:()=>currentSubject,website:runtime.website,store:runtime.store});
 const server=new McpServer({name:'galaxy-native-v2',version:'0.2.0'},{requestState:{verify:choice.verify},instructions:
  'Galaxy supplies shared data and collaboration, not model inference. Use the Galaxy skill to judge when to help; no fixed attempt count. Active match, publish and participate coexist. Four help paths are current AI, Capsule/history, open assistance and bounty/expert. Do not treat history as all help. Use existing exact Consent or Agent grants directly; new scope requires an actual user choice. Private summaries default local. Browser launch is not a delivered business action.'});
 const a2a=a2aHost?registerNativeA2aTools(server,{host:a2aHost,runtime,review:async(name,input,ctx,operation)=>{
  currentSubject=(await runtime.status()).identity??'';return choice.run(server,name,input,ctx,operation);
 }}):null;
 const trust=runtime.trustPackages?registerNativeTrustTools(server,{runtime,review:async(name,input,ctx,operation)=>{
  currentSubject=(await runtime.status()).identity??'';return choice.run(server,name,input,ctx,operation);
 }}):null;
 const identityGroups=registerNativeIdentityGroupTools(server,{runtime,review:async(name,input,ctx,operation)=>{
  currentSubject=(await runtime.status()).identity??'';return choice.run(server,name,input,ctx,operation);
 }});
 const compact=compactArtifact?registerNativeCompactApps(server,{runtime,artifact:compactArtifact}):null;
 const cleanup=()=>{a2a?.close();trust?.close();identityGroups.close();compact?.close?.();choice.close();};
 const previousClose=server.server.onclose;server.server.onclose=()=>{cleanup();previousClose?.();};
 const close=server.close.bind(server);server.close=async()=>{cleanup();await close();};
 registerHelpTools(server,{flow:runtime.helpFlow});
 const register=(name,schema,description,run,{write=false,needsChoice=false}={})=>server.registerTool(name,{inputSchema:schema,description,annotations:{readOnlyHint:!write}},async(input,ctx)=>{
  try{currentSubject=(await runtime.status()).identity??'';if(needsChoice)return await choice.run(server,name,input,ctx,()=>run(input));return nativeResult(await run(input));}
  catch(error){const code=/^[a-z0-9_-]{1,100}$/.test(error.code??error.message)?error.code??error.message:'native_operation_failed';
   return{isError:true,...nativeResult({error:code,mayNeedReceiptReconciliation:write})};}});
 register('galaxy_native_status',z.strictObject({}),'Read actual local/native connection and capability state. Does not initialize, connect or start a model.',()=>runtime.status());
 register('galaxy_command',z.strictObject({command:z.enum(['open','help','language','status','connect','setup','case','privacy','worker','hub','website']).default('open'),language:z.enum(['zh-CN','en-US']).optional(),stage:z.number().int().min(1).max(5).optional()}),
  'Preserved local five-stage /galaxy command contract. Opening an existing installation never initializes it again.',({command,...options})=>runtime.command(command,options));
 const init=z.strictObject({initializationPath:z.enum(['personal-galaxy','galaxy-worker','galaxy-hub']).optional(),profile:z.enum(['minimal','coding-case','agent-workspace']).optional(),modules:z.array(z.string().min(2).max(80)).max(8).optional()});
 register('galaxy_native_initialize_preview',init,'Preview local-only initialization choices; no key creation or network.',input=>previewGalaxyIntegration(input));
 register('galaxy_native_initialize',init,'Initialize the reviewed local module choices only. Creates no remote connection.',input=>runtime.initialize(input,{confirmed:true}),{write:true,needsChoice:true});
 register('galaxy_native_connect',z.strictObject({}),'Explicitly bind this device at the configured pinned authority. Local notes and full context are not uploaded.',()=>runtime.connect({confirmed:true}),{write:true,needsChoice:true});
 register('galaxy_native_disconnect',z.strictObject({}),'Stop this native runtime connection and automatic reconnection. This is not remote device revocation.',()=>runtime.disconnect(),{write:true});
 const authorization=z.strictObject({requestId:z.uuid(),action:consentSchema.shape.action,objectId:consentSchema.shape.objectId,payloadJson:z.string().min(2).max(48000),visibility:consentSchema.shape.visibility.default('Private'),viewers:consentSchema.shape.viewers.default([]),expiresAt:z.number().int().positive().optional()});
 server.registerTool('galaxy_native_authorize',{inputSchema:authorization,description:'Authorize only the exact reviewed payload/scope using the local device. Preserve requestId and bytes after missing ACK. Existing saved authorization retries do not ask again.',annotations:{readOnlyHint:false}},async(input,ctx)=>{
  try{currentSubject=(await runtime.status()).identity??'';
   return await runtime.authorizationExists(input)?nativeResult(await runtime.authorize(input)):await choice.run(server,'galaxy_native_authorize',input,ctx,()=>runtime.authorize(input,{confirmed:true}));
  }catch(error){return{isError:true,...nativeResult({error:error.code??'native_authorization_incomplete',requestId:input.requestId,reconcileOriginal:true})};}});
 register('galaxy_open',navigationSchema,'Open a stable object or one active entry in the browser. Local workRef stays on this device; the URL contains no original prompt or credentials.',runtime.navigation.open,{write:true});
 register('galaxy_return',z.strictObject({navigationId:z.uuid()}),'Refresh the same stable object and recover the local origin. Closing the browser does not cancel collaboration.',x=>runtime.navigation.resume(x.navigationId));
 register('galaxy_device_pending',z.strictObject({}),'Read public pending device handoff packets, not private keys or recovery codes.',()=>runtime.device.pending());
 register('galaxy_device_offer',z.strictObject({subjectId:z.string().regex(/^GUID[0-9A-Z]{28}$/)}),'Prepare a public device request for an existing identity. The old device must approve; this does not sign in by email.',x=>runtime.device.offer(x.subjectId,{confirmed:true}),{write:true,needsChoice:true});
 register('galaxy_device_approve',z.strictObject({offer:z.string().min(1).max(24000)}),'Approve this exact public new-device offer on a currently controlling device. Never paste private key or recovery seed.',x=>runtime.device.approve(x.offer,{confirmed:true}),{write:true,needsChoice:true});
 register('galaxy_device_accept',z.strictObject({approval:z.string().min(1).max(24000)}),'On the requesting device, verify public old-device approval and prove possession. Connect is a separate choice.',x=>runtime.device.accept(x.approval,{confirmed:true}),{write:true,needsChoice:true});
 register('galaxy_device_reconcile',z.strictObject({operationId:z.uuid()}),'Check the original device handoff after unknown delivery.',x=>runtime.device.reconcile(x.operationId,{}));
 register('galaxy_device_cancel',z.strictObject({operationId:z.uuid()}),'Cancel this device’s original pending handoff. A committed receipt remains committed; stopping locally is not server revocation.',x=>runtime.device.cancel(x.operationId,{confirmed:true}),{write:true});
 register('galaxy_chat_agent_grants',z.strictObject({roomId:z.uuid(),grantId:z.uuid().optional(),after:z.string().default(''),limit:z.number().int().min(1).max(100).default(50)}),
  'Read current room Agent permissions and their actual binding. Permission does not prove a host loop is running.',({roomId,...x})=>runtime.api.call('/v2/chat/rooms/'+roomId+'/agent-grants',x));
 register('galaxy_chat_agent_grant',z.strictObject({roomId:z.uuid(),grantId:z.uuid(),mode:z.enum(['read','draft','respond']).default('read'),primaryResponder:z.boolean().default(false),expiresAt:z.number().int().positive()}),
  'Choose this native connection’s room Agent scope and expiry. Only an explicitly selected responder may respond. Preserve grantId after an unknown ACK; a new connection needs a newly reviewed grant.',
  async({roomId,...input})=>{
   const old=await runtime.api.call('/v2/chat/rooms/'+roomId+'/agent-grants',{grantId:input.grantId}),bindingId=runtime.api.snapshot()?.bindingId;
   const receipt=old.items?.find(x=>x.grantId===input.grantId);
   if(receipt){if(receipt.bindingId!==bindingId||receipt.mode!==input.mode||receipt.primaryResponder!==input.primaryResponder||receipt.expiresAt!==input.expiresAt)throw new Error('agent_grant_original_scope_changed');
    return{...receipt,reconciled:true,hostRuntimeStarted:false};}
   return runtime.api.call('/v2/chat/rooms/'+roomId+'/agent-grant',{...input,bindingId});
  },{write:true,needsChoice:true});
 register('galaxy_chat_agent_revoke',z.strictObject({roomId:z.uuid(),grantId:z.uuid()}),'Revoke an owned room Agent grant. Future service calls are denied; the host must separately confirm an already running model stopped.',
  ({roomId,...x})=>runtime.api.call('/v2/chat/rooms/'+roomId+'/agent-revoke',x),{write:true});
 const definitions=nativeHttpDefinitions(runtime.api);
 // These operations introduce a new user-selected scope; ordinary delegated
 // sends/queries, exact signed payloads and same-operation retries do not.
 const choices=new Set(['galaxy_personal_summary_preferences_save','galaxy_personal_summary_delete','galaxy_inbox_options_save','galaxy_chat_create','galaxy_chat_vote','galaxy_chat_propose','galaxy_chat_accept_invitation','galaxy_chat_leave','galaxy_project_v2_preferences_save','galaxy_choice_preferences_save','galaxy_choice_delete']);
 for(const[name,tool]of Object.entries(definitions))register(name,tool.inputSchema,tool.description,tool.run,{write:tool.write,needsChoice:choices.has(name)});
 registerNativeWatchControlTools(register,runtime);
 const watches=new Map(),watchRuntimes=new Map(),summaries=new Map(),summaryClient=createPersonalSummaryClient(runtime.api);async function owner(){const id=(await runtime.status()).identity;if(!id)throw new Error('native_identity_required');return id;}
 async function watch(){const id=await owner();if(!watches.has(id))watches.set(id,createNativeWatch({store:runtime.store,api:runtime.api,subjectId:id,now:runtime.now}));return watches.get(id);}
 async function watchRuntime(){const id=await owner();let current=watchRuntimes.get(id);if(current)return current;const source=await watch();current=createNativeWatchRuntime({watch:source,now:runtime.now});watchRuntimes.set(id,current);
  // Rebind persisted active watches when a host process starts again. This
  // restores bounded host timers only; it never performs an implicit check or
  // acknowledges work, and expired/revoked watches remain inactive.
  const snapshot=await source.status();
  for(const row of snapshot.items??[])if(row.state==='active')await current.activate(row.id,{checkNow:false});
  return current;}
 register('galaxy_watch_start',nativeWatchStartSchema,'Opt into a bounded room purpose using an existing current Agent grant. Host-driven checks only, no background model or cloud inference is started.',async x=>{const started=await (await watch()).start(x,{confirmed:true}),id=started.items?.[0]?.id;if(id)await (await watchRuntime()).activate(id,{checkNow:false});return started;},{write:true,needsChoice:true});
 register('galaxy_watch_status',z.strictObject({id:z.uuid().optional()}),'Read actual local watch state, including host suspension. Permission is not evidence of a running host loop. Reading status does not activate timers.',async x=>{
  const current=watchRuntimes.get(await owner());if(current)return current.status(x.id);
  const observer=createNativeWatchRuntime({watch:await watch(),now:runtime.now});
  try{return await observer.status(x.id);}finally{await observer.dispose();}
 });
 register('galaxy_watch_check',z.strictObject({id:z.uuid()}),'Host-driven check under existing watch permission. Unchanged data triggers zero model calls; returned work is for the user Agent to process.',async x=>{const r=await watchRuntime();if(!r.isActive(x.id))await r.activate(x.id,{checkNow:false});return r.check(x.id,'manual');});
 register('galaxy_watch_ack',z.strictObject({id:z.uuid(),workId:z.uuid()}),'Acknowledge only actually processed work. Updates an Agent cursor, never human read.',async x=>{const r=await watchRuntime();if(!r.isActive(x.id))await r.activate(x.id,{checkNow:false});return r.ack(x.id,x.workId);},{write:true});
 register('galaxy_watch_pause',z.strictObject({id:z.uuid()}),'Pause this local watch and revoke its exact room Agent grant. It can resume only after a new current grant is explicitly selected; external process cancellation remains host-confirmed.',async x=>{const r=await watchRuntime();return r.isActive(x.id)?r.pause(x.id):(await watch()).pause(x.id);},{write:true,needsChoice:true});
 register('galaxy_watch_resume',nativeWatchResumeSchema,'Resume one paused watch with a newly selected current room Agent grant and explicit expiry. It never reuses the old grant.',async x=>(await watch()).resume(x,{confirmed:true}),{write:true,needsChoice:true});
 register('galaxy_watch_stop',z.strictObject({id:z.uuid()}),'Stop local checks and revoke only this watch’s room Agent permission. Retry the same watch ID when revocation is unconfirmed, even if already stopped. Actual external Agent interruption must be confirmed by the host.',async x=>{const r=await watchRuntime();return r.isActive(x.id)?r.stop(x.id):(await watch()).stop(x.id);},{write:true});
 async function summary(){const id=await owner();if(!summaries.has(id))summaries.set(id,createPersonalSummaryLocal({subjectId:id,store:runtime.store,now:runtime.now,
  getConnection:()=>{const s=runtime.api.snapshot();return s?{...s,endpoint:runtime.api.endpoint,client:summaryClient}:null;},
  sourceCheck:async({roomId,...ref})=>{const r=await runtime.api.call('/v2/personal-summaries/sources',{roomId,refs:[ref]});return r.items?.[0]??{available:false,temporarilyUnavailable:true};}}));return summaries.get(id);}
 register('galaxy_summary_local_save',z.strictObject({summaryId:z.uuid().optional(),roomId:z.uuid(),expectedLocalRevision:z.number().int().nonnegative().default(0),content:summaryContentSchema}),
  'Save the user-model/manual summary on this device only. No private cloud opt-in, room sharing, or model call occurs.',async x=>(await summary()).save({...x,endpoint:runtime.api.endpoint}),{write:true});
 register('galaxy_summary_local_get',z.strictObject({summaryId:z.uuid()}),'Read local notes with current selected-source permission filtering; unavailable room text is withheld.',async x=>(await summary()).get(x));
 register('galaxy_summary_local_list',z.strictObject({}),'List local summary metadata. Cloud replicas are a separate explicitly enabled flow.',async()=>(await summary()).list());
 register('galaxy_summary_local_status',z.strictObject({}),'Read this device’s private cloud synchronization choice, pending queue and model state.',async()=>(await summary()).status());
 register('galaxy_summary_sync_choice',z.strictObject({enabled:z.boolean(),roomIds:z.array(z.uuid()).max(256).nullable().default(null),includeExisting:z.boolean().default(true)}),
  'Explicitly select whether and which local room summaries may synchronize privately to the configured authority. Room sharing remains separate.',async x=>(await summary()).choose({...x,endpoint:runtime.api.endpoint},{confirmed:true}),{write:true,needsChoice:true});
 register('galaxy_summary_sync',z.strictObject({}),'Synchronize eligible local summaries under an already saved opt-in. Does not opt in or publish room messages; preserves conflicts and original unknown version IDs.',async()=>(await summary()).synchronize(),{write:true});
 server.close=async()=>{for(const current of watchRuntimes.values())await current.dispose();watchRuntimes.clear();watches.clear();summaries.clear();};
 return server;
}
