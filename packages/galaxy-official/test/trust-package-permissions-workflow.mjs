import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {TrustPackagePermissionService} from "../src/verification/trust-package-permissions.mjs";
import {trustPackagePermissionsMigrationSql} from '../src/infrastructure/trust-package-permissions-schema-v1.mjs';
import {prepareTrustPackage,sealTrustPackage,verifyTrustPackage} from "../src/verification/trust-package.mjs";
import {digest} from '../src/shared/digest.mjs';
import {createApi} from '../src/http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

export async function verifyTrustPermissions({database=null,migrateDatabase=true,repositories,afterWorkflow,extraScopes=[],now=2000000000}={}){
 const scopes=['binding','consent','case-teaser','evidence',...extraScopes];
 const f=await serviceFixture(scopes,database,{migrateDatabase,repositories,now}),p=await serviceFixture(scopes,f.db,{migrateDatabase:false,repositories,now}),
   q=await serviceFixture(scopes,f.db,{migrateDatabase:false,repositories,now});
 const server=createApi({...f,rateLimit:1000});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}`;
 const paths={preview:'permissions/preview',submit:'permissions/submit',revokePreview:'permissions/revoke-preview',receipt:'permissions/receipt',status:'permissions/status',query:'permissions/query',sources:'sources'};
 async function http(method,actor,input){const who=[f,p,q].find(w=>w.actor.subjectId===actor?.subjectId);
   const response=await fetch(url+'/v2/trust-package/'+paths[method],{method:'POST',headers:{'Content-Type':'application/json',...(who?{Authorization:'Bearer '+who.credential}:{})},body:JSON.stringify(input)});
   const result=await response.json();if(!response.ok)throw new ServiceError(result.error??'http_error',response.status);return result;}
 try {
  if(!(await f.db.query("SELECT to_regclass('trust_package_permissions') name")).rows[0].name)await f.db.exec(trustPackagePermissionsMigrationSql);
  const real=f.trustPackages??new TrustPackagePermissionService(f.access,{cases:f.cases,verificationRecords:f.verificationRecords});
  const trust=new Proxy(real,{get:(target,name)=>paths[name]?((actor,input)=>http(name,actor,input)):typeof target[name]==='function'?target[name].bind(target):target[name]});
  const clock={now:f.now};f.access.now=()=>clock.now;
  const rootId=randomUUID(),record={schemaVersion:2,kind:'case-created',eventId:rootId,caseId:rootId,expectedVersion:0,
    actorId:f.actor.subjectId,localRef:randomUUID(),title:'Synthetic authored trust source',summary:'No production identity or verified result',
    source:{kind:'local',reference:randomUUID()},synthetic:true};
  const sourceAuth=await f.authorize(record,'case.teaser.publish',{objectId:rootId});await f.cases.submitV2(f.actor,sourceAuth);
  const ref={endpoint:f.access.endpoint,kind:'case-event',id:rootId,caseId:rootId,version:1};
  const audience={kind:'subjects',subjectIds:[p.actor.subjectId]},selection={selections:[{ref,mode:'reference'}],audience,expiresAt:f.now+100};
  await assert.rejects(http('sources',null,selection),e=>e.status===401);
  await assert.rejects(http('sources',f.actor,{...selection,claimActor:q.actor.subjectId}),e=>e.status===422);
  assert.equal((await trust.sources(f.actor,selection)).items[0].state,'available');
  assert.equal((await trust.sources(p.actor,selection)).items[0].state,'unavailable','borrowed private metadata is not a portable right');
  assert.equal((await trust.sources(f.actor,{...selection,selections:[{ref,mode:'copy'}]})).items[0].reason,'trust_reproduction_permission_required');
  const input={id:randomUUID(),operationId:randomUUID(),source:ref,grantee:p.actor.subjectId,audience,expiresAt:f.now+200};
  const preview=await trust.preview(f.actor,input);assert.equal(preview.granted,false);
  assert.equal((await trust.receipt(f.actor,{id:input.id})).state,'absent','decline preview requires no server mutation');
  const signed=await f.signForTest(preview.payloadJson,preview.signatureType);
  const replies=await Promise.all([trust.submit(f.actor,{signed}),trust.submit(f.actor,{signed})]);assert.deepEqual(replies[0],replies[1]);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM trust_package_permissions')).rows[0].n,1);
  await assert.rejects(trust.submit(p.actor,{signed}),/invalid_trust_signature/);
  assert.equal((await trust.receipt(q.actor,{id:input.id})).state,'absent');
  await assert.rejects(trust.status(q.actor,{id:input.id}),/trust_permission_unavailable/);
  const request={...selection,selections:[{ref,mode:'copy',permissionId:input.id}]};
  const snapshot=(await trust.sources(p.actor,request)).items[0].snapshot;
  assert.equal(snapshot.bodyText,sourceAuth.payloadJson);assert.equal(snapshot.sourceHash,digest(sourceAuth.payloadJson));
  assert.equal(snapshot.originalSignature,undefined,'do not leak original Consent recipients or bindings');
  assert.equal((await trust.sources(p.actor,{...request,audience:{kind:'public'}})).items[0].reason,'trust_permission_scope_mismatch');
  assert.equal((await trust.sources(p.actor,{...request,selections:[{ref:{...ref,version:2},mode:'copy',permissionId:input.id}]})).items[0].reason,'trust_permission_scope_mismatch');
  const identity=await f.access.runAuthorized(p.actor,'consent',db=>trust.identityWithin(db,p.actor.subjectId));
  const pack=await prepareTrustPackage({identity,keyId:digest(p.genesis.genesisProof.publicKeyPem),epoch:0,audience,
    issuedAt:f.now,expiresAt:f.now+100,claims:[],sources:[snapshot]},{now:f.now});
  const bundle=await sealTrustPackage(pack,await p.signForTest(pack.manifestJson,pack.signatureType));
  const offline=await verifyTrustPackage(bundle,{now:f.now});assert.equal(offline.integrity,'valid');assert.equal(offline.sources[0].reproductionPermission.status,'signature-and-scope-valid');
  const revoke=await trust.revokePreview(f.actor,{id:input.id,operationId:randomUUID()});
  const revokeSigned=await f.signForTest(revoke.payloadJson,revoke.signatureType);await trust.submit(f.actor,{signed:revokeSigned});
  assert.equal((await trust.submit(f.actor,{signed:revokeSigned})).status,'revoked');
  assert.equal((await trust.status(p.actor,{id:input.id})).status,'revoked');assert.equal((await trust.sources(p.actor,request)).items[0].state,'unavailable');
  const stillOffline=await verifyTrustPackage(bundle,{now:f.now});assert.equal(stillOffline.integrity,'valid');assert.equal(stillOffline.currentRevocationChecked,false);
  const next={...input,id:randomUUID(),operationId:randomUUID()},nextPreview=await trust.preview(f.actor,next);
  await trust.submit(f.actor,{signed:await f.signForTest(nextPreview.payloadJson,nextPreview.signatureType)});
  assert.equal((await trust.status(p.actor,{id:next.id})).status,'active');
  assert.equal((await trust.query(p.actor,{role:'grantee'})).items.length,2);
  const blocked={...input,id:randomUUID(),operationId:randomUUID()},blockedPreview=await trust.preview(f.actor,blocked);
  const policy=f.access.resourceBudgetPolicy;f.access.resourceBudgetPolicy={...policy,maxPayloadBytesPerSubject:0};
  await assert.rejects(trust.submit(f.actor,{signed:await f.signForTest(blockedPreview.payloadJson,blockedPreview.signatureType)}),e=>e.status===409);
  assert.equal((await trust.receipt(f.actor,{id:blocked.id})).state,'absent');f.access.resourceBudgetPolicy=policy;
  await f.consents.revoke(f.actor,sourceAuth.consentId);
  assert.equal((await trust.status(p.actor,{id:next.id})).status,'source-or-control-unavailable');
  assert.equal((await trust.sources(p.actor,{...request,selections:[{ref,mode:'copy',permissionId:next.id}]})).items[0].state,'unavailable');
  clock.now=f.now+201;assert.equal((await trust.status(p.actor,{id:next.id})).status,'expired');
  if(afterWorkflow)await afterWorkflow({f,p,q,trust,clock,input,next,ref,bundle});
  return {exactAuthorPermission:true,scopeAndVersionBound:true,parallelIdempotency:true,sourceRevocation:true,permissionRevocation:true,
    expiry:true,resourceBudgetRollback:true,actualHttp:true,originalConsentNotCopied:true,offlineSignatureDoesNotClaimCurrentRights:true,modelCalls:0};
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(!database)await f.db.close();}
}
