// Disposable PostgreSQL + real original identity/Consent/forum/chat business.
// Byte storage, archive transport and AV are explicit local protocol fixtures.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {join,isAbsolute} from 'node:path';
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {communityForumFixture} from '../../packages/galaxy-official/test/community-forum-fixture.mjs';
import {materialTask} from '../../packages/galaxy-official/test/task-material-fixture.mjs';
import {invite} from '../../packages/galaxy-official/test/chat-workflow.mjs';
import {ChatAttachmentsService} from '../../packages/galaxy-official/src/chat/chat-attachments.mjs';
import {OutcomeMaterialServiceV2} from '../../packages/galaxy-official/src/evidence/outcome-material-v2.mjs';
import {digest} from '../../packages/galaxy-official/src/shared/digest.mjs';
import {loadCommunityPolicy,PublicWriteService} from '../../packages/galaxy-official/src/publishing/public-writes.mjs';
import {transaction,migrate} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {taskMaterialPrepareSchema} from '../../packages/galaxy-official/src/shared/task-material-v1-schema.mjs';
import {taskRequestV2Schema} from '../../packages/galaxy-official/src/shared/task-schema-v2.mjs';
import {outcomeMaterialEventSchema} from '../../packages/galaxy-official/src/shared/outcome-material-v2-schema.mjs';
import {p14EmptyControls} from '../../packages/galaxy-official/src/shared/p14-rules-schema.mjs';
import {taskMaterialCaseContainerTitle,taskCaseContainerSummary} from '../../packages/galaxy-official/src/shared/cases-schema.mjs';
import {applyTaskV2,proposeParticipationV2,applyParticipationV2} from '../../packages/galaxy-official/src/domain/task-v2.mjs';
import {browserScopes} from '../../packages/galaxy-official/src/browser-client.mjs';
import {createNativeRecoveryWebFixture} from '../../packages/galaxy-official/test/native-recovery-web-fixture.mjs';
import {commentFingerprints} from '../../packages/galaxy-official/src/tasks/v2/comments-v2.mjs';
import {taskCommentV2Schema} from '../../packages/galaxy-official/src/shared/task-comment-v2-schema.mjs';
import {qualificationDefinitionHash,qualificationRegistryManifest} from '../../packages/galaxy-official/src/infrastructure/qualification-policy-registry.mjs';
import {qualificationPolicySchema} from '../../packages/galaxy-official/src/shared/qualification-schema.mjs';
import {applyAssistance} from '../../packages/galaxy-official/src/domain/assistance.mjs';

if(process.argv[2]==='qualification-policies'){
 const values=JSON.parse(await readFile(process.argv[3],'utf8'));console.log(JSON.stringify(values.map(input=>{try{const policy=qualificationPolicySchema.parse(input);return{accepted:true,policy,definitionHash:qualificationDefinitionHash(input)}}catch{return{accepted:false}}})));process.exit(0);
}

if(process.argv[2]==='fingerprints'){
 const values=JSON.parse(await readFile(process.argv[3],'utf8'));console.log(JSON.stringify(values.map(value=>commentFingerprints(JSON.parse(value)))));process.exit(0);
}

