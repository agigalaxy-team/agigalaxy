import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import pg from 'pg';
import { beginBackupStatus,finishBackupStatus } from '../src/operations/backup-status.mjs';
import { prepareSnapshotCleanup,executeSnapshotCleanup,snapshotCleanupCandidates } from '../src/operations/backup-cleanup.mjs';
import { initializeBackupRepository, createBackup, backupRepositoryCheck, copyBackupSnapshot,
  retentionPreview, restoreBackup } from '../src/operations/backup.mjs';

const [action, configPath, receiptPath] = process.argv.slice(2);
let pool;
let statusRun;
const statusFailed=()=>{console.error(JSON.stringify({event:'backup_status_unavailable'}));process.exitCode=1;};
const publishStatus=async success=>{
  if(!statusRun)return;
  try{if(!await finishBackupStatus(statusRun,success))statusFailed();}catch{statusFailed();}
};
try {
  if (!['init', 'create', 'check', 'copy', 'retention', 'restore','prepare-cleanup','cleanup'].includes(action)) throw new Error('usage');
  if(process.env.GALAXY_BACKUP_STATUS_DIRECTORY){
    try{statusRun=await beginBackupStatus(process.env.GALAXY_BACKUP_STATUS_DIRECTORY,action);}catch{statusFailed();}
  }
  if(!isAbsolute(configPath??'')||!isAbsolute(receiptPath??''))throw new Error('usage');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.version !== 1) throw new Error('version');
  const reference = name => {
    if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]+$/.test(name) || !process.env[name]) throw new Error('missing environment reference');
    return process.env[name];
  };
  const repository = value => ({ binary: config.resticBinary, repository: value.repository,
    environment: Object.fromEntries(Object.entries(value.environmentReferences).map(([key, name]) => [key, reference(name)])) });
  const primary = repository(config.primary);
  let result;
  if(action==='prepare-cleanup'){
    const cleanupRequest={...config.cleanupRequest};
    if(cleanupRequest.snapshotIds===undefined){
      if(!config.retention)throw new Error('Explicit retention selection required');
      cleanupRequest.snapshotIds=await snapshotCleanupCandidates(primary,config.retention);
    }
    if(!cleanupRequest.snapshotIds.length){
      await writeFile(receiptPath,JSON.stringify({version:1,action,result:'no-candidates',physicalDeletionPerformed:false})+'\n',{flag:'wx',mode:0o600});
      console.log(JSON.stringify({action,result:'no-candidates',snapshots:0}));
    }else{
    const prepared=await prepareSnapshotCleanup(primary,cleanupRequest);
    await writeFile(receiptPath,prepared.payloadJson,{flag:'wx',mode:0o600});
    console.log(JSON.stringify({action,result:'prepared',sha256:prepared.sha256,snapshots:prepared.snapshots}));
    }
  }else{
  if(action==='cleanup'){
    if(!isAbsolute(config.approvedPlanPath??''))throw new Error('Exact approved plan required');
    result=await executeSnapshotCleanup(primary,await readFile(config.approvedPlanPath,'utf8'),config.approvedPlanSha256);
  }else if (action === 'init') {
    await initializeBackupRepository(primary);
    if (config.copy) await initializeBackupRepository(repository(config.copy));
    result = { initialized: true };
  } else if (action === 'check') result = await backupRepositoryCheck(primary);
  else if (action === 'retention') result = { dryRun: true, groups: await retentionPreview(primary, config.retention) };
  else if (action === 'copy') result = await copyBackupSnapshot(primary, repository(config.copy), config.snapshotId);
  else {
    pool = new pg.Pool({ connectionString: reference(config.databaseUrlEnvironment), max: 2 });
    if (action === 'create') result = await createBackup({ ...config.capture, pool, pgBin: config.pgBin,
      pgEnvironment: config.pgTlsEnvironment, repository: primary });
    else result = await restoreBackup({ ...config.restore, admin: pool, pgBin: config.pgBin,
      pgEnvironment: config.pgTlsEnvironment, repository: primary });
  }
  await writeFile(receiptPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ action, result: 'completed', receiptWritten: true }));
  }
  await publishStatus(true);
} catch {
  await publishStatus(false);
  console.error(JSON.stringify({ event: 'backup_operation_failed', action: ['init', 'create', 'check', 'copy', 'retention', 'restore','prepare-cleanup','cleanup'].includes(action) ? action : 'invalid',
    help: 'node scripts/backup.mjs <init|create|check|copy|retention|restore|prepare-cleanup|cleanup> <absolute-config.json> <new-absolute-receipt.json>; cleanup may have partly committed; retry the original approved plan; see docs/backup-recovery-v1.md' }));
  process.exitCode = 1;
} finally { try{if (pool) await pool.end();}catch{console.error(JSON.stringify({event:'backup_connection_close_failed'}));process.exitCode=1;} }
