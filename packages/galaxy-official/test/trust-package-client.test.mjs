import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createTrustPackageClient} from "../src/clients/trust-package.mjs";
import {TrustPackagePermissionService} from "../src/verification/trust-package-permissions.mjs";
import {trustPackagePermissionsMigrationSql} from '../src/infrastructure/trust-package-permissions-schema-v1.mjs';
import {digest} from '../src/shared/digest.mjs';

test('local export uses the existing real key without network; exact permission survives lost ACK/reload and does not re-sign',async()=>{
 const f=await serviceFixture(['binding','consent','case-teaser'],null,{now:Math.floor(Date.now()/1000)});
 try {
  if(!(await f.db.query("SELECT to_regclass('trust_package_permissions') name")).rows[0].name)await f.db.exec(trustPackagePermissionsMigrationSql);
  const service=new TrustPackagePermissionService(f.access,{cases:f.cases,verificationRecords:f.verificationRecords}),store=new Map();
  let calls=0,writes=0,signs=0,loseAck=false,changed=false;
  const current=async()=>({identity:await f.access.runAuthorized(f.actor,'consent',db=>service.identityWithin(db,f.actor.subjectId)),
    keyId:digest(f.genesis.genesisProof.publicKeyPem),epoch:0,bindingId:changed?randomUUID():f.actor.bindingId});
  const methods={'preview':'preview','submit':'submit','receipt':'receipt','status':'status','revoke-preview':'revokePreview'};
  const api={endpoint:f.access.endpoint,snapshot:()=>f.actor,call:async(path,input)=>{calls++;
    if(path.endsWith('/sources'))return service.sources(f.actor,input);
    const method=methods[path.split('/').at(-1)];assert.ok(method,'only explicit selected service routes');
    if(method==='submit')writes++;const result=await service[method](f.actor,input);
    if(method==='submit'&&loseAck){loseAck=false;throw new Error('synthetic-lost-ack');}return result;}};
  const options={api,current,sign:async(text,type)=>{signs++;return f.signForTest(text,type);},getLocal:async k=>structuredClone(store.get(k)),
    putLocal:async(k,v)=>{store.set(k,structuredClone(v));},locks:null,now:()=>f.now};
  const client=createTrustPackageClient(options),audience={kind:'subjects',subjectIds:[f.actor.subjectId]};
  const data={claims:[{id:randomUUID(),text:'Synthetic self assertion without experience',authority:'self-asserted',capabilityVerified:false}],audience,expiresAt:f.now+100};
  const preview=await client.prepare(data);assert.equal(calls,0);const exported=await client.exportPackage(preview,{confirmed:true});
  assert.equal(calls,0);assert.equal(signs,1);assert.equal(exported.remotePublished,false);
  const report=await client.importPackage(exported.container);assert.equal(report.capabilityVerified,false);assert.equal(calls,0);
  const tampered=await client.prepare(data);tampered.files['summary.md']+='changed';await assert.rejects(client.exportPackage(tampered,{confirmed:true}),/trust_preview_changed/);
  assert.equal(signs,1);const canceled=await client.prepare(data);await assert.rejects(client.exportPackage(canceled),/trust_preview_required/);
  const rootId=randomUUID(),record={schemaVersion:2,kind:'case-created',eventId:rootId,caseId:rootId,expectedVersion:0,
    actorId:f.actor.subjectId,localRef:randomUUID(),title:'Synthetic exact source',summary:'Unverified authored context',source:{kind:'local',reference:randomUUID()},synthetic:true};
  await f.cases.submitV2(f.actor,await f.authorize(record,'case.teaser.publish',{objectId:rootId}));
  const grant={id:randomUUID(),operationId:randomUUID(),source:{endpoint:f.access.endpoint,kind:'case-event',id:rootId,caseId:rootId,version:1},
    grantee:f.actor.subjectId,audience,expiresAt:f.now+100};
  const p=await client.permissionPreview(grant);assert.equal(writes,0);loseAck=true;
  await assert.rejects(client.executePermission(p,{confirmed:true}),/synthetic-lost-ack/);assert.equal(writes,1);assert.equal(signs,2);
  const restarted=createTrustPackageClient(options);assert.equal((await restarted.pending()).length,1);
  changed=true;const reconciled=await restarted.reconcile(grant.operationId);assert.equal(reconciled.state,'recorded');assert.equal(reconciled.reconciled,true);
  assert.equal(writes,1);assert.equal(signs,2);assert.equal((await restarted.pending()).length,0);
  const badEndpoint='https://package-instructions.invalid';const before=calls;
  await assert.rejects(client.checkOnline(exported.container,{selectedEndpoint:badEndpoint}),/trust_selected_endpoint_required/);assert.equal(calls,before);
  await client.deleteLocalExport();assert.equal(await client.lastExport(),null);
 }finally{await f.db.close();}
});
