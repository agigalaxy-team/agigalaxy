import {lstat} from 'node:fs/promises';
import {maintenanceModuleIds,maintenanceOpeningConditions} from "../../../galaxy-contracts/src/operations/maintenance/catalog.mjs";
import {changeWriter,writerIsRunning,postgresSqlArguments,atomicWrite,ensureDirectory} from '../operations-stack/host.mjs';
import {createOperationsStackPreparation} from './host-restore.mjs';
import {captureDeletionRecoveryContribution} from './deletion-contribution.mjs';
import {captureNativeCurrentFacts,readNativeCurrentFacts} from './current-facts.mjs';
import {verifyCurrentModelConfiguration,currentModelAuthority,modelAuthorityCaptureSql} from './model-preservation.mjs';
import {MaintenancePublicGate} from './public-gate.mjs';
import {MaintenanceCaddyControl} from './caddy-control.mjs';
import {MaintenanceDiscoveryReconciliation} from './discovery-reconciliation.mjs';
import {MaintenanceEngineSecurity} from './engine-security.mjs';
import {MaintenanceHostDatabase} from './host-database.mjs';
import {MaintenanceHostFiles} from './host-files.mjs';
import {MaintenanceNativeHealth} from './native-health.mjs';
import {MaintenanceProsodyCurrentState} from './prosody-current-state.mjs';
import {MaintenanceObjectDeletion} from './object-deletion.mjs';
import {protectedConfigurationFingerprint} from './protected-configuration.mjs';

const fail=code=>Object.assign(Error(code),{code});
const databaseOwners=new Set(['analytics-db','analytics-cache','analytics-events','recommendation-db','recommendation-cache']);
const controlUnits=new Set(['galaxy-api@pilot.service','galaxy-admin-pilot.service']);
const currentIdentity='galaxy-accounts-pilot-keycloak-1';
const backgroundUnits=new Set(['galaxy-worker@pilot.service','galaxy-content-publisher-pilot.service']);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const checks=(ids,value)=>Object.fromEntries(ids.map(id=>[id,value]));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// This gap is independent of native key/identity merge. A daemon process is
// not proof of the real chat component/source readiness contribution.
export function maintenanceNativeAuthorityGaps(moduleIds,{chatProbeConnected=false}={}){
 return[...(moduleIds.includes('chat')&&!chatProbeConnected?['maintenance_current_chat_native_readiness_not_proven']:[]),
  ...(moduleIds.includes('chat')&&chatProbeConnected&&!moduleIds.includes('business')?['maintenance_prosody_current_database_scope_required']:[])];
}

