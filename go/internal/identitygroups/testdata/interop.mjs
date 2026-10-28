import pg from '../../../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {serviceFixture} from '../../../../packages/galaxy-official/test/service-fixture.mjs';
import {configurationExample} from '../../../../packages/galaxy-official/test/configuration-v2-workflow.mjs';
import {identityGroupIntentSchema,identityGroupProofSchema,identityGroupSignatureType} from '../../../../packages/galaxy-official/src/shared/identity-group-v2-schema.mjs';
import {migrate} from '../../../../packages/galaxy-official/src/infrastructure/database.mjs';
import {cleanupIdentityGroupsWithin} from '../../../../packages/galaxy-official/src/operations/identity-group-retention-v2.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated fixture required');
const db=new pg.Pool({connectionString:address.href,max:6}),clock=2000000000,endpoint='https://identity-group.example.invalid',scopes=['binding','consent','case-teaser','history','data-export','data-delete'],hash=x=>createHash('sha256').update(x).digest('hex');
try{
 const owner=await serviceFixture(scopes,db,{endpoint,now:clock}),member=await serviceFixture(scopes,db,{endpoint,now:clock,migrateDatabase:false}),stranger=await serviceFixture(scopes,db,{endpoint,now:clock,migrateDatabase:false}),people={owner,member,stranger};
 const id=randomUUID(),event={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,actorId:owner.actor.subjectId,localRef:randomUUID(),title:'SYNTHETIC exact identity attribution',summary:'Private synthetic original author material',synthetic:true,source:{kind:'local',reference:randomUUID()}},caseGrant=await owner.authorize(event,'case.teaser.publish',{objectId:id});await owner.cases.submitV2(owner.actor,caseGrant);
 const config={...configurationExample(member.actor),observedAt:new Date(clock*1000).toISOString()},configGrant=await member.authorize(config,'configuration.publish',{objectId:config.operationId});await member.configurations.submit(member.actor,configGrant);
 const refs=[{kind:'case-event',id,caseId:id,version:1,sourceHash:hash(caseGrant.payloadJson),originalSubjectId:owner.actor.subjectId},{kind:'configuration',id:config.id,version:1,sourceHash:hash(configGrant.payloadJson),originalSubjectId:member.actor.subjectId}];
 await migrate(db,{roles:['api','worker']});
 console.log(JSON.stringify({ready:true,clock,endpoint,refs,actors:Object.fromEntries(Object.entries(people).map(([k,f])=>[k,{subject:f.actor.subjectId,token:f.credential}]))}));
 for await(const line of createInterface({input:process.stdin,terminal:false})){try{const q=JSON.parse(line),f=people[q.actor??'owner'];let value;
  if(q.action==='intent')value=identityGroupIntentSchema.parse(q.input);
  else if(q.action==='sign'){const current=await f.identityGroups.current(f.actor),payloadJson=q.payloadJson??JSON.stringify(identityGroupIntentSchema.parse(q.input)),p=JSON.parse(payloadJson),proof=identityGroupProofSchema.parse({schemaVersion:2,id:randomUUID(),operationId:p.operationId,groupId:p.groupId,payloadHash:hash(payloadJson),endpoint,subjectId:f.actor.subjectId,keyId:current.keyId,epoch:current.epoch,decision:q.decision??'approve',issuedAt:clock,expiresAt:p.expiresAt}),proofJson=JSON.stringify(proof);value={payloadJson,proofJson,signature:await (people[q.signer??q.actor??'owner']).signForTest(proofJson,identityGroupSignatureType)};}
  else if(q.action==='read')value=await owner.identityGroups[q.method](q.actor?f.actor:null,q.input);
  else if(q.action==='bootstrap'){const publicKeyPem=f.genesis.genesisProof.publicKeyPem,request={operationId:randomUUID(),subjectId:f.actor.subjectId,kind:'bootstrap',expectedEpoch:0,previousEventHash:null,signerKeyId:hash(publicKeyPem),genesisProof:f.genesis.genesisProof,newDevice:{deviceId:randomUUID(),publicKeyPem,scopes:['manage-identity',...scopes]}},ch=await f.identityControl.challenge(request),signature=await f.signForTest(ch.challenge,'galaxy-identity-control-v2+jws');await f.identityControl.commit({operationId:request.operationId,controllerSignature:signature,newDeviceProof:signature});f.actor=await f.access.authenticate(f.credential);value=await f.identityGroups.current(f.actor);}
  else if(q.action==='cleanup'){const tx=await db.connect();await tx.query('BEGIN');try{value=await cleanupIdentityGroupsWithin(tx,q.at)}finally{await tx.query('ROLLBACK');tx.release()}}
  else throw Error('action');console.log(JSON.stringify({value:value??null}));
 }catch(e){console.log(JSON.stringify({error:e.code??'fixture_error',status:e.status??500,message:e.message}));}}
}finally{await db.end()}
