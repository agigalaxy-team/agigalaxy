// Build-only extraction of the current official personal MCP registrations.
// This invokes no business operation, credentials, database or network service.
import {McpServer} from '../../packages/galaxy-official/node_modules/@modelcontextprotocol/server/dist/index.mjs';
import {z} from '../../packages/galaxy-official/node_modules/zod/index.js';
import {writeFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createPersonalMcp} from '../../packages/galaxy-official/src/adapters/mcp/personal/handler.mjs';
import {searchSourceTypes,searchScope} from '../../packages/galaxy-official/src/shared/search-schema.mjs';
import {searchV2Scope} from '../../packages/galaxy-official/src/shared/search-v2-schema.mjs';
const services=new Proxy({},{get:()=>new Proxy(()=>{},{get:()=>()=>{throw Error('Business operations must not run while exporting the catalog')}})});
const scopes=new Map();
const folder=new URL('../../packages/galaxy-official/src/adapters/mcp/personal/tools/',import.meta.url);
for(const file of await readdir(folder)){
 if(!file.endsWith('.mjs'))continue;
 const module=await import(new URL(file,folder));
 for(const [name,fn]of Object.entries(module))if(name.endsWith('ToolDefinitions')&&typeof fn==='function')for(const [tool,definition]of Object.entries(fn(services,null))){
  if(typeof definition.scope==='string')scopes.set(tool,definition.scope);
  else if(typeof definition.scope==='function'){const values={};for(const type of [...searchSourceTypes,'task','opportunity']){try{values[type]=definition.scope({type,search:{type}})}catch{}}scopes.set(tool,values)}
 }
}
const builtin={binding:['galaxy_account_quotas','galaxy_connection_status'],consent:['galaxy_consents_query','galaxy_consent_submit','galaxy_consent_revoke'],'case-teaser':['galaxy_case_get','galaxy_case_submit'],history:['galaxy_history_query','galaxy_profile_submit','galaxy_discovery_query'],notifications:['galaxy_discovery_preferences','galaxy_discovery_preferences_save','galaxy_notifications_query'],evidence:['galaxy_evidence_submit','galaxy_evidence_get'],proof:['galaxy_proof_get','galaxy_proof_submit','galaxy_proof_revoke'],assistance:['galaxy_assistance_query','galaxy_assistance_get','galaxy_assistance_submit'],context:['galaxy_context_query','galaxy_context_read'],capsules:['galaxy_capsules_query','galaxy_capsule_get'],builders:['galaxy_builders_query'],audit:['galaxy_audit_query'],'data-export':['galaxy_export_create','galaxy_export_page','galaxy_export_binary','galaxy_export_revoke']};
for(const[scope,names]of Object.entries(builtin))for(const name of names)scopes.set(name,scope);
scopes.set('galaxy_search_query',Object.fromEntries(searchSourceTypes.map(type=>[type,searchScope(type)])));
const catalog=[];const original=McpServer.prototype.registerTool;
McpServer.prototype.registerTool=function(name,definition){catalog.push({name,description:definition.description,inputSchema:z.toJSONSchema(definition.inputSchema,{io:'input',unrepresentable:'any'}),annotations:definition.annotations,scope:scopes.get(name)??null});return {}};
try{createPersonalMcp(services,null)}finally{McpServer.prototype.registerTool=original}
if(catalog.some(t=>!t.scope))throw Error('Missing original tool scope');
await writeFile(fileURLToPath(new URL('../../go/internal/personalmcp/catalog.json',import.meta.url)),JSON.stringify(catalog,null,2)+'\n');
