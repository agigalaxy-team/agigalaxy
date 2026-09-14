import {z} from 'zod';
import {ciIdSchema,ciProofPreviewSchema,ciReceiptSchema} from './shared/ci-observation-v2-schema.mjs';
export function ciToolDefinitions(services,actor){const tool=(scope,inputSchema,description,run,write=false)=>({scope,inputSchema,description,run,write});
  const signed=z.strictObject({consentId:z.uuid(),payloadJson:z.string().min(1).max(12000)});
  return{
    galaxy_ci_v2_receipt:tool('binding',ciReceiptSchema,'Reconcile your exact stored operation hash after a lost response. Recorded is not a current valid CI claim; the service additionally requires evidence/proof scope for the selected object.',i=>services.ciV2.receipt(actor,i)),
    galaxy_ci_v2_observe:tool('evidence',signed,'Queue selected public GitHub run observation. Exact ci.observe Consent binds your current v2 Evidence and Result versions and typed run tuple; does not run your project or certify capability.',i=>services.ciV2.submit(actor,i),true),
    galaxy_ci_v2_read:tool('evidence',ciIdSchema,'Read your CI observation request and current upstream status. Corrected/revoked sources invalidate the observation.',i=>services.ciV2.get(actor,i)),
    galaxy_ci_v2_stop:tool('evidence',ciIdSchema,'Stop your selected observation request and invalidate dependent proofs.',i=>services.ciV2.revokeRequest(actor,i),true),
    galaxy_ci_v2_proof_preview:tool('proof',ciProofPreviewSchema,'Preview bounded CI observation proof bytes before separately authorizing disclosure; private Case/Task/Evidence text is absent.',i=>services.ciV2.preview(actor,i)),
    galaxy_ci_v2_proof_publish:tool('proof',signed,'Publish exactly previewed v2 CI proof using proof.publish Consent. This is repository-controlled execution observation, not independent work, issue resolution or expert certification.',i=>services.ciV2.publish(actor,i),true),
    galaxy_ci_v2_proof_read:tool('proof',ciIdSchema,'Check current signed CI proof, exact source binding, expiry and revocation. An offline signature alone does not establish current availability.',i=>services.ciV2.getProof(actor,i)),
    galaxy_ci_v2_proof_revoke:tool('proof',ciIdSchema,'Revoke your selected v2 CI proof without changing legacy proof records.',i=>services.ciV2.revokeProof(actor,i),true),
  };}
