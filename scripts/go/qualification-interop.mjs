// Original services on disposable loopback PostgreSQL only. No real worker,
// upstream evidence provider, browser, SMTP, or production directory is used.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {communityForumFixture} from '../../packages/galaxy-official/test/community-forum-fixture.mjs';
import {migrate,transaction} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {QualificationService} from '../../packages/galaxy-official/src/qualifications/qualification.mjs';
import {QualificationV2Service} from '../../packages/galaxy-official/src/qualifications/qualification-v2.mjs';
import {digest} from '../../packages/galaxy-official/src/shared/digest.mjs';
import {cleanupQualificationRequestsWithin} from '../../packages/galaxy-official/src/operations/qualification-request-retention-v2.mjs';
import {ExperienceReviewService} from '../../packages/galaxy-official/src/evidence/experience-review.mjs';
import {experienceEventSchema} from '../../packages/galaxy-official/src/shared/experience-review-schema.mjs';
import {HonorService} from '../../packages/galaxy-official/src/records/honor.mjs';
import {HonorV2Service} from '../../packages/galaxy-official/src/records/honor-v2.mjs';
import {assessContributionRisk} from '../../packages/galaxy-official/src/domain/contribution-risk.mjs';
import {paginateHonor} from '../../packages/galaxy-official/src/domain/honor-pagination.mjs';
import canonicalize from '../../packages/galaxy-official/node_modules/canonicalize/lib/canonicalize.js';
import {choicePutIntent} from '../../packages/galaxy-official/src/shared/choice-snapshot-schema-v2.mjs';
import {searchV2ReferenceSchema} from '../../packages/galaxy-official/src/shared/search-v2-schema.mjs';
import * as choiceSchemas from '../../packages/galaxy-official/src/shared/choice-snapshot-schema-v2.mjs';
if(process.argv[2]==='experience-schema'){const inputs=JSON.parse(await readFile(process.argv[3],'utf8'));console.log(JSON.stringify(inputs.map(raw=>{try{return{accepted:true,json:JSON.stringify(experienceEventSchema.parse(JSON.parse(raw)))}}catch{return{accepted:false}}})));process.exit(0);}
if(process.argv[2]==='honor-algorithms'){const x=JSON.parse(await readFile(process.argv[3],'utf8')),risk=assessContributionRisk(x.items,{complete:true,checkedAt:x.now,subjectId:'a',network:{contributions:x.items,complete:true}}),view={card:{sourceFingerprint:'f',evidence:[],proofs:[]},contributions:x.items,riskAssessment:risk};console.log(JSON.stringify({risk,paged:paginateHonor(view,{riskIndex:risk.flags.length-1,riskReferenceAfter:1,limit:1})}));process.exit(0);}
if(process.argv[2]==='choice-schema'){const names={'preferences/save':'choicePreferenceSchema',get:'choiceGetSchema',list:'choicePageSchema',delete:'choiceDeleteSchema',receipt:'choiceReceiptQuerySchema',put:'choicePutSchema'},inputs=JSON.parse(await readFile(process.argv[3],'utf8'));console.log(JSON.stringify(inputs.map(x=>{let value;try{value=choiceSchemas[names[x.action]].parse(JSON.parse(x.raw))}catch{return{accepted:false}}const result={accepted:true,json:JSON.stringify(value)};if(x.action==='put'){try{result.hash=digest(canonicalize(choicePutIntent(value)))}catch{result.hashError=true}}return result})));process.exit(0);}

