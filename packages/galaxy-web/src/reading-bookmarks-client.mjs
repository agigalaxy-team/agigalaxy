import * as z from 'zod/v4';
import {sha256Hex, equalJson} from '../../galaxy-official/src/shared/web-primitives.mjs';
import {readingBookmarkReferenceSchema, readingBookmarkCommandSchema, readingBookmarkStateSchema,
  readingBookmarkReceiptReplySchema, readingBookmarksPageSchema, readingBookmarkKey} from '../../galaxy-official/src/shared/reading-bookmarks-v1-schema.mjs';

/** @typedef {import('zod/v4').infer<typeof readingBookmarkReferenceSchema>} ReadingBookmarkReference */
/** @typedef {Pick<Awaited<ReturnType<typeof import('./runtime.mjs').createWebRuntime>>, 'api'|'receiptStatus'|'getLocal'|'updateLocal'>} ReadingBookmarksRuntime */
/** @typedef {ReturnType<ReadingBookmarksRuntime['receiptStatus']['captureLease']>} ReadingBookmarkLease */
const journalSchema = z.strictObject({operations: z.record(z.string(), z.strictObject({
  command: readingBookmarkCommandSchema, payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  bindingId: z.string(), generation: z.number(), blockedReason: z.string().optional(),
}))});
const failure = (code, message) => Object.assign(new Error(message), {code});
const prefix = '/v2/reading-bookmarks/';

/** @param {ReadingBookmarksRuntime} runtime
 * @param {{subjectId?:string|null, locks?:Pick<LockManager,'request'>|null}} options */
