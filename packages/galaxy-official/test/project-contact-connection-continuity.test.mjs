import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes,createBrowserClient} from '../src/browser-client.mjs';
import { createExistingWebRuntime } from './existing-web-identity-fixture.mjs';
import {createRecoveryMaterial} from '../../galaxy-core/src/domain/identity-material.mjs';
import {getProjectContactClient} from '../../galaxy-web/src/project-contact-client.mjs';
import {digest} from '../src/shared/digest.mjs';
import {verifyContactsV2} from './contacts-v2-workflow.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function memoryStore(values,{get,put}={}){
  const store={
    async update(key,fn){const next=fn(structuredClone(values.get(key)));if(next&&typeof next.then==='function'){if(next instanceof Promise)void next.catch(()=>{});throw Error('local_update_async_callback');}const committed=structuredClone(next);values.set(key,committed);await put?.(key,committed);return structuredClone(committed);},
    get:async key=>{const value=structuredClone(values.get(key));await get?.(key,value);return value;},
    put:async(key,value)=>{values.set(key,structuredClone(value));await put?.(key,value);},
    async prepareRecovery(subjectId,operationId){
      const key=`pending-recovery:${subjectId}:${operationId}`,old=await store.get(key);if(old)return old;
      const value={...await createRecoveryMaterial(subjectId),operationId,saveDeclared:false,status:'local-pending-registration'};
      await store.put(key,value);return value;
    },
    async declareSaved(subjectId,operationId){
      const key=`pending-recovery:${subjectId}:${operationId}`,value=await store.get(key);assert.ok(value);
      await store.put(key,{...value,saveDeclared:true});
    },
    async recordReceipt(subjectId,operationId,receipt){
      assert.equal(receipt.subjectId,subjectId);assert.equal(receipt.operationId,operationId);assert.equal(receipt.state,'committed');
      const key=`pending-recovery:${subjectId}:${operationId}`,value=await store.get(key);assert.ok(value);
      await store.put(key,{...value,receipt,status:value.saveDeclared?'registered-save-declared':'registered-awaiting-save-declaration'});
    },
  };return store;
}
// Real WebRuntime, device JWS, canonical HTTP and PGlite. Journal uses a
// declared Map fixture. Private Project tests do not exercise Account quotas.
async function fixture(){
  const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000),syntheticCommunityQuota:false});
  const server=createApi({...f,rateLimit:1000}),data=new Map(),writes=[],clients=[];let runtime,onGet,onPut,lose=false;
  try{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
    const makeRuntime=async store=>{const client=await createExistingWebRuntime({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{
      now:()=>f.now,store,fetch:async(url,options)=>{const path=new URL(url).pathname;
        if(path==='/v1/consents'||path==='/v2/projects')writes.push(path);
        const response=await fetch(origin+path,options);
        if(lose&&path==='/v2/projects'){lose=false;assert.equal(response.status,200);throw new Error('Fictional caller ACK lost after actual commit');}
        return response;
      }});clients.push(client);return client;};
    runtime=await makeRuntime(memoryStore(data,{get:(...args)=>onGet?.(...args),put:(...args)=>onPut?.(...args)}));
    await runtime.connect({confirmed:true});
    const subjectId=runtime.api.snapshot().subjectId;
    const input={kind:'create',projectId:randomUUID(),operationId:randomUUID(),expectedRevision:0,
      document:{kind:'project',title:'FICTIONAL private project',summary:'PRIVATE FICTIONAL M10 draft',
        functions:['table-extraction'],discoverable:false}};
    const rows=async()=>(await f.db.query('SELECT operation_id,consent_id,payload_text,payload_hash FROM project_events_v2 WHERE project_id=$1',[input.projectId])).rows;
    return{f,runtime,data,writes,subjectId,input,rows,
      other:async()=>{const other=await makeRuntime(memoryStore(new Map()));await other.connect({confirmed:true});return other;},
      get:fn=>{onGet=fn;},put:fn=>{onPut=fn;},lose:()=>{lose=true;},
      close:async()=>{clients.forEach(client=>client.close());server.closeAllConnections();await new Promise(r=>server.close(r));await f.db.close();}};
  }catch(error){clients.forEach(client=>client.close());if(server.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}await f.db.close();throw error;}
}
const authority=/身份|连接|authority|Authorization changed/;
const outcome=p=>p.then(value=>({value}),error=>({error}));

