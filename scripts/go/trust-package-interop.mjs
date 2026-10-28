// Original trust bytes only; live modes are restricted to disposable loopback PG.
import {readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {join,isAbsolute} from 'node:path';
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {communityForumFixture} from '../../packages/galaxy-official/test/community-forum-fixture.mjs';
import {migrate} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {trustCanonical} from '../../packages/galaxy-official/src/shared/trust-package-crypto.mjs';
if(process.argv[2]==='canonical'){const values=JSON.parse(await readFile(process.argv[3],'utf8'));console.log(JSON.stringify(values.map(v=>{try{return{accepted:true,value:trustCanonical(v)}}catch{return{accepted:false}}})));process.exit(0)}
if(process.argv[2])throw Error('unknown isolated trust fixture mode');
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated PostgreSQL required');
const dir=process.env.GALAXY_GO_TEST_TRUST_DIR;if(!isAbsolute(dir??''))throw Error('absolute disposable directory required');
const pool=new pg.Pool({connectionString:address.href,max:4}),endpoint='https://trust.example.invalid';let f,bridge;
try{
 await migrate(pool,{roles:['api','worker']});f=await communityForumFixture({database:pool,migrateDatabase:false,endpoint});
 await f.login(f.owner,'trust-author');await f.login(f.responder,'trust-recipient');
 const caseId=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:f.owner.actor.subjectId,localRef:'trust-'+caseId,title:'Exact author statement',summary:'Private authored record',source:{kind:'local',reference:'trust-'+caseId},synthetic:false};
 const rootEnvelope=await f.owner.authorize(root,'case.teaser.publish',{objectId:caseId,viewers:[f.responder.actor.subjectId]});await f.owner.cases.submitV2(f.owner.actor,rootEnvelope);
 const task={operationId:randomUUID(),taskId:randomUUID(),caseId,intent:'collaboration',title:'Current linked source',summary:'Explicit source context',workContext:{goal:'Original goal',currentSituation:'Original situation',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',capabilityId:'code',enrollmentExpiresAt:f.clock.now+3600};
 await f.owner.assistance.createTask(f.owner.actor,await f.owner.authorize(task,'assistance.publish',{objectId:task.operationId,viewers:[f.responder.actor.subjectId]}));
 const source={endpoint,kind:'case-event',id:caseId,version:1,caseId,taskId:task.taskId};
 const preview={id:randomUUID(),operationId:randomUUID(),source,grantee:f.responder.actor.subjectId,audience:{kind:'subjects',subjectIds:[f.responder.actor.subjectId]},expiresAt:f.clock.now+1800};
 bridge=createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const x=JSON.parse(Buffer.concat(chunks).toString());const who=x.other?f.responder:f.owner;let result;
  if(x.action==='sign')result={signed:await f.owner.signForTest(x.text,'galaxy-trust-source-permission-v1+jws')};
  else if(x.action==='revoke-source'){await pool.query('UPDATE consents SET revoked_at=to_timestamp($2) WHERE id=$1',[rootEnvelope.consentId,f.clock.now]);result={revoked:true};}
  else if(x.action==='advance'){f.clock.now+=x.seconds;result={now:f.clock.now};}
  else result=await who.trustPackages[x.action](who.actor,x.input);
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
 }catch(e){res.writeHead(e.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.code??e.message}));}});
 await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));await writeFile(join(dir,'fixture.json'),JSON.stringify({endpoint,now:f.clock.now,token:f.owner.credential,otherToken:f.responder.credential,preview,bridge:`http://127.0.0.1:${bridge.address().port}/fixture`}),{mode:0o600});console.log('ready');await new Promise(resolve=>process.stdin.once('data',resolve));
}finally{if(bridge){bridge.closeAllConnections();await new Promise(resolve=>bridge.close(resolve));}if(f)await f.close();await pool.end();}
