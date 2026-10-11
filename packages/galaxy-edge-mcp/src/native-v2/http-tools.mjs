import {taskToolDefinitions} from '../../../galaxy-official/src/personal-mcp-task-tools-v2.mjs';
import {contextV2ToolDefinitions} from '../../../galaxy-official/src/personal-mcp-context-v2.mjs';
import {chatToolDefinitions} from '../../../galaxy-official/src/personal-mcp-chat-v2.mjs';
import {summaryToolDefinitions} from '../../../galaxy-official/src/personal-mcp-summaries-v2.mjs';
import {discoveryToolDefinitions} from '../../../galaxy-official/src/personal-mcp-discovery-v2.mjs';
import {capsuleToolDefinitions} from '../../../galaxy-official/src/personal-mcp-capsules-v2.mjs';
import {factToolDefinitions} from '../../../galaxy-official/src/personal-mcp-facts-v2.mjs';
import {searchToolDefinitions} from '../../../galaxy-official/src/personal-mcp-search-v2.mjs';
import {choiceToolDefinitions} from '../../../galaxy-official/src/personal-mcp-choices-v2.mjs';
import {commentToolDefinitions} from '../../../galaxy-official/src/personal-mcp-comments-v2.mjs';
import {identityGroupToolDefinitions} from '../../../galaxy-official/src/personal-mcp-identity-groups-v2.mjs';
import {verificationEventSchema} from '../../../galaxy-official/src/shared/verification-record-schema.mjs';
import {extendedNativeHttpDefinitions} from './extended-http-tools.mjs';

