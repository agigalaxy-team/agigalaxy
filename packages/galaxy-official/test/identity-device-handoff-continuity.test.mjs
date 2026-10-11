import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {createIdentityDeviceHandoff} from '../../galaxy-core/src/domain/identity-device-handoff.mjs';
import {createRecoveryMaterial,signIdentityPayload} from '../../galaxy-core/src/domain/identity-material.mjs';

async function fixture(){
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),server=createApi({...f,rateLimit:1000}),instances=[],commits=[],requests=[];
 f.identityControl.now=()=>f.now;let beforeCommit=false,statusOffline=false,onRead=null,onStatusResponse=null;
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
 async function runtime(rows=new Map()){const writes=[],store={get:async key=>{const value=structuredClone(rows.get(key));await onRead?.(key);return value;},
  put:async(key,value)=>{writes.push(key);return rows.set(key,structuredClone(value));},update:async(key,change)=>{const value=change(structuredClone(rows.get(key)));writes.push(key);rows.set(key,structuredClone(value));return structuredClone(value);},
  prepareRecovery:async(subjectId,operationId)=>{const key=`pending-recovery:${subjectId}:${operationId}`,existing=await store.get(key);if(existing)return existing;
   const record={...await createRecoveryMaterial(subjectId),operationId,saveDeclared:false,status:'local-pending-registration'};await store.put(key,record);return record;}};
  const runtime=await createWebRuntime({endpoint:f.access.endpoint,trustedKeys:f.access.trustedKeys},{store,now:()=>f.now,fetch:async(url,options)=>{
   const path=new URL(url).pathname;if(path==='/v2/identity/control/status'&&statusOffline)throw Error('Synthetic original status unavailable');
   if(path==='/v2/identity/control/commit'&&beforeCommit){beforeCommit=false;throw Error('Synthetic saved commit not delivered');}
   if(options.body)assert.ok(!/PRIVATE KEY|galaxy-recovery-v1:/.test(options.body));
   const result=await fetch(origin+path,options);requests.push({path,status:result.status});
   if(path==='/v2/identity/control/commit')commits.push({body:options.body,status:result.status});
   if(path==='/v2/identity/control/status')await onStatusResponse?.();return result;}});
  instances.push(runtime);return{runtime,rows,store,writes};
 }
 const old=await runtime();await old.runtime.createIdentity({confirmed:true});await old.runtime.connect({confirmed:true});
 const subjectId=(await old.runtime.status()).identity.subjectId;
 async function offer(joiner){const offer=await joiner.runtime.deviceHandoff.createOffer(subjectId,{confirmed:true}),approval=await old.runtime.deviceHandoff.approveOffer(offer,{confirmed:true});return{offer,approval};}
 return{f,old,subjectId,commits,requests,runtime,offer,setBeforeCommit:value=>beforeCommit=value,setStatusOffline:value=>statusOffline=value,setRead:fn=>onRead=fn,setStatusResponse:fn=>onStatusResponse=fn,
  wire:(action,input)=>fetch(origin+'/v2/identity/control/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}),
  async close(){instances.forEach(value=>value.close());server.closeAllConnections();await new Promise(done=>server.close(done));await f.db.close();}};
}

async function authorizeExpandedDevice(x){
 const joined=await x.runtime(),client=joined.runtime.deviceHandoff;
 const initial=await client.createOffer(x.subjectId,{scopes:['binding','consent'],confirmed:true});
 const initialApproval=await x.old.runtime.deviceHandoff.approveOffer(initial,{confirmed:true});
 await client.acceptApproval(initialApproval,{confirmed:true});await joined.runtime.connect({confirmed:true});
 const owner=await joined.store.get('galaxy-web:'+x.f.access.endpoint+':active');
 const offer=await client.createOffer(x.subjectId,{scopes:['binding','consent','history'],confirmed:true});
 const approval=await x.old.runtime.deviceHandoff.approveOffer(offer,{confirmed:true});
 const result=await client.acceptApproval(approval,{confirmed:true});
 assert.equal(result.receipt.state,'committed');assert.equal(result.needsLocalDeviceSelection,true);assert.equal(result.activated,false);
 return{joined,client,initial,owner,offer,approval};
}

