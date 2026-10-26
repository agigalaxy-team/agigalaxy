export const capsuleRefKey = (ref) =>
  `${ref.kind ?? ref.type}:${ref.id}:${ref.version}`;
/**
 * @template {{id:string,version:number,supersededInVisibleHistory?:boolean}} T
 * @param {T[]} [items]
 * @returns {T[]}
 */
export function currentCapsuleFacts(items = []) {
  const byId = new Map();
  for (const item of items)
    if (!byId.has(item.id) || byId.get(item.id).version < item.version)
      byId.set(item.id, item);
  return [...byId.values()].filter((item) => !item.supersededInVisibleHistory);
}
/**
 * @param {import('./capsule-authoring-types').CapsuleCaseHistory} history
 * @returns {import('./capsule-authoring-types').CapsuleSourceItem[]}
 */
export function capsuleCaseSources(history) {
  const caseId = history.caseId,
    root = history.events?.find((e) =>
      ['case', 'case-created'].includes(e.payload.kind),
    ),
    sources = [];
  if (root)
    sources.push({
      ref: { kind: 'case-root', id: root.eventId, version: 1, caseId },
      authorId: root.reportedBy,
      label: history.title ?? '工作背景',
    });
  for (const [field, kind] of [
    ['attempts', 'attempt'],
    ['interventions', 'intervention'],
    ['results', 'result'],
  ])
    for (const fact of currentCapsuleFacts(history[field] ?? []))
      sources.push({
        ref: { kind, id: fact.id, version: fact.version, caseId },
        authorId: fact.actorId === 'unknown' ? fact.reportedBy : fact.actorId,
        label: fact.summary ?? fact.description ?? fact.strategy ?? kind,
        fact,
      });
  for (const view of history.verificationRecords ?? [])
    if (view.referenceStatus === 'current' && view.record)
      sources.push({
        ref: { kind: view.type, id: view.id, version: view.version, caseId },
        authorId: view.record.reportedBy,
        label: view.record.summary,
        view,
      });
  return sources;
}
