import assert from 'node:assert/strict';
import { generateKeyPairSync,randomUUID } from 'node:crypto';
import { governanceConfigurationHash,signGovernanceChange,verifyGovernanceReview } from '../src/operations/governance-review.mjs';
import { runtimeConfigSnapshot,recordRuntimeConfig } from '../src/operations/runtime-config-audit.mjs';
export async function reviewedGovernanceFixture({endpoint='https://review-'+randomUUID()+'.example.org',now=Math.floor(Date.now()/1000),previousConfigurationSha256=null,configuration={auditReaderIds:['GUID'+'0'.repeat(28)]}}={}){
  const requester=generateKeyPairSync('ed25519'),reviewer=generateKeyPairSync('ed25519');
  const pin=(pair,kid)=>({kid,publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}),notBefore:now-60,notAfter:now+3600,revoked:false});
  const authorities={version:1,endpoint,requesters:[pin(requester,'requester')],reviewers:[pin(reviewer,'reviewer')]};
  const change={version:1,changeId:randomUUID(),endpoint,revision:1,previousConfigurationSha256,configurationSha256:governanceConfigurationHash(configuration),requesterKid:'requester',reviewerKid:'reviewer',issuedAt:now-1,expiresAt:now+300};
  const signatures=async(changeValue=change)=>({version:1,requestSignature:await signGovernanceChange(changeValue,{privateKey:requester.privateKey,kid:'requester'}),reviewSignature:await signGovernanceChange(changeValue,{privateKey:reviewer.privateKey,kid:'reviewer'})});
  return {endpoint,now,requester,reviewer,configuration,authorities,change,signatures,envelope:await signatures()};
}
export async function verifyReviewedGovernanceWorkflow(db){
  const f=await reviewedGovernanceFixture(),{endpoint,now}=f;
  const review=await verifyGovernanceReview(f.configuration,f.envelope,f.authorities,{endpoint,now});
  const snapshot=runtimeConfigSnapshot({governance:f.configuration,governanceReview:review});
  const a=await recordRuntimeConfig(db,{endpoint,component:'api',snapshot});
  await recordRuntimeConfig(db,{endpoint,component:'api',snapshot});
  await assert.rejects(recordRuntimeConfig(db,{endpoint,component:'api',snapshot:runtimeConfigSnapshot({governance:f.configuration})}),/unsigned/);
  await assert.rejects(verifyGovernanceReview({},f.envelope,f.authorities,{endpoint,now}),/digest/);
  await assert.rejects(verifyGovernanceReview(f.configuration,f.envelope,f.authorities,{endpoint,now:now+301}),/validity/);
  const duplicate={...f.authorities,reviewers:[{...f.authorities.reviewers[0],publicKeyPem:f.authorities.requesters[0].publicKeyPem}]};
  await assert.rejects(verifyGovernanceReview(f.configuration,{...f.envelope,reviewSignature:await signGovernanceChange(f.change,{privateKey:f.requester.privateKey,kid:'reviewer'})},duplicate,{endpoint,now}),/Independent/);
  await assert.rejects(verifyGovernanceReview(f.configuration,f.envelope,{...f.authorities,reviewers:[{...f.authorities.reviewers[0],revoked:true}]},{endpoint,now}),/unavailable/);
  const next={...f.change,changeId:randomUUID(),revision:2,previousConfigurationSha256:f.change.configurationSha256};
  const nextReview=await verifyGovernanceReview(f.configuration,await f.signatures(next),f.authorities,{endpoint,now});
  const b=await recordRuntimeConfig(db,{endpoint,component:'api',snapshot:runtimeConfigSnapshot({governance:f.configuration,governanceReview:nextReview})});
  assert.equal(b.payload.snapshot.governance.review.revision,2);
  await assert.rejects(recordRuntimeConfig(db,{endpoint,component:'api',snapshot}),/revision/);
  assert.equal(a.payload.snapshot.governance.review.requesterKid,'requester');
  return {independentSignatures:true,sameKeyAliasDenied:true,revokedAndExpiredDenied:true,configurationBound:true,revisionBound:true,unsignedDowngradeDenied:true,restartRecorded:true};
}
