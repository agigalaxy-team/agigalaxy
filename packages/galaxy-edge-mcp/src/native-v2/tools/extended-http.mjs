import {configurationToolDefinitions} from '../../../../galaxy-official/src/adapters/mcp/personal/tools/configurations-v2.mjs';
import {builderToolDefinitions} from '../../../../galaxy-official/src/adapters/mcp/personal/tools/builders-v2.mjs';
import {qualificationToolDefinitions} from '../../../../galaxy-official/src/adapters/mcp/personal/tools/qualification-v2.mjs';
import {honorToolDefinitions} from '../../../../galaxy-official/src/adapters/mcp/personal/tools/honor-v2.mjs';
import {ciToolDefinitions} from '../../../../galaxy-official/src/adapters/mcp/personal/tools/ci-v2.mjs';
import {attachmentToolDefinitions} from '../../../../galaxy-official/src/adapters/mcp/personal/tools/attachments.mjs';
import {hubToolDefinitions} from '../../../../galaxy-official/src/adapters/mcp/personal/tools/hubs-v2.mjs';
import {workerPackUseToolDefinitions} from '../../../../galaxy-official/src/adapters/mcp/personal/tools/worker-pack-uses-v2.mjs';
import {informationToolDefinitions} from '../../../../galaxy-official/src/adapters/mcp/personal/tools/information-v2.mjs';
import {targetGovernanceToolDefinitions} from '../../../../galaxy-official/src/adapters/mcp/personal/tools/target-governance-v2.mjs';
import {moderationToolDefinitions} from '../../../../galaxy-official/src/adapters/mcp/personal/tools/moderation-v2.mjs';
import {communityToolDefinitions} from '../../../../galaxy-official/src/adapters/mcp/personal/tools/community-v1.mjs';
import {readingBookmarkToolDefinitions} from '../../../../galaxy-official/src/adapters/mcp/personal/tools/reading-bookmarks-v1.mjs';

// Canonical input, authority/scope and write semantics are reused unchanged.
// Existing signed Consent bytes go directly to the API; this transport neither
// signs for the user nor invents confirmation fields or source permissions.
export function extendedNativeHttpDefinitions(api){
 if(typeof api?.call!=='function')throw new Error('Native HTTP client required');
 const post=path=>(_actor,input={})=>api.call(path,input);
 const group=(prefix,mapping)=>Object.fromEntries(Object.entries(mapping).map(([method,path])=>[method,post(prefix+path)]));
 const services={
  readingBookmarks:group('/v2/reading-bookmarks/',{status:'status',command:'command',query:'query',receipt:'receipt'}),
  forum:{query:input=>api.call('/v2/community/posts/query',input,{authenticated:false}),
   getPost:postId=>api.call('/v2/community/posts/'+postId,undefined,{method:'GET',authenticated:false}),
   getVersion:(postId,versionId)=>api.call('/v2/community/posts/'+postId+'/versions/'+versionId,undefined,{method:'GET',authenticated:false}),
   replies:input=>api.call('/v2/community/replies/query',input,{authenticated:false}),
   versions:(postId,input)=>api.call('/v2/community/posts/'+postId+'/versions',input,{authenticated:false}),
   owned:post('/v2/community/posts/owned')},
  configurations:group('/v2/configurations/',{submit:'events',get:'read',query:'query',versions:'versions',receipt:'receipt'}),
  builders:{...group('/v1/builders/',{get:'read',owned:'owned/query',receipt:'events/receipt',notices:'notices/query'}),
   v2:group('/v2/builders/',{get:'support/read',publish:'support/events',exportPack:'pack/export',manifest:'pack/manifest'})},
  packUses:group('/v2/builders/pack-uses/',{candidates:'candidates',submit:'events',get:'read',query:'query',receipt:'receipt'}),
  information:{query:post('/v2/information/query')},
  moderation:{...group('/v1/moderation/',{config:'config',query:'reports/query',report:'reports'}),
   get:(_actor,reportId)=>api.call('/v1/moderation/reports/'+reportId+'/read',{}),
   event:(_actor,reportId,input)=>api.call('/v1/moderation/reports/'+reportId+'/events',input),
   receipt:(_actor,{reportId,...input})=>api.call('/v1/moderation/reports/'+reportId+'/receipt',input)},
  informationWatches:group('/v2/information/watches/',{command:'command',list:'list',receipt:'receipt',check:'check',events:'events'}),
  targetGovernance:{...group('/v2/target-governance/',{targetInfo:'target',report:'reports',event:'events',query:'query',receipt:'receipt'}),
   config:()=>api.call('/v2/target-governance/config',null,{method:'GET'}),
   read:(_actor,reportId)=>api.call('/v2/target-governance/'+reportId,null,{method:'GET'})},
  hubs:{specification:()=>api.call('/v2/hubs/status',{}),...group('/v2/hubs/',{manage:'manage',get:'read',query:'query',submit:'events',members:'memberships',intake:'intake',receipt:'receipt'})},
  peering:group('/v2/hubs/peering/',{party:'party',connections:'connections',sources:'sources',submit:'events',read:'read',query:'query',list:'list',preview:'preview',receipt:'receipt'}),
  experienceReviews:group('/v2/experience/',{submit:'submit',read:'read'}),
  qualification:{v2:group('/v2/qualification/',{evaluate:'evaluate',candidates:'candidates'})},
  qualificationCalculations:group('/v2/qualification/',{submit:'calculation-permissions',receipt:'calculation-receipt',owned:'calculation-owned'}),
  qualificationRequests:group('/v2/qualification/permission-requests/',{plan:'plan',submit:'events',query:'query',read:'read',receipt:'receipt'}),
  contributionSharing:group('/v2/contributions/',{status:'status',ownedSources:'sources',preview:'preview',submit:'publish',readProjection:'read'}),
  honor:{v2:{query:post('/v2/honor/query'),ranking:input=>api.call('/v2/honor/ranking',input)}},
  requesterHistoryV2:group('/v2/requester-history/',{query:'query',facts:'facts'}),
  ciV2:group('/v2/ci/',{receipt:'receipts',submit:'requests',get:'requests/read',revokeRequest:'requests/revoke',preview:'proofs/preview',publish:'proofs/publish',getProof:'proofs/read',revokeProof:'proofs/revoke'}),
  attachments:{specification:()=>api.call('/v2/chat/attachments/config',{}),...group('/v2/chat/attachments/',{get:'read',queryOwn:'query',revoke:'revoke'})},
 };
 const tools=Object.assign({},...[configurationToolDefinitions,builderToolDefinitions,qualificationToolDefinitions,honorToolDefinitions,ciToolDefinitions,attachmentToolDefinitions,hubToolDefinitions,workerPackUseToolDefinitions,informationToolDefinitions,targetGovernanceToolDefinitions,moderationToolDefinitions,communityToolDefinitions,readingBookmarkToolDefinitions].map(factory=>factory(services,null)));
 // This canonical definition normally reads the current ID's account links
 // inside a server transaction. Native uses the existing binding-scoped API;
 // it must not imitate access.runAuthorized or query the public directory.
 tools.galaxy_community_account_options={...tools.galaxy_community_account_options,run:async()=>{
  const result=await api.call('/v2/account-archives/accounts',{}),rows=result?.accounts;
  if(!Array.isArray(rows)||rows.some(row=>typeof row?.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id)))
   throw Object.assign(new Error('native_account_options_unavailable'),{code:'native_account_options_unavailable'});
  return {items:rows.map(row=>({id:row.id})),selectionRequired:rows.length>1};
 }};
 return tools;
}
