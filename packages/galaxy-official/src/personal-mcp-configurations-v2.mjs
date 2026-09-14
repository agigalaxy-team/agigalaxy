import * as z from 'zod/v4';
import {configurationReadV2Schema,configurationQueryV2Schema,configurationVersionsV2Schema,configurationReceiptV2Schema} from './shared/configuration-v2-schema.mjs';
export function configurationToolDefinitions(services,actor){
 const tool=(inputSchema,description,run,write=false)=>({scope:'history',inputSchema,description,run,write});
 return {
  galaxy_configuration_v2_submit:tool(z.strictObject({consentId:z.uuid(),payloadJson:z.string().min(1).max(24000)}),'Append exact user-selected conditions or withdraw their object. Consent configuration.publish targets operationId. No environment scan, private prompt, key, full Skill body or implied installation certification. Optional Attempt condition reference is separate from publishing reusable material.',i=>services.configurations.submit(actor,i),true),
  galaxy_configuration_v2_read:tool(configurationReadV2Schema,'Read the exact currently authorized configuration version. Historical versions never silently retarget; unknown and revoked conditions are not proof of failure.',i=>services.configurations.get(actor,i)),
  galaxy_configuration_v2_query:tool(configurationQueryV2Schema,'List currently authorized selected configuration metadata or own management tombstones; missing conditions do not block collaboration.',i=>services.configurations.query(actor,i)),
  galaxy_configuration_v2_versions:tool(configurationVersionsV2Schema,'Choose an exact authorized immutable version, retaining version-specific disclosure.',i=>services.configurations.versions(actor,i)),
  galaxy_configuration_v2_receipt:tool(configurationReceiptV2Schema,'Read your exact accepted operation hash without granting content access or claiming remote installation.',i=>services.configurations.receipt(actor,i)),
 };
}
