import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createServices} from '../src/services.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
test('two actual WebRuntime device signers approve the same group; restart reconciles the original lost ACK',{timeout:120000},async()=>{
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000),syntheticCommunityQuota:false});
 const key=generateKeyPairSync('ed25519'),trustedKeys=new Map([['identity-group-web',{publicKeyPem:key.publicKey.export({type:'spki',format:'pem'}),notBefore:f.now-1,notAfter:f.now+86400,revoked:false}]]);
 const services=createServices({db:f.db,endpoint:f.access.endpoint,kid:'identity-group-web',signingKey:key.privateKey,trustedKeys,allowedScopes:browserScopes,operator:'Synthetic',region:'isolated',now:()=>f.now}),server=createApi({...services,rateLimit:1000});
 const dataA=new Map(),dataB=new Map(),store=data=>({get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v))});let a,b,writes=0,drop=true;
 try{await new Promise(r=>server.listen(0,'127.0.0.1',r));const local='http://127.0.0.1:'+server.address().port,config={endpoint:f.access.endpoint,trustedKeys};
  const wire=async(url,init)=>{const path=new URL(url).pathname,res=await fetch(local+path,init);if(path==='/v2/identity-groups/submit'){writes++;if(drop&&res.status===200){drop=false;throw Error('Synthetic lost WebRuntime identity group ACK');}}return res;};
  const options=data=>({store:store(data),fetch:wire,now:()=>f.now});
  a=await createWebRuntime(config,options(dataA));b=await createWebRuntime(config,options(dataB));await a.createIdentity({confirmed:true});await a.connect({confirmed:true});await b.createIdentity({confirmed:true});await b.connect({confirmed:true});
  const aid=(await a.status()).identity.subjectId,bid=(await b.status()).identity.subjectId,operation={schemaVersion:2,operationId:randomUUID(),groupId:randomUUID(),kind:'create',expectedVersion:0,previousOperationId:null,endpoint:f.access.endpoint,issuedAt:f.now,expiresAt:f.now+3600,memberIds:[aid,bid],canonicalDisplayId:aid,visibility:'Private',viewers:[],sourceRefs:[],attributionCorrections:[],purpose:'canonical-display-only',capabilityMerged:false,accessGranted:false};
  const changed=await a.identityGroups.prepare(operation);changed.payload.canonicalDisplayId=bid;await assert.rejects(a.identityGroups.execute(changed,{confirmed:true}),/preview_required/);assert.equal(writes,0);
  const preview=await a.identityGroups.prepare(operation);await assert.rejects(a.identityGroups.execute(preview,{confirmed:true}),/Synthetic lost/);assert.equal(writes,1);
  a.close();a=await createWebRuntime(config,options(dataA));await a.connect({confirmed:true});const pending=await a.identityGroups.pending();assert.equal(pending.length,1);
  const result=await a.identityGroups.retry(pending[0].proofId);assert.equal(result.ownApprovalAcknowledged,true);assert.equal(result.state,'pending');assert.equal(writes,1);
  const otherPreview=await b.identityGroups.prepareResponse(operation.operationId);assert.equal(otherPreview.subjectId,bid);assert.equal(otherPreview.payloadHash,pending[0].payloadHash);
  assert.equal((await b.identityGroups.execute(otherPreview,{confirmed:true})).state,'committed');assert.equal(writes,2);
  const current=await a.identityGroups.read(operation.groupId);assert.equal(current.canonicalDisplayId,aid);assert.deepEqual(current.memberIds,[aid,bid]);assert.equal(current.capabilityMerged,false);assert.equal(current.accessGranted,false);
  const rows=(await f.db.query('SELECT subject_id,key_id,epoch FROM identity_group_approvals_v2 WHERE operation_id=$1',[operation.operationId])).rows;assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.key_id)).size,2);assert.ok(rows.every(r=>r.epoch===1));
  console.log(JSON.stringify({event:'identity_group_web_runtime_verified',actualWebRuntime:true,actualWebCryptoDeviceSigning:true,twoIndependentCurrentKeys:true,restartSameJournal:true,originalAckReconciled:true,businessWrites:2,mutatedPreviewRejected:true,localStore:'synthetic-Map-not-IndexedDB',actualBrowserDom:false,cloudModelCalls:0}));
 }finally{a?.close();b?.close();if(server.listening)await new Promise(r=>server.close(r));await f.db.close();}
});
