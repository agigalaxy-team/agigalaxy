import {restoreProductBackup} from '../operations-stack/backup.mjs';
import {captureDeletionRecoveryContribution} from './deletion-contribution.mjs';
import {createProductionRestoreAdapters} from './production-restore.mjs';

// Reuse the existing native restic + pgBackRest preparation. This restores into
// a fresh, network-isolated tree; it is deliberately not an activation handler.
export function createOperationsStackPreparation({config,run}){
 return async function prepare(context){
  const {intent,point}=context,manifest=point.manifest,snapshot=point.snapshot;
  if(!manifest||manifest.id!==snapshot.tags?.find(t=>t.startsWith('capture:'))?.slice(8)||snapshot.id!==intent.pointId)throw Object.assign(Error('maintenance_capture_metadata_invalid'),{code:'maintenance_capture_metadata_invalid'});
  const receipt={version:1,captureId:manifest.id,snapshotId:snapshot.id,snapshotSubfolder:snapshot.paths[0],finishedAt:manifest.captureFinishedAt,
   databaseRestorePoints:manifest.databases.map(({id:stanza,restorePoint,backupLabel})=>({stanza,restorePoint,backupLabel}))};
  const directory=config.directories.restores+'/maintenance-'+intent.operationId;
  const result=await restoreProductBackup(config,{receipt,directory,run,lockHeld:true,privateSockets:true,selectedStanzas:['business']});
  if(result.state!=='isolated'||result.publicActivation!==false||!result.files)throw Object.assign(Error('maintenance_isolated_preparation_failed'),{code:'maintenance_isolated_preparation_failed'});
  return{version:1,kind:'operations-stack-isolated',captureId:manifest.id,directory,databases:result.databases,files:result.files,
   contributions:manifest.files.map(source=>({sourceId:source.id,preparedPath:result.files+'/'+source.id,originalPath:source.path})),publicActivation:false};
 };
}
export function createHostRestoreAdapters({config,run,controlDirectory,productionEnabled=false,fetchImpl=fetch,prosodyProbe=null}){
 if(productionEnabled)return createProductionRestoreAdapters({config,run,controlDirectory,fetchImpl,prosodyProbe});
 return{version:'operations-stack-isolated-preparation-v1',moduleIds:[],openingConditions:[],prepare:createOperationsStackPreparation({config,run}),
  'capture-current-facts':async context=>({complete:false,deletion:await captureDeletionRecoveryContribution({config,controlDirectory,operationId:context.intent.operationId,endpoint:context.authority?.endpoint,context,run}),
   blockers:['maintenance_current_source_lifecycle_not_connected','maintenance_outbound_delivery_reconciliation_not_connected','maintenance_current_authority_preservation_not_connected']})};
}
