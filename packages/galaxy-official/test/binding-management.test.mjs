import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { verifyBindingManagement } from './binding-management-workflow.mjs';
import { createBindingManagementClient } from '../src/binding-status-client.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { serviceFixture } from './service-fixture.mjs';

test('binding management lists software installations and revokes selected sessions through the real API',()=>verifyBindingManagement());

test('stored public-key conflicts do not consume a binding challenge and revocation stays within the selected endpoint',async()=>{
  const f=await serviceFixture(['binding']);
  try{
    const request={subjectId:f.genesis.id,genesisProof:f.genesis.genesisProof,installationId:randomUUID(),scopes:['binding']};
    const challenge=await f.bindings.challenge(request),input={challenge:challenge.challenge,clientSession:challenge.clientSession,
      signature:await f.signForTest(challenge.challenge,'galaxy-binding-response+jws')};
    await f.db.query('UPDATE subjects SET public_key=$1 WHERE id=$2',['conflicting stored key',f.genesis.id]);
    await assert.rejects(f.bindings.bind(input),/identity_conflict/);
    assert.equal((await f.db.query('SELECT consumed_at FROM binding_challenges WHERE id=$1',[challenge.challengeId])).rows[0].consumed_at,null);
    await f.db.query('UPDATE subjects SET public_key=$1 WHERE id=$2',[f.genesis.genesisProof.publicKeyPem,f.genesis.id]);
    const bound=await f.bindings.bind(input);
    await f.db.query('UPDATE bindings SET audience=$1 WHERE id=$2',['https://another.example.org',bound.bindingId]);
    assert.equal((await f.bindings.query(f.actor,{bindingId:bound.bindingId})).items.length,0);
    await assert.rejects(f.bindings.revoke(bound.bindingId,f.actor.subjectId,randomUUID(),null,f.actor),/not_found/);
    assert.equal((await f.db.query('SELECT revoked_at FROM bindings WHERE id=$1',[bound.bindingId])).rows[0].revoked_at,null);
  }finally{await f.db.close();}
});

test('pending revocation is bound to one local session and a canceled or late self-revocation cannot clear its replacement',async()=>{
  const endpoint='https://official.example.org',now=2000000000;
  for(const situation of ['before-send','late-success','late-failure','cancel']){
    const sessions=createSessionMemory({now:()=>now,isCurrent:async()=>true});
    const adopt=()=>{const id=randomUUID();sessions.adopt({endpoint,subjectId:'GUID'+'A'.repeat(28),bindingId:id,scopes:['binding'],expiresAt:now+500,
      bindingExpiresAt:now+900,takeCredential:()=>randomBytes(32).toString('base64url')});return id;};
    const id=adopt();let release,fail,started=false,writes=0;
    const send=async(url)=>{
      if(url.endsWith('/query'))return {subjectId:'GUID'+'A'.repeat(28),currentBindingId:id,checkedAt:now,nextAfter:null,items:[{
        bindingId:id,installationId:randomUUID(),scopes:['binding'],state:'active',createdAt:new Date(now*1000).toISOString(),expiresAt:new Date((now+900)*1000).toISOString(),revokedAt:null}]};
      writes++;started=true;return new Promise((resolve,reject)=>{release=resolve;fail=reject;});
    };
    const client=createBindingManagementClient({endpoint,sessions,send}),preview=await client.prepareRevoke(id);
    if(situation==='before-send'){adopt();await assert.rejects(client.executeRevoke(preview,preview.confirmation),/authorization/);assert.equal(writes,0);continue;}
    const pending=client.executeRevoke(preview,preview.confirmation);const rejected=assert.rejects(pending);
    while(!started)await new Promise(resolve=>setTimeout(resolve,1));
    const replacement=adopt();
    if(situation==='cancel')client.cancel(preview);
    if(situation==='late-failure')fail(new Error('Disconnected'));else release({bindingId:id,state:'revoked'});
    await rejected;assert.equal((await sessions.readAuthorization(endpoint)).bindingId,replacement);assert.equal(writes,1);
  }
});
