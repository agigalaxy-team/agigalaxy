import {z} from 'zod';
import {capsuleReadSchema,capsuleQuerySchema,capsuleUsesQuerySchema,capsulePreviewV2Schema} from '../../../../shared/capsule-v2-schema.mjs';
import {capsuleReceiptV2Schema,capsuleVersionsV2Schema,capsulePermissionsQueryV2Schema} from '../../../../shared/capsule-v2-schema.mjs';
export function capsuleToolDefinitions(services,actor){
  const signed=z.strictObject({consentId:z.uuid(),payloadJson:z.string().min(1).max(48000)});
  const tool=(inputSchema,description,run,write=false)=>({scope:'capsules',inputSchema,description,run,write});
  return {
    galaxy_capsule_v2_receipt:tool(capsuleReceiptV2Schema,'Query only your exact operation ID and accepted payload hash. Acknowledgement does not grant current source or body access.',i=>services.capsules.receiptV2(actor,i)),
    galaxy_capsule_v2_versions:tool(capsuleVersionsV2Schema,'List exact currently authorized versions without silently replacing an old selected version with latest. Owners also see their version management state.',i=>services.capsules.versionsV2(actor,i)),
    galaxy_capsule_v2_permissions:tool(capsulePermissionsQueryV2Schema,'List your source permissions or those explicitly granted to you with current expiry, revocation and source status. These are not coauthor or ownership certifications.',i=>services.capsules.permissionsQueryV2(actor,i)),
    galaxy_capsule_v2_preview:tool(capsulePreviewV2Schema,'Validate a user-side draft and selected source permissions without publishing or recording reuse. Failure reasons identify unresolved source/permission conditions.',i=>services.capsules.previewV2(actor,i)),
    galaxy_capsule_v2_publish:tool(signed,'Publish exact authorized version or maintenance bytes. Formal source success is a reported Result, not an independently verified solution or expertise. Coauthor approval is separate from source permission.',i=>services.capsules.publishV2(actor,i),true),
    galaxy_capsule_v2_read:tool(capsuleReadSchema,'Read a precise permitted version and current source status. Reading creates no application or successful reuse.',i=>services.capsules.getV2(actor,i)),
    galaxy_capsule_v2_query:tool(capsuleQuerySchema,'Find currently permitted Capsules with source and maintenance status. No historical visible-version fallback over a private latest version.',i=>services.capsules.queryV2(actor,i)),
    galaxy_capsule_v2_use:tool(signed,'Record exact authorized reference, actual apply, or scoped reverification using real Attempt/Result versions. References and synthetic examples never count as verified reuse.',i=>services.capsules.recordUseV2(actor,i),true),
    galaxy_capsule_v2_uses:tool(capsuleUsesQuerySchema,'Read current permitted application facts, explicit failed/partial outcomes, exact verification statuses and distinct target Case counts. Counts do not certify independent causality or capability.',i=>services.capsules.usesV2(actor,i)),
    galaxy_capsule_v2_permission:tool(signed,'Record or revoke an author-signed selected-source permission. Consent action is capsule.permission and objectId is payload.id; reading a room is not permission to publish its messages.',i=>services.capsules.permissionV2(actor,i),true),
    galaxy_capsule_v2_permission_read:tool(z.strictObject({permissionId:z.uuid()}),'Read a currently authorized source permission, including its explicit revoked state. Permission does not claim coauthorship or legal ownership verification.',i=>services.capsules.permissionReadV2(actor,i)),
  };
}