test('same-GUID authorization retains the old device until one explicit exact local selection; concurrent and repeated selection create no new commit or proof',{timeout:60000},async()=>{
 const x=await fixture(),subtle=globalThis.crypto.subtle,originalSign=subtle.sign.bind(subtle),descriptor=Object.getOwnPropertyDescriptor(subtle,'sign');let signs=0;
 try{
  const {joined,client,initial,owner,offer}=await authorizeExpandedDevice(x),before=x.commits.length;
  const key='identity-operation:'+x.f.access.endpoint+':'+offer.operationId,original=await joined.store.get(key);
  const activeKey='galaxy-web:'+x.f.access.endpoint+':active',oldBinding=joined.runtime.api.snapshot();
  assert.deepEqual(await joined.store.get(activeKey),owner);assert.equal((await client.pending()).needsLocalDeviceSelection,true);
  assert.equal((await client.createOffer(x.subjectId,{scopes:offer.scopes,confirmed:true})).operationId,offer.operationId);
  assert.equal((await client.resumePending(offer.operationId)).needsLocalDeviceSelection,true);
  assert.equal(joined.runtime.api.snapshot().bindingId,oldBinding.bindingId);
  const preview=await client.previewLocalDeviceSelection(offer.operationId);
  assert.deepEqual(preview,{endpoint:x.f.access.endpoint,subjectId:x.subjectId,operationId:offer.operationId,
   previousDeviceId:initial.deviceId,deviceId:offer.deviceId,scopes:offer.scopes,
   fingerprint:(await x.f.identityControl.publicState(x.subjectId)).devices.find(row=>row.device_id===offer.deviceId).key_id});
  assert.equal(Object.isFrozen(preview),true);assert.equal(Object.isFrozen(preview.scopes),true);
  await assert.rejects(client.selectLocalDevice(preview),error=>error.code==='device_join_confirmation_required');
  await assert.rejects(client.selectLocalDevice({...preview},{confirmed:true}),error=>error.code==='device_local_selection_preview_required');
  subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};
  const first=client.selectLocalDevice(preview,{confirmed:true}),second=client.selectLocalDevice(preview,{confirmed:true});
  assert.equal(first,second,'the same explicit choice shares the in-flight result');
  const selected=await first;assert.equal(selected.activated,true);assert.equal(selected.localDeviceSelected,true);assert.equal(selected.connectionRequired,true);
  assert.deepEqual((await joined.runtime.status()).identity,{subjectId:x.subjectId,deviceId:offer.deviceId});assert.equal(joined.runtime.api.snapshot(),null);
  const repeated=await client.selectLocalDevice(preview,{confirmed:true});assert.equal(repeated.activated,false);assert.equal(repeated.alreadyActivated,true);
  assert.equal(repeated.connectionRequired,false);assert.equal((await client.pending()).needsLocalDeviceSelection,false);
  assert.equal(x.commits.length,before);assert.equal(signs,0);assert.deepEqual(await joined.store.get(key),original);
  assert.equal(JSON.stringify((await joined.store.get(key)).commit),JSON.stringify(original.commit),'the original signed HTTP bytes are unchanged');
  assert.ok(await joined.store.get('device:'+x.subjectId+':'+initial.deviceId),'old key material remains local');
  assert.equal((await x.f.identityControl.publicState(x.subjectId)).devices.find(row=>row.device_id===initial.deviceId).status,'active');
  subtle.sign=originalSign;await joined.runtime.connect({confirmed:true});subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};
  await assert.rejects(client.selectLocalDevice(preview,{confirmed:true}),error=>error.code==='device_handoff_owner_changed');
  const binding=joined.runtime.api.snapshot(),receipt=await client.resumePending(offer.operationId);
  assert.equal(receipt.alreadyActivated,true);assert.equal(receipt.activated,false);assert.equal(joined.runtime.api.snapshot().bindingId,binding.bindingId);
  assert.equal(x.commits.length,before);assert.equal(signs,0);
 }finally{if(descriptor)Object.defineProperty(subtle,'sign',descriptor);else Reflect.deleteProperty(subtle,'sign');await x.close();}
});

test('an exact local device choice resumes a lost local completion ACK without a second activation or server commit',{timeout:60000},async()=>{
 const x=await fixture();
 try{
  const {joined,client,offer}=await authorizeExpandedDevice(x),preview=await client.previewLocalDeviceSelection(offer.operationId);
  const key='identity-handoff:'+x.f.access.endpoint+':'+offer.operationId,originalPut=joined.store.put;
  const activeKey='galaxy-web:'+x.f.access.endpoint+':active',before=x.commits.length,activations=joined.writes.filter(name=>name===activeKey).length;
  let loseAck=true;joined.store.put=async(name,value)=>{const result=await originalPut(name,value);
   if(loseAck&&name===key&&value.state==='committed'){loseAck=false;throw Error('Synthetic local completion ACK lost');}return result;};
  await assert.rejects(client.selectLocalDevice(preview,{confirmed:true}),/local completion ACK lost/);
  assert.equal((await joined.runtime.status()).identity.deviceId,offer.deviceId);
  const resumed=await client.selectLocalDevice(preview,{confirmed:true});assert.equal(resumed.activated,false);assert.equal(resumed.alreadyActivated,true);
  assert.equal(joined.writes.filter(name=>name===activeKey).length,activations+1);assert.equal(x.commits.length,before);
  assert.equal((await client.pending()).state,'committed');assert.equal((await client.pending()).needsLocalDeviceSelection,false);
 }finally{await x.close();}
});

