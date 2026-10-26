const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @param {string} taskId @param {{pathname:string,search:string}} location */
export function selectedTaskMaterial(taskId, location) {
  if (location.pathname !== `/app/tasks/${taskId}`) return null;
  const query = new URLSearchParams(location.search), ids = query.getAll('material');
  return query.get('section') === 'collaboration' && query.get('view') === 'materials'
    && ids.length === 1 && uuid.test(ids[0]) ? ids[0] : null;
}

/** @param {string} taskId @param {string|null} grantId @param {{pathname:string,search:string,hash?:string}} location */
export function taskMaterialPath(taskId, grantId, location) {
  if (location.pathname !== `/app/tasks/${taskId}` || grantId !== null && !uuid.test(grantId)) return null;
  const query = new URLSearchParams(location.search);
  if (grantId === null) query.delete('material');
  else { query.set('section', 'collaboration'); query.set('view', 'materials'); query.set('material', grantId); }
  return location.pathname + (query.size ? '?' + query.toString() : '') + (location.hash ?? '');
}

/** @param {{metadata:Pick<import('../../work-records/record-workspace-types').ContextMetadata,'taskId'|'ownerId'|'participantId'>}} view @param {string} taskId @param {string|undefined} subjectId */
export function contextMaterialMatchesWork(view, taskId, subjectId) {
  return !!subjectId && view.metadata.taskId === taskId
    && [view.metadata.ownerId, view.metadata.participantId].includes(subjectId);
}