const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated PostgreSQL required');
const dir=process.env.GALAXY_GO_TEST_QUALIFICATION_DIR;if(!isAbsolute(dir??''))throw Error('absolute disposable directory required');
const pool=new pg.Pool({connectionString:address.href,max:4}),endpoint='https://qualification.example.invalid';
let f,bridge;
try{
 await migrate(pool,{roles:['api','worker']});f=await communityForumFixture({database:pool,migrateDatabase:false,endpoint});
 await f.login(f.owner,'qualification-owner');await f.login(f.responder,'qualification-participant');
 const caseId=randomUUID(),caseEvent={kind:'case',id:caseId,localRef:'qualification-'+caseId,title:'Current eligibility source',summary:'Participant-reported source only',source:{kind:'local',reference:'qualification-'+caseId},participants:[{subjectId:f.owner.actor.subjectId,role:'requester'},{subjectId:f.responder.actor.subjectId,role:'provider'}]};
 await f.owner.cases.submit(f.owner.actor,await f.owner.authorize(caseEvent,'case.teaser.publish',{objectId:caseId,viewers:[f.responder.actor.subjectId]}));
 const attempt={kind:'attempt',id:randomUUID(),caseId,expectedVersion:1,sequence:1,approach:'Original local attempt',configuration:{environment:'isolated',version:'1',tools:[]}};
 await f.owner.cases.submit(f.owner.actor,await f.owner.authorize(attempt,'case.teaser.publish',{objectId:attempt.id,viewers:[f.responder.actor.subjectId]}));
 const request={id:randomUUID(),caseId,title:'Explicit collaboration',problem:'Current selected source',attemptedApproaches:['Original attempt'],scope:'Agreed participant scope',visibility:'Private',collaboration:'open-assistance',capabilityId:'code',enrollmentExpiresAt:f.clock.now+3600};
 await f.owner.assistance.create(f.owner.actor,await f.owner.authorize(request,'assistance.publish',{objectId:request.id,viewers:[f.responder.actor.subjectId]}));
 const offer=randomUUID(),delivery=randomUUID();let version=1,confirmation;
 for(const [who,fields] of [[f.responder,{kind:'offer',id:offer,proposal:'Participant proposal',scope:'Original scope'}],[f.owner,{kind:'select',offerId:offer}],[f.responder,{kind:'confirm'}],[f.responder,{kind:'deliver',id:delivery,attemptId:attempt.id,summary:'Participant reports result',evidenceIds:[],caseReviewVersion:0}],[f.owner,{kind:'accept',deliveryId:delivery,summary:'Requester acknowledges reported work'}]]){
  const event={id:randomUUID(),expectedVersion:version++,...fields},payload={assistanceId:request.id,event},input=await who.authorize(payload,'assistance.publish',{objectId:event.id,viewers:[who===f.owner?f.responder.actor.subjectId:f.owner.actor.subjectId]});await f.owner.assistance.submit(who.actor,request.id,input);if(event.kind==='confirm')confirmation={who,event,input};
 }
 const policy={id:'selected-history',version:'1',capabilityId:'code',title:'Current explicit sources',collaboration:'open-assistance',notBefore:f.clock.now-1,notAfter:f.clock.now+3600,minProofs:0,minAcceptedCollaborations:1,historyWindowSeconds:86400,requireCiSuccess:false,repositories:[]};
 const qualification=new QualificationService(f.owner.access,f.owner.proofs,f.owner.assistance,[policy]);
 const query={policyId:policy.id,policyVersion:policy.version,capabilityId:'code',subjectId:f.responder.actor.subjectId,evidence:{proofIds:[],assistanceIds:[request.id]}};
 f.owner.assistance.qualification=qualification;
 const v2CaseId=randomUUID(),v2Root={schemaVersion:2,kind:'case-created',eventId:v2CaseId,caseId:v2CaseId,expectedVersion:0,actorId:f.owner.actor.subjectId,localRef:'qualification-v2-'+v2CaseId,title:'Scoped real participant source',summary:'Explicit actual report',source:{kind:'local',reference:'qualification-v2-'+v2CaseId},synthetic:false};
 await f.owner.cases.submitV2(f.owner.actor,await f.owner.authorize(v2Root,'case.teaser.publish',{objectId:v2CaseId,viewers:[f.responder.actor.subjectId]}));
 const makeTask=async(extra={})=>{const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'collaboration',title:'Current task eligibility',summary:'Explicit selected work',workContext:{goal:'Original goal',currentSituation:'Original current situation',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',capabilityId:'code',enrollmentExpiresAt:f.clock.now+3600,...extra};await f.owner.assistance.createTask(f.owner.actor,await f.owner.authorize(task,'assistance.publish',{objectId:task.operationId,viewers:[f.responder.actor.subjectId]}));return task;};
 const sourceTask=await makeTask({caseId:v2CaseId}),targetTask=await makeTask({qualification:{policyId:policy.id,policyVersion:policy.version,profile:'facts-v2'}}),participationId=randomUUID();
 const proposal={eventId:randomUUID(),expectedTaskVersion:1,kind:'propose',participationId,subjectId:f.responder.actor.subjectId,role:'contribution',scopeVersion:1,agreedScope:'Current agreed work scope'};
 await f.owner.assistance.proposeParticipation(f.owner.actor,sourceTask.taskId,await f.owner.authorize(proposal,'assistance.publish',{objectId:proposal.eventId,viewers:[f.responder.actor.subjectId]}));
 const confirm={eventId:randomUUID(),expectedParticipationVersion:1,kind:'confirm',scopeVersion:1};
 await f.owner.assistance.submitParticipationEvent(f.responder.actor,participationId,await f.responder.authorize(confirm,'assistance.publish',{objectId:confirm.eventId,viewers:[f.owner.actor.subjectId]}));
 const common={schemaVersion:2,caseId:v2CaseId,actorId:f.responder.actor.subjectId,taskId:sourceTask.taskId,participationId,taskScopeVersion:1,participationScopeVersion:1};
 const v2Attempt={...common,kind:'attempt-start',eventId:randomUUID(),expectedVersion:1,role:'contribution',strategy:'Explicit participant-reported work',inputScopeSummary:'Current selected source',permissionScope:['selected-context']};
 const started=await f.responder.cases.submitV2(f.responder.actor,await f.responder.authorize(v2Attempt,'case.teaser.publish',{objectId:v2Attempt.eventId,viewers:[f.owner.actor.subjectId]}));
 const fact={...common,kind:'result-recorded',eventId:randomUUID(),expectedVersion:2,origin:{kind:'attempt',...started.objectRef},scopeVersion:1,deliverableRefs:[],reportedOutcome:'partial',summary:'Reported scoped result',limitations:'Participant reported; no independent verification'};
 const recorded=await f.responder.cases.submitV2(f.responder.actor,await f.responder.authorize(fact,'case.teaser.publish',{objectId:fact.eventId,viewers:[f.owner.actor.subjectId]}));
 const v2Delivery={eventId:randomUUID(),expectedParticipationVersion:2,kind:'deliver',resultRef:recorded.objectRef,interventionRefs:[],evidenceRefs:[],summary:'Deliver selected result'};
 await f.owner.assistance.submitParticipationEvent(f.responder.actor,participationId,await f.responder.authorize(v2Delivery,'assistance.publish',{objectId:v2Delivery.eventId,viewers:[f.owner.actor.subjectId]}));
 const v2Accept={eventId:randomUUID(),expectedParticipationVersion:3,kind:'accept',deliveryId:v2Delivery.eventId,summary:'Requester accepts reported work'};
 const acceptInput=await f.owner.authorize(v2Accept,'assistance.publish',{objectId:v2Accept.eventId,viewers:[f.responder.actor.subjectId]});await f.owner.assistance.submitParticipationEvent(f.owner.actor,participationId,acceptInput);
 const calculations=f.owner.qualificationCalculations;
 const v2=new QualificationV2Service(qualification,{cases:f.owner.cases,assistance:f.owner.assistance,calculations});
 const v2Query={taskId:targetTask.taskId,subjectId:f.responder.actor.subjectId,evidence:{participationIds:[participationId]},includeSimulation:true};
 const sourceRows=[...(await pool.query('SELECT id,subject_id,payload_hash FROM task_events WHERE task_id=$1 ORDER BY id',[sourceTask.taskId])).rows.map(r=>({...r,kind:'task-event'})),...(await pool.query('SELECT id,subject_id,payload_hash FROM case_events WHERE case_id=$1 ORDER BY id',[v2CaseId])).rows.map(r=>({...r,kind:'case-event'}))];
 const sourceRefs=sourceRows.map(r=>({kind:r.kind,id:r.id,eventVersion:1,payloadHash:r.payload_hash}));
 const commonGrant={taskId:targetTask.taskId,candidateId:f.responder.actor.subjectId,recipientId:f.owner.actor.subjectId,purpose:'this-task-eligibility-computation-only',expiresAt:new Date((f.clock.now+1800)*1000).toISOString(),disclosure:'public-conditions-and-bounded-satisfaction-only; no-source-text-or-other-party-identity'};
 const permission={...commonGrant,id:randomUUID(),kind:'source-permission',sourceRefs:sourceRefs.filter((_,i)=>sourceRows[i].subject_id===f.owner.actor.subjectId)};
 const permissionInput=await f.owner.authorize(permission,'qualification.source-permission',{objectId:permission.id,viewers:[f.responder.actor.subjectId]});
 const selectedEvidence={participationIds:[participationId],externalReviewRefs:[],capsuleUseIds:[],proofIds:[],assistanceIds:[]};
 const compute={...commonGrant,id:randomUUID(),kind:'compute',permissionIds:[permission.id],sourceRefs,evidence:selectedEvidence};
 const computeInput=await f.responder.authorize(compute,'qualification.compute',{objectId:compute.id,viewers:[f.owner.actor.subjectId]});
 const revoke={id:randomUUID(),kind:'revoke',grantId:compute.id,reason:'Explicit participant withdrawal'};
 const revokeInput=await f.responder.authorize(revoke,'qualification.compute',{objectId:revoke.id});
 const calculationQuery={...v2Query,evidence:{...selectedEvidence,calculationGrantId:compute.id}};
 const requests=f.owner.qualificationRequests;requests.qualification=v2;
 const requestId=randomUUID(),requestEvent={eventId:randomUUID(),requestId,expectedVersion:0,kind:'request',taskId:targetTask.taskId,sourceAuthorId:f.owner.actor.subjectId,participationIds:[participationId],externalReviewRefs:[],sourceRefs:permission.sourceRefs,expiresAt:commonGrant.expiresAt,purpose:'request-scoped-qualification-permission-only; no-permission-granted'};
 const requestCommands=[];
 for(const [who,event] of [[f.responder,requestEvent],[f.owner,{eventId:randomUUID(),requestId,expectedVersion:1,kind:'record-permission',grantId:permission.id}],[f.responder,{eventId:randomUUID(),requestId,expectedVersion:2,kind:'cancel',reason:'Cancel this permission request only'}]]){const input=await who.authorize(event,'qualification.request',{objectId:event.eventId,viewers:[who===f.owner?f.responder.actor.subjectId:f.owner.actor.subjectId]});requestCommands.push({author:who===f.responder,input,receipt:{eventId:event.eventId,payloadHash:digest(input.payloadJson)}});}
 const planQuery={taskId:targetTask.taskId,participationIds:[participationId],externalReviewRefs:[],expiresAt:commonGrant.expiresAt};
 const experienceReviewer={subjectId:f.owner.actor.subjectId,capabilityIds:['code'],kinds:['external-work','challenge'],scope:'Explicit local scoped reviewer',notBefore:f.clock.now-1,notAfter:f.clock.now+3600,authorityReference:'Isolated configured review authority',synthetic:false};
 const experiences=new ExperienceReviewService(f.owner.access,f.owner.consents,{reviewers:[experienceReviewer],resolveControllerWithin:f.owner.experienceReviews.resolveControllerWithin});v2.experienceReviews=experiences;
 const experienceId=randomUUID(),reviewId=randomUUID(),stableRecord='fixture:'+experienceId;
 const declaration={id:experienceId,operationId:randomUUID(),expectedVersion:0,reportedBy:f.responder.actor.subjectId,synthetic:false,kind:'external-work',subjectId:f.responder.actor.subjectId,capabilityId:'code',source:{system:'Explicit External Source \ud800',stableRecord,originalAt:new Date(f.clock.now*1000).toISOString(),originalAuthor:'Original declared author',links:['https://example.invalid/selected'],contentVersion:'1'},actualIntervention:'Participant declares scoped work',resultReference:'Explicit declared result',outcome:'partial',scope:'Declared scoped work \ud800',limitations:['No automatic external verification'],ownershipStatement:'Original author reports ownership'};
 const review={id:reviewId,operationId:randomUUID(),expectedVersion:0,reportedBy:f.owner.actor.subjectId,synthetic:false,kind:'review',experienceRef:{id:experienceId,version:1},capabilityId:'code',state:'verified-in-scope',scope:'Scoped review claim \udc00',observedAt:new Date(f.clock.now*1000).toISOString(),checked:{source:true,attribution:true,actualIntervention:true,result:true,acceptanceOrIndependentCheck:true},method:'Configured reviewer checks selected material',observations:'Limited reviewer-reported checks',limitations:['Not a professional capability certificate'],sourceReferences:['explicit-source-reference'],relationship:'non-party'};
 const corrected={...declaration,operationId:randomUUID(),expectedVersion:1,reason:'Correct original declaration',scope:'Corrected declared scoped work'};
 const correctedReview={...review,operationId:randomUUID(),expectedVersion:1,experienceRef:{id:experienceId,version:2},reason:'Review corrected current declaration'};
 const experienceCommands=[];
 for(const [who,event] of [[f.responder,declaration],[f.owner,review],[f.responder,corrected],[f.owner,correctedReview],[f.responder,{id:experienceId,operationId:randomUUID(),expectedVersion:2,reportedBy:f.responder.actor.subjectId,synthetic:false,kind:'revoke',objectType:'experience',reason:'Author withdraws declaration'}],[f.owner,{id:reviewId,operationId:randomUUID(),expectedVersion:2,reportedBy:f.owner.actor.subjectId,synthetic:false,kind:'revoke',objectType:'review',reason:'Reviewer withdraws review'}]]){experienceCommands.push({author:who===f.responder,input:await who.authorize(event,'experience.submit',{objectId:event.operationId,viewers:[who===f.owner?f.responder.actor.subjectId:f.owner.actor.subjectId]})});}
 let contributionFixture=null;
 if(process.argv[2]==='contributions'){
  const post=await f.post({title:'Selected public source title',body:'Unselected source body',publishedUntil:f.clock.now+3600});const created=await f.write(f.owner,'create-post',post);if(created.status!==200)throw Error('source forum creation failed');
  const materialId=randomUUID(),prepared=await f.ok('/v2/task-materials/prepare',{input:{source:{postId:post.postId,versionId:post.versionId},selections:[{materialId,field:'title',start:0,end:[...post.title].length}],expiresAt:post.publishedUntil}});
  const materialTask={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'collaboration',title:{format:'task-text-v1',segments:[{kind:'material',materialId}]},summary:'Private unselected Task summary',workContext:{goal:'Private Task goal',currentSituation:'Private Task situation',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.clock.now+3600,materials:prepared.descriptors};
  const payloadJson=JSON.stringify(materialTask),intent={version:1,id:randomUUID(),subjectId:f.owner.actor.subjectId,bindingId:f.owner.actor.bindingId,endpoint,action:'assistance.publish',objectId:materialTask.operationId,purpose:'operational',recipient:endpoint,fields:Object.keys(materialTask),visibility:'Private',viewers:[f.responder.actor.subjectId],payloadHash:digest(payloadJson),policyVersion:'0.1',issuedAt:f.clock.now,expiresAt:f.clock.now+3600};
  await f.owner.assistance.createTask(f.owner.actor,{signedIntent:await f.owner.signForTest(JSON.stringify(intent),'galaxy-consent+jws'),payloadJson,materialBodies:prepared.materialBodies});
  const rootRow=(await pool.query('SELECT id,payload_hash FROM task_events WHERE id=$1',[materialTask.operationId])).rows[0];
  const ref={kind:'task-event',id:rootRow.id,eventVersion:1,payloadHash:rootRow.payload_hash},selected={...ref,fields:['eventType','actorId','title']};
  const publication={id:randomUUID(),kind:'publish',sourceRefs:[selected],purposes:['honor'],purpose:'public-contribution-projections-only',expiresAt:new Date((f.clock.now+1800)*1000).toISOString(),redactionConfirmed:true,publicationScope:'selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged'};
  const publishInput=await f.owner.authorize(publication,'contribution.publish',{objectId:publication.id,visibility:'Public',purpose:'public-profile'}),revoke={id:randomUUID(),kind:'revoke',publicationId:publication.id,reason:'Withdraw this selected publication only'};
  contributionFixture={publication,ref,publish:publishInput,revoke:await f.owner.authorize(revoke,'contribution.publish',{objectId:revoke.id}),preview:{sourceRefs:[selected],purposes:['honor']},sources:{kind:'task-event',parentId:materialTask.taskId},read:{source:ref,purpose:'honor'},opaque:{publicationId:publication.id,sourceKey:digest(JSON.stringify([ref.kind,ref.id,ref.payloadHash])),purpose:'honor'}};
 }
 const honorRule={id:'scoped-contribution',version:'1',title:'Selected contribution only',capabilityId:'code',communityId:'fixture',kind:'open-contributor',members:[f.owner.actor.subjectId,f.responder.actor.subjectId],notBefore:f.clock.now-1,notAfter:f.clock.now+3600,windowFrom:f.clock.now-60,windowUntil:f.clock.now+1800,minAcceptedCases:1,minProofs:0,repositories:[]};
 const honorRules=[honorRule,{...honorRule,id:'scoped-facts',sourceProfile:'facts-v2'}];
 const honor=new HonorService(f.owner.access,f.owner.assistance,f.owner.proofs,honorRules),honorV2=new HonorV2Service(honor,{qualification:v2,sharing:f.owner.contributionSharing,ciV2:f.owner.ciV2});
 bridge=createServer(async(req,res)=>{try{
  if(req.method!=='POST'||req.url!=='/fixture'){res.writeHead(404);res.end();return}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());let result;
  if(input.action==='honor-risk')result=assessContributionRisk(input.query.contributions,{complete:true,checkedAt:f.clock.now,subjectId:input.query.subjectId,network:{contributions:input.query.contributions,complete:true}});
  else if(input.action==='honor-pagination')result=paginateHonor(input.query.view,input.query.query);
  else if(input.action==='honor-query')result=await honor.query(input.query.anonymous?null:f.owner.actor,input.query.input);
  else if(input.action==='honor-v2-query')result=await honorV2.query(input.query.anonymous?null:f.owner.actor,input.query.input);
  else if(input.action==='honor-ranking')result=await honor.ranking(input.query);
  else if(input.action==='honor-v2-ranking')result=await honorV2.ranking(input.query);
  else if(input.action==='honor-list')result=await honor.list();
  else if(input.action==='choice-fixture'){
   const taskSearch={type:'task',query:{view:'requested'}},historySearch={type:'history',query:{subjectId:f.owner.actor.subjectId}};
   const task=(await f.owner.search.v2.query(f.owner.actor,taskSearch)).items.find(i=>i.id===targetTask.taskId),history=(await f.owner.search.v2.query(f.owner.actor,historySearch)).items.find(i=>i.id===targetTask.taskId);if(!task||!history)throw Error('real selected Choice sources missing');
   const snapshotId=randomUUID(),candidateRefs=[{type:'task',...task.ref},{type:'history',...history.ref}],witnesses=[{search:taskSearch,ref:task.ref},{search:historySearch,ref:history.ref}];
   const base={snapshotId,versionId:randomUUID(),baseRevision:0,preferenceRevision:1,content:{localVersion:1,localTaskRef:'local-explicit-choice',visibleRationale:'Owner retained selected-source rationale',rationaleAuthor:'user',candidateRefs,selectedRefs:[candidateRefs[0]],resultRefs:[]},witnesses};
   const conflict={...base,versionId:randomUUID(),content:{...base.content,localVersion:2,visibleRationale:'Alternative retained by another device'}};
   const resolve={...base,versionId:randomUUID(),baseRevision:1,content:{...base.content,localVersion:3},resolveVersionIds:[conflict.versionId]};
   result={preference:{endpoint,expectedRevision:0,enabled:true,snapshotIds:[snapshotId]},puts:[base,conflict,resolve],receipts:[base,conflict,resolve].map(p=>({snapshotId,versionId:p.versionId,requestHash:digest(canonicalize(choicePutIntent(p)))}))};
  }
  else if(input.action==='choice-witness')result=await transaction(pool,db=>f.owner.choices.sourceReader.witnessWithin(db,f.owner.actor,searchV2ReferenceSchema.parse(input.query)));
  else if(input.action==='choice-get')result=await f.owner.choices.get(f.owner.actor,input.query);
  else if(input.action==='choice-preferences')result=await f.owner.choices.preferences(f.owner.actor);
  else if(input.action==='choice-put')result=await f.owner.choices.put(f.owner.actor,input.query);
  else if(input.action==='choice-receipt')result=await f.owner.choices.receipt(f.owner.actor,input.query);
  else if(input.action==='choice-list')result=await f.owner.choices.list(f.owner.actor,input.query);
  else if(input.action==='choice-revoke-root'){const root=(await pool.query('SELECT consent_id FROM task_events WHERE id=$1',[targetTask.operationId])).rows[0];await f.owner.consents.revoke(f.owner.actor,root.consent_id);result={revoked:true};}
  else if(['honor-publish','requester-publish'].includes(input.action)){
   const results=[];for(const who of [f.owner,f.responder]){const refs=sourceRows.filter(r=>r.subject_id===who.actor.subjectId).map(r=>({kind:r.kind,id:r.id,eventVersion:1,payloadHash:r.payload_hash,fields:['eventType','actorId']}));const payload={id:randomUUID(),kind:'publish',sourceRefs:refs,purposes:[input.action==='honor-publish'?'honor':'requester-history'],purpose:'public-contribution-projections-only',expiresAt:new Date((f.clock.now+1800)*1000).toISOString(),redactionConfirmed:true,publicationScope:'selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged'};results.push(await f.owner.contributionSharing.submit(who.actor,await who.authorize(payload,'contribution.publish',{objectId:payload.id,visibility:'Public',purpose:'public-profile'})));}result={publications:results};
  }
  else if(input.action==='evaluate')result=await qualification.evaluate(f.owner.actor,input.query??query);
  else if(input.action==='evaluate-v2')result=await v2.evaluate(f.owner.actor,input.query??v2Query);
  else if(input.action==='revoke-v2-acceptance'){await f.owner.consents.revoke(f.owner.actor,acceptInput.consentId);result={revoked:true};}
  else if(input.action==='revoke-confirmation'){await confirmation.who.consents.revoke(confirmation.who.actor,confirmation.input.consentId);result={revoked:true};}
  else if(input.action==='list')result=await qualification.list(f.owner.actor);
  else if(input.action==='requester-history')result=await f.owner.assistance.requesterHistory(f.owner.actor,input.query??{});
  else if(input.action==='requester-facts')result=await f.owner.assistance.requesterHistoryFacts(f.owner.actor,input.query);
  else if(input.action==='requester-v2-query')result=await f.owner.requesterHistoryV2.query(input.query.anonymous?null:f.owner.actor,input.query.input);
  else if(input.action==='requester-v2-facts')result=await f.owner.requesterHistoryV2.facts(input.query.anonymous?null:f.owner.actor,input.query.input);
  else if(input.action==='revoke-v2-root'){const root=(await pool.query('SELECT consent_id FROM task_events WHERE id=$1',[sourceTask.operationId])).rows[0];await f.owner.consents.revoke(f.owner.actor,root.consent_id);result={revoked:true};}
  else if(input.action==='calculation-submit')result=await calculations.submit(input.query.author?f.responder.actor:f.owner.actor,input.query.input);
  else if(input.action==='calculation-owned')result=await calculations.owned(input.query?.author?f.responder.actor:f.owner.actor,{});
  else if(input.action==='calculation-receipt')result=await calculations.receipt(input.query.author?f.responder.actor:f.owner.actor,input.query.input);
  else if(input.action==='candidates')result=await v2.candidates(f.responder.actor,input.query);
  else if(input.action==='permission-plan')result=await requests.plan(f.responder.actor,planQuery);
  else if(input.action==='permission-submit')result=await requests.submit(input.query.author?f.responder.actor:f.owner.actor,input.query.input);
  else if(input.action==='permission-read')result=await requests.read(input.query.author?f.responder.actor:f.owner.actor,{requestId});
  else if(input.action==='permission-query')result=await requests.query(input.query.author?f.responder.actor:f.owner.actor,{view:input.query.author?'sent':'received'});
  else if(input.action==='permission-receipt')result=await requests.receipt(input.query.author?f.responder.actor:f.owner.actor,input.query.input);
  else if(input.action==='inbox')result=await f.owner.inbox.query(input.query.author?f.responder.actor:f.owner.actor,{});
  else if(input.action==='search-tasks')result=await f.owner.search.v2.query(f.owner.actor,{type:'task',query:{view:'requested'}});
  else if(input.action==='cleanup-requests')result=await transaction(pool,tx=>cleanupQualificationRequestsWithin(tx,input.query.at));
  else if(input.action==='experience-submit')result=await experiences.submit(input.query.author?f.responder.actor:f.owner.actor,input.query.input);
  else if(input.action==='experience-read')result=await experiences.read(input.query.author?f.responder.actor:f.owner.actor,input.query.input);
  else if(input.action==='contribution-submit')result=await f.owner.contributionSharing.submit(f.owner.actor,input.query);
  else if(input.action==='contribution-status')result=await f.owner.contributionSharing.status(f.owner.actor,input.query);
  else if(input.action==='contribution-preview')result=await f.owner.contributionSharing.preview(f.owner.actor,input.query);
  else if(input.action==='contribution-sources')result=await f.owner.contributionSharing.ownedSources(f.owner.actor,input.query);
  else if(input.action==='contribution-read')result=await f.owner.contributionSharing.readProjection(input.query.authenticated?f.owner.actor:null,input.query.input);
  else if(input.action==='contribution-wire'){const value=await f.owner.contributionSharing.readProjection(null,input.query);result={json:JSON.stringify(value.projection)};}
  else throw Error('unknown fixture action');
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
 }catch(e){res.writeHead(e.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.code??e.message}));}});
 await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
 await writeFile(join(dir,'fixture.json'),JSON.stringify({endpoint,now:f.clock.now,honorRules,issuer:f.issuer.issuer,contributionFixture,experienceReviewer,experienceId,reviewId,experienceCommands,policy,query,v2Query,legacyId:request.id,requestId,planQuery,requestCommands,openQuery:{taskId:sourceTask.taskId,subjectId:f.responder.actor.subjectId},calculationQuery,calculationCommands:[{input:permissionInput,receipt:{operationId:permission.id,payloadHash:digest(permissionInput.payloadJson)}},{author:true,input:computeInput,receipt:{operationId:compute.id,payloadHash:digest(computeInput.payloadJson)}}],revokeCalculation:{author:true,input:revokeInput,receipt:{operationId:revoke.id,payloadHash:digest(revokeInput.payloadJson)}},token:f.owner.credential,authorToken:f.responder.credential,bridge:`http://127.0.0.1:${bridge.address().port}/fixture`}),{mode:0o600});console.log('ready');await new Promise(resolve=>process.stdin.once('data',resolve));
}finally{if(bridge){bridge.closeAllConnections();await new Promise(resolve=>bridge.close(resolve));}if(f)await f.close();await pool.end();}
