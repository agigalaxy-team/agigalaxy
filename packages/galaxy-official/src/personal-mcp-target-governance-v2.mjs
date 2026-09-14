import * as z from 'zod/v4';
import { targetGovernanceQuerySchemaV2, targetGovernanceReceiptSchemaV2 } from './shared/target-governance-v2-schema.mjs';
export function targetGovernanceToolDefinitions(services, actor) {
 if(!services.targetGovernance)return{};const g=services.targetGovernance;
 const tool=(inputSchema,description,run,write=false)=>({scope:'moderation',inputSchema,description,run,write});
 const signed=z.strictObject({consentId:z.uuid(),payloadJson:z.string().min(1).max(10000)});
 return {
  galaxy_target_governance_config:tool(z.strictObject({}),'Read configured handling roles; this does not guarantee an operator response or grant private-room access.',()=>g.config(actor)),
  galaxy_target_governance_target:tool(z.strictObject({type:z.enum(['task','room']),id:z.uuid()}),'Read exact currently authorized Task/Room target version before drafting a limited report. Do not copy unrelated messages.',x=>g.targetInfo(actor,x)),
  galaxy_target_governance_query:tool(targetGovernanceQuerySchemaV2,'Read current authorized reports and appeal status. A pending report is not a punishment or capability failure.',x=>g.query(actor,x)),
  galaxy_target_governance_get:tool(z.strictObject({reportId:z.uuid()}),'Read private handling events separately from current target restrictions; report visibility does not grant original room history.',x=>g.read(actor,x.reportId)),
  galaxy_target_governance_report:tool(signed,'Submit an exact locally signed moderation.publish Task/Room report with selected private viewers. Ordinary chats remain rooms; do not invent a Task or moderator.',x=>g.report(actor,x),true),
  galaxy_target_governance_event:tool(signed,'Submit an authorized supplement/withdrawal/appeal or configured independent handler decision. Restriction scopes and expiry are explicit; resuming this case does not clear other cases or restore revoked source access.',x=>g.event(actor,x),true),
  galaxy_target_governance_receipt:tool(targetGovernanceReceiptSchemaV2,'Reconcile the original event/hash before retry. Acknowledged means accepted historically, not current permission or server cancellation.',x=>g.receipt(actor,x)),
 };
}
