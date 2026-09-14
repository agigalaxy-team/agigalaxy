import * as z from 'zod/v4';
import { postPublicJson, fetchAssistanceJson, validatePublicUrl } from './public-fetch.mjs';
import { taskRequestV2Schema, taskReceiptV2Schema, taskQueryV2Schema } from './shared/task-schema-v2.mjs';

// Existing signed Consent is the payload authorization, not an input boolean.
// A transport/session lease is checked both before and after every request.
export function createTaskClientV2({ endpoint, sessions, send = postPublicJson, read = fetchAssistanceJson }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !sessions) throw new Error('Invalid Task client configuration.');
  async function invoke(path, body, { signal, method = 'POST' } = {}) {
    signal?.throwIfAborted();
    const auth = await sessions.readAuthorization(endpoint);
    if (!auth?.scopes.includes('assistance')) throw new Error('Task authorization required.');
    const check = async () => {
      signal?.throwIfAborted();
      if (!sessions.matchesAuthorization(auth) || !await sessions.isAuthorizationCurrent(auth)) throw new Error('Task authorization changed.');
      signal?.throwIfAborted();
    };
    try {
      await check();
      const options = { credential: auth.credential, signal, maxBytes: 1048576 };
      const result = method === 'GET' ? await read(endpoint + path, options) : await send(endpoint + path, { ...options, bodyJson: JSON.stringify(body) });
      await check(); return result;
    } catch (error) { if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(auth, 'remote-rejected'); throw error; }
  }
  function task(result, id) {
    if (result?.taskId !== id || !Number.isInteger(result.version) || result.version < 1 || result.paymentExecuted !== false
      || result.contextAccessGranted !== false
      || !(result.schemaVersion === 2 && result.roomMembershipGranted === false
        || result.schemaVersion === 1 && result.compatibility?.source === 'legacy-v1' && result.compatibility.v2Writes === false)) throw new Error('Invalid Task response.');
    return result;
  }
  async function createTask(submission, options) {
    z.strictObject({ consentId: z.uuid(), payloadJson: z.string().min(1).max(24000) }).parse(submission);
    const request = taskRequestV2Schema.parse(JSON.parse(submission.payloadJson));
    const result = await invoke('/v2/tasks', submission, options);
    if (result?.taskId !== request.taskId || result.eventId !== request.operationId || result.version !== 1) throw new Error('Unknown Task creation outcome; query original receipt.');
    return result;
  }
  async function getTask(id, options) { z.uuid().parse(id); return task(await invoke(`/v2/tasks/${id}`, null, { ...options, method: 'GET' }), id); }
  async function taskReceipt(input, options) {
    const query = taskReceiptV2Schema.parse(input), result = await invoke('/v2/tasks/receipt', query, options);
    if (!result || Object.entries(query).some(([key, value]) => result[key] !== value) || !['absent', 'acknowledged', 'conflict'].includes(result.state)
      || result.state === 'acknowledged' && (!Number.isInteger(result.version) || result.version < 1)) throw new Error('Invalid Task receipt.');
    return result;
  }
  async function queryTasks(input = {}, options) {
    const query = taskQueryV2Schema.parse(input), result = await invoke('/v2/tasks/query', query, options);
    if (!result || !Array.isArray(result.items) || result.items.length > query.limit || result.coverage !== 'visible-page-only'
      || !(result.nextAfter === null || z.uuid().safeParse(result.nextAfter).success)) throw new Error('Invalid Task page.');
    result.items.forEach(item => task(item, z.uuid().parse(item.taskId))); return result;
  }
  return { createTask, getTask, taskReceipt, queryTasks };
}
