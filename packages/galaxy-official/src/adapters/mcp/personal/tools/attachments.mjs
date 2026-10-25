import * as z from 'zod/v4';
import {attachmentReadSchema,attachmentQuerySchema} from '../../../../shared/chat-attachments-schema.mjs';
export function attachmentToolDefinitions(services,actor){
 if(!services.attachments)return {};
 const tool=(inputSchema,description,run,write=false)=>({scope:'binding',inputSchema,description,run,write});
 return {
  galaxy_attachment_config:tool(z.strictObject({}),'Read configured temporary file limits; configured availability does not prove a live upload or scan.',()=>services.attachments.specification()),
  galaxy_attachment_read:tool(attachmentReadSchema,'Read current room-authorized temporary file status. Scan clean is not a safety guarantee and not Evidence verification.',x=>services.attachments.get(actor,x)),
  galaxy_attachment_owned:tool(attachmentQuerySchema,'List your existing uploads in this currently authorized room. Use the browser to select local bytes and confirm upload; this tool does not read host files.',x=>services.attachments.queryOwn(actor,x)),
  galaxy_attachment_revoke:tool(attachmentReadSchema,'After user confirmation, revoke your exact file. Download stops and managed object cleanup is queued; message text and downloaded external copies have separate lifecycles.',x=>services.attachments.revoke(actor,x),true),
 };
}
