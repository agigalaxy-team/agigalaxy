import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {migrate} from "../../src/infrastructure/database.mjs";
import {verifyGovernance,chatFixture,invite} from '../chat-workflow.mjs';

test('PostgreSQL galaxy_api role serializes common governance and stable message operations',{timeout:60000},async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
 const pool=new pg.Pool({max:8,statement_timeout:10000}),runtimeDb=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:10000});
 try{await migrate(pool);await pool.query(await readFile(new URL('../../src/infrastructure/api-role.sql',import.meta.url),'utf8'));
  await verifyGovernance({database:pool,runtimeDb,migrateDatabase:false});
  let sends=0;const transport={available:true,project:async()=>{},send:async x=>{sends++;return{archiveId:x.messageId};}};
  const f=await chatFixture({database:pool,runtimeDb,migrateDatabase:false,transport}),[a,b]=f.people,roomId=randomUUID(),create={roomId,operationId:randomUUID(),title:'Concurrent actual PG test'};
  const rooms=await Promise.all([f.chat.create(a,create),f.chat.create(a,create)]);assert.equal(rooms[0].roomId,rooms[1].roomId);await invite(f.chat,a,roomId,b);
  const input={clientMessageId:randomUUID(),text:'one operation concurrent across sessions'};
  const receipts=await Promise.all([f.chat.send(a,roomId,input),f.chat.send(a,roomId,input)]);assert.equal(receipts[0].messageId,receipts[1].messageId);assert.equal(sends,1);
  const grantId=randomUUID();
  await f.chat.grantAgent(a,roomId,{grantId,bindingId:a.bindingId,mode:'respond',primaryResponder:true,expiresAt:Math.floor(Date.now()/1000)+3600});
  const own=await f.chat.queryAgentGrants(a,roomId,{grantId});assert.equal(own.items[0].state,'active');assert.equal(own.items[0].hostRuntimeState,'unverified');
  assert.equal((await f.chat.queryAgentGrants(b,roomId,{grantId})).state,'absent');
  await assert.rejects(f.chat.grantAgent(a,roomId,{grantId:randomUUID(),bindingId:b.bindingId,mode:'read',expiresAt:Math.floor(Date.now()/1000)+3600}),error=>error.code==='chat_agent_not_authorized');
  await f.chat.revokeAgent(a,roomId,{grantId});assert.equal((await f.chat.queryAgentGrants(a,roomId,{grantId})).items[0].state,'revoked');
  console.log(JSON.stringify({event:'chat_postgres_governance_verified',apiRole:true,concurrentCreate:true,concurrentSend:true,ownAgentGrantAndRevocation:true,foreignBindingRejected:true,transport:'explicit-contract-double-not-Prosody-runtime'}));
 }finally{await runtimeDb.end();await pool.end();}
});
