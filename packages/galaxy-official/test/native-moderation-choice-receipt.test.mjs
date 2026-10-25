import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {nativeHttpDefinitions} from '../../galaxy-edge-mcp/src/native-v2/tools/http.mjs';
import {choicePutIntent,choiceReceiptResultSchema} from '../src/shared/choice-snapshot-schema-v2.mjs';
import {moderationReceiptResultSchema} from '../src/shared/moderation-schema.mjs';
import {digest} from '../src/shared/digest.mjs';

// Actual native transport -> HTTP -> signed Consent/PGlite. These identities
// and statements are synthetic; no model, real allegation or public action.
async function fixture(){
 const f=await serviceFixture(browserScopes);let api;
 try{
  const other=await serviceFixture(browserScopes,f.db,{migrateDatabase:false,now:f.now});
  api=createApi({...f,rateLimit:1000});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`,calls=[];
  const client=credential=>nativeHttpDefinitions({call:async(path,input,options={})=>{
   calls.push({path,input});const response=await fetch(origin+path,{method:options.method??'POST',
    headers:{'content-type':'application/json',...(credential?{authorization:`Bearer ${credential}`}:{})},
    ...(options.method==='GET'?{}:{body:JSON.stringify(input)})});
   const body=await response.json();if(!response.ok)throw Object.assign(new Error(body.error),{status:response.status});return body;
  }});
  return{...f,other,calls,tools:client(f.credential),otherTools:client(other.credential),anonymous:client(null),
   close:async()=>{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}};
 }catch(error){if(api?.listening){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}await f.db.close();throw error;}
}
const invoke=(tools,name,input)=>tools[name].run(tools[name].inputSchema.parse(input));

test('native complete moderation adapters invoke real config/query/read/report/event/receipt with exact signed bytes and current authority',async()=>{
 const f=await fixture();try{
  f.moderation.moderatorIds=[f.other.actor.subjectId];
  const caseId=randomUUID(),root={kind:'case',id:caseId,localRef:randomUUID(),title:'Synthetic native review target',summary:'Owner private original',
   source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
  const source=await f.authorize(root,'case.teaser.publish',{viewers:[f.other.actor.subjectId]});await f.cases.submit(f.actor,source);
  assert.deepEqual((await invoke(f.tools,'galaxy_moderation_config',{})).moderatorIds,[f.other.actor.subjectId]);
  const id=randomUUID(),report={id,caseId,caseVersion:1,targetEventId:caseId,category:'scope',summary:'Synthetic concern for transport validation'};
  const signed=await f.authorize(report,'moderation.publish',{objectId:id,viewers:[f.other.actor.subjectId]});
  const created=await invoke(f.tools,'galaxy_moderation_report',signed);assert.equal(created.version,1);
  assert.equal(f.calls.at(-1).input.payloadJson,signed.payloadJson);
  assert.deepEqual((await invoke(f.tools,'galaxy_moderation_query',{caseId})).items.map(x=>x.reportId),[id]);
  assert.equal((await invoke(f.tools,'galaxy_moderation_get',{reportId:id})).version,1);
  const event={id:randomUUID(),reportId:id,expectedVersion:1,kind:'supplement',summary:'Synthetic owner addition',references:[]};
  const signedEvent=await f.authorize(event,'moderation.publish',{objectId:event.id,viewers:[f.other.actor.subjectId]});
  assert.equal((await invoke(f.tools,'galaxy_moderation_event',{reportId:id,...signedEvent})).version,2);
  assert.deepEqual(f.calls.at(-1),{path:`/v1/moderation/reports/${id}/events`,input:signedEvent});
  const writesBefore=f.calls.filter(x=>x.path==='/v1/moderation/reports'||x.path.endsWith('/events')).length;
  await f.consents.revoke(f.actor,signed.consentId);await f.consents.revoke(f.actor,signedEvent.consentId);await f.consents.revoke(f.actor,source.consentId);
  const query={reportId:id,eventId:event.id,payloadHash:digest(signedEvent.payloadJson)};
  const ack=moderationReceiptResultSchema.parse(await invoke(f.tools,'galaxy_moderation_receipt',query));
  assert.equal(ack.state,'acknowledged');assert.equal(ack.receipt.version,2);assert.equal(ack.contentReturned,false);assert.equal(ack.currentAccessGranted,false);
  assert.equal(f.calls.filter(x=>x.path==='/v1/moderation/reports'||x.path.endsWith('/events')).length,writesBefore);
  assert.equal((await invoke(f.otherTools,'galaxy_moderation_receipt',query)).state,'absent','moderator role does not make this another author’s receipt');
  assert.equal((await invoke(f.tools,'galaxy_moderation_receipt',{...query,payloadHash:'0'.repeat(64)})).state,'conflict');
  await assert.rejects(invoke(f.anonymous,'galaxy_moderation_config',{}),error=>error.status===401);
  const view=await invoke(f.tools,'galaxy_moderation_get',{reportId:id});assert.equal(view.report,null);assert.equal(view.source,null);
  assert.equal(view.events.some(x=>x.id===event.id),false);
 }finally{await f.close();}
});

test('native original Choice receipt returns the accepted old version after replacement and opt-out without restoring its body or sending again',async()=>{
 const f=await fixture();try{
  const id=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,actorId:f.actor.subjectId,
   localRef:randomUUID(),title:'Native original Choice receipt source',summary:'Synthetic public history source',synthetic:true,source:{kind:'local',reference:randomUUID()}};
  const source=await f.authorize(root,'case.teaser.publish',{objectId:id,visibility:'Public',purpose:'public-profile'});await f.cases.submitV2(f.actor,source);
  const search={type:'history',query:{query:'Native original Choice',limit:8}},candidate=(await f.search.v2.query(f.actor,search)).items[0];assert.ok(candidate);
  const snapshotId=randomUUID(),request={snapshotId,versionId:randomUUID(),baseRevision:0,preferenceRevision:1,
   content:{localVersion:1,localTaskRef:'Synthetic local work',visibleRationale:'Selected by synthetic owner',rationaleAuthor:'user',
    candidateRefs:[{type:candidate.type,...candidate.ref}],selectedRefs:[{type:candidate.type,...candidate.ref}],resultRefs:[]},witnesses:[{search,ref:candidate.ref}]};
  await invoke(f.tools,'galaxy_choice_preferences_save',{endpoint:f.access.endpoint,expectedRevision:0,enabled:true,snapshotIds:[snapshotId]});
  await invoke(f.tools,'galaxy_choice_put',request);
  await invoke(f.tools,'galaxy_choice_put',{...request,versionId:randomUUID(),baseRevision:1,content:{...request.content,localVersion:2,visibleRationale:'Explicit later selection'}});
  await invoke(f.tools,'galaxy_choice_preferences_save',{endpoint:f.access.endpoint,expectedRevision:1,enabled:false,snapshotIds:[]});
  await f.consents.revoke(f.actor,source.consentId);
  const query={snapshotId,versionId:request.versionId,requestHash:digest(canonicalize(choicePutIntent(request)))},before=f.calls.length;
  const ack=choiceReceiptResultSchema.parse(await invoke(f.tools,'galaxy_choice_receipt',query));
  assert.equal(ack.state,'acknowledged');assert.equal(ack.receipt.storedState,'superseded');assert.equal(ack.contentReturned,false);
  assert.deepEqual(f.calls.slice(before),[{path:'/v2/choice-snapshots/receipt',input:query}]);
  assert.equal((await invoke(f.otherTools,'galaxy_choice_receipt',query)).state,'absent');
  await assert.rejects(invoke(f.anonymous,'galaxy_choice_receipt',query),error=>error.status===401);
  assert.equal(f.tools.galaxy_choice_receipt.write,false);assert.equal(f.tools.galaxy_choice_receipt.scope,'binding');
  assert.equal(f.tools.galaxy_choice_receipt.inputSchema.safeParse({...query,content:request.content}).success,false);
 }finally{await f.close();}
});
