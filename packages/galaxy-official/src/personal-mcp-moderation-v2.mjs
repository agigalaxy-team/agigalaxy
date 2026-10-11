import * as z from 'zod/v4';
import {moderationReceiptSchema} from './shared/moderation-schema.mjs';
export function moderationToolDefinitions(services,actor){
 if(!services.moderation)return{};
 const tool=(inputSchema,description,run,write=false)=>({scope:'moderation',inputSchema,description,run,write});
 const signed={consentId:z.uuid(),payloadJson:z.string().min(1).max(16000)};
 return{
  galaxy_moderation_config:tool(z.strictObject({}),
   'Read this endpoint’s current Case/Assistance review configuration and participant support before preparing an action. Configured moderators are process roles, without automatic private-source access or independence certification.',
   ()=>services.moderation.config(actor)),
  galaxy_moderation_query:tool(z.strictObject({caseId:z.uuid().optional(),assistanceId:z.uuid().optional(),after:z.uuid().optional(),limit:z.number().int().min(1).max(20).default(8)})
   .refine(input=>!(input.caseId&&input.assistanceId)),
   'Find currently permitted review reports and your verifier invitations or participation. Optional Case and Assistance filters are alternatives. Hidden reports and their private content are not granted by this listing.',
   input=>services.moderation.query(actor,input)),
  galaxy_moderation_get:tool(z.strictObject({reportId:z.uuid()}),
   'Read the current report version, permitted report/events, precise invitation target and scope, and available actions. Invitation, acceptance, source-read permission, signed review, independent process decision and professional qualification remain separate.',
   input=>services.moderation.get(actor,input.reportId)),
  galaxy_moderation_report:tool(z.strictObject(signed),
   'Submit a Case/Evidence or Assistance concern using existing locally reviewed and signed moderation.publish Consent for these exact payloadJson bytes and configured recipients. Requires current source access and version. This tool never signs, grants permission or confirms a real allegation. If the reply is unknown, read the original ID/hash receipt before retrying.',
   input=>services.moderation.report(actor,input),true),
  galaxy_moderation_event:tool(z.strictObject({reportId:z.uuid(),...signed}),
   'Submit an exact reviewed, signed report event: invite, accept, decline, scoped verification response, withdraw, own supplement/correction/appeal, or an authorized independent process action. Current roles, source access, exact recipients, invitation expiry and expectedVersion are enforced. A signed participant review does not grant professional certification. Unknown replies must be reconciled by the original event ID and payload hash.',
   ({reportId,...submission})=>services.moderation.event(actor,reportId,submission),true),
  galaxy_moderation_receipt:tool(moderationReceiptSchema,
   'Read only your original reportId/eventId/payloadHash acceptance receipt after missing ACK or grant withdrawal. No old report, event body, member access, independence or capability verification is returned; never resends.',
   input=>services.moderation.receipt(actor,input)),
 };
}
