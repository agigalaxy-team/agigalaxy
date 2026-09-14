import { verifyGalaxyGenesis } from '../../../galaxy-core/src/galaxy-guid.mjs';
import { controlOperationSchema } from '../shared/identity-control-schema.mjs';
import { controlKeyId,controlEventHash,verifyControlSignature } from '../domain/identity-control.mjs';

// Offline verification establishes the included history only. The caller must
// independently obtain current authority state before granting present access.
import { verifyControlChainWith } from '../shared/trust-package-control-chain-engine.mjs';

export async function verifyIdentityControlChain(input){
  return verifyControlChainWith(input,{verifyGalaxyGenesis,controlOperationSchema,controlKeyId,controlEventHash,verifyControlSignature});
}
