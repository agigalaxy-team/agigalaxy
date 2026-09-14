import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { runBackupCommand } from '../../src/operations/backup.mjs';
import { readBackupStatus } from '../../src/operations/backup-status.mjs';
test('actual restic CLI records successful and failed attempts without losing last success',async()=>{
  assert.ok(process.env.GALAXY_TEST_RESTIC_BIN);
  const temporary=await mkdtemp(join(tmpdir(),'galaxy-backup-status-cli-'));
  try{
    const directory=join(temporary,'status'),path=join(temporary,'config.json');
    const config={version:1,resticBinary:process.env.GALAXY_TEST_RESTIC_BIN,
      primary:{repository:join(temporary,'repository'),environmentReferences:{RESTIC_PASSWORD:'SYNTHETIC_BACKUP_PASSWORD'}}};
    const env={GALAXY_BACKUP_STATUS_DIRECTORY:directory,SYNTHETIC_BACKUP_PASSWORD:randomBytes(32).toString('hex')};
    const run=(action,receipt)=>runBackupCommand(process.execPath,[fileURLToPath(new URL('../../scripts/backup.mjs',import.meta.url)),action,path,join(temporary,receipt)],{env,timeoutMs:30000});
    await writeFile(path,JSON.stringify(config));await run('init','init.json');await run('check','check.json');
    const previous=await readBackupStatus(directory,'check');assert.equal(previous.outcome,'succeeded');
    config.primary.repository=join(temporary,'missing');await writeFile(path,JSON.stringify(config));
    await assert.rejects(run('check','failed.json'));
    const failed=await readBackupStatus(directory,'check');assert.equal(failed.outcome,'failed');assert.equal(failed.lastSuccessAt,previous.lastSuccessAt);
  }finally{await rm(temporary,{recursive:true,force:true});}
});