// Reuse the canonical MCP schemas and descriptions. These adapters contain only
// HTTP paths; the existing data services still own authorization and semantics.
export function nativeHttpDefinitions(api){
 const post=path=>(_actor,input={})=>api.call(path,input),get=base=>(_actor,id)=>api.call(base+id,undefined,{method:'GET'});
 const dynamic=(base,suffix)=>(_actor,id,input={})=>api.call(base+id+suffix,input);
 const chat={};for(const [method,path]of Object.entries({create:'rooms/create',list:'rooms/query',invitations:'invitations/query',exportOwned:'export/owned'}))chat[method]=post('/v2/chat/'+path);
 for(const [method,path]of Object.entries({get:'read',history:'history',decisions:'decisions',proposeDecision:'propose',voteDecision:'vote',acceptInvite:'accept',joinPreview:'join-preview',join:'join',leave:'leave',send:'send',messageStatus:'receipt',cursor:'cursor'}))chat[method]=dynamic('/v2/chat/rooms/','/'+path);
 for(const method of ['edit','retract'])chat[method]=(_actor,roomId,messageId,input={})=>api.call('/v2/chat/rooms/'+roomId+'/messages/'+messageId+'/'+method,input);
 chat.queryAgentParticipants=dynamic('/v2/chat/rooms/','/agent-participants');
 const summaries={};for(const [method,path]of Object.entries({preferences:'preferences/read',savePreference:'preferences/save',put:'put',get:'get',receipt:'receipt',list:'list',sources:'sources',delete:'delete'}))summaries[method]=post('/v2/personal-summaries/'+path);
 const sharedSummaries={};for(const method of ['publish','get','list','receipt','retract'])sharedSummaries[method]=post('/v2/chat/shared-summaries/'+method);
 const capsules={};for(const [method,path]of Object.entries({receiptV2:'receipt',versionsV2:'versions',permissionsQueryV2:'permissions/query',previewV2:'preview',publishV2:'events',getV2:'read',queryV2:'query',recordUseV2:'uses',usesV2:'uses/query',permissionV2:'permissions',permissionReadV2:'permissions/read'}))capsules[method]=post('/v2/capsules/'+path);
 const choices={};for(const [method,path]of Object.entries({preferences:'preferences/read',savePreference:'preferences/save',put:'put',get:'get',list:'list',delete:'delete',receipt:'receipt'}))choices[method]=post('/v2/choice-snapshots/'+path);
 const services={
  assistance:{queryTasks:post('/v2/tasks/query'),getTask:get('/v2/tasks/'),createTask:post('/v2/tasks'),
   submitTaskEvent:dynamic('/v2/tasks/','/events'),proposeParticipation:dynamic('/v2/tasks/','/participations'),submitParticipationEvent:dynamic('/v2/participations/','/events'),taskReceipt:post('/v2/tasks/receipt')},
  taskOwnerRead:{prepare:(_actor,{taskId,...input})=>api.call('/v2/tasks/'+taskId+'/owner-read/prepare',input),
   read:dynamic('/v2/tasks/','/owner-read')},
  taskOwnerControl:{prepare:(_actor,{taskId,...input})=>api.call('/v2/tasks/'+taskId+'/owner-control/prepare',input),
   execute:dynamic('/v2/tasks/','/owner-control')},
  contextV2:{query:post('/v2/context/query'),create:post('/v2/context/grants'),submitEvent:dynamic('/v2/context/','/events'),receipt:post('/v2/context/receipt'),
   get:(_actor,id,{metadataOnly=false}={})=>api.call('/v2/context/'+id+(metadataOnly?'/metadata':''),undefined,{method:'GET'})},
  chat,summaries,sharedSummaries,capsules,choices,
  search:{v2:{query:post('/v2/search/query'),reference:post('/v2/search/reference')}},
  comments:{query:post('/v2/comments/query'),get:get('/v2/comments/'),submit:post('/v2/comments'),receipt:post('/v2/comments/receipt')},
  commentGovernance:{config:()=>api.call('/v2/comment-governance/config',undefined,{method:'GET'}),query:post('/v2/comment-governance/query'),report:post('/v2/comment-governance/reports'),event:dynamic('/v2/comment-governance/','/events'),receipt:post('/v2/comment-governance/receipt')},
  inbox:{query:post('/v2/notifications/query'),options:post('/v2/notifications/options/read'),saveOptions:post('/v2/notifications/options/save')},
  discovery:{v2:{query:post('/v2/discovery/query'),detail:post('/v2/discovery/detail')}},
  projects:{list:post('/v2/projects/query'),get:get('/v2/projects/'),submit:post('/v2/projects'),preferences:dynamic('/v2/projects/','/preferences/read'),savePreferences:dynamic('/v2/projects/','/preferences/save')},
  contacts:{query:post('/v2/contacts/query'),get:get('/v2/contacts/'),submit:post('/v2/contacts')},
  recruitment:{query:post('/v2/recruitment/query'),get:get('/v2/recruitment/'),submit:post('/v2/recruitment'),
   operationReceipt:(_actor,{recruitmentId,operationId,payloadHash})=>api.call('/v2/recruitment/'+recruitmentId+'/receipt?'+new URLSearchParams({operationId,payloadHash}),undefined,{method:'GET'})},
  history:{queryV2:post('/v2/history/query')},
  identityGroups:{current:()=>api.call('/v2/identity-groups/current',undefined,{method:'GET'}),source:post('/v2/identity-groups/source'),submit:post('/v2/identity-groups/submit'),proposal:get('/v2/identity-groups/operations/'),read:get('/v2/identity-groups/'),query:post('/v2/identity-groups/query'),resolve:(_actor,subjectId)=>api.call('/v2/identity-groups/resolve',{subjectId}),receipt:post('/v2/identity-groups/receipt')},
  cases:{submitV2:post('/v2/cases/events'),receipt:post('/v2/cases/events/receipt'),taskLinkReceipt:(_actor,{taskId,...input})=>api.call('/v2/tasks/'+taskId+'/case-link/receipt',input),getV2:(_actor,id,input)=>api.call('/v2/cases/'+id+'/read',input),
   respondBatch:(_actor,requests)=>api.call('/v2/cases/intervention-responses',{requests}),createAndLinkTask:(_actor,{taskId,...input})=>api.call('/v2/tasks/'+taskId+'/case',input)},
  evidence:{submitV2:(_actor,input)=>{const payload=verificationEventSchema.parse(JSON.parse(input.payloadJson));if(payload.kind!=='evidence')throw new Error('invalid_evidence_event');
   return api.call('/v2/verification-records/submit',input);}},verificationRecords:{submit:post('/v2/verification-records/submit'),get:post('/v2/verification-records/read'),status:post('/v2/verification-records/status'),receipt:post('/v2/verification-records/receipt')},
 };
 const definitions=Object.assign({},... [taskToolDefinitions,contextV2ToolDefinitions,chatToolDefinitions,summaryToolDefinitions,discoveryToolDefinitions,capsuleToolDefinitions,factToolDefinitions,searchToolDefinitions,choiceToolDefinitions,commentToolDefinitions,identityGroupToolDefinitions].map(factory=>factory(services,null)));
 for(const[name,definition]of Object.entries(extendedNativeHttpDefinitions(api))){
  if(Object.hasOwn(definitions,name))throw new Error('Duplicate native HTTP tool '+name);
  definitions[name]=definition;
 }
 return definitions;
}
