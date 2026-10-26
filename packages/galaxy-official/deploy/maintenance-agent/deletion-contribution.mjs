import {createHash} from 'node:crypto';
import {readFile,lstat,writeFile,mkdir} from 'node:fs/promises';
import {deletionLedgerColumns,validateDeletionLedger,replayDeletionLedger} from '../../src/operations/deletion-ledger.mjs';
import {postgresSqlArguments,noSymlinkPath,runCommand} from '../operations-stack/host.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
const quote=value=>"'"+value.replaceAll("'","''")+"'";
function endpoint(value){const u=new URL(value);if(u.protocol!=='https:'||u.origin!==value||u.username||u.password)throw fail('maintenance_recovery_endpoint_invalid');return value;}

// Capture only after the related writers have been contained. The existing
// deletion module verifies the original signed intents/events and later replays
// their actual domain operations; this adapter adds no deletion policy.
export async function captureDeletionRecoveryContribution({config,controlDirectory,operationId,endpoint:origin,run=runCommand}){
 if(!uuid.test(operationId))throw fail('maintenance_operation_invalid');endpoint(origin);
 const pg=config.postgres.find(x=>x.id==='business');if(!pg)throw fail('maintenance_business_cluster_unknown');
 const tableEntries=Object.entries(deletionLedgerColumns).map(([name,columns])=>{
  const selected=columns.map(x=>'"'+x+'"').join(',');
  return quote(name)+`,(SELECT coalesce(json_agg(row_to_json(selected) ORDER BY selected.id),'[]'::json) FROM (SELECT ${selected} FROM "${name}") selected)`;
 });
 const sql=`BEGIN; LOCK TABLE deletion_requests,deletion_events,deletion_executions,schema_migrations IN SHARE MODE;
 SELECT json_build_object('version',1,'schema',(SELECT max(version) FROM schema_migrations),'endpoint',${quote(origin)},'capturedAt',floor(extract(epoch FROM transaction_timestamp()))::bigint,'tables',json_build_object(${tableEntries.join(',')})); COMMIT;`;
 const args=postgresSqlArguments(pg,sql);args.splice(args.length-2,0,'--quiet');
 const response=await run(config.tools.docker,args,{timeout:30000,maxOutput:20*1024*1024});
 let ledger;try{
  ledger=JSON.parse(response.stdout.trim());
  // node-postgres, used by the original capture helper, normalizes these
  // timestamptz columns to ISO milliseconds. Match that representation exactly.
  for(const rows of Object.values(ledger.tables??{}))for(const row of rows)for(const key of ['created_at','updated_at','minimized_at'])if(row[key]!=null)row[key]=new Date(row[key]).toISOString();
  await validateDeletionLedger(ledger);
 }catch{throw fail('maintenance_current_deletion_facts_invalid');}
 const payload=JSON.stringify(ledger),hash=sha(payload),directory=controlDirectory+'/recovery-facts';
 await noSymlinkPath(directory);await mkdir(directory,{recursive:true,mode:0o700});const file=directory+'/'+operationId+'-deletion.json';
 try{await writeFile(file,payload,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)||sha(await readFile(file))!==hash)throw fail('maintenance_recovery_facts_conflict');}
 return{kind:'current-deletion-ledger',operationId,sha256:hash,capturedAt:ledger.capturedAt,requests:ledger.tables.deletion_requests.length,artifactPath:file,signatureValidated:true,publicActivation:false};
}
export async function replayDeletionRecoveryContribution({database,contribution,recoveryId,endpoint:origin,executorRef,controlDirectory='/var/lib/galaxy/maintenance',now}){
 endpoint(origin);if(!uuid.test(recoveryId)||!uuid.test(contribution?.operationId??'')||contribution.artifactPath!==controlDirectory+'/recovery-facts/'+contribution.operationId+'-deletion.json')throw fail('maintenance_recovery_facts_invalid');
 await noSymlinkPath(contribution.artifactPath);
 const info=await lstat(contribution.artifactPath);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)||info.size>20*1024*1024)throw fail('maintenance_private_recovery_facts_required');
 const payload=await readFile(contribution.artifactPath,'utf8');if(sha(payload)!==contribution.sha256)throw fail('maintenance_recovery_facts_changed');
 const result=await replayDeletionLedger(database,payload,{version:1,id:contribution.operationId,recoveryId,endpoint:origin,ledgerSha256:contribution.sha256,capturedNotBefore:contribution.capturedAt,executorRef},(now?{now}:{}));
 if(result.quarantined!==true||result.publicActivationReady!==false)throw fail('maintenance_deletion_replay_unconfirmed');
 return{kind:'current-deletion-ledger',sha256:contribution.sha256,requestsImported:result.requestsImported,requestsReplayed:result.requestsReplayed,executionsReplayed:result.executionsReplayed,quarantined:true,publicActivationReady:false};
}
