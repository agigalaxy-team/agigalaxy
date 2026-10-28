import pg from '../../../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {serviceFixture} from '../../../../packages/galaxy-official/test/service-fixture.mjs';
import {createServices} from '../../../../packages/galaxy-official/src/services.mjs';
import {migrate} from '../../../../packages/galaxy-official/src/infrastructure/database.mjs';
import {inspectGithubRun} from '../../../../packages/galaxy-official/src/evidence/github-evidence.mjs';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,basename} from 'node:path';
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated database required');
const [mode,path]=process.argv.slice(2);if(!isAbsolute(path??'')||basename(path)!=='evidence-fixture.json')throw Error('disposable fixture required');
const db=new pg.Pool({connectionString:address.href,max:8}),endpoint='https://evidence.example.invalid',clock=2000000000,now=()=>clock;let input='';for await(const c of process.stdin)input+=c;input=JSON.parse(input||'{}');
try{
 if(mode==='setup'){
  const f=await serviceFixture(['binding','consent','case-teaser','evidence','proof'],db,{endpoint,now:clock});await migrate(db,{roles:['api','worker']});const pub={visibility:'Public',purpose:'public-profile'};
  const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'CI source fixture',summary:'An author report only',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};await f.cases.submit(f.actor,await f.authorize(root,'case.teaser.publish',pub));const attempt={kind:'attempt',id:randomUUID(),caseId:root.id,expectedVersion:1,sequence:1,approach:'Controlled reference',configuration:{environment:'fixture',version:'1',tools:[]}};await f.cases.submit(f.actor,await f.authorize(attempt,'case.teaser.publish',pub));const result={kind:'result',id:randomUUID(),caseId:root.id,expectedVersion:2,attemptId:attempt.id,outcome:'partial',summary:'Reported result',failureReason:'',limitations:['Not a verified capability']};await f.cases.submit(f.actor,await f.authorize(result,'case.teaser.publish',pub));
  const reference={provider:'github-actions',owner:'Fixture',repository:'Synthetic',runId:11,attempt:1,commit:'a'.repeat(40)},make=n=>({id:randomUUID(),caseId:root.id,resultId:result.id,source:{...reference,runId:n}}),first=make(11),second=make(12),third=make(13),fourth=make(14);
  const run={id:11,run_attempt:1,head_sha:reference.commit,status:'completed',conclusion:'success',repository:{full_name:'Fixture/Synthetic',private:false,id:77,owner:{id:3,login:'Fixture',type:'Organization'}},updated_at:'2033-05-18T03:33:20.000Z',syntheticNote:'\u2028 literal \\u2028'};
  await f.evidence.submit(f.actor,await f.authorize(first,'evidence.submit'));await f.evidence.processNext(async(r,at)=>inspectGithubRun(r,{...run,id:r.runId},at));
  const seedID=randomUUID(),seedPreview=await f.proofs.preview(f.actor,{id:seedID,evidenceId:first.id}),seedGrant=await f.authorize(JSON.parse(seedPreview.payloadJson),'proof.publish',pub),seedProof=await f.proofs.publish(f.actor,seedGrant);
  const nextID=randomUUID(),nextPreview=await f.proofs.preview(f.actor,{id:nextID,evidenceId:first.id}),nextGrant=await f.authorize(JSON.parse(nextPreview.payloadJson),'proof.publish',pub);
  await f.evidence.submit(f.actor,await f.authorize(second,'evidence.submit'));await f.evidence.submit(f.actor,await f.authorize(fourth,'evidence.submit'));const thirdGrant=await f.authorize(third,'evidence.submit');
  const revision={kind:'revision',id:randomUUID(),caseId:root.id,expectedVersion:3,correctsEventId:result.id,reason:'Limit original interpretation',summary:'Reported correction'};await f.cases.submit(f.actor,await f.authorize(revision,'case.teaser.publish',pub));
  const pins=[...f.access.trustedKeys,['go-fixture',{publicKeyPem:input.publicKey,notBefore:clock-1,notAfter:clock+200000,revoked:false}]];
  await writeFile(path,JSON.stringify({endpoint,clock,owner:{subject:f.actor.subjectId,token:f.credential},root,first,second,third,fourth,thirdGrant,seedID,seedGrant,seedProof,nextID,nextPreview,nextGrant,pins,runJson:JSON.stringify(run)}),{mode:0o600});console.log('{}');
 }else if(mode==='read'){
  const f=JSON.parse(await readFile(path,'utf8')),key=generateKeyPairSync('ed25519'),services=createServices({db,endpoint,now,trustedKeys:new Map(f.pins),kid:'unused-fixture',signingKey:key.privateKey,allowedScopes:['binding','consent','case-teaser','evidence','proof'],operator:'Isolated read oracle',region:'test'}),{access,evidence,proofs}=services,a=await access.authenticate(f.owner.token,'proof'),seed=await proofs.get(null,f.seedID),next=await proofs.get(null,f.nextID);
  console.log(JSON.stringify({seed,next,seedWire:JSON.stringify(seed),nextWire:JSON.stringify(next),second:await evidence.get(a,f.second.id),third:await evidence.get(a,f.third.id),preview:await proofs.preview(a,{id:f.nextID,evidenceId:f.first.id}),history:await services.history.query(null,{subjectId:f.owner.subject})}));
 }else if(mode==='source'){const values=input.map(x=>{try{return{value:inspectGithubRun(x.reference,x.run,clock)}}catch{return{rejected:true}}});console.log(JSON.stringify({values}));}
 else throw Error('mode required');
}finally{await db.end()}