test('original local-read and Consent-return boundaries reject same-owner reconnect without Project dispatch',async()=>{
  for(const stage of ['local-read','consent-return']){
    const h=await fixture(),entered=deferred(),release=deferred();try{
      const original=h.runtime.api.snapshot();let client,settled;
      if(stage==='local-read'){
        let blocked=false;h.get(async key=>{if(!blocked&&key.includes('m10-operations:')){blocked=true;entered.resolve();await release.promise;}});
        client=getProjectContactClient(h.runtime,h.subjectId);const running=outcome(client.submit('project',h.input,{confirmed:true}));
        await entered.promise;await h.runtime.connect({confirmed:true});release.resolve();settled=await running;
        assert.deepEqual(h.writes,[]);
      }else{
        let changed=false;const bridge={...h.runtime,api:{...h.runtime.api,authorizePayload:async(...args)=>{
          const result=await h.runtime.api.authorizePayload(...args);
          if(!changed){changed=true;await h.runtime.connect({confirmed:true});}return result;
        }}};
        client=getProjectContactClient(bridge,h.subjectId);settled=await outcome(client.submit('project',h.input,{confirmed:true}));
        assert.equal(h.writes.filter(p=>p==='/v1/consents').length,1);
        const pending=(await client.pending())[0];assert.equal(pending.operationId,h.input.operationId);assert.ok(pending.payloadHash);
        assert.equal(pending.state,'prepared');
      }
      assert.equal(h.runtime.api.snapshot().subjectId,original.subjectId);assert.notEqual(h.runtime.api.snapshot().bindingId,original.bindingId);
      assert.ok(h.runtime.api.snapshot().generation>original.generation);
      assert.match(settled.error?.message??'unexpected success',authority);
      assert.equal(h.writes.filter(p=>p==='/v2/projects').length,0);assert.equal((await h.rows()).length,0);
    }finally{release.resolve();await h.close();}
  }
});

test('queued confirmation keeps its enqueue connection and selected input; hash completion also checks original lease',async()=>{
  const h=await fixture(),entered=deferred(),release=deferred();try{
    let blocked=false;h.get(async key=>{if(!blocked&&key.includes('m10-operations:')){blocked=true;entered.resolve();await release.promise;}});
    const client=getProjectContactClient(h.runtime,h.subjectId),first=outcome(client.reconcile(randomUUID()));
    await entered.promise;const second=outcome(client.submit('project',h.input,{confirmed:true}));
    h.input.document.summary='LATER mutable input must not become the selected draft';
    await h.runtime.connect({confirmed:true});release.resolve();
    for(const r of await Promise.all([first,second]))assert.match(r.error?.message??'unexpected success',authority);
    assert.deepEqual(h.writes,[]);assert.equal((await h.rows()).length,0);
    h.get(null);
    const originalDigest=Reflect.get(crypto.subtle,'digest');let changed=false;
    try{
      crypto.subtle.digest=async function(...args){const result=await originalDigest.apply(this,args);
        if(!changed&&new TextDecoder().decode(args[1]).includes(h.input.operationId)){changed=true;await h.runtime.connect({confirmed:true});}
        return result;
      };
      const hashed=await outcome(client.submit('project',h.input,{confirmed:true}));
      assert.equal(changed,true);assert.match(hashed.error?.message??'unexpected success',authority);
      assert.deepEqual(h.writes,[]);assert.equal((await h.rows()).length,0);
    }finally{crypto.subtle.digest=originalDigest;}
  }finally{release.resolve();await h.close();}
});

