import { randomUUID, createHash } from 'node:crypto';
import { deletionIntentSchema, deletionReadSchema, deletionQuerySchema, deletionStates, deletionStatusIntentSchema } from "../../../galaxy-contracts/src/deletion-schema.mjs";
import { postPublicJson, postDeletionStatusJson, validatePublicUrl } from "./public-fetch.mjs";
import { readDeletionEventPayload } from "../../../galaxy-contracts/src/deletion-event-payload.mjs";
const sha = value => createHash('sha256').update(value).digest('hex');
export function createDeletionClient({ endpoint, sessions, signIntent, send = postPublicJson, now = () => Math.floor(Date.now()/1000) }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !sessions) throw new Error('Invalid deletion client configuration');
  const pending = new WeakMap(); let signingPayload = null;
  async function authorization() {
    const actor = await sessions.readAuthorization(endpoint);
    if (!actor?.scopes.includes('data-delete')) throw new Error('Deletion request authorization required'); return actor;
  }
  async function current(actor, signal) {
    signal?.throwIfAborted();
    if (!await sessions.isAuthorizationCurrent(actor) || !sessions.matchesAuthorization(actor)) throw new Error('Deletion authorization changed');
    signal?.throwIfAborted();
  }
  async function request(method, input, { actor: supplied, signal } = {}) {
    const actor = supplied ?? await authorization();
    try {
      await current(actor, signal);
      const result = await send(`${endpoint}/v1/deletion-requests/${method}`, { bodyJson: JSON.stringify(input), credential: actor.credential, signal, maxBytes: 524288 });
      await current(actor, signal);
      if (result?.version !== 1 || result.endpoint !== endpoint || result.subjectId !== actor.subjectId) throw new Error('Deletion response mismatch');
      return { result, actor };
    } catch (error) { if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(actor,'remote-rejected'); throw error; }
  }
  function receipt(value, actor) {
    if (!value || value.version !== 1 || value.endpoint !== endpoint || value.subjectId !== actor.subjectId
      || !deletionReadSchema.safeParse({ id: value.id }).success || !Number.isInteger(value.revision) || value.revision < 1
      || !deletionStates.includes(value.state) || value.scope !== 'all-owned-service-data'
      || !/^[a-f0-9]{64}$/.test(value.requestHash) || typeof value.physicalDeletionPerformed !== 'boolean' || value.executionImplemented !== true
      || value.serviceWideDeletionComplete !== false) throw new Error('Deletion receipt mismatch');
    return value;
  }
  async function prepare(input) {
    if (typeof signIntent !== 'function') throw new Error('Deletion intent signer unavailable');
    const actor = await authorization(); await current(actor);
    const issuedAt = now(), intent = deletionIntentSchema.parse({ ...input, version: 1, id: randomUUID(), endpoint,
      subjectId: actor.subjectId, bindingId: actor.bindingId, issuedAt, expiresAt: Math.min(issuedAt + 300, actor.bindingExpiresAt, actor.expiresAt) });
    const payloadJson = JSON.stringify(intent), preview = Object.freeze({ endpoint, id: intent.id, action: intent.action,
      requestId: intent.action === 'request' ? intent.id : intent.requestId, payloadJson,
      confirmation: `CONFIRM DELETION ${intent.action} ${intent.id} ${sha(payloadJson)}` });
    pending.set(preview, { actor, intent, payloadJson, state: 'prepared', controller: new AbortController() }); return preview;
  }
  function cancel(preview) { const operation = pending.get(preview); if (!operation) throw new Error('Unknown deletion preview'); operation.state = 'cancelled'; operation.controller.abort(); }
  async function execute(preview, confirmation) {
    const operation = pending.get(preview);
    if (!operation || operation.state !== 'prepared' || confirmation !== preview.confirmation) throw new Error('Exact deletion confirmation required');
    operation.state = 'executing'; const { actor, intent, payloadJson, controller } = operation;
    try {
      await current(actor,controller.signal);
      if (now() >= intent.expiresAt || signingPayload !== null) throw new Error('Deletion intent expired or signing busy');
      let signed; signingPayload = payloadJson;
      try { signed = await signIntent(payloadJson,'galaxy-deletion-intent+jws'); } finally { signingPayload = null; }
      await current(actor,controller.signal);
      const { result } = await request('submit',{signed},{actor,signal:controller.signal}); receipt(result, actor);
      if (result.id !== preview.requestId || intent.action === 'request' && result.requestHash !== sha(payloadJson)
        || intent.action === 'cancel' && result.state !== 'cancelled') throw new Error('Deletion acknowledgement mismatch');
      operation.state = 'completed'; return result;
    } catch(error) { if (operation.state !== 'cancelled') operation.state = 'failed'; throw error; }
  }
  async function read(input, options = {}) {
    const selected = deletionReadSchema.parse(input), {result,actor} = await request('read',selected,options); receipt(result,actor);
    const intent = deletionIntentSchema.parse(JSON.parse(result.request?.payloadJson));
    if (result.id !== selected.id || intent.id !== selected.id || intent.subjectId !== actor.subjectId || intent.endpoint !== endpoint
      || sha(result.request.payloadJson) !== result.requestHash || !Array.isArray(result.events) || result.events.length > 20) throw new Error('Deletion detail mismatch');
    let revision = selected.afterRevision;
    for (const event of result.events) {
      if (event.revision !== revision + 1) throw new Error('Deletion event mismatch');readDeletionEventPayload(event);revision++;
    }
    if (result.nextAfterRevision === null ? revision !== result.revision
      : result.nextAfterRevision !== revision || result.events.length !== 20 || revision >= result.revision) throw new Error('Deletion event cursor mismatch');
    return result;
  }
  async function query(input = {}, options = {}) {
    const selected = deletionQuerySchema.parse(input), {result,actor} = await request('query',selected,options);
    if (!Array.isArray(result.items) || result.items.length > selected.limit) throw new Error('Deletion query mismatch');
    result.items.forEach(value => receipt(value, actor));
    if (result.nextAfter !== null && result.nextAfter !== result.items.at(-1)?.id) throw new Error('Deletion query cursor mismatch');
    return result;
  }
  return Object.freeze({ prepare,execute,cancel,read,query,isSigningIntent: payload => signingPayload !== null && payload === signingPayload,
    config: async (_input={},options={}) => (await request('config',{},options)).result });
}

