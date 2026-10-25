import {McpServer} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {nativeHttpDefinitions} from './tools/http.mjs';
import {createNativeChoice,nativeResult} from './interaction/choice.mjs';
import {navigationSchema} from './interaction/navigation.mjs';
import {nativeWatchStartSchema,nativeWatchResumeSchema,createNativeWatch} from './watch/index.mjs';
import {createNativeWatchRuntime} from './watch/runtime.mjs';
import {createConfiguredWatchHost} from './watch/host-config.mjs';
import {registerNativeWatchControlTools} from './watch/control-tools.mjs';
import {registerNativeNotificationTools} from './tools/notifications.mjs';
import {consentSchema} from '../../../galaxy-official/src/shared/consents-schema.mjs';
import {receiptStatusOperationSchema} from '../../../galaxy-official/src/shared/receipt-status-schema.mjs';
import {createPersonalSummaryLocal} from '../../../galaxy-official/src/personal-summary-local.mjs';
import {createPersonalSummaryClient} from '../../../galaxy-official/src/personal-summary-client.mjs';
import {summaryContentSchema} from '../../../galaxy-official/src/shared/personal-summary-schema.mjs';
import {previewGalaxyIntegration} from '../../../galaxy-core/src/local-store.mjs';
import {registerHelpTools} from '../help-tools-v2.mjs';
import {registerNativeA2aTools} from '../../../../integrations/native-v2/a2a-tools.mjs';
import {registerNativeTrustTools} from '../../../../integrations/native-v2/trust-tools.mjs';
import {registerNativeIdentityGroupTools} from '../../../../integrations/native-v2/identity-group-tools.mjs';
import {registerNativeDeviceManagementTools} from '../../../../integrations/native-v2/device-management-tools.mjs';
import {registerNativeIdentityWebConnectTools} from '../../../../integrations/native-v2/identity-web-connect-tools.mjs';
import {registerNativeIdentityAccountTools} from '../../../../integrations/native-v2/identity-link-tools.mjs';
import {registerNativeCompactApps,nativeCompactUiAdvertised} from '../../../../integrations/native-v2/compact-app/server.mjs';
import {registerNativeWorkerTools} from '../../../../integrations/native-v2/worker-tools.mjs';
import {registerNativeCapsuleWorkTools} from '../../../../integrations/native-v2/capsule-work-tools.mjs';
import {registerNativeWorkSelectionTools} from '../../../../integrations/native-v2/work-selection-tools.mjs';
import {registerNativeContactWorkTools} from '../../../../integrations/native-v2/contact-work-tools.mjs';
import {registerNativeA2aWorkTools} from '../../../../integrations/native-v2/a2a-work-tools.mjs';
import {workerPanelResult} from '../../../../integrations/native-v2/compact-app/worker-result.mjs';
import {presentNativeResult} from './interaction/presentation.mjs';
import {createNativeBookmarkSetter,nativeBookmarkSetSchema} from './interaction/bookmarks.mjs';
import {readProfileDisplayNames} from '../../../galaxy-official/src/profile-display-names.mjs';
import {registerWorkContinuationTools} from './work/continuation.mjs';
import {registerNativeLocalWorkTools,nativeUploadPrivacyInputSchema} from './work/local-tools.mjs';
import {nativeDiagnostics,registerDiagnosticTool} from './diagnostics.mjs';

