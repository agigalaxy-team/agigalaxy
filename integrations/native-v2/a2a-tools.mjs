import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { nativeResult } from '../../packages/galaxy-edge-mcp/src/native-v2/choice.mjs';
import { consentSchema } from '../../packages/galaxy-official/src/shared/consents-schema.mjs';

const peerId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), id = z.uuid();
export const a2aPrepareSchema = z.discriminatedUnion('action', [
  z.strictObject({ peerId, action: z.literal('send'), caseId: id, attemptId: id, attemptVersion: z.number().int().positive(),
    taskId: id.optional(), interventionRef: z.strictObject({ id, version: z.number().int().positive() }).optional(), text: z.string().min(1).max(12000) }),
  z.strictObject({ peerId, action: z.literal('reply'), associationId: id, text: z.string().min(1).max(12000) }),
  z.strictObject({ peerId, action: z.literal('cancel'), associationId: id }),
  z.strictObject({ peerId, action: z.literal('result'), associationId: id, summary: z.string().min(1).max(1200),
    reportedOutcome: z.enum(['succeeded', 'partial', 'failed', 'inconclusive', 'conflicting']), limitations: z.string().max(600).default(''),
    visibility: consentSchema.shape.visibility.default('Private'), viewers: consentSchema.shape.viewers.default([]), expiresAt: z.number().int().positive().optional() }),
]);

// Called only by a host with explicit configured peers. The already established
// native choice object handles a real user surface; a model-provided boolean is
// deliberately not an input. Queries/polls never request another approval.
export function registerNativeA2aTools(server, { host, runtime, review, now = () => Date.now() }) {
  if (typeof review !== 'function') throw new Error('Native user-choice adapter required.');
  const operations = new Map();
  const output = async fn => { try { return nativeResult(await fn()); } catch (error) {
    return { isError: true, ...nativeResult({ error: error.code ?? 'a2a_operation_incomplete', reason: error.message,
      ...(error.associationId ? { associationId: error.associationId } : {}), originalOperationRetained: true }) }; } };
  const prune = () => { for (const [id, op] of operations) if (op.expires <= now()) operations.delete(id); };
  server.registerTool('galaxy_a2a_peers', { inputSchema: z.strictObject({}), description: 'List only explicitly configured A2A 1.0 peers; no discovery enrollment or model calls.', annotations: { readOnlyHint: true } }, () => output(() => host.peers()));
  server.registerTool('galaxy_a2a_read', { inputSchema: z.strictObject({ peerId, action: z.enum(['list', 'get', 'poll', 'reconcile-result']), associationId: id.optional() }),
    description: 'Read scoped journal, poll a known peer Task, or reconcile original Result. Unknown initial ACK cannot be resent. Poll never means cancel.', annotations: { readOnlyHint: true } },
    input => output(() => { if (input.action !== 'list' && !input.associationId) throw new Error('Association ID required.'); return host.read(input.peerId, input.action, input.associationId); }));
  server.registerTool('galaxy_a2a_prepare', { inputSchema: a2aPrepareSchema,
    description: 'Prepare a locally persisted association or exact v2 Result draft from an existing current Attempt. Only selected text goes to peer; no cloud write occurs yet.', annotations: { readOnlyHint: false } },
    input => output(async () => {
      prune(); if (operations.size >= 128) throw new Error('Inspect or cancel pending A2A previews first.');
      const { peerId, action, ...selected } = input, preview = await host.prepare(peerId, action, selected);
      if (preview.state === 'acknowledged') return preview;
      const operationId = preview.kind === 'result' ? preview.draft.event.eventId : preview.operationId ?? randomUUID();
      operations.set(operationId, { peerId, action, preview, subjectId: (await runtime.status()).identity, expires: now() + 300000, state: 'prepared' });
      return { operationId, preview, state: 'local-preview', remoteSubmitted: false };
    }));
  server.registerTool('galaxy_a2a_execute', { inputSchema: z.strictObject({ operationId: id }),
    description: 'Execute the exact prepared external scope using the host user-choice surface. Same-operation retries inspect the original association instead of sending again.', annotations: { readOnlyHint: false } },
    async (input, ctx) => { try {
      prune(); const op = operations.get(input.operationId);
      if (!op || op.subjectId !== (await runtime.status()).identity) throw new Error('Preview expired or identity changed; read the retained association.');
      if (op.state === 'running') return nativeResult({ state: 'in-progress', operationId: input.operationId });
      if (op.state !== 'prepared') return nativeResult({ state: op.state, association: await host.read(op.peerId, 'get', op.preview.associationId), remoteResent: false });
      return await review('galaxy_a2a_execute', { operationId: input.operationId, preview: op.preview }, ctx, async () => {
        if (op.state !== 'prepared') return { state: op.state, remoteResent: false };
        op.state = 'running';
        try { const result = await host.execute(op.preview, { confirmed: true }); op.state = 'completed'; return result; }
        catch (error) { op.state = 'original-operation-needs-reconciliation'; throw error; }
      });
    } catch (error) { return output(() => { throw error; }); } });
  server.registerTool('galaxy_a2a_abort_local', { inputSchema: z.strictObject({ operationId: id }),
    description: 'Stop this local preview or in-flight transport; does not claim peer cancellation or remove unknown operations.', annotations: { readOnlyHint: false } },
    input => output(() => { const op = operations.get(input.operationId); if (!op) throw new Error('Preview not found; durable association remains.');
      const result = host.abort(op.preview); op.state = 'locally-stopped'; return result; }));
  return { close: () => { for (const op of operations.values()) { try { host.abort(op.preview); } catch { /* finished */ } } operations.clear(); } };
}
