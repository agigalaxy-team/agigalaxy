import { createCapsuleWebClient } from './capsule-workspace-client.mjs';
export function createWorkerPackUseClient({
  runtime,
  subjectId,
  now,
}) {
  const endpoint = runtime.api.endpoint;
  const journal = createCapsuleWebClient({
    api: runtime.api,
    getLocal: runtime.getLocal,
    putLocal: runtime.putLocal,
    subjectId,
    operationFamily: 'worker-pack',
    ...(now ? { now } : {}),
  });
  const read = async (path, input = {}, privateRead = false) => {
    const snapshot = () => { const s = runtime.api.snapshot(); return JSON.stringify([
      runtime.api.endpoint, s?.subjectId ?? null, s?.bindingId ?? null, s?.generation ?? null,
      s?.control?.deviceId ?? null, s?.control?.epoch ?? null]); },
      lease = snapshot(), current = runtime.api.snapshot()?.subjectId,
      authenticated = !!subjectId && current === subjectId;
    if (runtime.api.endpoint !== endpoint) throw Error('读取服务连接已变化。');
    if (privateRead && !authenticated) throw Error('请连接当前身份。');
    const value = await runtime.api.call(path, input, { authenticated });
    if (snapshot() !== lease)
      throw Error('读取身份或连接已变化，请重新读取当前来源。');
    return value;
  };
  return {
    ...journal,
    prepare: (payload, disclosure) =>
      journal.prepare('worker-pack', payload, disclosure),
    manifest: (input) => read('/v2/builders/pack/manifest', input),
    query: (input) => read('/v2/builders/pack-uses/query', input),
    get: (input) => read('/v2/builders/pack-uses/read', input),
    candidates: (input) =>
      read('/v2/builders/pack-uses/candidates', input, true),
    builders: (input) =>
      read('/v1/builders/query', { type: 'worker', ...input }),
    support: (builderId) => read('/v2/builders/support/read', { builderId }),
    caseFacts: (caseId, taskId) =>
      read('/v2/cases/' + caseId + '/read', taskId ? { taskId } : {}, true),
  };
}
/**
 * @param {{
 *   pack: import('./tool-workspace-state').ToolManifest,
 *   caseView: import('./tool-workspace-state').ToolCaseCandidate,
 *   attempt: import('./tool-workspace-state').ToolCandidateAttempt,
 *   result?: import('./tool-workspace-state').ToolResult|null,
 *   evidence?: import('./tool-workspace-state').ToolEvidence[],
 *   verifications?: import('./tool-workspace-state').ToolVerification[],
 *   prior?: import('./tool-workspace-state').PackUseRecord['follows'],
 *   existing?: import('./tool-workspace-state').PackUseView|null
 * }} input
 */
export function preparePackUse({
  pack,
  caseView,
  attempt,
  result = null,
  evidence = [],
  verifications = [],
  prior = null,
  existing = null,
}) {
  if (!pack?.manifestId || !attempt?.configurationRef || !caseView)
    throw Error('请选择准确Pack版本与实际配置下的尝试。');
  return {
    schemaVersion: 2,
    kind: 'record',
    operationId: crypto.randomUUID(),
    id: existing?.id ?? crypto.randomUUID(),
    expectedVersion: existing?.currentVersion ?? 0,
    pack: {
      builderId: pack.builderId,
      manifestId: pack.manifestId,
      manifestHash: pack.manifestHash,
    },
    caseId: caseView.caseId,
    attempt: { id: attempt.id, version: attempt.version },
    configuration: attempt.configurationRef,
    result: result ? { id: result.id, version: result.version } : null,
    evidenceRefs: evidence.map((v) => ({ id: v.id, version: v.version })),
    verificationRefs: verifications.map((v) => ({
      id: v.id,
      version: v.version,
    })),
    follows: existing?.record?.follows ?? prior,
  };
}