test('local device previews refuse original changes, unreadable status, withdrawn scope, revocation and another page winning the owner CAS',{timeout:60000},async()=>{
 const x=await fixture();
 try{
  const {joined,client,owner,offer}=await authorizeExpandedDevice(x),before=x.commits.length;
  const key='identity-operation:'+x.f.access.endpoint+':'+offer.operationId,saved=await joined.store.get(key);
  const preview=await client.previewLocalDeviceSelection(offer.operationId);
  joined.rows.set(key,{...saved,commit:{...saved.commit,newDeviceProof:saved.commit.newDeviceProof+'A'}});
  await assert.rejects(client.selectLocalDevice(preview,{confirmed:true}),error=>error.code==='device_approval_signature_invalid');joined.rows.set(key,saved);
  x.setStatusOffline(true);await assert.rejects(client.selectLocalDevice(preview,{confirmed:true}),/status unavailable/);x.setStatusOffline(false);
  const current=await x.f.identityControl.publicState(x.subjectId),device=current.devices.find(row=>row.device_id===offer.deviceId);
  // This one disposable database change models a current permission withdrawal;
  // the saved approval, original commit and original deadline remain untouched.
  await x.f.db.query('UPDATE device_authorizations SET scopes=$2 WHERE device_id=$1',[offer.deviceId,JSON.stringify(['binding','consent'])]);
  await assert.rejects(client.selectLocalDevice(preview,{confirmed:true}),error=>error.code==='device_authorization_no_longer_current');
  await x.f.db.query('UPDATE device_authorizations SET scopes=$2 WHERE device_id=$1',[offer.deviceId,JSON.stringify(device.scopes)]);
  assert.deepEqual(await joined.store.get('galaxy-web:'+x.f.access.endpoint+':active'),owner);
  const otherPage=await x.runtime(joined.rows),otherPreview=await otherPage.runtime.deviceHandoff.previewLocalDeviceSelection(offer.operationId);
  const winning=await otherPage.runtime.deviceHandoff.selectLocalDevice(otherPreview,{confirmed:true});assert.equal(winning.activated,true);
  const third=await otherPage.runtime.deviceHandoff.createOffer(x.subjectId,{scopes:['binding','consent','history','context'],confirmed:true});
  const thirdApproval=await x.old.runtime.deviceHandoff.approveOffer(third,{confirmed:true});
  const thirdCommit=await otherPage.runtime.deviceHandoff.acceptApproval(thirdApproval,{confirmed:true});assert.equal(thirdCommit.needsLocalDeviceSelection,true);
  const thirdPreview=await otherPage.runtime.deviceHandoff.previewLocalDeviceSelection(third.operationId);
  assert.equal((await otherPage.runtime.deviceHandoff.selectLocalDevice(thirdPreview,{confirmed:true})).activated,true);
  await assert.rejects(client.selectLocalDevice(preview,{confirmed:true}),error=>error.code==='device_local_selection_changed');
  const currentPreview=await client.previewLocalDeviceSelection(offer.operationId);
  await assert.rejects(client.selectLocalDevice(currentPreview,{confirmed:true}),error=>error.code==='device_handoff_owner_changed');
  assert.equal((await joined.store.get('galaxy-web:'+x.f.access.endpoint+':active')).deviceId,third.deviceId);
  assert.equal((await joined.runtime.status()).identity.deviceId,owner.deviceId,'the losing page does not pretend it adopted the other page’s owner');
  assert.equal(x.commits.length,before+1);assert.deepEqual((await joined.store.get(key)).commit,saved.commit);
  const h=createIdentityDeviceHandoff({endpoint:x.f.access.endpoint,send:joined.runtime.api.send,store:joined.store,getActive:async()=>owner,
   activate:async()=>{assert.fail('a revoked device cannot be adopted');},allowedScopes:browserScopes,now:()=>x.f.now});
  const revokedPreview=await h.previewLocalDeviceSelection(offer.operationId);
  const revoked=await x.old.runtime.deviceManagement.confirm(await x.old.runtime.deviceManagement.prepareRevoke({deviceId:offer.deviceId}),{confirmed:true});
  assert.equal(revoked.receipt.state,'committed');
  await assert.rejects(h.selectLocalDevice(revokedPreview,{confirmed:true}),error=>error.code==='device_authorization_no_longer_current');
  assert.equal(x.commits.length,before+2);
 }finally{await x.close();}
});

test('saved original device commit resumes exact HTTP bytes with zero new proof and never reactivates a completed device',{timeout:60000},async()=>{
 const x=await fixture(),subtle=globalThis.crypto.subtle,originalSign=subtle.sign.bind(subtle),originalSignDescriptor=Object.getOwnPropertyDescriptor(subtle,'sign');let signs=0;
 try{
  const joiner=await x.runtime(),{offer,approval}=await x.offer(joiner),client=joiner.runtime.deviceHandoff;
  x.setBeforeCommit(true);await assert.rejects(client.acceptApproval(approval,{confirmed:true}),/not delivered/);
  const saved=await joiner.store.get('identity-operation:'+x.f.access.endpoint+':'+offer.operationId),original=JSON.stringify(saved.commit),before=x.commits.length;
  const pending=await client.pending();assert.equal(pending.hasOriginalCommit,true);assert.equal(pending.needsReview,false);
  subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};
  x.setStatusOffline(true);await assert.rejects(client.resumePending(offer.operationId),/status unavailable/);assert.equal(x.commits.length,before);assert.equal(signs,0);
  x.setStatusOffline(false);const resumed=await client.resumePending(offer.operationId);
  assert.equal(resumed.receipt.state,'committed');assert.equal(resumed.activated,true);assert.equal(resumed.needsReview,false);assert.equal(signs,0);
  const sent=x.commits.filter(value=>JSON.parse(value.body).operationId===offer.operationId);assert.equal(sent.length,1);assert.equal(sent[0].body,original);
  assert.equal((await joiner.store.get('identity-operation:'+x.f.access.endpoint+':'+offer.operationId)).challenge,saved.challenge);
  subtle.sign=originalSign;await joiner.runtime.connect({confirmed:true});const binding=joiner.runtime.api.snapshot();
  subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};
  const repeated=await client.resumePending(offer.operationId);assert.equal(repeated.activated,false);assert.equal(repeated.alreadyActivated,true);
  assert.equal(joiner.runtime.api.snapshot().bindingId,binding.bindingId);assert.equal(joiner.runtime.api.snapshot().generation,binding.generation);
  assert.equal(x.commits.length,before+1);assert.equal(signs,0);
 }finally{if(originalSignDescriptor)Object.defineProperty(subtle,'sign',originalSignDescriptor);else Reflect.deleteProperty(subtle,'sign');await x.close();}
});

