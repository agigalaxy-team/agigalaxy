import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {builderDeclaration} from './builders-workflow.mjs';
import {sampleCharter} from './hubs-workflow.mjs';
import {createApi} from '../src/http.mjs';
import {digest} from '../src/shared/digest.mjs';
import {postHubPeeringJson} from "../src/infrastructure/public-fetch.mjs";
import {createPeeringProof} from './hub-ci-proof-fixture.mjs';
import {samePeeringMaterial} from "../../galaxy-web/src/features/hubs/peering-material.mjs";
export const hubScopes=['binding','consent','builders','case-teaser','evidence','proof','history','data-export','data-delete'];
export async function prepareHub(f){const hubId=randomUUID(),d={id:randomUUID(),builderId:hubId,kind:'declare',expectedRevision:0,
  declaration:{...builderDeclaration('hub',f.actor.subjectId),endpoint:f.access.endpoint}};
  const pub={visibility:'Public',purpose:'public-profile'};await f.builders.publish(f.actor,await f.authorize(d,'builder.publish',pub));
  const record=await f.builders.get(f.actor,{builderId:hubId}),e={schemaVersion:2,id:randomUUID(),kind:'charter',hubId,expectedVersion:0,
    declarationId:record.declarationId,declarationHash:record.declarationHash,charter:sampleCharter(f.now)};
  await f.hubs.submit(f.actor,await f.authorize(e,'hub.publish',pub));return hubId;
}
export async function peeringWorkflow(database=null,options={}){
  const now=Math.floor(Date.now()/1000),a=await serviceFixture(hubScopes,database,{now,endpoint:'https://a.hub.example',...options}),
    b=await serviceFixture(hubScopes,null,{now,endpoint:'https://b.hub.example'});
  const apis=[];
  try{
    for(const f of[a,b]){const api=createApi(f);await new Promise(ok=>api.listen(0,'127.0.0.1',ok));apis.push(api);f.testAddress=`http://127.0.0.1:${api.address().port}`;}
    const call=async(f,path,input,who=f,status=200)=>{const response=await fetch(f.testAddress+path,{method:'POST',headers:{'Content-Type':'application/json',...(who?{Authorization:`Bearer ${who.credential}`}:{})},body:JSON.stringify(input)});
      const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;};
    const ah=await prepareHub(a),bh=await prepareHub(b);
    const pins=f=>[...f.access.trustedKeys].map(([kid,p])=>({kid,publicKeyPem:p.publicKeyPem,notBefore:p.notBefore,notAfter:p.notAfter}));
    const agreement={profile:'galaxy-direct-proof/1',id:randomUUID(),version:1,parties:[
      {endpoint:a.access.endpoint,hubId:ah,operatorId:a.actor.subjectId,keys:pins(a)},
      {endpoint:b.access.endpoint,hubId:bh,operatorId:b.actor.subjectId,keys:pins(b)}],sourceKinds:['contribution-summary','ci-proof-v2'],
      purpose:'help-discovery',ratePerMinute:60,pageSize:1,expiresAt:now+1800,responseMaxAgeSeconds:120,cache:'no-response-body-retention',route:'direct',officialProtocolFee:0,
      localEvaluationAuthority:'no-automatic-capability-upgrade',rawTaskContext:'excluded',intake:'each-party-hub-private-intake'};
    const approve=async(f,hubId)=>call(f,'/v2/hubs/peering/events',await f.authorize({schemaVersion:2,id:randomUUID(),kind:'peer-approve',hubId,expectedVersion:0,agreement},'hub.publish'));
    await approve(a,ah);
    // Real independent database/services and HTTP signatures; this loopback
    // routing is only an isolated synthetic transport, not an autonomous Hub.
    a.peering.send=async(url,{bodyJson})=>{assert.equal(url,b.access.endpoint+'/v2/hubs/peering/exchange');return call(b,'/v2/hubs/peering/exchange',JSON.parse(bodyJson),null);};
    const query=overrides=>call(a,'/v2/hubs/peering/query',{hubId:ah,agreementId:agreement.id,queryId:randomUUID(),...overrides});
    assert.equal((await query()).state,'unknown','local approval cannot fabricate remote approval');
    await approve(b,bh);
    assert.equal((await query()).remoteApproval,'verified-for-this-current-query');
    const rootId=randomUUID(),root={schemaVersion:2,eventId:rootId,caseId:rootId,kind:'case-created',expectedVersion:0,actorId:b.actor.subjectId,
      localRef:randomUUID(),title:'Private synthetic title',summary:'SECRET_CONTEXT_NOT_FOR_PEERING',source:{kind:'local',reference:randomUUID()},synthetic:true};
    const rootAuth=await b.authorize(root,'case.teaser.publish',{objectId:rootId});await b.cases.submitV2(b.actor,rootAuth);
    const intervention={schemaVersion:2,eventId:randomUUID(),caseId:rootId,kind:'intervention',expectedVersion:1,actorId:b.actor.subjectId,
      types:['diagnosis'],affectsAttemptIds:[],description:'PRIVATE DIAGNOSIS',sourceRefs:[],observedEffect:'Not a completed repair'};
    const factAuth=await b.authorize(intervention,'case.teaser.publish',{objectId:intervention.eventId});await b.cases.submitV2(b.actor,factAuth);
    const source={kind:'contribution-summary',source:{kind:'case-event',id:intervention.eventId,eventVersion:1,payloadHash:digest(factAuth.payloadJson)},fields:['eventType','actorId','interventionTypes']};
    const preview=await call(b,'/v2/hubs/peering/preview',{hubId:bh,agreementId:agreement.id,source});
    assert.ok((await call(b,'/v2/hubs/peering/sources',{hubId:bh,kind:'case-event',parentId:rootId})).items.some(i=>i.source.source.id===intervention.eventId));
    assert.equal(preview.projection.synthetic,true,'root synthetic state follows a child fact');assert.equal(preview.published,false);
    const originalNow=b.peering.now;b.peering.now=()=>now+1;
    let reread;try{reread=await call(b,'/v2/hubs/peering/preview',{hubId:bh,agreementId:agreement.id,source});}finally{b.peering.now=originalNow;}
    assert.notEqual(reread.projection.observedAt,preview.projection.observedAt,'a later read changes observation metadata');
    assert.equal(samePeeringMaterial(source,preview.projection,reread.projection),true,'the same exact authored fields remain confirmable');
    assert.equal(samePeeringMaterial(source,preview.projection,{...reread.projection,sourceObject:{...reread.projection.sourceObject,payloadHash:'changed'}}),false);
    assert.equal(samePeeringMaterial(source,preview.projection,{...reread.projection,projection:{...reread.projection.projection,interventionTypes:['patch']}}),false);
    assert.equal(samePeeringMaterial(source,preview.projection,{...reread.projection,subjectId:a.actor.subjectId}),false);
    const grant={schemaVersion:2,id:randomUUID(),hubId:bh,kind:'source-grant',agreementId:agreement.id,agreementVersion:1,source,requesterIds:[a.actor.subjectId],expiresAt:now+1000,
      purpose:'selected-peering-read-only',disclosure:'exact-proof-or-selected-nonnarrative-contribution-fields',redactionConfirmed:true};
    const signed=await b.authorize(grant,'hub.publish');await call(b,'/v2/hubs/peering/events',signed);
    const result=await query();assert.equal(result.items.length,1);assert.equal(result.items[0].state,'current');assert.equal(result.items[0].synthetic,true);
    assert.deepEqual(result.items[0].projection,{eventType:'intervention',actorId:b.actor.subjectId,interventionTypes:['diagnosis']});
    for(const secret of [rootId,root.title,root.summary,intervention.description])assert.equal(JSON.stringify(result).includes(secret),false);
    assert.equal(result.capabilityVerified,false);assert.equal(result.responseBodyPersisted,false);
    assert.equal((await b.db.query('SELECT response_hash FROM hub_peering_receipts_v2 WHERE side=$1',["incoming"])).rows.some(r=>r.response_hash),true);
    const receipt=await call(b,'/v2/hubs/peering/receipt',{operationId:grant.id,payloadHash:digest(signed.payloadJson)});assert.equal(receipt.state,'recorded');
    assert.equal((await call(b,'/v2/hubs/peering/list',{hubId:bh,kind:'grants'})).items[0].id,grant.id);
    const proof=await createPeeringProof(b,root,intervention),proofGrant={...grant,id:randomUUID(),source:proof.source};
    const proofPreview=await call(b,'/v2/hubs/peering/preview',{hubId:bh,agreementId:agreement.id,source:proof.source});
    assert.equal(samePeeringMaterial(proof.source,proofPreview.projection,{...proofPreview.projection,observedAt:proofPreview.projection.observedAt+1}),false,'CI observation time remains part of the exact signed claim');
    assert.equal((await call(b,'/v2/hubs/peering/sources',{hubId:bh,kind:'ci-proof-v2'})).items[0].source.id,proof.source.id);
    await call(b,'/v2/hubs/peering/events',await b.authorize(proofGrant,'hub.publish'));
    const proofPage=await query({after:result.nextCursor});assert.equal(proofPage.items[0].sourceObject.kind,'ci-proof-v2');
    assert.equal(proofPage.items[0].signed,proof.published.signed,'the original issuer envelope is preserved byte-for-byte');
    assert.equal(proofPage.sourceGroups[0].independentEvidenceAdded,0);assert.equal(proofPage.items[0].synthetic,true);
    await b.consents.revoke(b.actor,proof.evidenceAuth.consentId);
    const proofGone=await query({after:proofPage.nextCursor,recheck:[proofGrant.id]});assert.deepEqual(proofGone.items,[{grantId:proofGrant.id,state:'unavailable'}]);
    // A peer signature only authenticates its selected scope; not the source
    // author or another requester. Editing requester is rejected by signature.
    await call(a,'/v2/hubs/peering/query',{hubId:ah,agreementId:agreement.id,queryId:randomUUID(),requesterId:b.actor.subjectId},a,400);
    const qid=randomUUID();await query({queryId:qid});await call(a,'/v2/hubs/peering/query',{hubId:ah,agreementId:agreement.id,queryId:qid,after:999},a,409);
    await b.consents.revoke(b.actor,factAuth.consentId);
    const revoked=await query({after:proofGone.nextCursor+1,recheck:[grant.id]});assert.ok(revoked.items.some(i=>i.grantId===grant.id&&i.state==='unavailable'));
    // No old source body is reconstructed after erasure; no fallback to cached
    // signed response after offline or after current grant withdrawal.
    await b.db.query("UPDATE case_events SET payload_text='' WHERE id=$1",[intervention.eventId]);
    assert.ok((await query({recheck:[grant.id]})).items.every(i=>i.state==='unavailable'));
    const transport=a.peering.send;a.peering.send=async()=>{throw new Error('synthetic offline');};
    const offline=await query();assert.equal(offline.state,'unknown');assert.deepEqual(offline.items,[]);assert.deepEqual(offline.intermediaries,[]);a.peering.send=transport;
    // A correctly signed but overbroad remote response is still rejected.
    const actual=b.peering.exchange.bind(b.peering);b.peering.exchange=async input=>{
      const response=await actual(input),{decodeJwt}=await import('jose'),v=decodeJwt(response.signed);v.data.items=[{grantId:grant.id,state:'unavailable',rawContext:'LEAK'}];
      return{signed:await b.peering.sign('hub-peering',v.data,v.jti,120)};};
    await call(a,'/v2/hubs/peering/query',{hubId:ah,agreementId:agreement.id,queryId:randomUUID()},a,409);b.peering.exchange=actual;
    await assert.rejects(postHubPeeringJson('https://a.example/not-peering',{bodyJson:'{}'}),/Invalid peering/);
    await call(a,'/v2/hubs/read',{hubId:ah},{credential:'invalid'},401);
    if(options.afterWorkflow)await options.afterWorkflow({a,b,ah,bh,agreement,call});
    return{hubId:ah,agreementId:agreement.id,subjectId:a.actor.subjectId};
  }finally{for(const api of apis)await new Promise(ok=>api.close(ok));await b.db.close();if(!database)await a.db.close();}
}
