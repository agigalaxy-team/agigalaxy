import { randomBytes, randomUUID } from 'node:crypto';
import { chatInputs } from './shared/chat-schema.mjs';
import { ServiceError } from './shared/service-error.mjs';

export class ChatService {
  constructor(access, transport) { this.access = access; this.transport = transport; }
  async execute(actor, action, input) {
    const parsed = chatInputs[action]?.safeParse(input);
    if (!parsed?.success) throw new ServiceError('invalid_chat_request');
    // Hold the existing live binding/session authorization through the operation.
    // Chat is an explicit new scope; old history/assistance grants do not imply it.
    return this.access.runAuthorized(actor, 'chat', async () => {
      const data = parsed.data;
      if (action === 'create') {
        const joinCode = randomBytes(32).toString('base64url');
        const room = await this.transport.command(actor, { action, ...data, roomId: randomUUID(), joinCode });
        return { ...room, joinCode };
      }
      if (action === 'send' || action === 'messages') {
        await this.transport.command(actor, { action: 'read', roomId: data.roomId });
        return this.transport[action](actor, data);
      }
      return this.transport.command(actor, { action, ...data });
    });
  }
}