export function createNativeToolServer(runtime,{a2aHost,workerHost,compactArtifact,watchHost,watchHostDriverFactory,notificationOptions}={}){
 const diagnostics=runtime.diagnostics??nativeDiagnostics();
 const configuredHost=createConfiguredWatchHost(watchHost,{createDriver:watchHostDriverFactory});
 let currentSubject='';const choice=createNativeChoice({identity:()=>currentSubject,website:runtime.website,store:runtime.store});
 let closing=false,closed,localClosed;const inFlight=new Set(),outbound=new Set();
 class NativeMcpServer extends McpServer{
  registerTool(name,configuration,handler){
   registerDiagnosticTool(name);
   return super.registerTool(name,configuration,async(...args)=>{
    if(closing)return presentNativeResult(name,{isError:true,...nativeResult({error:'native_runtime_closed',sideEffect:false})});
    const operation=diagnostics.run('tool',()=>handler(...args),{event:'native_tool',tool:name,resultFailed:value=>value?.isError===true});inFlight.add(operation);
    try{return presentNativeResult(name,await operation,{readOnly:configuration.annotations?.readOnlyHint===true});}finally{inFlight.delete(operation);}
   });
  }
 }
 const server=new NativeMcpServer({name:'galaxy-native-v2',version:'0.2.0'},{requestState:{verify:choice.verify},instructions:
  'Galaxy supplies authorized shared data and collaboration, not model inference. Start from the user’s current work and desired result: find help, ask for help, act on messages, then continue that work. Retrieve current background as needed; use structuredContent for exact references rather than exposing raw transport records. Use existing exact Consent or Agent grants directly; new scope requires an actual user choice. Keep original operation identifiers when recovering unknown delivery, and reconcile automatically before proposing a retry. Private summaries default local. Browser launch is not a delivered business action.'});
 const connect=server.connect.bind(server);
 server.connect=transport=>{
  const send=transport.send.bind(transport);
  transport.send=(...args)=>{const operation=Promise.resolve().then(()=>send(...args));outbound.add(operation);operation.then(()=>outbound.delete(operation),()=>outbound.delete(operation));return operation;};
  return connect(transport);
 };
 async function reviewOperation(name,input,ctx,operation,choiceOptions){
   const subjectId=(await runtime.status()).identity??'';
   const localSettingsChoice=['galaxy_local_settings_save','galaxy_work_sync_choice','galaxy_archive_sync_choice'].includes(name);
  currentSubject=subjectId;
  // A new room permission must identify the actual authorized room. This is
  // read-only context for the exact choice; the submitted grant stays unchanged.
  let reviewedInput=input;
  if(name==='galaxy_help_execute_action'&&input.preview?.kind==='task-event'){
   const task=await runtime.api.call('/v2/tasks/'+input.preview.taskId,undefined,{method:'GET'});
   const names=await readProfileDisplayNames((path,body)=>runtime.api.call(path,body),input.preview.recipientIds??[]);
   reviewedInput={...input,preview:{...input.preview,title:task.request.title,
    recipientNames:names.map(row=>row.displayName??row.subjectId)}};
  }
  if(name==='galaxy_chat_agent_grant'){
   const room=await runtime.api.call('/v2/chat/rooms/'+input.roomId+'/read',{});
   reviewedInput={...input,reviewRoom:{roomId:input.roomId,title:room.title}};
  }
  if(name==='galaxy_local_upload_privacy_set'&&input.sessionIds?.length){
   const sessions=await localWork.archive.list({galaxyId:subjectId,limit:100});
   reviewedInput={...input,selectedArchiveSessions:sessions.items.filter(item=>input.sessionIds.includes(item.archiveSessionId)).map(item=>({
    host:item.host,updatedAt:item.updatedAt,messageCount:item.messageCount}))};
  }
  if(name==='galaxy_local_settings_save'||name==='galaxy_work_sync_choice'||name==='galaxy_archive_sync_choice'){
   const key='local-settings-review:'+runtime.api.endpoint+':'+subjectId+':'+input.choiceId;let saved=await runtime.store.get(key);
   if(saved&&JSON.stringify(saved.input)!==JSON.stringify(input))throw new Error('local_settings_original_choice_changed');
    if(!saved){const targets=await localWork.availableAccounts(),target=targets.accounts.find(account=>account.accountId===input.targetAccountId),names=[],workNames=[];
     const title=value=>value&&!['Recorded work','Unprocessed work'].includes(value)?value:'尚未命名的工作';
     for(const source of input.sessions??[]){const work=await localWork.work.get({host:source.host,sessionId:source.sessionId,limit:1});names.push(title(work?.work.title));}
     for(const workId of input.workIds??[]){const work=await localWork.work.get({workId,limit:1});workNames.push(title(work?.work.title));}
     saved={input,targetAccountName:target?.displayName??'所选银河账户',selectedConversationNames:names,selectedWorkNames:workNames};await runtime.store.put(key,saved);
   }
    reviewedInput={...input,targetAccountName:saved.targetAccountName,selectedConversationNames:saved.selectedConversationNames,...(saved.selectedWorkNames?{selectedWorkNames:saved.selectedWorkNames}:{})};
  }
   const snapshot=runtime.api.snapshot?.(),selectedConnection=localSettingsChoice?await runtime.store.readConnection(runtime.api.endpoint):null;
   const authorizationContext={subjectId,endpoint:runtime.api.endpoint,...(localSettingsChoice
    ?{connectionRevision:selectedConnection.revision,deviceId:selectedConnection.active?.deviceId??null}
    :{bindingId:snapshot?.bindingId??null,generation:snapshot?.generation??null})};
   return choice.run(server,name,{...reviewedInput,authorizationContext},ctx,async()=>{
   const identity=(await runtime.status()).identity??'',latest=runtime.api.snapshot?.();
    const currentConnection=localSettingsChoice?await runtime.store.readConnection(runtime.api.endpoint):null;
    if(identity!==subjectId||runtime.api.endpoint!==authorizationContext.endpoint||(localSettingsChoice
     ?currentConnection.revision!==authorizationContext.connectionRevision||(currentConnection.active?.deviceId??null)!==authorizationContext.deviceId
     :(latest?.bindingId??null)!==authorizationContext.bindingId||(latest?.generation??null)!==authorizationContext.generation))throw new Error('native_choice_binding_changed');
   return operation();
  },choiceOptions);
 }
 const a2a=a2aHost?registerNativeA2aTools(server,{host:a2aHost,runtime,review:reviewOperation}):null;
 const trust=runtime.trustPackages?registerNativeTrustTools(server,{runtime,review:reviewOperation}):null;
 const identityGroups=registerNativeIdentityGroupTools(server,{runtime,review:reviewOperation});
 const deviceManagement=runtime.deviceManagement?registerNativeDeviceManagementTools(server,{runtime,review:reviewOperation}):null;
 const webIdentity=runtime.prepareWebIdentityContext?registerNativeIdentityWebConnectTools(server,{runtime}):null;
 const identityAccounts=runtime.identityAccounts?registerNativeIdentityAccountTools(server,{runtime,review:reviewOperation}):null;
 const compact=compactArtifact?registerNativeCompactApps(server,{runtime,artifact:compactArtifact,reviewAction:async({name,input,preview,context,run})=>{
  return reviewOperation(name,{...input,preview},context,run);
 }}):null;
 const workerToolRuntime=workerHost?{receiptStatus:runtime.receiptStatus,api:{endpoint:runtime.api.endpoint,snapshot:runtime.api.snapshot,call:runtime.workerAuthorization.call}}:null;
 const workers=workerHost?registerNativeWorkerTools(server,{flow:workerHost,runtime:workerToolRuntime,review:reviewOperation,
  ...(compact?{toolMeta:{ui:{resourceUri:compact.resourceUri}}}:{}),
  render:data=>workerPanelResult(data,{componentOnly:!!compact&&nativeCompactUiAdvertised(server)})
 }):null;
 const a2aWork=a2aHost?registerNativeA2aWorkTools(server,{host:a2aHost,runtime,review:reviewOperation,
  ...(compact?{toolMeta:{ui:{resourceUri:compact.resourceUri}}}:{}),
  render:data=>workerPanelResult(data,{componentOnly:!!compact&&nativeCompactUiAdvertised(server)})
 }):null;
 const previousClose=server.server.onclose,protocolClose=server.close.bind(server);
 server.server.onclose=()=>{void cleanup().catch(error=>diagnostics.emit({event:'native_runtime',stage:'shutdown',outcome:'failed',error}));previousClose?.();};
 registerHelpTools(server,{flow:runtime.helpFlow,review:reviewOperation});
 registerNativeCapsuleWorkTools(server,{runtime,review:reviewOperation});
 registerNativeWorkSelectionTools(server,{runtime});
 registerNativeContactWorkTools(server,{runtime,review:reviewOperation});
  registerWorkContinuationTools(server,{runtime});
 const register=(name,schema,description,run,{write=false,needsChoice=false,getReviewScope,singleUseChoice=false}={})=>server.registerTool(name,{inputSchema:schema,description,annotations:{readOnlyHint:!write}},async(input,ctx)=>{
  try{currentSubject=(await runtime.status()).identity??'';if(needsChoice){const scopeKey=getReviewScope?.();return await reviewOperation(name,input,ctx,()=>{
   if(getReviewScope&&scopeKey!==getReviewScope())throw Error('native_choice_scope_changed');return run(input);
  },{scopeKey,singleUse:singleUseChoice});}return nativeResult(await run(input));}
  catch(error){const code=/^[a-z0-9_-]{1,100}$/.test(error.code??error.message)?error.code??error.message:'native_operation_failed';
   diagnostics.emit({event:'native_tool',stage:'tool',outcome:'failed',tool:name,error});
   return{isError:true,...nativeResult({error:code,mayNeedReceiptReconciliation:write})};}});
 const localWork=registerNativeLocalWorkTools(register,runtime);
 compact?.registerLocalWork(localWork);
 localWork.startMaintenance();
 register('galaxy_native_status',z.strictObject({}),'Read current local/native state and resume an already selected connection within its original saved scope and current device control. Does not create an identity, grant new scope or start a model.',()=>runtime.status({restoreSelected:true}));
 register('galaxy_profile_names',z.strictObject({subjectIds:z.array(z.string().regex(/^GUID[0-9A-Z]{28}$/)).max(20)}),
  'Read only current permitted self-declared display names for already known subject references. Missing or withdrawn names stay null; no provider identity or old profile fallback.',async({subjectIds})=>{
   const lease=runtime.receiptStatus.captureLease();lease.assertCurrent();
   const names=await readProfileDisplayNames(async(path,input)=>{lease.assertCurrent();let result;
    try{result=await runtime.api.call(path,input);}catch(error){lease.assertCurrent();throw error;}lease.assertCurrent();return result;},subjectIds);
   lease.assertCurrent();return{items:names};
  });
 if(runtime.receiptStatus)register('galaxy_native_receipt_status',receiptStatusOperationSchema,
  'Read only this current local device owner’s exact original Choice receipt, including after the ordinary session expires. Creates no binding or writable session, uploads no original body and never resends the operation.',
  input=>runtime.receiptStatus.query(input));
 register('galaxy_command',z.strictObject({command:z.enum(['open','help','language','status','connect','setup','history','work','case','privacy','worker','hub','website']).default('open'),language:z.enum(['zh-CN','en-US']).optional(),stage:z.number().int().min(1).max(5).optional()}),
  'Open the ordinary local menu, work history or upload settings. Existing installations are not initialized again.',async({command,...options})=>await localWork.command(command)??runtime.command(command,options));
 const init=z.strictObject({initializationPath:z.enum(['personal-galaxy','galaxy-worker','galaxy-hub']).optional(),profile:z.enum(['minimal','coding-case','agent-workspace']).optional(),modules:z.array(z.string().min(2).max(80)).max(8).optional(),subjectType:z.enum(['person','organization']).optional(),uploadPrivacy:nativeUploadPrivacyInputSchema.omit({galaxyId:true}).optional()});
 register('galaxy_native_initialize_preview',init,'Preview local-only initialization choices; no key creation or network.',input=>previewGalaxyIntegration(input));
 register('galaxy_native_initialize',init,'Initialize the reviewed local module choices only. Creates no remote connection.',input=>runtime.initialize(input,{confirmed:true}),{write:true,needsChoice:true});
 register('galaxy_native_connect',z.strictObject({}),'Explicitly bind this device at the configured pinned authority. Local notes and full context are not uploaded. Restore the identity’s existing private-summary choice; an unset choice stays off and can be reviewed separately.',async()=>{
  const connection=await runtime.connect({confirmed:true});
  try{return{...connection,personalSummary:await (await summary()).onBinding()};}
  catch{return{...connection,personalSummary:{state:'refresh-required',syncChoiceInferred:false}};}
 },{write:true,needsChoice:true});
 register('galaxy_native_disconnect',z.strictObject({}),'Stop this native runtime connection and automatic reconnection. This is not remote device revocation.',async()=>{await hostNotifications.disable();return runtime.disconnect();},{write:true});
 const authorization=z.strictObject({requestId:z.uuid(),action:consentSchema.shape.action,objectId:consentSchema.shape.objectId,payloadJson:z.string().min(2).max(48000),visibility:consentSchema.shape.visibility.default('Private'),viewers:consentSchema.shape.viewers.default([]),expiresAt:z.number().int().positive().optional()});
 server.registerTool('galaxy_native_authorize',{inputSchema:authorization,description:'Authorize only the exact reviewed payload/scope using the local device. Preserve requestId and bytes after missing ACK. Existing saved authorization retries do not ask again.',annotations:{readOnlyHint:false}},async(input,ctx)=>{
  try{currentSubject=(await runtime.status()).identity??'';
   return await runtime.authorizationExists(input)?nativeResult(await runtime.authorize(input)):await reviewOperation('galaxy_native_authorize',input,ctx,()=>runtime.authorize(input,{confirmed:true}));
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
 register('galaxy_bookmark_set',nativeBookmarkSetSchema,
  'Save or remove a private bookmark for the user’s selected post, exact method version, project or person. Handles revisions, stable operation IDs and lost responses automatically. This does not follow updates, infer interests, create work or extend source permission.',
  createNativeBookmarkSetter(runtime),{write:true});
 // These operations introduce a new user-selected scope; ordinary delegated
 // sends/queries, exact signed payloads and same-operation retries do not.
 const choices=new Set(['galaxy_personal_summary_preferences_save','galaxy_personal_summary_delete','galaxy_inbox_options_save','galaxy_chat_create','galaxy_chat_vote','galaxy_chat_propose','galaxy_chat_accept_invitation','galaxy_chat_leave','galaxy_project_v2_preferences_save','galaxy_choice_preferences_save','galaxy_choice_delete']);
 for(const[name,tool]of Object.entries(definitions))register(name,tool.inputSchema,tool.description,tool.run,{write:tool.write,needsChoice:choices.has(name)});
 registerNativeWatchControlTools(register,runtime);
 const hostNotifications=registerNativeNotificationTools(register,runtime,notificationOptions);
 const watches=new Map(),watchRuntimes=new Map(),hostDrivers=new Map(),summaries=new Map(),summaryClient=createPersonalSummaryClient(runtime.api);async function owner(){const id=(await runtime.status()).identity;if(!id)throw new Error('native_identity_required');return id;}
 const hostLease=()=>{const s=runtime.api.snapshot();return s?{subjectId:s.subjectId,endpoint:runtime.api.endpoint,bindingId:s.bindingId,generation:s.generation}:null;};
 function hostDriver(id){if(!configuredHost)return null;if(!hostDrivers.has(id))hostDrivers.set(id,configuredHost.createDriver());return hostDrivers.get(id);}
 async function watch(){const id=await owner();if(!watches.has(id))watches.set(id,createNativeWatch({store:runtime.store,api:runtime.api,subjectId:id,now:runtime.now}));return watches.get(id);}
 async function watchRuntime({activatePersisted=true}={}){const id=await owner();if(closing)return null;let current=watchRuntimes.get(id);if(current)return current;const source=await watch();if(closing)return null;current=createNativeWatchRuntime({watch:source,now:runtime.now,hostDriver:hostDriver(id),getHostLease:hostLease});watchRuntimes.set(id,current);
  // Rebind persisted active watches when a host process starts again. This
  // restores bounded host timers only; it never performs an implicit check or
  // acknowledges work, and expired/revoked watches remain inactive.
  const snapshot=activatePersisted?await source.status():null;
  for(const row of snapshot?.items??[])if(row.state==='active'&&!closing)await current.activate(row.id,{checkNow:false});
  return closing?null:current;}
 async function activateWatch(id){if(closing)return false;const current=await watchRuntime();if(!current||closing)return false;try{await current.activate(id,{checkNow:false});return !closing;}catch(error){if(closing)return false;throw error;}}
 const suspended=()=>({state:'suspended-host',modelCalls:0,workSuppressed:true,retryOriginal:true});
 register('galaxy_watch_host_capabilities',z.strictObject({}),'Inspect the configured user host and effective reader restrictions. Creates no conversation or model turn and activates no Watch.',async()=>{
  if(!configuredHost)return{configured:false,modelStarted:false};
  const id=await owner(),before=JSON.stringify(hostLease()),driver=hostDriver(id),capabilities=await driver.capabilities();
  if(before!==JSON.stringify(hostLease())||id!==await owner())throw Error('watch_binding_changed');
  return{configured:true,...capabilities,workingDirectory:configuredHost.configuration.cwd,modelStarted:false};
 });
 register('galaxy_watch_host_activate',z.strictObject({id:z.uuid(),model:z.string().min(1).max(200)}),'Explicitly choose a configured user-host model for one existing active Watch and its exact room grant. Uses the trusted local working directory. No cloud model is supplied; unsupported reader restrictions refuse execution.',async({id,model})=>{
  if(!configuredHost)throw Error('watch_host_not_configured');
  if(configuredHost.configuration.kind==='claude-code'){
   const subject=await owner(),before=JSON.stringify(hostLease()),capabilities=await hostDriver(subject).capabilities();
   if(before!==JSON.stringify(hostLease())||subject!==await owner())throw Error('watch_binding_changed');
   if(closing)return suspended();
   // A selected model cannot prove the effective managed policy of this host.
   // Keep ordinary Watch work available to the user's foreground Agent until
   // the configured driver can actually establish its reader restrictions.
   if(capabilities.backgroundReaderSupported!==true)return{state:'foreground-fallback',reason:capabilities.backgroundReaderReason??'effective-managed-policy-unconfirmed',hostModelEnabled:false,modelStarted:false,modelCalls:0,foregroundFallback:true};
  }
  const current=await watchRuntime({activatePersisted:false});if(!current||closing)return suspended();
  return current.activate(id,{host:{model,cwd:configuredHost.configuration.cwd},confirmed:true,checkNow:false});
 },{write:true,needsChoice:true});
 register('galaxy_watch_host_reconcile',z.strictObject({id:z.uuid(),workId:z.uuid().optional()}),'Read only the original user-host thread/turn result metadata. Does not start a model, replay work, restore a grant or mark a human as having read anything.',async({id,workId})=>{
  if(!configuredHost)throw Error('watch_host_not_configured');
  const current=await watchRuntime({activatePersisted:false});if(!current||closing)return suspended();
  return current.reconcileHost(id,{workId});
 });
 register('galaxy_watch_start',nativeWatchStartSchema,'Opt into a bounded room purpose using an existing current Agent grant. Host-driven checks only, no background model or cloud inference is started.',async x=>{const started=await (await watch()).start(x,{confirmed:true}),id=started.items?.[0]?.id;return{...started,hostRuntimeState:id&&await activateWatch(id)?'running-host':'suspended-host'};},{write:true,needsChoice:true});
 register('galaxy_watch_status',z.strictObject({id:z.uuid().optional()}),'Read actual local watch state, including host suspension. Permission is not evidence of a running host loop. Reading status does not activate timers.',async x=>{
  const current=watchRuntimes.get(await owner());if(current)return current.status(x.id);
  const observer=createNativeWatchRuntime({watch:await watch(),now:runtime.now});
  try{return await observer.status(x.id);}finally{await observer.dispose();}
 });
 register('galaxy_watch_check',z.strictObject({id:z.uuid()}),'Host-driven check under existing watch permission. Unchanged data triggers zero model calls; returned work is for the user Agent to process.',async x=>{const r=await watchRuntime();if(!r||closing)return suspended();if(!r.isActive(x.id))await r.activate(x.id,{checkNow:false});return closing?suspended():r.check(x.id,'manual');});
 register('galaxy_watch_ack',z.strictObject({id:z.uuid(),workId:z.uuid()}),'Acknowledge only actually processed work. Updates an Agent cursor, never human read.',async x=>{const r=await watchRuntime();if(!r||closing)return suspended();if(!r.isActive(x.id))await r.activate(x.id,{checkNow:false});return closing?suspended():r.ack(x.id,x.workId);},{write:true});
 register('galaxy_watch_pause',z.strictObject({id:z.uuid()}),'Pause this local watch and revoke its exact room Agent grant. It can resume only after a new current grant is explicitly selected; external process cancellation remains host-confirmed.',async x=>{const r=await watchRuntime();return r?.isActive(x.id)?r.pause(x.id):(await watch()).pause(x.id);},{write:true,needsChoice:true});
 register('galaxy_watch_resume',nativeWatchResumeSchema,'Resume one paused watch with a newly selected current room Agent grant and explicit expiry. It never reuses the old grant.',async x=>{const resumed=await (await watch()).resume(x,{confirmed:true});return{...resumed,hostRuntimeState:await activateWatch(x.id)?'running-host':'suspended-host'};},{write:true,needsChoice:true});
 register('galaxy_watch_stop',z.strictObject({id:z.uuid()}),'Stop local checks and revoke only this watch’s room Agent permission. Retry the same watch ID when revocation is unconfirmed, even if already stopped. Actual external Agent interruption must be confirmed by the host.',async x=>{const r=await watchRuntime();return r?.isActive(x.id)?r.stop(x.id):(await watch()).stop(x.id);},{write:true});
 async function summary(){const id=await owner();if(!summaries.has(id)){const local=createPersonalSummaryLocal({subjectId:id,store:runtime.store,now:runtime.now,
  getConnection:()=>{const s=runtime.api.snapshot();return s?{...s,endpoint:runtime.api.endpoint,client:summaryClient}:null;},
  sourceCheck:async({roomId,...ref})=>{const r=await runtime.api.call('/v2/personal-summaries/sources',{roomId,refs:[ref]});return r.items?.[0]??{available:false,temporarilyUnavailable:true};}});
  summaries.set(id,Object.freeze(Object.fromEntries(Object.entries(local).map(([name,method])=>[name,async(...args)=>{
   if((await runtime.status()).identity!==id)throw new Error('native_identity_changed');
   const result=await method(...args);
   // Local-only personal notes have no service source refs. They still belong
   // to the captured owner, including across IDB/network await boundaries.
   if((await runtime.status()).identity!==id)throw new Error('native_identity_changed');
   return result;
  }]))));}return summaries.get(id);}
 register('galaxy_summary_local_save',z.strictObject({summaryId:z.uuid().optional(),roomId:z.uuid(),expectedLocalRevision:z.number().int().nonnegative().default(0),content:summaryContentSchema}),
  'Save the user-model/manual summary on this device only. No private cloud opt-in, room sharing, or model call occurs.',async x=>(await summary()).save({...x,endpoint:runtime.api.endpoint}),{write:true});
 register('galaxy_summary_local_get',z.strictObject({summaryId:z.uuid()}),'Read local notes with current selected-source permission filtering; unavailable room text is withheld.',async x=>(await summary()).get(x));
 register('galaxy_summary_local_list',z.strictObject({}),'List local summary metadata. Cloud replicas are a separate explicitly enabled flow.',async()=>(await summary()).list());
 register('galaxy_summary_local_status',z.strictObject({}),'Read this device’s private cloud synchronization choice, pending queue and model state.',async()=>(await summary()).status());
 register('galaxy_summary_sync_choice',z.strictObject({enabled:z.boolean(),roomIds:z.array(z.uuid()).max(256).nullable().default(null),includeExisting:z.boolean().default(true)}),
  'Explicitly select whether and which local room summaries may synchronize privately to the configured authority. Room sharing remains separate.',async x=>(await summary()).choose({...x,endpoint:runtime.api.endpoint},{confirmed:true}),{write:true,needsChoice:true});
 register('galaxy_summary_sync',z.strictObject({}),'Synchronize eligible local summaries under an already saved opt-in. Does not opt in or publish room messages; preserves conflicts and original unknown version IDs.',async()=>(await summary()).synchronize(),{write:true});
 register('galaxy_summary_sync_reconcile',z.strictObject({summaryId:z.uuid(),versionId:z.uuid()}),'Read the original private-summary upload receipt, including after opt-out or source withdrawal. Never resends its body or creates another version.',async x=>(await summary()).reconcile(x),{write:true});
 register('galaxy_summary_binding_refresh',z.strictObject({}),'Restore this identity’s recorded private-summary choice at the current authority. An unset or declined choice never becomes enabled merely by connecting; this may synchronize already authorized queued versions.',async()=>(await summary()).onBinding(),{write:true});
 register('galaxy_summary_sync_pull',z.strictObject({summaryId:z.uuid()}),'Read one owned cloud replica into the local summary store. Preserves independently edited local content and displays both versions as a conflict; does not share to the room.',async x=>(await summary()).pull(x),{write:true});
 register('galaxy_summary_sync_resolve',z.strictObject({summaryId:z.uuid(),expectedLocalRevision:z.number().int().positive(),content:summaryContentSchema}),
  'Review an explicit merge of local and remote summary versions. Unknown original uploads must be reconciled first; only an existing private-sync opt-in may queue the selected version.',async x=>(await summary()).resolve(x,{confirmed:true}),{write:true,needsChoice:true});
 register('galaxy_summary_cloud_delete',z.strictObject({summaryId:z.uuid()}),'Delete this owned cloud summary replica after current revision and binding checks. The local summary stays; disabling future private synchronization is a separate choice.',async x=>(await summary()).deleteCloud(x,{confirmed:true}),{write:true,needsChoice:true});
 function cleanup(){closing=true;
  // Invalidate device previews before waiting for their in-flight work. The
  // independent control journal survives; a late read cannot create a handle.
  const deviceDrain=deviceManagement?.close();
  const webIdentityDrain=webIdentity?.close();
  const localWorkDrain=localWork.close();
  return localClosed??=Promise.resolve().then(async()=>{
  const drained=await Promise.allSettled([...watchRuntimes.values()].map(current=>current.dispose()).concat([hostNotifications.close()]));
  // Both sets contain native Promises. allSettled consumes them synchronously
  // before yielding, so completion callbacks cannot mutate that iteration.
  await Promise.allSettled(inFlight);
  const lateDrained=await Promise.allSettled([...watchRuntimes.values()].map(current=>current.dispose()));
  const hostOnlyDrained=await Promise.allSettled([...hostDrivers].filter(([id])=>!watchRuntimes.has(id)).map(([,driver])=>driver.close()));
  // Business failures have already been returned to their caller. Only a
  // cleanup failure should make closing fail, and must not skip other owners.
  // The SDK sends a tools/call response after our handler resolves. Let its
  // continuation enqueue that reply, then drain actual transport writes.
  await new Promise(resolve=>setImmediate(resolve));
  await Promise.allSettled(outbound);
  const released=await Promise.allSettled([deviceDrain,webIdentityDrain,localWorkDrain,...[workers,a2aWork,a2a,trust,identityGroups,identityAccounts,compact,choice].filter(Boolean).map(owner=>Promise.resolve().then(()=>owner.close?.()))]);
  watchRuntimes.clear();watches.clear();hostDrivers.clear();summaries.clear();
  const errors=[...drained,...lateDrained,...hostOnlyDrained,...released].filter(result=>result.status==='rejected').map(result=>result.reason);
  if(errors.length)throw new AggregateError(errors,'native_server_cleanup_failed');
 });}
 server.close=()=>{closing=true;return closed??=Promise.resolve().then(async()=>{try{await cleanup();}finally{await protocolClose();}});};
 return server;
}
