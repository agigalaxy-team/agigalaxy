import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';
import {createOidcLoginProvider} from '../src/oidc-login.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {QualificationService} from '../src/qualification.mjs';
import {QualificationV2Service} from '../src/qualification-v2.mjs';
import {ExperienceReviewService} from '../src/experience-review.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {taskDraft,publicationFromDraft,applicationFromDraft,evidenceFromSelection,policyKey,localDateTime} from '../../galaxy-web/src/task-bounty-client.mjs';
import {retainTaskContactAgent,taskContactWebsite} from '../../galaxy-web/test/task-contact-agent-fixture.mjs';

// Entirely isolated test identities, local OIDC, example.org records and money
// units. synthetic:false below deliberately exercises that branch of validation;
// it is not a claim of actual professional experience or a production reviewer.
export async function verifyBountyWebV2(database=null,options={}){
 const now=Math.floor(Date.now()/1000),endpoint='https://official.example.org',issuer=await oidcProviderFixture([endpoint+'/v1/identity/callback/fixture'],{emailVerified:true});
 let f,api,a,b;try{
  const provider=await createOidcLoginProvider({id:'fixture',name:'Synthetic local OIDC',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:endpoint+'/v1/identity/callback/fixture',allowLoopbackHttp:true,now:()=>now});
  f=await serviceFixture(browserScopes,database,{...options,now,identityProviders:[provider],syntheticCommunityQuota:false});
  const policy={id:'test-bounty-current',version:'1',capabilityId:'software-debugging',title:'测试范围条件',collaboration:'basic-bounty',notBefore:now-1,notAfter:now+3600,minProofs:0,minAcceptedCollaborations:1,historyWindowSeconds:31536000,requireCiSuccess:false,repositories:[]};
  f.qualification=new QualificationService(f.access,f.proofs,f.assistance,[policy]);f.assistance.qualification=f.qualification;
  f.experienceReviews=new ExperienceReviewService(f.access,f.consents,{reviewers:[{subjectId:f.actor.subjectId,capabilityIds:[policy.capabilityId],kinds:['challenge'],scope:'isolated test only',notBefore:now-1,notAfter:now+3600,authorityReference:'isolated test reviewer, never production',synthetic:false}]});
  f.qualification.v2=new QualificationV2Service(f.qualification,{cases:f.cases,assistance:f.assistance,experienceReviews:f.experienceReviews,capsules:f.capsules,calculations:f.qualificationCalculations});
  api=createApi({...f,rateLimit:2000});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+api.address().port;
  let losePublication=false,loseApplication=false;const publications=[],applications=[],authorizations=[];
  const wire=async(url,init)=>{const path=new URL(url).pathname;
   if(path==='/v2/tasks')publications.push(JSON.parse(init.body));
   if(/\/v2\/tasks\/.+\/events$/.test(path))applications.push(JSON.parse(init.body));
   if(path==='/v1/consents')authorizations.push(JSON.parse(init.body));
   const response=await fetch(origin+path,init);
   if(losePublication&&path==='/v2/tasks'){losePublication=false;assert.equal(response.status,200);throw Error('lost publication ACK');}
   if(loseApplication&&/\/v2\/tasks\/.+\/events$/.test(path)){loseApplication=false;assert.equal(response.status,200);throw Error('lost application ACK');}
   return response;
  };
  const store=()=>{const data=new Map();return{get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),
   update:async(k,change)=>{const next=change(structuredClone(data.get(k)));if(next?.then)throw Error('local_update_async_callback');const committed=structuredClone(next);data.set(k,committed);return structuredClone(committed);}};};
  const aStore=store(),bStore=store(),config={endpoint,trustedKeys:f.bindings.trustedKeys};a=await createWebRuntime(config,{store:aStore,fetch:wire,now:()=>now,website:taskContactWebsite});b=await createWebRuntime(config,{store:bStore,fetch:wire,now:()=>now,website:taskContactWebsite});
  for(const rt of [a,b]){await rt.createIdentity({confirmed:true});await rt.connect({confirmed:true});}
  await retainTaskContactAgent(a,aStore,now);await retainTaskContactAgent(b,bStore,now);
  const aid=(await a.status()).identity.subjectId,bid=(await b.status()).identity.subjectId;
  const call=(rt,path,input)=>rt.api.call(path,input,{authenticated:true});
  const read=(rt,id)=>rt.api.call('/v2/tasks/'+id,null,{method:'GET',authenticated:true});
  const signed=async(rt,payload,action,objectId,viewers=[])=>rt.api.submitAuthorization(await rt.api.prepareAuthorization(JSON.stringify(payload),{action,objectId,visibility:'Private',viewers,confirmed:true}),{confirmed:true});
  const login=await call(a,'/v1/identity/begin',{providerId:'fixture'}),callback=await issuer.authorize(login.authorizationUrl);
  assert.equal((await fetch(origin+callback.pathname+callback.search)).status,200);await a.confirmAccountLink(login.loginId,{confirmed:true});assert.equal((await call(a,'/v2/account/quotas',{})).accountVerified,true);
  const catalog=await call(a,'/v1/qualification/policies',{});assert.equal(catalog.policies.length,1);
  const old={title:'保留旧草稿',summary:'主动诊断帮助',goal:'找到边界',situation:'没有失败尝试',visibility:'Public',intent:'diagnosis',unknownLocalNote:'旧本机材料'};
  const draft=taskDraft(old,now);assert.equal(draft.unknownLocalNote,old.unknownLocalNote);await a.putLocal('task-draft',draft);
  const paid={...draft,collaboration:'basic-bounty',budgetMode:'range',minimum:'0.10000001',maximum:'400.25',unit:'SYNTHETIC',policyKey:policyKey(policy),enrollmentLocal:localDateTime(now+1800)};
  const payload=publicationFromDraft(paid,catalog.policies,now);assert.equal(payload.caseId,null);assert.equal(payload.workContext.attemptRefs.length,0);
  assert.throws(()=>publicationFromDraft({...paid,minimum:'9',maximum:'1'},catalog.policies,now));
  assert.throws(()=>publicationFromDraft(paid,[],now),/请选择/);
  losePublication=true;await assert.rejects(a.publishTask(payload,{confirmed:true}),/lost publication/);const pending=await a.getLocal('task-publication');
  assert.equal(pending.payload.budget.minimum,'0.10000001');const postCount=publications.length,consentCount=authorizations.length;
  await a.disconnect();await a.connect({confirmed:true});const receipt=await a.reconcilePublication({retry:true});assert.equal(receipt.state,'acknowledged');assert.equal(publications.length,postCount);assert.equal(authorizations.length,consentCount);
  assert.deepEqual(await a.getLocal('task-draft'),draft,'pending reconciliation never deletes or replaces an edited local draft');
  let task=await read(a,receipt.taskId);assert.equal(task.caseId,null);assert.deepEqual(task.request.budget,payload.budget);assert.equal(task.request.enrollmentExpiresAt,payload.enrollmentExpiresAt);
  await a.taskEvent(task.taskId,{kind:'invite',expectedTaskVersion:task.version,recipientId:bid,note:'先了解限定范围',expiresAt:Math.min(now+7*86400,task.request.enrollmentExpiresAt)},{viewers:[bid],confirmed:true});
  const visible=await read(b,task.taskId),invite=visible.contacts.responses.invitations[0];assert.equal(invite.expiresAt,task.request.enrollmentExpiresAt);
  await b.taskEvent(task.taskId,{kind:'invitation-reply',expectedTaskVersion:visible.version,invitationId:invite.invitationId,response:'interested',message:'愿意了解，不等于承接'},{viewers:[aid],confirmed:true});
  task=await read(a,task.taskId);const applicationDraft={proposal:'提供有限诊断',scope:'核对单个流程，双方另定交付时间',quoteMode:'own',budgetMode:'fixed',amount:'125.00000001',minimum:'',maximum:'',unit:'SYNTHETIC',selected:[]};
  const noEvidence=applicationFromDraft(applicationDraft,task);await b.taskEvent(task.taskId,noEvidence,{viewers:[aid],confirmed:true});task=await read(a,task.taskId);
  assert.equal((await call(a,'/v2/qualification/evaluate',{taskId:task.taskId,subjectId:bid,evidence:noEvidence.qualificationEvidence})).state,'insufficient-evidence');
  const incomplete={eventId:randomUUID(),expectedTaskVersion:task.version,kind:'propose',participationId:randomUUID(),subjectId:bid,role:'diagnosis',scopeVersion:1,agreedScope:'范围',applicationId:task.contacts.responses.applications[0].applicationId};
  await assert.rejects(call(a,`/v2/tasks/${task.taskId}/participations`,await signed(a,incomplete,'assistance.publish',incomplete.eventId,[bid])),/qualification_required/);
  await b.taskEvent(task.taskId,{kind:'withdraw-application',expectedTaskVersion:task.version,applicationId:incomplete.applicationId,reason:'补充真实限定审核后另行申请'},{viewers:[aid],confirmed:true});
  task=await read(a,task.taskId);assert.equal(task.contacts.responses.applications[0].state,'withdrawn');
  const experience={id:randomUUID(),operationId:randomUUID(),kind:'challenge',expectedVersion:0,reportedBy:bid,subjectId:bid,synthetic:false,capabilityId:policy.capabilityId,
   source:{system:'isolated-test',stableRecord:randomUUID(),originalAt:new Date(now*1000).toISOString(),originalAuthor:'isolated test candidate',links:['https://example.org/isolated'],contentVersion:'1'},actualIntervention:'测试分支中的有限挑战',resultReference:'isolated-test-result',outcome:'partial',scope:'限定算法诊断',limitations:['不是生产案例'],ownershipStatement:'测试载荷分支，不声明生产实际来源'};
  await call(b,'/v2/experience/submit',await signed(b,experience,'experience.submit',experience.operationId,[aid,f.actor.subjectId]));
  const review={id:randomUUID(),operationId:randomUUID(),kind:'review',expectedVersion:0,reportedBy:f.actor.subjectId,synthetic:false,experienceRef:{id:experience.id,version:1},capabilityId:policy.capabilityId,state:'verified-in-scope',scope:'限定算法诊断',observedAt:new Date(now*1000).toISOString(),checked:{source:true,attribution:true,actualIntervention:true,result:true,acceptanceOrIndependentCheck:true},method:'isolated test review branch',observations:'仅限定核对',limitations:['合成隔离测试，不是生产资质'],sourceReferences:['isolated:test'],relationship:'non-party'};
  await f.experienceReviews.submit(f.actor,await f.authorize(review,'experience.submit',{objectId:review.operationId,viewers:[aid,bid]}));
  const choices=await call(b,'/v2/qualification/candidates',{taskId:task.taskId,kind:'external-review'});assert.equal(choices.items.length,1);assert.deepEqual(choices.items[0].evidence.externalReviewRefs,[{id:review.id,version:1}]);
  assert.equal((await call(a,'/v2/qualification/candidates',{taskId:task.taskId,kind:'external-review'})).items.length,0,'requester cannot browse the candidate directory as their own');
  assert.throws(()=>evidenceFromSelection([{kind:'calculation',evidence:{calculationGrantId:randomUUID()}},choices.items[0]]),/单独选择/);
  const selected={...applicationDraft,selected:choices.items};await b.putLocal(`task-application-draft:${task.taskId}`,selected);
  const event=applicationFromDraft(selected,task);assert.equal((await call(b,'/v2/qualification/evaluate',{taskId:task.taskId,subjectId:bid,evidence:event.qualificationEvidence})).state,'satisfied');
  loseApplication=true;await assert.rejects(b.taskEvent(task.taskId,event,{viewers:[aid],confirmed:true}),/lost application/);const original=await b.getLocal(`task-event:${task.taskId}`),count=applications.length;
  await b.disconnect();await b.connect({confirmed:true});assert.equal((await b.reconcileTaskEvent(task.taskId,{retry:true})).state,'acknowledged');assert.equal(applications.length,count);assert.equal(JSON.parse(original.payloadJson).event.quote.amount,'125.00000001');
  assert.deepEqual(await b.getLocal(`task-application-draft:${task.taskId}`),selected);
  task=await read(a,task.taskId);const application=task.contacts.responses.applications.find(x=>x.state==='pending');assert.equal(application.quote.amount,'125.00000001');
  const anonymous=await (await fetch(origin+'/v2/tasks/'+task.taskId)).json();assert.equal(JSON.stringify(anonymous).includes('125.00000001'),false);assert.equal(anonymous.contacts,undefined);
  const proposal=await a.proposeParticipation(task.taskId,{expectedTaskVersion:task.version,subjectId:bid,role:'diagnosis',agreedScope:application.scope,applicationId:application.applicationId},{confirmed:true});
  assert.equal((await read(a,task.taskId)).participations[0].state,'awaiting-counterparty');
  await b.participationEvent(task.taskId,proposal.participationId,{kind:'confirm',expectedParticipationVersion:1,scopeVersion:1},{viewers:[aid,bid],confirmed:true});
  task=await read(a,task.taskId);assert.equal(task.participations[0].state,'active');assert.equal(task.caseId,null);assert.equal(task.participations[0].applicationId,application.applicationId);
  const extension=task.request.enrollmentExpiresAt+3600;await a.taskEvent(task.taskId,{kind:'extend-enrollment',expectedTaskVersion:task.version,enrollmentExpiresAt:extension},{viewers:[aid],confirmed:true});
  task=await read(a,task.taskId);assert.equal(task.request.enrollmentExpiresAt,extension);assert.equal(task.participations[0].agreedScope,application.scope);
  const revoke={id:review.id,operationId:randomUUID(),kind:'revoke',objectType:'review',expectedVersion:1,reportedBy:f.actor.subjectId,synthetic:false,reason:'本次测试撤回限定核对'};
  await f.experienceReviews.submit(f.actor,await f.authorize(revoke,'experience.submit',{objectId:revoke.operationId,viewers:[aid,bid]}));
  assert.equal((await call(b,'/v2/qualification/candidates',{taskId:task.taskId,kind:'external-review'})).items.length,0);
  assert.equal((await call(a,'/v2/qualification/evaluate',{taskId:task.taskId,subjectId:bid,evidence:event.qualificationEvidence})).state,'insufficient-evidence');
  const open=publicationFromDraft({...draft,capabilityId:'software-debugging'},catalog.policies,now),openReceipt=await a.publishTask(open,{confirmed:true});
  let ot=await read(a,openReceipt.taskId);assert.equal(ot.request.budget,undefined);assert.equal(ot.request.qualification,undefined);
  await b.taskEvent(ot.taskId,applicationFromDraft({...applicationDraft,quoteMode:'task'},ot),{viewers:[aid],confirmed:true});ot=await read(a,ot.taskId);
  const op=await a.proposeParticipation(ot.taskId,{expectedTaskVersion:ot.version,subjectId:bid,role:'diagnosis',agreedScope:'没有合格旧材料也能开始开放协助',applicationId:ot.contacts.responses.applications[0].applicationId},{confirmed:true});
  await b.participationEvent(ot.taskId,op.participationId,{kind:'confirm',expectedParticipationVersion:1,scopeVersion:1},{viewers:[aid,bid],confirmed:true});assert.equal((await read(b,ot.taskId)).participations[0].state,'active');
  // Material picker also follows the actual native Task -> Case -> intervention
  // -> Result -> accepted delivery chain. A synthetic Case stays excluded.
  ot=await read(a,ot.taskId);const cid=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:cid,caseId:cid,expectedVersion:0,actorId:aid,taskId:ot.taskId,
   localRef:randomUUID(),title:'实际流程的合成记录',summary:'明确演示数据',source:{kind:'active-task',reference:ot.taskId},synthetic:true};
  const first={schemaVersion:2,kind:'intervention',eventId:randomUUID(),caseId:cid,expectedVersion:1,actorId:aid,taskId:ot.taskId,types:['diagnosis'],affectsAttemptIds:[],description:'合成范围检查',sourceRefs:[],observedEffect:'找到检查范围'};
  await call(a,`/v2/tasks/${ot.taskId}/case`,{operationId:randomUUID(),taskId:ot.taskId,expectedTaskVersion:ot.version,
   case:await signed(a,root,'case.teaser.publish',root.eventId,[bid]),initialFact:await signed(a,first,'case.teaser.publish',first.eventId,[bid])});
  const intervention={...first,eventId:randomUUID(),expectedVersion:2,actorId:bid,participationId:op.participationId};
  await call(b,'/v2/cases/events',await signed(b,intervention,'case.teaser.publish',intervention.eventId,[aid]));
  const result={schemaVersion:2,kind:'result-recorded',eventId:randomUUID(),caseId:cid,expectedVersion:3,actorId:bid,taskId:ot.taskId,participationId:op.participationId,
   scopeVersion:1,participationScopeVersion:1,origin:{kind:'intervention',id:intervention.eventId,version:1},deliverableRefs:[],reportedOutcome:'partial',summary:'合成有限诊断已交付',limitations:'非生产实践'};
  await call(b,'/v2/cases/events',await signed(b,result,'case.teaser.publish',result.eventId,[aid]));
  const delivered=await b.participationEvent(ot.taskId,op.participationId,{kind:'deliver',expectedParticipationVersion:2,resultRef:{id:result.eventId,version:1},interventionRefs:[{id:intervention.eventId,version:1}],evidenceRefs:[],summary:'有限范围报告'}, {viewers:[aid,bid],confirmed:true});
  await a.participationEvent(ot.taskId,op.participationId,{kind:'accept',expectedParticipationVersion:3,deliveryId:delivered.eventId,summary:'接受有限诊断，不等于问题解决'}, {viewers:[aid,bid],confirmed:true});
  const native=await call(b,'/v2/qualification/candidates',{taskId:task.taskId,kind:'participation',limit:1});assert.equal(native.items.length,1);assert.equal(native.items[0].id,op.participationId);assert.equal(native.items[0].synthetic,true);
  assert.equal((await call(b,'/v2/qualification/evaluate',{taskId:task.taskId,subjectId:bid,evidence:evidenceFromSelection(native.items)})).state,'insufficient-evidence');
  assert.equal((await call(a,'/v2/qualification/candidates',{taskId:task.taskId,kind:'participation'})).items.length,0);
  assert.equal((await call(a,'/v2/account/quotas',{})).quotas.find(q=>q.category==='task').used,2,'real verified Account quota, no synthetic quota stub');
  return{actualHttp:true,actualBrowserRuntime:true,realLocalOidc:true,scope:'isolated test data, no production reviewer or payment',lostAcks:true,privateQuotes:true};
 }finally{a?.close();b?.close();if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}if(f&&!database)await f.db.close();await issuer.close();}
}
