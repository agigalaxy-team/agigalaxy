import { randomUUID, createHash } from 'node:crypto';
import { exportCreateSchema, exportIdSchema, exportPageSchema, exportBinarySchema, exportDatasets, exportViewScopes, sameExportViews } from './shared/data-export-schema.mjs';
import { postPublicJson, validatePublicUrl } from './public-fetch.mjs';
const sha = data => createHash('sha256').update(data).digest('hex');
const pause = (milliseconds, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(new Error('Export canceled.')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
  signal?.addEventListener('abort', abort, { once: true });
});

export function createDataExportClient({ endpoint, sessions, send = postPublicJson, now = () => Math.floor(Date.now() / 1000) }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !sessions) throw new Error('Invalid export client configuration.');
  const tickets = new Map();
  async function current(actor, signal) {
    signal?.throwIfAborted();
    if (!await sessions.isAuthorizationCurrent(actor) || !sessions.matchesAuthorization(actor)) throw new Error('Export authorization changed.');
    signal?.throwIfAborted();
  }
  async function request(method, input, { signal, actor: supplied } = {}) {
    const actor = supplied ?? await sessions.readAuthorization(endpoint);
    if (!actor?.scopes.includes('data-export')) throw new Error('Data export authorization required.');
    await current(actor, signal);
    try {
      let result;
      for (let retry = 0; ; retry++) {
        try { result = await send(`${endpoint}/v1/data-exports/${method}`, { bodyJson: JSON.stringify(input), credential: actor.credential, signal, maxBytes: 786432 }); break; }
        catch (error) {
          if (error.code !== 'GALAXY_RATE_LIMITED' || retry >= 2) throw error;
          await pause(Math.max(1, Math.min(60, error.retryAfterSeconds || 1)) * 1000, signal); await current(actor, signal);
        }
      }
      await current(actor, signal); return { result, actor };
    } catch (error) { if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(actor, 'remote-rejected'); throw error; }
  }
  async function specification(_input = {}, options = {}) {
    const { result, actor } = await request('specification', {}, options);
    if (result.version !== 1 || result.endpoint !== endpoint || result.subjectId !== actor.subjectId
      || !Array.isArray(result.datasets) || result.datasets.some(name => !exportDatasets.includes(name))
      || !Array.isArray(result.viewKinds) || result.viewKinds.some(kind => !Object.hasOwn(exportViewScopes, kind) || !actor.scopes.includes(exportViewScopes[kind]))
      || result.maxSelectedViews !== 32) throw new Error('Export specification mismatch.');
    return result;
  }
  async function create(input = {}, options = {}) {
    const selected = exportCreateSchema.parse({ id: randomUUID(), ...input });
    const { result, actor } = await request('create', selected, options);
    if (result.version !== 1 || result.endpoint !== endpoint || result.id !== selected.id || result.subjectId !== actor.subjectId
      || result.ownership !== (selected.views.length ? 'mixed-authorized-copy' : 'owner-copy')
      || !sameExportViews(result.views, selected.views)
      || result.revoked || !Number.isFinite(result.expiresAt) || result.expiresAt <= now()
      || result.expiresAt > now() + 600 || JSON.stringify(result.datasets) !== JSON.stringify(selected.datasets)
      || selected.datasets.some(name => typeof result.bounds?.[name] !== 'string' || result.bounds[name].length > 200)) throw new Error('Export ticket mismatch.');
    tickets.set(result.id, { actor, ticket: structuredClone(result) }); return result;
  }
  async function page(input, options = {}) {
    const selected = exportPageSchema.parse(input), operation = tickets.get(selected.id);
    if (!operation || operation.ticket.expiresAt <= now() || !operation.ticket.datasets.includes(selected.dataset)) throw new Error('Current export ticket required.');
    const { result } = await request('page', selected, { ...options, actor: operation.actor });
    const { sha256, ...snapshot } = result;
    if (sha(JSON.stringify(snapshot)) !== sha256 || snapshot.version !== 1 || snapshot.endpoint !== endpoint
      || snapshot.subjectId !== operation.actor.subjectId || snapshot.exportId !== selected.id || snapshot.dataset !== selected.dataset
      || snapshot.after !== selected.after || snapshot.through !== operation.ticket.bounds[selected.dataset]
      || snapshot.expiresAt !== operation.ticket.expiresAt || snapshot.selectionCutoff !== operation.ticket.selectionCutoff
      || snapshot.ownership !== (selected.dataset === 'authorized-views' ? 'current-authorized-view' : 'owner-copy') || !Array.isArray(snapshot.items) || snapshot.items.length > selected.limit
      || snapshot.nextAfter !== null && (typeof snapshot.nextAfter !== 'string' || snapshot.nextAfter <= selected.after || snapshot.nextAfter > snapshot.through)) throw new Error('Export page mismatch.');
    if (selected.dataset === 'authorized-views') {
      const index = Number(selected.after || '0'), expected = operation.ticket.views[index];
      if (snapshot.items.length !== (expected ? 1 : 0)
        || expected && (!sameExportViews([snapshot.items[0].selection], [expected])
          || snapshot.items[0].scope !== exportViewScopes[expected.kind]
          || snapshot.items[0].authority !== 'current-read-access-only; no republishing or continuing authorization')
        || snapshot.nextAfter !== (index + 1 < operation.ticket.views.length ? String(index + 1).padStart(8, '0') : null)) throw new Error('Export view mismatch.');
    }
    return result;
  }
  async function binary(input, options = {}) {
    const selected = exportBinarySchema.parse(input), operation = tickets.get(selected.id);
    if (!operation || operation.ticket.expiresAt <= now() || !operation.ticket.datasets.includes(selected.dataset)) throw new Error('Current export ticket required.');
    const { result } = await request('binary', selected, { ...options, actor: operation.actor });
    if (result.version !== 1 || result.endpoint !== endpoint || result.subjectId !== operation.actor.subjectId
      || result.exportId !== selected.id || result.dataset !== selected.dataset || result.recordId !== selected.recordId
      || result.offset !== selected.offset || !Number.isInteger(result.length) || result.length < 0
      || result.length > selected.length || !Number.isInteger(result.totalBytes) || result.totalBytes < 1
      || result.nextOffset !== null && (result.nextOffset !== selected.offset + result.length || result.nextOffset >= result.totalBytes)
      || result.complete !== (result.nextOffset === null)) throw new Error('Export binary chunk mismatch.');
    if (result.binaryContentAvailable) {
      if (typeof result.contentBase64 !== 'string' || Buffer.from(result.contentBase64, 'base64').length !== result.length) throw new Error('Export binary content mismatch.');
    } else if (result.contentBase64 !== undefined || result.length !== 0) throw new Error('Unavailable export binary mismatch.');
    return result;
  }
  async function revoke(input, options = {}) {
    const { id } = exportIdSchema.parse(input), { result } = await request('revoke', { id }, options);
    if (result.id !== id || result.revoked !== true) throw new Error('Export revocation mismatch.');
    tickets.delete(id); return result;
  }
  async function download(id, { onPage, signal } = {}) {
    if (typeof onPage !== 'function') throw new Error('Export page consumer required.');
    const operation = tickets.get(id); if (!operation) throw new Error('Unknown export ticket.');
    const pages = []; let totalRows = 0;
    for (const dataset of operation.ticket.datasets) {
      let after = '';
      do {
        if (pages.length >= 10000) throw new Error('Export page limit; download incomplete.');
        const value = await page({ id, dataset, after }, { signal });
        signal?.throwIfAborted(); await onPage(value); signal?.throwIfAborted();
        totalRows += value.items.length;
        pages.push({ dataset, after, nextAfter: value.nextAfter, sha256: value.sha256, rows: value.items.length });
        after = value.nextAfter;
      } while (after !== null);
    }
    await current(operation.actor, signal);
    return { version: 1, ticket: structuredClone(operation.ticket), pages, totalRows, complete: true,
      proofValidity: 'historical-not-current-authorization', generatedAt: new Date(now() * 1000).toISOString() };
  }
  return Object.freeze({ specification, create, page, binary, revoke, download });
}
