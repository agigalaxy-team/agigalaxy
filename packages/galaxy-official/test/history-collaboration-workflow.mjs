import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { compareHistoryRebuilds } from '../src/shared/history-rebuild.mjs';

export async function verifyHistoryCollaboration(database=null,options={}){
  const scopes=['binding','consent','case-teaser','history','assistance'];
  const f=await serviceFixture(scopes,database,options);
  const p=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false});
  const outsider=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false});
  try{
    const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'Linked requirements',summary:'Synthetic collaboration history',
      source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    const publicGrant={visibility:'Public',purpose:'public-profile'};
    await f.cases.submit(f.actor,await f.authorize(root,'case.teaser.publish',publicGrant));
    const query=async actor=>(await f.history.query(actor,{subjectId:f.actor.subjectId})).items.find(item=>item.caseId===root.id);
    const request={id:randomUUID(),caseId:root.id,title:'Compiler help',problem:'Fixture',attemptedApproaches:[],scope:'Inspect',
      visibility:'Public',collaboration:'open-assistance',capabilityId:'compiler',enrollmentExpiresAt:f.now+800};
    const rootGrant=await f.authorize(request,'assistance.publish',publicGrant);
    await f.assistance.create(f.actor,rootGrant);
    const before=await query(null);
    assert.equal(before.rebuild.rule.version,4);
    assert.deepEqual(before.collaborationContext.capabilityIds,['compiler']);
    assert.deepEqual(before.collaborationContext.items[0].participantLinks,[]);
    const hidden={...request,id:randomUUID(),visibility:'Private',capabilityId:'hidden-skill'};
    await f.assistance.create(f.actor,await f.authorize(hidden,'assistance.publish'));
    assert.equal((await query(null)).rebuild.contentHash,before.rebuild.contentHash);
    let version=1;
    async function event(who,kind,fields={}){
      const ev={id:randomUUID(),expectedVersion:version,kind,...fields};
      const grant=await who.authorize({assistanceId:request.id,event:ev},'assistance.publish',
        {objectId:ev.id,viewers:[who===f?p.actor.subjectId:f.actor.subjectId]});
      version=(await f.assistance.submit(who.actor,request.id,grant)).version;
      return {ev,grant};
    }
    const offer=await event(p,'offer',{proposal:'Read logs',scope:'Inspect'});
    await event(f,'select',{offerId:offer.ev.id});
    const ownerBefore=await query(f.actor);
    assert.equal(ownerBefore.collaborationContext.items.find(item=>item.assistanceId===request.id).participantLinks.length,1);
    const confirmation=await event(p,'confirm');
    const owner=await query(f.actor),provider=await query(p.actor),publicView=await query(null);
    const link=owner.collaborationContext.items.find(item=>item.assistanceId===request.id);
    assert.equal(link.attribution,'requester-declared-requirement');
    assert.equal(link.capabilityVerified,false);
    assert.deepEqual(link.participantLinks.map(item=>item.role),['requester','provider']);
    assert.equal(link.participantLinks[1].eventId,confirmation.ev.id);
    assert.deepEqual(provider.collaborationContext.items[0].participantLinks.map(item=>item.subjectId),[p.actor.subjectId]);
    assert.deepEqual((await query(outsider.actor)).collaborationContext.items[0].participantLinks,[]);
    assert.equal(publicView.rebuild.contentHash,before.rebuild.contentHash,'private activity must not change public fingerprint');
    assert.equal(compareHistoryRebuilds(ownerBefore.rebuild,owner.rebuild).state,'changed');
    await f.consents.revoke(p.actor,confirmation.grant.consentId);
    const revoked=await query(f.actor);
    assert.deepEqual(revoked.collaborationContext.items.find(item=>item.assistanceId===request.id).participantLinks.map(item=>item.role),['requester']);
    assert.ok(revoked.collaborationContext.capabilityIds.includes('compiler'));
    assert.equal((await query(null)).rebuild.contentHash,before.rebuild.contentHash);
    await f.consents.revoke(f.actor,rootGrant.consentId);
    const removed=await query(null);
    assert.deepEqual(removed.collaborationContext.items,[]);
    assert.deepEqual(compareHistoryRebuilds(before.rebuild,removed.rebuild).changes.assistance.removed,[request.id]);
    assert.equal(removed.sourceVersion,1);
    assert.deepEqual(removed.rebuild.sources.events.map(item=>item.id),[root.id]);
  }finally{if(!database)await f.db.close();}
}
