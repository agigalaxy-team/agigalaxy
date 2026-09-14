import { exportCreateSchema, exportPageSchema, sameExportViews, exportViewScopes } from '../../galaxy-official/src/shared/data-export-schema.mjs';
import { deletionIntentSchema, deletionReadSchema, deletionQuerySchema, deletionStates, deletionStatusIntentSchema } from '../../galaxy-official/src/shared/deletion-schema.mjs';
import { sha256Hex, stableJson } from '../../galaxy-official/src/shared/web-primitives.mjs';

// Browser adapter over the existing export and signed deletion protocols.
// The local operation journal contains public payloads/signatures, never keys.
export function createPrivacyClient({ api, getLocal, putLocal, identity, sign, now = () => Math.floor(Date.now()/1000) }) {
  const endpoint = api.endpoint, previews = new WeakSet(); let writing = false;
  const actor = () => { const value = api.snapshot(); if (!value) throw new Error('connection_required'); return value; };
  const current = expected => { const value = actor(); if (value.subjectId !== expected.subjectId || value.bindingId !== expected.bindingId) throw new Error('数据操作的身份连接已改变，请重新读取。'); return value; };
  const request = (path, body, options) => api.call('/v1/' + path, body, options);
  const bound = (result, expected) => {
    if (result?.version !== 1 || result.endpoint !== endpoint || result.subjectId !== expected.subjectId) throw new Error('数据回执的主体或服务不匹配。');
    return result;
  };
  function deletionReceipt(result, expected) {
    bound(result, expected);
    if (!deletionReadSchema.safeParse({ id: result.id }).success || !deletionStates.includes(result.state)
      || !Number.isInteger(result.revision) || result.revision < 1 || result.scope !== 'all-owned-service-data'
      || !/^[a-f0-9]{64}$/.test(result.requestHash) || typeof result.physicalDeletionPerformed !== 'boolean'
      || result.executionImplemented !== true || result.serviceWideDeletionComplete !== false) throw new Error('删除处理回执无效。');
    return result;
  }
  async function specification() {
    const expected = actor(), value = bound(await request('data-exports/specification', {}), expected); current(expected);
    if (!Array.isArray(value.datasets) || !value.datasets.length || !Array.isArray(value.viewKinds)) throw new Error('导出范围无效。');
    return value;
  }
  async function createExport(input, { confirmed = false } = {}) {
    if (!confirmed || writing) throw new Error('请确认导出范围，并等待当前数据操作完成。');
    writing = true;
    try {
    const expected = actor(); let operation = await getLocal('data-export-operation');
    if (operation) throw new Error('已有下载记录，请先继续或关闭原记录。');
    const selected = exportCreateSchema.parse({ ...input, id: crypto.randomUUID() });
    operation = { selected, subjectId: expected.subjectId, bindingId: expected.bindingId, state: 'prepared', preparedAt: now() };
    await putLocal('data-export-operation', operation); return restoreExport();
    } finally { writing = false; }
  }
  async function restoreExport() {
    const operation = await getLocal('data-export-operation'); if (!operation) return null;
    const expected = current(operation), value = bound(await request('data-exports/create', operation.selected), expected); current(expected);
    if (value.id !== operation.selected.id || value.revoked || !Number.isFinite(value.expiresAt) || value.expiresAt <= now() || value.expiresAt > now() + 602
      || JSON.stringify(value.datasets) !== JSON.stringify(operation.selected.datasets) || !sameExportViews(value.views, operation.selected.views)
      || value.ownership !== (value.views.length ? 'mixed-authorized-copy' : 'owner-copy')
      || value.datasets.some(name => typeof value.bounds?.[name] !== 'string')) throw new Error('导出下载记录不匹配。');
    operation.ticket = value; operation.state = 'ready'; await putLocal('data-export-operation', operation); return value;
  }
  async function exportPage(input, { signal } = {}) {
    const selection = exportPageSchema.parse(input), operation = await getLocal('data-export-operation');
    if (!operation?.ticket || operation.ticket.id !== selection.id || !operation.ticket.datasets.includes(selection.dataset)) throw new Error('请先读取原下载记录。');
    const expected = current(operation), ticket = operation.ticket;
    const value = bound(await request('data-exports/page', selection, { signal }), expected); current(expected);
    const { sha256, ...snapshot } = value;
    if (sha256 !== await sha256Hex(JSON.stringify(snapshot)) || value.exportId !== ticket.id || value.dataset !== selection.dataset
      || value.after !== selection.after || value.through !== ticket.bounds[selection.dataset] || value.selectionCutoff !== ticket.selectionCutoff
      || value.expiresAt !== ticket.expiresAt || value.expiresAt <= now() || !Array.isArray(value.items) || value.items.length > selection.limit
      || value.ownership !== (selection.dataset === 'authorized-views' ? 'current-authorized-view' : 'owner-copy')
      || value.nextAfter !== null && (typeof value.nextAfter !== 'string' || value.nextAfter <= selection.after || value.nextAfter > value.through)) throw new Error('导出页或摘要不匹配，下载未完成。');
    if (selection.dataset === 'authorized-views') {
      const index = Number(selection.after || '0'), view = ticket.views[index];
      if (value.items.length !== (view ? 1 : 0) || view && (!sameExportViews([value.items[0].selection], [view])
        || value.items[0].scope !== exportViewScopes[view.kind] || value.items[0].authority !== 'current-read-access-only; no republishing or continuing authorization')
        || value.nextAfter !== (index + 1 < ticket.views.length ? String(index + 1).padStart(8, '0') : null)) throw new Error('所选授权视图不匹配。');
    }
    return value;
  }
  async function download({ signal, onProgress, maxBytes = 64 * 1024 * 1024 } = {}) {
    const ticket = await restoreExport(); if (!ticket) throw new Error('没有可下载记录。');
    const pages = [], records = [], counters = {}; let bytes = 0;
    const manifest = { version: 1, ticket, generatedAt: new Date(now()*1000).toISOString(), complete: false,
      consistency: 'bounded-live-pages; not a database backup', proofValidity: 'historical-not-current-authorization', pages, counters };
    try {
      for (const dataset of ticket.datasets) {
        let after = '';
        do {
          signal?.throwIfAborted(); if (pages.length >= 10000) throw new Error('分页数量达到上限。');
          const page = await exportPage({ id: ticket.id, dataset, after }, { signal });
          const lines = page.items.map(item => JSON.stringify({ dataset, item }));
          const size = new TextEncoder().encode(lines.join('\n') + '\n').length;
          if (bytes + size > maxBytes) throw new Error('本次浏览器下载超过内存上限，请减少所选数据集。');
          records.push(...lines); bytes += size; counters[dataset] = (counters[dataset] ?? 0) + page.items.length;
          pages.push({ dataset, after, nextAfter: page.nextAfter, rows: page.items.length, sha256: page.sha256 });
          onProgress?.({ pages: pages.length, rows: records.length, bytes }); after = page.nextAfter;
        } while (after !== null);
      }
      signal?.throwIfAborted(); current({ subjectId: ticket.subjectId, bindingId: (await getLocal('data-export-operation')).bindingId }); manifest.complete = true;
    } catch (error) { manifest.incompleteReason = error?.message ?? '下载未完成'; }
    const content = records.join('\n') + (records.length ? '\n' : ''); manifest.dataSha256 = await sha256Hex(content);
    manifest.rows = records.length; manifest.bytes = bytes;
    return { content, manifest, manifestSha256: await sha256Hex(JSON.stringify(manifest)) };
  }
  async function closeExport() {
    const operation = await getLocal('data-export-operation'); if (!operation) return { state: 'none' };
    const result = await request('data-exports/revoke', { id: operation.selected.id });
    if (result.id !== operation.selected.id || result.revoked !== true) throw new Error('下载关闭结果待查询。');
    await putLocal('data-export-operation', null); return result;
  }
  async function forgetExpiredExport() {
    const operation = await getLocal('data-export-operation');
    if (!operation || !operation.ticket || operation.ticket.expiresAt > now()) throw new Error('下载尚未确认到期，请先关闭原记录。');
    await putLocal('data-export-operation', null);
  }
  async function leaveExport({ confirmed = false } = {}) {
    if (!confirmed) throw new Error('请确认只离开本机下载记录；这不表示远端票据已关闭。');
    const operation = await getLocal('data-export-operation'); if (!operation) return;
    await putLocal('data-export-history:' + operation.selected.id, { ...operation, state: 'locally-left', remoteRevocationConfirmed: false });
    await putLocal('data-export-operation', null);
  }
  async function readDeletion(input) {
    const selected = deletionReadSchema.parse(input), expected = actor();
    const result = deletionReceipt(await request('deletion-requests/read', selected), expected); current(expected);
    const original = deletionIntentSchema.parse(JSON.parse(result.request?.payloadJson));
    if (result.id !== selected.id || original.id !== selected.id || original.subjectId !== expected.subjectId || original.endpoint !== endpoint
      || await sha256Hex(result.request.payloadJson) !== result.requestHash || !Array.isArray(result.events) || result.events.length > 20) throw new Error('删除申请的原文或页次不匹配。');
    let revision = selected.afterRevision;
    for (const event of result.events) {
      if (event.revision !== ++revision) throw new Error('删除事件版本不连续。');
      if (event.payload_minimized === true) {
        if (event.actor_kind !== 'operator' || event.signature !== null || event.payload_text !== ''
          || !['approve','reject','needs-information','execute'].includes(event.kind)
          || !event.retained_payload || await sha256Hex(stableJson(event.retained_payload)) !== event.retained_hash) throw new Error('最小化处理回执不匹配。');
      } else if (await sha256Hex(event.payload_text) !== event.payload_hash) throw new Error('删除事件摘要不匹配。');
    }
    if (result.nextAfterRevision === null ? revision !== result.revision : result.nextAfterRevision !== revision || result.events.length !== 20 || revision >= result.revision) throw new Error('删除事件游标不匹配。');
    return result;
  }
  async function queryDeletion(input = {}) {
    const selection = deletionQuerySchema.parse(input), expected = actor(), result = bound(await request('deletion-requests/query', selection), expected); current(expected);
    if (!Array.isArray(result.items) || result.items.length > selection.limit) throw new Error('删除申请列表无效。');
    result.items.forEach(item => deletionReceipt(item, expected));
    if (result.nextAfter !== null && result.nextAfter !== result.items.at(-1)?.id) throw new Error('删除申请游标无效。');
    return result;
  }
  async function prepareDeletion(input) {
    if (await getLocal('deletion-operation')) throw new Error('请先核对上次删除操作的结果。');
    const expected = actor(), control = await identity(), issuedAt = now();
    const intent = deletionIntentSchema.parse({ ...input, version: 1, id: crypto.randomUUID(), endpoint, subjectId: expected.subjectId,
      bindingId: expected.bindingId, issuedAt, expiresAt: Math.min(issuedAt + 300, expected.expiresAt, expected.bindingExpiresAt ?? Infinity) });
    const preview = { intent, payloadJson: JSON.stringify(intent), deviceId: control.deviceId };
    previews.add(preview); return preview;
  }
  async function submitDeletion(preview, { confirmed = false } = {}) {
    if (!confirmed || !previews.has(preview) || writing) throw new Error('请确认当前删除操作的准确预览。');
    writing = true;
    try {
      if (await getLocal('deletion-operation')) throw new Error('已有待核对的删除操作。');
      current(preview.intent); if (preview.intent.expiresAt <= now()) throw new Error('预览已过期，请重新准备。');
      const payloadJson = preview.payloadJson;
      if (JSON.stringify(preview.intent) !== payloadJson) throw new Error('删除预览已改变。');
      const signed = await sign(payloadJson, 'galaxy-deletion-intent+jws', preview.deviceId); current(preview.intent);
      const operation = { ...preview, signed, payloadHash: await sha256Hex(payloadJson), state: 'result-unknown' };
      await putLocal('deletion-operation', operation); previews.delete(preview);
      return sendDeletion(operation);
    } finally { writing = false; }
  }
  async function rememberReceipt(operation, receipt) {
    const requestId = operation.intent.action === 'request' ? operation.intent.id : operation.intent.requestId;
    await putLocal('deletion-receipt:' + requestId, { requestId, subjectId: operation.intent.subjectId,
      deviceId: operation.intent.action === 'request' ? operation.deviceId : (await getLocal('deletion-receipt:' + requestId))?.deviceId,
      receipt });
    await putLocal('deletion-operation', null); return receipt;
  }
  async function sendDeletion(operation) {
    current(operation.intent);
    if (operation.intent.expiresAt <= now()) throw new Error('原签名已过期；先查询已提交结果。未受理时可重新预览相同申请。');
    const result = deletionReceipt(await request('deletion-requests/submit', { signed: operation.signed }), operation.intent);
    if (result.id !== (operation.intent.requestId ?? operation.intent.id)
      || operation.intent.action === 'request' && result.requestHash !== operation.payloadHash
      || operation.intent.action === 'cancel' && result.state !== 'cancelled') throw new Error('删除操作结果待核对。');
    return rememberReceipt(operation, result);
  }
  async function reconcileDeletion({ retry = false } = {}) {
    const operation = await getLocal('deletion-operation'); if (!operation) return { state: 'none' };
    const id = operation.intent.requestId ?? operation.intent.id;
    let result;
    try {
      result = await readDeletion({ id });
      if (operation.intent.action === 'request') {
        const accepted = [operation,...(operation.prior ?? [])].find(item => result.requestHash === item.payloadHash);
        if (!accepted) throw new Error('申请 ID 已存在但内容不同，请保留原记录核对。');
        return rememberReceipt(accepted, result);
      }
      let page = result;
      for (;;) {
        const event = page.events.find(item => item.id === operation.intent.id);
        if (event) { const accepted = [operation,...(operation.prior ?? [])].find(item => event.payload_hash === item.payloadHash); if (!accepted) throw new Error('取消事件内容冲突。'); return rememberReceipt(accepted, result); }
        if (page.nextAfterRevision === null) break;
        page = await readDeletion({ id, afterRevision: page.nextAfterRevision });
      }
    } catch (error) { if (error.code !== 'not_found') throw error; }
    if (retry) return sendDeletion(operation);
    return { state: 'unacknowledged', id, operation, currentReceipt: result ?? null };
  }
  async function prepareRenewal() {
    const checked = await reconcileDeletion();
    if (checked.state !== 'unacknowledged') return checked;
    const previous = checked.operation;
    if (previous.intent.expiresAt > now()) throw new Error('原签名仍有效，请使用原操作重试。');
    const expected = actor(), control = await identity(), issuedAt = now();
    if (previous.intent.action === 'cancel' && (!checked.currentReceipt || !['requested','review-needed','approved'].includes(checked.currentReceipt.state))) throw new Error('申请现已不能取消，请查看处理详情。');
    const intent = deletionIntentSchema.parse({ ...previous.intent, bindingId: expected.bindingId, issuedAt,
      expiresAt: Math.min(issuedAt + 300, expected.expiresAt, expected.bindingExpiresAt ?? Infinity),
      ...(previous.intent.action === 'cancel' ? { expectedRevision: checked.currentReceipt.revision } : {}) });
    const preview = { intent, payloadJson: JSON.stringify(intent), deviceId: control.deviceId, previousHash: previous.payloadHash };
    previews.add(preview); return preview;
  }
  async function submitRenewal(preview, { confirmed = false } = {}) {
    if (!confirmed || !previews.has(preview) || writing) throw new Error('请确认相同申请的新签名预览。');
    writing = true;
    try {
      const checked = await reconcileDeletion(); if (checked.state !== 'unacknowledged') return checked;
      const previous = checked.operation;
      if (previous.payloadHash !== preview.previousHash || previous.intent.id !== preview.intent.id || JSON.stringify(preview.intent) !== preview.payloadJson) throw new Error('待核对操作已改变。');
      current(preview.intent); if (preview.intent.expiresAt <= now()) throw new Error('预览已过期。');
      const signed = await sign(preview.payloadJson, 'galaxy-deletion-intent+jws', preview.deviceId);
      const { prior = [], ...previousVersion } = previous;
      const operation = { ...preview, signed, payloadHash: await sha256Hex(preview.payloadJson), state: 'result-unknown', prior: [...prior, previousVersion] };
      await putLocal('deletion-operation', operation); previews.delete(preview); return sendDeletion(operation);
    } finally { writing = false; }
  }
  async function holderStatus(requestId) {
    const control = await identity(); if (!control) throw new Error('本机没有原身份控制材料。');
    const saved = await getLocal('deletion-receipt:' + requestId), issuedAt = now();
    const intent = deletionStatusIntentSchema.parse({ version: 1, action: 'status', id: crypto.randomUUID(), requestId, endpoint,
      subjectId: control.subjectId, issuedAt, expiresAt: issuedAt + 300 });
    const signed = await sign(JSON.stringify(intent), 'galaxy-deletion-status+jws', saved?.deviceId ?? control.deviceId);
    const result = deletionReceipt(await request('deletion-requests/status', { signed }, { authenticated: false }), control);
    if ((await identity())?.subjectId !== control.subjectId || result.id !== requestId || result.statusIntentId !== intent.id || result.holderProofVerified !== true) throw new Error('删除后持钥回执不匹配。');
    return result;
  }
  return Object.freeze({ specification, createExport, restoreExport, exportPage, download, closeExport, forgetExpiredExport, leaveExport,
    readDeletion, queryDeletion, prepareDeletion, submitDeletion, reconcileDeletion, prepareRenewal, submitRenewal, holderStatus,
    pendingDeletion: () => getLocal('deletion-operation'), exportOperation: () => getLocal('data-export-operation') });
}
