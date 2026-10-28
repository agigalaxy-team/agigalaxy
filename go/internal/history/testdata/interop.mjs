import pg from '../../../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {serviceFixture} from '../../../../packages/galaxy-official/test/service-fixture.mjs';
import {createServices} from '../../../../packages/galaxy-official/src/services.mjs';
import {migrate} from '../../../../packages/galaxy-official/src/infrastructure/database.mjs';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,basename} from 'node:path';
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated database required');
const [mode,path]=process.argv.slice(2);if(!isAbsolute(path??'')||basename(path)!=='history-fixture.json')throw Error('disposable fixture required');
const db=new pg.Pool({connectionString:address.href,max:8}),endpoint='https://history.example.invalid',now=()=>2000000000;
try{
 if(mode==='setup'){
  const scopes=['binding','consent','case-teaser','history'],f=await serviceFixture(scopes,db,{endpoint,now:now()}),other=await serviceFixture(scopes,db,{endpoint,now:now(),migrateDatabase:false});await migrate(db,{roles:['api']});
  const pub={visibility:'Public',purpose:'public-profile'},write=async(p,audience=pub)=>{const grant=await f.authorize(p,'case.teaser.publish',audience);await f.cases.submit(f.actor,grant);return grant};
  const root=(n,title)=>({kind:'case',id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,localRef:randomUUID(),title,summary:'Synthetic compiler regression report',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]});
  const publicCase=root(1,'Synthetic compiler \u2028 literal \\u2028 source');await write(publicCase);
  const attempt={kind:'attempt',id:randomUUID(),caseId:publicCase.id,expectedVersion:1,sequence:1,approach:'Owner-only reported approach',configuration:{environment:'Node',version:'24',tools:['private-tool']}};await write(attempt);
  const first={kind:'result',id:randomUUID(),caseId:publicCase.id,expectedVersion:2,attemptId:attempt.id,outcome:'succeeded',summary:'Owner reported success',failureReason:'',limitations:['Synthetic; no verified capability']};await write(first);
  const failed={...first,id:randomUUID(),expectedVersion:3,outcome:'failed',summary:'Later reported failure',failureReason:'Reported mismatch'};const failedGrant=await write(failed);
  await write({kind:'revision',id:randomUUID(),caseId:publicCase.id,expectedVersion:4,correctsEventId:first.id,reason:'Limit the earlier statement',summary:'Correction remains an author report'});
  const review=randomUUID();await write({kind:'revision',id:review,caseId:publicCase.id,expectedVersion:5,correctsEventId:failed.id,reason:'Open reported dispute',summary:'Not an independent decision',review:{threadId:review,type:'dispute',state:'opened'}});
  await write({kind:'revision',id:randomUUID(),caseId:publicCase.id,expectedVersion:6,correctsEventId:failed.id,reason:'Continue discussion',summary:'Case-owner state',review:{threadId:review,type:'dispute',state:'in-review'}});
  const hidden=root(2,'Private compiler hidden');await write(hidden,{});const shared=root(3,'Selected compiler report');await write(shared,{visibility:'Private',viewers:[other.actor.subjectId]});const later=root(4,'Later public compiler report');await write(later);
  const statement={id:randomUUID(),expectedRevision:0,selfDeclared:{displayName:'Actual ID declaration in isolated history',claimedCapabilities:['Self-declared only']},sharing:{visibility:'Public',viewers:[],expiresAt:null}};await f.profiles.publish(f.actor,await f.authorize(statement,'profile.publish',pub));
  await writeFile(path,JSON.stringify({endpoint,now:now(),owner:{subject:f.actor.subjectId,token:f.credential},viewer:{subject:other.actor.subjectId,token:other.credential},publicCase:publicCase.id,hidden:hidden.id,shared:shared.id,later:later.id,failedGrant,trustedKeys:[...f.bindings.trustedKeys]}),{mode:0o600});console.log('{}');
 }else if(mode==='query'){
  const f=JSON.parse(await readFile(path,'utf8')),server=generateKeyPairSync('ed25519'),services=createServices({db,endpoint,kid:'fixture',signingKey:server.privateKey,trustedKeys:new Map(f.trustedKeys),operator:'Isolated read-only history',region:'test',now,allowedScopes:['binding','consent','case-teaser','history']});let input='';for await(const b of process.stdin)input+=b;const queries=JSON.parse(input),results=[];
  for(const query of queries){const actor=query.actor?await services.access.authenticate(f[query.actor].token,'history'):null;try{results.push({value:await services.history.query(actor,query.input)})}catch(e){results.push({error:e.code??'internal_error',status:e.status??500})}}
  console.log(JSON.stringify({results}));
 }else throw Error('mode required');
}finally{await db.end()}
