import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { serviceFixture } from './service-fixture.mjs';
import { approveFixtureDeletion } from './deletion-execute-workflow.mjs';
import { executeDeletion } from '../src/operations/deletion-execute.mjs';
import { minimizeDeletionReceipt } from '../src/operations/deletion-minimize.mjs';
import { captureDeletionLedger,replayDeletionLedger } from '../src/operations/deletion-ledger.mjs';
import { readDeletionEventPayload } from '../src/shared/deletion-event-payload.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createDeletionClient } from '../src/deletion-client.mjs';

export async function verifyDeletionMinimization(database=null,options={}){
  const scopes=['binding','consent','case-teaser','data-delete'];
  const f=await serviceFixture(scopes,database,options),admin=options.adminDatabase??f.db;
  const other=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false});let restored,api;
  const sessions=createSessionMemory({now:()=>other.now,isCurrent:async()=>true});
  try{
    const root={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Minimum receipt',summary:'Synthetic',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(root));
    const command=await approveFixtureDeletion(f,admin);
    const original=(await f.db.query('SELECT signature FROM deletion_requests WHERE id=$1',[command.requestId])).rows[0].signature;
    const snapshot=!database?await f.db.dumpDataDir():null;
    const executed=await executeDeletion(admin,command,{now:()=>f.now});
    const minimize={version:1,id:randomUUID(),requestId:command.requestId,endpoint:f.access.endpoint,expectedRevision:executed.revision,operatorRef:'synthetic-retention',
      policy:{id:'synthetic-only',version:'1',notBefore:f.now,basis:'Synthetic receipt minimization'}};
    await assert.rejects(minimizeDeletionReceipt(admin,minimize,{now:()=>f.now+3599}),/not due/);
    const minimized=await minimizeDeletionReceipt(admin,minimize,{now:()=>f.now+3600});
    assert.equal(minimized.execution.minimized,true);assert.equal(minimized.execution.selectedCounts,undefined);assert.equal(minimized.execution.receiptLedger.cleanupImplemented,true);
    assert.ok(minimized.minimization.payloadBytesRemoved>0);assert.equal(minimized.minimization.eventsMinimized,2);
    assert.deepEqual(await minimizeDeletionReceipt(admin,minimize,{now:()=>f.now+3601}),minimized);
    await assert.rejects(minimizeDeletionReceipt(admin,{...minimize,operatorRef:'changed'},{now:()=>f.now+3601}),/conflict/);
    const rows=(await f.db.query('SELECT * FROM deletion_events WHERE request_id=$1 ORDER BY revision',[command.requestId])).rows;
    assert.equal(rows[0].signature,original);assert.equal(rows[1].payload_text,'');assert.equal(rows[2].payload_text,'');
    assert.match(readDeletionEventPayload(rows[1]).explanation,/^sha256:/);
    assert.equal(readDeletionEventPayload(rows[2]).originalResultSha256,rows[2].payload_hash);
    assert.throws(()=>readDeletionEventPayload({...rows[1],retained_payload:{...rows[1].retained_payload,explanation:'tampered'}}),/mismatch/);
    const intent={version:1,id:randomUUID(),action:'status',requestId:command.requestId,endpoint:f.access.endpoint,subjectId:f.actor.subjectId,issuedAt:f.now,expiresAt:f.now+300};
    assert.equal((await f.deletion.statusWithProof(await f.signForTest(JSON.stringify(intent),'galaxy-deletion-status+jws'))).execution.minimized,true);
    // A cancelled request retains its subject cancellation signature and keeps
    // the account alive; the ordinary authenticated client can read its summary.
    const canceled=await approveFixtureDeletion(other,admin);
    const cancel={version:1,id:randomUUID(),action:'cancel',requestId:canceled.requestId,expectedRevision:2,endpoint:f.access.endpoint,subjectId:other.actor.subjectId,bindingId:other.actor.bindingId,issuedAt:f.now,expiresAt:f.now+300};
    await f.deletion.submit(other.actor,await other.signForTest(JSON.stringify(cancel),'galaxy-deletion-intent+jws'));
    await minimizeDeletionReceipt(admin,{...minimize,id:randomUUID(),requestId:canceled.requestId,expectedRevision:3},{now:()=>f.now+3600});
    api=createApi({...f,rateLimit:200});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    sessions.adopt({endpoint:f.access.endpoint,subjectId:other.actor.subjectId,bindingId:other.actor.bindingId,scopes,expiresAt:f.now+300,bindingExpiresAt:f.now+500,takeCredential:()=>other.credential});
    const client=createDeletionClient({endpoint:f.access.endpoint,sessions,now:()=>f.now,send:async(url,input)=>{
      const response=await fetch(`http://127.0.0.1:${api.address().port}`+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.credential}`},body:input.bodyJson});assert.equal(response.status,200);return response.json();}});
    const details=await client.read({id:canceled.requestId});assert.equal(details.state,'cancelled');assert.equal(details.events[1].payload_minimized,true);assert.equal(details.events[2].signature!==null,true);
    const capture=await captureDeletionLedger(admin,{endpoint:f.access.endpoint,now:()=>f.now+3601});
    const capturedEvents=JSON.parse(capture.payloadJson).tables.deletion_events.filter(event=>[command.requestId,canceled.requestId].includes(event.request_id));
    assert.ok(!JSON.stringify(capturedEvents).includes('Synthetic execution exercise'));
    if(snapshot){
      restored=new PGlite({loadDataDir:snapshot});const recoveryId=randomUUID();
      await restored.query("INSERT INTO recovery_state(recovery_id,snapshot_id,status) VALUES($1,$2,'quarantined')",[recoveryId,'c'.repeat(64)]);
      const replay=await replayDeletionLedger(restored,capture.payloadJson,{version:1,id:randomUUID(),recoveryId,endpoint:f.access.endpoint,ledgerSha256:capture.sha256,capturedNotBefore:f.now+3601,executorRef:'synthetic-minimum-replay'},{now:()=>f.now+3610});
      assert.equal(replay.requestsReplayed,1);
      assert.equal((await restored.query('SELECT id FROM cases WHERE id=$1',[root.id])).rows.length,0);
      assert.equal((await restored.query('SELECT payload_text FROM deletion_events WHERE id=$1',[command.approvalId])).rows[0].payload_text,'');
      await captureDeletionLedger(restored,{endpoint:f.access.endpoint,now:()=>f.now+3611});
    }
    return {operatorTextCleared:true,signedIntentsRetained:true,clientReadsSummary:true,ownerStatus:true,duePolicyEnforced:true,idempotent:true,minimizedLedgerCaptured:true,oldSnapshotReplay:!database};
  }finally{sessions.close();if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}await restored?.close();if(!database)await f.db.close();}
}