test('the approving browser reads requested, committed, canceled and expired exact approval receipts without signing or writing',{timeout:60000},async()=>{
 const x=await fixture(),subtle=globalThis.crypto.subtle,originalSign=subtle.sign.bind(subtle),originalSignDescriptor=Object.getOwnPropertyDescriptor(subtle,'sign');let signs=0;
 const writes=()=>x.requests.filter(row=>['/v2/identity/control/challenges','/v2/identity/control/commit','/v2/identity/control/cancel'].includes(row.path)).length;
 const local=()=>JSON.stringify([...x.old.rows]);
 const remote=async()=>JSON.stringify((await x.f.db.query('SELECT id,request,state,challenge_text,receipt,expires_at,committed_at FROM identity_control_operations WHERE subject_id=$1 ORDER BY id',[x.subjectId])).rows);
 async function readOnly(packet,expected){const before={local:local(),remote:await remote(),writes:writes()},connection=x.old.runtime.api.snapshot();
  subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};
  try{const result=await x.old.runtime.deviceHandoff.readApprovalStatus(packet);
   assert.equal(result.receipt.state,expected);assert.equal(result.state,expected);assert.equal(result.receipt.operationId,packet.request.operationId);
   assert.equal(result.deviceId,packet.request.newDevice.deviceId);assert.deepEqual(result.scopes,packet.request.newDevice.scopes);
   assert.equal(result.expiresAt,JSON.parse(packet.challenge).expiresAt);assert.equal(result.readOnly,true);
   assert.equal(signs,0);assert.equal(writes(),before.writes);assert.ok(local()===before.local,'status does not modify local records');
   assert.ok(await remote()===before.remote,'status does not modify the control operation');
   assert.equal(x.old.runtime.api.snapshot()?.bindingId??null,connection?.bindingId??null);return result;
  }finally{subtle.sign=originalSign;}
 }
 try{
  const joiner=await x.runtime(),first=await x.offer(joiner);
  await readOnly(first.approval,'requested');await joiner.runtime.deviceHandoff.acceptApproval(first.approval,{confirmed:true});
  await readOnly(first.approval,'committed');x.f.now+=181;await readOnly(first.approval,'committed');
  const nextJoiner=await x.runtime(),second=await x.offer(nextJoiner);
  const cancel=await x.wire('cancel',{operationId:second.offer.operationId,controllerSignature:second.approval.controllerSignature});assert.equal(cancel.status,200);
  await readOnly(second.approval,'canceled');
  const lastJoiner=await x.runtime(),third=await x.offer(lastJoiner);x.f.now+=181;await readOnly(third.approval,'expired');
 }finally{if(originalSignDescriptor)Object.defineProperty(subtle,'sign',originalSignDescriptor);else Reflect.deleteProperty(subtle,'sign');await x.close();}
});

