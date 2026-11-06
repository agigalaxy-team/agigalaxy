// Authored development subset, not a deployed endpoint registry or a claim of
// exhaustive route/permission coverage. Current Go domain tests verify behavior.
const entries=[];
function add(method,path,service,operation,scope,input,documentation,{authentication=scope?'galaxy-session':'none',status=200,condition='configured-service'}={}) {
  entries.push({method,path,service,operation,authentication,scope:scope??null,input,status,condition,documentation});
}
const publication={fields:['consentId','payloadJson'],meaning:'Exact reviewed payload JSON and existing signed Consent; action/visibility/current ownership remain service-specific.'};
const fields=(...names)=>({fields:names});
const schema=name=>({schema:'packages/galaxy-contracts/src/'+name});
const optional={authentication:'optional-galaxy-session'};

for(const name of ['providers','begin','status','cancel','confirm','query','revoke'])add('POST','/v1/identity/'+name,'identity',name,'binding',name==='providers'?fields():{schema:"go/internal/accountlinks/http.go:"+name},'docs/technical/interfaces.md');
add('GET','/v1/identity/callback/{providerId}','identity','callback',null,{query:['code','state','iss','error','error_description','error_uri','session_state'],meaning:'OIDC callback tied to an existing pending login; duplicate/unrecognized query keys rejected.'},'docs/technical/interfaces.md',{condition:'selected-oidc-provider'});
add('POST','/v1/binding-challenges','bindings','challenge',null,fields('subjectId','genesisProof','installationId','scopes'),'docs/technical/interfaces.md',{status:201});
add('POST','/v1/bindings','bindings','bind',null,fields('challenge','signature','clientSession'),'docs/technical/interfaces.md');
add('POST','/v1/session-challenges','access','challenge',null,fields('bindingId','credentialHash'),'docs/technical/interfaces.md',{status:201});
add('POST','/v1/sessions','access','activate',null,fields('challenge','signature'),'docs/technical/interfaces.md');
add('GET','/v1/bindings/{id}','bindings','get','binding',null,'docs/technical/interfaces.md');
add('POST','/v1/bindings/{id}/revoke','bindings','revoke','binding',fields(),'docs/technical/interfaces.md');
add('POST','/v1/bindings/query','bindings','query','binding',schema('binding-management-schema.mjs'),'docs/technical/interfaces.md');
add('GET','/v1/consents','consents','list','consent',{query:['after'],meaning:'Optional UUID cursor; at most one after parameter.'},'docs/technical/interfaces.md');
add('POST','/v1/consents','consents','create','consent',fields('signedIntent'),'docs/technical/interfaces.md');
add('POST','/v1/consents/{id}/revoke','consents','revoke','consent',fields(),'docs/technical/interfaces.md');
for(const path of ['/v1/cases','/v1/case-events'])add('POST',path,'cases','submit','case-teaser',{...publication,meaning:publication.meaning+(path==='/v1/cases'?' kind=case only.':' kind must not be case.')},'docs/technical/interfaces.md');
add('GET','/v1/cases/{id}','cases','get','case-teaser',null,'docs/technical/interfaces.md');
add('POST','/v1/evidence-submissions','evidence','submit','evidence',publication,'docs/technical/interfaces.md',{status:202});
add('GET','/v1/verifications/{id}','evidence','get','evidence',null,'docs/technical/interfaces.md');
add('POST','/v1/proof-previews','proofs','preview','proof',fields('id','evidenceId'),'docs/technical/interfaces.md');
add('POST','/v1/proofs','proofs','publish','proof',publication,'docs/technical/interfaces.md');
add('POST','/v1/proofs/{id}/revoke','proofs','revoke','proof',fields(),'docs/technical/interfaces.md');
for(const path of ['/v1/proofs/{id}','/v1/proofs/{id}/status'])add('GET',path,'proofs','get','proof',null,'docs/technical/interfaces.md',optional);
add('POST','/v1/history/query','history','query','history',schema('history-schema.mjs'),'docs/technical/interfaces.md',optional);
add('GET','/v1/profiles/{subjectId}','history','query','history',null,'docs/technical/interfaces.md',optional);
add('POST','/v1/profiles/statements','profiles','publish','history',publication,'docs/technical/interfaces.md');
add('POST','/v1/discovery/query','discovery','query','history',schema('discovery-schema.mjs:discoveryQuerySchema'),'docs/technical/interfaces.md');
add('POST','/v1/discovery/preferences/read','discovery','preferences','notifications',fields(),'docs/technical/interfaces.md');
add('POST','/v1/discovery/preferences/save','discovery','save','notifications',schema('discovery-schema.mjs:discoverySaveSchema'),'docs/technical/interfaces.md');
add('POST','/v1/search/query','search','query','query-type',schema('search-schema.mjs'),'docs/technical/interfaces.md',optional);

