import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { HonorService } from "../src/records/honor.mjs";
import { createApi } from '../src/http.mjs';
import { createHonorClient } from "../src/clients/honor.mjs";
import { createHostConnectionController } from "../src/clients/flows/host-connection-controller.mjs";
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { recordRuntimeConfig,runtimeConfigSnapshot,verifyRuntimeConfigEvent } from '../src/operations/runtime-config-audit.mjs';
import { approveFixtureDeletion } from './deletion-execute-workflow.mjs';
import { executeDeletion } from '../src/operations/deletion-execute.mjs';

export async function verifyHonorRegistry(db=null,options={}){
  const endpoint=`https://honor-${randomUUID()}.example.org`,scopes=['binding','consent','history','case-teaser','assistance','data-delete'];
  const fixtureOptions={...options,endpoint},f=await serviceFixture(scopes,db,fixtureOptions);
  const p=await serviceFixture(scopes,f.db,fixtureOptions);
  const rule={id:'open-helper',version:'1',title:'Synthetic open contributor',kind:'open-contributor',capabilityId:'compiler',communityId:'fixture',
    members:[f.actor.subjectId,p.actor.subjectId],relatedPartyGroups:[[f.actor.subjectId,p.actor.subjectId]],
    notBefore:f.now-1,notAfter:f.now+1000,windowFrom:f.now-100,windowUntil:f.now+100,minAcceptedCases:1,minProofs:0,
    repositories:[{owner:'Fixture',repository:'Example'}],rankingEnabled:false};
  const input=rules=>({id:randomUUID(),endpoint,component:'api',operatorRef:'synthetic-operator',honorRules:rules,
    snapshot:runtimeConfigSnapshot({governance:{honorRules:rules}})});
  const record=rules=>recordRuntimeConfig(f.db,input(rules));
  const api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`,requests=[];
  const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});
  sessions.adopt({endpoint,subjectId:p.actor.subjectId,bindingId:p.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>p.credential});
  const send=async(url,request)=>{
    requests.push({path:new URL(url).pathname,credential:request.credential,body:JSON.parse(request.bodyJson)});
    const response=await fetch(origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',...(request.credential?{Authorization:`Bearer ${request.credential}`}:{})},body:request.bodyJson,signal:request.signal});
    const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;
  };
  const client=createHonorClient({endpoint,sessions,send}),host=createHostConnectionController({endpoint,sessions,honorClient:client});
  const query={ruleId:rule.id,ruleVersion:'1'};
  try{
    const firstInput=input([rule]),first=await recordRuntimeConfig(f.db,firstInput);
    assert.equal((await recordRuntimeConfig(f.db,firstInput)).event_hash,first.event_hash);
    await f.honor.useRegistry();
    assert.equal((await host.honorRules()).ruleHistorySupported,true);
    let page=await host.honorRuleHistory({limit:1});assert.equal(page.items.length,1);assert.equal(page.nextAfter,null);
    const originalHash=page.items[0].registry.definitionHash;
    assert.equal(page.items[0].registry.introducedConfigurationId,first.id);
    assert.ok(!JSON.stringify(page).includes(f.actor.subjectId));assert.ok(!JSON.stringify(page).includes('relatedPartyGroups'));
    assert.equal(requests.at(-1).credential,undefined);assert.deepEqual(requests.at(-1).body,{after:0,limit:1});
    // Real accepted work makes revocation/removal observable on an earned current card.
    const root={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Synthetic registry work',summary:'Fixture',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(root));
    const attempt={id:randomUUID(),kind:'attempt',caseId:root.id,expectedVersion:1,sequence:1,approach:'Inspect',configuration:{environment:'test',version:'1',tools:[]}};
    await f.cases.submit(f.actor,await f.authorize(attempt));
    const request={id:randomUUID(),caseId:root.id,title:'Compiler help',problem:'Fixture',attemptedApproaches:[],scope:'Inspect',visibility:'Public',collaboration:'open-assistance',capabilityId:'compiler',enrollmentExpiresAt:f.now+800};
    await f.assistance.create(f.actor,await f.authorize(request,'assistance.publish',{visibility:'Public',purpose:'public-profile'}));
    let version=1;
    async function event(who,kind,fields={}){
      const ev={id:randomUUID(),expectedVersion:version,kind,...fields};
      const grant=await who.authorize({assistanceId:request.id,event:ev},'assistance.publish',{objectId:ev.id,viewers:[who===f?p.actor.subjectId:f.actor.subjectId]});
      version=(await f.assistance.submit(who.actor,request.id,grant)).version;return ev;
    }
    const offer=await event(p,'offer',{proposal:'Inspect',scope:'Inspect'});await event(f,'select',{offerId:offer.id});await event(p,'confirm');
    const delivery=await event(p,'deliver',{attemptId:attempt.id,evidenceIds:[],summary:'Resolved'});await event(f,'accept',{deliveryId:delivery.id,summary:'Accepted'});
    const active=(await host.getHonor(query)).card;assert.equal(active.status,'active');assert.equal(active.acceptedCases,1);
    assert.equal(active.capabilityVerified,false);assert.equal(active.registry.definitionHash,originalHash);
    // Equivalent unordered sets and repository casing preserve the definition.
    await record([{...rule,members:[...rule.members].reverse(),relatedPartyGroups:[[...rule.members].reverse()],repositories:[{owner:'fixture',repository:'example'}]}]);
    assert.equal((await host.getHonor(query)).card.registry.definitionHash,originalHash);
    const conflicting=input([{...rule,minAcceptedCases:2}]);
    await assert.rejects(recordRuntimeConfig(f.db,conflicting),/publish a new version/);
    for(const [table,column] of [['runtime_config_events','id'],['audit_events','request_id']])assert.equal((await f.db.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`,[conflicting.id])).rows.length,0);
    const next={...rule,version:'2',minAcceptedCases:2,rankingEnabled:true,privacyReview:'approved',windowUntil:f.now-1};await record([rule,next]);
    page=await host.honorRuleHistory({ruleId:rule.id,limit:1});assert.ok(page.nextAfter>0);assert.equal(page.items[0].rule.version,'1');
    const second=await host.honorRuleHistory({ruleId:rule.id,after:page.nextAfter,limit:1});assert.equal(second.items[0].rule.version,'2');assert.equal(second.nextAfter,null);
    assert.equal((await host.getHonor({...query,ruleVersion:'2'})).card.status,'insufficient-evidence');
    await record([{...rule,revoked:true},next]);
    const revoked=(await host.getHonor(query)).card;assert.equal(revoked.status,'inactive-rule');assert.equal(revoked.id,active.id);assert.equal(revoked.registry.revoked,true);
    await record([]);assert.deepEqual((await host.honorRules()).rules,[]);
    const removed=(await host.getHonor(query)).card;assert.equal(removed.status,'inactive-rule');assert.equal(removed.registry.configured,false);assert.equal(removed.registry.revoked,true);
    page=await host.honorRuleHistory({});assert.equal(page.items.length,2);assert.ok(page.items.every(item=>!item.registry.configured));
    assert.equal((await host.honorRanking({...query,ruleVersion:'2'})).reason,'rule-inactive-or-window-open');
    // Reconstructed services use the retained registry, without source configuration in memory.
    const restarted=new HonorService(f.access,f.assistance,f.proofs);await restarted.useRegistry();
    assert.equal((await restarted.ruleHistory()).items.length,2);
    await record([rule]);assert.equal((await restarted.query(p.actor,{...query,subjectId:p.actor.subjectId})).card.status,'active');
    await assert.rejects(recordRuntimeConfig(f.db,{...input([]),honorRules:undefined}),/memory-only/);
    await assert.rejects(recordRuntimeConfig(f.db,{...input([rule]),honorRules:[next]}),/do not match/);
    const other=new HonorService({db:f.db,endpoint:'https://another.example.org'},f.assistance,f.proofs);await assert.rejects(other.useRegistry(),/unavailable/);
    if(options.concurrent){
      const outcomes=await Promise.allSettled([record([{...rule,version:'3',minAcceptedCases:3}]),record([{...rule,version:'3',minAcceptedCases:4}])]);
      assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);assert.equal(outcomes.filter(item=>item.status==='rejected').length,1);
    }
    const events=(await f.db.query("SELECT * FROM runtime_config_events WHERE endpoint=$1 AND component='api' ORDER BY sequence",[endpoint])).rows;
    events.forEach(verifyRuntimeConfigEvent);
    assert.equal(Number((await f.db.query("SELECT count(*) FROM audit_events WHERE audience=$1 AND action='runtime.config.observe'",[endpoint])).rows[0].count),events.length);
    const admin=options.adminDatabase??f.db,command=await approveFixtureDeletion(p,admin);
    const deletion=await executeDeletion(admin,command,{now:()=>f.now});
    assert.equal(deletion.operatorPolicies.honorRuleVersions,options.concurrent?3:2);assert.equal(deletion.operatorPolicies.cleanupImplemented,false);
    assert.equal(deletion.serviceWideDeletionComplete,false);
    assert.equal((await f.honor.ruleHistory()).items.find(item=>item.rule.version==='1').registry.definitionHash,originalHash);
    const databaseTables=Number((await f.db.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count);
    const schema=Number((await f.db.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version);
    return {schema,databaseTables,immutableVersions:true,atomicConfigHistory:true,currentCardRevocation:true,retainedRemovedRules:true,reconstructedService:true,publicDefinitionOnly:true,deletionReferencesReported:true,concurrentVersionConflict:options.concurrent??false};
  }finally{host.cancel();sessions.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!db)await f.db.close();}
}
