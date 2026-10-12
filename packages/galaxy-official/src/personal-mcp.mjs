import { McpServer,verifyBearerToken,bearerAuthChallengeResponse,buildOAuthProtectedResourceMetadata,getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { body,captureAuthenticatedRequest } from './adapters/http/request.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { oauthScope } from './oauth-resource-access.mjs';
import { historyQuerySchema } from './shared/history-schema.mjs';
import { searchQuerySchema,searchScope } from './shared/search-schema.mjs';
import { capsuleQuerySchema,capsuleReadSchema } from './shared/capsule-schema.mjs';
import { builderQuerySchema } from './shared/builders-schema.mjs';
import { exportCreateSchema,exportPageSchema,exportBinarySchema,exportIdSchema } from './shared/data-export-schema.mjs';
import { assistanceQuerySchema } from './shared/assistance-schema.mjs';
import { notificationQuerySchema } from './shared/notifications-schema.mjs';
import { auditQuerySchema } from './shared/audit-schema.mjs';
import { discoveryQuerySchema, discoverySaveSchema } from './shared/discovery-schema.mjs';
import { taskToolDefinitions } from './personal-mcp-task-tools-v2.mjs';
import { factToolDefinitions } from './personal-mcp-facts-v2.mjs';
import { chatToolDefinitions } from './personal-mcp-chat-v2.mjs';
import {attachmentToolDefinitions} from './personal-mcp-attachments.mjs';
import { capsuleToolDefinitions } from './personal-mcp-capsules-v2.mjs';
import { configurationToolDefinitions } from './personal-mcp-configurations-v2.mjs';
import { qualificationToolDefinitions } from './personal-mcp-qualification-v2.mjs';
import { honorToolDefinitions } from './personal-mcp-honor-v2.mjs';
import { discoveryToolDefinitions } from './personal-mcp-discovery-v2.mjs';
import { summaryToolDefinitions } from './personal-mcp-summaries-v2.mjs';
import { ciToolDefinitions } from './personal-mcp-ci-v2.mjs';
import { searchToolDefinitions } from './personal-mcp-search-v2.mjs';
import { choiceToolDefinitions } from './personal-mcp-choices-v2.mjs';
import {hubToolDefinitions} from './personal-mcp-hubs-v2.mjs';
import { builderToolDefinitions } from './personal-mcp-builders-v2.mjs';
import { workerPackUseToolDefinitions } from './personal-mcp-worker-pack-uses-v2.mjs';
import {informationToolDefinitions} from './personal-mcp-information-v2.mjs';
import { commentToolDefinitions } from './personal-mcp-comments-v2.mjs';
import { contextV2ToolDefinitions } from './personal-mcp-context-v2.mjs';
import { outcomeMaterialToolDefinitions } from './personal-mcp-outcome-materials-v2.mjs';
import { trustPackageToolDefinitions } from './personal-mcp-trust-package.mjs';
import {moderationToolDefinitions} from './personal-mcp-moderation-v2.mjs';
import {communityToolDefinitions} from './personal-mcp-community-v1.mjs';
import {readingBookmarkToolDefinitions} from './personal-mcp-reading-bookmarks-v1.mjs';

const id=z.strictObject({id:z.uuid()});
const signed=z.strictObject({signed:z.string().min(1).max(16384)});
const submission=z.strictObject({consentId:z.uuid(),payloadJson:z.string().min(1).max(24000)});

// Each entry reuses an existing use case. Transport OAuth never produces a
// Galaxy signature or Consent; signed mutations require the preapproved bytes.
function definitions(services,actor) {
  const tool=(scope,inputSchema,description,run,write=false)=>({scope,inputSchema,description,run,write});
  return {
    ...taskToolDefinitions(services,actor),
    ...builderToolDefinitions(services,actor),
    ...workerPackUseToolDefinitions(services,actor),
    ...informationToolDefinitions(services,actor),
    ...hubToolDefinitions(services,actor),
    ...factToolDefinitions(services,actor),
    ...chatToolDefinitions(services,actor),
    ...moderationToolDefinitions(services,actor),
    ...communityToolDefinitions(services,actor),
    ...readingBookmarkToolDefinitions(services,actor),
    ...attachmentToolDefinitions(services,actor),
    ...capsuleToolDefinitions(services,actor),
    ...configurationToolDefinitions(services,actor),
    ...qualificationToolDefinitions(services,actor),
    ...honorToolDefinitions(services,actor),
    ...discoveryToolDefinitions(services,actor),
    ...summaryToolDefinitions(services,actor),
    ...ciToolDefinitions(services,actor),
    ...searchToolDefinitions(services,actor),
    ...choiceToolDefinitions(services,actor),
    ...commentToolDefinitions(services,actor),
    ...contextV2ToolDefinitions(services,actor),
    ...outcomeMaterialToolDefinitions(services,actor),
    ...trustPackageToolDefinitions(services,actor),
    galaxy_account_quotas:tool('binding',z.strictObject({}),'Read verified Account status and current daily public task/comment/invitation quotas; this is not professional qualification.',()=>services.publicWrites.status(actor)),
    galaxy_connection_status:tool('binding',z.strictObject({}),'Read the current Galaxy subject, binding and allowed scopes.',
      ()=>services.access.runAuthorized(actor,'binding',async(_db,authorization)=>({subjectId:actor.subjectId,bindingId:actor.bindingId,
        endpoint:services.access.endpoint,scopes:authorization.credentialScopes,authorization:'oauth-resource',consentRequired:true}))),
    galaxy_consents_query:tool('consent',z.strictObject({after:z.uuid().optional()}),'List current owner Consent records.',input=>services.consents.list(actor,input.after)),
    galaxy_consent_submit:tool('consent',signed,'Submit an exact Consent already signed by the local Galaxy key.',input=>services.consents.create(actor,input.signed),true),
    galaxy_consent_revoke:tool('consent',id,'Revoke a selected owner Consent.',input=>services.consents.revoke(actor,input.id),true),
    galaxy_case_get:tool('case-teaser',id,'Read an authorized Case.',input=>services.cases.get(actor,input.id)),
    galaxy_case_submit:tool('case-teaser',submission,'Submit exact Case/Attempt/Result bytes with their existing signed Consent.',input=>services.cases.submit(actor,input),true),
    galaxy_history_query:tool('history',historyQuerySchema,'Query current authorized Case and track-record history.',input=>services.history.query(actor,input)),
    galaxy_profile_submit:tool('history',submission,'Publish explicitly selected self-declared profile and project descriptions covered by an existing signed Consent.',input=>services.profiles.publish(actor,input),true),
    galaxy_discovery_query:tool('history',discoveryQuerySchema,'Find opted-in projects by shared function tags, with reasons, differences and self-declared sources. Does not contact anyone.',input=>services.discovery.query(actor,input)),
    galaxy_discovery_preferences:tool('notifications',z.strictObject({}),'Read owner discovery preferences and effective temporary contact wishes.',()=>services.discovery.preferences(actor)),
    galaxy_discovery_preferences_save:tool('notifications',discoverySaveSchema,'Update owner discovery preferences, including a temporary pause or focus. Does not send messages.',input=>services.discovery.save(actor,input),true),
    galaxy_search_query:tool(input=>searchScope(input.type),searchQuerySchema,'Search current authorized Case/history/Proof/Capsule/Builder projections.',input=>services.search.query(actor,input)),
    galaxy_evidence_submit:tool('evidence',submission,'Submit Evidence source metadata covered by an existing exact Consent.',input=>services.evidence.submit(actor,input),true),
    galaxy_evidence_get:tool('evidence',id,'Read an authorized Evidence observation state.',input=>services.evidence.get(actor,input.id)),
    galaxy_proof_get:tool('proof',id,'Read a Proof using current visibility and revocation checks.',input=>services.proofs.get(actor,input.id)),
    galaxy_proof_submit:tool('proof',submission,'Publish previously reviewed Proof bytes with exact existing Consent.',input=>services.proofs.publish(actor,input),true),
    galaxy_proof_revoke:tool('proof',id,'Revoke a selected owner Proof.',input=>services.proofs.revoke(actor,input.id),true),
    galaxy_assistance_query:tool('assistance',assistanceQuerySchema,'List current authorized assistance requests.',input=>services.assistance.query(actor,input)),
    galaxy_assistance_get:tool('assistance',id,'Read a current authorized assistance request.',input=>services.assistance.get(actor,input.id)),
    galaxy_assistance_submit:tool('assistance',submission,'Publish a reviewed assistance request with exact existing Consent.',input=>services.assistance.create(actor,input),true),
    galaxy_context_query:tool('context',z.strictObject({assistanceId:z.uuid()}),'List currently authorized material grants for one assistance request.',input=>services.context.query(actor,input)),
    galaxy_context_read:tool('context',id,'Read an explicitly granted material; current permission and a read audit are required.',input=>services.context.get(actor,input.id)),
    galaxy_notifications_query:tool('notifications',notificationQuerySchema,'Read owner notifications.',input=>services.notifications.query(actor,input)),
    galaxy_capsules_query:tool('capsules',capsuleQuerySchema,'List current authorized reusable Capsules.',input=>services.capsules.query(actor,input)),
    galaxy_capsule_get:tool('capsules',capsuleReadSchema,'Read an authorized Capsule revision.',input=>services.capsules.get(actor,input)),
    galaxy_builders_query:tool('builders',builderQuerySchema,'Query the compatible Builder directory without arbitrary endpoint probes.',input=>services.builders.query(actor,input)),
    galaxy_audit_query:tool('audit',auditQuerySchema,'Read owner or explicitly authorized audit records.',input=>services.audit.query(actor,input)),
    galaxy_export_create:tool('data-export',exportCreateSchema,'Create an owner export or explicitly selected authorized-view export ticket.',input=>services.dataExport.create(actor,input),true),
    galaxy_export_page:tool('data-export',exportPageSchema,'Read one current authorized export page.',input=>services.dataExport.page(actor,input)),
    galaxy_export_binary:tool('data-export',exportBinarySchema,'Read one current-authorized outcome-material attachment export chunk.',input=>services.dataExport.binary(actor,input)),
    galaxy_export_revoke:tool('data-export',exportIdSchema,'Revoke a selected owner export ticket.',input=>services.dataExport.revoke(actor,input),true),
  };
}
export function createPersonalMcp(services,actor) {
  const server=new McpServer({name:'galaxy-personal',version:'0.1.0'});
  for(const [name,definition] of Object.entries(definitions(services,actor))) {
    server.registerTool(name,{description:definition.description,inputSchema:definition.inputSchema,
      annotations:{readOnlyHint:!definition.write,destructiveHint:definition.write,openWorldHint:false}},async input=>{
      try { const result=await definition.run(input);return {content:[{type:'text',text:JSON.stringify(result??null)}]}; }
      catch(error){const details=error instanceof ServiceError ? {error:error.code,
        ...(error.quota?{quota:error.quota}:{}),
        ...(Number.isFinite(error.retryAfterSeconds)?{retryAfterSeconds:error.retryAfterSeconds}:{}),
        ...(error.restrictionReason?{restrictionReason:error.restrictionReason}:{})}:null;
        return {isError:true,content:[{type:'text',text:details && Object.keys(details).length>1?JSON.stringify(details):details?.error??'operation_failed'}]};}
    });
  }
  return server;
}

export function createPersonalMcpHandler({services,authority,verifier,allowLoopbackHttp=false}) {
  const resource=new URL(services.access.endpoint+'/mcp/personal');
  const resourceMetadataUrl=getOAuthProtectedResourceMetadataUrl(resource);
  const metadata=buildOAuthProtectedResourceMetadata({oauthMetadata:verifier.metadata(),resourceServerUrl:resource,
    scopesSupported:[oauthScope('binding')],resourceName:'Galaxy Personal',dangerouslyAllowInsecureIssuerUrl:allowLoopbackHttp});
  const schemaDefinitions=definitions(services,null);
  async function challenge(response,error,requiredScopes,recordFailure) {
    if(error instanceof ServiceError)throw error;
    const result=bearerAuthChallengeResponse(error,{resourceMetadataUrl,requiredScopes});
    await recordFailure(result.status,'oauth_authorization_rejected');
    for(const [key,value] of result.headers)response.setHeader(key,value);
    response.statusCode=result.status;response.end(await result.text());
  }
  return Object.freeze({metadataPath:new URL(resourceMetadataUrl).pathname,metadata:()=>structuredClone(metadata),resource:resource.href,
    async handle(request,response,{requestId,recordFailure=async()=>{}}) {
      if(request.headers.host!==resource.host)throw new ServiceError('invalid_host',403);
      let actor,info;
      const basic=[oauthScope('binding')];
      try {
        info=await verifyBearerToken(request.headers.authorization,{resourceMetadataUrl,requiredScopes:basic,
          verifier:{async verifyAccessToken(token){const result=await authority.authenticate(token,{httpRequestId:requestId});actor=result.actor;return result.authInfo;}}});
        await captureAuthenticatedRequest(request,actor,info.token);
      }catch(error){return challenge(response,error,basic,recordFailure);}
      const parsed=request.method==='POST'?await body(request,null):undefined;
      if(parsed?.method==='tools/call') {
        const definition=Object.hasOwn(schemaDefinitions,parsed.params?.name)?schemaDefinitions[parsed.params.name]:null;
        if(definition){
          const input=definition.inputSchema.safeParse(parsed.params.arguments??{});
          if(input.success){
            const scope=typeof definition.scope==='function'?definition.scope(input.data):definition.scope;
            const required=[...new Set([...basic,oauthScope(scope)])];
            try{await verifyBearerToken(request.headers.authorization,{resourceMetadataUrl,requiredScopes:required,verifier:{verifyAccessToken:async()=>info}});}
            catch(error){return challenge(response,error,required,recordFailure);}
          }
        }
      }
      const server=createPersonalMcp(services,actor);
      const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      try { await server.connect(transport);await transport.handleRequest(request,response,parsed); }
      finally { await server.close(); }
    },
  });
}