test('actual committed lost ACK stays original across reconnect; readonly query does not resend and explicit retry preserves exact Consent/bytes',async()=>{
  const h=await fixture();try{
    const client=getProjectContactClient(h.runtime,h.subjectId);h.lose();
    await assert.rejects(client.submit('project',h.input,{confirmed:true}),e=>e.resultUnknown===true);
    const row=(await h.rows())[0],pending=(await client.pending())[0];
    assert.equal(row.operation_id,h.input.operationId);assert.equal(row.payload_hash,pending.payloadHash);
    await h.runtime.connect({confirmed:true});const counts=[...h.writes];
    const query=await client.reconcile(pending.operationId);
    assert.equal(query.state,'exact-receipt-unconfirmed');assert.equal(query.current.projectId,h.input.projectId);
    assert.deepEqual(h.writes,counts);assert.equal((await client.pending())[0].operationId,pending.operationId);
    const replay=await client.reconcile(pending.operationId,{retry:true,confirmed:true});
    assert.equal(replay.replayed,true);assert.deepEqual(await h.rows(),[row]);
    assert.equal(h.writes.filter(p=>p==='/v1/consents').length,1,'original accepted operation never gets another Consent');
    assert.equal((await client.pending()).length,0);
    const after=[...h.writes],remembered=await client.reconcile(pending.operationId,{retry:true,confirmed:true});
    assert.equal(remembered.state,'acknowledged');assert.deepEqual(h.writes,after);
    const terminal=[...h.data.values()].filter(Array.isArray).flat().find(x=>x.operationId===pending.operationId);
    assert.equal(terminal.payloadJson,undefined);assert.equal(terminal.submission,undefined);
    assert.equal(terminal.payloadHash,row.payload_hash);assert.equal(terminal.consentId,row.consent_id);
  }finally{await h.close();}
});

test('acknowledgement journal completion after real owner change keeps only original-owner body-free locator and withholds old UI result',async()=>{
  const h=await fixture();try{
    const other=await h.other(),recovery=await other.prepareRecovery();await other.saveRecovery({operationId:recovery.operationId,confirmed:true});
    const nextOwner=other.api.snapshot().subjectId;
    let changed=false;h.put(async(key,value)=>{
      if(!changed&&key.includes('m10-operations:')&&Array.isArray(value)&&value.some(x=>x.state==='acknowledged')){
        changed=true;const recovered=await h.runtime.recover(recovery.code,{confirmed:true});await h.runtime.confirmRecoveredCode({operationId:recovered.operationId,confirmed:true});
        await h.runtime.connect({confirmed:true});
      }
    });
    const client=getProjectContactClient(h.runtime,h.subjectId),settled=await outcome(client.submit('project',h.input,{confirmed:true}));
    assert.equal(changed,true);assert.match(settled.error?.message??'unexpected success',authority);
    assert.notEqual(h.runtime.api.snapshot().subjectId,h.subjectId);
    assert.equal(h.runtime.api.snapshot().subjectId,nextOwner);
    await assert.rejects(client.pending(),authority);
    const next=getProjectContactClient(h.runtime,h.runtime.api.snapshot().subjectId);assert.deepEqual(await next.pending(),[]);
    const old=[...h.data.entries()].find(([key,value])=>key.includes(h.subjectId)&&Array.isArray(value)&&value.some(x=>x.operationId===h.input.operationId));
    assert.ok(old);const saved=old[1].find(x=>x.operationId===h.input.operationId);
    assert.equal(saved.state,'acknowledged');assert.equal(saved.subjectId,h.subjectId);assert.equal(saved.payloadJson,undefined);
    assert.equal(saved.submission,undefined);assert.equal(JSON.stringify(saved).includes('PRIVATE FICTIONAL'),false);
    assert.equal((await h.rows()).length,1);assert.equal(h.writes.filter(p=>p==='/v2/projects').length,1);
  }finally{await h.close();}
});