test('approval status rejects changed originals and non-current managers while commit and cancel retain the full original proof',{timeout:60000},async()=>{
 const x=await fixture(),subtle=globalThis.crypto.subtle,originalSign=subtle.sign.bind(subtle),originalSignDescriptor=Object.getOwnPropertyDescriptor(subtle,'sign');let signs=0;
 try{
  const joiner=await x.runtime(),{offer,approval}=await x.offer(joiner),key='identity-operation:'+x.f.access.endpoint+':'+offer.operationId;
  await joiner.runtime.deviceHandoff.acceptApproval(approval,{confirmed:true});await joiner.runtime.connect({confirmed:true});
  const original=await x.old.store.get(key),proof=await joiner.store.get(key),oldDevice=(await x.old.runtime.status()).identity.deviceId;
  const changedRequest=structuredClone(approval);changedRequest.request.previousEventHash='0'.repeat(64);
  const changedChallenge=structuredClone(approval),challenge=JSON.parse(changedChallenge.challenge);challenge.nonce='A'.repeat(43);changedChallenge.challenge=JSON.stringify(challenge);
  subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};const reads=x.requests.filter(row=>row.path==='/v2/identity/control/status').length;
  await assert.rejects(x.old.runtime.deviceHandoff.readApprovalStatus(changedRequest),error=>error.code==='device_challenge_changed');
  await assert.rejects(x.old.runtime.deviceHandoff.readApprovalStatus(changedChallenge),error=>error.code==='device_approval_not_owned');
  await x.old.store.put(key,{...original,request:{...original.request,expectedEpoch:original.request.expectedEpoch+1}});
  await assert.rejects(x.old.runtime.deviceHandoff.readApprovalStatus(approval),error=>error.code==='device_approval_not_owned');await x.old.store.put(key,original);
  await x.old.store.put(key,{...original,challenge:changedChallenge.challenge});
  await assert.rejects(x.old.runtime.deviceHandoff.readApprovalStatus(approval),error=>error.code==='device_approval_not_owned');await x.old.store.put(key,original);
  await joiner.store.put(key,original);await assert.rejects(joiner.runtime.deviceHandoff.readApprovalStatus(approval),error=>error.code==='device_controller_not_authorized');await joiner.store.put(key,proof);
  assert.equal(x.requests.filter(row=>row.path==='/v2/identity/control/status').length,reads);assert.equal(signs,0);subtle.sign=originalSign;
  const controllerOnly={operationId:offer.operationId,controllerSignature:approval.controllerSignature};
  for(const action of ['commit','cancel']){const denied=await x.wire(action,controllerOnly);assert.equal(denied.status,401);assert.equal((await denied.json()).error,'identity_control_proof_invalid');
   const retained=await x.wire(action,proof.commit);assert.equal(retained.status,200);assert.equal((await retained.json()).state,'committed');}
  const otherMaterial=await joiner.store.get('device:'+x.subjectId+':'+offer.deviceId),otherSignature=await signIdentityPayload(approval.challenge,otherMaterial.privateKey);
  const wrongSigner=await x.wire('status',{operationId:offer.operationId,controllerSignature:otherSignature});assert.equal(wrongSigner.status,401);
  const oldScopes=(await x.f.identityControl.publicState(x.subjectId)).devices.find(row=>row.device_id===oldDevice).scopes;
  // A contained service fixture removes management authority to exercise a
  // changed current scope; it is not a product scope-changing operation.
  await x.f.db.query('UPDATE device_authorizations SET scopes=$2 WHERE device_id=$1',[oldDevice,JSON.stringify(oldScopes.filter(scope=>scope!=='manage-identity'&&scope!=='*'))]);
  subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};
  await assert.rejects(x.old.runtime.deviceHandoff.readApprovalStatus(approval),error=>error.code==='device_controller_not_authorized');assert.equal(signs,0);
  const lostAuthority=await x.wire('status',controllerOnly);assert.equal(lostAuthority.status,401);subtle.sign=originalSign;
  await x.f.db.query('UPDATE device_authorizations SET scopes=$2 WHERE device_id=$1',[oldDevice,JSON.stringify(oldScopes)]);
  const revoked=await joiner.runtime.deviceManagement.confirm(await joiner.runtime.deviceManagement.prepareRevoke({deviceId:oldDevice}),{confirmed:true});assert.equal(revoked.receipt.state,'committed');
  subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};
  await assert.rejects(x.old.runtime.deviceHandoff.readApprovalStatus(approval),error=>error.code==='device_controller_not_authorized');assert.equal(signs,0);
  const revokedAuthority=await x.wire('status',controllerOnly);assert.equal(revokedAuthority.status,401);
 }finally{if(originalSignDescriptor)Object.defineProperty(subtle,'sign',originalSignDescriptor);else Reflect.deleteProperty(subtle,'sign');await x.close();}
});

test('approval status fences changed browser generation, owner and exact saved approval after late HTTP reads',{timeout:60000},async()=>{
 const x=await fixture(),subtle=globalThis.crypto.subtle,originalSign=subtle.sign.bind(subtle),originalSignDescriptor=Object.getOwnPropertyDescriptor(subtle,'sign');let signs=0;
 try{
  const joiner=await x.runtime(),{offer,approval}=await x.offer(joiner);await joiner.runtime.deviceHandoff.acceptApproval(approval,{confirmed:true});
  const key='identity-operation:'+x.f.access.endpoint+':'+offer.operationId,original=await x.old.store.get(key);
  const before=x.commits.length;subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};
  x.setStatusResponse(()=>x.old.runtime.api.disconnect());
  await assert.rejects(x.old.runtime.deviceHandoff.readApprovalStatus(approval),error=>error.code==='receipt_status_authority_changed');
  x.setStatusResponse(null);assert.equal(x.commits.length,before);assert.equal(signs,0);assert.ok(JSON.stringify(await x.old.store.get(key))===JSON.stringify(original));
  let owner=(await x.old.runtime.status()).identity,activations=0;
  const handoff=createIdentityDeviceHandoff({endpoint:x.f.access.endpoint,send:x.old.runtime.api.send,store:x.old.store,getActive:async()=>owner,
   activate:async()=>{activations++;},allowedScopes:browserScopes,now:()=>x.f.now});
  x.setStatusResponse(()=>{owner={subjectId:x.subjectId,deviceId:offer.deviceId};});
  await assert.rejects(handoff.readApprovalStatus(approval),error=>error.code==='device_handoff_owner_changed');
  x.setStatusResponse(null);owner=(await x.old.runtime.status()).identity;
  x.setStatusResponse(()=>x.old.store.put(key,{...original,controllerApproval:original.controllerApproval+'A'}));
  await assert.rejects(handoff.readApprovalStatus(approval),error=>error.code==='device_handoff_original_changed');
  assert.equal(x.commits.length,before);assert.equal(activations,0);assert.equal(signs,0);
 }finally{if(originalSignDescriptor)Object.defineProperty(subtle,'sign',originalSignDescriptor);else Reflect.deleteProperty(subtle,'sign');await x.close();}
});

