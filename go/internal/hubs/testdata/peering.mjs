import pg from '../../../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {serviceFixture} from '../../../../packages/galaxy-official/test/service-fixture.mjs';
import {createServices} from '../../../../packages/galaxy-official/src/services.mjs';
import {hubScopes,prepareHub} from '../../../../packages/galaxy-official/test/hub-peering-workflow.mjs';
import {createPeeringProof} from '../../../../packages/galaxy-official/test/hub-ci-proof-fixture.mjs';
import {peeringEventSchema} from '../../../../packages/galaxy-official/src/shared/hub-peering-v2-schema.mjs';
import {migrate} from '../../../../packages/galaxy-official/src/infrastructure/database.mjs';
import {createPrivateKey,randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {basename,isAbsolute} from 'node:path';
import {createInterface} from 'node:readline';
const [path]=process.argv.slice(2),address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname)||!isAbsolute(path??'')||basename(path)!=='peering-fixture.json')throw Error('isolated fixture required');
const config=JSON.parse(await readFile(path,'utf8'));if(!['https://a.example.invalid','https://b.example.invalid'].includes(config.endpoint))throw Error('synthetic endpoint required');
const db=new pg.Pool({connectionString:address.href,max:6}),clock=2000000000,now=()=>clock,hash=x=>createHash('sha256').update(x).digest('hex'),pins=new Map([['go-fixture',{publicKeyPem:config.publicKeyPem,notBefore:clock-1,notAfter:clock+200000,revoked:false}]]);
try{
 const base=await serviceFixture(hubScopes,db,{endpoint:config.endpoint,now:clock}),services=createServices({db,endpoint:config.endpoint,kid:'go-fixture',signingKey:createPrivateKey(config.privateKeyPem),trustedKeys:pins,now,allowedScopes:hubScopes,operator:'Isolated peer',region:'test'}),f={...base,...services},hubId=await prepareHub(f);
 let source=null,proof=null,root=null,factAuth=null;
 if(config.includeProof){
  const id=randomUUID();root={schemaVersion:2,eventId:id,caseId:id,kind:'case-created',expectedVersion:0,actorId:f.actor.subjectId,localRef:randomUUID(),title:'PRIVATE_SYNTHETIC_TITLE',summary:'PRIVATE_SYNTHETIC_CONTEXT',source:{kind:'local',reference:randomUUID()},synthetic:true};await f.cases.submitV2(f.actor,await f.authorize(root,'case.teaser.publish',{objectId:id}));
  const intervention={schemaVersion:2,eventId:randomUUID(),caseId:id,kind:'intervention',expectedVersion:1,actorId:f.actor.subjectId,types:['diagnosis'],affectsAttemptIds:[],description:'PRIVATE_SYNTHETIC_DIAGNOSIS',sourceRefs:[],observedEffect:'Only a reported observation'};factAuth=await f.authorize(intervention,'case.teaser.publish',{objectId:intervention.eventId});await f.cases.submitV2(f.actor,factAuth);
  source={kind:'contribution-summary',source:{kind:'case-event',id:intervention.eventId,eventVersion:1,payloadHash:hash(factAuth.payloadJson)},fields:['eventType','actorId','interventionTypes']};proof=await createPeeringProof(f,root,intervention);
 }
 await migrate(db,{roles:['api','worker']});console.log(JSON.stringify({ready:true,endpoint:config.endpoint,hubId,subject:f.actor.subjectId,token:f.credential,source,proof,caseId:root?.caseId,factConsentId:factAuth?.consentId,pin:[...pins][0][1]}));
 const lines=createInterface({input:process.stdin,terminal:false});let tail=Promise.resolve();
 for await(const line of lines){tail=tail.then(async()=>{try{const q=JSON.parse(line);let value;
  if(q.action==='authorize')value=await f.authorize(peeringEventSchema.parse(q.payload),q.kind??'hub.publish',q.disclosure??{});
  else if(q.action==='revoke')value=await f.consents.revoke(f.actor,q.id);
  else if(q.action==='read')value=await f.peering[q.method](f.actor,q.input);
  else if(q.action==='transport'){if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(q.origin)||!['https://a.example.invalid','https://b.example.invalid'].includes(q.peer))throw Error('isolated transport only');f.peering.send=async(url,{bodyJson})=>{if(url!==q.peer+'/v2/hubs/peering/exchange')throw Error('exact selected peer only');const response=await fetch(q.origin+'/v2/hubs/peering/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:bodyJson});if(!response.ok)throw Error('isolated peer unavailable');return response.json()};value={configured:true};}
  else throw Error('action');console.log(JSON.stringify({value:value??null}));
 }catch(e){console.log(JSON.stringify({error:e.code??'fixture_error',status:e.status??500,message:e.message}));}});await tail;}
}finally{await db.end()}
