import {trustPermissionPreviewSchema,trustPermissionMutationSchema,trustPermissionLookupSchema,
 trustPermissionRevokeSchema,trustPermissionQuerySchema,trustSelectionSchema} from '../../../../trust-package-permissions.mjs';

export function trustPackageToolDefinitions(services,actor){
 if(!services.trustPackages)return {};
 const tool=(inputSchema,description,method,write=false)=>({scope:'consent',inputSchema,description,write,run:input=>services.trustPackages[method](actor,input)});
 return {
  galaxy_trust_sources:tool(trustSelectionSchema,'Obtain only selected authored references or exact record bytes under a separate trust-package reproduction permission. Current read access and other-purpose grants do not grant reproduction. No package/model inference is uploaded.','sources'),
  galaxy_trust_permission_preview:tool(trustPermissionPreviewSchema,'Preview a new exact original-author, source version/hash, grantee, audience and expiry license. No grant exists until the user selects and the local current device signs this exact payload.','preview'),
  galaxy_trust_permission_revoke_preview:tool(trustPermissionRevokeSchema,'Preview revocation of one own trust-purpose license. It does not erase already distributed files or invalidate historical signature mathematics.','revokePreview'),
  galaxy_trust_permission_submit:tool(trustPermissionMutationSchema,'Submit only the already user-reviewed exact current-device trust permission JWS. Never substitute a model Boolean for the actual local signature. Reconcile the original receipt before retrying.','submit',true),
  galaxy_trust_permission_receipt:tool(trustPermissionLookupSchema,'Query original author operation/signature hashes after an unknown result. Historical receipt is separate from current source/control permission.','receipt'),
  galaxy_trust_permission_status:tool(trustPermissionLookupSchema,'Explicitly recheck a selected service license and its source/control status. This does not grant online source reading, verify skill, or certify all package facts.','status'),
  galaxy_trust_permission_query:tool(trustPermissionQuerySchema,'List this current subject’s authored or received trust-purpose licenses and exact source references, with current status and pagination.','query'),
 };
}