test('automatic Project resume reuses an accepted Consent for absent and lost-ACK operations without any new authorization',async()=>{
  const h=await fixture();try{
    let interrupted=true,signs=0;
    const bridge={...h.runtime,api:{...h.runtime.api,authorizePayload:async(...args)=>{signs++;return h.runtime.api.authorizePayload(...args);},
      call:async(path,...args)=>{if(path==='/v2/projects'&&interrupted){interrupted=false;throw Error('Synthetic stop before Project HTTP');}return h.runtime.api.call(path,...args);}}};
    const client=getProjectContactClient(bridge,h.subjectId);
    await assert.rejects(client.submit('project',h.input,{confirmed:true}),/before Project HTTP/);
    assert.equal((await h.rows()).length,0);assert.equal(signs,1);
    const original=[...h.data.values()].filter(Array.isArray).flat().find(row=>row.operationId===h.input.operationId);
    assert.ok(original.submission.consentId);
    const preview=await client.reviewPending(h.input.operationId);
    assert.equal(preview.payload.document.summary,h.input.document.summary);assert.equal(preview.authorization,'original-consent');
    await h.runtime.connect({confirmed:true});
    assert.equal((await client.resumePending(h.input.operationId)).state,'acknowledged');
    assert.equal(signs,1);assert.equal(h.writes.filter(path=>path==='/v1/consents').length,1);
    assert.equal((await h.rows())[0].consent_id,original.submission.consentId);
    const before=[...h.writes];assert.equal((await client.resumePending(h.input.operationId)).state,'acknowledged');assert.deepEqual(h.writes,before);
    const next={...h.input,projectId:randomUUID(),operationId:randomUUID()};h.lose();
    await assert.rejects(client.submit('project',next,{confirmed:true}),error=>error.resultUnknown===true);
    const accepted=(await h.f.db.query('SELECT operation_id,consent_id,payload_text,payload_hash FROM project_events_v2 WHERE project_id=$1',[next.projectId])).rows;
    await h.runtime.connect({confirmed:true});assert.equal((await client.resumePending(next.operationId)).state,'acknowledged');
    assert.deepEqual((await h.f.db.query('SELECT operation_id,consent_id,payload_text,payload_hash FROM project_events_v2 WHERE project_id=$1',[next.projectId])).rows,accepted);
    assert.equal(signs,2);assert.equal(h.writes.filter(path=>path==='/v1/consents').length,2);
  }finally{await h.close();}
});

test('automatic Project resume retains unsigned and explicitly stopped originals with zero Consent or business writes',async()=>{
  const h=await fixture();try{
    let signs=0;const bridge={...h.runtime,api:{...h.runtime.api,authorizePayload:async()=>{signs++;throw Error('Synthetic signing interrupted');}}},
      client=getProjectContactClient(bridge,h.subjectId);
    await assert.rejects(client.submit('project',h.input,{confirmed:true}),/signing interrupted/);
    const original=await client.reviewPending(h.input.operationId);
    assert.equal(original.hasSubmission,false);assert.equal(original.authorization,'review-required');
    await h.runtime.connect({confirmed:true});
    assert.equal((await client.resumePending(h.input.operationId)).reason,'authorization-review-required');
    assert.equal(signs,1);assert.deepEqual(h.writes,[]);assert.equal((await h.rows()).length,0);
    const key=[...h.data.keys()].find(key=>key.includes('m10-operations:'));
    h.data.set(key,h.data.get(key).map(row=>({...row,state:'stopped-local'})));
    assert.equal((await client.resumePending(h.input.operationId)).state,'stopped-local');
    assert.equal((await client.reviewPending(h.input.operationId)).payload.document.summary,h.input.document.summary);
    assert.equal(signs,1);assert.deepEqual(h.writes,[]);
  }finally{await h.close();}
});

