import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createPeeringProof} from './hub-ci-proof-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {createTrustPackageClient} from '../src/trust-package-client.mjs';
import {prepareTrustPackage,verifyTrustPackage} from '../src/trust-package.mjs';
import {trustPackageInputSchema,trustCiReferenceSnapshotSchema} from '../src/shared/trust-package-schema.mjs';
import {digest} from '../src/shared/digest.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

const scopes=['binding','consent','case-teaser','evidence','proof'];
export async function ciReferenceFixture({shortSignatureTtl=null}={}){
  const f=await serviceFixture(scopes,null,{now:Math.floor(Date.now()/1000)+30});
  let server;
  try {
    if(shortSignatureTtl!==null){
      const sign=f.ciV2.sign;
      f.ciV2.sign=(type,data,id,ttl)=>sign(type,data,id,Math.min(ttl,shortSignatureTtl));
    }
    const rootId=randomUUID(),root={schemaVersion:2,eventId:rootId,caseId:rootId,kind:'case-created',expectedVersion:0,
      actorId:f.actor.subjectId,localRef:randomUUID(),title:'Synthetic exact CI reference',summary:'Synthetic bounded reference test',
      source:{kind:'local',reference:randomUUID()},synthetic:true};
    await f.cases.submitV2(f.actor,await f.authorize(root,'case.teaser.publish',{objectId:rootId}));
    const intervention={schemaVersion:2,eventId:randomUUID(),caseId:rootId,kind:'intervention',expectedVersion:1,
      actorId:f.actor.subjectId,types:['diagnosis'],affectsAttemptIds:[],description:'Synthetic CI source',sourceRefs:[],observedEffect:'Partial'};
    await f.cases.submitV2(f.actor,await f.authorize(intervention,'case.teaser.publish',{objectId:intervention.eventId}));
    const proof=await createPeeringProof(f,root,intervention);
    const original=(await f.db.query('SELECT payload_text,payload_hash,signed FROM ci_proofs_v2 WHERE id=$1',[proof.source.id])).rows[0];
    const ref={endpoint:f.access.endpoint,kind:'ci-proof-v2',id:proof.source.id,version:1};
    const clock={now:f.now},counts={reads:0,mutations:0,signatures:0};
    f.access.now=()=>clock.now;f.ciV2.now=()=>clock.now;
    server=createApi({...f,rateLimit:1000});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url='http://127.0.0.1:'+server.address().port;
    const http=async(path,input,credential=f.credential)=>{
      if(path==='/v2/trust-package/sources')counts.reads++;else if(path.endsWith('/submit'))counts.mutations++;
      const response=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+credential},
        body:JSON.stringify(input)});
      const result=await response.json();
      if(!response.ok)throw new ServiceError(result.error??'http_error',response.status);
      return result;
    };
    const identity=await f.access.runAuthorized(f.actor,'consent',db=>f.trustPackages.identityWithin(db,f.actor.subjectId));
    const stored=new Map();
    const client=createTrustPackageClient({api:{endpoint:ref.endpoint,snapshot:()=>({subjectId:f.actor.subjectId,bindingId:f.actor.bindingId}),
      call:http},current:async()=>({identity,keyId:digest(f.genesis.genesisProof.publicKeyPem),epoch:0,bindingId:f.actor.bindingId}),
      sign:async(text,type)=>{counts.signatures++;return f.signForTest(text,type);},
      getLocal:async name=>structuredClone(stored.get(name)),putLocal:async(name,value)=>stored.set(name,structuredClone(value)),now:()=>clock.now});
    const select=(selections=[{ref,mode:'reference'}],expiresAt=clock.now+120)=>http('/v2/trust-package/sources',
      {selections,audience:{kind:'public'},expiresAt});
    return {f,proof,ref,clock,counts,http,select,original,client,identity,stored,async unchanged(){
      const row=(await f.db.query('SELECT payload_text,payload_hash,signed FROM ci_proofs_v2 WHERE id=$1',[ref.id])).rows[0];
      assert.deepEqual(row,original);
    },async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.db.close();}};
  } catch(error){if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await f.db.close();throw error;}
}

