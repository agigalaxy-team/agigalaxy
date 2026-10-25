import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {NodeStreamableHTTPServerTransport} from '@modelcontextprotocol/node';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {createPersonalMcp} from '../src/adapters/mcp/personal/handler.mjs';
import {createRetirementController} from '../src/retirement.mjs';
import {digest} from '../src/shared/digest.mjs';
import {verificationOperationReceiptResultSchema} from '../src/shared/verification-record-schema.mjs';

const scopes=['binding','consent','case-teaser','evidence'];
// Fictional identities and source observations only. Canonical HTTP, Ed25519
// Consent signatures and PGlite commits are real; lost ACK is a caller fault
// injected after a successful HTTP commit, not a physical network experiment.
async function fixture(options={}){
  const f=await serviceFixture(scopes,null,{syntheticCommunityQuota:false,...options});
  const api=createApi({...f,rateLimit:1000}),hosts=[],servers=[];
  const close=async()=>{
    for(const host of hosts)await host.close();
    for(const server of [...servers,api])if(server.listening){
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    }
    await f.db.close();
  };
  try{
    await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+api.address().port;
    const post=async(path,input,who=f)=>{
      const headers={'Content-Type':'application/json'};
      if(who?.credential)headers.Authorization='Bearer '+who.credential;
      const response=await fetch(origin+path,{method:'POST',headers,body:JSON.stringify(input)});
      return{status:response.status,body:await response.json()};
    };
    const authorise=async(payload,action='evidence.submit',payloadJson=JSON.stringify(payload))=>{
      const intent={version:1,id:randomUUID(),subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,
        endpoint:f.access.endpoint,objectId:payload.operationId??payload.eventId,action,
        purpose:'operational',recipient:f.access.endpoint,fields:Object.keys(payload),visibility:'Private',viewers:[],
        payloadHash:digest(payloadJson),policyVersion:'0.1',issuedAt:f.now,expiresAt:f.now+3600};
      const created=await post('/v1/consents',{signedIntent:await f.signForTest(JSON.stringify(intent),'galaxy-consent+jws')});
      assert.equal(created.status,200,JSON.stringify(created));
      return{consentId:intent.id,payloadJson};
    };
    const submit=async(payload,path='/v2/verification-records/submit',action='evidence.submit',payloadJson)=>{
      const request=await authorise(payload,action,payloadJson),out=await post(path,request);
      assert.equal(out.status,200,JSON.stringify(out));return{payload,request,out};
    };
    const caseResult=async()=>{
      const caseId=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,
        expectedVersion:0,actorId:f.actor.subjectId,localRef:randomUUID(),title:'FICTIONAL M06 receipt fixture',
        summary:'Synthetic historical operation metadata',source:{kind:'local',reference:randomUUID()},synthetic:true};
      await submit(root,'/v2/cases/events','case.teaser.publish');
      const intervention={schemaVersion:2,kind:'intervention',eventId:randomUUID(),caseId,expectedVersion:1,
        actorId:f.actor.subjectId,types:['diagnosis'],affectsAttemptIds:[],description:'Fictional bounded diagnosis',
        sourceRefs:[],observedEffect:'No real external execution'};
      await submit(intervention,'/v2/cases/events','case.teaser.publish');
      const result={schemaVersion:2,kind:'result-recorded',eventId:randomUUID(),caseId,expectedVersion:2,
        actorId:f.actor.subjectId,origin:{kind:'intervention',id:intervention.eventId,version:1},scopeVersion:1,
        deliverableRefs:[],reportedOutcome:'partial',summary:'Fictional result',limitations:'Synthetic only'};
      await submit(result,'/v2/cases/events','case.teaser.publish');return{caseId,result};
    };
    const evidence=(caseId,more={})=>{
      const observedAt=new Date(f.now*1000).toISOString();
      return{caseId,reportedBy:f.actor.subjectId,synthetic:true,observedAt,id:randomUUID(),operationId:randomUUID(),
        expectedVersion:0,kind:'evidence',evidenceType:'test-result',
        source:{originSystem:'isolated-M06-fixture',externalStableId:randomUUID(),contentVersion:'1',
          issuer:f.actor.subjectId,originalAt:observedAt},reportedSourceState:'available',
        summary:'PRIVATE FICTIONAL support, not a real validation',...more};
    };
    const verification=(caseId,result,evidenceId,more={})=>({
      caseId,reportedBy:f.actor.subjectId,synthetic:true,observedAt:new Date(f.now*1000).toISOString(),
      id:randomUUID(),operationId:randomUUID(),expectedVersion:0,kind:'verification',
      target:{type:'result',id:result.eventId,version:1},scopeVersion:1,method:'local-test',
      scope:'Fictional bounded fixture',conditions:{environment:'synthetic'},observation:'passed',
      summary:'PRIVATE FICTIONAL baseline, no expertise certification',evidenceRefs:[{id:evidenceId,version:1}],
      relationship:'same-controller',...more});
    const reference=(payload,request)=>({type:payload.kind==='revoke'?payload.objectType:payload.kind,
      id:payload.id,operationId:payload.operationId,payloadHash:digest(request.payloadJson)});
    const receipt=async(ref,who=f)=>{
      const out=await post('/v2/verification-records/receipt',ref,who);
      assert.equal(out.status,200,JSON.stringify(out));
      verificationOperationReceiptResultSchema.parse(out.body);return out.body;
    };
    const revokeConsent=async request=>assert.equal((await post('/v1/consents/'+request.consentId+'/revoke',{})).status,200);
    const eventCount=async()=>Number((await f.db.query('SELECT count(*) FROM verification_events')).rows[0].count);
    const original=async operationId=>(await f.db.query(
      'SELECT operation_id,object_id,version,payload_text,payload_hash,consent_id,created_at FROM verification_events WHERE operation_id=$1',
      [operationId])).rows[0];
    const sdk=async who=>{
      const server=createServer(async(req,res)=>{let mcp;try{
        const credential=/^Bearer (.+)$/.exec(req.headers.authorization??'')?.[1];
        const actor=await f.access.authenticate(credential);mcp=createPersonalMcp(f,actor);
        const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
        await mcp.connect(transport);await transport.handleRequest(req,res);
      }catch{if(!res.headersSent)res.writeHead(401);res.end();}finally{await mcp?.close();}});
      servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      const host=new Client({name:'fictional-verification-receipt',version:'1'});hosts.push(host);
      await host.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+server.address().port),
        {requestInit:{headers:{authorization:'Bearer '+who.credential}}}));return host;
    };
    return{f,post,authorise,submit,caseResult,evidence,verification,reference,receipt,revokeConsent,eventCount,original,sdk,close};
  }catch(error){await close();throw error;}
}
function assertMinimal(value){
  assert.equal(value.currentAccessGranted,false);assert.equal(value.contentReturned,false);
  assert.equal(value.sourceAccessChecked,false);assert.equal(value.authority,'accepted-operation-only');
  const keys=['type','id','operationId','payloadHash','state','authority','audience',
    'currentAccessGranted','contentReturned','sourceAccessChecked',
    ...(value.state==='acknowledged'?['receipt']:value.state==='absent'?['absenceMeaning']:['reason'])];
  assert.deepEqual(Object.keys(value).sort(),keys.sort());
  if(value.state==='acknowledged')assert.deepEqual(Object.keys(value.receipt).sort(),
    ['type','id','operationId','payloadHash','version','acceptedAt'].sort());
  assert.equal(JSON.stringify(value).includes('PRIVATE FICTIONAL'),false);
}

