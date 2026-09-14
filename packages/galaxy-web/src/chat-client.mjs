import { chatCreateSchema, chatDecisionSchema, chatSendSchema, chatEditSchema } from '../../galaxy-official/src/shared/chat-schema.mjs';

// Only user-confirmed, stable operations are journalled. Reopening a page never
// resends a draft, approves an invitation, or turns ordinary chat into a Task.
export function createChatClient({ api, getLocal, putLocal }) {
  let subjectId = api.snapshot()?.subjectId; const endpoint = api.endpoint, locks = new Set();
  const owner = () => { const current = api.snapshot()?.subjectId; if (!subjectId && current) subjectId = current; if (!subjectId || current !== subjectId || api.endpoint !== endpoint) throw new Error('身份或连接已改变，请重新打开房间。'); };
  const serial = async (roomId, fn) => { owner(); const key = roomId ?? 'create'; if (locks.has(key)) throw new Error('本房间已有聊天操作正在处理。'); locks.add(key); try { return await fn(); } finally { locks.delete(key); } };
  const roomPath = roomId => {
    if (!/^[0-9a-f-]{36}$/i.test(roomId)) throw new Error('无效房间标识。');
    return `/v2/chat/rooms/${roomId}`;
  };
  const key = roomId => `chat-operation:${roomId ?? 'create'}`;
  async function execute(record) {
    owner(); const result = await api.call(record.path, record.input); owner();
    await putLocal(key(record.roomId), null); return result;
  }
  async function commit(roomId, path, input, confirmed) {
    return serial(roomId, async () => {
      owner(); if (!confirmed) throw new Error('请连接身份并确认这次操作。');
      if (await getLocal(key(roomId))) throw new Error('请先查询或处理此房间上一次操作。');
      const record = { roomId, path, input, createdAt: Date.now() };
      await putLocal(key(roomId), record); return execute(record);
    });
  }
  return Object.freeze({
    pending: roomId => { owner(); return getLocal(key(roomId)); },
    async retry(roomId, { confirmed = false } = {}) {
      return serial(roomId, async () => { if (!confirmed) throw new Error('请确认重试原操作。');
      const record = await getLocal(key(roomId)); if (!record) return { state: 'none' };
      if (record.path.endsWith('/send')) {
        const receipt = await api.call(roomPath(roomId) + '/receipt', { clientMessageId: record.input.clientMessageId });
        if (receipt.state !== 'pending' && receipt.state !== 'not-found') { await putLocal(key(roomId), null); return receipt; }
      }
      return execute(record); });
    },
    async stopRetry(roomId, { confirmed = false } = {}) {
      if (!confirmed) throw new Error('请确认仅停止本机重试，已完成的服务操作不会撤销。');
      owner(); await putLocal(key(roomId), null); return { localRetryStopped: true, serverOperationCancelled: false };
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