export async function verifyCiReferenceExport(){
  const s=await ciReferenceFixture();
  try {
    const selected=await s.select(),snapshot=selected.items[0].snapshot;
    assert.equal(selected.items[0].state,'available');
    assert.equal(snapshot.profile,'galaxy-ci-proof-v2-reference/1');
    assert.equal(snapshot.issuer,s.ref.endpoint);assert.equal(snapshot.associatedSubjectId,s.f.actor.subjectId);
    assert.notEqual(snapshot.issuer,snapshot.associatedSubjectId);
    assert.equal(snapshot.sourceHash,s.original.payload_hash);assert.equal(snapshot.sourceSignatureHash,digest(s.original.signed));
    assert.equal(snapshot.sourceExpiresAt,Math.min(JSON.parse(Buffer.from(s.original.signed.split('.')[1],'base64url')).exp,
      JSON.parse(s.original.payload_text).expiresAt));
    for(const field of ['authorId','bodyText','permission','originalSignature'])assert.equal(snapshot[field],undefined);
    assert.ok(!JSON.stringify(selected).includes(s.original.signed));assert.ok(!JSON.stringify(selected).includes('PRIVATE_SOURCE_BODY'));
    const packs=[],reports=[];
    for(let i=0;i<2;i++){
      const preview=await s.client.prepare({selections:[{ref:s.ref,mode:'reference'},{ref:s.ref,mode:'reference'}],
        claims:[{id:randomUUID(),text:'Selected reference '+i,authority:'self-asserted',capabilityVerified:false}],
        audience:{kind:'public'},expiresAt:s.clock.now+120});
      assert.equal(preview.state,'ready');assert.equal(preview.sourceCount,1);
      const pack=await s.client.exportPackage(preview,{confirmed:true});packs.push(pack.container);
      const report=await s.client.importPackage(pack.container);reports.push(report);
      assert.equal(report.integrity,'valid');assert.equal(report.importedBusinessFacts,0);assert.equal(report.capabilityVerified,false);
      const item=report.sources[0];
      assert.equal(item.issuer,s.ref.endpoint);assert.equal(item.associatedSubjectId,s.f.actor.subjectId);
      assert.equal(item.issuerSignatureVerified,false);assert.equal(item.originalSignature.status,'not-provided');
      assert.equal(item.currentSourceState,'not-checked');assert.equal(item.independentExecutionVerified,false);
      assert.equal(item.reproductionPermission.status,'not-required-for-reference');
      assert.ok(report.summary.includes('关联主体（不是签发者'));assert.ok(!report.summary.includes('作者：undefined'));
    }
    // Ordinary import accepts one full package. Serial consumer comparison
    // keeps both package identities and one exact source key, without a new API.
    assert.notEqual(reports[0].packageId,reports[1].packageId);
    const keys=reports.map(r=>r.sources.map(x=>[x.ref.endpoint,x.ref.kind,x.ref.id,x.ref.version,x.sourceHash].join(':')));
    assert.deepEqual(keys[0],keys[1]);
    await assert.rejects(s.client.importPackage({...packs[0],HAIP:{opaque:'not-interpreted'}}));
    const tampered=structuredClone(packs[0]);tampered.files['objects.json']=tampered.files['objects.json'].replace(snapshot.sourceHash,'f'.repeat(64));
    await assert.rejects(verifyTrustPackage(tampered),/file changed/);
    assert.equal(s.counts.mutations,0);await s.unchanged();
    return {actualHttp:true,actualSignedCiProof:true,actualPackageJws:true,sourceProfile:snapshot.profile,issuerDistinctFromSubject:true,
      exactSourceRecords:1,seriallyImportedPackages:2,newBatchApi:false,ciBytesCopied:false,issuerRightsGranted:false,models:0};
  } finally {await s.close();}
}