test('exact Verification receipt distinguishes committed lost ACK and unsubmitted correction after source and Consent revocation',async()=>{
  const h=await fixture();try{
    const {caseId,result}=await h.caseResult(),e=await h.submit(h.evidence(caseId));
    const v=await h.submit(h.verification(caseId,result,e.payload.id));
    const accepted={...v.payload,operationId:randomUUID(),expectedVersion:1,reason:'Fictional correction accepted',
      observation:'inconclusive',summary:'PRIVATE FICTIONAL accepted correction'};
    const notSent={...accepted,operationId:randomUUID(),reason:'Fictional correction not sent',summary:'PRIVATE FICTIONAL unsubmitted'};
    const a=await h.authorise(accepted),b=await h.authorise(notSent);
    await assert.rejects(async()=>{
      const out=await h.post('/v2/verification-records/submit',a);assert.equal(out.status,200);
      throw new Error('injected missing caller ACK after actual commit');
    },/injected missing caller ACK/);
    const refA=h.reference(accepted,a),refB=h.reference(notSent,b),before=await h.receipt(refA);
    assert.equal(before.state,'acknowledged');assert.equal(before.receipt.version,2);assertMinimal(before);
    const bytes=await h.original(accepted.operationId);assert.equal(bytes.payload_text,a.payloadJson);
    await h.revokeConsent(e.request);
    const current=await h.post('/v2/verification-records/status',{refs:[{type:'verification',id:v.payload.id,version:2}]});
    assert.equal(current.body.items[0].referenceStatus,'dependency-unavailable');assert.equal(current.body.items[0].record,null);
    await h.revokeConsent(a);await h.revokeConsent(b);
    assert.deepEqual(await h.receipt(refA),before);const absent=await h.receipt(refB);
    assert.equal(absent.state,'absent');assert.equal(absent.absenceMeaning,'no-retained-owner-operation');assertMinimal(absent);
    const consentReceipts=await Promise.all([a,b].map(r=>h.post('/v2/consents/receipt',{consentId:r.consentId})));
    assert.ok(consentReceipts.every(r=>r.body.state==='recorded'&&r.body.status==='revoked'));
    assert.equal((await h.post('/v2/verification-records/submit',a)).body.error,'consent_required');
    const oldStatus=await h.post('/v2/verification-records/status',{refs:[{type:'verification',id:v.payload.id,version:2}]});
    assert.equal(oldStatus.body.items[0].reason,'consent_required');
    await h.submit({schemaVersion:2,kind:'case-withdrawn',eventId:randomUUID(),caseId,
      expectedVersion:3,actorId:h.f.actor.subjectId,reason:'Fictional withdrawal'},'/v2/cases/events','case.teaser.publish');
    assert.deepEqual(await h.receipt(refA),before);
    assert.equal(await h.eventCount(),3);assert.deepEqual(await h.original(accepted.operationId),bytes);
    assert.equal(await h.original(notSent.operationId),undefined);
  }finally{await h.close();}
});

