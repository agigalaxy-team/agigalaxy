import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyContextV2} from './context-v2-workflow.mjs';
import {createBrowserClient} from '../src/browser-client.mjs';
import {createContextClientV2} from "../src/clients/context-v2.mjs";
import {digest} from '../src/shared/digest.mjs';

test('browser protocol client persists exact signed operations and requires renewed consent only after explicit review',{timeout:60000},async()=>{
 await verifyContextV2({now:Math.floor(Date.now()/1000),afterWorkflow:async({f,p,clock,task,fresh,localEndpoint})=>{
  // The fixture signer uses its fixed clock; the preceding expiry scenario
  // advanced only readers. Restore that shared instant before new handshakes.
  clock.now=f.now;
  const records=new Map(),getLocal=async key=>structuredClone(records.get(key)),putLocal=async(key,value)=>{records.set(key,structuredClone(value));};
  let dropConsent=false,dropBeforeConsent=false,dropGrant=false;const consentPosts=[],everDurable=new Set();
  const fetcher=async(url,options)=>{
   assert.equal(new URL(url).origin,f.bindings.endpoint);const path=new URL(url).pathname;
   if(path==='/v1/consents'){
    const signed=JSON.parse(options.body).signedIntent,stored=[...records.values()].some(row=>row?.preparedConsent?.signedIntent===signed);
    if(stored)everDurable.add(signed);
    assert.equal(everDurable.has(signed),true,'exact signed authorization was durable before any Consent send, including late original sends');
    if(dropBeforeConsent){dropBeforeConsent=false;throw new Error('synthetic offline before Consent');}
    consentPosts.push(signed);
   }
   const response=await fetch(localEndpoint+path,options);
   if(path==='/v1/consents'&&dropConsent){dropConsent=false;assert.equal(response.status,200);throw new Error('synthetic unknown Consent ACK');}
   if(path==='/v2/context/grants'&&dropGrant){dropGrant=false;assert.equal(response.status,200);throw new Error('synthetic unknown grant ACK');}
   return response;
  };
  const browser=createBrowserClient({endpoint:f.bindings.endpoint,trustedKeys:f.bindings.trustedKeys,fetch:fetcher,sign:f.signForTest,now:()=>clock.now});
  async function upgrade(who){const publicKeyPem=who.genesis.genesisProof.publicKeyPem,deviceId=crypto.randomUUID(),scopes=['binding','consent','context','assistance'];
   const request={version:2,kind:'bootstrap',operationId:crypto.randomUUID(),subjectId:who.actor.subjectId,expectedEpoch:0,previousEventHash:null,
    signerKeyId:digest(publicKeyPem),genesisProof:who.genesis.genesisProof,newDevice:{deviceId,publicKeyPem,scopes:['manage-identity',...scopes]}};
   const challenge=await who.identityControl.challenge(request),signature=await who.signForTest(challenge.challenge,'galaxy-identity-control-v2+jws');
   await who.identityControl.commit({operationId:request.operationId,controllerSignature:signature,newDeviceProof:signature});
   return {deviceId,keyId:digest(publicKeyPem),epoch:1};}
  let ownerControl;
  const connect=()=>browser.connect({subjectId:f.actor.subjectId,genesisProof:f.genesis.genesisProof,installationId:crypto.randomUUID(),scopes:['binding','consent','context','assistance'],control:ownerControl},{confirmed:true});
  const helper=()=>createContextClientV2({api:browser,getLocal,putLocal,now:()=>clock.now});
  const payload=()=>({...fresh,id:crypto.randomUUID(),expiresAt:clock.now+1800,materials:[{id:crypto.randomUUID(),label:'Explicit text',mediaType:'text/plain',content:'Only the chosen participant receives this text.'}]});
  try{
   ownerControl=await upgrade(f);await connect();let client=helper();const first=await client.prepareGrant(payload());
   assert.equal(consentPosts.length,0);assert.equal(records.size,0,'preview is only a preview');
   dropConsent=true;await assert.rejects(client.execute(first,{confirmed:true}),/unknown Consent ACK/);
   const saved=[...records.values()].find(row=>row?.operationId===first.operationId),original=saved.preparedConsent;
   assert.equal((await client.pending())[0].operationId,first.operationId);
   browser.disconnect();await connect();client=helper();
   assert.equal((await client.reconcile(first.operationId)).state,'absent');assert.equal(consentPosts.length,1);
   const recovered=await client.resumePending(first.operationId);assert.equal(recovered.grantId,first.grantId);
   assert.equal(consentPosts.length,1,'accepted original Consent is reused across new binding');
   assert.equal((await client.pending()).length,0);
   const receiver=createBrowserClient({endpoint:p.bindings.endpoint,trustedKeys:f.bindings.trustedKeys,
    fetch:(url,opts)=>fetch(localEndpoint+new URL(url).pathname,opts),sign:p.signForTest,now:()=>clock.now});
   try{const peerControl=await upgrade(p);await receiver.connect({subjectId:p.actor.subjectId,genesisProof:p.genesis.genesisProof,installationId:crypto.randomUUID(),scopes:['binding','consent','context','assistance'],control:peerControl},{confirmed:true});
    const peerRecords=new Map(),peer=createContextClientV2({api:receiver,getLocal:async k=>structuredClone(peerRecords.get(k)),putLocal:async(k,v)=>{peerRecords.set(k,structuredClone(v));},now:()=>clock.now});
    const metadata=await peer.get(first.grantId,{metadataOnly:true});assert.equal(metadata.contextAccessGranted,false);
    assert.equal(metadata.materials[0].content,undefined);await peer.execute(await peer.prepareEvent('accept',metadata.metadata),{confirmed:true});
    const view=await peer.get(first.grantId);assert.equal(view.contextAccessGranted,true);assert.equal(view.materials[0].content,first.payload.materials[0].content);
   }finally{receiver.close();}
   const second=await client.prepareGrant(payload());dropGrant=true;
   await assert.rejects(client.execute(second,{confirmed:true}),/unknown grant ACK/);
   client=helper();const sentBeforeRecovery=consentPosts.length;
   assert.equal((await client.resumePending(second.operationId)).state,'acknowledged');assert.equal(consentPosts.length,sentBeforeRecovery);assert.equal((await client.pending()).length,0);
   const third=await client.prepareGrant(payload());dropBeforeConsent=true;
   await assert.rejects(client.execute(third,{confirmed:true}),/offline before Consent/);
   const previous=[...records.values()].find(row=>row?.operationId===third.operationId).preparedConsent;
   browser.disconnect();await connect();client=helper();
   const beforeStale=consentPosts.length;
   assert.equal((await client.resumePending(third.operationId)).reason,'original-binding-changed');
   assert.equal(consentPosts.length,beforeStale);
   assert.equal([...records.values()].find(row=>row?.operationId===third.operationId).preparedConsent.signedIntent,previous.signedIntent);
   await assert.rejects(client.retry(third.operationId,{confirmed:true}),error=>error.code==='consent_reauthorization_required');
   const review=await client.reviewAuthorization(third.operationId);assert.equal(review.state,'reauthorization-required');
   assert.equal(review.consentId,previous.intent.id);assert.equal(review.operationId,third.operationId);
   await assert.rejects(async()=>client.reauthorize(third.operationId,review),/context_confirmation_required/);
   const renewed=await client.reauthorize(third.operationId,review,{confirmed:true});assert.equal(renewed.eventId,third.operationId);
   assert.equal((await client.pending()).length,0);
   let failFirstSignature=true;
   const unsignedClient=createContextClientV2({api:{...browser,prepareAuthorization:async(...args)=>{
    if(failFirstSignature){failFirstSignature=false;throw Error('synthetic interrupted original signature');}
    return browser.prepareAuthorization(...args);
   }},getLocal,putLocal,now:()=>clock.now});
   const unsigned=await unsignedClient.prepareGrant(payload());
   await assert.rejects(unsignedClient.execute(unsigned,{confirmed:true}),/interrupted original signature/);
   const beforeUnsigned=consentPosts.length;
   assert.equal((await unsignedClient.resumePending(unsigned.operationId)).reason,'authorization-review-required');
   assert.equal(consentPosts.length,beforeUnsigned);
   assert.equal([...records.values()].find(row=>row?.operationId===unsigned.operationId).preparedConsent,undefined);
   const unsignedReview=await unsignedClient.reviewAuthorization(unsigned.operationId);
   assert.equal(unsignedReview.state,'reauthorization-required');assert.equal(unsignedReview.consentId,null);
   assert.equal(unsignedReview.expiresAt,unsigned.expiresAt);
   await assert.rejects(async()=>unsignedClient.reauthorize(unsigned.operationId,unsignedReview),/context_confirmation_required/);
   assert.equal((await unsignedClient.reauthorize(unsigned.operationId,unsignedReview,{confirmed:true})).eventId,unsigned.operationId);
   const changed=await client.prepareGrant(payload());changed.payload.materials[0].content='User-facing preview altered';
   assert.throws(()=>client.execute(changed,{confirmed:true}),/context_preview_changed/);
   const stale=await client.prepareGrant(payload());browser.disconnect();await connect();
   assert.throws(()=>client.execute(stale,{confirmed:true}),/context_identity_changed/);
   const late=await client.prepareGrant(payload());dropBeforeConsent=true;
   await assert.rejects(client.execute(late,{confirmed:true}),/offline before Consent/);
   const held=[...records.values()].find(row=>row?.operationId===late.operationId).preparedConsent;
   const stopped=await client.abandon(late.operationId,{confirmed:true});assert.equal(stopped.state,'stopped-local');assert.equal(stopped.serverCancellationConfirmed,false);
   const minimum=[...records.values()].find(row=>row?.operationId===late.operationId);assert.equal(minimum.payloadJson,undefined);assert.equal(minimum.preparedConsent,undefined);
   const beforeStopped=consentPosts.length;
   assert.equal((await client.resumePending(late.operationId)).reason,'stopped-local');assert.equal(consentPosts.length,beforeStopped);
   await assert.rejects(client.retry(late.operationId,{confirmed:true}),/context_local_retry_stopped/);
   const laterSubmission=await browser.submitAuthorization(held,{confirmed:true});await browser.call('/v2/context/grants',laterSubmission);
   assert.equal((await client.reconcile(late.operationId)).state,'acknowledged','late accepted original remains discoverable after local stop');
   const expired=await client.prepareGrant(payload());dropBeforeConsent=true;
   await assert.rejects(client.execute(expired,{confirmed:true}),/offline before Consent/);
   const frozen=[...records.values()].find(row=>row?.operationId===expired.operationId),beforeExpired=consentPosts.length;
   // The shared workflow's binding issuer keeps its fixed clock. Move only
   // this recovery client's deadline clock; no request may reach a write path.
   const expiredClient=createContextClientV2({api:browser,getLocal,putLocal,now:()=>clock.now+1801});
   assert.equal((await expiredClient.resumePending(expired.operationId)).reason,'authorization-expired');assert.equal(consentPosts.length,beforeExpired);
   assert.equal([...records.values()].find(row=>row?.operationId===expired.operationId).preparedConsent.signedIntent,frozen.preparedConsent.signedIntent);
   await assert.rejects(expiredClient.reviewAuthorization(expired.operationId),/context_original_material_deadline_expired/);
   assert.ok(original.signedIntent);assert.equal(task.caseId,null);
  }finally{browser.close();}
 }});
});
