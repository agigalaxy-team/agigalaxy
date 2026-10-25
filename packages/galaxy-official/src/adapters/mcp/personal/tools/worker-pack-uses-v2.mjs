import * as z from 'zod/v4';
import {
  packUseReadSchema,
  packUseQuerySchema,
  packUseCandidatesSchema,
  packUseReceiptSchema,
  packManifestReadSchema,
} from '../../../../shared/worker-pack-uses-v2-schema.mjs';
const writeSchema = z.strictObject({
  consentId: z.uuid(),
  payloadJson: z.string().max(18000),
});
export function workerPackUseToolDefinitions(services, actor) {
  const service = services.packUses;
  if (!service) return {};
  const tool = (inputSchema, description, run, write = false) => ({
    scope: 'builders',
    inputSchema,
    description,
    run,
    write,
  });
  return {
    galaxy_worker_pack_manifest: tool(
      packManifestReadSchema,
      'Read an exact currently authorized Pack manifest revision, including historical status. No installation or model execution.',
      (input) => services.builders.v2.manifest(actor, input),
    ),
    galaxy_worker_pack_candidates: tool(
      packUseCandidatesSchema,
      'List your actually recorded native Attempts with exact Configuration, Result and currently usable evidence versions. Does not invent work or request broader data.',
      (input) => service.candidates(actor, input),
    ),
    galaxy_worker_pack_use_record: tool(
      writeSchema,
      'Submit exact builder.publish consent for your actual Pack use association or withdrawal. The signer must own the Attempt. Never mark install/download as successful reuse.',
      (input) => service.submit(actor, input),
      true,
    ),
    galaxy_worker_pack_use_read: tool(
      packUseReadSchema,
      'Read a Pack use against current source authorization and exact versions. Reported results and independent verification remain separate.',
      (input) => service.get(actor, input),
    ),
    galaxy_worker_pack_uses: tool(
      packUseQuerySchema,
      'Query currently authorized Pack use associations. Visibility and counts do not establish professional ability.',
      (input) => service.query(actor, input),
    ),
    galaxy_worker_pack_use_receipt: tool(
      packUseReceiptSchema,
      'Reconcile your exact original operation ID and payload hash before retrying. A receipt is not current source access.',
      (input) => service.receipt(actor, input),
    ),
  };
}
