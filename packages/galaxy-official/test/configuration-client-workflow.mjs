import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createBrowserClient} from '../src/browser-client.mjs';
import {createConfigurationClient} from '../../galaxy-web/src/configuration-client.mjs';
import {digest} from '../src/shared/digest.mjs';
export async function verifyConfigurationBrowser(f,origin,record){
 const storage=new Map(),getLocal=async k=>structuredClone(storage.get(k)),putLocal=async(k,v)=>storage.set(k,structuredClone(v));
 let loseConsent=true,loseBusiness=false,posts=0,consentPosts=0;
 const scopes=['binding','consent','history'],key=f.genesis.genesisProof.publicKeyPem,deviceId=randomUUID(),
  upgrade={version:2,kind:'bootstrap',operationId:randomUUID(),subjectId:f.actor.subjectId,expectedEpoch:0,previousEventHash:null,signerKeyId:digest(key),genesisProof:f.genesis.genesisProof,newDevice:{deviceId,publicKeyPem:key,scopes:['manage-identity',...scopes]}};
 const challenge=await f.identityControl.challenge(upgrade),signature=await f.signForTest(challenge.challenge,'galaxy-identity-control-v2+jws');
 await f.identityControl.commit({operationId:upgrade.operationId,controllerSignature:signature,newDeviceProof:signature});
 const browser=createBrowserClient({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys,sign:f.signForTest,now:()=>f.now,
  fetch:async(url,init)=>{const path=new URL(url).pathname;
   if(path==='/v1/consents'){consentPosts++;assert.ok([...storage.values()].some(v=>v?.active?.prepared?.signedIntent===JSON.parse(init.body).signedIntent),'signed authorization persisted before first network write');}
   if(path==='/v2/configurations/events')posts++;
   const result=await fetch(origin+path,init);
   if(path==='/v1/consents'&&loseConsent){loseConsent=false;assert.equal(result.status,200);throw Error('synthetic lost configuration Consent ACK');}
   if(path==='/v2/configurations/events'&&loseBusiness){loseBusiness=false;assert.equal(result.status,200);throw Error('synthetic lost configuration operation ACK');}
   return result;}});
 const connect=()=>browser.connect({subjectId:f.actor.subjectId,genesisProof:f.genesis.genesisProof,installationId:randomUUID(),scopes,control:{deviceId,keyId:digest(key),epoch:1}},{confirmed:true});
 const helper=()=>createConfigurationClient({api:browser,getLocal,putLocal,subjectId:f.actor.subjectId});
 try{
  await connect();let client=helper();const preview=await client.prepare(record);
  await assert.rejects(client.execute(preview,{confirmed:true}),/lost configuration Consent/);assert.equal(posts,0);
  const first=consentPosts;await connect();client=helper();await client.retry(record.operationId,{confirmed:true});assert.equal(consentPosts,first);assert.equal(posts,1);
  const v2={...record,operationId:randomUUID(),expectedVersion:1,summary:'经用户另一次明确修订的元数据'},preview2=await client.prepare(v2);loseBusiness=true;
  await assert.rejects(client.execute(preview2,{confirmed:true}),/lost configuration operation/);
  client=helper();const priorPosts=posts;assert.equal((await client.reconcile(v2.operationId)).state,'acknowledged');assert.equal(posts,priorPosts);
  assert.equal((await client.get({id:record.id,version:1})).record.summary,record.summary);
  assert.equal((await client.get({id:record.id})).record.summary,v2.summary);
  await client.saveDraft({title:'local-only'});assert.equal((await client.loadDraft()).title,'local-only');
  return {actualBrowserClient:true,storage:'explicit-memory-fixture',lostConsentAck:true,lostBusinessAck:true};
 }finally{await Promise.resolve(browser.disconnect()).catch(()=>{});}
}
