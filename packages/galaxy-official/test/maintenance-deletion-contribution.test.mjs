import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {serviceFixture} from './service-fixture.mjs';
import {approveFixtureDeletion} from './deletion-execute-workflow.mjs';
import {executeDeletion} from '../src/operations/deletion-execute.mjs';
import {captureDeletionLedger} from '../src/operations/deletion-ledger.mjs';
import {captureDeletionRecoveryContribution,replayDeletionRecoveryContribution} from '../deploy/maintenance-agent/deletion-contribution.mjs';

// Only the docker/psql transport is doubled. Signed deletion approval, ledger
// validation, quarantine and domain replay are the real existing PG code.
test('maintenance preserves current signed deletion facts outside the restored database and replays only into the exact quarantine',{
 skip:process.platform!=='linux'?'Private control artifacts require Linux permissions.':false,
},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-maintenance-facts-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const f=await serviceFixture(['binding','consent','case-teaser','data-delete']);t.after(()=>f.db.close());
 const item={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Synthetic pre-restore object',summary:'Only for local behavior verification',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
 await f.cases.submit(f.actor,await f.authorize(item));const command=await approveFixtureDeletion(f,f.db),snapshot=await f.db.dumpDataDir();await executeDeletion(f.db,command,{now:()=>f.now});
 const capture=await captureDeletionLedger(f.db,{endpoint:f.access.endpoint,now:()=>f.now+1}),operationId=randomUUID();let reads=0;
 const contribution=await captureDeletionRecoveryContribution({config:{tools:{docker:'synthetic-docker'},postgres:[{id:'business',container:'synthetic-pg',socketPath:'/tmp',administrator:'postgres',database:'galaxy_pilot'}]},controlDirectory:directory,operationId,endpoint:f.access.endpoint,
  run:async(_cmd,args)=>{reads++;assert.ok(args.includes('--quiet'));assert.ok(args.at(-1).includes('LOCK TABLE deletion_requests,deletion_events,deletion_executions,schema_migrations IN SHARE MODE'));return{code:0,stdout:capture.payloadJson};}});
 assert.equal(reads,1);assert.equal(contribution.signatureValidated,true);assert.equal(contribution.publicActivation,false);assert.equal(contribution.requests,1);
 const restored=new PGlite({loadDataDir:snapshot});t.after(()=>restored.close());const recoveryId=randomUUID();await restored.query("INSERT INTO recovery_state(singleton,recovery_id,snapshot_id,status) VALUES(true,$1,$2,'quarantined')",[recoveryId,'a'.repeat(64)]);
 const options={database:restored,contribution,recoveryId,endpoint:f.access.endpoint,executorRef:'maintenance-native-fixed',controlDirectory:directory,now:()=>f.now+10};
 const result=await replayDeletionRecoveryContribution(options);assert.equal(result.quarantined,true);assert.equal(result.publicActivationReady,false);assert.equal(result.requestsReplayed,1);
 assert.equal((await restored.query('SELECT id FROM cases WHERE id=$1',[item.id])).rows.length,0);assert.equal((await restored.query('SELECT status FROM recovery_state')).rows[0].status,'quarantined');
 assert.deepEqual(await replayDeletionRecoveryContribution(options),result);
 await assert.rejects(replayDeletionRecoveryContribution({...options,contribution:{...contribution,artifactPath:directory+'/unselected.json'}}),{code:'maintenance_recovery_facts_invalid'});
 const original=await readFile(contribution.artifactPath,'utf8');await writeFile(contribution.artifactPath,original+' ',{mode:0o600});await assert.rejects(replayDeletionRecoveryContribution(options),{code:'maintenance_recovery_facts_changed'});
});
