import {z} from 'zod';
import {summaryPreferenceSchema,summaryPutSchema,summaryPageSchema} from './shared/personal-summary-schema.mjs';
import {sharedSummaryPublishSchema,sharedSummaryGetSchema,sharedSummaryPageSchema} from './shared/chat-shared-summary-schema.mjs';
import {inboxQuerySchema,inboxOptionsSchema} from './shared/notification-inbox-schema.mjs';
export function summaryToolDefinitions(services,actor){
 const tool=(inputSchema,description,run,write=false,scope='binding')=>({inputSchema,description,run,write,scope}),result={};
 if(services.summaries)Object.assign(result,{
  galaxy_personal_summary_preferences:tool(z.strictObject({}),'Read existing owner-only cloud summary synchronization choice. Binding or reading never enables cloud sync.',()=>services.summaries.preferences(actor)),
  galaxy_personal_summary_preferences_save:tool(summaryPreferenceSchema,'Apply the user-selected synchronization scope at the exact current service origin. Do not enable because an Agent generated a summary. Local default, private cloud sync and room sharing are separate choices.',x=>services.summaries.savePreference(actor,x),true),
  galaxy_personal_summary_put:tool(summaryPutSchema,'Store this exact user-model or manual result only under existing enabled private sync permission. No model runs on Galaxy. Stable versionId retries preserve conflicts; this never sends a room message.',x=>services.summaries.put(actor,x),true),
  galaxy_personal_summary_get:tool(z.strictObject({summaryId:z.uuid()}),'Read one owner-only retained summary and independent conflict versions with current source filtering. This does not fetch the entire chat or grant sharing permission.',x=>services.summaries.get(actor,x)),
  galaxy_personal_summary_list:tool(summaryPageSchema,'List only this owner’s current permitted private cloud summary replicas. Unavailable local-only summaries cannot be inferred from this cloud list.',x=>services.summaries.list(actor,x)),
  galaxy_personal_summary_sources:tool(z.strictObject({roomId:z.uuid(),refs:z.array(z.strictObject({messageId:z.uuid(),revision:z.number().int().positive()})).max(100)}),'Check exact selected room source versions. Temporary restrictions are not permanent deletion; full history remains a separate read.',x=>services.summaries.sources(actor,x)),
  galaxy_personal_summary_delete:tool(z.strictObject({summaryId:z.uuid(),expectedRevision:z.number().int().nonnegative()}),'Delete the explicitly selected private cloud replica. Does not delete local notes, source room history, or independently shared versions.',x=>services.summaries.delete(actor,x),true),
 });
 if(services.sharedSummaries)Object.assign(result,{
  galaxy_chat_shared_summary_publish:tool(sharedSummaryPublishSchema.safeExtend({agentGrantId:z.uuid()}),'Publish only the user-selected content and exact source versions to the specified same room as an independent shared message. Requires a current respond Agent grant. Preserve shareId after unknown delivery and query before retry; never auto-share a private replica.',x=>services.sharedSummaries.publish(actor,x),true),
  galaxy_chat_shared_summary_get:tool(sharedSummaryGetSchema,'Read or reconcile an exact shared summary message, with current room and source access. Pending is not delivered; accepted is not read by other members.',x=>services.sharedSummaries.get(actor,x)),
  galaxy_chat_shared_summary_list:tool(sharedSummaryPageSchema,'Read voluntarily shared versions and key-message source locators; they complement the complete currently authorized room history.',x=>services.sharedSummaries.list(actor,x)),
  galaxy_chat_shared_summary_retract:tool(sharedSummaryGetSchema,'Retract an explicitly selected owned shared version. Original private notes and other members’ messages stay under their separate controls.',x=>services.sharedSummaries.retract(actor,x),true),
 });
 if(services.inbox)Object.assign(result,{
  galaxy_inbox_query:tool(inboxQuerySchema,'Read current authorized inbox events. Agent queries never mark a human read position or claim actual external delivery.',x=>services.inbox.query(actor,x),false,'notifications'),
  galaxy_inbox_options:tool(z.strictObject({}),'Read owner room/category mute and blocking settings.',()=>services.inbox.options(actor),false,'notifications'),
  galaxy_inbox_options_save:tool(z.strictObject({expectedRevision:z.number().int().nonnegative(),settings:inboxOptionsSchema}),'Apply the user-selected room/category mute or subject block settings. Blocking does not revoke previously public facts; necessary service receipts remain quiet.',x=>services.inbox.saveOptions(actor,x),true,'notifications'),
 });
 return result;
}
