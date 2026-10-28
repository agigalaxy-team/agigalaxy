import pg from '../../../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {serviceFixture} from '../../../../packages/galaxy-official/test/service-fixture.mjs';
import {migrate,transaction} from '../../../../packages/galaxy-official/src/infrastructure/database.mjs';
import {AccessService} from '../../../../packages/galaxy-official/src/security/access.mjs';
import {ConsentReader} from '../../../../packages/galaxy-official/src/consents/consent-reader.mjs';
import {CaseService} from '../../../../packages/galaxy-official/src/cases/service.mjs';
import {caseEventSchema,caseEventV2Schema} from '../../../../packages/galaxy-official/src/shared/cases-schema.mjs';
import {projectCaseFacts} from '../../../../packages/galaxy-official/src/domain/intervention.mjs';
import {caseTaskLinkPayloadHash,legacyCaseTaskLinkPayloadHash} from '../../../../packages/galaxy-official/src/shared/case-operation-hash.mjs';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,basename} from 'node:path';
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated database required');
const [mode,path]=process.argv.slice(2);if(!isAbsolute(path??'')||basename(path)!=='case-fixture.json')throw Error('disposable fixture required');
const db=new pg.Pool({connectionString:address.href,max:8}),endpoint='https://cases.example.invalid',clock=2000000000,now=()=>clock;
try{
 if(mode==='setup'){
  const f=await serviceFixture(['binding','consent','case-teaser','assistance'],db,{endpoint,now:clock});await migrate(db,{roles:['api']});
  const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'  Actual author Case  ',summary:'  Reported, unverified  ',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
  const seed=await f.authorize(root);await f.cases.submit(f.actor,seed);
  const attempt={kind:'attempt',id:randomUUID(),caseId:root.id,expectedVersion:1,sequence:1,approach:'  Original author approach  ',configuration:{environment:' Node ',version:'24',tools:[]}};
  const result={kind:'result',id:randomUUID(),caseId:root.id,expectedVersion:2,attemptId:attempt.id,outcome:'failed',summary:'  Reported failure  ',failureReason:'diagnosed only',limitations:['not independently verified']};
  const thread=randomUUID(),review={kind:'revision',id:thread,caseId:root.id,expectedVersion:3,correctsEventId:result.id,reason:' open ',summary:' reported dispute ',review:{threadId:thread,type:'dispute',state:'opened'}};
  const stale={...attempt,id:randomUUID(),sequence:2,expectedVersion:1},badReview={...review,id:randomUUID(),expectedVersion:4,review:{...review.review,state:'reopened'}};
  const uncreated={...root,id:randomUUID(),localRef:randomUUID(),source:{kind:'local',reference:randomUUID()}};const rollback=await f.authorize(uncreated);await db.query('UPDATE consents SET revoked_at=to_timestamp($2) WHERE id=$1',[rollback.consentId,clock]);
  const newRoot={...root,id:randomUUID(),localRef:randomUUID(),source:{kind:'local',reference:randomUUID()}};const newGrant=await f.authorize(newRoot);
  const requests=[];for(const p of [attempt,result,review,stale,badReview])requests.push(await f.authorize(p));
  const caseId=randomUUID(),common={caseId,actorId:f.actor.subjectId},v2root={...common,kind:'case-created',eventId:caseId,expectedVersion:0,localRef:randomUUID(),title:'Actual v2 reports',summary:'Original work facts',source:{kind:'local',reference:randomUUID()},synthetic:false},v2grant=p=>f.authorize(p,'case.teaser.publish',{objectId:p.eventId,visibility:'Public',purpose:'public-profile'});await f.cases.submitV2(f.actor,await v2grant(v2root));
  const start={...common,kind:'attempt-start',eventId:randomUUID(),expectedVersion:1,role:'author',strategy:'Reported approach',inputScopeSummary:'Synthetic isolated input',permissionScope:['local test'],startedAt:'2033-05-18T03:33:20.000Z'},intervention={...common,kind:'intervention',eventId:randomUUID(),expectedVersion:2,types:['advice'],affectsAttemptIds:[start.eventId],description:'Author intervention',sourceRefs:[],observedEffect:'Reported only'},response={...common,kind:'intervention-response',eventId:randomUUID(),expectedVersion:3,interventionRef:{id:intervention.eventId,version:1},state:'partial',summary:'Self reply'},end={...common,kind:'attempt-end',eventId:randomUUID(),expectedVersion:4,attemptRef:{id:start.eventId,version:1},status:'completed',summary:'Author ended work',reportedOutcome:'partial',failureReason:'Unknown external condition',endedAt:'2033-05-18T03:33:21.000Z'},recorded={...common,kind:'result-recorded',eventId:randomUUID(),expectedVersion:5,origin:{kind:'attempt',id:start.eventId,version:2},scopeVersion:1,deliverableRefs:[],reportedOutcome:'partial',summary:'Original result',limitations:'Reported only'},resolution={...common,kind:'resolution-recorded',eventId:randomUUID(),expectedVersion:6,taskScopeVersion:1,status:'partially-resolved',summary:'Requester decision',satisfiedGoals:['  initial goal  '],remainingGoals:['unknown'],resultRefs:[{id:recorded.eventId,version:1}],verificationRefs:[],supersedesResolutionId:null},correction={...recorded,eventId:randomUUID(),expectedVersion:7,reportedOutcome:'failed',summary:'Later correction',supersedes:{id:recorded.eventId,version:1}},laterResponse={...response,eventId:randomUUID(),expectedVersion:8,state:'accepted'},unavailable={...intervention,eventId:randomUUID(),expectedVersion:9,sourceRefs:[{kind:'evidence',id:randomUUID(),version:1}]};
  const v2events=[start,intervention,response,end,recorded,resolution,correction,laterResponse,unavailable],v2requests=[];for(const p of v2events)v2requests.push(await v2grant(p));
  await writeFile(path,JSON.stringify({endpoint,clock,owner:{subject:f.actor.subjectId,token:f.credential},root,seed,attempt,result,review,requests,rollback,uncreated,newRoot,newGrant,v2root,v2events,v2requests}),{mode:0o600});console.log('{}');
 }else if(mode==='read'||mode==='v2'){
  const f=JSON.parse(await readFile(path,'utf8')),access=new AccessService({db,endpoint,now}),cases=new CaseService(access,new ConsentReader({now})),a=await access.authenticate(f.owner.token,'case-teaser');
  if(mode==='v2')console.log(JSON.stringify({v2:await cases.getV2(a,f.v2root.caseId)}));else console.log(JSON.stringify({value:await cases.get(a,f.root.id),facts:await transaction(db,async tx=>{const parent=(await tx.query('SELECT * FROM cases WHERE id=$1',[f.root.id])).rows[0],rows=(await tx.query('SELECT * FROM case_events WHERE case_id=$1 ORDER BY version',[f.root.id])).rows;return projectCaseFacts(rows,parent)}),v2:await cases.getV2(a,f.v2root.caseId)}));
 }else if(mode==='pure'){
  let input='';for await(const c of process.stdin)input+=c;const x=JSON.parse(input);console.log(JSON.stringify({schemas:x.schemas.map(p=>{const v=(p.eventId?caseEventV2Schema:caseEventSchema).safeParse(p);return v.success?{accepted:true,value:v.data}:{accepted:false}}),facts:projectCaseFacts(x.rows,x.parent),hashes:x.link?{current:caseTaskLinkPayloadHash(x.link),legacy:legacyCaseTaskLinkPayloadHash(x.link)}:null}));
 }else throw Error('mode required');
}finally{await db.end()}