export async function verifyCiReferenceScope(){
  const s=await ciReferenceFixture();
  try {
    const other=await serviceFixture(scopes,s.f.db,{migrateDatabase:false,now:s.f.now});
    const item=(await s.select()).items[0],snapshot=item.snapshot;
    const borrowed=await s.http('/v2/trust-package/sources',{selections:[{ref:s.ref,mode:'reference'}],
      audience:{kind:'public'},expiresAt:s.clock.now+120},other.credential);
    assert.equal(borrowed.items[0].reason,'trust_ci_associated_subject_required');
    for(const ref of [{...s.ref,version:2},{...s.ref,caseId:randomUUID()},{...s.ref,taskId:randomUUID()}]){
      assert.equal((await s.select([{ref,mode:'reference'}])).items[0].reason,'trust_ci_reference_locator_invalid');
    }
    assert.equal((await s.select([{ref:s.ref,mode:'copy'}])).items[0].reason,'trust_ci_reference_only');
    assert.equal((await s.select([{ref:s.ref,mode:'reference',permissionId:randomUUID()}])).items[0].reason,'trust_ci_reference_only');
    await assert.rejects(s.http('/v2/trust-package/permissions/preview',{id:randomUUID(),operationId:randomUUID(),source:s.ref,
      grantee:s.f.actor.subjectId,audience:{kind:'public'},expiresAt:s.clock.now+120}),/trust_original_author_required/);
    assert.equal((await s.select([{ref:{...s.ref,endpoint:'https://another.example.org'},mode:'reference'}])).items[0].reason,'trust_source_endpoint_mismatch');
    const missingScope=await serviceFixture(['binding','consent'],s.f.db,{migrateDatabase:false,now:s.f.now});
    const noProof=await s.http('/v2/trust-package/sources',{selections:[{ref:s.ref,mode:'reference'}],
      audience:{kind:'public'},expiresAt:s.clock.now+120},missingScope.credential);
    assert.equal(noProof.items[0].reason,'trust_source_scope_required');
    for(const extra of [{authorId:s.f.actor.subjectId},{bodyText:'not licensed'},{permission:{}},
      {originalSignature:{profile:'galaxy-proof',signed:s.original.signed}}, {HAIP:{opaque:true}}]){
      assert.equal(trustCiReferenceSnapshotSchema.safeParse({...snapshot,...extra}).success,false);
    }
    assert.equal(trustCiReferenceSnapshotSchema.safeParse({...snapshot,mode:'copy'}).success,false);
    assert.equal(trustCiReferenceSnapshotSchema.safeParse({...snapshot,issuer:'https://another.example.org'}).success,false);
    const input={identity:s.identity,keyId:digest(s.f.genesis.genesisProof.publicKeyPem),epoch:0,audience:{kind:'public'},
      issuedAt:s.clock.now,expiresAt:s.clock.now+120,claims:[],sources:[snapshot]};
    assert.equal(trustPackageInputSchema.safeParse({...input,sources:[{...snapshot,bodyText:'injected'}]}).success,false);
    assert.equal(trustPackageInputSchema.safeParse({...input,sources:[{...snapshot,associatedSubjectId:other.actor.subjectId}]}).success,false);
    await assert.rejects(prepareTrustPackage({...input,sources:[snapshot,{...snapshot,sourceHash:'f'.repeat(64)}]},
      {now:s.clock.now}),/Conflicting copies/);
    const pin=s.f.ciV2.trustedKeys.get('fixture');
    pin.revoked=true;
    assert.equal((await s.select()).items[0].reason,'trust_ci_signature_unavailable');
    pin.revoked=false;
    await s.f.db.query('UPDATE ci_proofs_v2 SET payload_hash=$2 WHERE id=$1',[s.ref.id,'f'.repeat(64)]);
    assert.equal((await s.select()).items[0].reason,'ci_proof_integrity_mismatch');
    await s.f.db.query('UPDATE ci_proofs_v2 SET payload_hash=$2 WHERE id=$1',[s.ref.id,s.original.payload_hash]);
    assert.equal(s.counts.signatures,0);assert.equal(s.counts.mutations,0);await s.unchanged();
    return {ownerAssociationRequired:true,proofScopeRequired:true,versionOneImmutable:true,referenceOnly:true,
      issuerLicenseGranted:false,unknownFieldsRejected:true,pinnedIssuerRequired:true,storedHashTamperRejected:true,newConsent:0};
  } finally {await s.close();}
}

