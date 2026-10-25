import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {extendedNativeHttpDefinitions} from '../../galaxy-edge-mcp/src/native-v2/tools/extended-http.mjs';
import {configurationToolDefinitions} from '../src/adapters/mcp/personal/tools/configurations-v2.mjs';
import {builderToolDefinitions} from '../src/adapters/mcp/personal/tools/builders-v2.mjs';
import {qualificationToolDefinitions} from '../src/adapters/mcp/personal/tools/qualification-v2.mjs';
import {honorToolDefinitions} from '../src/adapters/mcp/personal/tools/honor-v2.mjs';
import {ciToolDefinitions} from '../src/adapters/mcp/personal/tools/ci-v2.mjs';
import {attachmentToolDefinitions} from '../src/adapters/mcp/personal/tools/attachments.mjs';
import {hubToolDefinitions} from '../src/adapters/mcp/personal/tools/hubs-v2.mjs';
import {workerPackUseToolDefinitions} from '../src/adapters/mcp/personal/tools/worker-pack-uses-v2.mjs';
import {informationToolDefinitions} from '../src/adapters/mcp/personal/tools/information-v2.mjs';
import {targetGovernanceToolDefinitions} from '../src/adapters/mcp/personal/tools/target-governance-v2.mjs';
import {moderationToolDefinitions} from '../src/adapters/mcp/personal/tools/moderation-v2.mjs';
import {communityToolDefinitions} from '../src/adapters/mcp/personal/tools/community-v1.mjs';
import {readingBookmarkToolDefinitions} from '../src/adapters/mcp/personal/tools/reading-bookmarks-v1.mjs';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {digest} from '../src/shared/digest.mjs';

const factories=[configurationToolDefinitions,builderToolDefinitions,qualificationToolDefinitions,honorToolDefinitions,ciToolDefinitions,attachmentToolDefinitions,hubToolDefinitions,workerPackUseToolDefinitions,informationToolDefinitions,targetGovernanceToolDefinitions,moderationToolDefinitions,communityToolDefinitions,readingBookmarkToolDefinitions];
const invoke=(tools,name,input)=>tools[name].run(tools[name].inputSchema.parse(input));