for(const [path,operation] of [['/v1/assistance','create'],['/v1/assistance/{id}/events','submit']])add('POST',path,'assistance',operation,'assistance',publication,'docs/technical/interfaces.md');
add('GET','/v1/assistance/{id}','assistance','get','assistance',null,'docs/technical/interfaces.md');
for(const [path,operation] of [['/v1/assistance/query','query'],['/v1/assistance/events/receipt','receipt'],['/v1/requester-history/query','requesterHistory'],['/v1/requester-history/facts','requesterHistoryFacts']])add('POST',path,'assistance',operation,'assistance',schema('assistance-schema.mjs'),'docs/technical/interfaces.md');
add('POST','/v1/context-grants','context','create','context',publication,'docs/technical/interfaces.md');
add('POST','/v1/context-grants/{id}/accept','context','accept','context',publication,'docs/technical/interfaces.md');
add('POST','/v1/context-grants/{id}/revoke','context','revoke','context',fields(),'docs/technical/interfaces.md');
add('GET','/v1/context-grants/{id}','context','get','context',null,'docs/technical/interfaces.md');
add('POST','/v1/context-grants/query','context','query','context',fields('assistanceId'),'docs/technical/interfaces.md');
add('POST','/v1/context-grants/receipt','context','receipt','context',schema('context-schema.mjs'),'docs/technical/interfaces.md');
/** @type {Array<[string,string,object]>} */
const notificationRows=[['query','query',schema('notifications-schema.mjs')],['preferences/read','preferences',fields()],['preferences/save','save',fields('expectedRevision','settings')],['read','markRead',fields('id')],['archive','archive',fields('expectedRevision','before')]];
for(const [path,operation,input] of notificationRows)add('POST','/v1/notifications/'+path,'notifications',operation,'notifications',input,'docs/technical/interfaces.md');
add('POST','/v1/qualification/policies','qualification','list','assistance',fields(),'docs/technical/interfaces.md');
add('POST','/v1/qualification/evaluate','qualification','evaluate','assistance',schema('qualification-schema.mjs'),'docs/technical/interfaces.md');
/** @type {Array<[string,string,object]>} */
const moderationRows=[['config','config',fields()],['reports','report',publication],['reports/query','query',schema('moderation-schema.mjs')],['reports/{id}/read','get',fields()],['reports/{id}/events','event',publication]];
for(const [path,operation,input] of moderationRows)add('POST','/v1/moderation/'+path,'moderation',operation,'moderation',input,'docs/technical/interfaces.md');
add('POST','/v1/honor/rules','honor','list',null,fields(),'docs/technical/interfaces.md');
add('POST','/v1/honor/rule-history','honor','ruleHistory',null,{schema:"go/internal/honor/rules.go:ruleHistory"},'docs/technical/interfaces.md');
add('POST','/v1/honor/ranking','honor','ranking',null,fields('ruleId','ruleVersion'),'docs/technical/interfaces.md');
add('POST','/v1/honor/query','honor','query','history',{schema:"go/internal/honor/http.go:query"},'docs/technical/interfaces.md',optional);
add('GET','/v1/honor/{subjectId}/{ruleId}/{ruleVersion}','honor','query','history',null,'docs/technical/interfaces.md',optional);
for(const [path,operation] of [['events','publish'],['uses','recordUse']])add('POST','/v1/capsules/'+path,'capsules',operation,'capsules',publication,'docs/technical/interfaces.md');
for(const [path,operation] of [['read','get'],['query','query'],['uses/query','uses']])add('POST','/v1/capsules/'+path,'capsules',operation,'capsules',schema('capsule-schema.mjs'),'docs/technical/interfaces.md',optional);
add('POST','/v1/builders/specification','builders','specification',null,fields(),'docs/technical/interfaces.md');
add('POST','/v1/builders/events','builders','publish','builders',publication,'docs/technical/interfaces.md');
for(const [path,operation] of [['read','get'],['query','query'],['notices/query','notices']])add('POST','/v1/builders/'+path,'builders',operation,'builders',schema('builders-schema.mjs'),'docs/technical/interfaces.md',optional);
for(const [path,operation] of [['reports/export','exportReport'],['manage/read','manage'],['owned/query','owned'],['events/receipt','receipt']])add('POST','/v1/builders/'+path,'builders',operation,'builders',schema('builders-schema.mjs'),'docs/technical/interfaces.md');
add('POST','/v1/builders/node-control/export','builders','exportNodeControl','builders',fields('builderId','controlId'),'docs/technical/interfaces.md');
/** @type {Array<[string,string,object,string]>} */
const auditRows=[['config','config',fields(),'audit'],['grants','listGrants',fields(),'audit'],['query','query',schema('audit-schema.mjs'),'audit'],['export','query',schema('audit-schema.mjs'),'audit'],['grants/approve','approve',fields('signed'),'audit-review'],['grants/revoke','revoke',fields('id'),'audit-review']];
for(const [path,operation,input,scope] of auditRows)add('POST','/v1/audit/'+path,'audit',operation,scope,input,'docs/technical/interfaces.md');
for(const name of ['specification','create','page','revoke'])add('POST','/v1/data-exports/'+name,'dataExport',name,'data-export',name==='specification'?fields():schema('data-export-schema.mjs'),'docs/technical/interfaces.md');
add('POST','/v1/deletion-requests/status','deletion','statusWithProof',null,fields('signed'),'docs/technical/interfaces.md',{authentication:'local-key-signature'});
for(const name of ['config','submit','read','query'])add('POST','/v1/deletion-requests/'+name,'deletion',name,'data-delete',name==='config'?fields():name==='submit'?fields('signed'):schema('deletion-schema.mjs'),'docs/technical/interfaces.md');

