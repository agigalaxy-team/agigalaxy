import { z } from 'zod';
import { outcomeMaterialQuerySchema, outcomeMaterialReadSchema,
  outcomeMaterialSelectionSchema, outcomeMaterialReceiptSchema } from './shared/outcome-material-v2-schema.mjs';

const envelope = z.strictObject({ consentId: z.uuid(), payloadJson: z.string().min(1).max(24000) });

export function outcomeMaterialToolDefinitions(services, actor) {
  if (!services.outcomeMaterials) return {};
  const tool = (inputSchema, description, run, write = false) => ({
    scope: 'evidence', inputSchema, description, run, write,
  });
  return {
    galaxy_outcome_material_source: tool(outcomeMaterialSelectionSchema,
      'Preview one explicitly selected message or attachment before requesting independent retention. Preview does not copy content or change the original chat TTL.',
      input => services.outcomeMaterials.source(actor, input)),
    galaxy_outcome_material_request: tool(envelope,
      'Request an independently retained copy of a selected outcome material with an exact pre-signed Consent. The source author must approve; this does not provide a model or infer success.',
      input => services.outcomeMaterials.request(actor, input), true),
    galaxy_outcome_material_approve: tool(envelope,
      'Approve an exact outcome material copy as the source author. Independent retention is explicit and does not alter the original chat lifecycle.',
      input => services.outcomeMaterials.approve(actor, input), true),
    galaxy_outcome_material_control: tool(envelope,
      'Decline, cancel or revoke one outcome material using an exact signed control event. Revocation schedules only the Galaxy-held copy for cleanup.',
      input => services.outcomeMaterials.control(actor, input), true),
    galaxy_outcome_material_read: tool(outcomeMaterialReadSchema,
      'Read one current outcome material only when its owner, source-author and Case permissions remain valid. Text content may be returned; attachments return metadata and instructions for explicit authorized web or HTTP retrieval, never binary base64. Permission loss returns metadata without the body or retrieval instructions to a party.',
      async input => {
        const { bytesBase64, ...view } = await services.outcomeMaterials.read(actor, input);
        if (typeof bytesBase64 !== 'string' || !view.contentAvailable || view.authorization !== 'current') return view;
        return { ...view, fileRetrieval: { via: 'existing-authorized-web-or-http', method: 'POST',
          path: '/v2/outcome-materials/read', input: { id: view.materialId, version: view.version },
          currentAuthorizationRequired: true } };
      }),
    galaxy_outcome_material_inspect: tool(outcomeMaterialReadSchema,
      'Inspect the current proposal and request hash for a material you own or authored; this does not mean it was approved or reused.',
      input => services.outcomeMaterials.inspect(actor, input)),
    galaxy_outcome_material_query: tool(outcomeMaterialQuerySchema,
      'List your requested or authored outcome materials and their current permission state. Listing does not certify the material or Case result.',
      input => services.outcomeMaterials.query(actor, input)),
    galaxy_outcome_material_receipt: tool(outcomeMaterialReceiptSchema,
      'Reconcile an uncertain outcome material operation by its stable operation ID and payload hash; it never retries a different payload.',
      input => services.outcomeMaterials.operationReceipt(actor, input)),
  };
}
