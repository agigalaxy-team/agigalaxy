import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServiceReleaseHost} from '../deploy/service-release-host.mjs';

test('host adapter snapshots and restores exact environment/unit bytes and verifies real readyz contract',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-release-host-'));
 if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith('galaxy-release-host-'))throw Error('Unexpected fixture cleanup target.');
 const env=join(directory,'api.env'),unit=join(directory,'worker.service'),nextEnv=join(directory,'target.env'),nextUnit=join(directory,'target.service'),commands=[];
 const oldEnv=Buffer.from('GALAXY_RELEASE_DIRECTORY=/synthetic/old\r\n'),oldUnit=Buffer.from('[Service]\nExecStart=/synthetic/old\n');
 try{
  await writeFile(env,oldEnv);await writeFile(unit,oldUnit);await writeFile(nextEnv,'GALAXY_RELEASE_DIRECTORY=/synthetic/new\n');await writeFile(nextUnit,'[Service]\nExecStart=/synthetic/new\n');
  const operationId=randomUUID(),from={releaseId:'fixture-old'},to={releaseId:'fixture-new'};
  const adapter=await createServiceReleaseHost({configuration:{files:[{destination:env,targetSource:nextEnv},{destination:unit,targetSource:nextUnit}],
   units:['fixture-api@pilot.service','fixture-worker@pilot.service','fixture-publisher.service'],migrationUnit:'fixture-migration@pilot.service',stateDirectory:join(directory,'protected'),readyUrl:'http://127.0.0.1:1/readyz'},operationId,from,to,
   run:async args=>{commands.push(args);return args[0]==='show'?'inactive':'';},
   fetch:async()=>new Response(JSON.stringify({status:'ready'}),{headers:{'x-galaxy-release':(await readFile(env,'utf8')).includes('/old')?from.releaseId:to.releaseId}})});
  const reference=await adapter.host.snapshot();await adapter.host.stopAll();await adapter.host.applyTarget();await adapter.host.startTarget();await adapter.host.verifyTarget();
  assert.match(await readFile(env,'utf8'),/\/new/);assert.match(await readFile(unit,'utf8'),/\/new/);
  await adapter.host.stopAll();await adapter.host.restore(reference);await adapter.host.startPrevious();await adapter.host.verifyPrevious();
  assert.deepEqual(await readFile(env),oldEnv);assert.deepEqual(await readFile(unit),oldUnit);assert.equal(await adapter.host.migrationState(),'inactive');
  await assert.rejects(adapter.host.restore(join(directory,'foreign')),/Original protected snapshot/);
  await adapter.journal.write({operationId,state:'result-unknown',snapshotReference:reference});
  assert.deepEqual(await adapter.journal.read(operationId),{operationId,state:'result-unknown',snapshotReference:reference});
  assert.equal(commands.filter(args=>args[0]==='stop').length,2);
  assert.deepEqual(commands.find(args=>args[0]==='start'),['start','fixture-api@pilot.service','fixture-worker@pilot.service','fixture-publisher.service']);
 }finally{await rm(directory,{recursive:true,force:true});}
});
