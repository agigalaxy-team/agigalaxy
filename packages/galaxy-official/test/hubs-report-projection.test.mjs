import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {builderDeclaration} from './builders-workflow.mjs';
import {supportFor} from './builder-support-v2-workflow.mjs';
import {sampleCharter} from './hubs-workflow.mjs';
import {digest} from '../src/shared/digest.mjs';

test('Hub report selection exposes only currently readable exact event hashes and bounded report meaning',async()=>{
 const f=await serviceFixture(['binding','consent','builders'],null,{now:Math.floor(Date.now()/1000)});
 try{
  const assessor=await serviceFixture(['binding','consent','builders'],f.db,{now:f.now,migrateDatabase:false});f.builders.assessorIds.add(assessor.actor.subjectId);
  const hubId=randomUUID(),declaration=builderDeclaration('hub',f.actor.subjectId),pub={visibility:'Public',purpose:'public-profile'},declared={id:randomUUID(),builderId:hubId,kind:'declare',expectedRevision:0,declaration};
  await f.builders.publish(f.actor,await f.authorize(declared,'builder.publish',pub));
  const current=await f.builders.get(f.actor,{builderId:hubId}),support={id:randomUUID(),builderId:hubId,kind:'support-profile',expectedRevision:1,declarationId:current.declarationId,declarationHash:current.declarationHash,support:{...supportFor(declaration),objectActions:['hub.core'],missingCapabilities:['worker.execute']}};
  await f.builders.v2.publish(f.actor,await f.authorize(support,'builder.publish',pub));
  const report={id:randomUUID(),builderId:hubId,kind:'scope-report',expectedRevision:2,declarationId:current.declarationId,declarationHash:current.declarationHash,profile:'galaxy-builder-scope-report/1',supportId:support.id,supportHash:digest(JSON.stringify(support)),suite:{name:'Synthetic report fixture',version:'1',source:'https://fixture.example/suite',sha256:digest('synthetic suite')},run:{id:randomUUID(),sourceHash:digest('synthetic source'),reportHash:digest('synthetic report'),runnerVersion:'1',environment:'Synthetic source metadata only',testClass:'format'},checks:[{action:'hub.core',status:'not-tested',detail:'No execution result asserted by this metadata fixture.'}],observedAt:f.now,expiresAt:f.now+3600,limitations:'Synthetic report permission/hash projection; no capability or interoperability claim.'};
  const auth=await assessor.authorize(report,'builder.publish',pub);await f.builders.v2.publish(assessor.actor,auth);
  const charter={schemaVersion:2,id:randomUUID(),hubId,kind:'charter',expectedVersion:0,declarationId:current.declarationId,declarationHash:current.declarationHash,charter:sampleCharter(f.now)};
  await f.hubs.submit(f.actor,await f.authorize(charter,'hub.publish',pub));
  const projected=(await f.hubs.manage(f.actor,{hubId})).reports[0],row=(await f.db.query('SELECT payload_hash FROM builder_events WHERE id=$1',[report.id])).rows[0];
  assert.equal(projected.payloadHash,row.payload_hash);assert.equal(projected.canReferenceInCharter,true);assert.equal(projected.publiclyReadable,true);
  assert.equal(projected.validity,'current');assert.equal(projected.checks[0].status,'not-tested');assert.equal(projected.independentExecutionVerified,false);
  await assessor.consents.revoke(assessor.actor,auth.consentId);
  assert.deepEqual((await f.hubs.manage(f.actor,{hubId})).reports,[],'withdrawn report bodies and their selectable references are not resurrected');
 }finally{await f.db.close();}
});
