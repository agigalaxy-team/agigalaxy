import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {privacyConsumerFixture} from '../../galaxy-official/test/privacy-consumer-continuity-workflow.mjs';

test('automatic trust permission continuity only resends the saved signed original within its authority; export stays local',async t=>{
 const f=await privacyConsumerFixture();t.after(()=>f.close());const subjectId=f.original.subjectId,id=randomUUID(),payload={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,
  actorId:subjectId,localRef:randomUUID(),title:'本地合成资料包来源',summary:'本人真实签名的合成材料',synthetic:true,source:{kind:'local',reference:randomUUID()}};
 await f.runtime.api.call('/v2/cases/events',await f.runtime.api.authorizePayload(payload,{action:'case.teaser.publish',objectId:id,visibility:'Private',viewers:[],confirmed:true}));
 const client=f.runtime.trustPackages,audience={kind:'subjects',subjectIds:[subjectId]},input=()=>({id:randomUUID(),operationId:randomUUID(),source:{endpoint:f.runtime.api.endpoint,kind:'case-event',id,caseId:id,version:1},grantee:subjectId,audience,expiresAt:f.now()+600});
 let drop=true;f.wireHooks.before=path=>{if(drop&&path==='/v2/trust-package/permissions/submit'){drop=false;throw Error('synthetic trust before delivery');}};
 const p=await client.permissionPreview(input());await assert.rejects(client.executePermission(p,{confirmed:true}),/synthetic trust before delivery/);
 const operationId=preview=>JSON.parse(preview.payloadJson).operationId;
 const saved=await f.runtime.getLocal('trust-package:permission:'+operationId(p)),writes=()=>f.requests.filter(row=>row.path==='/v2/trust-package/permissions/submit').length;
 const [a,b]=await Promise.all([client.resumePending(),client.resumePending()]);assert.equal(a[0].state,'recorded');assert.deepEqual(b,[]);
 assert.equal((await f.runtime.getLocal('trust-package:permission:'+operationId(p))).signed,saved.signed);assert.equal(writes(),2,'one interrupted attempt and one exact signed dispatch');
 let lose=true;f.wireHooks.after=(path,response)=>{if(lose&&path==='/v2/trust-package/permissions/submit'){lose=false;assert.equal(response.status,200);throw Error('synthetic trust ACK lost');}};
 const accepted=await client.permissionPreview(input());await assert.rejects(client.executePermission(accepted,{confirmed:true}),/synthetic trust ACK lost/);
 let before=writes();assert.equal((await client.resumePending())[0].reconciled,true);assert.equal(writes(),before);
 drop=true;const stopped=await client.permissionPreview(input());await assert.rejects(client.executePermission(stopped,{confirmed:true}));await client.stopRetry(operationId(stopped));
 before=writes();assert.equal((await client.resumePending())[0].reason,'stopped-local');assert.equal(writes(),before);
 drop=true;const stale=await client.permissionPreview(input());await assert.rejects(client.executePermission(stale,{confirmed:true}));
 f.setTime(f.now()+301);before=writes();assert.equal((await client.resumePending()).find(row=>row.operationId===operationId(stale)).reason,'original-signature-stale');assert.equal(writes(),before);
 await f.runtime.connect({confirmed:true});drop=true;const expired=await client.permissionPreview({...input(),expiresAt:f.now()+10});await assert.rejects(client.executePermission(expired,{confirmed:true}));
 f.setTime(f.now()+11);before=writes();assert.equal((await client.resumePending()).find(row=>row.operationId===operationId(expired)).reason,'authorization-expired');assert.equal(writes(),before);
 drop=true;const priorBinding=await client.permissionPreview(input());await assert.rejects(client.executePermission(priorBinding,{confirmed:true}));await f.runtime.connect({confirmed:true});
 before=writes();assert.equal((await client.resumePending()).find(row=>row.operationId===operationId(priorBinding)).reason,'original-binding-changed');assert.equal(writes(),before);
 const beforeExport=f.requests.length,local=await client.exportPackage(await client.prepare({claims:[{id:randomUUID(),text:'只在本机导出的合成自述',authority:'self-asserted',capabilityVerified:false}],selections:[],audience,expiresAt:f.now()+600}),{confirmed:true});
 assert.equal(local.remotePublished,false);assert.equal(local.localSaved,true);assert.equal((await client.lastExport()).packageId,local.packageId);
 assert.equal(f.requests.slice(beforeExport).some(row=>row.path.startsWith('/v2/trust-package')),false);
});
