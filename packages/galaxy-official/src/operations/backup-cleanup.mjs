import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../shared/digest.mjs';
import { runBackupCommand,backupRepositoryCheck,retentionPreview } from './backup.mjs';

const hash=z.string().regex(/^[a-f0-9]{64}$/),time=z.number().int().nonnegative();
const requestSchema=z.object({version:z.literal(1),id:z.uuid().optional(),repositoryRef:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  snapshotIds:z.array(hash).min(1).max(1000),requestIds:z.array(z.uuid()).max(1000).default([]),
  policy:z.object({id:z.string().min(1).max(100),version:z.string().min(1).max(80),notBefore:time,basis:z.string().min(1).max(2000)}).strict(),
  prune:z.boolean()}).strict().refine(value=>new Set(value.snapshotIds).size===value.snapshotIds.length&&new Set(value.requestIds).size===value.requestIds.length);
const planSchema=z.object({version:z.literal(1),id:z.uuid(),repositoryRef:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  repositoryId:hash,repositoryLocationSha256:hash,preparedAt:time,policy:z.object({id:z.string().min(1).max(100),version:z.string().min(1).max(80),notBefore:time,basis:z.string().min(1).max(2000)}).strict(),
  requestIds:z.array(z.uuid()).max(1000),prune:z.boolean(),
  snapshots:z.array(z.object({id:hash,time:z.string().min(1).max(80),tree:hash,metadataSha256:hash}).strict()).min(1).max(1000)
}).strict().refine(value=>new Set(value.snapshots.map(row=>row.id)).size===value.snapshots.length&&new Set(value.requestIds).size===value.requestIds.length);

const run=(repository,args)=>runBackupCommand(repository.binary,['--repo',repository.repository,'--json','--no-cache',...args],{env:repository.environment});
async function repositoryId(repository){
  // Read the public repository identifier, never a master key or key object.
  const config=JSON.parse(await run(repository,['cat','config']));return hash.parse(config.id);
}
async function snapshots(repository){
  const rows=JSON.parse(await run(repository,['snapshots']));
  if(!Array.isArray(rows)||rows.length>100000)throw new Error('Unsupported backup inventory');
  return rows.map(row=>{
    if(!hash.safeParse(row.id).success||!hash.safeParse(row.tree).success||typeof row.time!=='string'||typeof row.hostname!=='string'
      ||!Array.isArray(row.paths)||!row.paths.every(path=>typeof path==='string')||row.tags&&(!Array.isArray(row.tags)||!row.tags.every(tag=>typeof tag==='string')))throw new Error('Invalid snapshot metadata');
    const order=(a,b)=>a<b?-1:a>b?1:0;
    const metadata={id:row.id,time:row.time,tree:row.tree,hostname:row.hostname,paths:[...row.paths].sort(order),tags:[...(row.tags??[])].sort(order)};
    return {id:row.id,time:row.time,tree:row.tree,hostname:row.hostname,metadataSha256:digest(JSON.stringify(metadata))};
  });
}

export async function snapshotCleanupCandidates(repository,retention){
  const groups=await retentionPreview(repository,retention);
  if(!Array.isArray(groups))throw new Error('Invalid retention preview');
  const ids=[];
  for(const group of groups){
    if(group.host!=='galaxy-official')continue;
    if(group.remove!==undefined&&!Array.isArray(group.remove))throw new Error('Invalid retention candidates');
    for(const row of group.remove??[])ids.push(hash.parse(row.id));
  }
  return [...new Set(ids)];
}

export async function prepareSnapshotCleanup(repository,input,{now=()=>Math.floor(Date.now()/1000)}={}){
  const request=requestSchema.parse(input),repoId=await repositoryId(repository),rows=await snapshots(repository);
  const selected=request.snapshotIds.map(id=>{
    const row=rows.find(item=>item.id===id);if(!row||row.hostname!=='galaxy-official')throw new Error('Selected Galaxy snapshot is unavailable');
    const {hostname:_,...summary}=row;return summary;
  });
  const plan=planSchema.parse({version:1,id:request.id??randomUUID(),repositoryRef:request.repositoryRef,repositoryId:repoId,
    repositoryLocationSha256:digest(repository.repository),preparedAt:now(),policy:request.policy,requestIds:request.requestIds,prune:request.prune,snapshots:selected});
  const payloadJson=JSON.stringify(plan);return {payloadJson,sha256:digest(payloadJson),snapshots:selected.length,repositoryRef:plan.repositoryRef,physicalDeletionPerformed:false};
}

export async function executeSnapshotCleanup(repository,payloadJson,expectedSha256,{now=()=>Math.floor(Date.now()/1000)}={}){
  if(typeof payloadJson!=='string'||Buffer.byteLength(payloadJson)>1048576||!hash.safeParse(expectedSha256).success||digest(payloadJson)!==expectedSha256)throw new Error('Cleanup plan digest mismatch');
  const plan=planSchema.parse(JSON.parse(payloadJson));
  if(plan.policy.notBefore>now())throw new Error('Backup cleanup is not due');
  if(plan.repositoryLocationSha256!==digest(repository.repository)||plan.repositoryId!==await repositoryId(repository))throw new Error('Backup cleanup repository mismatch');
  const before=await snapshots(repository),targets=new Set(plan.snapshots.map(row=>row.id));
  const present=before.filter(row=>targets.has(row.id));
  for(const row of present)if(row.hostname!=='galaxy-official'||row.metadataSha256!==plan.snapshots.find(selected=>selected.id===row.id).metadataSha256)throw new Error('Cleanup snapshot changed');
  const protectedRows=before.filter(row=>!targets.has(row.id));
  // Exact immutable IDs only. If forget partly committed or its acknowledgement
  // was lost, retry the same approved plan against the remaining selected IDs.
  if(present.length)await run(repository,['forget',...present.map(row=>row.id)]);
  const afterForget=await snapshots(repository);
  if(afterForget.some(row=>targets.has(row.id)))throw new Error('Selected snapshots remain; retry the original cleanup plan');
  if(plan.prune)await run(repository,['prune','--max-unused','0']);
  await backupRepositoryCheck(repository);
  const after=await snapshots(repository);
  if(after.some(row=>targets.has(row.id))||protectedRows.some(row=>!after.some(item=>item.id===row.id&&item.metadataSha256===row.metadataSha256)))throw new Error('Cleanup verification changed; inspect the repository');
  return {version:1,id:plan.id,repositoryRef:plan.repositoryRef,repositoryId:plan.repositoryId,planSha256:expectedSha256,
    requestIds:plan.requestIds,policyId:plan.policy.id,policyVersion:plan.policy.version,checkedAt:now(),
    selectedSnapshotIds:[...targets],selectedSnapshotsAbsent:true,alreadyAbsentBefore:plan.snapshots.length-present.length,removedInThisAttempt:present.length,
    prunePerformed:plan.prune,pruneScope:plan.prune?'repository-wide unreferenced data':'not requested',repositoryIntegrityChecked:true,
    unrelatedSnapshotsPreserved:protectedRows.length,remainingSnapshots:after.length,
    backupSubjectErasureComplete:false,otherRepositoriesChecked:false,storageMediaErasureVerified:false,
    coverage:'selected snapshot references only; deduplicated data may remain in retained snapshots'};
}
