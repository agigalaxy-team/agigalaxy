import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from '../../galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../galaxy-official/src/http.mjs';
import {digest} from '../../galaxy-official/src/shared/digest.mjs';
import {nativeHttpDefinitions} from '../src/native-v2/tools/http.mjs';

test('native fact receipt adapters invoke the real authenticated HTTP routes after source withdrawal',async()=>{
 const f=await serviceFixture(['binding','consent','case-teaser','assistance','context']);const api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 try{const caseId=randomUUID(),event={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:f.actor.subjectId,localRef:randomUUID(),title:'Synthetic native receipt adapter',summary:'Private old fact must stay withheld',source:{kind:'local',reference:randomUUID()},synthetic:true};
  const signed=await f.authorize(event,'case.teaser.publish',{objectId:event.eventId});await f.cases.submitV2(f.actor,signed);await f.consents.revoke(f.actor,signed.consentId);
  const calls=[],origin='http://127.0.0.1:'+api.address().port,definitions=nativeHttpDefinitions({call:async(path,input)=>{calls.push({path,input});const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+f.credential},body:JSON.stringify(input)});const body=await response.json();if(!response.ok)throw new Error(body.error);return body;}});
  const query={caseId,eventId:caseId,payloadHash:digest(signed.payloadJson)},result=await definitions.galaxy_case_v2_receipt.run(query);
  assert.equal(definitions.galaxy_case_v2_receipt.write,false);assert.equal(result.state,'acknowledged');assert.equal(result.currentAccessGranted,false);assert.equal(JSON.stringify(result).includes(event.summary),false);assert.deepEqual(calls[0],{path:'/v2/cases/events/receipt',input:query});
  const link={taskId:randomUUID(),operationId:randomUUID(),payloadHash:'0'.repeat(64)};assert.equal((await definitions.galaxy_task_case_link_receipt.run(link)).state,'absent');assert.equal(definitions.galaxy_task_case_link_receipt.write,false);
  assert.deepEqual(calls[1],{path:`/v2/tasks/${link.taskId}/case-link/receipt`,input:{operationId:link.operationId,payloadHash:link.payloadHash}});
  const context={grantId:randomUUID(),eventId:randomUUID(),payloadHash:'0'.repeat(64)};assert.equal((await definitions.galaxy_context_v2_receipt.run(context)).state,'absent');
  assert.equal(calls.length,3,'Only the original read-only receipt transports were invoked');
 }finally{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}
});
