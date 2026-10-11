import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lockControllerMappingsWithin,controllerMappingLockKeys} from '../src/controller-mapping-lock.mjs';
import {CommunityAccountRegistry} from '../src/community-accounts.mjs';
import {chatFixture,invite} from './chat-workflow.mjs';

test('controller lock keys cover absent associations and batch duplicates in stable subject order',async()=>{
 const calls=[],db={query:async(sql,args)=>{calls.push({sql,args});return{rows:[]};}};
 await lockControllerMappingsWithin(db,'https://one.example',['c','a','b','a']);
 assert.deepEqual(calls.map(call=>call.args[1]),controllerMappingLockKeys('https://one.example',['a','b','c']));
 assert.ok(calls.every(call=>call.sql.includes('pg_advisory_xact_lock_shared(')));
 const original=calls.find(call=>call.args[1]===controllerMappingLockKeys('https://one.example',['a'])[0]);calls.length=0;
 await lockControllerMappingsWithin(db,'https://one.example',['a'],{exclusive:true});
 assert.deepEqual(calls[0].args,original.args);assert.ok(!calls[0].sql.includes('_shared'));
 calls.length=0;await lockControllerMappingsWithin(db,'https://other.example',['a']);assert.notDeepEqual(calls[0].args,original.args);
});

test('verified association takes the same exclusive subject key before account upsert even for a first link',async()=>{
 const endpoint='https://official.example.org',subjectId='synthetic-first-association',linkId=randomUUID(),calls=[];
 const access={endpoint,now:()=>1000},registry=new CommunityAccountRegistry(access,[{describe:()=>({issuer:'https://issuer.example',clientId:'client'})}]);
 const db={query:async(sql,args)=>{calls.push({sql,args});if(sql.includes('FROM external_identity_links'))return{rows:[{issuer:'https://issuer.example',client_id:'client'}]};if(sql.includes('RETURNING id'))return{rows:[{id:randomUUID()}]};return{rows:[]};}};
 await registry.linkVerifiedWithin(db,{subjectId,linkId,endpoint,issuer:'https://issuer.example',externalSubject:'synthetic-account',verifiedAt:1000,verificationMethod:'email'});
 assert.ok(calls[0].sql.includes('pg_advisory_xact_lock('));assert.equal(calls[0].args[1],controllerMappingLockKeys(endpoint,[subjectId])[0]);
 assert.ok(calls.findIndex(call=>call.sql.includes('INSERT INTO community_accounts'))>0);
});

test('actual room reads and writes acquire the complete controller batch before resolution without read-side row updates',async()=>{
 // Actual PGlite, signed Bindings and ChatService. This fixture's controller
 // resolver and quota are explicit legacy doubles, not real PG concurrency.
 const f=await chatFixture({transport:{available:true,project:async()=>{},send:async()=>({}),read:async()=>[]}});
 try{
  const roomId=randomUUID(),[a,b,c]=f.people;await f.chat.create(a,{roomId,operationId:randomUUID(),title:'Synthetic lock ordering'});
  await invite(f.chat,a,roomId,b);await invite(f.chat,a,roomId,c,[b]);
  const events=[],originalRun=f.chat.run.bind(f.chat),originalResolver=f.chat.resolveControlParty;
  // PGlite supplies a separate transaction client. Observe that actual client,
  // delegating every query without changing results or transaction boundaries.
  f.chat.run=(actor,write,fn)=>originalRun(actor,write,db=>fn({query:async(sql,args)=>{
   if(sql.includes('pg_advisory_xact_lock_shared'))events.push({kind:'lock',id:args[1]});
   if(/^UPDATE chat_(rooms|memberships)/.test(sql))events.push({kind:'update'});return db.query(sql,args);
  }}));
  f.chat.resolveControlParty=async(db,id)=>{events.push({kind:'resolve',id});return originalResolver(db,id);};
  const view=await f.chat.get(a,roomId),ids=controllerMappingLockKeys(f.chat.access.endpoint,[a.subjectId,b.subjectId,c.subjectId]);
  assert.deepEqual(events.filter(event=>event.kind==='lock').map(event=>event.id),ids);assert.equal(events.findIndex(event=>event.kind==='resolve'),3);
  assert.ok(!events.some(event=>event.kind==='update'));
  events.length=0;const decisionId=randomUUID(),proposal=await f.chat.proposeDecision(a,roomId,{decisionId,expectedRevision:view.revision,action:'join-rule',joinRule:{mode:'open'}});
  assert.equal(proposal.state,'pending');assert.deepEqual(events.slice(0,3).map(event=>event.id),ids);assert.equal(events[3].kind,'resolve');
 }finally{await f.close();}
});