test('extended native HTTP reuses every canonical capability and preserves signed bytes without model confirmation or attachment bytes',async()=>{
 const accounts=[{id:randomUUID(),email:'PRIVATE_LINKED_ACCOUNT_EMAIL'},{id:randomUUID(),displayName:'PRIVATE_LINKED_ACCOUNT_LABEL'}],
  calls=[],native=extendedNativeHttpDefinitions({call:async(...args)=>{calls.push(args);return args[0]==='/v2/account-archives/accounts'?{accounts,subjectId:'NOT_PROJECTED'}:{transport:'synthetic-routing-only'};}});
 const spy=new Proxy(()=>{}, {get:()=>spy,apply:()=>({transport:'canonical-shape-only'})});
 const canonical=Object.assign({},...factories.map(f=>f(spy,null)));
 assert.deepEqual(Object.keys(native).sort(),Object.keys(canonical).sort());assert.equal(Object.keys(native).length,98);
 for(const[name,tool]of Object.entries(native)){
  assert.equal(tool.scope,canonical[name].scope,name);assert.equal(tool.write,canonical[name].write,name);assert.equal(tool.description,canonical[name].description,name);
 }
 const signed={consentId:randomUUID(),payloadJson:'{\n  "exact": "Synthetic bytes and spaces stay unchanged"\n}'};
 const writes={galaxy_configuration_v2_submit:'/v2/configurations/events',galaxy_builder_support_publish:'/v2/builders/support/events',
  galaxy_experience_submit:'/v2/experience/submit',galaxy_qualification_calculation_permission:'/v2/qualification/calculation-permissions',
  galaxy_qualification_permission_request:'/v2/qualification/permission-requests/events',galaxy_contribution_publish:'/v2/contributions/publish',
  galaxy_ci_v2_observe:'/v2/ci/requests',galaxy_ci_v2_proof_publish:'/v2/ci/proofs/publish',
  galaxy_hub_events:'/v2/hubs/events',galaxy_hub_peering_events:'/v2/hubs/peering/events',galaxy_worker_pack_use_record:'/v2/builders/pack-uses/events',
  galaxy_target_governance_report:'/v2/target-governance/reports',galaxy_target_governance_event:'/v2/target-governance/events',
  galaxy_moderation_report:'/v1/moderation/reports'};
 for(const[name,path]of Object.entries(writes)){
  assert.equal(native[name].inputSchema.safeParse({...signed,confirmed:true}).success,false,name);
  await invoke(native,name,signed);assert.deepEqual(calls.at(-1),[path,signed]);
 }
 const id=randomUUID(),hash='a'.repeat(64),source={kind:'case-event',id,eventVersion:1,payloadHash:hash};
 assert.equal(native.galaxy_moderation_event.inputSchema.safeParse({reportId:id,...signed,confirmed:true}).success,false);
 await invoke(native,'galaxy_moderation_event',{reportId:id,...signed});assert.deepEqual(calls.at(-1),['/v1/moderation/reports/'+id+'/events',signed]);
 await invoke(native,'galaxy_moderation_get',{reportId:id});assert.deepEqual(calls.at(-1),['/v1/moderation/reports/'+id+'/read',{}]);
 await invoke(native,'galaxy_moderation_receipt',{reportId:id,eventId:id,payloadHash:hash});
 assert.deepEqual(calls.at(-1),['/v1/moderation/reports/'+id+'/receipt',{eventId:id,payloadHash:hash}]);
 const samples={
  galaxy_community_account_options:[{},'/v2/account-archives/accounts'],
  galaxy_community_owned:[{topic:'technology'},'/v2/community/posts/owned'],
  galaxy_bookmarks:[{kind:'forum-post'},'/v2/reading-bookmarks/query'],
  galaxy_bookmark_status:[{reference:{kind:'forum-post',postId:id}},'/v2/reading-bookmarks/status'],
  galaxy_bookmark_command:[{operationId:id,reference:{kind:'forum-post',postId:id},saved:true,expectedRevision:0},'/v2/reading-bookmarks/command'],
  galaxy_bookmark_receipt:[{operationId:id,payloadHash:hash},'/v2/reading-bookmarks/receipt'],
  galaxy_configuration_v2_read:[{id,version:3},'/v2/configurations/read'],galaxy_configuration_v2_query:[{},'/v2/configurations/query'],
  galaxy_configuration_v2_versions:[{id,afterVersion:1},'/v2/configurations/versions'],galaxy_configuration_v2_receipt:[{operationId:id,payloadHash:hash},'/v2/configurations/receipt'],
  galaxy_builder_support_read:[{builderId:id},'/v2/builders/support/read'],galaxy_builder_pack_export:[{builderId:id,manifestId:id},'/v2/builders/pack/export'],
  galaxy_builder_read:[{builderId:id},'/v1/builders/read'],galaxy_builder_owned:[{},'/v1/builders/owned/query'],
  galaxy_builder_receipt:[{builderId:id,eventId:id,payloadHash:hash},'/v1/builders/events/receipt'],galaxy_builder_notices:[{builderId:id},'/v1/builders/notices/query'],
  galaxy_experience_read:[{id,version:2},'/v2/experience/read'],
  galaxy_qualification_v2_evaluate:[{taskId:id,subjectId:'GUID'+'A'.repeat(28)},'/v2/qualification/evaluate'],
  galaxy_qualification_v2_candidates:[{taskId:id,kind:'participation'},'/v2/qualification/candidates'],
  galaxy_qualification_permission_plan:[{taskId:id,participationIds:[id],expiresAt:'2033-05-18T03:33:20Z'},'/v2/qualification/permission-requests/plan'],
  galaxy_qualification_permission_requests:[{view:'sent'},'/v2/qualification/permission-requests/query'],
  galaxy_qualification_permission_request_read:[{requestId:id},'/v2/qualification/permission-requests/read'],
  galaxy_qualification_permission_request_receipt:[{eventId:id,payloadHash:hash},'/v2/qualification/permission-requests/receipt'],
  galaxy_qualification_calculation_receipt:[{operationId:id,payloadHash:hash},'/v2/qualification/calculation-receipt'],
  galaxy_qualification_calculation_owned:[{},'/v2/qualification/calculation-owned'],
  galaxy_contribution_status:[{publicationId:id},'/v2/contributions/status'],
  galaxy_contribution_sources:[{kind:'case-event',parentId:id},'/v2/contributions/sources'],
  galaxy_contribution_preview:[{sourceRefs:[{...source,fields:['eventType','actorId']}],purposes:['honor']},'/v2/contributions/preview'],
  galaxy_contribution_read:[{source,purpose:'honor'},'/v2/contributions/read'],
  galaxy_honor_v2_query:[{ruleId:'synthetic',ruleVersion:'1',subjectId:'GUID'+'A'.repeat(28)},'/v2/honor/query'],
  galaxy_honor_v2_ranking:[{ruleId:'synthetic',ruleVersion:'1'},'/v2/honor/ranking'],
  galaxy_requester_history_v2_query:[{},'/v2/requester-history/query'],galaxy_requester_history_v2_facts:[{rootEventId:id},'/v2/requester-history/facts'],
  galaxy_ci_v2_receipt:[{id,type:'request'},'/v2/ci/receipts'],galaxy_ci_v2_read:[{id},'/v2/ci/requests/read'],galaxy_ci_v2_stop:[{id},'/v2/ci/requests/revoke'],
  galaxy_ci_v2_proof_preview:[{id,requestId:id},'/v2/ci/proofs/preview'],galaxy_ci_v2_proof_read:[{id},'/v2/ci/proofs/read'],galaxy_ci_v2_proof_revoke:[{id},'/v2/ci/proofs/revoke'],
  galaxy_attachment_config:[{},'/v2/chat/attachments/config'],galaxy_attachment_read:[{attachmentId:id,agentGrantId:id},'/v2/chat/attachments/read'],
  galaxy_attachment_owned:[{roomId:id},'/v2/chat/attachments/query'],galaxy_attachment_revoke:[{attachmentId:id},'/v2/chat/attachments/revoke'],
  galaxy_hub_status:[{},'/v2/hubs/status'],galaxy_hub_query:[{},'/v2/hubs/query'],galaxy_hub_read:[{hubId:id},'/v2/hubs/read'],
  galaxy_hub_manage:[{hubId:id},'/v2/hubs/manage'],galaxy_hub_memberships:[{hubId:id},'/v2/hubs/memberships'],
  galaxy_hub_intake:[{hubId:id},'/v2/hubs/intake'],galaxy_hub_receipt:[{operationId:id,payloadHash:hash},'/v2/hubs/receipt'],
  galaxy_hub_peering_party:[{hubId:id},'/v2/hubs/peering/party'],galaxy_hub_peering_connections:[{hubId:id},'/v2/hubs/peering/connections'],
  galaxy_hub_peering_sources:[{hubId:id,kind:'ci-proof-v2'},'/v2/hubs/peering/sources'],
  galaxy_hub_peering_read:[{hubId:id,agreementId:id},'/v2/hubs/peering/read'],
  galaxy_hub_peering_list:[{hubId:id,kind:'agreements'},'/v2/hubs/peering/list'],
  galaxy_hub_peering_preview:[{hubId:id,agreementId:id,source:{kind:'ci-proof-v2',id,payloadHash:hash}},'/v2/hubs/peering/preview'],
  galaxy_hub_peering_query:[{hubId:id,agreementId:id,queryId:id},'/v2/hubs/peering/query'],
  galaxy_hub_peering_receipt:[{operationId:id,payloadHash:hash},'/v2/hubs/peering/receipt'],
  galaxy_worker_pack_manifest:[{builderId:id,manifestId:id},'/v2/builders/pack/manifest'],
  galaxy_worker_pack_candidates:[{},'/v2/builders/pack-uses/candidates'],galaxy_worker_pack_use_read:[{id},'/v2/builders/pack-uses/read'],
  galaxy_worker_pack_uses:[{},'/v2/builders/pack-uses/query'],galaxy_worker_pack_use_receipt:[{operationId:id,payloadHash:hash},'/v2/builders/pack-uses/receipt'],
  galaxy_information_query:[{purpose:'Selected current sources',sources:[{key:'methods',source:{kind:'search',request:{type:'capsule',query:{}}}}]},'/v2/information/query'],
  galaxy_information_watch_change:[{operationId:id,watchId:id,expectedRevision:1,action:'pause'},'/v2/information/watches/command'],
  galaxy_information_watches:[{},'/v2/information/watches/list'],galaxy_information_watch_receipt:[{operationId:id,requestHash:hash},'/v2/information/watches/receipt'],
  galaxy_information_watch_check:[{watchId:id,expectedRevision:1},'/v2/information/watches/check'],galaxy_information_watch_events:[{watchId:id},'/v2/information/watches/events'],
  galaxy_target_governance_config:[{},'/v2/target-governance/config',{method:'GET'}],
  galaxy_target_governance_get:[{reportId:id},'/v2/target-governance/'+id,{method:'GET'}],
  galaxy_target_governance_target:[{type:'task',id},'/v2/target-governance/target'],
  galaxy_target_governance_query:[{},'/v2/target-governance/query'],galaxy_target_governance_receipt:[{eventId:id,payloadHash:hash},'/v2/target-governance/receipt'],
  galaxy_moderation_config:[{},'/v1/moderation/config'],galaxy_moderation_query:[{},'/v1/moderation/reports/query'],
 };
 assert.equal(Object.keys(samples).length+Object.keys(writes).length+3+5,Object.keys(native).length,'every canonical leaf has a transport case or local catalog check');
 for(const[name,[input,path,options]]of Object.entries(samples)){
  const parsed=native[name].inputSchema.parse(input);await native[name].run(parsed);assert.deepEqual(calls.at(-1),options?[path,null,options]:[path,parsed],name);
 }
 assert.deepEqual(await invoke(native,'galaxy_community_account_options',{}),{items:accounts.map(({id})=>({id})),selectionRequired:true});
 assert.equal(native.galaxy_community_account_options.inputSchema.safeParse({accountId:id}).success,false);
 const malformed=extendedNativeHttpDefinitions({call:async()=>({items:[]})});
 await assert.rejects(invoke(malformed,'galaxy_community_account_options',{}),{code:'native_account_options_unavailable'});
 const publicReads={
  galaxy_community_query:[{topic:'technology',query:'selected topic'},'/v2/community/posts/query'],
  galaxy_community_replies:[{postId:id,postVersionId:id},'/v2/community/replies/query'],
  galaxy_community_versions:[{postId:id},'/v2/community/posts/'+id+'/versions'],
 };
 for(const[name,[input,path]]of Object.entries(publicReads)){
  const parsed=native[name].inputSchema.parse(input);await native[name].run(parsed);
  const expected=name==='galaxy_community_versions'?{limit:parsed.limit}:parsed;
  assert.deepEqual(calls.at(-1),[path,expected,{authenticated:false}],name);
 }
 await invoke(native,'galaxy_community_read',{postId:id});
 assert.deepEqual(calls.at(-1),['/v2/community/posts/'+id,undefined,{method:'GET',authenticated:false}]);
 await invoke(native,'galaxy_community_read',{postId:id,versionId:id});
 assert.deepEqual(calls.at(-1),['/v2/community/posts/'+id+'/versions/'+id,undefined,{method:'GET',authenticated:false}]);
 const beforeCatalog=calls.length,topics=await invoke(native,'galaxy_community_topics',{});
 assert.equal(calls.length,beforeCatalog);assert.equal(topics.items.length,5);assert.equal(topics.legacyTopic.id,'unclassified');
 assert.deepEqual(Object.keys(native).filter(n=>n.startsWith('galaxy_attachment_')).sort(),['galaxy_attachment_config','galaxy_attachment_owned','galaxy_attachment_read','galaxy_attachment_revoke']);
 assert.equal(native.galaxy_attachment_read.inputSchema.safeParse({attachmentId:id,base64:'payload'}).success,false);
 assert.equal(native.galaxy_attachment_owned.inputSchema.safeParse({roomId:id,path:'C:/private/file'}).success,false);
});

