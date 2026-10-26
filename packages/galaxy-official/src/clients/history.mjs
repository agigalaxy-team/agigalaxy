import { historyQuerySchema,historyFieldPolicySchema,historyRefreshSchema,historyProgressSchema } from "../shared/history-schema.mjs";
import { selfDeclaredProfileSchema } from "../shared/profile-schema.mjs";
import { createProfileClient } from "./profile.mjs";
import { summarizeCiProofViews } from "../shared/ci-provenance.mjs";
import canonicalize from 'canonicalize';
export { profileStatementSchema,selfDeclaredProfileSchema } from "../shared/profile-schema.mjs";
import { postPublicJson, validatePublicUrl } from "../infrastructure/public-fetch.mjs";
import { historyRebuildSchema,historyContentHash,compareHistoryRebuilds } from "../shared/history-rebuild.mjs";
export { compareHistoryRebuilds } from "../shared/history-rebuild.mjs";
export { createSearchClient } from "./search.mjs";

// Explicit host action; no background fetch, credential persistence or automatic pagination.
export function createHistoryClient({ endpoint, sessions, send = postPublicJson }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !sessions)
    throw new Error('Invalid history client configuration.');
  const baselines=new Map();let baselineIdentity=null;
  async function query(input = {}, { signal } = {}) {
    const options = historyQuerySchema.parse(input);
    signal?.throwIfAborted();
    const authorization = await sessions.readAuthorization(endpoint);
    if (!authorization || !authorization.scopes.includes('history')) throw new Error('History authorization required.');
    const check = async () => {
      signal?.throwIfAborted();
      if (!await sessions.isAuthorizationCurrent(authorization) || !sessions.matchesAuthorization(authorization))
        throw new Error('History authorization changed.');
      signal?.throwIfAborted();
    };
    await check();
    let document;
    try {
      document = await send(endpoint + '/v1/history/query', { bodyJson: JSON.stringify(options),
        credential: authorization.credential, signal, maxBytes: 1048576 });
    } catch (error) {
      if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(authorization, 'remote-rejected');
      throw error;
    }
    await check();
    if (!document || document.projectionVersion !== 1 || document.derived !== true
      || document.capabilityVerified !== false || document.subjectId !== (options.subjectId ?? null)
      || !Array.isArray(document.items) || document.items.length > options.limit
      || !Number.isSafeInteger(document.checkedAt)
      || !['owner', 'authorized'].includes(document.view)
      || !(document.nextCursor === null || /^[0-9a-f-]{36}$/.test(document.nextCursor))
      || document.items.some(item => !item || !/^[0-9a-f-]{36}$/.test(item.caseId)
        || item.capabilityVerified !== false || !Array.isArray(item.results) || !Array.isArray(item.matchReasons)))
      throw new Error('Invalid history response.');
    if(document.selfDeclared!==undefined)selfDeclaredProfileSchema.parse(document.selfDeclared);
    if(document.refresh!==undefined)historyRefreshSchema.parse(document.refresh);
    if(document.pageSummary?.ciSources!==undefined&&canonicalize(document.pageSummary.ciSources)!==canonicalize(summarizeCiProofViews(document.items.flatMap(item=>item.proofs??[]))))
      throw new Error('History CI source count mismatch.');
    // Validate the complete page before replacing any in-memory comparison.
    for(const item of document.items){if(item.rebuild){
      const receipt=historyRebuildSchema.parse(item.rebuild);
      if(receipt.rule.version>=3){
        const policy=historyFieldPolicySchema.parse(item.fieldPolicy);historyProgressSchema.parse(item.reportedProgress);
        if(policy.view!==receipt.view)throw new Error('History field policy mismatch.');
      }
      if(receipt.endpoint!==endpoint||receipt.caseId!==item.caseId||receipt.sourceVersion!==item.sourceVersion
        ||![1,2,3,4].includes(receipt.rule.version)||receipt.contentHash!==historyContentHash(item,receipt.rule.version)
        ||(document.view==='owner'&&receipt.view!=='owner')||receipt.view==='public')throw new Error('Invalid history rebuild receipt.');
    }}
    const identity=authorization.subjectId+':'+authorization.bindingId;
    if(identity!==baselineIdentity){baselines.clear();baselineIdentity=identity;}
    const items=document.items.map(item=>{
      const key=(item.rebuild?.view??document.view)+':'+item.caseId;
      const rebuildComparison=compareHistoryRebuilds(baselines.get(key),item.rebuild);
      if(item.rebuild){baselines.delete(key);baselines.set(key,structuredClone(item.rebuild));}
      else baselines.delete(key);
      while(baselines.size>128)baselines.delete(baselines.keys().next().value);
      return {...item,rebuildComparison};
    });
    // These are endpoint-reported projections, not independently verified credentials.
    return { ...document,items, endpoint, source: 'endpoint-reported' };
  }
  return Object.freeze({ query, profile: (subjectId, options) => query({ subjectId }, options),publishProfile:createProfileClient({endpoint,sessions,send}).publish });
}
