import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {serviceFixture} from './service-fixture.mjs';
import {attachmentContractFixture} from './chat-attachments-workflow.mjs';
import {approveOutcomeCopy} from './outcome-material-lifecycle-continuity-workflow.mjs';
import {OutcomeMaterialServiceV2} from "../src/evidence/outcome-material-v2.mjs";
import {createApi} from '../src/http.mjs';
import {createRetirementController} from "../src/privacy/retirement.mjs";
import {serviceAccessV2} from '../src/operations/service-access-v2.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// Real JWS/HTTP and canonical export/current-source services. Storage, scanner,
// community Account and chat transport remain explicit isolated contract doubles.
export async function takeoutBinaryFixture({database=null,migrateDatabase=true,repositories}={}){
 const base=Math.floor(Date.now()/1000);let current=base;
 const policy={version:1,id:'synthetic-binary-takeout-v1',endpoint:'https://official.example.org',operator:'Synthetic operator',
  reason:'Isolated export route regression',announcedAt:base+10,stopWritesAt:base+20,takeoutUntil:base+120,statusUntil:base+180,
  contactUrl:'https://official.example.org/contact',deletionPolicyUrl:'https://official.example.org/deletion'};
 const retirement=createRetirementController(policy,{endpoint:policy.endpoint,now:()=>current});
 const f=await serviceFixture(['binding','consent','case-teaser','evidence','data-export'],database,{migrateDatabase,repositories,now:base,retirement});
 let server;
 try{
  f.access.now=f.bindings.now=f.consents.now=f.chat.now=f.attachments.now=()=>current;
  f.chat.requireAccountWithin=async()=>{};
  f.chat.transport={available:true,project:async()=>{},send:async input=>({archiveId:input.messageId})};
  Object.assign(f.attachments,attachmentContractFixture());
  const materials=new OutcomeMaterialServiceV2(f.access,{consents:f.consents,chat:f.chat,records:f.verificationRecords,attachments:f.attachments});
  f.dataExport.viewServices.outcomeMaterials=materials;
  server=createApi({...f,outcomeMaterials:materials,rateLimit:1000});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const post=async(path,input,method='POST')=>{
   const response=await fetch(origin+path,{method,headers:{Authorization:'Bearer '+f.credential,'Content-Type':'application/json'},
    ...(method==='POST'?{body:JSON.stringify(input)}:{})});
   return {status:response.status,body:await response.json()};
  };
  const roomId=randomUUID(),attachmentId=randomUUID(),bytes=Buffer.from('Synthetic independently permitted takeout binary chunks.'),sha256=hash(bytes);
  await f.chat.create(f.actor,{roomId,operationId:randomUUID(),title:'Synthetic takeout binary'});
  await f.attachments.prepare(f.actor,{attachmentId,roomId,name:'selected.txt',mediaType:'text/plain',size:bytes.length,
   sha256,purpose:'temporary-room-attachment',confirmed:true});
  await f.attachments.upload(f.actor,attachmentId,Readable.from([bytes]),{contentLength:bytes.length});await f.attachments.scanPending();
  const x={f,materials,post,base,policy,retirement,roomId,attachmentId,bytes,sha256,
   setTime(seconds){current=seconds;},
   async ticket(){const result=await post('/v1/data-exports/create',{id:randomUUID(),datasets:['outcome-materials-v2']});
    assert.equal(result.status,200,JSON.stringify(result.body));return result.body;},
   input(ticket,material,offset=0,length=8){return {id:ticket.id,dataset:'outcome-materials-v2',recordId:material.materialId,offset,length};},
   async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(!database)await f.db.close();}};
  x.material=await approveOutcomeCopy(x,{copyPermissionSeconds:300});
  return x;
 }catch(error){
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(!database)await f.db.close();
  throw error;
 }
}

const assertUnavailable=result=>{
 assert.equal(result.status,200,JSON.stringify(result.body));
 assert.equal(result.body.binaryContentAvailable,false);
 assert.equal(result.body.complete,false);
 assert.equal(result.body.length,0);
 assert.equal(Object.hasOwn(result.body,'contentBase64'),false);
 assert.equal(result.body.nextOffset,null);
};

