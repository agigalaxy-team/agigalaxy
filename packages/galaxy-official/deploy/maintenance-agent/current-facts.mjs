import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,lstat} from 'node:fs/promises';
import {currentRecoveryFactsCaptureSql,reconcileCurrentRecoveryFacts} from '../../src/operations/maintenance-recovery-facts.mjs';
import {noSymlinkPath,postgresSqlArguments,runCommand} from '../operations-stack/host.mjs';

const fail=code=>Object.assign(Error(code),{code});
const sha=value=>createHash('sha256').update(value).digest('hex');
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export async function captureNativeCurrentFacts({config,controlDirectory,operationId,endpoint,run=runCommand}){
 if(!uuid.test(operationId))throw fail('maintenance_operation_invalid');const pg=config.postgres.find(x=>x.id==='business');if(!pg)throw fail('maintenance_business_cluster_unknown');
 const args=postgresSqlArguments(pg,currentRecoveryFactsCaptureSql(endpoint));args.splice(args.length-2,0,'--quiet');
 const response=await run(config.tools.docker,args,{timeout:60000,maxOutput:20*1024*1024});let facts;
 try{facts=JSON.parse(response.stdout.trim());if(facts.version!==1||facts.endpoint!==endpoint||!Number.isSafeInteger(facts.capturedAt)||!facts.tables||!facts.gates)throw Error();}catch{throw fail('maintenance_current_facts_invalid');}
 const payload=JSON.stringify(facts),hash=sha(payload),directory=controlDirectory+'/recovery-facts';await noSymlinkPath(directory);await mkdir(directory,{recursive:true,mode:0o700});const file=directory+'/'+operationId+'-current.json';
 try{await writeFile(file,payload,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)||sha(await readFile(file))!==hash)throw fail('maintenance_current_facts_conflict');}
 return{kind:'current-source-authority-outbound',operationId,sha256:hash,capturedAt:facts.capturedAt,artifactPath:file,schema:facts.schema,tableCount:Object.keys(facts.tables).length,sourceGateTables:Object.keys(facts.gates).length};
}
export async function replayNativeCurrentFacts({database,contribution,controlDirectory,endpoint,recoveryId}){
 return reconcileCurrentRecoveryFacts(database,await readNativeCurrentFacts({contribution,controlDirectory}),{endpoint,recoveryId});
}
export async function readNativeCurrentFacts({contribution,controlDirectory}){
 const file=controlDirectory+'/recovery-facts/'+contribution.operationId+'-current.json';if(!uuid.test(contribution.operationId)||contribution.artifactPath!==file)throw fail('maintenance_current_facts_invalid');await noSymlinkPath(file);const info=await lstat(file);
 if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)||info.size>20*1024*1024)throw fail('maintenance_private_current_facts_required');const payload=await readFile(file,'utf8');if(sha(payload)!==contribution.sha256)throw fail('maintenance_current_facts_changed');
 return JSON.parse(payload);
}
