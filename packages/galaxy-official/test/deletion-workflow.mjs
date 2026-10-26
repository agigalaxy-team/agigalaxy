import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { createDeletionClient } from "../src/clients/deletion.mjs";
import { createHostConnectionController } from "../src/clients/flows/host-connection-controller.mjs";
import { reviewDeletionRequest } from '../src/operations/deletion-review.mjs';
import { createRetirementController } from "../src/privacy/retirement.mjs";
import { retirementFixturePolicy } from './retirement-workflow.mjs';

export async function verifyDeletionWorkflow(database = null, options = {}) {
  const scopes = ['binding','consent','case-teaser','data-export','data-delete'];
  let clock = 2000000000;
  const retirement = createRetirementController(retirementFixturePolicy(clock), { now: () => clock });
  const f = await serviceFixture(scopes, database, {...options,retirement});
  const other = await serviceFixture(scopes, f.db, {...options,migrateDatabase:false});
  const sessions = createSessionMemory({ now: () => f.now, isCurrent: async () => true });
  sessions.adopt({endpoint:f.access.endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,scopes,
    expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>f.credential});
  const api=createApi({...f,rateLimit:200}); await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`;
  let signCalls=0,lastSigned;
  const send=async(url,input)=>{const response=await fetch(origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.credential}`},body:input.bodyJson,signal:input.signal});
    const value=await response.json();if(response.status!==200)throw new Error(value.error);return value;};
  const client=createDeletionClient({endpoint:f.access.endpoint,sessions,now:()=>f.now,send,signIntent:async(payload,typ)=>{signCalls++;lastSigned=await f.signForTest(payload,typ);return lastSigned;}});
  const host=createHostConnectionController({endpoint:f.access.endpoint,sessions,deletionClient:client});
  const input={action:'request',scope:'all-owned-service-data',reason:'account-exit',takeout:'already-exported',exportManifestSha256:'a'.repeat(64)};
  const review=(request,decision,extra={})=>({version:1,id:randomUUID(),requestId:request.id,endpoint:f.access.endpoint,
    expectedRevision:request.revision,reviewerRef:'synthetic-reviewer',decision,explanation:'Synthetic review only',...extra});
  const reviewer=options.reviewerDatabase??f.db;
  try {
    const root={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Deletion fixture',summary:'Preserve until actual execution',
      source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(root));
    clock+=20; assert.equal((await host.readDeletion('config')).physicalDeletionOnSubmission,false);
    const canceled=await host.prepareDeletion(input);assert.equal(signCalls,0);host.cancel();await assert.rejects(host.executeDeletion(canceled,canceled.confirmation));assert.equal(signCalls,0);
    const preview=await host.prepareDeletion(input);
    await assert.rejects(host.executeDeletion(preview,'wrong'),/confirmation/);
    // A failed confirmation closes the host operation; prepare a fresh intent.
    host.cancel();const confirmed=await host.prepareDeletion(input),requested=await host.executeDeletion(confirmed,confirmed.confirmation);
    assert.equal(requested.state,'requested');assert.equal(signCalls,1);assert.equal(requested.physicalDeletionPerformed,false);
    assert.deepEqual(await f.deletion.submit(f.actor,lastSigned),requested);
    const details=await host.readDeletion('read',{id:requested.id});assert.equal(details.request.signature,lastSigned);assert.equal(details.events.length,1);
    assert.equal((await host.readDeletion('query')).items[0].id,requested.id);
    await assert.rejects(f.deletion.read(other.actor,{id:requested.id}),/not_found/);
    const forged=await other.signForTest(confirmed.payloadJson,'galaxy-deletion-intent+jws');await assert.rejects(f.deletion.submit(f.actor,forged),/signature/);
    const duplicate=await client.prepare(input);await assert.rejects(client.execute(duplicate,duplicate.confirmation),/active_deletion_request_exists/);
    const needs=await reviewDeletionRequest(reviewer,review(requested,'needs-information'));assert.equal(needs.state,'review-needed');
    const remaining=await client.read({id:requested.id,afterRevision:1});assert.equal(remaining.events[0].kind,'needs-information');assert.equal(remaining.events[0].signature,null);
    const rejected=await reviewDeletionRequest(reviewer,review(needs,'reject'));assert.equal(rejected.state,'rejected');
    const second=await host.prepareDeletion({...input,takeout:'not-needed',exportManifestSha256:undefined}),newRequest=await host.executeDeletion(second,second.confirmation);
    const plan={policyId:'synthetic-retention',policyVersion:'1',primary:{action:'delete-owned-data',notBefore:f.now+60,basis:'Synthetic exercise'},
      audit:{action:'retain-minimum',until:f.now+600,basis:'Synthetic exercise'},backups:{action:'expire-snapshots-and-replay-deletions',until:f.now+1200,basis:'Synthetic exercise'},externalCopies:'outside-service-control'};
    await assert.rejects(reviewDeletionRequest(reviewer,review(newRequest,'approve')));
    const approval=review(newRequest,'approve',{plan}),approved=await reviewDeletionRequest(reviewer,approval);assert.equal(approved.state,'approved');
    assert.deepEqual(await reviewDeletionRequest(reviewer,approval),approved);
    await assert.rejects(reviewDeletionRequest(reviewer,{...approval,explanation:'Changed without new event ID'}),/conflict/);
    const exported=await f.dataExport.create(f.actor,{id:randomUUID(),datasets:['deletion-requests','deletion-events']});
    const exportedEvents=await f.dataExport.page(f.actor,{id:exported.id,dataset:'deletion-events'});
    assert.equal(exportedEvents.items.length,5);assert.ok(exportedEvents.items.some(event=>event.kind==='approve'));
    const stale=await host.prepareDeletion({action:'cancel',requestId:newRequest.id,expectedRevision:1});await assert.rejects(host.executeDeletion(stale,stale.confirmation),/changed/);
    const cancel=await host.prepareDeletion({action:'cancel',requestId:newRequest.id,expectedRevision:approved.revision});
    assert.equal((await host.executeDeletion(cancel,cancel.confirmation)).state,'cancelled');
    await assert.rejects(reviewDeletionRequest(reviewer,review({...approved,revision:3},'approve',{plan})),/changed/);
    assert.equal((await f.cases.get(f.actor,root.id)).caseId,root.id);
    const oldNow=f.access.now;f.access.now=()=>f.now+301;
    try { const expired=await client.prepare(input);await assert.rejects(client.execute(expired,expired.confirmation),/expired/); }
    finally { f.access.now=oldNow; }
    const audit=(await f.db.query("SELECT action,scope,context_version FROM audit_events WHERE actor=$1 AND action LIKE 'data.deletion.%'",[f.actor.subjectId])).rows;
    assert.equal(audit.length,3);assert.ok(audit.every(row=>row.scope==='data-delete'&&row.context_version===1));
    const admin=options.adminDatabase??f.db;
    await admin.query('UPDATE access_credentials SET scopes=$2::jsonb WHERE token_hash=$1',[f.actor.credentialHash,JSON.stringify(['binding'])]);
    await assert.rejects(f.deletion.read(f.actor,{id:newRequest.id}),/access_denied/);
    return {signedIntake:true,scopeEnforced:true,operatorReview:true,ownerHistoryAndCancel:true,exportedLedger:true,physicalDeletionPerformed:false};
  } finally { host.cancel();sessions.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!database)await f.db.close(); }
}
