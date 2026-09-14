import * as z from 'zod/v4';
import {identityGroupQuerySchema,identityGroupReceiptSchema,identityGroupSourceSelectionSchema,identityGroupSubmitSchema} from './shared/identity-group-v2-schema.mjs';
export function identityGroupToolDefinitions(services,actor){
 const tool=(inputSchema,description,run,write=false)=>({scope:'binding',inputSchema,description,run,write});
 return{
  galaxy_identity_group_current:tool(z.strictObject({}),'Read this actual device current manage-identity control before an explicit signed identity-group operation.',()=>services.identityGroups.current(actor)),
  galaxy_identity_group_source:tool(identityGroupSourceSelectionSchema,'Preview your exact currently authorized source and its real immutable hash. No source is published or transferred by this read.',x=>services.identityGroups.source(actor,x)),
  galaxy_identity_group_submit:tool(identityGroupSubmitSchema,'Submit an exact current-key proof for the same versioned group intent. All affected identities independently approve; one member may revoke. No original GUID, actor, source rights, Account quota or capability is merged. Replay unknown outcomes using original IDs and receipt.',x=>services.identityGroups.submit(actor,x),true),
  galaxy_identity_group_proposal:tool(z.strictObject({operationId:z.uuid()}),'Read the original proposal bytes only as a named affected identity. Preview before signing; pending does not establish common control.',x=>services.identityGroups.proposal(actor,x.operationId)),
  galaxy_identity_group_read:tool(z.strictObject({groupId:z.uuid()}),'Read current display relationship and exact sources as this viewer. Original authors stay visible; unavailable materials confer no access.',x=>services.identityGroups.read(actor,x.groupId)),
  galaxy_identity_group_query:tool(identityGroupQuerySchema,'List permitted identity display groups; conflicting display IDs are not silently merged.',x=>services.identityGroups.query(actor,x)),
  galaxy_identity_group_resolve:tool(z.strictObject({subjectId:identityGroupQuerySchema.shape.subjectId.unwrap()}),'Resolve an original GUID to permitted current display groups without moving facts or permissions.',x=>services.identityGroups.resolve(actor,x)),
  galaxy_identity_group_receipt:tool(identityGroupReceiptSchema,'Reconcile the exact original operation hash. Committed group and this particular approval acknowledged are distinct facts.',x=>services.identityGroups.receipt(actor,x)),
 };
}
