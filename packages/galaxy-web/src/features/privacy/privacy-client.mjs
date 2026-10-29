import { exportCreateSchema, exportPageSchema, sameExportViews, exportViewScopes } from "../../../../galaxy-contracts/src/data-export-schema.mjs";
import { deletionIntentSchema, deletionReadSchema, deletionQuerySchema, deletionStates, deletionStatusIntentSchema } from "../../../../galaxy-contracts/src/deletion-schema.mjs";
import { sha256Hex, stableJson } from "../../../../galaxy-contracts/src/web-primitives.mjs";

// Keep the original owner's journal even when a committed acknowledgement
// arrives too late for the current UI. A stopped download is not a revocation.
export function createPrivacyClient({ api, getLocal, putLocal, identity, sign, captureLease, now = () => Math.floor(Date.now() / 1000) }) {
  const endpoint = api.endpoint, previews = new WeakMap(); let tail = Promise.resolve();
  const changed = cause => Object.assign(new Error('数据操作的身份、设备或连接已改变，请重新读取。'), { code: 'privacy_authority_changed', cause });
  const requireScope=scope=>{const scopes=api.snapshot()?.scopes??[];if(!scopes.includes(scope)&&!scopes.includes('*'))throw Object.assign(new Error(`当前浏览器设备未获准${scope==='data-export'?'导出资料（data-export）':'提交或读取删除申请（data-delete）'}。请在已有 Agent 的本机审阅页明确批准所需权限；原连接和本机记录仍保留。`),{code:'privacy_device_scope_required',scope});};
  function capture(connected) {
    if (typeof captureLease !== 'function') throw new Error('privacy_lease_unavailable');
    const original = captureLease(), connection = api.snapshot();
    const check = () => { try { original.assertCurrent(); } catch (error) { throw changed(error); } };
    check();
    if (original.endpoint !== endpoint || !original.subjectId || !original.deviceId) throw changed();
    if (connected && (!connection || original.subjectId !== connection.subjectId || original.bindingId !== connection.bindingId
      || original.generation !== connection.generation || original.endpoint !== connection.endpoint)) throw new Error('connection_required');
    return Object.freeze({ ...original, connection, assertCurrent: check });
  }
  // Capture at enqueue time; queued work cannot adopt a later connection.
  function serial(work, connected = true, scope = null) {
    let lease; try { lease = capture(connected);if(scope)requireScope(scope); } catch (error) { return Promise.reject(error); }
    const result = tail.then(async () => { lease.assertCurrent();if(scope)requireScope(scope); const value = await work(lease); lease.assertCurrent(); return value; });
    tail = result.catch(() => {}); return result;
  }
  async function wait(lease, action) { lease.assertCurrent(); const value = await action(); lease.assertCurrent(); return value; }
  const local = (lease, name) => wait(lease, () => getLocal(name, lease.subjectId));
  const save = (lease, name, value) => wait(lease, () => putLocal(name, value, lease.subjectId));
  const request = (lease, path, body, options) => wait(lease, () => {if(options?.authenticated!==false)requireScope(path.startsWith('data-exports/')?'data-export':'data-delete');return api.call('/v1/' + path, body, options);});
  const hash = (lease, value) => wait(lease, () => sha256Hex(value));
  const owner = (lease, expected) => {
    lease.assertCurrent();
    if (expected.subjectId !== lease.subjectId || expected.endpoint && expected.endpoint !== endpoint) throw changed();
  };
  const current = (lease, expected) => { owner(lease, expected); if (expected.bindingId !== lease.bindingId) throw changed(); };
  const control = async lease => {
    const value = await wait(lease, identity);
    if (!value || value.subjectId !== lease.subjectId || value.deviceId !== lease.deviceId) throw changed(); return value;
  };
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
  async function specification(lease) {
    const value = bound(await request(lease, 'data-exports/specification', {}), lease);
    if (!Array.isArray(value.datasets) || !value.datasets.length || !Array.isArray(value.viewKinds)) throw new Error('导出范围无效。'); return value;
  }
  async function createExport(lease, input, { confirmed = false } = {}) {
    if (!confirmed) throw new Error('请确认导出范围，并等待当前数据操作完成。');
    if (await local(lease, 'data-export-operation')) throw new Error('已有下载记录，请先继续或关闭原记录。');
    const selected = exportCreateSchema.parse({ ...input, id: crypto.randomUUID() });
    await save(lease, 'data-export-operation', { selected, subjectId: lease.subjectId, bindingId: lease.bindingId, endpoint, state: 'prepared', preparedAt: now() });
    return restoreExport(lease);
  }
  async function restoreExport(lease) {
    const operation = await local(lease, 'data-export-operation'); if (!operation) return null;
    current(lease, operation);
    const value = bound(await request(lease, 'data-exports/create', operation.selected), lease);
    if (value.id !== operation.selected.id || value.revoked || !Number.isFinite(value.expiresAt) || value.expiresAt <= now() || value.expiresAt > now() + 602
      || JSON.stringify(value.datasets) !== JSON.stringify(operation.selected.datasets) || !sameExportViews(value.views, operation.selected.views)
      || value.ownership !== (value.views.length ? 'mixed-authorized-copy' : 'owner-copy')
      || value.datasets.some(name => typeof value.bounds?.[name] !== 'string')) throw new Error('导出下载记录不匹配。');
    await save(lease, 'data-export-operation', { ...operation, ticket: value, state: 'ready' }); return value;
  }
  async function resumeExport(lease) {
    const operation=await local(lease,'data-export-operation');if(!operation)return{state:'none'};owner(lease,operation);
    if(operation.state==='locally-left'||operation.localRetryStopped)return{state:'stopped-local',id:operation.selected.id};
    if(operation.bindingId!==lease.bindingId)return{state:'unacknowledged',id:operation.selected.id,reason:'original-binding-changed'};
    if(operation.ticket?.expiresAt<=now()||!operation.ticket&&operation.preparedAt+600<=now())return{state:'expired',id:operation.selected.id};
    // create is idempotent, but the current API has no read-only lookup for an
    // unknown ticket. Do not silently create a new snapshot or lifetime then.
    if(!operation.ticket)return{state:'unacknowledged',id:operation.selected.id,reason:'ticket-result-unknown'};
    const ticket=await restoreExport(lease);return{state:'ready',ticket};
  }
  async function exportPage(lease, input, { signal } = {}) {
    const selection = exportPageSchema.parse(input), operation = await local(lease, 'data-export-operation');
    if (!operation?.ticket || operation.ticket.id !== selection.id || !operation.ticket.datasets.includes(selection.dataset)) throw new Error('请先读取原下载记录。');
    current(lease, operation); const ticket = operation.ticket;
    const value = bound(await request(lease, 'data-exports/page', selection, { signal }), lease);
    const { sha256, ...snapshot } = value;
    if (sha256 !== await hash(lease, JSON.stringify(snapshot)) || value.exportId !== ticket.id || value.dataset !== selection.dataset
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
  async function download(lease, { signal, onProgress, maxBytes = 64 * 1024 * 1024 } = {}) {
    const ticket = await restoreExport(lease); if (!ticket) throw new Error('没有可下载记录。');
    const pages = [], records = [], counters = {}; let bytes = 0;
    const manifest = { version: 1, ticket, generatedAt: new Date(now() * 1000).toISOString(), complete: false,
      consistency: 'bounded-live-pages; not a database backup', proofValidity: 'historical-not-current-authorization', pages, counters };
    try {
      for (const dataset of ticket.datasets) {
        let after = '';
        do {
          lease.assertCurrent(); signal?.throwIfAborted(); if (pages.length >= 10000) throw new Error('分页数量达到上限。');
          const page = await exportPage(lease, { id: ticket.id, dataset, after }, { signal });
          const lines = page.items.map(item => JSON.stringify({ dataset, item }));
          const size = lines.length ? new TextEncoder().encode(lines.join('\n') + '\n').length : 0;
          if (bytes + size > maxBytes) throw new Error('本次浏览器下载超过内存上限，请减少所选数据集。');
          records.push(...lines); bytes += size; counters[dataset] = (counters[dataset] ?? 0) + page.items.length;
          pages.push({ dataset, after, nextAfter: page.nextAfter, rows: page.items.length, sha256: page.sha256 });
          onProgress?.({ pages: pages.length, rows: records.length, bytes }); lease.assertCurrent(); after = page.nextAfter;
        } while (after !== null);
      }
      signal?.throwIfAborted(); lease.assertCurrent(); manifest.complete = true;
    } catch (error) {
      // A current owner's legitimately read pages remain a partial export.
      // An invalidated lease must never turn into a downloadable old body.
      lease.assertCurrent(); manifest.incompleteReason = error?.message ?? '下载未完成';
    }
    const content = records.join('\n') + (records.length ? '\n' : ''); manifest.dataSha256 = await hash(lease, content);
    manifest.rows = records.length; manifest.bytes = new TextEncoder().encode(content).length;
    return { content, manifest, manifestSha256: await hash(lease, JSON.stringify(manifest)) };
  }
  async function closeExport(lease) {
    const operation = await local(lease, 'data-export-operation'); if (!operation) return { state: 'none' }; owner(lease, operation);
    const result = await request(lease, 'data-exports/revoke', { id: operation.selected.id });
    if (result.id !== operation.selected.id || result.revoked !== true) throw new Error('下载关闭结果待查询。');
    await save(lease, 'data-export-operation', null); return result;
  }
  async function forgetExpiredExport(lease) {
    const operation = await local(lease, 'data-export-operation');
    if (!operation || !operation.ticket || operation.ticket.expiresAt > now()) throw new Error('下载尚未确认到期，请先关闭原记录。');
    owner(lease, operation); await save(lease, 'data-export-operation', null);
  }
  async function leaveExport(lease, { confirmed = false } = {}) {
    if (!confirmed) throw new Error('请确认只离开本机下载记录；这不表示远端票据已关闭。');
    const operation = await local(lease, 'data-export-operation'); if (!operation) return; owner(lease, operation);
    await save(lease, 'data-export-history:' + operation.selected.id, { ...operation, state: 'locally-left', remoteRevocationConfirmed: false });
    await save(lease, 'data-export-operation', null);
  }
  async function readDeletion(lease, input) {
    const selected = deletionReadSchema.parse(input), result = deletionReceipt(await request(lease, 'deletion-requests/read', selected), lease);
    const original = deletionIntentSchema.parse(JSON.parse(result.request?.payloadJson));
    if (result.id !== selected.id || original.id !== selected.id || original.subjectId !== lease.subjectId || original.endpoint !== endpoint
      || await hash(lease, result.request.payloadJson) !== result.requestHash || !Array.isArray(result.events) || result.events.length > 20) throw new Error('删除申请的原文或页次不匹配。');
    let revision = selected.afterRevision;
    for (const event of result.events) {
      if (event.revision !== ++revision) throw new Error('删除事件版本不连续。');
      if (event.payload_minimized === true) {
        if (event.actor_kind !== 'operator' || event.signature !== null || event.payload_text !== ''
          || !['approve', 'reject', 'needs-information', 'execute'].includes(event.kind)
          || !event.retained_payload || await hash(lease, stableJson(event.retained_payload)) !== event.retained_hash) throw new Error('最小化处理回执不匹配。');
      } else if (await hash(lease, event.payload_text) !== event.payload_hash) throw new Error('删除事件摘要不匹配。');
    }
    if (result.nextAfterRevision === null ? revision !== result.revision : result.nextAfterRevision !== revision || result.events.length !== 20 || revision >= result.revision) throw new Error('删除事件游标不匹配。');
    return result;
  }
  async function queryDeletion(lease, input = {}) {
    const selection = deletionQuerySchema.parse(input), result = bound(await request(lease, 'deletion-requests/query', selection), lease);
    if (!Array.isArray(result.items) || result.items.length > selection.limit) throw new Error('删除申请列表无效。');
    result.items.forEach(item => deletionReceipt(item, lease));
    if (result.nextAfter !== null && result.nextAfter !== result.items.at(-1)?.id) throw new Error('删除申请游标无效。'); return result;
  }
  function preview(lease, intent, deviceId, extra = {}) {
    const value = Object.freeze({ intent: Object.freeze(intent), payloadJson: JSON.stringify(intent), deviceId, ...extra });
    previews.set(value, lease); return value;
  }
  function reviewed(lease, value, confirmed) {
    if (!confirmed || !previews.has(value)) throw new Error('请确认当前删除操作的准确预览。');
    previews.get(value).assertCurrent(); current(lease, value.intent);
    if (value.deviceId !== lease.deviceId || JSON.stringify(value.intent) !== value.payloadJson) throw changed();
    if (value.intent.expiresAt <= now()) throw new Error('预览已过期，请重新准备。');
  }
  async function prepareDeletion(lease, input) {
    if (await local(lease, 'deletion-operation')) throw new Error('请先核对上次删除操作的结果。');
    const material = await control(lease), issuedAt = now(), expected = lease.connection;
    const intent = deletionIntentSchema.parse({ ...input, version: 1, id: crypto.randomUUID(), endpoint, subjectId: lease.subjectId,
      bindingId: lease.bindingId, issuedAt, expiresAt: Math.min(issuedAt + 300, expected.expiresAt, expected.bindingExpiresAt ?? Infinity) });
    return preview(lease, intent, material.deviceId);
  }
  async function submitDeletion(lease, value, { confirmed = false } = {}) {
    reviewed(lease, value, confirmed);
    if (await local(lease, 'deletion-operation')) throw new Error('已有待核对的删除操作。');
    const signed = await wait(lease, () => sign(value.payloadJson, 'galaxy-deletion-intent+jws', value.deviceId));
    const operation = { ...value, signed, payloadHash: await hash(lease, value.payloadJson), state: 'result-unknown' };
    await save(lease, 'deletion-operation', operation); previews.delete(value); return sendDeletion(lease, operation);
  }
  async function rememberReceipt(lease, operation, receipt) {
    owner(lease, operation.intent);
    const requestId = operation.intent.action === 'request' ? operation.intent.id : operation.intent.requestId;
    const previous = operation.intent.action === 'request' ? null : await local(lease, 'deletion-receipt:' + requestId);
    const value = { requestId, subjectId: operation.intent.subjectId,
      deviceId: operation.intent.action === 'request' ? operation.deviceId : previous?.deviceId, receipt };
    // Persist to the captured owner's namespace. If completion invalidates the
    // lease, keep this ACK and original pending locator; withhold the UI result.
    await save(lease, 'deletion-receipt:' + requestId, value);
    const index=await local(lease,'deletion-receipt-index')??[];
    if(!Array.isArray(index))throw Error('deletion_local_index_unavailable');
    const locator={requestId,subjectId:value.subjectId,deviceId:value.deviceId??null,state:receipt.state,revision:receipt.revision,
      checkedAt:receipt.checkedAt??now(),physicalDeletionPerformed:receipt.physicalDeletionPerformed};
    await save(lease,'deletion-receipt-index',[locator,...index.filter(item=>item.requestId!==requestId)]);
    await save(lease, 'deletion-operation', null); return receipt;
  }
  async function deletionReceipts(lease){
    const index=await local(lease,'deletion-receipt-index')??[];if(!Array.isArray(index))throw Error('deletion_local_index_unavailable');
    return index.filter(item=>item.subjectId===lease.subjectId&&item.deviceId===lease.deviceId).map(item=>({
      requestId:item.requestId,subjectId:item.subjectId,deviceId:item.deviceId,state:item.state,revision:item.revision,
      checkedAt:item.checkedAt,physicalDeletionPerformed:item.physicalDeletionPerformed}));
  }
  async function sendDeletion(lease, operation) {
    current(lease, operation.intent);
    if (operation.intent.expiresAt <= now()) throw new Error('原签名已过期；先查询已提交结果。未受理时可重新预览相同申请。');
    const result = deletionReceipt(await request(lease, 'deletion-requests/submit', { signed: operation.signed }), operation.intent);
    if (result.id !== (operation.intent.requestId ?? operation.intent.id)
      || operation.intent.action === 'request' && result.requestHash !== operation.payloadHash
      || operation.intent.action === 'cancel' && result.state !== 'cancelled') throw new Error('删除操作结果待核对。');
    return rememberReceipt(lease, operation, result);
  }
  async function reconcileDeletion(lease, { retry = false } = {}) {
    const operation = await local(lease, 'deletion-operation'); if (!operation) return { state: 'none' }; owner(lease, operation.intent);
    const id = operation.intent.requestId ?? operation.intent.id; let result;
    try {
      result = await readDeletion(lease, { id });
      if (operation.intent.action === 'request') {
        const accepted = [operation, ...(operation.prior ?? [])].find(item => result.requestHash === item.payloadHash);
        if (!accepted) throw new Error('申请 ID 已存在但内容不同，请保留原记录核对。'); return rememberReceipt(lease, accepted, result);
      }
      let page = result;
      for (;;) {
        const event = page.events.find(item => item.id === operation.intent.id);
        if (event) {
          const accepted = [operation, ...(operation.prior ?? [])].find(item => event.payload_hash === item.payloadHash);
          if (!accepted) throw new Error('取消事件内容冲突。'); return rememberReceipt(lease, accepted, result);
        }
        if (page.nextAfterRevision === null) break;
        page = await readDeletion(lease, { id, afterRevision: page.nextAfterRevision });
      }
    } catch (error) { lease.assertCurrent(); if (error.code !== 'not_found') throw error; }
    if (retry) return sendDeletion(lease, operation);
    return { state: 'unacknowledged', id, operation, currentReceipt: result ?? null };
  }
  async function resumeDeletion(lease) {
    const result=await reconcileDeletion(lease);if(result.state!=='unacknowledged')return result;
    const operation=result.operation,intent=deletionIntentSchema.parse(JSON.parse(operation.payloadJson));
    if(JSON.stringify(intent)!==JSON.stringify(operation.intent)||await hash(lease,operation.payloadJson)!==operation.payloadHash
      ||typeof operation.signed!=='string'||!operation.signed)throw Error('deletion_original_operation_changed');
    const blocked=reason=>({...result,reason});
    if(operation.localRetryStopped||['stopped-local','locally-left','canceled'].includes(operation.state))return blocked('stopped-local');
    if(intent.expiresAt<=now())return blocked('authorization-expired');
    if(intent.bindingId!==lease.bindingId||operation.deviceId!==lease.deviceId)return blocked('original-binding-changed');
    return sendDeletion(lease,operation);
  }
  async function prepareRenewal(lease) {
    const checked = await reconcileDeletion(lease); if (checked.state !== 'unacknowledged') return checked;
    const previous = checked.operation;
    if (previous.intent.expiresAt > now()) throw new Error('原签名仍有效，请使用原操作重试。');
    const material = await control(lease), issuedAt = now(), expected = lease.connection;
    if (previous.intent.action === 'cancel' && (!checked.currentReceipt || !['requested', 'review-needed', 'approved'].includes(checked.currentReceipt.state))) throw new Error('申请现已不能取消，请查看处理详情。');
    const intent = deletionIntentSchema.parse({ ...previous.intent, bindingId: lease.bindingId, issuedAt,
      expiresAt: Math.min(issuedAt + 300, expected.expiresAt, expected.bindingExpiresAt ?? Infinity),
      ...(previous.intent.action === 'cancel' ? { expectedRevision: checked.currentReceipt.revision } : {}) });
    return preview(lease, intent, material.deviceId, { previousHash: previous.payloadHash });
  }
  async function submitRenewal(lease, value, { confirmed = false } = {}) {
    reviewed(lease, value, confirmed);
    const checked = await reconcileDeletion(lease); if (checked.state !== 'unacknowledged') return checked;
    const previous = checked.operation;
    if (previous.payloadHash !== value.previousHash || previous.intent.id !== value.intent.id) throw new Error('待核对操作已改变。');
    const signed = await wait(lease, () => sign(value.payloadJson, 'galaxy-deletion-intent+jws', value.deviceId));
    const { prior = [], ...previousVersion } = previous;
    const operation = { ...value, signed, payloadHash: await hash(lease, value.payloadJson), state: 'result-unknown', prior: [...prior, previousVersion] };
    await save(lease, 'deletion-operation', operation); previews.delete(value); return sendDeletion(lease, operation);
  }
  async function holderStatus(lease, requestId) {
    const material = await control(lease), saved = await local(lease, 'deletion-receipt:' + requestId), issuedAt = now();
    if (saved && (saved.subjectId !== lease.subjectId || saved.requestId !== requestId)) throw changed();
    const intent = deletionStatusIntentSchema.parse({ version: 1, action: 'status', id: crypto.randomUUID(), requestId, endpoint,
      subjectId: lease.subjectId, issuedAt, expiresAt: issuedAt + 300 });
    const signed = await wait(lease, () => sign(JSON.stringify(intent), 'galaxy-deletion-status+jws', saved?.deviceId ?? material.deviceId));
    const result = deletionReceipt(await request(lease, 'deletion-requests/status', { signed }, { authenticated: false }), lease);
    await control(lease);
    if (result.id !== requestId || result.statusIntentId !== intent.id || result.holderProofVerified !== true) throw new Error('删除后持钥回执不匹配。'); return result;
  }
  return Object.freeze({
    specification: () => serial(specification,true,'data-export'), createExport: (input, options) => serial(lease => createExport(lease, input, options),true,'data-export'),
    restoreExport: () => serial(restoreExport,true,'data-export'), resumeExport: () => serial(resumeExport,true,'data-export'), exportPage: (input, options) => serial(lease => exportPage(lease, input, options),true,'data-export'),
    download: options => serial(lease => download(lease, options),true,'data-export'), closeExport: () => serial(closeExport,true,'data-export'),
    forgetExpiredExport: () => serial(forgetExpiredExport, false), leaveExport: options => serial(lease => leaveExport(lease, options), false),
    readDeletion: input => serial(lease => readDeletion(lease, input),true,'data-delete'), queryDeletion: input => serial(lease => queryDeletion(lease, input),true,'data-delete'),
    prepareDeletion: input => serial(lease => prepareDeletion(lease, input),true,'data-delete'), submitDeletion: (value, options) => serial(lease => submitDeletion(lease, value, options),true,'data-delete'),
    reconcileDeletion: options => serial(lease => reconcileDeletion(lease, options),true,'data-delete'), resumeDeletion: () => serial(resumeDeletion,true,'data-delete'), prepareRenewal: () => serial(prepareRenewal,true,'data-delete'),
    submitRenewal: (value, options) => serial(lease => submitRenewal(lease, value, options),true,'data-delete'), holderStatus: id => serial(lease => holderStatus(lease, id), false),
    pendingDeletion: () => serial(lease => local(lease, 'deletion-operation'), false),
    deletionReceipts: () => serial(deletionReceipts,false),
    exportOperation: () => serial(lease => local(lease, 'data-export-operation'), false),
  });
}
