// Portable verification only. Inputs are explicitly supplied signed documents;
// no endpoint fetching, binding, identity access or trust discovery occurs here.
export { verifyCiProof,verifyCiProofCollection } from './verification/ci-proof.mjs';
export { githubBridgeMapping } from './shared/ci-provenance.mjs';
