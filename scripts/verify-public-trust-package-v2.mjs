import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createWebRuntime,loadWebConfiguration} from '../packages/galaxy-web/src/runtime.mjs';
import {verifyTrustPackage} from '../packages/galaxy-official/src/trust-package.mjs';

// Authorized, explicitly synthetic public-service probe. This never opens the
// user's browser database, account credentials, files or a model service.
const release=process.argv[2],reportPath=process.argv[3];
assert.match(release??'',/^official-2026\.09\.13-product-v2-r[1-9][0-9]*$/);
assert.ok(reportPath&&isAbsolute(reportPath));
const reportFile=await open(reportPath,'wx');
const record={observedAt:new Date().toISOString(),release,
 scope:'Real public HTTPS with a new synthetic private Case and its author-only trust permission; WebCrypto/BrowserClient, not browser UI or real participant acceptance',
 checks:{},cleanup:{},modelCalls:0,realAccountUsed:false,backupStarted:false};
const values=new Map(),store={get:async key=>structuredClone(values.get(key)),put:async(key,value)=>values.set(key,structuredClone(value))};
let runtime,client,sourceConsentId,permissionId,permissionRevoked=false,apiCalls=0,step='ready';
try{
 const ready=await fetch('https://official.agigalaxy.org/readyz',{redirect:'error'});
 assert.equal(ready.status,200);assert.equal(ready.headers.get('x-galaxy-release'),release);
 const config=await loadWebConfiguration((path,options)=>{assert.equal(path,'/galaxy-web-config.json');return fetch('https://agigalaxy.org/galaxy-web-config.json',options);});
 assert.equal(config.endpoint,'https://official.agigalaxy.org');record.checks.selectedOfficialPinConfiguration=true;
 runtime=await createWebRuntime(config,{store,fetch:(url,options)=>{apiCalls++;return fetch(url,{...options,headers:{...options.headers,Origin:'https://agigalaxy.org'}});}});
 step='synthetic-identity';await runtime.createIdentity({confirmed:true});await runtime.connect({confirmed:true});
 const status=await runtime.status(),subjectId=status.identity.subjectId;
 record.subjectId=subjectId;record.bindingId=status.connection.bindingId;client=runtime.trustPackages;
 const audience={kind:'subjects',subjectIds:[subjectId]},now=Math.floor(Date.now()/1000),expiresAt=now+3600;
 step='offline-self-claim';const before=apiCalls;
 const self=await client.prepare({claims:[{id:randomUUID(),text:'合成部署验证：此为临时身份自述，不代表真实用户、经历或能力。',authority:'self-asserted',capabilityVerified:false}],audience,expiresAt});
 const selfExport=await client.exportPackage(self,{confirmed:true});
 assert.equal((await verifyTrustPackage(selfExport.container)).integrity,'valid');assert.equal(apiCalls,before);
 record.checks.selfClaimOfflineAfterExplicitIdentityConnection=true;
 step='private-case';const caseId=randomUUID();record.caseId=caseId;
 const source={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:subjectId,
  localRef:randomUUID(),title:'合成部署验证：可携带信任资料',summary:'仅用于验证私有来源、精确作者许可、离线签名及撤销。不是用户真实 Case，不调用模型。',
  source:{kind:'local',reference:randomUUID()},synthetic:true};
 const auth=await runtime.api.prepareAuthorization(JSON.stringify(source),{action:'case.teaser.publish',objectId:caseId,visibility:'Private',viewers:[],confirmed:true});
 sourceConsentId=auth.intent.id;const submitted=await runtime.api.submitAuthorization(auth,{confirmed:true});
 await runtime.api.call('/v2/cases/events',submitted);
 const sourceRead=await runtime.api.call(`/v2/cases/${caseId}/read`,{});
 assert.equal(sourceRead.events[0].synthetic,true);assert.equal(sourceRead.events[0].caseVersion,1);
 record.checks.syntheticPrivateCaseCurrentRead=true;
 const ref={endpoint:config.endpoint,kind:'case-event',id:caseId,caseId,version:1};
 step='reference-package';const refPreview=await client.prepare({selections:[{ref,mode:'reference'}],audience,expiresAt});
 assert.equal(refPreview.state,'ready');const refExport=await client.exportPackage(refPreview,{confirmed:true});
 const refObject=JSON.parse(refExport.container.files['objects.json']).sources[0];
 assert.equal(refObject.mode,'reference');assert.equal(refObject.bodyText,undefined);assert.equal(refObject.permission,undefined);
 assert.equal((await verifyTrustPackage(refExport.container)).integrity,'valid');record.checks.authorReferenceWithoutBody=true;
 step='author-exact-copy-permission';permissionId=randomUUID();record.permissionId=permissionId;
 const grant=await client.permissionPreview({id:permissionId,operationId:randomUUID(),source:ref,grantee:subjectId,audience,expiresAt:now+7200});
 assert.equal((await runtime.api.call('/v2/trust-package/permissions/receipt',{id:permissionId})).state,'absent');
 const receipt=await client.executePermission(grant,{confirmed:true});assert.equal(receipt.state,'recorded');assert.equal(receipt.status,'recorded-needs-current-source-check');
 assert.equal((await runtime.api.call('/v2/trust-package/permissions/status',{id:permissionId})).status,'active');
 record.checks.previewDoesNotGrantAndRecordedReceiptRequiresSeparateCurrentCheck=true;
 step='copied-package';const selection={ref,mode:'copy',permissionId};
 const preview=await client.prepare({selections:[selection],audience,expiresAt});assert.equal(preview.state,'ready');
 const exported=await client.exportPackage(preview,{confirmed:true});record.packageId=exported.packageId;
 const copied=JSON.parse(exported.container.files['objects.json']).sources[0];
 assert.equal(copied.bodyText,submitted.payloadJson);assert.equal(copied.originalSignature,undefined);
 const beforeVerify=apiCalls,offline=await verifyTrustPackage(exported.container);assert.equal(apiCalls,beforeVerify);
 assert.equal(offline.integrity,'valid');assert.equal(offline.sources[0].reproductionPermission.status,'signature-and-scope-valid');
 assert.equal(offline.currentRevocationChecked,false);assert.equal(offline.capabilityVerified,false);assert.equal(offline.importedBusinessFacts,0);
 record.checks.exactAuthorBodyAndIndependentLicense=true;record.checks.offlineDoesNotAssertCurrentRightsOrCapability=true;
 step='explicit-current-check';const online=await client.checkOnline(exported.container,{selectedEndpoint:config.endpoint});
 assert.equal(online.uploadedPackage,false);assert.equal(online.online.control.status,'included-signer-current');assert.equal(online.online.items[0].status,'active');
 record.checks.explicitSelectedServiceCurrentControlAndPermission=true;
 step='revoke';const revoke=await client.permissionPreview({id:permissionId,operationId:randomUUID()},{revoke:true});
 const revoked=await client.executePermission(revoke,{confirmed:true});assert.equal(revoked.status,'revoked');permissionRevoked=true;
 const exact=await runtime.api.call('/v2/trust-package/permissions/receipt',{id:permissionId});
 assert.equal(exact.revokeOperationId,revoked.revokeOperationId);assert.equal(exact.revokeSignatureHash,revoked.revokeSignatureHash);
 const later=await client.checkOnline(exported.container,{selectedEndpoint:config.endpoint});assert.equal(later.online.items[0].status,'revoked');
 const denied=await client.prepare({selections:[selection],audience,expiresAt});assert.equal(denied.state,'sources-unavailable');
 assert.equal((await verifyTrustPackage(exported.container)).integrity,'valid');
 record.checks.exactRevocationReceiptAndFreshCopyDenied=true;record.checks.historicalSignatureSurvivesCurrentRevocation=true;
 record.passed=true;
}catch(error){record.passed=false;record.failure={step,type:error.name,code:error.code??'probe_failed'};process.exitCode=1;}
finally{
 if(client&&permissionId&&!permissionRevoked){try{
  const existing=await runtime.api.call('/v2/trust-package/permissions/receipt',{id:permissionId});
  if(existing.state==='recorded'&&existing.status!=='revoked'){
   const revoke=await client.permissionPreview({id:permissionId,operationId:randomUUID()},{revoke:true});
   permissionRevoked=(await client.executePermission(revoke,{confirmed:true})).status==='revoked';
  }else permissionRevoked=existing.state==='absent'||existing.status==='revoked';
 }catch{record.cleanup.permissionRevokeUnconfirmed=true;process.exitCode=1;}}
 if(permissionId)record.cleanup.permissionRevokedOrAbsent=permissionRevoked;
 if(runtime&&sourceConsentId){try{
  const existing=await runtime.api.call('/v2/consents/receipt',{consentId:sourceConsentId});
  if(existing.state!=='absent')await runtime.api.call('/v1/consents/'+sourceConsentId+'/revoke',{});
  record.cleanup.privateSourceConsentRevokedOrAbsent=true;
 }catch{record.cleanup.privateSourceConsentRevokedOrAbsent=false;process.exitCode=1;}}
 try{const bindingId=record.bindingId??runtime?.api.snapshot()?.bindingId;if(bindingId){await runtime.api.call('/v1/bindings/'+bindingId+'/revoke',{});record.cleanup.syntheticBindingRevoked=true;}}
 catch{record.cleanup.syntheticBindingRevoked=false;process.exitCode=1;}
 runtime?.close();values.clear();record.cleanup.localSyntheticKeysDiscarded=true;
 record.cleanup.scope='Revoked synthetic source disclosure, copy permission and binding; durable synthetic Case/identity/audit receipts are not claimed physically erased.';
 record.completedAt=new Date().toISOString();record.apiRequests=apiCalls;
 if(process.exitCode)record.passed=false;
 await reportFile.writeFile(JSON.stringify(record,null,2)+'\n');await reportFile.close();console.log(JSON.stringify(record));
}