// Not selected by the initial enabled:false deployment. This is the fixed
// production adapter, installed only after its native prerequisites are ready.
// No operation, SQL, native path, stage, command or public route is supplied by
// a browser/model. All effects remain bound to one concrete approved intent.
export function createProductionRestoreAdapters({config,run,controlDirectory,fetchImpl=fetch,prosodyProbe=null,
 gate=new MaintenancePublicGate({controlDirectory,control:new MaintenanceCaddyControl({config,run})}),engines=new MaintenanceEngineSecurity({config,run,controlDirectory,fetchImpl}),
 databases=new MaintenanceHostDatabase({config,run,controlDirectory}),files=new MaintenanceHostFiles({run,controlDirectory}),
 health=new MaintenanceNativeHealth({config,run,fetchImpl}),prepare=createOperationsStackPreparation({config,run}),
 discovery=new MaintenanceDiscoveryReconciliation({config,run,fetchImpl}),
 prosody=new MaintenanceProsodyCurrentState({config,run,controlDirectory,probe:prosodyProbe}),objects=new MaintenanceObjectDeletion({config,run,controlDirectory}),
 captureCurrent=captureNativeCurrentFacts,captureDeletion=captureDeletionRecoveryContribution,fingerprint=protectedConfigurationFingerprint,readinessTimeoutMs=120000,wait=pause,
 verifyModels=facts=>verifyCurrentModelConfiguration({facts,configuration:{operations:config},fetchImpl}),
 loadCurrent=contribution=>readNativeCurrentFacts({contribution,controlDirectory}),
 readModelState=async context=>JSON.parse((await run(config.tools.docker,postgresSqlArguments(config.postgres.find(x=>x.id==='business'),modelAuthorityCaptureSql(context.authority.endpoint)),{timeout:15000,maxOutput:1024*1024})).stdout.trim())}={}){
 const stopped=async(context,predicate)=>{
  for(const writer of context.containment.activeWriters){
   if(!predicate(writer)||context.containment.stopped.some(x=>x.kind===writer.kind&&x.name===writer.name))continue;
   // Journal the exact intent before the native stop. No automatic undo or
   // opening happens on a lost ACK; the same operation is queried instead.
   context.containment.stopped.push(writer);await checkpoint(context);await changeWriter(config,writer,false,run);
  }
 };
 // The native key RPC/HTTP must remain alive while current authority is
 // captured. Their business writers are stopped first; prepare then stops
 // these stores before any volume capture/activation.
 const stateful=writer=>databaseOwners.has(contextBinding(writer))||['objects','search'].includes(contextBinding(writer));
 let bindings=[];
 const contextBinding=writer=>bindings.find(x=>x.name===writer.name)?.id;
 const checkpoint=async context=>{
  const directory=controlDirectory+'/host-intents';await ensureDirectory(directory);
  await atomicWrite(directory+'/'+context.intent.operationId+'.json',JSON.stringify({version:1,intent:context.intent,containment:context.containment,artifacts:context.artifacts,currentFacts:context.currentFacts,activated:context.activated===true})+'\n');
 };
 const nativeBlockers=async moduleIds=>{
  const blockers=maintenanceNativeAuthorityGaps(moduleIds,{chatProbeConnected:typeof prosody.probe==='function'});
  if(moduleIds.includes('objects')&&!moduleIds.includes('business'))blockers.push('maintenance_object_current_database_scope_required');
  return blockers;
 };
 return{version:'galaxy-current-authority-host-restore-v5',moduleIds:[...maintenanceModuleIds],openingConditions:[...maintenanceOpeningConditions],
  async inspect({point,footprint,moduleIds}){
   const blockers=await nativeBlockers(moduleIds),metadata=point.manifest?.maintenance;
   if(!metadata?.sourceBindings)blockers.push('maintenance_point_source_bindings_not_recorded');
   if(moduleIds.some(id=>footprint.coverage.find(x=>x.id===id)?.state!=='covered'))blockers.push('maintenance_current_footprint_unknown');
   for(const current of footprint.containers.filter(x=>x.state==='available'&&moduleIds.includes(x.module)&&x.id!=='keycloak'))if(metadata?.images?.find(x=>x.id===current.id)?.image!==current.image)blockers.push('maintenance_engine_image_compatibility_not_proven');
   if(!blockers.length)try{if(moduleIds.includes('chat')){const c={intent:{moduleIds},footprint};await prosody.requireLiveComponent(c);await prosody.inspect(c);}if(moduleIds.includes('objects'))await objects.inspect();if(moduleIds.some(x=>['objects','configuration'].includes(x)))await engines.inspect({intent:{moduleIds},footprint});await health.check({intent:{moduleIds},footprint,containment:{activeWriters:footprint.services.filter(x=>x.active).map(x=>({kind:'systemd',name:x.unit})),probeToken:null}});}catch(error){blockers.push(/^maintenance_[a-z_]+$/.test(error.code??'')?error.code:'maintenance_native_preflight_unavailable');}
   return{blockers:[...new Set(blockers)]};
  },
  async contain(context){
   const blockers=await nativeBlockers(context.intent.moduleIds);if(blockers.length)throw fail(blockers[0]);
   if(context.intent.moduleIds.includes('chat')){await prosody.requireLiveComponent(context);await prosody.inspect(context);}
   if(context.intent.moduleIds.includes('objects'))await objects.inspect();
   if(context.intent.moduleIds.some(x=>['objects','configuration'].includes(x)))await engines.inspect(context);
   bindings=context.footprint.containers;
   const models=await readModelState(context);if(models.pending!==0)throw fail('maintenance_model_configuration_busy');
   context.modelAuthority=currentModelAuthority(models);context.modelBinding=await verifyModels(models);
   const containment=await gate.contain(context.intent.operationId),activeWriters=[];
   for(const writer of context.footprint.writers)if(writer.name!==currentIdentity&&await writerIsRunning(config,writer,run))activeWriters.push(writer);
   context.containment={...containment,activeWriters,stopped:[]};
   await checkpoint(context);
   await stopped(context,writer=>!controlUnits.has(writer.name)&&!stateful(writer));
   // Drain existing API/admin requests after the public gate is contained,
   // then keep the exact maintenance + current IAM control plane available.
   for(const writer of activeWriters.filter(x=>controlUnits.has(x.name))){await changeWriter(config,writer,false,run);await changeWriter(config,writer,true,run);}
   return{accepted:true};
  },
  async 'capture-current-facts'(context){
   const pg=config.postgres.find(x=>x.id==='business');
   const pending=(await run(config.tools.docker,postgresSqlArguments(pg,"SELECT count(*) FROM operations_model_settings_operations_v1 WHERE phase IN ('prepared','submitting','pending','result-unknown')"),{timeout:15000,maxOutput:1024})).stdout.trim();
   if(pending!=='0')throw fail('maintenance_model_configuration_busy');
   const options={config,controlDirectory,operationId:context.intent.operationId,endpoint:context.authority.endpoint,context,run};
   const configuration=await fingerprint(),current=await captureCurrent(options),deletion=await captureDeletion(options),native=await engines.capture(context);
   if(!same(currentModelAuthority(await loadCurrent(current)),context.modelAuthority))throw fail('maintenance_current_model_binding_unconfirmed');
   const chat=context.intent.moduleIds.includes('chat')?await prosody.capture(context):null;
   const objectFacts=context.intent.moduleIds.includes('objects')?await objects.capture(context):null;
   return{complete:true,configuration,current,deletion,engines:native,modelBinding:context.modelBinding,...(chat?{prosody:chat}:{}),...(objectFacts?{objects:objectFacts}:{})};
  },
  async prepare(context){
   await stopped(context,stateful);
   return prepare(context);
  },
  async restore(context){
   context.artifacts.fileTransfers=await files.stage(context);
   context.artifacts.transfers=await databases.prepare(context,{reconcileNative:db=>prosody.prepare(db,context),captureObjects:db=>objects.point(db,context),reconcileObjects:(db,point)=>objects.prepare(db,context,point)});
   await checkpoint(context);
   return{accepted:true};
  },
  async reconcile(context){
   context.artifacts.openpanelSecurity=await engines.prepareOpenPanel(context);
   if(context.intent.moduleIds.includes('configuration'))context.artifacts.grafanaSecurity=await engines.prepareGrafana(context);
   if(!same(await fingerprint(),context.currentFacts.configuration))throw fail('maintenance_current_configuration_changed');
   return{accepted:true};
  },
  async validate(context){
   if(!same(await fingerprint(),context.currentFacts.configuration))throw fail('maintenance_current_configuration_changed');
   if(!context.artifacts.security?.authorityPreserved||!context.artifacts.security?.sourceGatesReconciled||context.artifacts.deletion?.quarantined!==true)throw fail('maintenance_current_recovery_facts_incomplete');
   if(context.intent.moduleIds.includes('analytics')&&context.artifacts.openpanelSecurity?.currentPasswordsPreserved!==true)throw fail('maintenance_native_security_reconciliation_unconfirmed');
   if(context.intent.moduleIds.includes('configuration')&&context.artifacts.grafanaSecurity?.currentPermissionsPreserved!==true)throw fail('maintenance_grafana_current_authority_unconfirmed');
   if(context.intent.moduleIds.includes('chat')&&context.artifacts.prosodySecurity?.nativeLifecycleReconciled!==true)throw fail('maintenance_prosody_native_lifecycle_unconfirmed');
   if(context.intent.moduleIds.includes('objects')&&!context.artifacts.objectDeletionPlan)throw fail('maintenance_object_deletion_contribution_not_connected');
   if(!context.activated){
    for(const file of context.artifacts.fileTransfers){const info=await lstat(file.candidate);if(info.isSymbolicLink()||(file.kind==='tree'?!info.isDirectory():!info.isFile()))throw fail('maintenance_restore_file_type_changed');}
    // These are staged artifacts, not claims that the old live services have
    // already been replaced or that public routes are ready to open.
    return{prepared:true,modules:checks(context.intent.moduleIds,false),conditions:checks(maintenanceOpeningConditions,false)};
   }
   await databases.validate(context);
   if(context.intent.moduleIds.includes('search')&&context.artifacts.meiliSecurity?.currentKeysPreserved!==true)throw fail('maintenance_native_key_reconciliation_unconfirmed');
   if(context.intent.moduleIds.includes('objects')&&context.artifacts.garageSecurity?.currentBucketPermissionsPreserved!==true)throw fail('maintenance_garage_current_authority_unconfirmed');
   if(context.intent.moduleIds.includes('objects'))await objects.verify(context);
   if(context.intent.moduleIds.some(id=>['search','recommendation'].includes(id))&&context.artifacts.discoverySecurity?.currentPublicSourcesReconciled!==true)throw fail('maintenance_discovery_reconciliation_unconfirmed');
   const deadline=Date.now()+readinessTimeoutMs;let observed,error;
   do{try{observed=await health.check(context);break;}catch(value){error=value;if(Date.now()<deadline)await wait(1000);}}while(Date.now()<deadline);
   if(!observed)throw error??fail('maintenance_required_modules_not_ready');
   if(context.intent.moduleIds.includes('website'))await files.validate(context);
   if(context.intent.moduleIds.some(id=>['search','recommendation'].includes(id)))await discovery.verify(context);
   if(!same(await verifyModels(await loadCurrent(context.currentFacts.current)),context.currentFacts.modelBinding))throw fail('maintenance_current_model_binding_unconfirmed');
   if(context.intent.moduleIds.some(x=>['objects','configuration'].includes(x)))await engines.verifyNativeAuthority(context);
   if(context.intent.moduleIds.includes('chat'))await prosody.verifyLive(context);
   return{prepared:true,phase:'activated',modules:checks(context.intent.moduleIds,true),conditions:checks(maintenanceOpeningConditions,true),basis:'native-readiness-current-security-and-restic-verified-point'};
  },
  async activate(context){
   await stopped(context,writer=>controlUnits.has(writer.name));
   await databases.activate(context);await files.activate(context);
   // Resume databases/caches before their applications, then the current
   // control plane. Current Keycloak/accounts cluster was never rolled back.
   const original=context.containment.stopped,priority=writer=>{
    const id=contextBinding(writer);return databaseOwners.has(id)?0:writer.kind==='container'?1:controlUnits.has(writer.name)?2:3;
   };
   // Only storage/database processes start before exact object reconciliation.
   // API, workers and engine applications remain stopped while an S3 receipt
   // is pending; the public gate stays contained on every failure.
   const storage=writer=>databaseOwners.has(contextBinding(writer))||contextBinding(writer)==='objects';
   for(const writer of original.filter(storage).sort((a,b)=>priority(a)-priority(b)))await changeWriter(config,writer,true,run);
   if(context.intent.moduleIds.includes('objects')){
    context.artifacts.garageSecurity=await engines.restoreGarage(context);
    context.artifacts.objectDeletion=await objects.reconcile(context);await checkpoint(context);
   }
   for(const writer of original.filter(x=>!storage(x)&&!backgroundUnits.has(x.name)).sort((a,b)=>priority(a)-priority(b)))await changeWriter(config,writer,true,run);
   if(context.intent.moduleIds.includes('search'))context.artifacts.meiliSecurity=await engines.restoreMeili(context.currentFacts.engines);
   context.artifacts.discoverySecurity=await discovery.reconcile(context);
   for(const writer of original.filter(x=>backgroundUnits.has(x.name)))await changeWriter(config,writer,true,run);
   context.activated=true;await checkpoint(context);return{accepted:true};
  },
  async open(context){
   if(context.activated!==true||context.checks?.phase!=='activated')throw fail('maintenance_required_modules_not_ready');
   return gate.open(context.containment);
  },
 };
}