export async function verifyTakeoutBinaryRead(options={}){
 const x=await takeoutBinaryFixture(options);
 try{
  const ticket=await x.ticket(),input=x.input(ticket,x.material);
  assert.equal(serviceAccessV2('POST','/v1/data-exports/binary'),'read');
  for(const path of ['/v1/data-exports/binary-extra','/v1/data-exports/binary/extra','/v1/future-write'])
   assert.equal(serviceAccessV2('POST',path),null);
  assert.equal(serviceAccessV2('GET','/v1/data-exports/binary'),null);
  const normal=await x.post('/v1/data-exports/binary',input);
  assert.equal(normal.status,200,JSON.stringify(normal.body));
  assert.equal(normal.body.sha256,x.sha256);
  assert.equal(normal.body.exportId,ticket.id);
  assert.equal(normal.body.recordId,x.material.materialId);
  assert.deepEqual(Buffer.from(normal.body.contentBase64,'base64'),x.bytes.subarray(0,8));
  assert.equal(normal.body.nextOffset,8);
  assert.equal(normal.body.complete,false);
  x.setTime(x.base+20);assert.equal(x.retirement.phase(),'takeout');
  const current=await x.materials.read(x.f.actor,{id:x.material.materialId,version:1});
  assert.equal(current.contentAvailable,true);
  const takeout=await x.post('/v1/data-exports/binary',input);
  assert.equal(takeout.status,200,JSON.stringify(takeout.body));
  assert.deepEqual(takeout.body,normal.body,'same ticket, exact offset, source and current permission retain identical binary projection');
  const tail=await x.post('/v1/data-exports/binary',x.input(ticket,x.material,8,524288));
  assert.equal(tail.status,200,JSON.stringify(tail.body));assert.equal(tail.body.complete,true);
  assert.equal(tail.body.nextOffset,null);
  const assembled=Buffer.concat([Buffer.from(takeout.body.contentBase64,'base64'),Buffer.from(tail.body.contentBase64,'base64')]);
  assert.deepEqual(assembled,x.bytes);assert.equal(hash(assembled),normal.body.sha256);
  const page=await x.post('/v1/data-exports/page',{id:ticket.id,dataset:'outcome-materials-v2',limit:1});
  assert.equal(page.status,200);assert.deepEqual(Buffer.from(page.body.items[0].contentBase64,'base64'),x.bytes);
  for(const path of ['/v1/future-write','/v1/data-exports/binary-extra','/v1/data-exports/binary/extra','/v2/outcome-materials/request']){
   const result=await x.post(path,{});
   assert.equal(result.status,410);assert.equal(result.body.error,'service_writes_stopped');
  }
  assert.equal((await x.post('/v1/data-exports/binary',{},'GET')).status,410);
  x.setTime(x.policy.takeoutUntil);assert.equal(x.retirement.phase(),'status-only');
  const closedBinary=await x.post('/v1/data-exports/binary',input),closedPage=await x.post('/v1/data-exports/page',{id:ticket.id,dataset:'outcome-materials-v2'});
  assert.equal(closedBinary.status,410);assert.equal(closedPage.status,410);
  x.setTime(x.policy.statusUntil);assert.equal(x.retirement.phase(),'closed');
  assert.equal((await x.post('/v1/data-exports/binary',input)).status,410);
  return {normalStatus:200,takeoutStatus:200,sameTicketAndBytes:true,assembledSha256Matches:true,chunkCount:2,
   unknownWriteAndPathVariantsRejected:true,statusOnlyAndClosedDownloadRejected:true};
 }finally{await x.close();}
}

export async function verifyTakeoutBinarySourceValidity(options={}){
 const x=await takeoutBinaryFixture(options);
 try{
  const expiring=await approveOutcomeCopy(x,{copyPermissionSeconds:40}),ticket=await x.ticket();
  const input=x.input(ticket,x.material),expiringInput=x.input(ticket,expiring);
  assert.equal((await x.post('/v1/data-exports/binary',expiringInput)).body.binaryContentAvailable,true);
  x.setTime(x.base+20);assert.equal(x.retirement.phase(),'takeout');
  const revoke=await x.post('/v1/consents/'+x.material.approvalConsentId+'/revoke',{});
  assert.equal(revoke.status,200,JSON.stringify(revoke.body));
  const revoked=await x.post('/v1/data-exports/binary',input);
  assertUnavailable(revoked);assert.equal(revoked.body.sha256,x.sha256);
  const live=await x.post('/v1/data-exports/binary',expiringInput);
  assert.equal(live.status,200);assert.equal(live.body.binaryContentAvailable,true);
  x.setTime(x.base+41);assert.equal(x.retirement.phase(),'takeout');assert.ok(x.base+41<ticket.expiresAt);
  const expired=await x.post('/v1/data-exports/binary',expiringInput);
  assertUnavailable(expired);assert.equal(expired.body.sha256,x.sha256);
  return {approvalRevokeCurrentContentWithheld:true,approvalExpiryCurrentContentWithheld:true,
   permissionWithholdingIsMetadataOnly:true,ticketStillValid:true,sourceSha256Unchanged:true};
 }finally{await x.close();}
}

export async function verifyTakeoutBinaryTicketValidity(options={}){
 const x=await takeoutBinaryFixture(options);
 try{
  const revokedTicket=await x.ticket(),expiredTicket=await x.ticket();
  const revokedInput=x.input(revokedTicket,x.material),expiredInput=x.input(expiredTicket,x.material);
  assert.equal((await x.post('/v1/data-exports/binary',revokedInput)).status,200);
  x.setTime(x.base+20);assert.equal(x.retirement.phase(),'takeout');
  const revoke=await x.post('/v1/data-exports/revoke',{id:revokedTicket.id});
  assert.equal(revoke.status,200);assert.equal(revoke.body.revoked,true);
  const revoked=await x.post('/v1/data-exports/binary',revokedInput);
  assert.equal(revoked.status,410);assert.equal(revoked.body.error,'export_expired');
  // Isolated expiry metadata setup. It does not change any source permission,
  // binding, signed bytes, deadline policy or production record.
  await x.f.db.query('UPDATE data_exports SET expires_at=$2 WHERE id=$1',
   [expiredTicket.id,new Date((x.base+30)*1000).toISOString()]);
  x.setTime(x.base+31);assert.equal(x.retirement.phase(),'takeout');
  const expired=await x.post('/v1/data-exports/binary',expiredInput);
  assert.equal(expired.status,410);assert.equal(expired.body.error,'export_expired');
  assert.equal((await x.materials.read(x.f.actor,{id:x.material.materialId,version:1})).contentAvailable,true);
  return {ticketRevokeRejected:true,ticketExpiryRejected:true,sourceStillCurrentlyReadable:true,
   sourcePermissionNotExpandedByRouteClassification:true};
 }finally{await x.close();}
}