test('extended native calls actual HTTP services: exact configuration versions, private authorization, scoped receipts and no inferred runtime or Honor',async()=>{
 const f=await serviceFixture(browserScopes);let server;
 try{
  server=createApi({...f,rateLimit:1000});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const endpoint='http://127.0.0.1:'+server.address().port,calls=[];
  const client=credential=>extendedNativeHttpDefinitions({call:async(path,input,options={})=>{
   calls.push({path,input});const response=await fetch(endpoint+path,{method:options.method??'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:'Bearer '+credential}:{})},...(options.method==='GET'?{}:{body:JSON.stringify(input)})});
   const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error),{code:result.error,status:response.status});return result;
  }}),native=client(f.credential),anonymous=client(null);
  const id=randomUUID(),event={schemaVersion:2,id,operationId:randomUUID(),expectedVersion:0,actorId:f.actor.subjectId,kind:'record',
   title:'Synthetic selected conditions',summary:'No source scan or actual installation claim',observedAt:new Date(f.now*1000).toISOString(),synthetic:true,selectedFieldsOnly:true,
   conditions:{model:{name:null,version:null},runtime:{name:'fixture',version:'1'},environment:{name:null,version:null},tools:[],skills:[],mcp:[],
    promptPolicyVersion:null,rulesVersion:null,operationScope:[],inputScopeSummary:null,limitations:'Synthetic local integration fixture; no host execution'}};
  // Sign the deliberately spaced original document, not a reserialized payload.
  const payloadJson=JSON.stringify(event,null,2),intent={version:1,id:randomUUID(),subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,
   endpoint:f.bindings.endpoint,objectId:event.operationId,action:'configuration.publish',purpose:'operational',recipient:f.bindings.endpoint,
   fields:Object.keys(event),visibility:'Private',viewers:[],payloadHash:digest(payloadJson),policyVersion:'0.1',issuedAt:f.now,expiresAt:f.now+3600};
  await f.consents.create(f.actor,await f.signForTest(JSON.stringify(intent),'galaxy-consent+jws'));
  const signed={consentId:intent.id,payloadJson};
  assert.equal((await invoke(native,'galaxy_configuration_v2_submit',signed)).version,1);
  assert.equal((await invoke(native,'galaxy_configuration_v2_submit',signed)).version,1,'same operation is reconciled');
  assert.equal(calls.at(-1).input.payloadJson,payloadJson);
  const first=await invoke(native,'galaxy_configuration_v2_read',{id,version:1});assert.equal(first.record.title,event.title);assert.equal(first.actualInstallationVerified,false);
  await assert.rejects(()=>invoke(anonymous,'galaxy_configuration_v2_read',{id,version:1}),e=>e.status===403&&e.code==='configuration_authorization_unavailable');
  const update={...event,operationId:randomUUID(),expectedVersion:1,title:'Synthetic corrected conditions'};
  assert.equal((await invoke(native,'galaxy_configuration_v2_submit',await f.authorize(update,'configuration.publish',{objectId:update.operationId}))).version,2);
  assert.equal((await invoke(native,'galaxy_configuration_v2_read',{id,version:1})).sourceStatus,'historical-version');
  const versions=await invoke(native,'galaxy_configuration_v2_versions',{id,limit:1});assert.equal(versions.items[0].version,1);assert.equal(versions.nextAfterVersion,1);
  assert.equal((await invoke(native,'galaxy_configuration_v2_query',{subjectId:f.actor.subjectId})).items[0].version,2);
  assert.equal((await invoke(native,'galaxy_configuration_v2_receipt',{operationId:event.operationId,payloadHash:digest(payloadJson)})).state,'acknowledged');
  assert.equal((await invoke(native,'galaxy_configuration_v2_receipt',{operationId:event.operationId,payloadHash:'a'.repeat(64)})).state,'conflict');
  const revoke={schemaVersion:2,id,operationId:randomUUID(),expectedVersion:2,actorId:f.actor.subjectId,kind:'revoke',reason:'Synthetic withdrawal'};
  await invoke(native,'galaxy_configuration_v2_submit',await f.authorize(revoke,'configuration.publish',{objectId:revoke.operationId}));
  const gone=await invoke(native,'galaxy_configuration_v2_read',{id,version:1});assert.equal(gone.sourceStatus,'revoked');assert.equal(gone.record,null);
  assert.deepEqual((await invoke(native,'galaxy_builder_owned',{})).items,[]);
  assert.equal((await invoke(native,'galaxy_builder_receipt',{builderId:randomUUID(),eventId:randomUUID(),payloadHash:'a'.repeat(64)})).state,'absent');
  assert.deepEqual((await invoke(native,'galaxy_qualification_permission_requests',{view:'sent'})).items,[]);
  assert.deepEqual((await invoke(native,'galaxy_qualification_calculation_owned',{})).items,[]);
  assert.equal((await invoke(native,'galaxy_qualification_permission_request_receipt',{eventId:randomUUID(),payloadHash:'a'.repeat(64)})).state,'absent');
  assert.equal((await invoke(native,'galaxy_qualification_calculation_receipt',{operationId:randomUUID(),payloadHash:'a'.repeat(64)})).state,'absent');
  assert.equal((await invoke(native,'galaxy_ci_v2_receipt',{id:randomUUID(),type:'request'})).state,'absent');
  assert.equal((await invoke(native,'galaxy_ci_v2_receipt',{id:randomUUID(),type:'proof'})).state,'absent');
  const requester=await invoke(native,'galaxy_requester_history_v2_query',{});assert.equal(requester.globalScore,null);assert.deepEqual(requester.items,[]);
  const status=await invoke(native,'galaxy_contribution_status',{publicationId:randomUUID()});assert.equal(status.state,'absent');
  const attachments=await invoke(native,'galaxy_attachment_config',{});assert.equal(attachments.supported,false,'unconfigured fixture is not a runtime success');assert.equal(attachments.storageRuntimeVerified,false);
  await invoke(native,'galaxy_hub_status',{});
  assert.deepEqual((await invoke(native,'galaxy_hub_query',{})).items,[]);
  assert.deepEqual((await invoke(native,'galaxy_worker_pack_uses',{})).items,[]);
  const information=await invoke(native,'galaxy_information_query',{purpose:'Synthetic current-source integration',sources:[{key:'methods',source:{kind:'search',request:{type:'capsule',query:{}}}}]});
  assert.equal(information.modelCalls,0);assert.equal(information.items[0].key,'methods');assert.deepEqual(information.items[0].items,[]);
  assert.deepEqual((await invoke(native,'galaxy_information_watches',{})).items,[]);
  const governance=await invoke(native,'galaxy_target_governance_config',{});
  assert.equal(governance.configured,false);assert.equal(governance.guaranteesResponse,false);
  assert.equal((await invoke(native,'galaxy_target_governance_receipt',{eventId:randomUUID(),payloadHash:'c'.repeat(64)})).state,'absent');
  await assert.rejects(()=>invoke(anonymous,'galaxy_target_governance_config',{}),e=>e.status===401);
  assert.equal((await invoke(native,'galaxy_worker_pack_use_receipt',{operationId:randomUUID(),payloadHash:'b'.repeat(64)})).state,'absent');
  await assert.rejects(()=>invoke(client('not-a-valid-credential'),'galaxy_hub_query',{view:'owned'}),e=>e.status===401);
  await assert.rejects(()=>invoke(client('not-a-valid-credential'),'galaxy_qualification_permission_requests',{}),e=>e.status===401);
 }finally{if(server)await new Promise(r=>server.close(r));await f.db.close();}
});
