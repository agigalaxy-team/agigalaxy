import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {hubScopes} from './hub-peering-workflow.mjs';
import {approveFixtureDeletion} from './deletion-execute-workflow.mjs';
import {executeDeletion} from '../src/operations/deletion-execute.mjs';
import {productV2ExportDatasets} from '../src/infrastructure/lifecycle-export-v2.mjs';
export function checkHubLifecycle({admin,repositories}){return async({a,ah})=>{
  const member=await serviceFixture(hubScopes,a.db,{migrateDatabase:false,repositories,now:a.now,endpoint:a.access.endpoint});
  const membershipId=randomUUID(),invite={schemaVersion:2,id:randomUUID(),hubId:ah,kind:'invite',membershipId,memberId:member.actor.subjectId,expectedVersion:0,charterVersion:1,scopes:['approved-proof-query'],expiresAt:a.now+1000};
  await a.hubs.submit(a.actor,await a.authorize(invite,'hub.publish',{viewers:[member.actor.subjectId]}));
  const accept={schemaVersion:2,id:randomUUID(),hubId:ah,kind:'accept',membershipId,expectedVersion:1,charterVersion:1,acceptedScopes:['approved-proof-query']};
  await a.hubs.submit(member.actor,await member.authorize(accept,'hub.publish',{viewers:[a.actor.subjectId]}));
  const datasets=productV2ExportDatasets.filter(d=>d.startsWith('hub-')),ticket=await a.dataExport.create(a.actor,{id:randomUUID(),datasets});
  for(const dataset of datasets){const page=await a.dataExport.page(a.actor,{id:ticket.id,dataset});assert.ok(page.items.every(r=>!r.subject_id||r.subject_id===a.actor.subjectId));}
  const asker=await serviceFixture(hubScopes,a.db,{migrateDatabase:false,repositories,now:a.now,endpoint:a.access.endpoint}),threadId=randomUUID();
  const open={schemaVersion:2,id:randomUUID(),hubId:ah,kind:'intake-open',threadId,title:'Private synthetic intake',text:'ERASE ONLY ASKER TEXT'};
  await a.hubs.submit(asker.actor,await asker.authorize(open,'hub.publish',{viewers:[a.actor.subjectId]}));
  const reply={schemaVersion:2,id:randomUUID(),hubId:ah,kind:'intake-reply',threadId,expectedVersion:1,text:'INDEPENDENT OPERATOR REPLY'};
  await a.hubs.submit(a.actor,await a.authorize(reply,'hub.publish',{viewers:[asker.actor.subjectId]}));
  const eraseAsker=await approveFixtureDeletion(asker,admin,{auditUntil:a.now+180});await executeDeletion(admin,eraseAsker,{now:()=>a.now});
  const retained=(await a.hubs.intake(a.actor,{hubId:ah,threadId})).items[0];assert.equal(retained.state,'closed');
  assert.equal(retained.messages.length,1);assert.equal(retained.messages[0].text,reply.text);
  assert.equal((await admin.query('SELECT id FROM hub_events_v2 WHERE id=$1',[open.id])).rows.length,0,'deleted question body is not retained by the reply');
  const replyExport=await a.dataExport.create(a.actor,{id:randomUUID(),datasets:['hub-events-v2']});
  const exported=await a.dataExport.page(a.actor,{id:replyExport.id,dataset:'hub-events-v2'});
  assert.equal(exported.items.find(e=>e.id===reply.id).payload_text.includes(reply.text),true,'independent reply remains in its actual author export');
  const command=await approveFixtureDeletion(a,admin,{auditUntil:a.now+180});
  await assert.rejects(a.hubs.get(null,{hubId:ah}),/hub_unavailable/);
  const receipt=await executeDeletion(admin,command,{now:()=>a.now});assert.equal(receipt.externalCopies.state,'outside-service-control');
  assert.equal((await admin.query('SELECT payload_text FROM hub_events_v2 WHERE id=$1',[invite.id])).rows[0].payload_text,'','foreign member reference retains no deleted operator text');
  assert.ok((await admin.query('SELECT payload_text FROM hub_events_v2 WHERE id=$1',[accept.id])).rows[0].payload_text,'independent member accepted-event preserved');
  assert.equal((await a.hubs.members(member.actor,{hubId:ah})).items[0].authorization,'permission-unavailable');
};}
