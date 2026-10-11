import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {serviceFixture} from '../../../packages/galaxy-official/test/service-fixture.mjs';
import {builderDeclaration} from '../../../packages/galaxy-official/test/builders-workflow.mjs';
import {retirementFixturePolicy} from '../../../packages/galaxy-official/test/retirement-workflow.mjs';
import {createRetirementController} from '../../../packages/galaxy-official/src/retirement.mjs';
import {createApi} from '../../../packages/galaxy-official/src/http.mjs';
import {createSessionMemory} from '../../../packages/galaxy-official/src/session-memory.mjs';
import {createBuilderClient} from '../../../packages/galaxy-official/src/builder-client.mjs';
import {createBuilderFlow} from '../../../packages/galaxy-official/src/builder-flow.mjs';
import {createHistoryClient} from '../../../packages/galaxy-official/src/history-client.mjs';
import {createCaseClient} from '../../../packages/galaxy-official/src/case-client.mjs';
import {createCapsuleClient} from '../../../packages/galaxy-official/src/capsule-client.mjs';
import {createCapsuleFlow} from '../../../packages/galaxy-official/src/capsule-flow.mjs';
import {a2aHostFactory} from '../../../packages/galaxy-a2a/src/host-flow.mjs';
import {sdkPeer} from '../../../packages/galaxy-a2a/test/sdk-peer.mjs';
import {createDeletionClient,createDeletionStatusClient} from '../../../packages/galaxy-official/src/deletion-client.mjs';
import {createHostConnectionController} from '../../../packages/galaxy-official/src/host-connection-controller.mjs';
import {createSearchClient} from '../../../packages/galaxy-official/src/search-client.mjs';
import {createAssistanceClient} from '../../../packages/galaxy-official/src/assistance-client.mjs';
import {createAssistanceFlow} from '../../../packages/galaxy-official/src/assistance-flow.mjs';
import {createLocalAssistanceStore} from '../../../packages/galaxy-official/src/local-assistance-store.mjs';
import {createDataExportClient} from '../../../packages/galaxy-official/src/data-export-client.mjs';
import {saveDataExport} from '../../../packages/galaxy-official/src/local-data-export.mjs';
import {EvidenceService} from '../../../packages/galaxy-official/src/evidence.mjs';
import {ConsentReader} from '../../../packages/galaxy-official/src/consent-reader.mjs';
import {inspectGithubRun} from '../../../packages/galaxy-official/src/github-evidence.mjs';
import {writeJson,localPaths} from '../../../packages/galaxy-core/src/storage/files.mjs';
import {initializeGalaxyIntegration} from '../../../packages/galaxy-core/src/local-store.mjs';
import {createLocalDeletionRecords} from '../local-deletion-records.mjs';

