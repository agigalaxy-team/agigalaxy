import * as z from 'zod/v4';
import {contextQueryV2Schema,contextReceiptV2Schema} from './shared/context-v2-schema.mjs';
export function contextV2ToolDefinitions(services,actor){
 if(!services.contextV2)return {};
 const tool=(inputSchema,description,run,write=false)=>({scope:'context',inputSchema,description,run,write});
 const signed={consentId:z.uuid(),payloadJson:z.string().min(1).max(40000)};
 return {
  galaxy_context_v2_query:tool(contextQueryV2Schema,'List only this subject’s per-participant selected material grants. Expiry, rejection, scope changes and revocation are independent; membership or accepted participation does not grant material access.',x=>services.contextV2.query(actor,x)),
  galaxy_context_v2_get:tool(z.strictObject({grantId:z.uuid(),metadataOnly:z.boolean().default(false)}),'Read current authorized selected text or metadata. Obtain metadata.materialsHash from this real response before proposing acceptance. Galaxy supplies data; the user Agent decides which material is useful. No repository or runtime access is created.',x=>services.contextV2.get(actor,x.grantId,{metadataOnly:x.metadataOnly})),
  galaxy_context_v2_grant:tool(z.strictObject(signed),'Submit exact user-reviewed text for one taskId, participationId and agreed scopeVersion using a locally signed context.grant Consent. Never share the whole context, every participant, or private cloud summaries automatically.',x=>services.contextV2.create(actor,x),true),
  galaxy_context_v2_event:tool(z.strictObject({grantId:z.uuid(),...signed}),'Submit one explicitly signed accept, decline or revoke event. Acceptance must name the exact materialsHash obtained from metadata; it is not execution, room membership, successful assistance or capability verification.',({grantId,...x})=>services.contextV2.submitEvent(actor,grantId,x),true),
  galaxy_context_v2_receipt:tool(contextReceiptV2Schema,'Reconcile the original author event ID and payload hash after a missing ACK before retrying. Accepted receipt is historical evidence only; query the material again for current permission.',x=>services.contextV2.receipt(actor,x)),
 };
}
