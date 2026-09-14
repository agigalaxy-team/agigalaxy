import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes,randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeBackupRepository,runBackupCommand } from '../../src/operations/backup.mjs';
import { prepareSnapshotCleanup,executeSnapshotCleanup,snapshotCleanupCandidates } from '../../src/operations/backup-cleanup.mjs';

test('real restic cleanup pins repository and exact snapshots, resumes after lost acknowledgement and preserves other backups',async()=>{
  assert.ok(process.env.GALAXY_TEST_RESTIC_BIN,'Explicit restic binary required');
  const directory=await mkdtemp(join(tmpdir(),'galaxy-restic-cleanup-'));
  try{
    const repo={binary:process.env.GALAXY_TEST_RESTIC_BIN,repository:join(directory,'repository'),environment:{RESTIC_PASSWORD:randomBytes(32).toString('hex')}};
    const other={...repo,repository:join(directory,'other-repository')};
    await initializeBackupRepository(repo);await initializeBackupRepository(other);
    const source=join(directory,'source');await mkdir(source);
    const snapshots=[];
    for(let i=0;i<3;i++){
      await writeFile(join(source,'synthetic.txt'),'Synthetic version '+i+' '+randomUUID());
      const output=await runBackupCommand(repo.binary,['--repo',repo.repository,'--json','--no-cache','backup','.', '--host',i===2?'unrelated-host':'galaxy-official'],{env:repo.environment,cwd:source});
      snapshots.push(JSON.parse(output.trim().split('\n').at(-1)).snapshot_id);
    }
    const now=Math.floor(Date.now()/1000),request={version:1,repositoryRef:'synthetic-primary',snapshotIds:[snapshots[0]],requestIds:[randomUUID()],
      policy:{id:'synthetic-only',version:'1',notBefore:now+10,basis:'Synthetic cleanup exercise'},prune:true};
    assert.deepEqual(await snapshotCleanupCandidates(repo,{keepDaily:1,keepWeekly:1,keepMonthly:1}),[snapshots[0]]);
    const plan=await prepareSnapshotCleanup(repo,request,{now:()=>now});
    await assert.rejects(executeSnapshotCleanup(repo,plan.payloadJson,plan.sha256,{now:()=>now}),/not due/);
    await assert.rejects(executeSnapshotCleanup(other,plan.payloadJson,plan.sha256,{now:()=>now+10}),/repository mismatch/);
    await assert.rejects(prepareSnapshotCleanup(repo,{...request,snapshotIds:[snapshots[2]]}),/unavailable/);
    await assert.rejects(executeSnapshotCleanup(repo,plan.payloadJson,'0'.repeat(64),{now:()=>now+10}),/digest mismatch/);
    // The first exact forget commits, then the caller loses its acknowledgement.
    await runBackupCommand(repo.binary,['--repo',repo.repository,'--json','--no-cache','forget',snapshots[0]],{env:repo.environment});
    const result=await executeSnapshotCleanup(repo,plan.payloadJson,plan.sha256,{now:()=>now+10});
    assert.equal(result.alreadyAbsentBefore,1);assert.equal(result.removedInThisAttempt,0);assert.equal(result.selectedSnapshotsAbsent,true);
    assert.equal(result.unrelatedSnapshotsPreserved,2);assert.equal(result.remainingSnapshots,2);assert.equal(result.prunePerformed,true);
    const restored=await runBackupCommand(repo.binary,['--repo',repo.repository,'--json','--no-cache','dump',snapshots[2],'synthetic.txt'],{env:repo.environment});
    assert.ok(restored.startsWith('Synthetic version 2'));
    // Exercise the supported CLI and its environment-reference configuration.
    const config={version:1,resticBinary:repo.binary,primary:{repository:repo.repository,environmentReferences:{RESTIC_PASSWORD:'SYNTHETIC_PASSWORD'}},
      cleanupRequest:{...request,snapshotIds:[snapshots[1]],policy:{...request.policy,notBefore:now},prune:false}};
    const configPath=join(directory,'config.json'),planPath=join(directory,'plan.json');
    await writeFile(configPath,JSON.stringify(config));
    const cli=fileURLToPath(new URL('../../scripts/backup.mjs',import.meta.url));
    const prepared=JSON.parse(await runBackupCommand(process.execPath,[cli,'prepare-cleanup',configPath,planPath],{env:{SYNTHETIC_PASSWORD:repo.environment.RESTIC_PASSWORD}}));
    config.approvedPlanPath=planPath;config.approvedPlanSha256=prepared.sha256;await writeFile(configPath,JSON.stringify(config));
    const receiptPath=join(directory,'receipt.json');
    await runBackupCommand(process.execPath,[cli,'cleanup',configPath,receiptPath],{env:{SYNTHETIC_PASSWORD:repo.environment.RESTIC_PASSWORD}});
    const receipt=JSON.parse(await readFile(receiptPath,'utf8'));assert.equal(receipt.removedInThisAttempt,1);assert.equal(receipt.remainingSnapshots,1);
    assert.equal(receipt.backupSubjectErasureComplete,false);assert.equal(receipt.storageMediaErasureVerified,false);
    const evidence={event:'restic_snapshot_cleanup_verified',retentionCandidatesFiltered:true,exactTargets:true,otherHostSnapshotRestored:true,wrongRepositoryRejected:true,notDueRejected:true,
      lostAcknowledgementResumed:true,cli:true,repositoryCheckPassed:true,prune:true,subjectErasureClaimed:false};
    console.log(JSON.stringify(evidence));if(process.env.GALAXY_TEST_CLEANUP_EVIDENCE)await writeFile(process.env.GALAXY_TEST_CLEANUP_EVIDENCE,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  }finally{await rm(directory,{recursive:true,force:true});}
});
