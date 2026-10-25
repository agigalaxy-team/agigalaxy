import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {CompactSign} from 'jose';
import {digest} from '../src/shared/digest.mjs';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {createBrowserClient,browserScopes} from '../src/browser-client.mjs';
import { createExistingWebRuntime } from './existing-web-identity-fixture.mjs';
import {createNativeWatch} from '../../galaxy-edge-mcp/src/native-v2/watch/index.mjs';
import {createNativeWatchHandoff} from '../../galaxy-edge-mcp/src/native-v2/watch/handoff.mjs';
import {transaction} from '../src/database.mjs';
import {cleanupWatchControlsWithin} from '../src/operations/watch-control-retention-v2.mjs';
import {approveFixtureDeletion} from './deletion-execute-workflow.mjs';
import {executeDeletion} from '../src/operations/deletion-execute.mjs';

const memoryStore=()=>{const data=new Map();return{
 get:async key=>structuredClone(data.get(key)),put:async(key,value)=>data.set(key,structuredClone(value)),
 update:async(key,fn)=>{const value=fn(structuredClone(data.get(key)));data.set(key,structuredClone(value));return structuredClone(value);}};};

export async function verifyWatchControlV2({database=null,adminDatabase=database,workerDatabase=null,repositories,migrateDatabase=true}={}){
 const f=await serviceFixture(browserScopes,database,{migrateDatabase,repositories,now:Math.floor(Date.now()/1000)});
 const admin=adminDatabase??f.db,bodies=new Map(),clients=[];
 // Current device bindings, room ACL, Agent grants, cursors and HTTP are real.
 // Only the external archive transport and Account quota are explicit doubles;
 // this is not another Prosody or public Account acceptance test.
 f.chat.requireAccountWithin=async()=>{};f.chat.consumeInviteWithin=async()=>{};f.chat.markInviteRespondedWithin=async()=>{};
 f.chat.transport={available:true,project:async()=>{},send:async x=>{bodies.set(x.messageId,{archiveId:x.messageId,text:x.text,revision:1});return{archiveId:x.messageId};},
  read:async x=>x.ids.map(id=>bodies.get(id)).filter(Boolean),erase:async x=>{bodies.delete(x.messageId);return{archiveDeleted:true};}};
 const server=createApi({...f,browserOrigins:['https://galaxy.example.org'],rateLimit:10000});let outsider,loseTakeover=false;
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const fetcher=async(url,options)=>{const path=new URL(url).pathname,response=await fetch(origin+path,{...options,headers:{...options.headers,Origin:'https://galaxy.example.org'}});
   if(loseTakeover&&path==='/v2/watch-controls/takeover'&&response.status===200){loseTakeover=false;throw Error('synthetic lost committed takeover ACK');}return response;};
  const devices=[{deviceId:randomUUID(),publicKeyPem:f.genesis.genesisProof.publicKeyPem,sign:f.signForTest}];
  for(let i=1;i<3;i++){const keys=generateKeyPairSync('ed25519');devices.push({deviceId:randomUUID(),publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}),
   sign:(text,typ)=>new CompactSign(Buffer.from(text)).setProtectedHeader({alg:'Ed25519',typ}).sign(keys.privateKey)});}
  for(const[i,d]of devices.entries()){const state=i?await f.identityControl.publicState(f.genesis.id):null;
   const operation={operationId:randomUUID(),subjectId:f.genesis.id,kind:i?'authorize-device':'bootstrap',expectedEpoch:i?1:0,
    previousEventHash:state?.chainHead??null,signerKeyId:digest(devices[0].publicKeyPem),...(i?{}:{genesisProof:f.genesis.genesisProof}),
    newDevice:{deviceId:d.deviceId,publicKeyPem:d.publicKeyPem,scopes:['manage-identity',...browserScopes]}};
   const challenge=await f.identityControl.challenge(operation);await f.identityControl.commit({operationId:operation.operationId,
    controllerSignature:await f.signForTest(challenge.challenge,'galaxy-identity-control-v2+jws'),newDeviceProof:await d.sign(challenge.challenge,'galaxy-identity-control-v2+jws')});
   const client=createBrowserClient({endpoint:f.bindings.endpoint,trustedKeys:f.bindings.trustedKeys,sign:d.sign,now:()=>f.now,fetch:fetcher});
   await client.connect({subjectId:f.genesis.id,genesisProof:f.genesis.genesisProof,control:{deviceId:d.deviceId,keyId:digest(d.publicKeyPem),epoch:1},installationId:randomUUID(),scopes:browserScopes},{confirmed:true});clients.push(client);}
  const[a,b,c]=clients;outsider=await createExistingWebRuntime({endpoint:f.bindings.endpoint,trustedKeys:f.bindings.trustedKeys},{store:memoryStore(),fetch:fetcher,now:()=>f.now});
  await outsider.connect({confirmed:true});const peer=(await outsider.status()).identity.subjectId;
  const room=await a.call('/v2/chat/rooms/create',{roomId:randomUUID(),operationId:randomUUID(),title:'Synthetic transferred watch'});
  const invite=await a.call(`/v2/chat/rooms/${room.roomId}/propose`,{decisionId:randomUUID(),expectedRevision:room.revision,action:'invite',targetSubjectId:peer});
  await outsider.api.call(`/v2/chat/rooms/${room.roomId}/accept`,{decisionId:invite.decisionId,accept:true});
  const grant=async(client,id,mode='respond')=>client.call(`/v2/chat/rooms/${room.roomId}/agent-grant`,{grantId:id,bindingId:client.snapshot().bindingId,mode,primaryResponder:mode==='respond',expiresAt:f.now+3600});
  const oldGrant=randomUUID(),unrelated=randomUUID();await grant(a,oldGrant);await grant(a,unrelated,'read');
  const localA=memoryStore(),localB=memoryStore(),wa=createNativeWatch({store:localA,api:a,subjectId:f.genesis.id,now:()=>f.now});
  const started=await wa.start({roomId:room.roomId,agentGrantId:oldGrant,purpose:'Selected synthetic room only',expiresAt:f.now+1800},{confirmed:true});
  const w=started.items[0],watchId=w.id,ha=createNativeWatchHandoff({store:localA,api:a,subjectId:f.genesis.id,now:()=>f.now}),hb=createNativeWatchHandoff({store:localB,api:b,subjectId:f.genesis.id,now:()=>f.now});
  assert.equal((await ha.query()).items.length,0,'local start never uploads a control or summary');
  const register={operationId:randomUUID(),watchId,roomId:w.roomId,agentGrantId:w.agentGrantId,purpose:w.purpose,expiresAt:w.expiresAt};
  await assert.rejects(ha.enable(register),/watch_choice_required/);const registered=await ha.enable(register,{confirmed:true});assert.equal(registered.watch.revision,1);
  assert.equal(registered.watch.stored,'explicitly-selected-private-watch-control');
  const boundedGrant=(await admin.query('SELECT expires_at FROM chat_agent_grants WHERE grant_id=$1',[oldGrant])).rows[0];
  assert.equal(Date.parse(boundedGrant.expires_at),w.expiresAt*1000,'the exact delegated scope cannot outlive its selected watch deadline');
  await assert.rejects(outsider.api.call('/v2/watch-controls/read',{watchId}),/watch_control_not_found/);
  assert.equal((await outsider.api.call('/v2/watch-controls/query',{})).items.length,0);
  await outsider.api.call(`/v2/chat/rooms/${room.roomId}/send`,{clientMessageId:randomUUID(),text:'Synthetic acknowledged work'});
  const work=await wa.check(watchId);assert.equal(work.state,'work-ready');await wa.ack(watchId,work.work.workId);
  const acknowledged=(await ha.get(watchId)).watch.lastCursor;assert.notEqual(acknowledged,'0');
  await outsider.api.call(`/v2/chat/rooms/${room.roomId}/send`,{clientMessageId:randomUUID(),text:'Synthetic work not acknowledged'});
  const pendingReader=createNativeWatch({store:localA,api:a,subjectId:f.genesis.id,now:()=>f.now+901});
  const pending=await pendingReader.check(watchId);assert.equal(pending.state,'work-ready');assert.notEqual(pending.work.next,acknowledged);
  const takeover={operationId:randomUUID(),watchId,expectedRevision:1,expectedGrantId:oldGrant,targetBindingId:b.snapshot().bindingId,newGrantId:randomUUID()};
  await assert.rejects(hb.takeover(takeover),/watch_choice_required/);
  loseTakeover=true;await assert.rejects(hb.takeover(takeover,{confirmed:true}),/lost committed takeover/);
  assert.equal((await hb.pending()).length,1);const moved=await hb.reconcile(takeover.operationId);
  assert.equal(moved.watch.watchId,watchId);assert.equal(moved.watch.lastCursor,acknowledged);assert.equal(moved.watch.revision,2);
  assert.equal(moved.receipt.previousInstallationState,'revoked-for-this-watch');assert.equal(moved.watch.externalProcessStopped,'unconfirmed');
  const wb=createNativeWatch({store:localB,api:b,subjectId:f.genesis.id,now:()=>f.now});
  assert.equal((await wb.status(watchId)).items[0].after,acknowledged);assert.equal((await wb.check(watchId)).work.items[0].text,'Synthetic work not acknowledged');
  for(const {method,input}of [{method:'history',input:{after:'0',agentGrantId:oldGrant}},{method:'cursor',input:{kind:'agent',agentGrantId:oldGrant,sequence:acknowledged}},
   {method:'send',input:{clientMessageId:randomUUID(),text:'stale responder must fail',agentGrantId:oldGrant}}]){
   await assert.rejects(a.call(`/v2/chat/rooms/${room.roomId}/${method}`,input),/chat_agent_not_authorized/);}
  await assert.rejects(pendingReader.ack(watchId,pending.work.workId),/chat_agent_not_authorized/);
  await assert.rejects(c.call('/v2/watch-controls/takeover',{...takeover,operationId:randomUUID(),targetBindingId:c.snapshot().bindingId,newGrantId:randomUUID()}),/watch_control_revision_conflict/);
  await wa.stop(watchId);assert.equal((await hb.get(watchId)).watch.state,'active','old host stop never follows new grant');
  const active=(await a.call(`/v2/chat/rooms/${room.roomId}/agent-grants`,{})).items;
  assert.equal(active.find(x=>x.grantId===unrelated).state,'active');assert.equal(active.find(x=>x.grantId===takeover.newGrantId).state,'active');
  const stop={operationId:randomUUID(),watchId,expectedRevision:2,expectedGrantId:takeover.newGrantId};await hb.stop(stop);await hb.stop(stop);
  assert.equal((await hb.get(watchId)).watch.state,'stopped');await hb.reconcile(takeover.operationId);
  assert.equal((await wb.status(watchId)).items[0].state,'stopped','old successful takeover receipt cannot resurrect a later stop');
  await assert.rejects(c.call('/v2/watch-controls/takeover',{operationId:randomUUID(),watchId,expectedRevision:3,expectedGrantId:takeover.newGrantId,targetBindingId:c.snapshot().bindingId,newGrantId:randomUUID()}),/watch_control_inactive/);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM watch_control_operations_v2 WHERE watch_id=$1',[watchId])).rows[0].n,3);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM chat_agent_grants WHERE grant_id=$1',[takeover.newGrantId])).rows[0].n,1);
  const selected=(await admin.query('SELECT * FROM watch_controls_v2 WHERE watch_id=$1',[watchId])).rows[0];
  assert.equal(JSON.stringify(selected).includes('Synthetic acknowledged work'),false);assert.equal(selected.purpose,w.purpose);
  const additional=async(client,purpose)=>{const grantId=randomUUID();await grant(client,grantId,'read');
   const r=await client.call('/v2/watch-controls/register',{operationId:randomUUID(),watchId:randomUUID(),roomId:room.roomId,agentGrantId:grantId,purpose,expiresAt:f.now+1800});return r.watch;};
  const blocked=await additional(a,'Synthetic revoked scope');
  await a.call(`/v2/chat/rooms/${room.roomId}/agent-revoke`,{grantId:blocked.agentGrantId});
  await assert.rejects(b.call('/v2/watch-controls/takeover',{operationId:randomUUID(),watchId:blocked.watchId,expectedRevision:1,
   expectedGrantId:blocked.agentGrantId,targetBindingId:b.snapshot().bindingId,newGrantId:randomUUID()}),/watch_source_grant_revoked/);
  const contested=await additional(a,'Synthetic contested transfer');
  const requests=[b,c].map(client=>({operationId:randomUUID(),watchId:contested.watchId,expectedRevision:1,expectedGrantId:contested.agentGrantId,targetBindingId:client.snapshot().bindingId,newGrantId:randomUUID()}));
  const concurrent=await Promise.allSettled([b,c].map((client,i)=>client.call('/v2/watch-controls/takeover',requests[i])));
  assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);assert.match(concurrent.find(r=>r.status==='rejected').reason.message,/watch_control_revision_conflict/);
  const foreign=await additional(outsider.api,'Synthetic independently owned scope');
  f.actor=await f.access.authenticate(f.credential);
  const ticket=await f.dataExport.create(f.actor,{id:randomUUID(),datasets:['watch-controls','watch-control-operations'],views:[]});
  const exported=await f.dataExport.page(f.actor,{id:ticket.id,dataset:'watch-controls'});assert.equal(exported.items.length,3);assert.ok(exported.items.every(row=>row.subject_id===f.genesis.id));
  const cleaned=await transaction(workerDatabase??admin,db=>cleanupWatchControlsWithin(db,f.now+90*86400+1));assert.equal(cleaned.watchControlReceipts,1);
  assert.equal((await admin.query('SELECT count(*)::int n FROM watch_control_operations_v2 WHERE watch_id=$1',[watchId])).rows[0].n,0);
  const deletion=await approveFixtureDeletion(f,admin,{auditUntil:f.now+180});await executeDeletion(admin,deletion,{now:()=>f.now});
  assert.equal((await admin.query('SELECT count(*)::int n FROM watch_controls_v2 WHERE subject_id=$1',[f.genesis.id])).rows[0].n,0);
  assert.equal((await admin.query('SELECT count(*)::int n FROM watch_control_operations_v2 WHERE subject_id=$1',[f.genesis.id])).rows[0].n,0);
  assert.equal((await admin.query('SELECT count(*)::int n FROM watch_controls_v2 WHERE watch_id=$1',[foreign.watchId])).rows[0].n,1);
  return{watchIdStable:true,threeSameSubjectBindings:true,actualHttp:true,exactCursor:true,oldGrantDenied:true,unrelatedGrantRetained:true,
   lostAckReconciled:true,localStopNotResurrected:true,concurrentTakeoverWinner:1,revokedScopeNotResumed:true,ownExport:true,actualPrimaryDeletion:true,workerRetention:true,
   cloudModel:false,transport:'explicit-contract-double',hostRuntimeAcceptance:false};
 }finally{for(const c of clients)c.close();outsider?.close();await new Promise(r=>server.close(r));if(!database)await f.db.close();}
}
