import { postPublicJson, validatePublicUrl } from './public-fetch.mjs';
import { chatInputs, chatResults } from './shared/chat-schema.mjs';

export function createChatClient({ endpoint, sessions, send = postPublicJson }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !sessions) throw new Error('Invalid chat endpoint');
  async function invoke(action, input, { signal } = {}) {
    const data = chatInputs[action].parse(input);
    signal?.throwIfAborted();
    const actor = await sessions.readAuthorization(endpoint);
    if (!actor?.scopes.includes('chat')) throw new Error('Chat authorization required');
    const check = async () => {
      signal?.throwIfAborted();
      if (!sessions.matchesAuthorization(actor) || !await sessions.isAuthorizationCurrent(actor)) throw new Error('Chat authorization changed');
      signal?.throwIfAborted();
    };
    try {
      await check();
      const value = await send(endpoint + '/v1/chat/' + action, { bodyJson: JSON.stringify(data), credential: actor.credential, signal, maxBytes: 1048576 });
      await check();
      const result = chatResults[action].parse(value);
      if (data.roomId && result.roomId && data.roomId !== result.roomId) throw new Error('Chat room mismatch');
      return result;
    } catch (error) {
      if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(actor, 'remote-rejected');
      throw error; // Mutations are never retried automatically.
    }
  }
  return Object.freeze(Object.fromEntries(Object.keys(chatInputs).map(action => [action, (input = {}, options) => invoke(action, input, options)])));
}
