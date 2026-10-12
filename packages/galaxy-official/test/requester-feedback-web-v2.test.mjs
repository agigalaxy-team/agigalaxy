import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createServices} from '../src/services.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {requesterFeedbackPreview,submitRequesterFeedback} from '../../galaxy-web/src/requester-feedback-client.mjs';
import {retainTaskContactAgent,taskContactWebsite} from '../../galaxy-web/test/task-contact-agent-fixture.mjs';
import {memoryAtomicUpdate} from './memory-atomic-update.mjs';

test('browser requester feedback preserves private author scope, superseded history and committed operation after lost acknowledgement',async()=>{
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000),syntheticCommunityQuota:false});
 const key=generateKeyPairSync('ed25519'),trustedKeys=new Map([['feedback-web',{publicKeyPem:key.publicKey.export({type:'spki',format:'pem'}),notBefore:f.now-1,notAfter:f.now+86400,revoked:false}]]);
 const services=createServices({db:f.db,endpoint:f.access.endpoint,kid:'feedback-web',signingKey:key.privateKey,trustedKeys,allowedScopes:browserScopes,operator:'Synthetic',region:'isolated',now:()=>f.now});
 const origin='https://galaxy.example.org',server=createApi({...services,browserOrigins:[origin],rateLimit:10000});
 const data=new Map(),store={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>{data.set(k,structuredClone(v));},update:memoryAtomicUpdate(data)};let runtime,drop=true;
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const local='http://127.0.0.1:'+server.address().port;
  const wire=async(url,options)=>{const path=new URL(url).pathname,response=await fetch(local+path,{...options,headers:{...options.headers,Origin:origin}});
   const payload=typeof options.body==='string'?JSON.parse(options.body):null;
   if(drop&&path.startsWith('/v2/participations/')&&payload?.payloadJson&&JSON.parse(payload.payloadJson).kind==='requester-feedback'){
    drop=false;assert.equal(response.status,200);throw Error('Synthetic lost committed feedback acknowledgement');}
   return response;};
  const config={endpoint:f.access.endpoint,trustedKeys};runtime=await createWebRuntime(config,{store,fetch:wire,now:()=>f.now,website:taskContactWebsite});
  await runtime.createIdentity({confirmed:true});await runtime.connect({confirmed:true});const subjectId=(await runtime.status()).identity.subjectId;
  assert.equal((await runtime.agentContinuity.status()).state,'required');
  await retainTaskContactAgent(runtime,store,f.now);
  const taskId=randomUUID(),open={taskId,operationId:randomUUID(),caseId:null,intent:'collaboration',title:'Synthetic cooperation feedback',summary:'Selected private task',workContext:{goal:'Review collaboration',currentSituation:'No failure history required',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+3600};
  await f.assistance.createTask(f.actor,await f.authorize(open,'assistance.publish',{objectId:open.operationId,viewers:[subjectId]}));
  const proposal={kind:'propose',eventId:randomUUID(),participationId:randomUUID(),expectedTaskVersion:1,subjectId,role:'advice',scopeVersion:1,agreedScope:'Specific synthetic review'};
  await f.assistance.proposeParticipation(f.actor,taskId,await f.authorize(proposal,'assistance.publish',{objectId:proposal.eventId,viewers:[subjectId]}));
  const read=()=>runtime.api.call('/v2/tasks/'+taskId,null,{method:'GET'}),draft={descriptionClarity:'partly-clear',scopeMatched:'no',note:'范围出现未约定的变化。',reason:''};
  let task=await read(),participant=task.participations[0];assert.throws(()=>requesterFeedbackPreview(task,participant,subjectId,draft),/实际确认参与/);
  await runtime.participationEvent(taskId,proposal.participationId,{kind:'confirm',expectedParticipationVersion:1,scopeVersion:1},{confirmed:true,viewers:[f.actor.subjectId]});
  await runtime.participationEvent(taskId,proposal.participationId,{kind:'withdraw',expectedParticipationVersion:2,reason:'Synthetic scope mismatch'},{confirmed:true,viewers:[f.actor.subjectId]});
  task=await read();participant=task.participations[0];const preview=requesterFeedbackPreview(task,participant,subjectId,draft);
  assert.equal(preview.visibility,'Private');assert.equal(preview.independentQualityRating,false);
  assert.throws(()=>requesterFeedbackPreview(task,participant,f.actor.subjectId,draft),/实际确认参与/);
  await assert.rejects(submitRequesterFeedback(runtime,preview),/lost committed/);
  const saved=await runtime.getLocal('task-event:'+taskId);assert.equal(JSON.parse(saved.payloadJson).note,draft.note);assert.equal(saved.preparedConsent.intent.visibility,'Private');
  runtime.close();runtime=await createWebRuntime(config,{store,fetch:wire,now:()=>f.now,website:taskContactWebsite});await runtime.connect({confirmed:true});
  assert.equal((await runtime.reconcileTaskEvent(taskId)).state,'acknowledged');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM task_events WHERE id=$1',[saved.eventId])).rows[0].n,1);
  task=await read();participant=task.participations[0];assert.equal(participant.feedback.eventId,saved.eventId);
  assert.throws(()=>requesterFeedbackPreview(task,participant,subjectId,{...draft,note:'更正',reason:''}));
  const corrected=requesterFeedbackPreview(task,participant,subjectId,{descriptionClarity:'clear',scopeMatched:'yes',note:'已核对早前约定。',reason:'先前漏看补充说明。'});
  assert.equal(corrected.event.supersedes,saved.eventId);await submitRequesterFeedback(runtime,corrected);
  const history=await f.requesterHistoryV2.facts(f.actor,{rootEventId:open.operationId,limit:20});
  assert.equal(history.counts.currentFeedback,1);assert.equal(history.facts.filter(v=>v.feedbackState==='superseded').length,1);assert.equal(history.globalScore,null);
  const publicHistory=await f.requesterHistoryV2.query(null,{subjectId:f.actor.subjectId});assert.deepEqual(publicHistory.items,[]);
 }finally{runtime?.close();if(server.listening)await new Promise(r=>server.close(r));await f.db.close();}
});
