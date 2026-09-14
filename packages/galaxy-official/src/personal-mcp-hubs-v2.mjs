import * as z from 'zod/v4';
import {peeringReadSchema,peeringQuerySchema,peeringListSchema,peeringPreviewSchema,peeringWriteSchema,peeringSourcesSchema,peeringConnectionsSchema} from './shared/hub-peering-v2-schema.mjs';
import {hubReadSchema,hubQuerySchema,hubMembershipQuerySchema,hubReceiptSchema,hubIntakeQuerySchema} from './shared/hubs-v2-schema.mjs';
export function hubToolDefinitions(services,actor){if(!services.hubs)return{};
  const tool=(inputSchema,description,run,write=false)=>({scope:'builders',inputSchema,description,run,write});
  return{
    galaxy_hub_peering_party:tool(peeringConnectionsSchema,'Read operated Hub endpoint and currently configured public verification pins for explicit agreement preparation. No secret key or autonomous-domain claim.',q=>services.peering.party(actor,q)),
    galaxy_hub_peering_connections:tool(peeringConnectionsSchema,'List currently usable local agreements for this operator or explicitly confirmed member; this does not claim a peer is online.',q=>services.peering.connections(actor,q)),
    galaxy_hub_peering_sources:tool(peeringSourcesSchema,'Select exact owned current publication-controlled CI Proofs or authored finite contribution references. Only minimal selection metadata is returned; no Case/Task body.',q=>services.peering.sources(actor,q)),
    galaxy_hub_manage:tool(hubReadSchema,'Read actual owner management metadata and latest Charter version even if original Charter permission has expired; no old text is restored.',q=>services.hubs.manage(actor,q)),
    galaxy_hub_peering_events:tool(peeringWriteSchema,'Submit exact existing hub.publish Consent for local agreement approval/exit or a precise source grant/revoke; the other Hub must independently approve the same agreement. No implicit original-context sharing.',q=>services.peering.submit(actor,q),true),
    galaxy_hub_peering_read:tool(peeringReadSchema,'Read own selected peering agreement and original pins; local approval alone does not establish current remote approval.',q=>services.peering.read(actor,q)),
    galaxy_hub_peering_list:tool(peeringListSchema,'List own agreements or exact source grants with stable pagination; expired permissions do not restore original source text.',q=>services.peering.list(actor,q)),
    galaxy_hub_peering_preview:tool(peeringPreviewSchema,'Preview exact own Proof or selected nonnarrative contribution fields before granting separately listed remote readers. Existing read or Honor publication is not this license.',q=>services.peering.preview(actor,q)),
    galaxy_hub_peering_query:tool(peeringQuerySchema,'Read current explicitly permitted remote Proofs or contribution summaries as this authenticated user under the chosen two-party agreement. Retain original issuer/strength; offline is unknown, no Relay fallback. Recheck previously selected grant IDs before reuse.',q=>services.peering.query(actor,q)),
    galaxy_hub_peering_receipt:tool(hubReceiptSchema,'Reconcile only an exact original peering write ID and payload hash before retry; no new choice or signature is created.',q=>services.peering.receipt(actor,q)),
    galaxy_hub_status:tool(z.strictObject({}),'Read implemented Hub profile and limits; membership or a declaration is not proof of an independent network or professional capability.',()=>services.hubs.specification()),
    galaxy_hub_query:tool(hubQuerySchema,'Browse currently authorized structured Hub Charters. Public mode sends no private query context.',q=>services.hubs.query(actor,q)),
    galaxy_hub_read:tool(hubReadSchema,'Read exact Charter version, its declaration reference and current claimed/reported/unknown evidence boundaries.',q=>services.hubs.get(actor,q)),
    galaxy_hub_events:tool(z.strictObject({consentId:z.uuid(),payloadJson:z.string().max(48000)}),'Submit exact hub.publish signed Consent and event. Charter, controlled invitation, member acceptance/exit and private intake are separate actions. No automatic Task or chat access.',q=>services.hubs.submit(actor,q),true),
    galaxy_hub_memberships:tool(hubMembershipQuerySchema,'Read your memberships or, for the declared operator, this Hub membership management list. A revised Charter never automatically widens accepted scope.',q=>services.hubs.members(actor,q)),
    galaxy_hub_intake:tool(hubIntakeQuerySchema,'Read only your own or your operated Hub private intake threads with current consent and fixed content expiry.',q=>services.hubs.intake(actor,q)),
    galaxy_hub_receipt:tool(hubReceiptSchema,'Reconcile exact original operation ID and payload hash before retry; an accepted event does not prove a real autonomous Hub is operating.',q=>services.hubs.receipt(actor,q)),
  };
}
