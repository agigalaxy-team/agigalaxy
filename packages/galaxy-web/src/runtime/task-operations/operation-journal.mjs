import { hasTaskMaterials, taskMaterialSubmissionSchema } from '../../../../galaxy-contracts/src/task-material-v1-schema.mjs';

// One per-runtime queue owns local journal updates and business dispatch state.
// Receipt reconciliation, identity leases and user decisions stay with the caller.
export function createTaskOperationJournal({ api, store, now, taskAwait, checkOperationLease, currentPublicationMaterials }) {
  let taskQueueTail = Promise.resolve();
  const withTaskQueue = fn => { const operation = taskQueueTail.then(fn); taskQueueTail = operation.catch(() => {}); return operation; };
  const sameTaskOperation = (left, right) => left && right && left.payloadHash === right.payloadHash
    && (left.eventId ?? left.payload?.operationId) === (right.eventId ?? right.payload?.operationId);
  function preserveTaskQueue(current,next) {
    if(next===null)return null;
    const value=structuredClone(next),erased=[...new Set([...(current.materialErasedIds??[]),...(value.materialErasedIds??[])])];
    if(erased.length){value.materialErasedIds=erased;value.materialBodies=(value.materialBodies??[]).filter(body=>!erased.includes(body.materialId));}
    if(current.automaticRetryBlock)value.automaticRetryBlock=current.automaticRetryBlock;
    return value;
  }
  async function updateTaskQueue(key, operation, next, lease = null) {
    return withTaskQueue(async () => {
      if(typeof store.update==='function'){
        let matched=false;
        const update=()=>store.update(key,current=>{
          if(lease)checkOperationLease(lease);
          if(!sameTaskOperation(current,operation)){
            if(next===null)return current;
            throw new Error('原操作已停止本机重试或队列已改变；不会重新放回发送队列。');
          }
          matched=true;return preserveTaskQueue(current,next);
        });
        if(lease)await taskAwait(lease,update);else await update();return matched;
      }
      const current = lease ? await taskAwait(lease, () => store.get(key)) : await store.get(key);
      if (!sameTaskOperation(current, operation)) {
        if (next === null) return false;
        throw new Error('原操作已停止本机重试或队列已改变；不会重新放回发送队列。');
      }
      const preserved = preserveTaskQueue(current,next);
      if (lease) await taskAwait(lease, () => store.put(key, preserved)); else await store.put(key, preserved);
      return true;
    });
  }
  function taskBusinessRejected(record) {
    const publication = !!record.payload, block = record.automaticRetryBlock;
    return Object.assign(new Error('服务未接受上次内容，已停止自动发送。原内容仍保留。'), {
      code: publication ? 'publication_business_rejected' : 'task_operation_business_rejected',
      reason: block.code, status: block.status, rejectedAt: block.rejectedAt,
      ...(block.retryAt ? { retryAt: block.retryAt } : {}),
    });
  }
  const isTaskBusinessRejection = error => error?.outcome === 'rejected'
    && Number.isInteger(error.status) && error.status >= 400 && error.status < 500
    && ![401, 408, 429].includes(error.status)
    && !['unauthorized', 'binding_revoked', 'invalid_session', 'session_expired', 'access_denied'].includes(error.code);
  async function changeTaskDispatch(key, record, lease, change) {
    return withTaskQueue(async () => {
      const update = current => {
        checkOperationLease(lease);
        if (!sameTaskOperation(current, record)) throw new Error('原操作已停止本机重试或队列已改变；不会重新放回发送队列。');
        return change(current);
      };
      if (typeof store.update === 'function') return taskAwait(lease, () => store.update(key, update));
      const current = await taskAwait(lease, () => store.get(key)), next = update(current);
      await taskAwait(lease, () => store.put(key, next)); return next;
    });
  }
  async function dispatchTaskBusiness(key, record, lease, path, { explicitRetry = false } = {}) {
    // Check the persisted slot at the send boundary too: another page may have
    // received a definite rejection after this page read the original journal.
    const sending = await changeTaskDispatch(key, record, lease, current => {
      if (current.automaticRetryBlock && (!explicitRetry
        || current.automaticRetryBlock.retryAt && Date.parse(current.automaticRetryBlock.retryAt) > now() * 1000))
        throw taskBusinessRejected(current);
      const next = { ...current, state: 'result-unknown' }; delete next.automaticRetryBlock; return next;
    });
    try {
      const current=sending.payload&&hasTaskMaterials(sending.payload)?await currentPublicationMaterials(sending,lease,{rebuild:true,requireAvailable:true}):sending;
      const submission=current.payload&&hasTaskMaterials(current.payload)?taskMaterialSubmissionSchema.parse({...current.submission,materialBodies:current.materialBodies}):current.submission;
      return await taskAwait(lease, () => api.call(path, submission));
    }
    catch (error) {
      // HTTP 5xx, timeouts and network failures cannot prove non-acceptance.
      // They keep the existing unknown-result automatic continuation.
      if (isTaskBusinessRejection(error)) await changeTaskDispatch(key, sending, lease, current => ({ ...current,
        state: 'business-rejected', automaticRetryBlock: {
          code: error.code, status: error.status, rejectedAt: now(),
          ...(typeof error.retryAt === 'string' && Number.isFinite(Date.parse(error.retryAt)) ? { retryAt: error.retryAt } : {}),
        },
      }));
      throw error;
    }
  }
  const continuedTaskReceipt = (receipt, payloadHash) => ({ ...receipt,
    ...(receipt.state && receipt.state !== 'acknowledged' ? { businessState: receipt.state } : {}),
    ...(payloadHash ? { payloadHash } : {}), state: 'acknowledged' });
  const minimalTaskReceipt = receipt => ({ state: receipt.state, checkedAt: receipt.checkedAt ?? now(),
    ...(Number.isSafeInteger(receipt.version) ? { version: receipt.version } : {}),
    ...(Number.isSafeInteger(receipt.participationVersion) ? { participationVersion: receipt.participationVersion } : {}) });
  return { withTaskQueue, sameTaskOperation, updateTaskQueue, taskBusinessRejected, dispatchTaskBusiness, continuedTaskReceipt, minimalTaskReceipt };
}