test('Evidence receipt preserves each original accepted version after correction, revocation and retained-body erasure without reconstructing content',async()=>{
  const h=await fixture();try{
    const {caseId}=await h.caseResult(),first=await h.submit(h.evidence(caseId));
    const second=await h.submit({...first.payload,operationId:randomUUID(),expectedVersion:1,reason:'Fictional source correction',
      source:{...first.payload.source,contentVersion:'2'},summary:'PRIVATE FICTIONAL correction'});
    const revoked=await h.submit({kind:'revoke',objectType:'evidence',id:first.payload.id,operationId:randomUUID(),
      expectedVersion:2,caseId,reportedBy:h.f.actor.subjectId,synthetic:true,reason:'Fictional evidence withdrawal'});
    const refs=[first,second,revoked].map(r=>h.reference(r.payload,r.request));
    const receipts=await Promise.all(refs.map(r=>h.receipt(r)));
    assert.deepEqual(receipts.map(r=>r.receipt.version),[1,2,3]);receipts.forEach(assertMinimal);
    for(const r of [first,second,revoked])await h.revokeConsent(r.request);
    // Explicit retained-row robustness fixture; not a claim that production
    // retention always erases these two columns or preserves a subject forever.
    await h.f.db.query("UPDATE verification_events SET payload='{}'::jsonb,payload_text='' WHERE object_id=$1",[first.payload.id]);
    const forbidden=async()=>{throw new Error('receipt attempted a current body/source read');};
    for(const method of ['readWithin','caseWithin','targetWithin','requireReferenceWithin'])h.f.verificationRecords[method]=forbidden;
    h.f.consents.require=forbidden;
    assert.deepEqual(await Promise.all(refs.map(r=>h.receipt(r))),receipts);
    assert.equal(await h.eventCount(),3);
    // Once the stored owner operation is physically absent, receipt does not
    // invent a historical ledger. This is fixture SQL deletion, not a subject
    // deletion end-to-end test.
    await h.f.db.query('DELETE FROM verification_events WHERE operation_id=$1',[second.payload.operationId]);
    const absent=await h.receipt(refs[1]);assert.equal(absent.state,'absent');assertMinimal(absent);
    assert.deepEqual(await h.receipt(refs[0]),receipts[0]);
  }finally{await h.close();}
});

