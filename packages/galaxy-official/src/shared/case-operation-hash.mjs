import canonicalize from 'canonicalize';
import { digest } from './digest.mjs';
import { caseTaskLinkSchema } from './cases-schema.mjs';

// Exact fact bytes are immutable. The separately signed Consent can be renewed
// without turning the same business operation into another Case or work fact.
export function caseTaskLinkPayloadHash(input) {
  const command = caseTaskLinkSchema.parse(input);
  return digest(canonicalize({ operationId: command.operationId, taskId: command.taskId,
    expectedTaskVersion: command.expectedTaskVersion,
    case: { payloadJson: command.case.payloadJson }, initialFact: { payloadJson: command.initialFact.payloadJson } }));
}

// Rows written before independent receipts used this exact parsed-object hash.
// Preserve those hashes; this helper is only for known original legacy inputs.
export function legacyCaseTaskLinkPayloadHash(input) {
  return digest(JSON.stringify(caseTaskLinkSchema.parse(input)));
}
