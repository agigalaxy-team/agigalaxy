import {mkdir,readFile,lstat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {atomicWrite,noSymlinkPath} from '../operations-stack/host.mjs';

const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=code=>Object.assign(new Error(code),{code});

// Backup-only private metadata. No stderr, message, argv, paths or input is kept.
const backupPhases=new Set(["prepare","database-backup","size-check","precopy","capture-and-resume","before-transfer","api-readiness","current-authorization","repository-transfer","repository-result","record-receipt","cleanup","complete"]);
const backupFailureCodes=new Set(["operations_absolute_path_required","operations_backup_still_running","operations_backup_type_invalid","operations_capture_context_invalid","operations_capture_pause_limit","operations_capture_size_limit","operations_capture_size_unknown","operations_capture_source_type_mismatch","operations_capture_source_unavailable","operations_capture_space_unavailable","operations_cleanup_marker_mismatch","operations_cleanup_outside_root","operations_command_failed","operations_command_output_limit","operations_command_timed_out","operations_command_unavailable","operations_credential_environment_invalid","operations_directory_required","operations_existing_directory_owner_mismatch","operations_external_tablespaces_need_explicit_restore_mapping","operations_job_already_running","operations_job_lock_unknown","operations_no_eligible_database_backup","operations_pause_ledger_invalid","operations_pause_target_changed","operations_postgres_archive_not_enabled","operations_postgres_target_mismatch","operations_previous_pause_needs_resume","operations_private_credential_reference_required","operations_recursive_capture_rejected","operations_restic_snapshot_unknown","operations_root_required","operations_symlink_target_rejected","operations_target_changed","operations_target_host_mismatch","operations_target_outside_root","operations_writer_restart_failed","operations_writer_state_unknown"]);
const backupCommands=new Set(['restic','docker','cp','du','systemctl']);
const diagnosticErrorNames=new Set(['Error','TypeError','SyntaxError','AbortError','TimeoutError']);
const commandSignals=new Set(['SIGINT','SIGTERM','SIGKILL','SIGHUP','SIGABRT','SIGPIPE']);
const backupFailure=error=>{
 const command=backupCommands.has(error?.command)?error.command:null;
 return{code:backupFailureCodes.has(error?.code)?error.code:backupFailureCodes.has(error?.message)?error.message:null,
  errorName:diagnosticErrorNames.has(error?.name)?error.name:null,command,
  exitCode:command&&Number.isInteger(error?.exitCode)&&error.exitCode>=0&&error.exitCode<=255?error.exitCode:null,
  signal:command&&commandSignals.has(error?.signal)?error.signal:null};
};

export class MaintenanceControlJournal{
 constructor({directory,now=()=>new Date()}){Object.assign(this,{directory,now});this.active=new Set();}
 path(id){if(!idPattern.test(id))throw fail('maintenance_operation_invalid');return this.directory+'/'+id+'.json';}
 async initialize(){await noSymlinkPath(this.directory);await mkdir(this.directory,{recursive:true,mode:0o700});const s=await lstat(this.directory);if(!s.isDirectory()||(s.mode&0o077))throw fail('maintenance_private_journal_required');}
 async read(id){
  let row;try{const p=this.path(id),s=await lstat(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||s.size>1048576)throw fail('maintenance_private_journal_required');row=JSON.parse(await readFile(p,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(row.id!==id||row.version!==1||!row.intent||!Array.isArray(row.steps))throw fail('maintenance_control_journal_invalid');
  // A process restart cannot turn an interrupted restore into a new attempt.
  if(row.state==='running'&&!this.active.has(id))return{...row,state:'unknown',publicActivation:row.steps.some(s=>s.id==='open'&&s.state==='running')?null:row.publicActivation,code:'maintenance_execution_result_unknown',steps:row.steps.map(s=>s.state==='running'?{...s,state:'unknown'}:s)};
  return row;
 }
 async begin(intent){
  await this.initialize();const old=await this.read(intent.operationId);if(old){if(!isDeepStrictEqual(old.intent,intent))throw fail('maintenance_operation_conflict');return{row:old,created:false};}
  const row={version:1,id:intent.operationId,intent,intentDigest:createHash('sha256').update(JSON.stringify(intent)).digest('hex'),kind:intent.kind,state:'running',startedAt:this.now().toISOString(),finishedAt:null,publicActivation:false,steps:[]};
  try{await writeFile(this.path(row.id),JSON.stringify(row)+'\n',{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;const winner=await this.read(intent.operationId);if(!winner||!isDeepStrictEqual(winner.intent,intent))throw fail('maintenance_operation_conflict');return{row:winner,created:false};}
  this.active.add(row.id);return{row,created:true};
 }
 async save(row){await atomicWrite(this.path(row.id),JSON.stringify(row)+'\n');return row;}
 async backupPhase(row,phase){
  if(row.kind!=='backup-create'||!backupPhases.has(phase))return false;
  row.backupDiagnostic={version:1,phase,updatedAt:this.now().toISOString(),failure:null};
  // Diagnostic persistence is best-effort; it must not change the backup effect.
  try{await this.save(row);return true;}catch{return false;}
 }
 async finish(row,error=null){if(row.kind==='backup-create'&&error){const phase=backupPhases.has(row.backupDiagnostic?.phase)?row.backupDiagnostic.phase:null;row.backupDiagnostic={version:1,phase,updatedAt:this.now().toISOString(),failure:backupFailure(error)};}row.state=error?(error.code==='maintenance_public_activation_unknown'?'unknown':'failed'):'succeeded';row.finishedAt=this.now().toISOString();if(error)row.code=/^maintenance_[a-z_]{1,80}$/.test(error.code??'')?error.code:'maintenance_execution_failed';await this.save(row);this.active.delete(row.id);return row;}
 async verification(pointId){
  if(!/^[a-f0-9]{64}$/.test(pointId))throw fail('maintenance_point_invalid');
  try{const s=await lstat(this.directory+'/verified-'+pointId+'.json');if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||s.size>8192)return null;const row=JSON.parse(await readFile(this.directory+'/verified-'+pointId+'.json','utf8'));return row.pointId===pointId?row:null;}catch(error){if(error.code==='ENOENT')return null;throw error;}
 }
 async verify(pointId,operationId){await this.initialize();const row={version:1,pointId,operationId,checkedAt:this.now().toISOString(),basis:'restic-check-read-data-and-point-still-present'};await atomicWrite(this.directory+'/verified-'+pointId+'.json',JSON.stringify(row)+'\n');return row;}
}
