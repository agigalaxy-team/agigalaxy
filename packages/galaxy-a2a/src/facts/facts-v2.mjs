import * as z from 'zod/v4';
import { isDeepStrictEqual } from 'node:util';
import { caseEventV2Schema } from '../../../galaxy-official/src/shared/cases-schema.mjs';
import { terminal } from './mapping.mjs';

const ref = z.strictObject({ id: z.uuid(), version: z.number().int().positive() });
const selection = z.strictObject({ attemptVersion: z.number().int().positive(), taskId: z.uuid().optional(),
  interventionRef: ref.optional() });
const requireFact = (yes, reason) => { if (!yes) throw new Error(`A2A v2 ${reason}.`); };

/** Authenticated projections, never raw DB rows or legacy events dressed as v2. */
export function createA2aFactsV2({ readCase, readTask }) {
  return Object.freeze({ async resolve({ caseId, attemptId, subjectId, selected, frozen, signal }) {
    const input = frozen ? { attemptVersion: frozen.attemptRef.version,
      ...(frozen.taskId ? { taskId: frozen.taskId } : {}),
      ...(frozen.origin.kind === 'intervention' ? { interventionRef: { id: frozen.origin.id, version: frozen.origin.version } } : {}) }
      : selection.parse(selected);
    const current = await readCase(caseId, { ...(input.taskId ? { taskId: input.taskId } : {}), signal });
    requireFact(current?.caseId === caseId && Number.isSafeInteger(current.version), 'Case unavailable');
    const attempt = current.attempts?.filter(a => a.id === attemptId).at(-1);
    requireFact(attempt?.version === input.attemptVersion && attempt.actorId === subjectId
      && attempt.provenance === 'native-v2' && attempt.scopeVersion === current.scopeVersion, 'Attempt version, scope or actor changed');
    requireFact((attempt.taskId ?? null) === (input.taskId ?? null), 'explicit Task association required');
    let origin = attempt, kind = 'attempt';
    if (input.interventionRef) {
      kind = 'intervention'; origin = current.interventions?.filter(i => i.id === input.interventionRef.id).at(-1);
      requireFact(origin?.version === input.interventionRef.version && origin.actorId === subjectId
        && origin.affectsAttemptIds?.includes(attemptId), 'selected Intervention must currently affect this Attempt');
    }
    requireFact(origin.scopeVersion === attempt.scopeVersion && (origin.taskId ?? null) === (attempt.taskId ?? null)
      && (origin.participationId ?? null) === (attempt.participationId ?? null), 'origin association mismatch');
    const context = { version: 2, attemptRef: { id: attempt.id, version: attempt.version },
      origin: { kind, id: origin.id, version: origin.version }, taskId: attempt.taskId ?? null,
      participationId: attempt.participationId ?? null, scopeVersion: attempt.scopeVersion,
      participationScopeVersion: attempt.participationScopeVersion ?? null };
    if (context.taskId) {
      requireFact(typeof readTask === 'function', 'Task reader required');
      const task = await readTask(context.taskId, { signal });
      requireFact(task?.taskId === context.taskId && task.caseId === caseId
        && !task.paused && !['canceled', 'closed'].includes(task.state), 'Task unavailable');
      if (context.participationId) {
        const p = task.participations?.find(p => p.participationId === context.participationId);
        requireFact(p?.subjectId === subjectId && p.scopeAvailable !== false && p.scopeVersion === context.participationScopeVersion
          && ['active', 'delivered', 'accepted', 'disputed'].includes(p.state), 'Participation unavailable');
      } else requireFact(task.requesterId === subjectId, 'requester or explicit Participation required');
    }
    if (frozen) requireFact(isDeepStrictEqual(context, frozen), 'frozen fact association changed');
    return { current, factContext: context };
  } });
}

export function resultDraftV2(link, scope, current, { summary, reportedOutcome, limitations = '' }, eventId) {
  requireFact(terminal(link.peer?.state), 'terminal peer observation required');
  z.string().trim().min(1).max(1200).parse(summary);
  z.string().max(600).parse(limitations);
  // Outcome is selected by the user/host. Protocol COMPLETED alone does not say
  // whether the user's original problem was solved, even by self-report.
  z.enum(['succeeded', 'partial', 'failed', 'inconclusive', 'conflicting']).parse(reportedOutcome);
  requireFact(link.peer.state === 'completed' || !['succeeded', 'partial'].includes(reportedOutcome), 'peer state cannot support a success report');
  const c = link.factContext;
  return caseEventV2Schema.parse({ schemaVersion: 2, kind: 'result-recorded', eventId,
    caseId: link.caseId, expectedVersion: current.version, actorId: scope.subjectId,
    ...(c.taskId ? { taskId: c.taskId, taskScopeVersion: c.scopeVersion } : {}),
    ...(c.participationId ? { participationId: c.participationId, participationScopeVersion: c.participationScopeVersion } : {}),
    origin: c.origin, scopeVersion: c.scopeVersion, deliverableRefs: [], reportedOutcome, summary,
    limitations: `External A2A participant report; no independent Verification, acceptance or Resolution. Association ${link.id}; response SHA256 ${link.peer.responseHash}; artifacts remain selected summaries/hashes in the private local journal. ${limitations}`.trim() });
}
