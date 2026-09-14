import {builderExtensionWriteSchema,builderExtensionReadSchema,builderPackExportSchema} from './shared/builder-support-v2-schema.mjs';
import {builderReadSchema,builderOwnedQuerySchema,builderReceiptSchema,builderNoticesSchema} from './shared/builders-schema.mjs';
export function builderToolDefinitions(services,actor){
  if(!services.builders?.v2)return {};
  const tool=(inputSchema,description,run,write=false)=>({scope:'builders',inputSchema,description,run,write});
  return {
    galaxy_builder_support_read:tool(builderExtensionReadSchema,'Read currently authorized declared object actions, scoped assessor reports and Pack metadata. A report is not professional certification.',input=>services.builders.v2.get(actor,input)),
    galaxy_builder_support_publish:tool(builderExtensionWriteSchema,'Publish one exact signed builder.publish event for support, Pack or scope report. Do not fabricate runs or infer permission from a directory entry.',input=>services.builders.v2.publish(actor,input),true),
    galaxy_builder_pack_export:tool(builderPackExportSchema,'Export the exact currently readable author-declared Pack manifest reference. Does not install, start a Worker or add successful use.',input=>services.builders.v2.exportPack(actor,input)),
    galaxy_builder_read:tool(builderReadSchema,'Read existing versioned declaration, maintenance, node approval and finite reachability.',input=>services.builders.get(actor,input)),
    galaxy_builder_owned:tool(builderOwnedQuerySchema,'Read your own registry entries, including unavailable declarations needing recovery.',input=>services.builders.owned(actor,input)),
    galaxy_builder_receipt:tool(builderReceiptSchema,'Reconcile an exact original builder event before retrying; no implicit republish.',input=>services.builders.receipt(actor,input)),
    galaxy_builder_notices:tool(builderNoticesSchema,'Read currently permitted maintenance notices and their actual versions.',input=>services.builders.notices(actor,input)),
  };
}