test('receipt enforces original owner, exact type/id/hash and strict input; absent explicit reauthorization preserves original business bytes',async()=>{
  const h=await fixture();try{
    const {caseId}=await h.caseResult(),payload=h.evidence(caseId),raw=JSON.stringify(payload,null,2);
    const unsubmitted=await h.authorise(payload,'evidence.submit',raw),ref=h.reference(payload,unsubmitted);
    await h.revokeConsent(unsubmitted);const prior=await h.receipt(ref);
    assert.equal(prior.state,'absent');assert.equal(await h.eventCount(),0);
    const fresh=await h.authorise(payload,'evidence.submit',raw);
    assert.notEqual(fresh.consentId,unsubmitted.consentId);assert.equal(fresh.payloadJson,unsubmitted.payloadJson);
    assert.equal((await h.post('/v2/verification-records/submit',fresh)).status,200);
    const accepted=await h.receipt(ref),bytes=await h.original(payload.operationId);
    assert.equal(accepted.state,'acknowledged');assert.equal(bytes.payload_text,raw);assert.equal(bytes.payload_hash,ref.payloadHash);
    assert.equal(await h.eventCount(),1);
    const other=await serviceFixture(scopes,h.f.db,{migrateDatabase:false,syntheticCommunityQuota:false});
    const another=await h.receipt(ref,other),unknown=await h.receipt({...ref,operationId:randomUUID()},other);
    assert.equal(another.state,'absent');assert.equal(unknown.state,'absent');
    assert.equal(another.absenceMeaning,unknown.absenceMeaning);assertMinimal(another);
    for(const wrong of [{...ref,payloadHash:'0'.repeat(64)},{...ref,id:randomUUID()},{...ref,type:'verification'}]){
      const conflict=await h.receipt(wrong);assert.equal(conflict.state,'conflict');assertMinimal(conflict);
      assert.deepEqual({...conflict}, {...wrong,state:'conflict',authority:'accepted-operation-only',audience:'owner-only',
        currentAccessGranted:false,contentReturned:false,sourceAccessChecked:false,reason:'original-operation-mismatch'});
    }
    for(const invalid of [{...ref,body:'PRIVATE FICTIONAL'},{...ref,consentId:fresh.consentId},
      {...ref,payloadHash:'A'.repeat(64)},{...ref,operationId:null}]){
      const rejected=await h.post('/v2/verification-records/receipt',invalid);
      assert.equal(rejected.status,400);assert.equal(rejected.body.error,'invalid_verification_receipt_query');
    }
    assert.equal((await h.post('/v2/verification-records/receipt',ref,null)).status,401);
    const noEvidence=await serviceFixture(['binding','consent'],h.f.db,{migrateDatabase:false,syntheticCommunityQuota:false});
    const scopeDenied=await h.post('/v2/verification-records/receipt',ref,noEvidence);
    assert.equal(scopeDenied.status,401);assert.equal(scopeDenied.body.error,'access_denied');
    assert.equal(verificationOperationReceiptResultSchema.safeParse({...accepted,body:'unexpected'}).success,false);
    assert.equal(verificationOperationReceiptResultSchema.safeParse({...accepted,
      receipt:{...accepted.receipt,operationId:randomUUID()}}).success,false);
    assert.equal(await h.eventCount(),1);assert.deepEqual(await h.original(payload.operationId),bytes);
  }finally{await h.close();}
});