test('saved approval without a device proof requires the original explicit choice, and canceled or expired records never sign/retry',{timeout:60000},async()=>{
 const x=await fixture(),subtle=globalThis.crypto.subtle,originalSign=subtle.sign.bind(subtle),originalSignDescriptor=Object.getOwnPropertyDescriptor(subtle,'sign');let signs=0;
 try{
  const joiner=await x.runtime(),{offer,approval}=await x.offer(joiner),client=joiner.runtime.deviceHandoff;
  subtle.sign=()=>{throw Error('Synthetic new proof not signed');};await assert.rejects(client.acceptApproval(approval,{confirmed:true}),/not signed/);
  subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};const before=x.commits.length;
  const pending=await client.pending();assert.equal(pending.registered,false);assert.equal(pending.needsReview,true);assert.equal(pending.hasOriginalCommit,false);
  const unconfirmed=await client.resumePending(offer.operationId);assert.equal(unconfirmed.receipt.registered,false);assert.equal(unconfirmed.needsReview,true);
  assert.equal(x.commits.length,before);assert.equal(signs,0);assert.equal((await joiner.runtime.status()).identity,null);
  assert.equal((await client.previewApproval(approval)).operationId,offer.operationId);assert.equal(signs,0);
  await client.cancel(offer.operationId,{confirmed:true});assert.equal((await client.resumePending(offer.operationId)).needsReview,false);
  await assert.rejects(client.acceptApproval(approval,{confirmed:true}),error=>error.code==='device_request_canceled');assert.equal(signs,0);assert.equal(x.commits.length,before);
  subtle.sign=originalSign;
  const unsignedJoiner=await x.runtime(),unsigned=await x.offer(unsignedJoiner);
  subtle.sign=()=>{throw Error('Synthetic new proof not signed');};await assert.rejects(unsignedJoiner.runtime.deviceHandoff.acceptApproval(unsigned.approval,{confirmed:true}),/not signed/);
  x.f.now+=181;subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};
  const unsignedExpired=await unsignedJoiner.runtime.deviceHandoff.resumePending(unsigned.offer.operationId);
  assert.equal(unsignedExpired.receipt.state,'expired');assert.equal(unsignedExpired.receipt.registered,false);assert.equal(unsignedExpired.receipt.localOnly,true);
  assert.equal(unsignedExpired.needsReview,false);assert.equal(signs,0);assert.equal(x.commits.length,before);
  subtle.sign=originalSign;
  const expiredJoiner=await x.runtime(),next=await x.offer(expiredJoiner);x.setBeforeCommit(true);
  await assert.rejects(expiredJoiner.runtime.deviceHandoff.acceptApproval(next.approval,{confirmed:true}),/not delivered/);
  const beforeExpiry=x.commits.length;x.f.now+=181;
  subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};const previousSigns=signs;
  const expired=await expiredJoiner.runtime.deviceHandoff.resumePending(next.offer.operationId);
  assert.equal(expired.receipt.state,'expired');assert.equal(expired.activated,false);assert.equal(expired.needsReview,false);
  assert.equal((await expiredJoiner.runtime.deviceHandoff.pending()).state,'expired');
  assert.equal(x.commits.length,beforeExpiry);assert.equal(signs,previousSigns);
 }finally{if(originalSignDescriptor)Object.defineProperty(subtle,'sign',originalSignDescriptor);else Reflect.deleteProperty(subtle,'sign');await x.close();}
});

test('an asynchronous original device read cannot activate or send into a newly selected browser identity',{timeout:60000},async()=>{
 const x=await fixture();
 try{
  const joiner=await x.runtime(),{offer,approval}=await x.offer(joiner);x.setBeforeCommit(true);
  await assert.rejects(joiner.runtime.deviceHandoff.acceptApproval(approval,{confirmed:true}));
  const original=await joiner.store.get('identity-operation:'+x.f.access.endpoint+':'+offer.operationId);
  let changed=false;x.setRead(async key=>{if(!changed&&key==='identity-handoff:'+x.f.access.endpoint+':'+offer.operationId){changed=true;x.setRead(null);await joiner.runtime.createIdentity({confirmed:true});}});
  await assert.rejects(joiner.runtime.deviceHandoff.resumePending(offer.operationId),/身份|device_handoff_owner_changed/);
  assert.equal(changed,true);assert.notEqual((await joiner.runtime.status()).identity.subjectId,x.subjectId);
  assert.equal(x.commits.filter(value=>JSON.parse(value.body).operationId===offer.operationId).length,0);
  assert.deepEqual((await joiner.store.get('identity-operation:'+x.f.access.endpoint+':'+offer.operationId)).commit,original.commit);
 }finally{await x.close();}
});