// Uses existing service fixtures. All source work and GitHub metadata are
// synthetic; signatures, HTTP, PGlite and local record storage actually run.
export async function professionalPurposeFixture(kind){
 const entries=['search','drafts','export'].includes(kind);assert.ok(entries||['builder','deletion','capsule','a2a'].includes(kind));const scopes=['binding','consent','case-teaser','history','evidence','proof','builders','data-delete','capsules',...(entries?['assistance','data-export']:[])];
 // Fixed synthetic time must follow the database job timestamps while keeping
 // the real UI's enrollment deadline in the future. No production clock changes.
 let clock=entries?Math.floor(Date.now()/1000)+120:2000000000;const retirement=kind==='deletion'?createRetirementController(retirementFixturePolicy(clock),{now:()=>clock}):undefined;
 const f=await serviceFixture(scopes,null,{retirement,now:clock}),directory=await mkdtemp(join(tmpdir(),'galaxy-professional-purpose-'));let api,sessions,controller,peer,closed=false;
 const state={dropRequestAck:false,requestWrites:0,statusQueries:0,dropCaseAck:false,caseResultWrites:0,capsuleWrites:0,dropCollaborationAck:false,collaborationWrites:0,exportTickets:0},calls=[];
 async function close(){if(closed)return;closed=true;controller?.cancel();sessions?.close();await peer?.close();if(api?.listening){api.closeAllConnections();await new Promise(ok=>api.close(ok));}await f.db.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-professional-purpose-'));await rm(target,{recursive:true,force:true});}
 try{await writeJson(localPaths(directory).identity,f.genesis);sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});sessions.adopt({endpoint:f.access.endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>f.credential});
  api=createApi({...f,rateLimit:5000});await new Promise(ok=>api.listen(0,'127.0.0.1',ok));const base='http://127.0.0.1:'+api.address().port;
  const send=async(url,input)=>{const path=new URL(url).pathname;calls.push(path);const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(input.credential?{Authorization:'Bearer '+input.credential}:{})},body:input.bodyJson,signal:input.signal}),body=await response.json();
   if(response.status!==200)throw Object.assign(Error(body.error??'fixture_http_failed'),{code:body.error});
   if(path==='/v1/deletion-requests/submit'){state.requestWrites++;if(state.dropRequestAck){state.dropRequestAck=false;throw Error('synthetic_original_request_ack_lost');}}
   if(path==='/v1/deletion-requests/status')state.statusQueries++;
   if(path==='/v1/case-events'&&JSON.parse(JSON.parse(input.bodyJson).payloadJson).kind==='result'){state.caseResultWrites++;if(state.dropCaseAck){state.dropCaseAck=false;throw Error('synthetic_original_result_ack_lost');}}
   if(path==='/v1/capsules/events'||path==='/v1/capsules/uses')state.capsuleWrites++;
   if(path==='/v1/assistance'){state.collaborationWrites++;if(state.dropCollaborationAck){state.dropCollaborationAck=false;throw Error('synthetic_original_collaboration_ack_lost');}}
   if(path==='/v1/data-exports/create')state.exportTickets++;return body;};
  const read=async(url,input)=>{const path=new URL(url).pathname;calls.push(path);const response=await fetch(base+path,{headers:{Authorization:'Bearer '+input.credential},signal:input.signal}),body=await response.json();if(response.status!==200)throw Error(body.error??'fixture_http_failed');return body;};
  const records=createLocalDeletionRecords({dataDirectory:directory,endpoint:f.access.endpoint,now:()=>f.now});
  if(kind==='deletion'){clock+=20;const deletionClient=createDeletionClient({endpoint:f.access.endpoint,sessions,signIntent:f.signForTest,send,now:()=>f.now}),deletionStatusClient=createDeletionStatusClient({endpoint:f.access.endpoint,readSubjectId:async()=>f.actor.subjectId,signIntent:f.signForTest,send,now:()=>f.now});
   controller=createHostConnectionController({sessions,endpoint:f.access.endpoint,deletionClient,deletionStatusClient});return{kind,f,directory,controller,records,state,calls,sessions,close};}
  const grant={visibility:'Public',purpose:'public-profile'},root={id:randomUUID(),kind:'case',localRef:randomUUID(),title:entries?'合成：当前求助工作':kind==='capsule'?'合成：方法原来的完成工作':kind==='a2a'?'合成：原外部协作工作':'合成：节点参与示例工作',summary:'选择已有工作及 CI 来源；不代表独立执行认证。',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
  await f.cases.submit(f.actor,await f.authorize(root,'case.teaser.publish',grant));const attempt={id:randomUUID(),kind:'attempt',caseId:root.id,expectedVersion:1,sequence:1,approach:'合成参与',configuration:{environment:'Node',version:'24',tools:[]}};
  await f.cases.submit(f.actor,await f.authorize(attempt,'case.teaser.publish',grant));const result={id:randomUUID(),kind:'result',caseId:root.id,expectedVersion:2,attemptId:attempt.id,outcome:kind==='capsule'||entries?'succeeded':'partial',summary:kind==='capsule'||entries?'合成：原方法步骤已完成':'合成：只完成所选步骤',failureReason:'',limitations:['合成示例，未在真实任务验收']};
  await f.cases.submit(f.actor,await f.authorize(result,'case.teaser.publish',grant));const submission={id:randomUUID(),caseId:root.id,resultId:result.id,source:{provider:'github-actions',owner:'fixture',repository:'local-node-example',runId:19,attempt:1,commit:'a'.repeat(40)}};
  await f.evidence.submit(f.actor,await f.authorize(submission,'evidence.submit',grant));const worker=new EvidenceService(null,new ConsentReader({now:()=>f.now}),{db:f.db,endpoint:f.access.endpoint,now:()=>f.now});
  await worker.processNext((input,now)=>inspectGithubRun(input,{id:19,run_attempt:1,head_sha:input.commit,repository:{full_name:input.owner+'/'+input.repository,private:false,id:123},updated_at:new Date(now*1000).toISOString(),status:'completed',conclusion:'success'},now));
  const p=await f.proofs.preview(f.actor,{id:randomUUID(),evidenceId:submission.id}),proof=await f.proofs.publish(f.actor,await f.authorize(JSON.parse(p.payloadJson),'proof.publish',grant));
  const historyClient=createHistoryClient({endpoint:f.access.endpoint,sessions,send}),caseClient=createCaseClient({endpoint:f.access.endpoint,sessions,send,read});
  if(entries){
   await initializeGalaxyIntegration(directory,{profile:'coding-case',source:'test'});
   const draftStore=createLocalAssistanceStore({dataDirectory:directory,endpoint:f.access.endpoint});
   const assistanceFlow=createAssistanceFlow({endpoint:f.access.endpoint,sessions,signIntent:f.signForTest,consentSend:send,assistanceSend:send,assistanceRead:read,journal:draftStore,now:()=>f.now});
   const dataExportClient=createDataExportClient({endpoint:f.access.endpoint,sessions,send,now:()=>f.now}),exportDirectory=join(directory,'exports');await mkdir(exportDirectory);
   controller=Object.freeze({...createHostConnectionController({sessions,endpoint:f.access.endpoint,caseClient,historyClient,
     searchClient:createSearchClient({endpoint:f.access.endpoint,sessions,send}),assistanceClient:createAssistanceClient({endpoint:f.access.endpoint,sessions,send,read}),assistanceFlow,
     dataExportClient,saveExportToDirectory:(id,path,options)=>saveDataExport(dataExportClient,id,path,options)}),
    createAssistanceDraft:()=>draftStore.createDraft(),getAssistanceDraft:id=>draftStore.getDraft(id),createAssistanceEventDraft:input=>draftStore.createEventDraft(input),
    rebaseAssistanceDraft:input=>draftStore.rebaseDraft(input),saveAssistanceDraft:input=>draftStore.saveDraft(input),listAssistanceDrafts:()=>draftStore.listDrafts(),forgetAssistanceDraft:id=>draftStore.forgetDraft(id)});
   return{kind,f,directory,controller,records,state,calls,sessions,root,attempt,result,proof,draftStore,exportDirectory,readWorkContext:async()=>({caseId:root.id}),close};
  }
  if(kind==='a2a'){
   peer=await sdkPeer();const factory=a2aHostFactory({peers:[{id:'peer',name:'合成：已有外部服务',endpoint:peer.endpoint,tenant:'fixture',peerPrincipal:'external-fixture-user',agentCard:peer.card}],post:(...args)=>peer.post(...args),readPeerAuthorization:async()=>({peerPrincipal:'external-fixture-user',credential:'synthetic-external-token'})});
   const flow=factory({dataDirectory:directory,endpoint:f.access.endpoint,sessions,cases:caseClient,signIntent:f.signForTest,consentSend:send,caseSend:send,caseRead:read,now:()=>f.now});
   controller=createHostConnectionController({sessions,endpoint:f.access.endpoint,caseClient,historyClient,a2aFlow:flow});
   return{kind,f,directory,controller,records,state,calls,sessions,root,attempt,result,proof,peer,readWorkContext:async()=>({caseId:root.id,a2a:{peerId:'peer',attemptId:attempt.id,text:'complete'}}),close};
  }
  if(kind==='capsule'){
   const flow=createCapsuleFlow({endpoint:f.access.endpoint,sessions,signIntent:f.signForTest,capsuleSend:send,consentSend:send,caseSend:send,caseRead:read,now:()=>f.now});
   controller=createHostConnectionController({sessions,endpoint:f.access.endpoint,caseClient,historyClient,capsuleClient:createCapsuleClient({endpoint:f.access.endpoint,sessions,send}),capsuleFlow:flow});
   const draft={kind:'version',title:'合成：包导出检查方法',problemPattern:'合成：模块缺少导出',environment:{name:'Node',version:'24'},solutionStrategy:'合成：检查 package exports；此正文仅用于本地界面验证。',tools:[],skills:[],mcpRefs:[],verificationMethod:'合成：检查所选结果和 CI 元数据，不证明独立执行',limitations:['合成示例，未在真实任务验收'],capabilityId:'compiler',applicableScope:'合成 Node 包导出问题',license:'MIT',contributors:[],sourceResolution:{caseId:root.id,resultId:result.id,proofIds:[proof.proofId]},redactionConfirmed:true,visibility:'Public',viewers:[]};
   const prepared=await controller.prepareCapsule(draft),published=await controller.executeCapsule(prepared,prepared.confirmation);
   const application={root:{...root,id:randomUUID(),localRef:randomUUID(),source:{kind:'local',reference:randomUUID()},title:'合成：这次实际应用工作'},attempt:{...attempt,id:randomUUID()},result:{...result,id:randomUUID(),outcome:'partial',summary:'合成：只在当前环境完成一部分'}};
   application.attempt.caseId=application.root.id;application.result.caseId=application.root.id;application.result.attemptId=application.attempt.id;
   for(const event of [application.root,application.attempt,application.result])await f.cases.submit(f.actor,await f.authorize(event,'case.teaser.publish',grant));
   const evidence={...submission,id:randomUUID(),caseId:application.root.id,resultId:application.result.id,source:{...submission.source,runId:20}};await f.evidence.submit(f.actor,await f.authorize(evidence,'evidence.submit',grant));
   await worker.processNext((input,now)=>inspectGithubRun(input,{id:20,run_attempt:1,head_sha:input.commit,repository:{full_name:input.owner+'/'+input.repository,private:false,id:123},updated_at:new Date(now*1000).toISOString(),status:'completed',conclusion:'success'},now));
   const ci=await f.proofs.preview(f.actor,{id:randomUUID(),evidenceId:evidence.id});application.proof=await f.proofs.publish(f.actor,await f.authorize(JSON.parse(ci.payloadJson),'proof.publish',grant));
   return{kind,f,directory,controller,records,state,calls,sessions,root,attempt,result,proof,draft,published,application,readWorkContext:async()=>({caseId:root.id}),close};
  }
  const flow=createBuilderFlow({endpoint:f.access.endpoint,sessions,signIntent:f.signForTest,builderSend:send,consentSend:send,now:()=>f.now}),client=createBuilderClient({endpoint:f.access.endpoint,sessions,send});
  const declaration=builderDeclaration('worker',f.actor.subjectId);declaration.name='合成本机节点';let preview=await flow.prepare({kind:'declare',declaration,visibility:'Public'});const created=await flow.execute(preview,preview.confirmation),builderId=created.builderId;
  preview=await flow.prepare({kind:'node-control',builderId});await flow.execute(preview,preview.confirmation);controller=createHostConnectionController({sessions,endpoint:f.access.endpoint,builderClient:client,builderFlow:flow,historyClient});
  return{kind,f,directory,controller,records,state,calls,sessions,builderId,root,attempt,result,proof,close};
 }catch(e){await close();throw e;}
}