export function createReadingBookmarksClient(runtime, {subjectId = null, locks = globalThis.navigator?.locks ?? null} = {}) {
  const endpoint = runtime.api.endpoint, ownerId = subjectId ?? runtime.api.snapshot()?.subjectId;
  const journalKey = 'reading-bookmarks-v1:' + endpoint;
  let queue = Promise.resolve();
  function capture() {
    const lease = runtime.receiptStatus.captureLease();
    if (!ownerId || lease.subjectId !== ownerId || lease.endpoint !== endpoint) throw failure('reading_bookmark_identity_changed', '身份或连接已变化，请重新打开收藏。');
    lease.assertCurrent(); return lease;
  }
  /** @template T @param {ReadingBookmarkLease} lease @param {()=>Promise<T>} fn @returns {Promise<T>} */
  async function guard(lease, fn) {
    lease.assertCurrent();
    let result; try {result = await fn();} catch (caught) {lease.assertCurrent(); throw caught;}
    lease.assertCurrent(); return result;
  }
  const read = (lease, path, input) => guard(lease, () => runtime.api.call(prefix + path, input, {authenticated: true}));
  /** @template T @param {(lease:ReadingBookmarkLease)=>Promise<T>} action @returns {Promise<T>} */
  const serial = action => {
    const lease = capture(), invoke = () => guard(lease, () => action(lease));
    const run = () => locks ? locks.request('reading-bookmarks:' + endpoint + ':' + ownerId, {mode: 'exclusive'}, invoke) : invoke();
    const next = queue.then(run, run); queue = next.then(() => {}, () => {}); return next;
  };
  async function load(lease) {
    const raw = await guard(lease, () => runtime.getLocal(journalKey, ownerId));
    return journalSchema.parse(raw ?? {operations: {}});
  }
  function update(lease, action) {
    return guard(lease, () => runtime.updateLocal(journalKey, raw => {
      lease.assertCurrent(); return action(journalSchema.parse(raw ?? {operations: {}}));
    }, ownerId));
  }
  async function exact(record) {
    if (await sha256Hex(JSON.stringify(record.command)) !== record.payloadHash) throw failure('reading_bookmark_original_changed', '原收藏操作内容已变化，已停止发送。');
  }
  async function receipt(lease, record) {
    await guard(lease, () => exact(record));
    const value = readingBookmarkReceiptReplySchema.parse(await read(lease, 'receipt', {operationId: record.command.operationId, payloadHash: record.payloadHash}));
    if (value.operationId !== record.command.operationId || value.payloadHash !== record.payloadHash
      || value.state === 'acknowledged' && !equalJson(value.bookmark.reference, record.command.reference))
      throw failure('reading_bookmark_receipt_mismatch', '刚才的收藏结果尚未确认。');
    return value;
  }
  async function settle(lease, key, record, ack) {
    await update(lease, journal => {
      const current = journal.operations[key];
      if (current?.command.operationId !== record.command.operationId || current.payloadHash !== record.payloadHash) return journal;
      const operations = {...journal.operations}; delete operations[key]; return {operations};
    });
    return ack;
  }
  async function block(lease, key, record, reason) {
    await update(lease, journal => {
      const current = journal.operations[key];
      if (current?.command.operationId !== record.command.operationId || current.payloadHash !== record.payloadHash || current.blockedReason === reason) return journal;
      return {operations: {...journal.operations, [key]: {...current, blockedReason: reason}}};
    });
    return {state: 'pending', reason, reference: record.command.reference};
  }
  const rejected = caught => caught && typeof caught === 'object' && caught.outcome === 'rejected'
    && ['reading_bookmark_changed', 'reading_bookmark_operation_conflict', 'reading_bookmark_source_unavailable', 'invalid_reading_bookmark_request'].includes(caught.code);
  async function continueRecord(lease, key, record, explicitRetry = false) {
    const acknowledged = await receipt(lease, record);
    if (acknowledged.state === 'acknowledged') return settle(lease, key, record, acknowledged);
    if (record.blockedReason && !explicitRetry) return {state: 'pending', reason: record.blockedReason, reference: record.command.reference};
    if (record.bindingId !== lease.bindingId || record.generation !== lease.generation) {
      if (!explicitRetry) return block(lease, key, record, 'connection-changed');
    }
    try {
      const value = readingBookmarkReceiptReplySchema.parse(await read(lease, 'command', record.command));
      if (value.state !== 'acknowledged' || value.operationId !== record.command.operationId || value.payloadHash !== record.payloadHash
        || !equalJson(value.bookmark.reference, record.command.reference)) throw failure('reading_bookmark_receipt_mismatch', '刚才的收藏结果尚未确认。');
      return settle(lease, key, record, value);
    } catch (caught) {
      // Explicit business rejection is final for these original bytes; polling
      // reads the receipt, never repeats that rejected write automatically.
      if (rejected(caught)) return block(lease, key, record, caught.code);
      throw caught;
    }
  }
  return {
    ownerId, endpoint,
    current() {capture();},
    async status(reference) {
      const selected = readingBookmarkReferenceSchema.parse(reference), lease = capture();
      const value = readingBookmarkStateSchema.parse(await read(lease, 'status', {reference: selected}));
      if (!equalJson(value.reference, selected)) throw failure('reading_bookmark_receipt_mismatch', '收藏对象尚未确认。');
      return value;
    },
    async query(input = {}) {
      const lease = capture(), page = readingBookmarksPageSchema.parse(await read(lease, 'query', input));
      return page;
    },
    pending() {return serial(async lease => Object.values((await load(lease)).operations));},
    /** @param {ReadingBookmarkReference|null} [reference] */
    async resumePending(reference = null) {
      const key = reference ? readingBookmarkKey(reference) : null;
      return serial(async lease => {
        const journal = await load(lease), items = [];
        for (const [selectedKey, record] of Object.entries(journal.operations)) if (!key || selectedKey === key) {
          try {items.push(await continueRecord(lease, selectedKey, record));}
          catch {lease.assertCurrent(); items.push({state: 'pending', reason: 'temporarily-unavailable', reference: record.command.reference});}
        }
        return {items};
      });
    },
    setSaved(reference, saved) {
      const selected = readingBookmarkReferenceSchema.parse(reference), key = readingBookmarkKey(selected);
      return serial(async lease => {
        const journal = await load(lease), original = journal.operations[key];
        if (original) {
          const result = await continueRecord(lease, key, original);
          if (result.state === 'pending') throw failure('reading_bookmark_pending', '正在核对刚才的收藏，本次选择仍保留。');
          if (original.command.saved === saved) return result;
        }
        const previous = readingBookmarkStateSchema.parse(await read(lease, 'status', {reference: selected}));
        if (!equalJson(previous.reference, selected)) throw failure('reading_bookmark_receipt_mismatch', '收藏对象尚未确认。');
        const command = readingBookmarkCommandSchema.parse({operationId: crypto.randomUUID(), reference: selected, saved, expectedRevision: previous.revision});
        const record = {command, payloadHash: await guard(lease, () => sha256Hex(JSON.stringify(command))), bindingId: lease.bindingId, generation: lease.generation};
        await update(lease, current => {
          if (current.operations[key]) throw failure('reading_bookmark_pending', '另一页正在核对这项收藏，本次选择尚未发送。');
          return {operations: {...current.operations, [key]: record}};
        });
        return continueRecord(lease, key, record);
      });
    },
    retry(reference) {
      const key = readingBookmarkKey(reference);
      return serial(async lease => {
        const record = (await load(lease)).operations[key];
        if (!record) return null;
        if (record.blockedReason && record.blockedReason !== 'connection-changed') {
          const result = await receipt(lease, record);
          if (result.state === 'acknowledged') return settle(lease, key, record, result);
          // A definite rejected operation has no unknown business outcome.
          // Clear only this exact local locator so a new explicit click can
          // use the current object revision; never alter its stored bytes.
          await settle(lease, key, record, result); return result;
        }
        return continueRecord(lease, key, record, true);
      });
    },
  };
}
