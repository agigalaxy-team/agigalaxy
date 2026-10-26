import * as z from 'zod/v4';

const draftValueSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
  kind: z.enum(['create', 'edit', 'correct', 'retract', 'report', 'supplement', 'appeal', 'withdraw-report', 'pause', 'resolve', 'resume']),
  text: z.string().max(6000),
  reason: z.string().max(600).default(''),
  audience: z.array(z.string().min(1).max(80)).default([]),
  category: z.enum(['advertising', 'harassment', 'privacy', 'review-request', 'other']).default('advertising'),
  verdict: z.enum(['upheld', 'dismissed']).default('dismissed'),
  disposition: z.enum(['unchanged', 'approve', 'reject']).default('unchanged'),
  rule: z.string().max(120).default('comment-rules/1'),
  pauseMinutes: z.number().default(60),
  commentRef: z.strictObject({commentId: z.uuid(), revision: z.number().int().positive()}).nullable().default(null),
  reportRef: z.strictObject({id: z.uuid(), version: z.number().int().positive()}).nullable().default(null),
  operationId: z.uuid().optional(),
});
const draftReferenceSchema = z.strictObject({id: z.uuid(), revision: z.number().int().positive()});
const draftRecordSchema = z.strictObject({
  version: z.literal(1), endpoint: z.string(), subjectId: z.string(), taskId: z.uuid(), draft: draftValueSchema,
});
// Shared only within the same runtime/API. The queue retains no draft body;
// independent tabs still compare their original head in the IDB transaction.
const draftQueues = new WeakMap();
// A draft owns editing heads only; operation reconciliation uses the caller's journal.
export function createCommentEditorDraft({ api, endpoint, subjectId, taskId, getLocal, updateLocal, captureLease, load, query }) {
  const draftKey = `comment-editor-draft:${endpoint}:${subjectId}:${taskId}`;
  if (!draftQueues.has(api)) draftQueues.set(api, new Map());
  const draftQueue = draftQueues.get(api);
  let draftLoaded = false, draftHead = null, lastDraftSave = null;
  const observedDrafts = new Set();
  const draftError = (code, message) => Object.assign(new Error(message), {code});
  const draftToken = value => value ? {id: value.id, revision: value.revision} : null;
  const sameDraft = (left, right) => left === null && right === null || left?.id === right?.id && left?.revision === right?.revision;
  const observedToken = value => `${value.id}:${value.revision}`;
  const observeDraft = value => {if (value) observedDrafts.add(observedToken(value));};
  function readDraftRecord(row) {
    if (row == null) return null;
    const parsed = draftRecordSchema.parse(row);
    if (parsed.endpoint !== endpoint || parsed.subjectId !== subjectId || parsed.taskId !== taskId)
      throw draftError('comment_draft_owner_changed', '本机编辑稿不属于当前身份、站点或任务。');
    return parsed;
  }
  function serialDraft(action) {
    const lease = captureLease(), invoke = () => {lease.check(); return action(lease);};
    const run = (draftQueue.get(draftKey) ?? Promise.resolve()).then(invoke, invoke);
    const tail = run.then(() => {}, () => {});
    draftQueue.set(draftKey, tail);
    void tail.then(() => {if (draftQueue.get(draftKey) === tail) draftQueue.delete(draftKey);});
    return run;
  }
  function updateDraft(lease, updater) {
    if (typeof updateLocal !== 'function')
      throw draftError('local_atomic_update_unavailable', '本机存储不支持安全保存编辑稿，请保留文字后重新打开原任务。');
    return lease.wait(() => updateLocal(draftKey, row => {lease.check(); return updater(readDraftRecord(row));}, subjectId));
  }
  async function terminalOperation(operationId, lease) {
    lease.check();
    if (!operationId) return null;
    const journal = await load(lease);
    return journal.stopped.find(row => row.operationId === operationId
      && ['stopped-local', 'acknowledged'].includes(row.state)) ?? null;
  }
  const terminalDraftError = () => draftError('comment_draft_operation_terminal',
    '原操作已停止本机重试或已收到回执，不能再保存为待发送稿。请重新读取本机版本；服务端结果仍按原操作查询。');
  async function consumeTerminalDraft(record, lease) {
    const terminal = await terminalOperation(record?.draft.operationId, lease);
    lease.check();
    if (!terminal) return {record, terminal: null};
    const expected = draftToken(record.draft), operationId = record.draft.operationId;
    await updateDraft(lease, current => {
      if (current == null) return null;
      if (!sameDraft(draftToken(current.draft), expected) || current.draft.operationId !== operationId)
        throw draftError('comment_draft_changed', '原编辑稿已在另一页面更新，请重新读取后核对；本次没有覆盖它。');
      return null;
    });
    observeDraft(record.draft);
    return {record: null, terminal};
  }
  const draft = Object.freeze({
    load: () => {
      const originalSave = lastDraftSave;
      return serialDraft(async lease => {
        // A saved locator or editor body is not a current Task read permission.
        await query(lease, `/v2/tasks/${taskId}`, undefined, {method: 'GET'});
        const stored = readDraftRecord(await lease.wait(() => getLocal(draftKey, subjectId)));
        // Local stopping and server acknowledgement both retire only the draft
        // linked to that original operation. A receipt still describes the
        // service outcome; an absent receipt does not undo a durable local stop.
        const {record} = await consumeTerminalDraft(stored, lease);
        lease.check();
        draftHead = draftToken(record?.draft); draftLoaded = true;
        observeDraft(record?.draft);
        // An explicit fresh read resolves an earlier local save conflict. A
        // save queued after this read began still owns its result or failure.
        if (lastDraftSave === originalSave) lastDraftSave = null;
        return record?.draft ?? null;
      });
    },
    save: input => {
      const value = draftValueSchema.parse(input);
      const run = serialDraft(async lease => {
        if (!draftLoaded) throw draftError('comment_draft_not_loaded', '请先核对原任务和本机编辑稿，再保存本次修改。');
        if (await terminalOperation(value.operationId, lease)) throw terminalDraftError();
        const expected = draftHead;
        const stored = await updateDraft(lease, current => {
          if (!sameDraft(draftToken(current?.draft), expected))
            throw draftError('comment_draft_changed', '原编辑稿已在另一页面更新，请重新读取后核对；本次没有覆盖它。');
          if (current?.draft.id === value.id && value.revision <= current.draft.revision) {
            if (value.revision === current.draft.revision && JSON.stringify(value) === JSON.stringify(current.draft)) return current;
            throw draftError('comment_draft_revision_changed', '本次编辑版本已过期，请保留当前文字后重新核对。');
          }
          return {version: 1, endpoint, subjectId, taskId, draft: value};
        });
        // Another tab may commit its stop while this save waits for the local
        // transaction. Check again before returning any linked editor body.
        const {record, terminal} = await consumeTerminalDraft(stored, lease);
        lease.check();
        draftHead = draftToken(record?.draft);
        if (terminal) throw terminalDraftError();
        observeDraft(stored.draft);
        return structuredClone(stored.draft);
      });
      lastDraftSave = run;
      return run;
    },
    flush: () => {
      const original = lastDraftSave;
      return serialDraft(async lease => {if (original) await lease.wait(() => original);});
    },
    clear: input => {
      const expected = draftReferenceSchema.parse(input);
      return serialDraft(async lease => {
        let cleared = false;
        await updateDraft(lease, current => {
          if (current == null) {
            cleared = observedDrafts.has(observedToken(expected)); return null;
          }
          if (!sameDraft(draftToken(current?.draft), expected)) return current;
          cleared = true; return null;
        });
        if (cleared) {draftHead = null; draftLoaded = true;}
        return cleared;
      });
    },
  });
  return draft;
}