export async function verifyCiReferenceExpiry(){
  const s=await ciReferenceFixture({shortSignatureTtl:5});
  try {
    const selected=await s.select(undefined,s.clock.now+4),snapshot=selected.items[0].snapshot;
    assert.equal(selected.items[0].state,'available');assert.equal(snapshot.sourceExpiresAt,s.clock.now+5);
    assert.ok(JSON.parse(s.original.payload_text).expiresAt>snapshot.sourceExpiresAt);
    assert.equal((await s.select(undefined,s.clock.now+6)).items[0].reason,'trust_ci_reference_expiry_exceeds_source');
    const preview=await s.client.prepare({selections:[{ref:s.ref,mode:'reference'}],audience:{kind:'public'},expiresAt:s.clock.now+4});
    const exported=await s.client.exportPackage(preview,{confirmed:true});
    const stalePreview=await s.client.prepare({selections:[{ref:s.ref,mode:'reference'}],audience:{kind:'public'},expiresAt:s.clock.now+4});
    const signatures=s.counts.signatures;s.clock.now+=5;
    assert.equal((await s.select(undefined,s.clock.now+1)).items[0].reason,'trust_ci_signature_unavailable');
    // The package deadline was bounded below the Proof deadline. At Proof
    // expiry the package itself is already stale, so its exact expiry guard
    // rejects before a new signature rather than pretending it is current.
    await assert.rejects(s.client.exportPackage(stalePreview,{confirmed:true}),error=>error.code==='trust_package_expiry_invalid');
    assert.equal(s.counts.signatures,signatures);
    const offline=await s.client.importPackage(exported.container,{now:s.clock.now});
    assert.equal(offline.integrity,'valid');assert.equal(offline.temporalState,'expired');
    assert.equal(offline.sources[0].sourceTemporalState,'expired');assert.equal(offline.sources[0].currentSourceState,'not-checked');
    await s.unchanged();return {actualInnerJwtExpiryClamped:true,sourceDataExpiryNotExtended:true,expiredExportWithheld:true,
      originalBytesUnchanged:true,offlineCurrentRightsUnknown:true};
  } finally {await s.close();}
}

export async function verifyCiReferenceRevocation(){
  const s=await ciReferenceFixture();
  try {
    const preview=await s.client.prepare({selections:[{ref:s.ref,mode:'reference'}],audience:{kind:'public'},expiresAt:s.clock.now+120});
    const exported=await s.client.exportPackage(preview,{confirmed:true});
    const stale=await s.client.prepare({selections:[{ref:s.ref,mode:'reference'}],audience:{kind:'public'},expiresAt:s.clock.now+120});
    const signatures=s.counts.signatures;
    await s.f.consents.revoke(s.f.actor,s.proof.evidenceAuth.consentId);
    assert.equal((await s.select()).items[0].state,'unavailable');
    await assert.rejects(s.client.exportPackage(stale,{confirmed:true}),/trust_source_changed/);
    assert.equal(s.counts.signatures,signatures);
    const offline=await s.client.importPackage(exported.container);
    assert.equal(offline.integrity,'valid');assert.equal(offline.currentRevocationChecked,false);
    assert.equal(offline.sources[0].currentSourceState,'not-checked');assert.equal(offline.onlineAccessGranted,false);
    await s.unchanged();return {sourceConsentRevocationStopsExport:true,priorOfflineSignatureNotCurrentAuthority:true,
      rawProofUnchanged:true,newCopyPermission:false,models:0};
  } finally {await s.close();}
}

export async function verifyCiReferenceLateExpiry(){
  const s=await ciReferenceFixture({shortSignatureTtl:5});
  try {
    const canonical=s.f.ciV2.proofWithin.bind(s.f.ciV2);
    let advanced=false;
    s.f.ciV2.proofWithin=async(...args)=>{
      // Initial issuer signature verification has completed. The real
      // canonical source read then crosses that same signed JWT's deadline.
      if(!advanced){advanced=true;s.clock.now+=5;}
      return canonical(...args);
    };
    const selection=await s.select(undefined,s.clock.now+4);
    assert.ok(advanced);assert.equal(selection.items[0].state,'unavailable');
    assert.equal(selection.items[0].reason,'trust_ci_signature_unavailable');
    assert.equal(selection.items[0].snapshot,undefined);assert.equal(s.counts.signatures,0);assert.equal(s.counts.mutations,0);
    await s.unchanged();return {expiryDuringCurrentSourceReadWithheld:true,partialItemUnavailable:true,proofBytesUnchanged:true};
  } finally {await s.close();}
}
