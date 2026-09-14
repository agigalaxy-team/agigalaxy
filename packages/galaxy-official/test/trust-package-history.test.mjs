import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
test('portable reference preserves superseded Attempt version rather than reporting it as current',async()=>{
 const f=await serviceFixture();try{
  const caseId=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:f.actor.subjectId,
   localRef:randomUUID(),title:'Synthetic historical source',summary:'Original scope',source:{kind:'local',reference:randomUUID()},synthetic:true};
  const start={schemaVersion:2,kind:'attempt-start',eventId:randomUUID(),caseId,expectedVersion:1,actorId:f.actor.subjectId,
   role:'diagnosis',strategy:'Selected source',inputScopeSummary:'Own test',permissionScope:['read-selected-context']};
  const end={schemaVersion:2,kind:'attempt-end',eventId:randomUUID(),caseId,expectedVersion:2,actorId:f.actor.subjectId,
   attemptRef:{id:start.eventId,version:1},status:'canceled',summary:'User stopped',failureReason:'unknown'};
  for(const e of [root,start,end])await f.cases.submitV2(f.actor,await f.authorize(e,'case.teaser.publish',{objectId:e.eventId}));
  const response=await f.trustPackages.sources(f.actor,{selections:[{ref:{endpoint:f.access.endpoint,kind:'case-event',id:start.eventId,caseId,version:2},mode:'reference'},
   {ref:{endpoint:f.access.endpoint,kind:'case-event',id:end.eventId,caseId,version:3},mode:'reference'}],audience:{kind:'public'},expiresAt:f.now+100});
  assert.equal(response.items[0].snapshot.sourceState,'superseded');assert.equal(response.items[0].snapshot.ref.version,2);
  assert.equal(response.items[1].snapshot.sourceState,'current');assert.equal(response.items[1].snapshot.ref.version,3);
 }finally{await f.db.close();}
});
