import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {builderDeclaration} from './builders-workflow.mjs';
import {HubServiceV2} from "../src/network/hubs-v2.mjs";


import {sampleCharter} from './hubs-workflow.mjs';

test('Hub exact Charter and member scope have real signed consent, current source and private intake boundaries',async()=>{
  const scopes=['binding','consent','builders'],f=await serviceFixture(scopes,null,{now:Math.floor(Date.now()/1000)});
  try{
    // Migration68 is exercised through the real fixture migration runner.
    const member=await serviceFixture(scopes,f.db,{now:f.now}),stranger=await serviceFixture(scopes,f.db,{now:f.now}),hubs=new HubServiceV2(f.access,f.consents,f.builders);
    const publicGrant={visibility:'Public',purpose:'public-profile'},hubId=randomUUID(),declaration={id:randomUUID(),builderId:hubId,kind:'declare',expectedRevision:0,declaration:builderDeclaration('hub',f.actor.subjectId)};
    await f.builders.publish(f.actor,await f.authorize(declaration,'builder.publish',publicGrant));
    const d=await f.builders.get(f.actor,{builderId:hubId}),charter={schemaVersion:2,id:randomUUID(),kind:'charter',hubId,expectedVersion:0,declarationId:d.declarationId,declarationHash:d.declarationHash,charter:sampleCharter(f.now)};
    const write=async(who,e,g={})=>{const auth=await who.authorize(e,'hub.publish',g);return{auth,receipt:await hubs.submit(who.actor,auth)};};
    const published=await write(f,charter,publicGrant);assert.equal(published.receipt.version,1);
    assert.deepEqual(await hubs.submit(f.actor,published.auth),published.receipt);
    const view=await hubs.get(null,{hubId});assert.equal(view.state,'active');assert.equal(view.autonomousDomainVerified,false);assert.equal(view.claims.conformance.currentState,'unknown');
    assert.deepEqual(view.availableActions,[],'public reading does not invent authenticated actions');
    assert.ok((await hubs.manage(f.actor,{hubId})).availableActions.includes('invite'));
    assert.deepEqual((await hubs.get(member.actor,{hubId})).availableActions,['intake-open']);
    assert.equal((await hubs.query(null)).items.length,1);
    await assert.rejects(write(stranger,{...charter,id:randomUUID(),expectedVersion:1},publicGrant),/hub_operator_required/);
    const membershipId=randomUUID(),invitation={schemaVersion:2,id:randomUUID(),kind:'invite',hubId,membershipId,memberId:member.actor.subjectId,expectedVersion:0,charterVersion:1,scopes:['approved-proof-query'],expiresAt:f.now+500};
    const invited=await write(f,invitation,{viewers:[member.actor.subjectId]});
    assert.equal((await hubs.members(member.actor,{hubId})).items[0].authorization,'awaiting-member-confirmation');
    assert.deepEqual((await hubs.members(member.actor,{hubId})).items[0].availableActions,['accept','decline']);
    assert.deepEqual((await hubs.members(f.actor,{hubId})).items[0].availableActions,['remove']);
    assert.equal((await hubs.members(stranger.actor,{hubId})).items.length,0);
    const accept={schemaVersion:2,id:randomUUID(),kind:'accept',hubId,membershipId,expectedVersion:1,charterVersion:1,acceptedScopes:['member-updates']};
    await assert.rejects(write(member,accept,{viewers:[f.actor.subjectId]}),/hub_scope_expansion/);
    const accepted=await write(member,{...accept,id:randomUUID(),acceptedScopes:['approved-proof-query']},{viewers:[f.actor.subjectId]});
    assert.equal(accepted.receipt.version,2);assert.equal((await hubs.members(member.actor,{hubId})).items[0].authorization,'active');
    assert.ok((await hubs.get(member.actor,{hubId})).availableActions.includes('peering-query'));
    await f.access.runAuthorized(member.actor,'builders',db=>hubs.requireMemberWithin(db,member.actor,hubId,'approved-proof-query'));
    await assert.rejects(f.access.runAuthorized(member.actor,'builders',db=>hubs.requireMemberWithin(db,member.actor,hubId,'member-updates')),/hub_scope_unavailable/);
    const changed=await write(f,{...charter,id:randomUUID(),expectedVersion:1,charter:{...charter.charter,name:'Updated synthetic Charter'}},publicGrant);
    assert.equal((await hubs.members(member.actor,{hubId})).items[0].authorization,'charter-reconfirmation-required');
    assert.ok(!(await hubs.get(member.actor,{hubId})).availableActions.includes('peering-query'),'new Charter does not reuse an old member scope');
    assert.deepEqual((await hubs.members(member.actor,{hubId})).items[0].availableActions,['exit'],'leaving remains available when reconfirmation is required');
    assert.equal((await hubs.get(null,{hubId,version:1})).state,'historical-version');
    await f.consents.revoke(f.actor,changed.auth.consentId);
    await assert.rejects(hubs.get(null,{hubId}),/hub_unavailable/,'revoked latest Charter never falls back to an old public version');
    const exit={schemaVersion:2,id:randomUUID(),kind:'exit',hubId,membershipId,expectedVersion:2,charterVersion:1};
    await write(member,exit,{viewers:[f.actor.subjectId]});assert.equal((await hubs.members(member.actor,{hubId})).items[0].state,'exited');
    assert.ok((await f.db.query('SELECT id FROM subjects WHERE id=$1',[member.actor.subjectId])).rows.length,'membership exit preserves the Galaxy identity');
    const third=await write(f,{...charter,id:randomUUID(),expectedVersion:2},publicGrant);
    const threadId=randomUUID(),open={schemaVersion:2,id:randomUUID(),hubId,kind:'intake-open',threadId,title:'Private synthetic question',text:'Selected private concern'};
    await write(stranger,open,{viewers:[f.actor.subjectId]});
    assert.equal((await hubs.intake(member.actor,{hubId,threadId})).items.length,0);
    assert.equal((await hubs.intake(f.actor,{hubId,threadId})).items[0].messages[0].text,open.text);
    await write(f,{schemaVersion:2,id:randomUUID(),hubId,kind:'intake-reply',threadId,expectedVersion:1,text:'Operator actually replied'},{viewers:[stranger.actor.subjectId]});
    assert.equal((await hubs.intake(stranger.actor,{hubId,threadId})).items[0].messages.length,2);
    assert.equal((await hubs.receipt(member.actor,{operationId:third.receipt.operationId,payloadHash:third.receipt.payloadHash})).state,'absent');
    await f.consents.revoke(f.actor,invited.auth.consentId);assert.equal((await hubs.members(member.actor,{hubId})).items[0].authorization,'inactive');
    await f.db.query('UPDATE hub_intake_v2 SET expires_at=$2 WHERE id=$1',[threadId,f.now-1]);await hubs.purgeExpired();
    assert.ok((await hubs.intake(stranger.actor,{hubId,threadId})).items[0].messages.every(m=>!m.contentAvailable&&!m.text));
    assert.deepEqual((await hubs.intake(stranger.actor,{hubId,threadId})).items[0].availableActions,[]);
  }finally{await f.db.close();}
});
