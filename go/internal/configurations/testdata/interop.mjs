import pg from '../../../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {serviceFixture} from '../../../../packages/galaxy-official/test/service-fixture.mjs';
import {createServices} from '../../../../packages/galaxy-official/src/services.mjs';
import {migrate,transaction} from '../../../../packages/galaxy-official/src/infrastructure/database.mjs';
import {configurationEventV2Schema} from '../../../../packages/galaxy-official/src/shared/configuration-v2-schema.mjs';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,basename} from 'node:path';
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated database required');
const [mode,path]=process.argv.slice(2);if(!isAbsolute(path??'')||basename(path)!=='configuration-fixture.json')throw Error('disposable fixture required');
const db=new pg.Pool({connectionString:address.href,max:8}),endpoint='https://configuration.example.invalid',clock=2000000000,now=()=>clock,scopes=['binding','consent','history','case-teaser','evidence','proof'];let input='';for await(const c of process.stdin)input+=c;input=JSON.parse(input||'null');
try{
 if(mode==='setup'){
  const f=await serviceFixture(scopes,db,{endpoint,now:clock});await migrate(db,{roles:['api']});const pub=input?.privateForGrant?{}:{visibility:'Public',purpose:'public-profile'},conditions={model:{name:null,version:null},runtime:{name:'Go',version:'reported'},environment:{name:'Controlled fixture',version:null},tools:[{name:'Selected tool',version:null,reference:'Author reference'}],skills:[],mcp:[],promptPolicyVersion:null,rulesVersion:null,operationScope:['Selected local text'],inputScopeSummary:'No original prompts',limitations:'Author-reported only'};
  const first={schemaVersion:2,id:randomUUID(),operationId:randomUUID(),expectedVersion:0,actorId:f.actor.subjectId,kind:'record',title:'  Original selected configuration  ',summary:'Author-reported conditions',conditions,observedAt:new Date(clock*1000).toISOString(),synthetic:false,selectedFieldsOnly:true},grant=p=>f.authorize(p,'configuration.publish',{...pub,objectId:p.operationId});const firstGrant=await grant(first);await f.configurations.submit(f.actor,firstGrant);
  const second={...first,operationId:randomUUID(),expectedVersion:1,conditions:{...conditions,limitations:'Current explicit correction'}},secondGrant=await grant(second),revoke={schemaVersion:2,id:first.id,operationId:randomUUID(),expectedVersion:2,actorId:f.actor.subjectId,kind:'revoke',reason:'Author revokes source'},revokeGrant=await grant(revoke),rollback={...first,id:randomUUID(),operationId:randomUUID()},rollbackGrant=await grant(rollback);
  const caseId=randomUUID(),root={caseId,actorId:f.actor.subjectId,kind:'case-created',eventId:caseId,expectedVersion:0,localRef:randomUUID(),title:'Configuration source history',summary:'No equivalence inferred',source:{kind:'local',reference:randomUUID()},synthetic:false},attempt={caseId,actorId:f.actor.subjectId,kind:'attempt-start',eventId:randomUUID(),expectedVersion:1,role:'author',strategy:'Selected reported conditions',configurationRef:{id:first.id,version:1},inputScopeSummary:'Source text',permissionScope:['test']};for(const p of [root,attempt])await f.cases.submitV2(f.actor,await f.authorize(p,'case.teaser.publish',{...pub,objectId:p.eventId}));
  await writeFile(path,JSON.stringify({endpoint,clock,owner:{subject:f.actor.subjectId,token:f.credential},first,firstGrant,second,secondGrant,revoke,revokeGrant,rollback,rollbackGrant,caseId,pins:[...f.access.trustedKeys]}),{mode:0o600});console.log('{}');
 }else if(mode==='read'){
  const f=JSON.parse(await readFile(path,'utf8')),key=generateKeyPairSync('ed25519'),s=createServices({db,endpoint,now,trustedKeys:new Map(f.pins),kid:'unused',signingKey:key.privateKey,allowedScopes:scopes,operator:'Isolated oracle',region:'test'}),results=[];
  for(const q of input){const actor=q.actor?await s.access.authenticate(f.owner.token,'history'):null;try{let value;if(q.kind==='condition')value=await transaction(db,tx=>s.configurations.conditionWithin(tx,actor,q.input));else if(q.kind==='history')value=await s.history.v2.query(actor,q.input);else value=await s.configurations[q.kind](actor,q.input);results.push({value})}catch(e){results.push({error:e.code??'internal_error',status:e.status??500})}}console.log(JSON.stringify({results}));
 }else if(mode==='grant-read'){
  const f=JSON.parse(await readFile(path,'utf8')),key=generateKeyPairSync('ed25519'),s=createServices({db,endpoint,now,trustedKeys:new Map(f.pins),kid:'unused',signingKey:key.privateKey,allowedScopes:scopes,operator:'Isolated oracle',region:'test'}),author={subjectId:f.owner.subject};
  console.log(JSON.stringify(await transaction(db,async tx=>({condition:await s.configurations.conditionWithin(tx,author,{id:f.first.id,version:1}),case:await s.cases.readV2Within(tx,author,f.caseId)}))));
 }else if(mode==='schema'){console.log(JSON.stringify({values:input.map(x=>{const p=configurationEventV2Schema.safeParse(x);return p.success?{value:p.data}:{error:true}})}));}
 else throw Error('mode');
}finally{await db.end()}