test('actual ordinary MCP SDK exposes a read-only original Verification receipt without source permission or business resend',async()=>{
  const h=await fixture();try{
    const {caseId,result}=await h.caseResult(),e=await h.submit(h.evidence(caseId));
    const v=await h.submit(h.verification(caseId,result,e.payload.id)),ref=h.reference(v.payload,v.request);
    await h.revokeConsent(e.request);await h.revokeConsent(v.request);
    const expected=await h.receipt(ref),owner=await h.sdk(h.f),listed=await owner.listTools();
    const definition=listed.tools.find(t=>t.name==='galaxy_verification_record_receipt');
    assert.ok(definition);assert.equal(definition.annotations.readOnlyHint,true);
    const before=await h.eventCount();
    const called=await owner.callTool({name:'galaxy_verification_record_receipt',arguments:ref});
    assert.ok(!called.isError,JSON.stringify(called));const ack=JSON.parse(called.content[0].text);
    assert.deepEqual(ack,expected);assertMinimal(ack);
    const oldRead=await owner.callTool({name:'galaxy_verification_record_read',arguments:{type:'verification',id:v.payload.id}});
    assert.equal(oldRead.isError,true);assert.match(oldRead.content[0].text,/consent_required/);
    const extra=await owner.callTool({name:'galaxy_verification_record_receipt',arguments:{...ref,payloadJson:v.request.payloadJson}});
    assert.equal(extra.isError,true);
    const other=await serviceFixture(scopes,h.f.db,{migrateDatabase:false,syntheticCommunityQuota:false}),foreign=await h.sdk(other);
    const resultOther=await foreign.callTool({name:'galaxy_verification_record_receipt',arguments:ref});
    assert.ok(!resultOther.isError);assert.equal(JSON.parse(resultOther.content[0].text).state,'absent');
    assert.equal(await h.eventCount(),before);assert.equal(Number((await h.f.db.query('SELECT count(*) FROM jobs')).rows[0].count),0);
  }finally{await h.close();}
});

test('receipt remains read-only during takeout and does not create a status-only authentication exception',async()=>{
  const now=2000000000,endpoint='https://official.example.org';let clock=now;
  const retirement=createRetirementController({version:1,id:'fictional-M06-retirement',endpoint,operator:'Fixture',
    reason:'Synthetic exit boundary',announcedAt:now+1,stopWritesAt:now+2,takeoutUntil:now+3,statusUntil:now+4,
    contactUrl:endpoint+'/contact',deletionPolicyUrl:endpoint+'/deletion'},{endpoint,now:()=>clock});
  const h=await fixture({retirement,now});try{
    const {caseId}=await h.caseResult(),e=await h.submit(h.evidence(caseId)),ref=h.reference(e.payload,e.request);
    const before=await h.receipt(ref),bytes=await h.original(e.payload.operationId);
    clock=now+2;assert.equal(retirement.phase(),'takeout');assert.deepEqual(await h.receipt(ref),before);
    assert.equal((await h.post('/v2/verification-records/submit',e.request)).status,410);
    clock=now+3;assert.equal(retirement.phase(),'status-only');
    const denied=await h.post('/v2/verification-records/receipt',ref);
    assert.equal(denied.status,410);assert.equal(denied.body.error,'service_retired');
    clock=now+4;assert.equal((await h.post('/v2/verification-records/receipt',ref)).status,410);
    assert.equal(await h.eventCount(),1);assert.deepEqual(await h.original(e.payload.operationId),bytes);
  }finally{await h.close();}
});