test('a completed device receipt never reselects or reconnects; an empty browser explicitly resumes only the original local device',{timeout:60000},async()=>{
 const x=await fixture(),subtle=globalThis.crypto.subtle,originalSign=subtle.sign.bind(subtle),originalSignDescriptor=Object.getOwnPropertyDescriptor(subtle,'sign');let signs=0;
 try{
  const joined=await x.runtime(),{offer,approval}=await x.offer(joined);await joined.runtime.deviceHandoff.acceptApproval(approval,{confirmed:true});
  await joined.runtime.connect({confirmed:true});await joined.runtime.disconnect();
  const key='identity-operation:'+x.f.access.endpoint+':'+offer.operationId,original=JSON.stringify(await joined.store.get(key)),before=x.commits.length,writes=joined.writes.length;
  subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};
  const disconnected=await joined.runtime.deviceHandoff.resumePending(offer.operationId);
  assert.equal(disconnected.alreadyActivated,true);assert.equal(disconnected.activated,false);assert.equal(disconnected.needsLocalActivation,false);
  assert.equal(joined.runtime.api.snapshot(),null);assert.equal(joined.writes.length,writes);assert.equal(signs,0);
  await assert.rejects(joined.runtime.deviceHandoff.resumeLocalIdentity(offer.operationId,{confirmed:true}),error=>error.code==='device_identity_switch_required');
  joined.runtime.close();joined.rows.delete('galaxy-web:'+x.f.access.endpoint+':active');const blank=await x.runtime(joined.rows),blankWrites=blank.writes.length;
  // Time passing does not invalidate a committed operation. The current device
  // authorization, not that old approval deadline, governs local resumption.
  x.f.now+=181;const read=await blank.runtime.deviceHandoff.resumePending(offer.operationId);
  assert.equal(read.receipt.state,'committed');assert.equal(read.alreadyActivated,false);assert.equal(read.needsLocalActivation,true);assert.equal(read.activated,false);
  assert.equal((await blank.runtime.status()).identity,null);assert.equal(blank.writes.length,blankWrites);assert.equal(signs,0);
  await assert.rejects(blank.runtime.deviceHandoff.resumeLocalIdentity(offer.operationId),error=>error.code==='device_join_confirmation_required');
  x.setStatusResponse(()=>blank.runtime.api.disconnect());
  await assert.rejects(blank.runtime.deviceHandoff.resumeLocalIdentity(offer.operationId,{confirmed:true}),error=>error.code==='device_handoff_owner_changed');x.setStatusResponse(null);
  assert.equal((await blank.runtime.status()).identity,null);assert.equal(blank.writes.length,blankWrites);assert.equal(signs,0);
  const resumed=await blank.runtime.deviceHandoff.resumeLocalIdentity(offer.operationId,{confirmed:true});
  assert.equal(resumed.activated,true);assert.equal(resumed.resumedLocalIdentity,true);assert.equal(resumed.connectionRequired,true);
  assert.deepEqual((await blank.runtime.status()).identity,{subjectId:x.subjectId,deviceId:offer.deviceId});assert.equal(blank.runtime.api.snapshot(),null);
  assert.equal(blank.writes.length,blankWrites+1);assert.equal(signs,0);assert.equal(x.commits.length,before);
  assert.ok(JSON.stringify(await blank.store.get(key))===original,'the original request, commit, proof, receipt and deadline remain unchanged');
  assert.equal((await x.f.identityControl.publicState(x.subjectId)).devices.filter(device=>device.device_id===offer.deviceId).length,1);
 }finally{if(originalSignDescriptor)Object.defineProperty(subtle,'sign',originalSignDescriptor);else Reflect.deleteProperty(subtle,'sign');await x.close();}
});

test('local resumption refuses another current owner, missing material, changed originals and unknown status without signing or activating',{timeout:60000},async()=>{
 const x=await fixture(),subtle=globalThis.crypto.subtle,originalSign=subtle.sign.bind(subtle),originalSignDescriptor=Object.getOwnPropertyDescriptor(subtle,'sign');let signs=0;
 try{
  const joined=await x.runtime(),{offer,approval}=await x.offer(joined);await joined.runtime.deviceHandoff.acceptApproval(approval,{confirmed:true});
  const originalOwner=(await joined.runtime.status()).identity,key='identity-operation:'+x.f.access.endpoint+':'+offer.operationId,recordKey='identity-handoff:'+x.f.access.endpoint+':'+offer.operationId,
   materialKey='device:'+x.subjectId+':'+offer.deviceId,saved=await joined.store.get(key),record=await joined.store.get(recordKey),material=await joined.store.get(materialKey);
  let owner=null,activations=0;const h=createIdentityDeviceHandoff({endpoint:x.f.access.endpoint,send:joined.runtime.api.send,store:joined.store,getActive:async()=>owner,
   activate:async value=>{activations++;owner=value;},allowedScopes:browserScopes,now:()=>x.f.now}),before=x.commits.length,writes=joined.writes.length;
  subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};
  owner={subjectId:x.subjectId,deviceId:(await x.old.runtime.status()).identity.deviceId};
  await assert.rejects(h.resumeLocalIdentity(offer.operationId,{confirmed:true}),error=>error.code==='device_identity_switch_required');
  const awaitingSelection=await h.resumePending(offer.operationId);
  assert.equal(awaitingSelection.needsLocalDeviceSelection,true);assert.equal(awaitingSelection.activated,false);
  assert.equal(owner.deviceId,(await x.old.runtime.status()).identity.deviceId);
  owner={subjectId:'GUID1501M4GK4NZ08ZZ04CJ2A4CCHPTS',deviceId:crypto.randomUUID()};
  await assert.rejects(h.resumeLocalIdentity(offer.operationId,{confirmed:true}),error=>error.code==='device_identity_switch_required');owner=null;
  x.setStatusOffline(true);await assert.rejects(h.resumeLocalIdentity(offer.operationId,{confirmed:true}),/status unavailable/);x.setStatusOffline(false);
  joined.rows.delete(materialKey);await assert.rejects(h.resumeLocalIdentity(offer.operationId,{confirmed:true}),error=>error.code==='device_key_unavailable');joined.rows.set(materialKey,material);
  joined.rows.set(materialKey,{...material,deviceId:crypto.randomUUID()});await assert.rejects(h.resumeLocalIdentity(offer.operationId,{confirmed:true}),error=>error.code==='device_key_unavailable');joined.rows.set(materialKey,material);
  joined.rows.set(key,{...saved,commit:{...saved.commit,newDeviceProof:saved.commit.newDeviceProof+'A'}});
  await assert.rejects(h.resumeLocalIdentity(offer.operationId,{confirmed:true}),error=>error.code==='device_approval_signature_invalid');joined.rows.set(key,saved);
  for(const state of ['canceled','expired']){joined.rows.set(recordKey,{...record,state});await assert.rejects(h.resumeLocalIdentity(offer.operationId,{confirmed:true}),error=>error.code==='device_handoff_not_completed');}joined.rows.set(recordKey,record);
  x.setStatusResponse(()=>{owner=originalOwner;});await assert.rejects(h.resumeLocalIdentity(offer.operationId,{confirmed:true}),error=>error.code==='device_handoff_owner_changed');x.setStatusResponse(null);owner=null;
  x.setStatusResponse(()=>{joined.rows.set(recordKey,{...record,installationId:crypto.randomUUID()});});
  await assert.rejects(h.resumeLocalIdentity(offer.operationId,{confirmed:true}),error=>error.code==='device_handoff_original_changed');x.setStatusResponse(null);joined.rows.set(recordKey,record);
  assert.equal(activations,0);assert.equal(signs,0);assert.equal(x.commits.length,before);assert.equal(joined.writes.length,writes);
 }finally{if(originalSignDescriptor)Object.defineProperty(subtle,'sign',originalSignDescriptor);else Reflect.deleteProperty(subtle,'sign');await x.close();}
});

