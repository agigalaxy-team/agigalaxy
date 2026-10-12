import test from 'node:test';
import assert from 'node:assert/strict';
import {capsuleWebContinuityFixture} from '../../galaxy-official/test/capsule-web-continuity-fixture.mjs';
import {isCapsuleCaseFacts,applicationResults,exactApplicationOrigin} from '../src/capsule-application-model.mjs';

test('application preview accepts the real current Case read without the history-list kind wrapper, retaining the exact result and origin',async t=>{
 const f=await capsuleWebContinuityFixture();t.after(()=>f.close());
 const current=await f.author.client.caseFacts({caseId:f.own.caseId});
 assert.equal(current.kind,undefined);
 assert.equal(isCapsuleCaseFacts(current),true);
 const results=applicationResults(current,f.author.identity.subjectId);
 assert.deepEqual(results.map(item=>({id:item.id,version:item.version})),[{id:f.own.result.eventId,version:1}]);
 const origin=exactApplicationOrigin(current,results[0],f.author.identity.subjectId);
 assert.deepEqual(origin.ref,{kind:'attempt',id:f.own.attempt.eventId,version:1});
 assert.equal(isCapsuleCaseFacts({caseId:f.own.caseId,eventId:f.own.result.eventId,record:null}),false);
 assert.equal(isCapsuleCaseFacts({caseId:f.own.caseId,attempts:[],interventions:[]}),false);
});