test('Contact pending recovery uses real BrowserClient/OIDC facts and rejects old connection before any original replay',async()=>{
  // Reuse existing actual local OIDC/Account/quota workflow once. The seeded
  // legacy pending row is a retained exact accepted Contact envelope fixture;
  // this is not another physical lost-network-ACK experiment.
  await verifyContactsV2(null,{afterWorkflow:async({p,contact,contactAcceptance})=>{
    const scopes=p.actor.scopes,deviceId=randomUUID(),publicKey=p.genesis.genesisProof.publicKeyPem;
    const upgrade={version:2,operationId:randomUUID(),subjectId:p.actor.subjectId,kind:'bootstrap',expectedEpoch:0,
      previousEventHash:null,signerKeyId:digest(publicKey),genesisProof:p.genesis.genesisProof,
      newDevice:{deviceId,publicKeyPem:publicKey,scopes:['manage-identity',...scopes]}};
    const challenge=await p.identityControl.challenge(upgrade),signature=await p.signForTest(challenge.challenge,'galaxy-identity-control-v2+jws');
    await p.identityControl.commit({operationId:upgrade.operationId,controllerSignature:signature,newDeviceProof:signature});
    const server=createApi({...p,rateLimit:1000}),memory=new Map(),writes=[];let api,onGet;
    try{
      await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
      api=createBrowserClient({endpoint:p.access.endpoint,trustedKeys:p.bindings.trustedKeys,now:()=>p.now,sign:p.signForTest,
        fetch:async(url,options)=>{const path=new URL(url).pathname;if(path==='/v2/contacts'||path==='/v1/consents')writes.push(path);return fetch(origin+path,options);}});
      const connect=()=>api.connect({subjectId:p.actor.subjectId,genesisProof:p.genesis.genesisProof,installationId:randomUUID(),scopes,
        control:{deviceId,keyId:digest(publicKey),epoch:1}},{confirmed:true});await connect();
      const row=(await p.db.query('SELECT consent_id,payload_text,payload_hash FROM contact_events_v2 WHERE operation_id=$1',[contactAcceptance.operationId])).rows[0];
      const pending={type:'contact',objectId:contact.contactId,operationId:contactAcceptance.operationId,payloadJson:row.payload_text,
        visibility:'Private',viewers:[contact.opportunityRef.subjectId],state:'result-unknown',attempts:1,
        submission:{consentId:row.consent_id,payloadJson:row.payload_text}};
      const key='m10-operations:'+p.actor.subjectId;memory.set(key,[structuredClone(pending)]);
      const runtime={api,getLocal:async name=>{const v=structuredClone(memory.get(name));await onGet?.();return v;},
        putLocal:async(name,value)=>memory.set(name,structuredClone(value))},client=getProjectContactClient(runtime,p.actor.subjectId);
      let changed=false;onGet=async()=>{if(!changed){changed=true;await connect();}};
      await assert.rejects(client.reconcile(pending.operationId,{retry:true,confirmed:true}),authority);
      assert.deepEqual(writes,[]);assert.deepEqual(memory.get(key),[pending],'legacy exact bytes/signature stay intact on old lease rejection');
      onGet=null;const queried=await client.reconcile(pending.operationId);
      assert.equal(queried.state,'exact-receipt-unconfirmed');assert.equal(queried.current.contactId,contact.contactId);
      assert.deepEqual(writes,[]);assert.equal(memory.get(key)[0].payloadHash,row.payload_hash);
      const replay=await client.reconcile(pending.operationId,{retry:true,confirmed:true});
      assert.equal(replay.replayed,true);assert.equal(replay.operationId,pending.operationId);
      assert.deepEqual(writes,['/v2/contacts']);assert.deepEqual(await client.pending(),[]);
      const saved=memory.get(key)[0];assert.equal(saved.state,'acknowledged');assert.equal(saved.payloadHash,row.payload_hash);
      assert.equal(saved.payloadJson,undefined);assert.equal(saved.consentId,row.consent_id);
      assert.equal(Number((await p.db.query('SELECT count(*) FROM contact_events_v2 WHERE operation_id=$1',[pending.operationId])).rows[0].count),1);
    }finally{api?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
  }});
});