test('a committed local device cannot resume after revocation, loss of binding or an identity epoch change',{timeout:60000},async()=>{
 const x=await fixture(),subtle=globalThis.crypto.subtle,originalSign=subtle.sign.bind(subtle),originalSignDescriptor=Object.getOwnPropertyDescriptor(subtle,'sign');let signs=0;
 try{
  const joined=await x.runtime(),{offer,approval}=await x.offer(joined);await joined.runtime.deviceHandoff.acceptApproval(approval,{confirmed:true});
  let owner=null,activations=0;const h=createIdentityDeviceHandoff({endpoint:x.f.access.endpoint,send:joined.runtime.api.send,store:joined.store,getActive:async()=>owner,
   activate:async value=>{activations++;owner=value;},allowedScopes:browserScopes,now:()=>x.f.now}),device=(await x.f.identityControl.publicState(x.subjectId)).devices.find(row=>row.device_id===offer.deviceId),before=x.commits.length;
  subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};
  // These scoped database changes simulate current control states only inside
  // this disposable service fixture; no operation or approval is rewritten.
  await x.f.db.query('UPDATE device_authorizations SET scopes=$2 WHERE device_id=$1',[offer.deviceId,JSON.stringify(device.scopes.filter(scope=>scope!=='binding'&&scope!=='*'))]);
  await assert.rejects(h.resumeLocalIdentity(offer.operationId,{confirmed:true}),error=>error.code==='device_authorization_no_longer_current');
  await x.f.db.query('UPDATE device_authorizations SET scopes=$2,epoch=epoch+1 WHERE device_id=$1',[offer.deviceId,JSON.stringify(device.scopes)]);
  await assert.rejects(h.resumeLocalIdentity(offer.operationId,{confirmed:true}),error=>error.code==='device_authorization_no_longer_current');
  await x.f.db.query('UPDATE device_authorizations SET epoch=$2 WHERE device_id=$1',[offer.deviceId,device.epoch]);subtle.sign=originalSign;
  const revoked=await x.old.runtime.deviceManagement.confirm(await x.old.runtime.deviceManagement.prepareRevoke({deviceId:offer.deviceId}),{confirmed:true});assert.equal(revoked.receipt.state,'committed');
  const afterRevoke=x.commits.length;subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};
  await assert.rejects(h.resumeLocalIdentity(offer.operationId,{confirmed:true}),error=>error.code==='device_authorization_no_longer_current');
  assert.equal(activations,0);assert.equal(signs,0);assert.equal(x.commits.length,afterRevoke);assert.equal(afterRevoke,before+1);
  subtle.sign=originalSign;const recovery=await x.old.runtime.prepareRecovery();await x.old.runtime.saveRecovery({operationId:recovery.operationId,confirmed:true});
  const recovered=await x.runtime();await recovered.runtime.recover(recovery.code,{confirmed:true});
  assert.equal((await x.f.identityControl.publicState(x.subjectId)).epoch,device.epoch+1);const afterRecovery=x.commits.length;
  subtle.sign=function(...args){signs++;return originalSign.apply(this,args);};
  await assert.rejects(h.resumeLocalIdentity(offer.operationId,{confirmed:true}),error=>error.code==='device_authorization_no_longer_current');
  assert.equal(activations,0);assert.equal(signs,0);assert.equal(x.commits.length,afterRecovery);
 }finally{if(originalSignDescriptor)Object.defineProperty(subtle,'sign',originalSignDescriptor);else Reflect.deleteProperty(subtle,'sign');await x.close();}
});