if(process.argv[2]==='schemas'){
 const cases=JSON.parse(await readFile(process.argv[3],'utf8'));console.log(JSON.stringify(cases.map(({kind,json})=>{const schema={prepare:taskMaterialPrepareSchema,task:taskRequestV2Schema,outcome:outcomeMaterialEventSchema,comment:taskCommentV2Schema}[kind];try{return{accepted:true,value:schema.parse(JSON.parse(json))}}catch{return{accepted:false}}})));process.exit(0);
}
if(process.argv[2]==='policies'){
 const path=process.argv[3],cases=JSON.parse(await readFile(path,'utf8')),result=[];
 for(let i=0;i<cases.length;i++){const file=path+'.'+i;await writeFile(file,cases[i]);try{result.push({accepted:true,value:await loadCommunityPolicy(file)})}catch{result.push({accepted:false})}}
 console.log(JSON.stringify(result));process.exit(0);
}
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated PostgreSQL required');
const dir=process.env.GALAXY_GO_TEST_MATERIAL_DIR;if(!isAbsolute(dir??''))throw Error('absolute disposable directory required');
const pool=new pg.Pool({connectionString:address.href,max:4}),endpoint='https://materials.example.invalid';
let f,bridge,recoveredRuntime;
try{
 await migrate(pool,{roles:['api']});
 f=await communityForumFixture({database:pool,migrateDatabase:false,endpoint,scopes:browserScopes});
 await pool.query(`INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at)VALUES($1,'business-controls',1,$2,'configured-baseline',$3)ON CONFLICT DO NOTHING`,[endpoint,JSON.stringify(p14EmptyControls),new Date(f.clock.now*1000)]);
 const p=await materialTask(f,{expiry:300});await f.login(f.responder,'outcome-source-author');
 const objects=new Map(),messages=new Map();
 const store={keyId:'isolated-key',async get({key}){return objects.get(key)??null},async put({key,bytes,sha256}){if(digest(bytes)!==sha256)throw Error('fixture integrity');objects.set(key,Buffer.from(bytes));return{stored:true}},async erase({key}){objects.delete(key);return{objectRemoved:true}}};
 const scanner={async scan(){return{state:'clean',fixtureOnly:true}}};
 const transport={available:true,async project(){return{projected:true}},async send(x){messages.set(x.messageId,{archiveId:x.messageId,text:x.text,revision:1});return{archiveId:x.messageId}},async read(x){return x.ids.map(id=>messages.get(id)).filter(Boolean)},async erase(x){messages.delete(x.archiveId??x.messageId);return{archiveDeleted:true}}};
 const chat=f.owner.chat;chat.transport=transport;
 const files=new ChatAttachmentsService({chat,store,scanner});chat.attachments=files;
 const outcome=new OutcomeMaterialServiceV2(f.owner.access,{consents:f.owner.consents,chat,records:f.owner.verificationRecords,attachments:files});
 const roomId=randomUUID();await chat.create(f.owner.actor,{roomId,operationId:randomUUID(),title:'Isolated current-source room'});await invite(chat,f.owner.actor,roomId,f.responder.actor);
 const caseId=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:f.owner.actor.subjectId,localRef:'isolated-'+caseId,title:'Selected result copy',summary:'Explicit local fixture',source:{kind:'local',reference:'isolated'},synthetic:true};
 await f.owner.cases.submitV2(f.owner.actor,await f.owner.authorize(root,'case.teaser.publish',{objectId:caseId}));
 const sent=await chat.send(f.responder.actor,roomId,{clientMessageId:randomUUID(),text:'Explicitly selected message 😀'});
 const selected=await chat.readSelectedWithin(pool,f.owner.actor,{messageId:sent.messageId,revision:1});
 async function proposal(source,title){
  const request={id:randomUUID(),materialId:randomUUID(),kind:'request',source,caseId,purpose:'Selected outcome copy',title,audience:{visibility:'Private',viewers:[f.responder.actor.subjectId]},uses:['evidence'],retention:'with-related-result; independently-authorized-copy',requestExpiresAt:new Date((f.clock.now+3600)*1000).toISOString()};
  const envelope=await f.owner.authorize(request,'outcome.material',{objectId:request.id,viewers:[f.responder.actor.subjectId]});
  const approval={id:randomUUID(),materialId:request.materialId,kind:'approve',expectedRevision:1,requestHash:digest(envelope.payloadJson),source,license:'authored-content',basis:'authored-content',scope:'Exact selected fixture content',independentRetention:true,temporarySourceExpiryRevokesCopy:false};
  const approve=await f.responder.authorize(approval,'outcome.material',{objectId:approval.id,viewers:[f.owner.actor.subjectId]});
  const control={id:randomUUID(),materialId:request.materialId,kind:'revoke',expectedRevision:2,reason:'Explicit fixture revoke'};
  return{request,envelope,approval,approve,control:await f.responder.authorize(control,'outcome.material',{objectId:control.id})};
 }
 const message=await proposal({kind:'message',id:sent.messageId,version:1,sha256:selected.contentHash,roomId},'Message result');
 const bytes=Buffer.from('Original isolated attachment bytes\n'),attachmentId=randomUUID();
 await files.prepare(f.responder.actor,{attachmentId,roomId,name:'result.txt',mediaType:'text/plain',size:bytes.length,sha256:digest(bytes),purpose:'temporary-room-attachment',confirmed:true});await files.upload(f.responder.actor,attachmentId,Readable.from([bytes]),{contentLength:bytes.length});await files.scanPending({limit:2});await chat.send(f.responder.actor,roomId,{clientMessageId:randomUUID(),text:'Explicit original attachment publication',attachments:[{id:attachmentId,sha256:digest(bytes)}]});
 const attachment=await proposal({kind:'attachment',id:attachmentId,version:1,sha256:digest(bytes),roomId},'Attachment result');
 const who=async x=>({subjectId:x.actor.subjectId,token:x.credential,accountId:(await x.communityAccounts.resolveWithin(pool,x.actor)).id});
 const linkedCaseId=randomUUID(),linkedRoot={schemaVersion:2,kind:'case-created',eventId:linkedCaseId,caseId:linkedCaseId,expectedVersion:0,actorId:f.owner.actor.subjectId,taskId:p.request.taskId,localRef:'task-'+linkedCaseId,title:taskMaterialCaseContainerTitle,summary:taskCaseContainerSummary,source:{kind:'active-task',reference:p.request.taskId},synthetic:true};
 const initial={schemaVersion:2,kind:'attempt-start',eventId:randomUUID(),caseId:linkedCaseId,expectedVersion:1,actorId:f.owner.actor.subjectId,taskId:p.request.taskId,role:'requester',strategy:'Selected local fixture work',inputScopeSummary:'Original controlled material scope',permissionScope:['selected-context']};
 const caseLink={operationId:randomUUID(),expectedTaskVersion:1,case:await f.owner.authorize(linkedRoot,'case.teaser.publish',{objectId:linkedRoot.eventId}),initialFact:await f.owner.authorize(initial,'case.teaser.publish',{objectId:initial.eventId})};
 const invitationEventId=randomUUID(),taskEvents=[];
 for(const [who,viewers,event] of [[f.owner,[f.responder.actor.subjectId],{eventId:invitationEventId,expectedTaskVersion:1,kind:'invite',recipientId:f.responder.actor.subjectId,note:'Explicit invitation',expiresAt:f.clock.now+300}],
 [f.responder,[f.owner.actor.subjectId],{eventId:randomUUID(),expectedTaskVersion:2,kind:'invitation-reply',invitationId:invitationEventId,response:'interested',message:'Interested on the stated scope'}],
 [f.responder,[f.owner.actor.subjectId],{eventId:randomUUID(),expectedTaskVersion:3,kind:'apply',proposal:'A concrete original application',scope:'Selected context only'}],
 [f.owner,[],{eventId:randomUUID(),expectedTaskVersion:4,kind:'suggest-contacts',state:'empty',items:[]}],
 [f.owner,[],{eventId:randomUUID(),expectedTaskVersion:18,kind:'stop-enrollment',reason:'Stop accepting new applications'}],
 [f.owner,[],{eventId:randomUUID(),expectedTaskVersion:19,kind:'close',reason:'Explicit task termination',terminationIntent:'terminate-task'}]]){
  const payload={taskId:p.request.taskId,event};taskEvents.push({owner:who===f.owner,input:await who.authorize(payload,'assistance.publish',{objectId:event.eventId,viewers})});
 }
 const participationId=randomUUID(),scope1=randomUUID(),scope2=randomUUID(),resolution=randomUUID(),participationCommands=[];
 const participationProposal={eventId:randomUUID(),expectedTaskVersion:5,kind:'propose',participationId,subjectId:f.responder.actor.subjectId,role:'contribution',scopeVersion:1,agreedScope:'Explicit selected fixture scope',applicationId:JSON.parse(taskEvents[2].input.payloadJson).event.eventId};
 const participationEvents=[[f.owner,participationProposal],
 [f.responder,{eventId:randomUUID(),expectedParticipationVersion:1,kind:'confirm',scopeVersion:1}],
 [f.owner,{eventId:scope1,expectedParticipationVersion:2,kind:'propose-scope',scopeVersion:2,agreedScope:'Proposed selected scope',reason:'Ask for precise revised scope'}],
 [f.responder,{eventId:randomUUID(),expectedParticipationVersion:3,kind:'decline-scope',proposalId:scope1,reason:'Retain current scope'}],
 [f.owner,{eventId:scope2,expectedParticipationVersion:4,kind:'propose-scope',scopeVersion:2,agreedScope:'Mutually selected scope',reason:'Revised explicit scope'}],
 [f.responder,{eventId:randomUUID(),expectedParticipationVersion:5,kind:'confirm-scope',proposalId:scope2}],
 [f.owner,{eventId:randomUUID(),expectedParticipationVersion:8,kind:'dispute',reason:'Explicitly record scope dispute'}],
 [f.owner,{eventId:resolution,expectedParticipationVersion:9,kind:'propose-resolution',outcome:'resume-work',summary:'Propose resuming stated work'}],
 [f.responder,{eventId:randomUUID(),expectedParticipationVersion:10,kind:'confirm-resolution',proposalId:resolution}],
 [f.responder,{eventId:randomUUID(),expectedParticipationVersion:11,kind:'withdraw',reason:'Stop own participation'}],
 [f.responder,{eventId:randomUUID(),expectedParticipationVersion:12,kind:'requester-feedback',descriptionClarity:'partly-clear',scopeMatched:true,note:'Provider report, no independent rating'}]];
 for(const [actor,event] of participationEvents){participationCommands.push({owner:actor===f.owner,proposal:event.kind==='propose',participationId,input:await actor.authorize(event,'assistance.publish',{objectId:event.eventId,viewers:[actor===f.owner?f.responder.actor.subjectId:f.owner.actor.subjectId]})})}
 const commentId=randomUUID(),commentCommands=[];
 for(const [kind,body] of [['create','Useful selected Task comment 😀 https://例子.测试:443/a/../b#section'],['edit','Revised original comment'],['correct','A correction after the original report'],['retract',null]]){
  const payload={schemaVersion:2,id:randomUUID(),commentId,taskId:p.request.taskId,expectedRevision:commentCommands.length,kind,...(body===null?{}:{body,visibility:'inherit-task'}),...(kind==='correct'?{reason:'Explicit correction'}:{})};
  commentCommands.push(await f.owner.authorize(payload,'comment.publish',{objectId:payload.id,...(kind==='retract'?{}:{visibility:'Public',purpose:'public-profile'})}));
 }
 for(const actor of [f.owner,f.responder,f.moderator])actor.commentGovernance.moderatorIds=[f.moderator.actor.subjectId];
 const reportId=randomUUID(),governanceCommands=[];
 const report={schemaVersion:2,id:reportId,target:{type:'task-comment',id:commentId,revision:1},category:'review-request',summary:'Request review of the selected original comment'};
 governanceCommands.push({owner:true,input:await f.owner.authorize(report,'moderation.publish',{objectId:report.id,viewers:[f.moderator.actor.subjectId]})});
 for(const [actor,fields] of [[f.moderator,{kind:'pause',until:f.clock.now+600,rule:'Explicit temporary source review'}],[f.moderator,{kind:'resume'}],[f.moderator,{kind:'resolve',verdict:'dismissed',reviewDisposition:'approve',rule:'Original comment acceptable'}],[f.owner,{kind:'appeal'}],[f.moderator,{kind:'resolve',verdict:'upheld',reviewDisposition:'reject',rule:'Record changed review disposition'}]]){
  const payload={schemaVersion:2,id:randomUUID(),reportId,expectedVersion:governanceCommands.length,summary:'Explicit configured operator process',...fields};governanceCommands.push({owner:actor===f.owner,input:await actor.authorize(payload,'moderation.publish',{objectId:payload.id,viewers:[actor===f.owner?f.moderator.actor.subjectId:f.owner.actor.subjectId]})});
 }
 const metadata={endpoint,now:f.clock.now,issuer:f.issuer.issuer,owner:await who(f.owner),author:await who(f.responder),moderator:{subjectId:f.moderator.actor.subjectId,token:f.moderator.credential},task:p,roomId,message,attachment,caseLink,taskEvents,participationCommands,commentCommands,governanceCommands,attachmentBytesBase64:bytes.toString('base64')};
 const legacyCaseId=randomUUID(),legacyCase={kind:'case',id:legacyCaseId,localRef:'legacy-'+legacyCaseId,title:'Original v1 Case source',summary:'Explicit isolated source record',source:{kind:'local',reference:'legacy-'+legacyCaseId},participants:[{subjectId:f.owner.actor.subjectId,role:'requester'},{subjectId:f.responder.actor.subjectId,role:'provider'}]};
 await f.owner.cases.submit(f.owner.actor,await f.owner.authorize(legacyCase,'case.teaser.publish',{objectId:legacyCase.id,viewers:[f.responder.actor.subjectId]}));
 const legacyAttempt={kind:'attempt',id:randomUUID(),caseId:legacyCaseId,expectedVersion:1,sequence:1,approach:'Explicit local attempt report',configuration:{environment:'isolated',version:'1',tools:[]}};
 await f.owner.cases.submit(f.owner.actor,await f.owner.authorize(legacyAttempt,'case.teaser.publish',{objectId:legacyAttempt.id,viewers:[f.responder.actor.subjectId]}));
 const legacyRequest={id:randomUUID(),caseId:legacyCaseId,title:'Original v1 assistance',problem:'Participant-reported work, not a capability certificate',attemptedApproaches:['Original recorded attempt'],scope:'Explicit collaboration scope',visibility:'Private',collaboration:'open-assistance',capabilityId:'code',enrollmentExpiresAt:f.clock.now+3600};
 const legacy={request:legacyRequest,input:await f.owner.authorize(legacyRequest,'assistance.publish',{objectId:legacyRequest.id,viewers:[f.responder.actor.subjectId]}),commands:[]};
 const offer1=randomUUID(),offer2=randomUUID(),delivery1=randomUUID(),delivery2=randomUUID(),resolution1=randomUUID();
 for(const [actor,fields] of [[f.owner,{kind:'invite',participantId:f.responder.actor.subjectId,note:'Explicit original invitation'}],[f.responder,{kind:'offer',id:offer1,proposal:'First original proposal',scope:'Initial proposed scope'}],[f.owner,{kind:'shortlist',offerIds:[offer1]}],[f.responder,{kind:'withdraw-offer',offerId:offer1,reason:'Withdraw own first proposal'}],[f.responder,{kind:'offer',id:offer2,proposal:'Revised original proposal',scope:'Selected proposed scope'}],[f.owner,{kind:'shortlist',offerIds:[offer2]}],[f.owner,{kind:'select',offerId:offer2}],[f.responder,{kind:'confirm'}],[f.owner,{kind:'change-scope',scope:'Mutually revised scope',reason:'Explicit scope revision'}],[f.responder,{kind:'confirm-scope'}],[f.responder,{kind:'deliver',id:delivery1,attemptId:legacyAttempt.id,summary:'Participant reports a delivery',evidenceIds:[],caseReviewVersion:0}],[f.owner,{kind:'accept',deliveryId:delivery1,summary:'Requester acknowledges reported delivery'}],[f.responder,{kind:'requester-feedback',descriptionClarity:'clear',scopeMatched:true,note:'Provider report only'}],[f.owner,{kind:'dispute',reason:'Record explicit dispute'}],[f.owner,{kind:'propose-resolution',id:resolution1,summary:'Propose resuming the agreed work',outcome:'resume-work'}],[f.responder,{kind:'confirm-resolution',proposalId:resolution1}],[f.responder,{kind:'deliver',id:delivery2,attemptId:legacyAttempt.id,summary:'Participant reports later delivery',evidenceIds:[],caseReviewVersion:0}],[f.owner,{kind:'accept',deliveryId:delivery2,summary:'Requester acknowledges later delivery'}]]){
  const event={id:randomUUID(),expectedVersion:legacy.commands.length+1,...fields},payload={assistanceId:legacyRequest.id,event};legacy.commands.push({owner:actor===f.owner,input:await actor.authorize(payload,'assistance.publish',{objectId:event.id,viewers:[actor===f.owner?f.responder.actor.subjectId:f.owner.actor.subjectId]})});
 }
 metadata.legacy=legacy;
 bridge=createServer(async(req,res)=>{try{
  if(req.method!=='POST'||req.url!=='/fixture'){res.writeHead(404);res.end();return}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString()),x=input.value??{};let result;
  switch(input.action){
   case 'store-get':{const bytes=await store.get(x);result={bytesBase64:bytes?.toString('base64')??null};break}
   case 'store-put':result=await store.put({...x,bytes:Buffer.from(x.bytesBase64,'base64')});break;
   case 'store-erase':result=await store.erase(x);break;
   case 'transport':{const action=x.action,payload=x.payload;result=action==='read'?{messages:await transport.read(payload)}:await transport[action](payload);break}
   case 'source':result=await f.owner.assistance.taskMaterials.sourceWithin(pool,x.source,{ownerId:f.owner.actor.subjectId});break;
   case 'read-task':result=await f.owner.assistance.getTask(f.owner.actor,p.request.taskId);break;
   case 'query-task-wire':result={json:JSON.stringify(await f.owner.assistance.queryTasks(f.owner.actor,{view:'requested'}))};break;
   case 'task-history-wire':{const v=await f.owner.assistance.readTaskWithin(pool,f.owner.actor,p.request.taskId),request={title:v.request.title,summary:v.request.summary,...(v.request.capabilityId?{capabilityId:v.request.capabilityId}:{})};result={json:JSON.stringify({requesterId:v.requesterId,caseId:v.caseId,request,...(v.textView?{textView:{format:v.textView.format,checkedAt:v.textView.checkedAt,fields:{title:v.textView.fields.title,summary:v.textView.fields.summary}}}:{}),participations:(v.participations??[]).map(p=>({subjectId:p.subjectId,participationId:p.participationId,role:p.role,...(p.scopeAvailable===undefined?{}:{scopeAvailable:p.scopeAvailable}),agreedScope:p.agreedScope,scopeVersion:p.scopeVersion,events:p.events,deliveries:p.deliveries}))})};break;}
   case 'history-v2':result=await f.owner.history.v2.query(f.owner.actor,{subjectId:f.owner.actor.subjectId,limit:50});break;
   case 'history-revoke-scope':{const row=(await pool.query('SELECT consent_id FROM task_events WHERE id=$1',[scope2])).rows[0];result=await f.owner.consents.revoke(f.owner.actor,row.consent_id);break;}
   case 'status-task':result=await f.owner.assistance.taskMaterials.status(f.owner.actor,p.request.taskId,f.owner.assistance);break;
   case 'quota':result=await f.owner.publicWrites.status(f.owner.actor);break;
   case 'comment-view':result=await f.owner.comments.get(x.anonymous?null:x.author?f.responder.actor:f.owner.actor,x.id);break;
   case 'comment-query':result=await f.owner.comments.query(f.owner.actor,{taskId:p.request.taskId});break;
   case 'comment-receipt':result=await f.owner.comments.receipt(f.owner.actor,x);break;
   case 'governance-view':result=await f.owner.commentGovernance.get(x.moderator?f.moderator.actor:f.owner.actor,x.id);break;
   case 'governance-query':result=await f.owner.commentGovernance.query(x.moderator?f.moderator.actor:f.owner.actor,{});break;
   case 'governance-receipt':result=await f.owner.commentGovernance.receipt(x.moderator?f.moderator.actor:f.owner.actor,{operationId:x.operationId,payloadHash:x.payloadHash});break;
   case 'block-comment-party':{const options=await f.owner.inbox.options(f.owner.actor);result=await f.owner.inbox.saveOptions(f.owner.actor,{expectedRevision:options.revision,settings:{...options.settings,blockedSubjectIds:[f.responder.actor.subjectId]}});break;}
   case 'inbox-query':result=await f.owner.inbox.query(x.moderator?f.moderator.actor:f.owner.actor,x.input??{});break;
   case 'inbox-options':result=await f.owner.inbox.options(f.owner.actor);break;
   case 'inbox-one':result=await f.owner.inbox.oneWithin(pool,f.owner.actor,x.id);break;
   case 'inbox-claim':result=await f.owner.inbox.claim(f.owner.actor,x);break;
   case 'inbox-presented':result=await f.owner.inbox.presented(f.owner.actor,x);break;
   case 'notification-preferences':result=await f.owner.notifications.preferences(f.owner.actor);break;
   case 'notification-save':result=await f.owner.notifications.save(f.owner.actor,x);break;
   case 'notification-query':result=await f.owner.notifications.query(f.owner.actor,x);break;
   case 'notification-archive':result=await f.owner.notifications.archive(f.owner.actor,x);break;
   case 'legacy-read':result=await f.owner.assistance.get(x.author?f.responder.actor:f.owner.actor,legacyRequest.id);break;
   case 'legacy-task-read':result=await f.owner.assistance.getTask(x.author?f.responder.actor:f.owner.actor,legacyRequest.id);break;
   case 'legacy-query':result=await f.owner.assistance.query(f.owner.actor,{view:'requested'});break;
   case 'legacy-transition':result=applyAssistance(x.state,x.actor,x.event,f.clock.now);break;
   case 'legacy-receipt':result=await f.owner.assistance.receipt(x.author?f.responder.actor:f.owner.actor,{assistanceId:x.assistanceId,eventId:x.eventId,payloadHash:x.payloadHash});break;
   case 'notifications-only-moderator':await f.reconnect(f.moderator,['binding','notifications']);result={token:f.moderator.credential};break;
   case 'consume':result=await transaction(pool,tx=>f.owner.publicWrites.consumeWithin(tx,f.owner.actor,x));break;
   case 'task-transition':result=applyTaskV2(x.state,x.actor,x.event,f.clock.now);break;
   case 'participation-transition':result=x.proposal?proposeParticipationV2(x.task,x.actor,x.event,f.clock.now):applyParticipationV2(x.task,x.state,x.actor,x.event,f.clock.now);break;
   case 'delivery':{
    const common={schemaVersion:2,caseId:linkedCaseId,actorId:f.responder.actor.subjectId,taskId:p.request.taskId,participationId,taskScopeVersion:1,participationScopeVersion:2};
    const attempt={...common,kind:'attempt-start',eventId:randomUUID(),expectedVersion:2,role:'contribution',strategy:'Actual isolated participant work',inputScopeSummary:'Explicit selected source',permissionScope:['selected-context']};
    const started=await f.responder.cases.submitV2(f.responder.actor,await f.responder.authorize(attempt,'case.teaser.publish',{objectId:attempt.eventId,viewers:[f.owner.actor.subjectId]}));
    const fact={...common,kind:'result-recorded',eventId:randomUUID(),expectedVersion:3,origin:{kind:'attempt',...started.objectRef},scopeVersion:1,deliverableRefs:[],reportedOutcome:'partial',summary:'Participant-reported result',limitations:'Explicit fixture only'};
    const recorded=await f.responder.cases.submitV2(f.responder.actor,await f.responder.authorize(fact,'case.teaser.publish',{objectId:fact.eventId,viewers:[f.owner.actor.subjectId]}));
    const delivery={eventId:randomUUID(),expectedParticipationVersion:6,kind:'deliver',resultRef:recorded.objectRef,interventionRefs:[],evidenceRefs:[],summary:'Submit actual selected result'};
    const acceptance={eventId:randomUUID(),expectedParticipationVersion:7,kind:'accept',deliveryId:delivery.eventId,summary:'Requester accepts the reported result'};
    result={deliver:await f.responder.authorize(delivery,'assistance.publish',{objectId:delivery.eventId,viewers:[f.owner.actor.subjectId]}),accept:await f.owner.authorize(acceptance,'assistance.publish',{objectId:acceptance.eventId,viewers:[f.responder.actor.subjectId]})};break;
   }
   case 'revoke-task-root':{const row=(await pool.query('SELECT consent_id FROM task_events WHERE id=$1',[p.request.operationId])).rows[0];result=await f.owner.consents.revoke(f.owner.actor,row.consent_id);break;}
   case 'owner-recovery':{
    const values=new Map(),nativeStore={get:async key=>structuredClone(values.get(key)),put:async(key,value)=>values.set(key,structuredClone(value)),update:async(key,change)=>{const next=change(structuredClone(values.get(key)));if(next&&typeof next.then==='function')throw Error('synchronous fixture transaction required');values.set(key,structuredClone(next));return structuredClone(next)}};
    let token;recoveredRuntime=await createNativeRecoveryWebFixture({endpoint,trustedKeys:f.owner.bindings.trustedKeys},{store:nativeStore,now:()=>f.clock.now,fetch:(url,options)=>{const credential=new Headers(options.headers).get('authorization');if(credential?.startsWith('Bearer '))token=credential.slice(7);return fetch(f.origin+new URL(url).pathname,options)}});
    const runtime=recoveredRuntime;await runtime.connect({confirmed:true});const recovery=await runtime.prepareRecovery();await runtime.saveRecovery({operationId:recovery.operationId,confirmed:true});
    const sign=async(payloadJson,action,objectId,expiresAt=f.clock.now+7200)=>runtime.api.submitAuthorization(await runtime.api.prepareAuthorization(payloadJson,{action,objectId,visibility:'Private',viewers:[],expiresAt,confirmed:true}),{confirmed:true});
    const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',title:'Retained recovered owner work',summary:'Exact authored recovery fixture',workContext:{goal:'Retain original authored bytes',currentSituation:'Recover same controlled ID',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.clock.now+10000};
    const original=await sign(JSON.stringify(task),'assistance.publish',task.operationId);await runtime.api.call('/v2/tasks',original);
    const recovered=await runtime.recover(recovery.code,{confirmed:true});await runtime.confirmRecoveredCode({operationId:recovered.operationId,confirmed:true});await runtime.connect({confirmed:true});
    const operationId=randomUUID(),preview=await runtime.api.call(`/v2/tasks/${task.taskId}/owner-read/prepare`,{operationId});
    const request=await sign(preview.payloadJson,'task.owner-read',operationId,preview.expiresAt);const read=await runtime.api.call(`/v2/tasks/${task.taskId}/owner-read`,request);
    const controlInput={operationId:randomUUID(),kind:'stop-enrollment',reason:'Recovered owner stops new enrollment'};const controlPreview=await runtime.api.call(`/v2/tasks/${task.taskId}/owner-control/prepare`,controlInput);
    const controlRequest=await sign(controlPreview.payloadJson,'assistance.publish',controlInput.operationId,controlPreview.expiresAt);
    result={task,operationId,preview,request,read,controlInput,controlPreview,controlRequest,token};break;
   }
   case 'read-outcome':result=await outcome.read(f.owner.actor,{id:x.id});break;
   case 'receipt-outcome':result=await outcome.operationReceipt(f.owner.actor,x);break;
   case 'revoke-source':result=await f.owner.consents.revoke(f.owner.actor,p.source.consentId);break;
   case 'expire-chat-source':await pool.query('UPDATE chat_message_refs SET expires_at=$2 WHERE message_id=$1',[sent.messageId,new Date((f.clock.now-1)*1000)]);result={expired:true};break;
   default:throw Error('unknown fixture action');
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({result}));
 }catch(e){res.writeHead(e.status??500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.code??e.message}))}});
 await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));metadata.bridge='http://127.0.0.1:'+bridge.address().port+'/fixture';
 await writeFile(join(dir,'fixture.json'),JSON.stringify(metadata),{mode:0o600});console.log('ready');await new Promise(resolve=>process.stdin.once('data',resolve));
}finally{recoveredRuntime?.close();if(bridge){bridge.closeAllConnections();await new Promise(resolve=>bridge.close(resolve))}if(f)await f.close();await pool.end()}
