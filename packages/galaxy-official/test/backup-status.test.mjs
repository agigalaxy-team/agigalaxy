import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { beginBackupStatus,finishBackupStatus,readBackupStatus } from '../src/operations/backup-status.mjs';
import { createOperationalMetrics } from '../src/operations/metrics.mjs';
import { createApi } from '../src/http.mjs';
import { ServiceError } from '../src/shared/service-error.mjs';

test('backup status preserves last success across failure and missing/corrupt input stays unavailable',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'galaxy-backup-status-'));
  try{
    const metrics=createOperationalMetrics({component:'api',defaultMetrics:false,cacheMs:0,backupStatusDirectory:directory,monitoredBackupActions:['create']});
    assert.match(await metrics.render(),/galaxy_backup_status_available\{action="create",component="api"\} 0/);
    const first=await beginBackupStatus(directory,'create',100);await finishBackupStatus(first,true,110);
    const next=await beginBackupStatus(directory,'create',120);await finishBackupStatus(next,false,125);
    const state=await readBackupStatus(directory,'create');assert.equal(state.lastSuccessAt,110);assert.equal(state.outcome,'failed');
    const body=await metrics.render();assert.match(body,/galaxy_backup_last_attempt_success\{action="create",component="api"\} 0/);
    assert.match(body,/galaxy_backup_last_success_timestamp_seconds\{action="create",component="api"\} 110/);
    const encoded=await readFile(join(directory,'create.json'),'utf8');assert.doesNotMatch(encoded,/repository|password|DATABASE_URL/);
    await writeFile(join(directory,'create.json'),'{broken');
    const invalid=await metrics.render();assert.match(invalid,/galaxy_backup_status_available\{action="create",component="api"\} 0/);
    assert.doesNotMatch(invalid,/galaxy_backup_last_success_timestamp_seconds\{/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('older backup invocation cannot overwrite the latest attempt',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'galaxy-backup-status-race-'));
  try{
    const first=await beginBackupStatus(directory,'check',100),second=await beginBackupStatus(directory,'check',101);
    assert.equal(await finishBackupStatus(first,true,102),false);
    assert.equal((await readBackupStatus(directory,'check')).runId,second.runId);
    assert.equal(await finishBackupStatus(second,true,103),true);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('real HTTP quota rejection feeds only fixed metric categories',async()=>{
  const metrics=createOperationalMetrics({component:'api',defaultMetrics:false});
  const api=createApi({metrics,bindings:{endpoint:'https://official.example.org'},
    access:{authenticate:async()=>({subjectId:'fixture',bindingId:'00000000-0000-4000-8000-000000000001'})},
    cases:{submit:async()=>{throw new ServiceError('storage_quota_exceeded',409);}}});
  api.listen(0,'127.0.0.1');await once(api,'listening');
  try{
    const result=await fetch('http://127.0.0.1:'+api.address().port+'/v1/cases',{method:'POST',headers:{authorization:'Bearer synthetic','content-type':'application/json'},
      body:JSON.stringify({consentId:'synthetic',payloadJson:JSON.stringify({kind:'case'})})});
    assert.equal(result.status,409);await result.arrayBuffer();
    metrics.quotaRejected('unknown-private-value');metrics.quotaRejected('__proto__');
    const body=await metrics.render();assert.match(body,/galaxy_resource_quota_rejections_total\{kind="payload",component="api"\} 1/);
    assert.doesNotMatch(body,/synthetic|unknown-private-value/);
  }finally{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}
});
