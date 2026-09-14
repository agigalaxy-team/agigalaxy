import { ServiceError } from '../shared/service-error.mjs';
import { exportViewScopes } from '../shared/data-export-schema.mjs';

// All readers operate inside the export's existing authorized transaction.
// No recursive request, nested transaction, new visibility rule or raw table copy.
export async function readExportView(services, db, actor, selection, authorization, now, readKind='export') {
  const scope = exportViewScopes[selection.kind];
  if (!authorization.credentialScopes.includes(scope)) throw new ServiceError('export_view_scope_required', 403);
  let view;
  try {
    switch (selection.kind) {
      case 'choice-snapshot':view=await services.choices.getWithin(db,actor,selection.id);break;
      case 'recruitment': view = await services.recruitment.readWithin(db, actor, selection.id); break;
      case 'project': view = await services.projects.readWithin(db, actor, selection.id); break;
      case 'contact': view = await services.contacts.readWithin(db, actor, selection.id); break;
      case 'personal-summary': view = await services.summaries.getWithin(db, actor, selection.id); break;
      case 'task': view = await services.assistance.readTaskWithin(db, actor, selection.id); break;
      case 'case':
        if(selection.taskId&&!authorization.credentialScopes.includes('assistance'))throw new ServiceError('export_view_scope_required',403);
        view = await services.cases.readV2Within(db, actor, selection.id, { taskId: selection.taskId ?? null }); break;
      case 'evidence': case 'verification': view = await services.verificationRecords.readWithin(db, actor,
        { type: selection.kind, id: selection.id, ...(selection.version ? { version: selection.version } : {}) }); break;
      case 'assistance': view = await services.assistance.readWithin(db, actor, selection.id); break;
      case 'context': view = await services.context.readWithin(db, actor, selection.id, true, authorization, readKind); break;
      case 'proof': view = await services.proofs.readWithin(db, actor, selection.id); break;
      case 'capsule': view = await services.capsules.readWithin(db, actor, { capsuleId: selection.id, ...(selection.versionId ? { versionId: selection.versionId } : {}) }); break;
      case 'builder': view = await services.builders.readWithin(db, actor, { builderId: selection.id }); break;
      case 'builder-support': view = await services.builders.v2.readWithin(db, actor, { builderId: selection.id }); break;
      case 'moderation': view = await services.moderation.readWithin(db, actor, selection.id); break;
      default: throw new ServiceError('invalid_export_view');
    }
  } catch (error) {
    if (error instanceof ServiceError && [401, 403, 404, 409].includes(error.status)) throw new ServiceError('export_view_unavailable', 403);
    throw error;
  }
  return { selection, scope, checkedAt: now, authority: 'current-read-access-only; no republishing or continuing authorization', view };
}
