import { createTaskMaterialClient } from "../../features/tasks/materials/task-material-client.mjs";
import { hasTaskMaterials } from '../../../../galaxy-official/src/shared/task-material-v1-schema.mjs';

// Material verification preserves the original publication slot and erased IDs.
export function createPublicationMaterials({ api, prefix, store, taskDraftScope, receiptStatus, now, taskAwait, checkOperationLease, sameTaskOperation, captureTaskDraftLease }) {
  function materialClientFor(lease) {
    return createTaskMaterialClient({ api, taskDraftScope, receiptStatus }, { subjectId: lease.subjectId, now });
  }
  async function currentPublicationMaterials(record, lease, { rebuild = false, requireAvailable = false } = {}) {
    if (!record || !hasTaskMaterials(record.payload)) return record;
    checkOperationLease(lease);
    const client = materialClientFor(lease), key = prefix + lease.subjectId + ':task-publication';
    try {
      const result = await taskAwait(lease, () => client.verifySubmission(record.payload, record.materialBodies ?? [], { rebuild }));
      let current = record;
      if (result.changed || result.erased.length) {
        if (typeof store.update !== 'function') throw new Error('local_atomic_update_unavailable');
        current = await taskAwait(lease, () => store.update(key, previous => {
          checkOperationLease(lease);
          if (!sameTaskOperation(previous, record)) throw new Error('原发布队列已变化，请重新核对。');
          const erased = [...new Set([...(previous.materialErasedIds ?? []), ...result.erased])];
          const bodies = (previous.materialBodies ?? []).filter(body => !erased.includes(body.materialId));
          for (const body of result.value.materialBodies) if (!erased.includes(body.materialId) && !bodies.some(item => item.materialId === body.materialId)) bodies.push(body);
          const next = { ...previous, materialBodies: bodies, materialErasedIds: erased };
          if (next.submission?.materialBodies) { next.submission = { ...next.submission }; delete next.submission.materialBodies; }
          return next;
        }));
      }
      if (requireAvailable && (!result.allowed || (current.materialErasedIds ?? []).some(id => record.payload.materials.some(material => material.materialId === id))))
        throw Object.assign(new Error('原发布材料当前不可用或编辑文字已清理。可以继续查询原回执，或明确停止本机重试；不会替换原内容、编号或期限。'), { code: 'task_material_unavailable' });
      return { ...current, materialBodies: result.view.materialBodies.filter(body => !(current.materialErasedIds ?? []).includes(body.materialId)), materialStates: result.states };
    } finally { client.close(); }
  }
  async function readTaskPublication(originalSubjectId) {
    const lease = captureTaskDraftLease(), owner = originalSubjectId ?? lease.subjectId ?? 'visitor';
    if (owner !== (lease.subjectId ?? 'visitor')) throw new Error('本机发布记录不属于当前身份。');
    const record = await taskAwait(lease, () => store.get(prefix + owner + ':task-publication'));
    return currentPublicationMaterials(record, lease);
  }
  return { materialClientFor, currentPublicationMaterials, readTaskPublication };
}
