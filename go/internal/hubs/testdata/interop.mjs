import pg from '../../../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {serviceFixture} from '../../../../packages/galaxy-official/test/service-fixture.mjs';
import {builderDeclaration} from '../../../../packages/galaxy-official/test/builders-workflow.mjs';
import {sampleCharter} from '../../../../packages/galaxy-official/test/hubs-workflow.mjs';
import {createServices} from '../../../../packages/galaxy-official/src/services.mjs';
import {migrate} from '../../../../packages/galaxy-official/src/infrastructure/database.mjs';
import {randomUUID,generateKeyPairSync,createHash} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import {isAbsolute,basename} from 'node:path';
const [mode,path]=process.argv.slice(2);let input='';for await(const chunk of process.stdin)input+=chunk;input=JSON.parse(input||'null');
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname)||!isAbsolute(path??'')||basename(path)!=='hub-fixture.json')throw Error('isolated database/temp fixture required');
const db=new pg.Pool({connectionString:address.href,max:6}),endpoint='https://hub.example.invalid',clock=2000000000,scopes=['binding','consent','builders'],hash=x=>createHash('sha256').update(x).digest('hex');
try{
 if(mode==='setup'){
  const owner=await serviceFixture(scopes,db,{endpoint,now:clock}),member=await serviceFixture(scopes,db,{endpoint,now:clock,migrateDatabase:false}),stranger=await serviceFixture(scopes,db,{endpoint,now:clock,migrateDatabase:false}),pub={visibility:'Public',purpose:'public-profile'},hubId=randomUUID(),d={id:randomUUID(),builderId:hubId,kind:'declare',expectedRevision:0,declaration:builderDeclaration('hub',owner.actor.subjectId)},dg=await owner.authorize(d,'builder.publish',pub);await owner.builders.publish(owner.actor,dg);
  const charter={schemaVersion:2,id:randomUUID(),kind:'charter',hubId,expectedVersion:0,declarationId:d.id,declarationHash:hash(dg.payloadJson),charter:sampleCharter(clock)},membershipId=randomUUID(),threadId=randomUUID(),base={schemaVersion:2,hubId},events={
   charter,invite:{...base,id:randomUUID(),kind:'invite',membershipId,memberId:member.actor.subjectId,expectedVersion:0,charterVersion:1,scopes:['approved-proof-query'],expiresAt:clock+500},
   acceptBad:{...base,id:randomUUID(),kind:'accept',membershipId,expectedVersion:1,charterVersion:1,acceptedScopes:['member-updates']},accept:{...base,id:randomUUID(),kind:'accept',membershipId,expectedVersion:1,charterVersion:1,acceptedScopes:['approved-proof-query']},
   intake:{...base,id:randomUUID(),kind:'intake-open',threadId,title:'Selected private issue',text:'Only this explicit synthetic message'},reply:{...base,id:randomUUID(),kind:'intake-reply',threadId,expectedVersion:1,text:'Operator reply to the original author'},close:{...base,id:randomUUID(),kind:'intake-close',threadId,expectedVersion:2,text:'Author closes selected thread'},
   charter2:{...charter,id:randomUUID(),expectedVersion:1,charter:{...charter.charter,name:'Updated synthetic charter'}},suspend:{...base,id:randomUUID(),kind:'suspend',expectedVersion:2},resume:{...base,id:randomUUID(),kind:'resume',expectedVersion:2},exit:{...base,id:randomUUID(),kind:'exit',membershipId,expectedVersion:2,charterVersion:1}
  },actors={owner,member,stranger},grants={};
  for(const [key,event]of Object.entries(events)){const who=['acceptBad','accept','exit'].includes(key)?member:['intake','close'].includes(key)?stranger:owner;let disclosure=key.startsWith('charter')?pub:{};if(key==='invite')disclosure={viewers:[member.actor.subjectId]};if(['acceptBad','accept','exit','intake','close'].includes(key))disclosure={viewers:[owner.actor.subjectId]};if(key==='reply')disclosure={viewers:[stranger.actor.subjectId]};grants[key]={actor:Object.entries(actors).find(([,a])=>a===who)[0],input:await who.authorize(event,'hub.publish',disclosure)};}
  await migrate(db,{roles:['api','worker']});await writeFile(path,JSON.stringify({endpoint,clock,hubId,membershipId,threadId,events,grants,actors:Object.fromEntries(Object.entries(actors).map(([key,f])=>[key,{subject:f.actor.subjectId,token:f.credential}])),pins:[...owner.access.trustedKeys]}),{mode:0o600});console.log('{}');
 }else if(mode==='read'){
  const f=JSON.parse(await readFile(path,'utf8')),key=generateKeyPairSync('ed25519'),s=createServices({db,endpoint,now:()=>input.clock??clock,kid:'unused',signingKey:key.privateKey,trustedKeys:new Map(f.pins),allowedScopes:scopes,operator:'Isolated',region:'test'}),results=[];
  for(const q of input.queries){const a=q.actor?await s.access.authenticate(f.actors[q.actor].token,'builders'):null;try{results.push({value:await s.hubs[q.method](a,q.input)})}catch(e){results.push({error:e.code,status:e.status})}}console.log(JSON.stringify({results}));
 }else throw Error('mode');
}finally{await db.end()}