export const businessApiReference=Object.freeze(entries.map(entry=>Object.freeze(entry)));
export const specialApiReference=Object.freeze([
  ...['','/contributions','/legacy-honors'].map(suffix=>({method:'GET',path:'/v2/community/growth/accounts/{accountId}'+suffix,authentication:'none',meaning:'Public account growth and eligible contributions, or publicly linked identity honors; paginated endpoints accept limit and after. Current profile and source visibility apply.',documentation:'docs/technical/community-growth-and-reputation.md'})),
  ...['','/contributions','/legacy-honors'].map(suffix=>({method:'GET',path:'/v2/community/growth/me'+suffix,authentication:'official-account-cookie',meaning:'Current account growth or contributions; linked identity honors still require the association to be public. Paginated endpoints accept limit and after.',documentation:'docs/technical/community-growth-and-reputation.md'})),
  ...['status','query','command','receipt'].map(action=>({method:'POST',path:'/v2/community/growth/recognitions/'+action,authentication:'official-account-cookie',meaning:'Current section maintainer scoped recognition; command checks the actual content and scope, receipt reads the original operation.',documentation:'docs/technical/community-growth-and-reputation.md'})),
  ...['query','command','receipt','assessment-config','assessment-config-command','assessment-config-receipt','weights'].map(action=>({method:'POST',path:'/v1/operations/community-growth/'+action,authentication:'operations-cookie',meaning:'Management growth rules, recognition or private assessment. Domain permissions are checked within the transaction; writes retain the original operation receipt.',documentation:'docs/technical/community-growth-and-reputation.md'})),
  ...['status','command','receipt'].map(action=>({method:'POST',path:'/v2/community/reactions/'+action,authentication:action==='status'?'source-specific-optional-account':'official-account-cookie-or-galaxy-session',meaning:'Real post/reply likes and cancellation; status checks source visibility, command and receipt use the original account operation.',documentation:'docs/technical/community-growth-and-reputation.md'})),
  ...['status','query','command','receipt'].map(action=>({method:'POST',path:'/v1/account/follows/'+action,authentication:'official-account-cookie',meaning:'Account follow state, visibility and original operation receipt; new relationships default public and existing private relationships stay private.',documentation:'docs/technical/community-growth-and-reputation.md'})),
  {method:'POST',path:'/v1/account/follows/public-query',authentication:'none',meaning:'Current public following or followers for an eligible public profile; private relationships are excluded.',documentation:'docs/technical/community-growth-and-reputation.md'},
  {method:'GET',path:'/v1/operations/recommendation/community-signals',authentication:'operations-cookie',meaning:'Read the current community recommendation settings with recommendations.read.',documentation:'docs/technical/community-growth-and-reputation.md'},
  {method:'POST',path:'/v1/operations/recommendation/community-signals',authentication:'operations-cookie',meaning:'Save community recommendation settings with recommendations.configure and original operation ID.',documentation:'docs/technical/community-growth-and-reputation.md'},
  {method:'GET',path:'/v1/operations/recommendation/operations/{operationId}',authentication:'operations-cookie',meaning:'Read the original recommendation operation receipt with recommendations.read.',documentation:'docs/technical/community-growth-and-reputation.md'},
  ...['status','command','query','receipt'].flatMap(action=>[
    {method:'POST',path:'/v1/account/bookmarks/'+action,authentication:'official-account-cookie',meaning:'Account-private source locator with exact account and CSRF; source permissions are rechecked.',documentation:'docs/product/data-and-files.md'},
    {method:'POST',path:'/v2/account-bookmarks/'+action,authentication:'galaxy-session',meaning:'Explicit authorized target account; identity records are not adopted by the account.',documentation:'docs/product/data-and-files.md'}]),
  {method:'POST',path:'/v2/chat/accounts/query',authentication:'official-account-cookie-or-galaxy-session',meaning:'Current participant account lookup. Search respects public query settings; exact known recipients retain their existing profile visibility.',documentation:'docs/product/data-and-files.md'},
  ...['config','prepare','read','query','revoke'].map(action=>({method:'POST',path:'/v2/community/attachments/'+action,authentication:action==='config'?'none':'official-account-cookie-or-galaxy-session',meaning:'Source-bound post/reply file preparation, status and revocation; config returns actual limits.',documentation:'docs/product/data-and-files.md'})),
  {method:'PUT',path:'/v2/community/attachments/{id}/upload',authentication:'official-account-cookie-or-galaxy-session',meaning:'Exact prepared bytes, owner and digest; unavailable until scanner accepts.',documentation:'docs/product/data-and-files.md'},
  {method:'POST',path:'/v2/community/attachments/{id}/content',authentication:'source-specific-optional-account',meaning:'Exact post version or reply and parent authorization is checked before returning private stored bytes.',documentation:'docs/product/data-and-files.md'},
  {method:'GET',path:'/.well-known/galaxy-network.json',authentication:'none',meaning:'Signed Manifest, ETag and conditional 304; default capability labels binding/sessions/docs-mcp only.',documentation:'docs/technical/interfaces.md'},
  {method:'GET',path:'/.well-known/galaxy-signing-keys.json',authentication:'none',meaning:'Configured public keyring; no private keys.',documentation:'docs/technical/interfaces.md'},
  {method:'GET',path:'/v1/policy',authentication:'none',meaning:'Public Manifest policy.',documentation:'docs/technical/interfaces.md'},
  {method:'GET',path:'/v1/signing-keys/status',authentication:'none',meaning:'Current loaded public trust metadata.',documentation:'docs/technical/interfaces.md'},
  {method:'GET',path:'/v1/service-status',authentication:'none',meaning:'Configured retirement/incident status; not independent monitoring.',documentation:'docs/technical/interfaces.md'},
  {method:'POST',path:'/mcp/docs',authentication:'none',meaning:'MCP JSON-RPC, reviewed public document allowlist only; exact Host.',documentation:'docs/technical/interfaces.md'},
  {method:'GET',path:'/.well-known/oauth-protected-resource/mcp/personal',authentication:'none',meaning:'Only when Personal MCP configured; RFC9728 metadata.',documentation:'docs/technical/interfaces.md'},
  {method:'POST',path:'/mcp/personal',authentication:'oauth-resource',meaning:'Only when configured; MCP JSON-RPC with scope challenges and current Galaxy authorization.',documentation:'docs/technical/interfaces.md'},
  ...['GET','DELETE'].map(method=>({method,path:'/mcp/personal',authentication:'oauth-resource',meaning:'Authenticates then SDK returns 405; no persistent MCP session or event stream in this profile.',documentation:'docs/technical/interfaces.md'})),
  ...['/healthz','/readyz'].map(path=>({method:'GET',path,authentication:'none',exposure:'internal-only',meaning:'Internal API probe; excluded from public Caddy routes.',documentation:'docs/technical/interfaces.md'})),
]);
