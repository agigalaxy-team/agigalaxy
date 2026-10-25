#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {assertTarget,resumePausedWriters} from '../operations-stack/host.mjs';
import {createProductBackup} from '../operations-stack/backup.mjs';
import {readMaintenanceAgentConfiguration} from './configuration.mjs';
import {resolveMaintenanceFootprint,maintenanceCaptureConfiguration,maintenanceCaptureContext} from './footprint.mjs';

// This root-only, fixed routine can replace the existing timer's ExecStart.
// It does not enable a timer or select a new calendar/retention policy.
export async function backupCurrentDeployment(configuration,{run,now}={}){
 const config=configuration.operations;assertTarget(config);
 const footprint=await resolveMaintenanceFootprint(config,{run,captureProof:true}),capture=maintenanceCaptureConfiguration(config,footprint);
 return createProductBackup(capture,{run,now,captureContext:()=>maintenanceCaptureContext(config,footprint,{run})});
}
export async function resumeCurrentDeploymentWriters(configuration,{run}={}){
 const config=configuration.operations;assertTarget(config);
 const footprint=await resolveMaintenanceFootprint(config,{run});
 return resumePausedWriters({...config,backup:{...config.backup,writers:footprint.writers}},run);
}
// Only fixed machine facts reach the journal; raw errors may contain secrets.
const backupFailureCodes=new Set(["maintenance_agentos_database_not_in_cluster","maintenance_capture_coverage_incomplete","maintenance_cluster_metadata_invalid","maintenance_command_invalid","maintenance_container_unavailable","maintenance_current_footprint_changed","maintenance_current_footprint_unknown","maintenance_current_release_unknown","maintenance_native_response_invalid","maintenance_private_configuration_invalid","maintenance_runtime_reference_invalid","maintenance_service_not_loaded","maintenance_source_not_registered","maintenance_source_unavailable","maintenance_volume_outside_registered_roots","maintenance_volume_symlink_rejected","maintenance_website_dependency_outside_registered_roots","operations_absolute_path_required","operations_backup_still_running","operations_backup_type_invalid","operations_capture_context_invalid","operations_capture_pause_limit","operations_capture_size_limit","operations_capture_size_unknown","operations_capture_source_type_mismatch","operations_capture_source_unavailable","operations_capture_space_unavailable","operations_cleanup_marker_mismatch","operations_cleanup_outside_root","operations_command_failed","operations_command_output_limit","operations_command_timed_out","operations_command_unavailable","operations_credential_environment_invalid","operations_directory_required","operations_existing_directory_owner_mismatch","operations_external_tablespaces_need_explicit_restore_mapping","operations_isolated_archive_mode_invalid","operations_isolated_restore_not_ready","operations_job_already_running","operations_job_lock_unknown","operations_no_eligible_database_backup","operations_pause_ledger_invalid","operations_pause_target_changed","operations_pitr_target_invalid","operations_postgres_archive_not_enabled","operations_postgres_target_mismatch","operations_previous_pause_needs_resume","operations_private_credential_reference_required","operations_recursive_capture_rejected","operations_restic_snapshot_unknown","operations_restore_database_mismatch","operations_restore_manifest_invalid","operations_restore_outside_root","operations_restore_receipt_invalid","operations_restore_stanza_scope_invalid","operations_root_required","operations_symlink_target_rejected","operations_target_changed","operations_target_host_mismatch","operations_target_outside_root","operations_writer_restart_failed","operations_writer_state_unknown"]);
export function maintenanceBackupFailureRecord(error){
 const causeCode=[error?.code,error?.message].find(value=>backupFailureCodes.has(value))??null;
 const filesystemCode=['ENOENT','EACCES','EPERM','ENOSPC','EIO','EROFS','ENOTDIR','EISDIR','ELOOP'].includes(error?.code)?error.code:null;
 const command=causeCode==='operations_command_failed'&&['docker','cp','du','restic','systemctl'].includes(error?.command)?error.command:null;
 const exitCode=command&&Number.isInteger(error?.exitCode)&&error.exitCode>=0&&error.exitCode<=255?error.exitCode:null;
 return{event:'maintenance_backup_failed',code:'maintenance_capture_failed',causeCode,filesystemCode,command,exitCode};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const action=process.argv[2];
  if(!['backup','resume-writers'].includes(action)||process.argv[3]!=='--config'||!process.argv[4]||process.argv.length!==5)throw Error('maintenance_command_invalid');
  const configuration=await readMaintenanceAgentConfiguration(process.argv[4]);
  if(action==='backup'){
   const receipt=await backupCurrentDeployment(configuration);
   process.stdout.write(JSON.stringify({event:'maintenance_backup_complete',snapshotId:receipt.snapshotId,captureId:receipt.captureId})+'\n');
  }else{
   const result=await resumeCurrentDeploymentWriters(configuration);
   process.stdout.write(JSON.stringify({event:'maintenance_writer_resume_complete',state:result.state})+'\n');
  }
 }catch(error){process.stderr.write(JSON.stringify(maintenanceBackupFailureRecord(error))+'\n');process.exitCode=1;}
}
