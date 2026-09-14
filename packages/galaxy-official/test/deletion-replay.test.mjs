import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { serviceFixture } from './service-fixture.mjs';
import { approveFixtureDeletion } from './deletion-execute-workflow.mjs';
import { executeDeletion } from '../src/operations/deletion-execute.mjs';
import { captureDeletionLedger,replayDeletionLedger } from '../src/operations/deletion-ledger.mjs';
import { digest } from '../src/shared/digest.mjs';

test('old snapshot replays executed deletion, imports cancellation/new approval, rolls back failures and stays quarantined',async()=>{
  const scopes=['binding','consent','case-teaser','data-delete'];
  const f=await serviceFixture(scopes),other=await serviceFixture(scopes,f.db,{migrateDatabase:false});let restored;
  try{
    const root={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Snapshot deletion',summary:'Remove after snapshot',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(root));
    const command=await approveFixtureDeletion(f,f.db),cancelled=await approveFixtureDeletion(other,f.db);
    const snapshot=await f.db.dumpDataDir();
    await executeDeletion(f.db,command,{now:()=>f.now});
    const cancel={version:1,id:randomUUID(),action:'cancel',requestId:cancelled.requestId,expectedRevision:2,subjectId:other.actor.subjectId,bindingId:other.actor.bindingId,endpoint:f.access.endpoint,issuedAt:f.now,expiresAt:f.now+300};
    await other.deletion.submit(other.actor,await other.signForTest(JSON.stringify(cancel),'galaxy-deletion-intent+jws'));
    const approvedOnly=await approveFixtureDeletion(other,f.db);
    const capture=await captureDeletionLedger(f.db,{endpoint:f.access.endpoint,now:()=>f.now+1});
    restored=new PGlite({loadDataDir:snapshot});
    const recoveryId=randomUUID();await restored.query("INSERT INTO recovery_state(singleton,recovery_id,snapshot_id,status) VALUES(true,$1,$2,'quarantined')",[recoveryId,'a'.repeat(64)]);
    const replay={version:1,id:randomUUID(),recoveryId,endpoint:f.access.endpoint,ledgerSha256:capture.sha256,capturedNotBefore:f.now+1,executorRef:'synthetic-recovery'};
    await assert.rejects(replayDeletionLedger(restored,capture.payloadJson,{...replay,capturedNotBefore:f.now+2},{now:()=>f.now+10}),/cutoff/);
    const broken=JSON.parse(capture.payloadJson);broken.tables.deletion_events.pop();const bytes=JSON.stringify(broken);
    await assert.rejects(replayDeletionLedger(restored,bytes,{...replay,ledgerSha256:digest(bytes)},{now:()=>f.now+10}));
    await restored.query('ALTER TABLE deletion_replays ADD CONSTRAINT synthetic_replay_failure CHECK(false)');
    await assert.rejects(replayDeletionLedger(restored,capture.payloadJson,replay,{now:()=>f.now+10}),/synthetic_replay_failure/);
    assert.equal((await restored.query('SELECT id FROM cases WHERE id=$1',[root.id])).rows.length,1);
    assert.equal((await restored.query('SELECT state FROM deletion_requests WHERE id=$1',[command.requestId])).rows[0].state,'approved');
    await restored.query('ALTER TABLE deletion_replays DROP CONSTRAINT synthetic_replay_failure');
    const result=await replayDeletionLedger(restored,capture.payloadJson,replay,{now:()=>f.now+10});
    assert.equal(result.requestsReplayed,1);assert.equal(result.publicActivationReady,false);
    assert.equal((await restored.query('SELECT id FROM cases WHERE id=$1',[root.id])).rows.length,0);
    assert.equal((await restored.query('SELECT id FROM subjects WHERE id=$1',[f.actor.subjectId])).rows.length,0);
    assert.equal((await restored.query('SELECT id FROM subjects WHERE id=$1',[other.actor.subjectId])).rows.length,1);
    assert.equal((await restored.query('SELECT state FROM deletion_requests WHERE id=$1',[cancelled.requestId])).rows[0].state,'cancelled');
    assert.equal((await restored.query('SELECT state FROM deletion_requests WHERE id=$1',[approvedOnly.requestId])).rows[0].state,'approved');
    assert.equal((await restored.query('SELECT status FROM recovery_state')).rows[0].status,'quarantined');
    assert.deepEqual(await replayDeletionLedger(restored,capture.payloadJson,replay,{now:()=>f.now+20}),result);
    await assert.rejects(replayDeletionLedger(restored,capture.payloadJson,{...replay,id:randomUUID()},{now:()=>f.now+20}),/already replayed/);
    const recaptured=await captureDeletionLedger(restored,{endpoint:f.access.endpoint,now:()=>f.now+20});assert.ok(recaptured.bytes>capture.bytes);
  }finally{await restored?.close();await f.db.close();}
});
