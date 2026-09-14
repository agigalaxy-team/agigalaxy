import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {builderDeclaration} from './builders-workflow.mjs';
import {checkChoiceSource} from './choice-source-check.mjs';
test('Choice Worker and Hub dependency witnesses use actual public declaration versions and current revocation',async()=>{
 const f=await serviceFixture(['binding','consent','builders'],null,{now:Math.floor(Date.now()/1000)});
 try{for(const type of ['worker','hub']){
  const event={id:randomUUID(),builderId:randomUUID(),kind:'declare',expectedRevision:0,declaration:builderDeclaration(type,f.actor.subjectId)};
  const grant=await f.authorize(event,'builder.publish',{visibility:'Public',purpose:'public-profile'});await f.builders.publish(f.actor,grant);
  const dep=await checkChoiceSource(f,f.actor,{type,query:{query:'Synthetic'}},event.builderId);
  assert.equal((await f.choices.sourceReader.statusWithin(f.db,f.actor,dep)).state,'current');
  await f.consents.revoke(f.actor,grant.consentId);assert.equal((await f.choices.sourceReader.statusWithin(f.db,f.actor,dep)).state,'unavailable');
 }}finally{await f.db.close();}
});