// Uses the preserved request verification key, so it remains usable after the
// subject's bindings and credentials have been removed.
export function createDeletionStatusClient({ endpoint, readSubjectId, signIntent, send = postDeletionStatusJson, now = () => Math.floor(Date.now()/1000) }) {
  if(validatePublicUrl(endpoint).origin!==endpoint||typeof readSubjectId!=='function'||typeof signIntent!=='function')throw new Error('Invalid deletion status client');
  const pending=new WeakMap();let signingPayload=null;
  async function prepare({requestId}) {
    const issuedAt=now(),intent=deletionStatusIntentSchema.parse({version:1,id:randomUUID(),action:'status',requestId,endpoint,
      subjectId:await readSubjectId(),issuedAt,expiresAt:issuedAt+300});
    const payloadJson=JSON.stringify(intent),preview=Object.freeze({requestId,endpoint,payloadJson,confirmation:`CONFIRM DELETION STATUS ${intent.id} ${sha(payloadJson)}`});
    pending.set(preview,{intent,payloadJson,state:'prepared',controller:new AbortController()});return preview;
  }
  function cancel(preview){const operation=pending.get(preview);if(!operation)throw new Error('Unknown status preview');operation.state='cancelled';operation.controller.abort();}
  async function execute(preview,confirmation){
    const operation=pending.get(preview);
    if(!operation||operation.state!=='prepared'||confirmation!==preview.confirmation)throw new Error('Exact status confirmation required');
    operation.state='executing';const {intent,payloadJson,controller}=operation;
    const current=async()=>{controller.signal.throwIfAborted();if(now()>=intent.expiresAt||await readSubjectId()!==intent.subjectId)throw new Error('Deletion status identity changed or expired');controller.signal.throwIfAborted();};
    try{
      await current();if(signingPayload!==null)throw new Error('Status signing busy');
      let signed;signingPayload=payloadJson;try{signed=await signIntent(payloadJson,'galaxy-deletion-status+jws');}finally{signingPayload=null;}
      await current();const result=await send(`${endpoint}/v1/deletion-requests/status`,{bodyJson:JSON.stringify({signed}),signal:controller.signal,maxBytes:65536});
      await current();
      if(result?.version!==1||result.endpoint!==endpoint||result.id!==intent.requestId||result.subjectId!==intent.subjectId||result.statusIntentId!==intent.id
        ||result.holderProofVerified!==true||!deletionStates.includes(result.state)||!Number.isInteger(result.revision)||result.revision<1
        ||typeof result.physicalDeletionPerformed!=='boolean'||result.serviceWideDeletionComplete!==false||result.executionImplemented!==true)throw new Error('Deletion status response mismatch');
      operation.state='completed';return result;
    }catch(error){if(operation.state!=='cancelled')operation.state='failed';throw error;}
  }
  return Object.freeze({prepare,execute,cancel,isSigningIntent:payload=>signingPayload!==null&&payload===signingPayload});
}
