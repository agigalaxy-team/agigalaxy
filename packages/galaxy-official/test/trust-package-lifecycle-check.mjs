import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {approveFixtureDeletion} from './deletion-execute-workflow.mjs';
import {executeDeletion} from '../src/operations/deletion-execute.mjs';
import {cleanupProductV2Retention} from '../src/operations/lifecycle-retention-v2.mjs';

export function checkTrustLifecycle({admin,worker}={}) {return async({f,p,q,trust,clock,input,ref})=>{
 const db=admin??f.db,workerDb=worker??f.db;
 const own=await f.dataExport.create(f.actor,{id:randomUUID(),datasets:['trust-package-permissions']});
 const exported=await f.dataExport.page(f.actor,{id:own.id,dataset:'trust-package-permissions'});
 assert.equal(exported.items.length,2);assert.ok(exported.items.every(r=>r.subject_id===f.actor.subjectId));
 assert.equal(exported.items.some(r=>r.payload_text.includes('No production identity')),false,'source body never stored in license');
 const other=await p.dataExport.create(p.actor,{id:randomUUID(),datasets:['trust-package-permissions']});
 assert.equal((await p.dataExport.page(p.actor,{id:other.id,dataset:'trust-package-permissions'})).items.length,0,'receiving a license is not authorship');
 async function fresh(who){const id=randomUUID(),event={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,actorId:who.actor.subjectId,
   localRef:randomUUID(),title:'Synthetic retained license',summary:'Authored original for lifecycle',source:{kind:'local',reference:randomUUID()},synthetic:true};
  await who.cases.submitV2(who.actor,await who.authorize(event,'case.teaser.publish',{objectId:id}));
  const target={...ref,id,caseId:id},grant={id:randomUUID(),operationId:randomUUID(),source:target,grantee:q.actor.subjectId,
   audience:{kind:'subjects',subjectIds:[q.actor.subjectId]},expiresAt:f.now+400};
  const view=await who.trustPackages.preview(who.actor,grant);await who.trustPackages.submit(who.actor,{signed:await who.signForTest(view.payloadJson,view.signatureType)});return grant;
 }
 const pending=await fresh(f),independent=await fresh(p);
 assert.equal((await trust.status(q.actor,{id:pending.id})).status,'active');
 const command=await approveFixtureDeletion(f,db,{auditUntil:clock.now+180});
 assert.equal((await trust.status(q.actor,{id:pending.id})).status,'source-or-control-unavailable','pending deletion stops new copies before execution');
 const deleted=await executeDeletion(db,command,{now:()=>clock.now});
 assert.equal(deleted.deletedCounts.trust_package_permissions,3);assert.equal(deleted.externalCopies.state,'outside-service-control');
 assert.equal((await db.query('SELECT id FROM trust_package_permissions WHERE subject_id=$1',[f.actor.subjectId])).rows.length,0);
 assert.equal((await db.query('SELECT id FROM trust_package_permissions WHERE id=$1',[independent.id])).rows.length,1,'other author license preserved');
 const swept=await cleanupProductV2Retention(workerDb,{now:()=>f.now+400+180*86400});
 assert.equal(swept.removed.trustPackagePermissionReceipts,1);
 assert.equal((await db.query('SELECT id FROM trust_package_permissions WHERE id=$1',[independent.id])).rows.length,0);
};}
