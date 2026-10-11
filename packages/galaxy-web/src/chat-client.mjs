import { chatCreateSchema, chatDecisionSchema, chatSendSchema, chatEditSchema, chatPageSchema, chatMessageReceiptResultSchema } from '../../galaxy-official/src/shared/chat-schema.mjs';
import {chatSendRequestHash} from '../../galaxy-official/src/shared/chat-message-request-hash.mjs';
export {chatSendRequestHash};
const stoppedIndexWrites = new Map();

// Only user-confirmed, stable operations are journalled. Reopening a page never
// resends a draft, approves an invitation, or turns ordinary chat into a Task.
export function createChatClient({ api, getLocal, putLocal, updateLocal, subjectId, captureLease }) {
  const connection = () => { const current = api.snapshot() ?? {}; return { subjectId: current.subjectId ?? null,
    endpoint: api.endpoint ?? current.endpoint ?? null, bindingId: current.bindingId ?? null, generation: current.generation ?? null }; };
  const fixedOwner = subjectId !== undefined;
  let identity = { ...connection(), ...(fixedOwner ? { subjectId } : {}) }; const locks = new Set();
  const checkOwner = current => {
    if (!identity.subjectId || identity.subjectId !== current.subjectId || identity.endpoint !== current.endpoint) throw new Error('身份或连接已改变，请重新打开房间。');
  };
  const begin = () => { const current = connection(); if (!fixedOwner && !identity.subjectId && current.subjectId) identity = current;
    checkOwner(current); const authority = captureLease?.();
    if (captureLease && (!authority || typeof authority.assertCurrent !== 'function'
      || ['subjectId', 'endpoint', 'bindingId', 'generation'].some(key => authority[key] !== current[key]))) throw new Error('身份或连接已改变，请重新打开房间。');
    authority?.assertCurrent(); return { ...current, authority }; };
  // The original runtime authority is retained for this operation. A new A
  // session after A -> B -> A must not revive an earlier A operation's lease.
  const check = lease => { lease.authority?.assertCurrent(); const current = connection(); checkOwner(current);
    if (['subjectId', 'endpoint', 'bindingId', 'generation'].some(key => current[key] !== lease[key])) throw new Error('身份或连接已改变，请重新打开房间。');
    lease.authority?.assertCurrent(); };
  const guarded = async (lease,fn) => { check(lease); let result; try { result = await fn(); } catch (error) { check(lease); throw error; } check(lease); return result; };
  const serial = async (roomId, fn) => { const lease = begin(), key = roomId ?? 'create'; if (locks.has(key)) throw new Error('本房间已有聊天操作正在处理。'); locks.add(key); try { const result = await fn(lease); check(lease); return result; } finally { locks.delete(key); } };
  const roomPath = roomId => {
    if (!/^[0-9a-f-]{36}$/i.test(roomId)) throw new Error('无效房间标识。');
    return `/v2/chat/rooms/${roomId}`;
  };
  const key = roomId => `chat-operation:${roomId ?? 'create'}`;
  const stoppedKey = roomId => `chat-stopped-operations:${roomId}`;
  const stoppedIndexKey = 'chat-stopped-room-index';
  const validateOwner = record => { if (record?.owner && (record.owner.subjectId !== identity.subjectId || record.owner.endpoint !== identity.endpoint)) throw new Error('身份或连接已改变，请重新打开房间。'); return record; };
  const read = async (roomId,lease) => validateOwner(await guarded(lease,() => getLocal(key(roomId))));
  const sameRecord = (current, original) => JSON.stringify(current) === JSON.stringify(original);
  const atomic = (roomId, updater, lease) => guarded(lease, () => {
    if (typeof updateLocal !== 'function') throw new Error('local_atomic_update_unavailable');
    return updateLocal(key(roomId), current => { check(lease); validateOwner(current); return updater(current); });
  });
  const replaceOriginal = (roomId, original, next, lease) => atomic(roomId, current =>
    sameRecord(current, original) ? next : current, lease);
  const stopped = async (roomId,lease) => { const rows = await guarded(lease,() => getLocal(stoppedKey(roomId))) ?? [];
    if (!Array.isArray(rows)) throw new Error('本机原消息回执记录不可用。'); rows.forEach(validateOwner); return rows; };
  const stoppedRooms = async lease => { const index = await guarded(lease,() => getLocal(stoppedIndexKey));
    if (!index) return {roomIds:[]};
    if (!index.owner || index.owner.subjectId !== lease.subjectId || index.owner.endpoint !== lease.endpoint || !Array.isArray(index.roomIds) || index.roomIds.some(id=>typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))) throw new Error('本机原消息回执记录不可用。');
    return {roomIds:[...new Set(index.roomIds)]}; };
  async function indexStoppedRoom(roomId,lease) {
    const lockName = 'galaxy-chat-stopped-rooms:'+lease.subjectId+':'+lease.endpoint;
    const update = async()=>{const {roomIds}=await stoppedRooms(lease);
      await guarded(lease,()=>putLocal(stoppedIndexKey,{owner:{subjectId:lease.subjectId,endpoint:lease.endpoint},roomIds:[...new Set([...roomIds,roomId])]}));};
    // Browser origin locks preserve updates from two tabs. The fallback queues
    // instances in this realm; a journal is retained if indexing fails.
    if(globalThis.navigator?.locks)return guarded(lease,()=>navigator.locks.request(lockName,update));
    const prior=stoppedIndexWrites.get(lockName)??Promise.resolve(),next=prior.catch(()=>{}).then(update);
    stoppedIndexWrites.set(lockName,next);try{return await next;}finally{if(stoppedIndexWrites.get(lockName)===next)stoppedIndexWrites.delete(lockName);}
  }
  async function exactReceipt(record,lease) {
    if (record.input.text !== undefined && await guarded(lease,() => chatSendRequestHash(record.input)) !== record.requestHash) throw new Error('本机原消息已改变，请保留原操作标识并重新核对。');
    const query = {roomId: record.roomId, clientMessageId: record.input.clientMessageId, requestHash: record.requestHash};
    const receipt = chatMessageReceiptResultSchema.parse(await guarded(lease,() => api.call(roomPath(record.roomId) + '/receipt', {clientMessageId: query.clientMessageId, requestHash: query.requestHash})));
    if (Object.entries(query).some(([field,value]) => receipt[field] !== value)) throw new Error('chat_message_receipt_mismatch');
    if (receipt.state === 'conflict') throw new Error('chat_message_receipt_conflict'); return receipt;
  }
  async function execute(record,lease) {
    check(lease); validateOwner(record); const result = await guarded(lease,() => api.call(record.path, record.input));
    await replaceOriginal(record.roomId, record, null,lease); return result;
  }
  async function commit(roomId, path, input, confirmed) {
    return serial(roomId, async lease => {
      if (!confirmed) throw new Error('请连接身份并确认这次操作。');
      if (await read(roomId,lease)) throw new Error('请先查询或处理此房间上一次操作。');
      const record = { roomId, path, input, createdAt: Date.now(), owner: {subjectId: lease.subjectId, endpoint: lease.endpoint} };
      if (path.endsWith('/send')) record.requestHash = await guarded(lease,() => chatSendRequestHash(input));
      await atomic(roomId, current => {
        if (current) throw new Error('请先查询或处理此房间上一次操作。');
        return record;
      }, lease); return execute(record,lease);
    });
  }
  async function resume(roomId, lease) {
    let record = await read(roomId,lease); if (!record) return { state: 'none' };
    if (record.roomId !== roomId) throw new Error('本机原聊天操作与房间不一致。');
    if (roomId === null && record.path === '/v2/chat/rooms/create') chatCreateSchema.parse(record.input);
    else if (record.path === roomPath(roomId) + '/send') chatSendSchema.parse(record.input);
    else if (record.path === roomPath(roomId) + '/propose') chatDecisionSchema.parse(record.input);
    else if (new RegExp('^'+roomPath(roomId)+'/messages/[0-9a-f-]{36}/edit$','i').test(record.path)) chatEditSchema.parse(record.input);
    else throw new Error('本机原聊天操作不能安全接续。');
    if (record.path.endsWith('/send')) {
      if (!record.requestHash) {
        const original = record;
        record = {...record, requestHash: await guarded(lease,() => chatSendRequestHash(record.input))};
        const stored = await replaceOriginal(roomId, original, record, lease);
        if (!sameRecord(stored, record)) throw new Error('本机原聊天操作已改变，请核对原操作。');
      }
      const receipt = await exactReceipt(record,lease);
      if (!['pending','absent'].includes(receipt.state)) { await replaceOriginal(roomId, record, null,lease); return receipt; }
      if (record.localRetryStopped) return {...receipt, localRetryStopped: true, serverOperationCancelled: false};
    }
    // A durable journal is written only by the original approved action.
    // Recovery sends those same IDs and bytes; a saved draft never enters it.
    return execute(record,lease);
  }
  async function reconcileStopped(roomId,clientMessageId,lease) {
    const rows = await stopped(roomId,lease), index = rows.findIndex(row => row.input.clientMessageId === clientMessageId);
    if (index < 0) throw new Error('没有本机保存的这条原消息回执。'); const receipt = await exactReceipt(rows[index],lease);
    rows[index] = {...rows[index],receipt}; await guarded(lease,() => putLocal(stoppedKey(roomId),rows));
    return {...receipt,localRetryStopped:true,serverOperationCancelled:false};
  }
  return Object.freeze({
    pending: roomId => read(roomId,begin()),
    resumePending: roomId => serial(roomId,lease => resume(roomId,lease)),
    latestHistory(roomId, { before, limit = 50 } = {}) {
      const lease = begin(), input = chatPageSchema.parse({latest:true,limit,...(before!==undefined?{before}:{})});
      return guarded(lease,() => api.call(roomPath(roomId) + '/history', input));
    },
    async retry(roomId, { confirmed = false } = {}) {
      return serial(roomId, async lease => { if (!confirmed) throw new Error('请确认重试原操作。'); return resume(roomId,lease); });
    },
    async stopRetry(roomId, { confirmed = false } = {}) {
      return serial(roomId, async lease => { if (!confirmed) throw new Error('请确认仅停止本机重试，已完成的服务操作不会撤销。');
      const record = await read(roomId,lease);
      if (record?.path.endsWith('/send')) {
        const requestHash = record.requestHash ?? await guarded(lease,() => chatSendRequestHash(record.input));
        const rows = await stopped(roomId,lease), prior = rows.find(row => row.input.clientMessageId === record.input.clientMessageId);
        if (prior && prior.requestHash !== requestHash) throw new Error('本机原消息回执记录已改变。');
        const locator = {roomId,requestHash,input:{clientMessageId:record.input.clientMessageId},owner:{subjectId:lease.subjectId,endpoint:lease.endpoint},localRetryStopped:true,stoppedAt:Date.now()};
        await guarded(lease,() => putLocal(stoppedKey(roomId),[...rows.filter(row => row.input.clientMessageId !== locator.input.clientMessageId),locator]));
        await indexStoppedRoom(roomId,lease);
      }
      if (record) await replaceOriginal(roomId, record, null,lease);
      return { localRetryStopped: true, serverOperationCancelled: false }; });
    },
    stopped: roomId => stopped(roomId,begin()),
    stoppedRooms: () => stoppedRooms(begin()),
    reconcileStopped: (roomId,clientMessageId) => serial(roomId,lease => reconcileStopped(roomId,clientMessageId,lease)),
    async reconcileStoppedAll(roomId) {
      const lease = begin(), ids = roomId ? [roomId] : (await stoppedRooms(lease)).roomIds, results = [];
      for (const id of ids) {
        const rows = await stopped(id,lease);
        for (const row of rows) {
          check(lease); const clientMessageId = row.input.clientMessageId;
          if (['accepted','retracted','expired'].includes(row.receipt?.state)) {
            results.push({roomId:id,clientMessageId,receipt:row.receipt}); continue;
          }
          try { const receipt = await serial(id,current => reconcileStopped(id,clientMessageId,current));
            check(lease); results.push({roomId:id,clientMessageId,receipt}); }
          catch (error) { check(lease); results.push({roomId:id,clientMessageId,error:error.message}); }
        }
      }
      check(lease); return results;
    },
    create: (input, { confirmed = false } = {}) => commit(null, '/v2/chat/rooms/create',
      chatCreateSchema.parse({ ...input, roomId: input.roomId ?? crypto.randomUUID(), operationId: input.operationId ?? crypto.randomUUID() }), confirmed),
    propose: (roomId, input, { confirmed = false } = {}) => commit(roomId, roomPath(roomId) + '/propose',
      chatDecisionSchema.parse({ ...input, decisionId: input.decisionId ?? crypto.randomUUID() }), confirmed),
    send: (roomId, text, { replyTo = null, confirmed = false, attachments } = {}) => commit(roomId, roomPath(roomId) + '/send',
      chatSendSchema.parse({ clientMessageId: crypto.randomUUID(), text, replyTo,...(attachments?.length?{attachments}:{}) }), confirmed),
    edit: (roomId, messageId, input, { confirmed = false } = {}) => {
      if (!/^[0-9a-f-]{36}$/i.test(messageId)) throw new Error('无效消息标识。');
      return commit(roomId, roomPath(roomId) + `/messages/${messageId}/edit`,
        chatEditSchema.parse({ ...input, operationId: crypto.randomUUID() }), confirmed);
    },
  });
}
