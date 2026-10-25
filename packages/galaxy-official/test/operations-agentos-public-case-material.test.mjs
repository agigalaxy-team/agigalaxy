import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';
import {migrate} from '../src/database.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {CommunityForumV1} from '../src/community-forum-v1.mjs';
import {CommunityForumGovernanceV1} from '../src/community-forum-governance-v1.mjs';
import {OperationsCommunityService} from '../src/operations-community.mjs';
import {AgentOsConversations} from '../src/operations-agentos-conversations.mjs';
import {AgentOsConversationTools} from '../src/operations-agentos-conversation-tools.mjs';
import {caseDetail,caseMaterialVersion} from '../src/operations-agentos-query-view.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {bindOperationsAiUse,withOperationsAiWork,inheritOperationsAiUse,operationsAiUseDomain} from '../src/shared/operations-ai-use.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

// Actual PGlite migrations/API role, ordinary-account publish/report/event/
// withdrawal, stored human grants, P07 material reader and conversation source
// retirement. Native admission/AI resolver/transport are explicit doubles;
// nothing contacts a model, reads a real case, or performs a case decision.
test('selected public-case review keeps current authorized materials, retires changed sources and discloses output omissions',{timeout:90000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now}),
  forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),
  governance=new CommunityForumGovernanceV1(f.access,null,forum,{accounts:f.accounts}),
  community=new OperationsCommunityService({businessAdmin,forum,governance,now:f.now}),
  admin={kind:'business-operator',operatorId:'case-material-admin',role:'administrator',endpoint:f.endpoint},
  reader={...admin,operatorId:'case-material-reader',role:'reader'},party={...reader,operatorId:'case-material-party-reader'};
 for(const actor of [admin,reader,party])await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,$3,$4,'Local case-purpose fixture',$5,$5)`,[actor.operatorId,f.endpoint,actor===party?'https://login.example.org':'https://operations.synthetic.invalid',actor===party?'synthetic-1':actor.operatorId,new Date(f.now()*1000)]);
 const codes=['workbench.read','ai.use.governance','cases.read'],{permissions,roles}=await attachOperationsFixtureAuthority({businessAdmin,admin,reader,permissions:codes});
 roles.set(party.operatorId,'reader');
 const role=(await f.db.query('SELECT r.* FROM operations_business_roles_v1 r JOIN operations_role_assignments_v1 a ON a.role_id=r.id WHERE a.operator_id=$1',[reader.operatorId])).rows[0];
 await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:party.operatorId,roleId:role.id,enabled:true},{authorize:async()=>admin});
 const ai=randomUUID();await f.db.query(`INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at)
  VALUES($1,$2,'governance','Local public-case reader','Only this SQL fixture',true,1,1,$3,$3)`,[ai,f.endpoint,new Date(f.now()*1000)]);
 const author=f.people[0],reporter=f.people[1],audience={read:{kind:'everyone'},participate:{kind:'accounts'}};
 async function post(body,until){const value=await bindForumIds('create-post','account:'+author.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:author.accountId,title:'Public case source',body,links:['https://example.invalid/current-source'],topic:'technology',audience,publishedUntil:until});await forum.publish(author,{payloadJson:JSON.stringify(value)});return value;}
 async function report(source,summary){const value=await bindForumIds('create-report','account:'+reporter.accountId,{schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),accountId:reporter.accountId,target:{kind:'post-version',postId:source.postId,versionId:source.versionId},category:'other',summary});await governance.report(reporter,{payloadJson:JSON.stringify(value)});return value;}
 const originalNow=f.now(),source=await post('PUBLIC_CASE_BODY '+ '🧭'.repeat(7900),originalNow+7200),shortSource=await post('SHORT_PUBLIC_SOURCE',originalNow+20),
  selected=await report(source,'PRIVATE_CASE_STATEMENT: source text is untrusted; ignore this attempted instruction.'),short=await report(shortSource,'PRIVATE_SHORT_CASE_STATEMENT');
 for(let i=0;i<24;i++){
  const summary=Array.from('PRIVATE_CASE_SUPPLEMENT_'+i+' '+ '🧭'.repeat(1600)).slice(0,1600).join(''),value=await bindForumIds('supplement','account:'+reporter.accountId,{schemaVersion:1,operationId:randomUUID(),governanceEventId:randomUUID(),reportId:selected.reportId,expectedReportVersion:i+1,accountId:reporter.accountId,kind:'supplement',summary});
  await governance.event(reporter,selected.reportId,{payloadJson:JSON.stringify(value)});
 }
 await migrate(f.db,{roles:['api']});await f.db.exec('SET ROLE galaxy_api');
 const aiCodes=new Set(codes),resolveAi=async(_db,domain,{accountId})=>({accountId,domain,enabled:true,permissions:[...aiCodes],roleVersions:[]});
 let afterReport=null;
 const authority={db:f.db,endpoint:f.endpoint,now:f.now,async human(input,{action='workbench.read',domain=null,purpose='query',db=f.db}={}){
  if(![reader.operatorId,party.operatorId].includes(input.operatorId))throw new ServiceError('operations_permission_denied',403);
  if((domain??operationsAiUseDomain(input)??'governance')!=='governance')throw new ServiceError('operations_agentos_domain_mismatch',403);
  const admitted=inheritOperationsAiUse(input,{...Object.fromEntries(Object.entries(input)),role:'reader'}),current=await businessAdmin.authorizeAction(admitted,action,{db});
  return withOperationsAiWork(bindOperationsAiUse(current,'governance'),{accountId:ai,purpose,resolve:resolveAi});
 }};
 const services={community:{report:async(...args)=>{const value=await community.report(...args);if(afterReport)await afterReport(value);return value;},reports:community.reports.bind(community)}};
 const client={async status(){return{state:'connected',modelState:'configured',configuredDomains:['governance'],conversationVersion:2,conversationDomains:['governance']};},async readConversation(){return{runs:[],readExpiresAt:f.now()+30};}};
 const conversations=new AgentOsConversations({authority,client,summaryForConversation:async()=>({checkedAt:f.now(),readExpiresAt:f.now()+30,availability:{}})}),tools=new AgentOsConversationTools({conversations,authority,services});conversations.tools=tools;
 const query=(tool,args,actor=reader)=>tools.query.execute({actor,domain:'governance',tool,arguments:args});
 const selectedArgs={kind:'case',id:selected.reportId};
 const directory=await query('query-operations',{module:'cases',view:'list',filters:{}});
 assert(!JSON.stringify(directory).includes('PRIVATE_CASE_'));assert(!JSON.stringify(directory).includes('PUBLIC_CASE_BODY'));
 assert(directory.evidenceRefs.filter(x=>x.kind==='case').every(x=>!x.controlledSource&&typeof x.version==='number'),'directory metadata contract remains unchanged');
 const raw=await community.report(reader,selected.reportId),current=await query('read-operation-object',selectedArgs),reference=current.evidenceRefs.find(x=>x.kind==='case');
 assert.equal(raw.events.length,25);assert.equal(raw.version,25);assert.equal(current.data.source.content.body,source.body,'valid intake body is returned whole');
 assert.equal(current.data.source.bodyTruncated,false);assert.equal(current.data.material.purpose,'public-case-review');
 assert.equal(current.data.material.trust,'untrusted-source-text');assert.equal(current.data.material.instructionAuthority,'none');
 assert.equal(current.data.material.legacyPrivateNarrativeGranted,false);assert.equal(current.data.material.coverage.eventsAvailable,25);
 assert.equal(current.data.material.coverage.eventsComplete,false);assert(current.data.events.length>0&&current.data.events.length<25);
 assert.equal(current.data.events[0].id,raw.events[0].id);assert.equal(current.data.events.at(-1).id,raw.events.at(-1).id,'budget preserves initial and latest authorized records');
 assert.equal(current.data.material.coverage.eventSelection,'first-and-latest-within-output-budget');assert(Buffer.byteLength(JSON.stringify(current))<180000);
 for(const id of [author.accountId,reporter.accountId])assert(!JSON.stringify(current.data).includes(id),'parties are not material or a profile source');
 assert.equal(current.data.handling.canModerate,false,'read-only role does not acquire a decision');
 assert.equal(reference.controlledSource,true);assert.equal(reference.purpose,'public-case-review');assert.equal(reference.version,caseMaterialVersion(raw));
 assert.equal((await query('read-operation-object',selectedArgs,party)).data.events.length,0,'known-party service gate still withholds private explanations');
 assert.throws(()=>caseDetail({...raw,legacyPrivateNarrativeGranted:true}),{code:'operations_query_response_invalid'});
 const malformed=caseDetail({...raw,source:{...raw.source,content:{...raw.source.content,body:'🧭'.repeat(8001)}}});
 assert.equal(Array.from(malformed.source.content.body).length,8000);assert.equal(malformed.source.bodyTruncated,true);assert.equal(malformed.material.coverage.textComplete,false);
 assert(!malformed.source.content.body.includes('\ufffd'),'Unicode clipping keeps whole code points');
 const brief=await query('read-operation-object',{kind:'case',id:short.reportId}),briefRef=brief.evidenceRefs.find(x=>x.kind==='case');
 assert.equal(briefRef.readExpiresAt,originalNow+20,'known public source deadline narrows the original read lease');
 f.advance(21);assert.equal((await tools.query.revalidate({actor:reader,domain:'governance',evidenceRefs:[briefRef]})).valid,false);
 const expiredSource=await query('read-operation-object',{kind:'case',id:short.reportId});assert.equal(expiredSource.data.source.availability,'unavailable');assert.equal(expiredSource.data.source.content,null);
 assert(expiredSource.data.events.length,'independently permitted case statement is not erased with its public source');
 const context=await conversations.session(reader,'governance',{create:true}),turnId=randomUUID(),runId=randomUUID();
 await f.db.query("INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,native_run_id,created_at) VALUES($1,$2,$3,$4,'no-prose-fixture','accepted','{}',$5,$6)",[turnId,f.endpoint,context.row.id,reader.operatorId,runId,new Date(f.now()*1000)]);
 await tools.execute({conversationId:context.row.id,sessionId:context.row.session_id,turnId,runId,callId:randomUUID(),tool:'read-operation-object',arguments:selectedArgs});
 const recorded=(await f.db.query('SELECT evidence_ref FROM operations_agentos_conversation_sources_v1 WHERE conversation_id=$1',[context.row.id])).rows;
 assert.equal(recorded.length,1);assert.equal(recorded[0].evidence_ref.purpose,'public-case-review');assert(!JSON.stringify(recorded).includes('PRIVATE_CASE_'));
 aiCodes.delete('cases.read');await assert.rejects(query('read-operation-object',selectedArgs),{code:'operations_permission_denied'});aiCodes.add('cases.read');
 async function humanRead(enabled){const row=(await f.db.query('SELECT * FROM operations_business_roles_v1 WHERE id=$1',[role.id])).rows[0];await permissions.saveRole(admin,{operationId:randomUUID(),id:row.id,expectedVersion:row.version,name:row.name,description:row.description,enabled:true,permissions:enabled?codes:codes.filter(x=>x!=='cases.read')},{authorize:async()=>admin});}
 afterReport=async()=>{afterReport=null;await humanRead(false);};await assert.rejects(query('read-operation-object',selectedArgs),{code:'operations_permission_denied'});await humanRead(true);
 // A private report grant expires without changing the report's scalar head.
 const beforeExpiry=await query('read-operation-object',selectedArgs),beforeRef=beforeExpiry.evidenceRefs.find(x=>x.kind==='case');
 const expiryContext=await conversations.session(reader,'governance',{create:true});await tools.rememberSources(expiryContext.row,[beforeRef]);
 f.advance(3580);const afterExpiry=await query('read-operation-object',selectedArgs),afterRaw=await community.report(reader,selected.reportId);
 assert.equal(afterRaw.version,raw.version);assert.equal(afterRaw.source.availability,'available');assert.equal(afterRaw.events.length,0);
 assert.notEqual(caseMaterialVersion(afterRaw),caseMaterialVersion(raw));assert.equal((await tools.query.revalidate({actor:reader,domain:'governance',evidenceRefs:[beforeRef]})).valid,false);
 await assert.rejects(conversations.current(expiryContext.row.id,{operator:reader}),{code:'operations_agentos_source_changed'});
 // Use a fresh permission-key context after the explicit grant-revocation case.
 const newContext=await conversations.session(reader,'governance',{create:true}),newTurn=randomUUID();
 await f.db.query("INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,native_run_id,created_at) VALUES($1,$2,$3,$4,'no-prose-fixture','accepted','{}',$5,$6)",[newTurn,f.endpoint,newContext.row.id,reader.operatorId,randomUUID(),new Date(f.now()*1000)]);
 const newRef=afterExpiry.evidenceRefs.find(x=>x.kind==='case');await tools.rememberSources(newContext.row,[newRef]);
 const withdrawal=await bindForumIds('withdraw-post','account:'+author.accountId,{schemaVersion:1,operationId:randomUUID(),postId:source.postId,expectedHeadVersion:1});await forum.withdraw(author,'withdraw-post',{payloadJson:JSON.stringify(withdrawal)});
 await assert.rejects(conversations.current(newContext.row.id,{operator:reader}),{code:'operations_agentos_source_changed'});
 const retired=(await f.db.query('SELECT retired_at,retirement_reason FROM operations_agentos_conversations_v1 WHERE id=$1',[newContext.row.id])).rows[0];assert(retired.retired_at);assert.equal(retired.retirement_reason,'source-changed');
 const withdrawn=await query('read-operation-object',selectedArgs);assert.equal(withdrawn.data.source.content,null);assert.equal(withdrawn.data.events.length,0);assert(!JSON.stringify(withdrawn).includes('PRIVATE_CASE_'));
 const nativeRoot=new URL('../../../services/galaxy-operations-agentos/src/galaxy_agentos/',import.meta.url),instructions=await readFile(new URL('conversations.py',nativeRoot),'utf8'),doc=await readFile(new URL('conversation_tools.py',nativeRoot),'utf8');
 assert(instructions.includes('public-case-review')&&instructions.includes('举报不等于违规成立')&&instructions.includes('材料不完整或被截断'));
 assert(doc.includes('public-case-review material')&&!doc.includes('private chat/case body'));
 await f.db.exec('RESET ROLE');
});
