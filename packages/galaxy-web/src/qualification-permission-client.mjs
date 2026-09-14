import { createCapsuleWebClient } from './capsule-workspace-client.mjs';
export function createQualificationPermissionClient({
  runtime,
  subjectId,
  now = () => Math.floor(Date.now() / 1000),
}) {
  const api = runtime.api,
    journal = createCapsuleWebClient({
      api,
      getLocal: runtime.getLocal,
      putLocal: runtime.putLocal,
      subjectId,
      operationFamily: 'qualification',
      now,
    });
  const query = (path, input) => {
    if (api.snapshot()?.subjectId !== subjectId)
      throw Error('请连接当前身份。');
    return api.call(path, input, { authenticated: true });
  };
  const root = '/v2/qualification/permission-requests/';
  return {
    ...journal,
    plan: (input) => query(root + 'plan', input),
    requests: (input) => query(root + 'query', input),
    request: (requestId) => query(root + 'read', { requestId }),
    grants: (input) => query('/v2/qualification/calculation-owned', input),
    prepareRequest: (plan, author) =>
      journal.prepare(
        'qualification-request',
        {
          kind: 'request',
          eventId: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          expectedVersion: 0,
          taskId: plan.taskId,
          sourceAuthorId: author.sourceAuthorId,
          participationIds: plan.compute.evidence.participationIds,
          sourceRefs: author.sourceRefs,
          expiresAt: plan.expiresAt,
          purpose:
            'request-scoped-qualification-permission-only; no-permission-granted',
        },
        { viewers: [author.sourceAuthorId] },
      ),
    prepareResponse: (request, kind, extra = {}) =>
      journal.prepare(
        'qualification-request',
        {
          kind,
          eventId: crypto.randomUUID(),
          requestId: request.requestId,
          expectedVersion: request.version,
          ...extra,
        },
        { viewers: [request.candidateId, request.sourceAuthorId] },
      ),
    preparePermission: (request) => {
      if (
        request.role !== 'source-author' ||
        request.state !== 'pending' ||
        !request.grant
      )
        throw Error('当前没有可授予的本人来源许可。');
      return journal.prepare(
        'qualification-grant',
        { ...request.grant, id: crypto.randomUUID() },
        { viewers: [request.candidateId, request.recipientId] },
      );
    },
    prepareCompute: (plan) => {
      if (!plan.ready) throw Error('请先收集每位来源作者的限定许可。');
      return journal.prepare(
        'qualification-grant',
        { ...plan.compute, id: crypto.randomUUID() },
        { viewers: [plan.recipientId] },
      );
    },
    prepareRevoke: (grant, reason) => {
      if (!grant.payload) throw Error('原许可意图当前不可读取。');
      return journal.prepare(
        'qualification-grant',
        { id: crypto.randomUUID(), kind: 'revoke', grantId: grant.id, reason },
        {
          grantKind: grant.payload.kind,
          viewers: [grant.payload.candidateId, grant.payload.recipientId],
        },
      );
    },
  };
}
