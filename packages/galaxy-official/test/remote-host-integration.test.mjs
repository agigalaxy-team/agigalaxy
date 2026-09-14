import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { serviceFixture } from './service-fixture.mjs';
import { createLocalHostRuntime } from '../src/local-host-runtime.mjs';
import { createRemoteToolServer } from '../../galaxy-edge-mcp/src/remote-server.mjs';
import { initializeGalaxyIntegration, createCaseDraft } from '../../galaxy-core/src/local-store.mjs';
import { createConnectionProfile, saveConnectionProfile } from '../../galaxy-core/src/connection-profile.mjs';

test('real MCP publication uses the local signer, fixed approval, service records and authorized history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-mcp-host-'));
  const scopes = ['binding', 'consent', 'case-teaser', 'history'];
  const f = await serviceFixture(scopes);
  t.after(async () => { await f.db.close(); await rm(directory, { recursive: true, force: true }); });
  await initializeGalaxyIntegration(directory, { profile: 'coding-case', source: 'test' });
  const endpoint = f.bindings.endpoint, installationId = randomUUID();
  await saveConnectionProfile(directory, createConnectionProfile({ targets: [{ id: 'official', kind: 'official', endpoint }],
    scopes: [{ id: 'bind', targetId: 'official', action: 'binding', recipient: endpoint, purpose: 'Explicit connection',
      visibleFields: ['subjectId', 'genesisProof', 'installationId', 'scopes'], expiresAt: new Date((f.now + 90000) * 1000).toISOString() }] }));
  const identityBefore = await readFile(join(directory, 'galaxy-id.json'));
  const draft = await createCaseDraft(directory, { title: 'MCP publication fixture', failureSummary: 'Synthetic compiler failure' });
  let writes = 0, handshakes = 0, publicationActor = null;
  const runtime = createLocalHostRuntime({ endpoint, dataDirectory: directory, installationId, scopes, bindingScopeId: 'bind',
    trustedKeys: f.bindings.trustedKeys, manifest: (await f.manifest.get()).document, now: () => f.now,
    connectionSend: async (url, options) => {
      handshakes++; const body = JSON.parse(options.bodyJson);
      const handlers = { '/v1/binding-challenges': () => f.bindings.challenge(body), '/v1/bindings': () => f.bindings.bind(body),
        '/v1/session-challenges': () => f.access.challenge(body), '/v1/sessions': () => f.access.activate(body) };
      return handlers[new URL(url).pathname]();
    },
    consentSend: async (_url, options) => { writes++; publicationActor = await f.access.authenticate(options.credential, 'consent');
      return f.consents.create(publicationActor, JSON.parse(options.bodyJson).signedIntent); },
    caseSend: async (_url, options) => { writes++; return f.cases.submit(await f.access.authenticate(options.credential, 'case-teaser'), JSON.parse(options.bodyJson)); },
    caseRead: async (url, options) => f.cases.get(await f.access.authenticate(options.credential, 'case-teaser'), new URL(url).pathname.split('/').at(-1)),
    historySend: async (_url, options) => f.history.query(await f.access.authenticate(options.credential, 'history'), JSON.parse(options.bodyJson)),
  });
  t.after(() => runtime.close());
  let approved = false, shown = null;
  const remote = createRemoteToolServer({ controller: runtime.controller, helpFlow: runtime.helpFlow, authorizePublication: async preview => {
    shown = preview; assert.equal(preview.endpoint, endpoint); assert.equal(JSON.parse(preview.payloadJson).title, draft.title); return approved;
  } });
  const client = new Client({ name: 'galaxy-real-host-test', version: '1' });
  t.after(async () => { await client.close(); await remote.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([remote.server.connect(serverTransport), client.connect(clientTransport)]);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const unpack = value => JSON.parse(value.content[0].text);
  const toolNames = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of [
    'galaxy_remote_search', 'galaxy_remote_history_query', 'galaxy_remote_case_read',
    'galaxy_publication_drafts_list', 'galaxy_publication_prepare', 'galaxy_publication_execute',
    'galaxy_publication_cancel', 'galaxy_publication_reconcile',
    'galaxy_help_start', 'galaxy_help_get', 'galaxy_help_query', 'galaxy_help_return',
  ]) assert.ok(toolNames.includes(name), name);
  const help = unpack(await call('galaxy_help_start', { localTaskRef: 'original-task:compiler' }));
  assert.equal(help.subjectId, JSON.parse(identityBefore).id);
  assert.equal(help.paths.length, 4);
  assert.equal(help.cloudSync, 'off');
  assert.equal(unpack(await call('galaxy_help_get', { sessionId: help.id })).id, help.id);
  assert.equal((await call('galaxy_remote_history_query', { query: 'MCP' })).isError, true);
  assert.equal(handshakes, 0); assert.equal(writes, 0);
  const connection = await runtime.controller.prepare();
  await runtime.controller.execute(connection, connection.confirmation); assert.equal(handshakes, 4);
  const listed = unpack(await call('galaxy_publication_drafts_list'));
  assert.equal(listed[0].localCaseId, draft.id); assert.equal(writes, 0);
  const input = { localCaseId: draft.id, visibility: 'Public' };
  let prepared = unpack(await call('galaxy_publication_prepare', input));
  assert.equal(prepared.endpoint, endpoint); assert.equal(writes, 0);
  assert.equal((await call('galaxy_publication_execute', { handle: prepared.handle, approved: true })).isError, true);
  assert.equal(shown, null); // Tool arguments cannot approve for the host.
  assert.equal((await call('galaxy_publication_execute', { handle: prepared.handle })).isError, true);
  assert.equal(writes, 0); assert.equal((await f.db.query('SELECT id FROM cases')).rows.length, 0);
  approved = true;
  prepared = unpack(await call('galaxy_publication_prepare', input));
  const response = await call('galaxy_publication_execute', { handle: prepared.handle });
  assert.notEqual(response.isError, true); const receipt = unpack(response);
  assert.equal(receipt.eventId, shown.eventId); assert.equal(writes, 2);
  const history = unpack(await call('galaxy_remote_history_query', { query: 'MCP publication' }));
  assert.equal(history.items.length, 1); assert.equal(history.items[0].caseId, receipt.caseId);
  assert.equal(unpack(await call('galaxy_remote_case_read', { caseId: receipt.caseId })).verification, 'unverified');
  assert.equal((await call('galaxy_publication_execute', { handle: prepared.handle })).isError, true); assert.equal(writes, 2);
  const consent = JSON.parse(shown.intentJson);
  await f.consents.revoke(publicationActor, consent.id);
  assert.equal((await f.history.query(null, { query: 'MCP publication' })).items.length, 0);
  runtime.controller.disconnect();
  assert.equal((await call('galaxy_remote_history_query', { query: 'MCP' })).isError, true);
  const helpReturn = unpack(await call('galaxy_help_return', { sessionId: help.id, expectedRevision: help.revision }));
  assert.equal(helpReturn.handoff.localTaskRef, 'original-task:compiler');
  assert.equal(helpReturn.remoteOperationsCanceled, false);
  runtime.close();
  assert.equal((await call('galaxy_help_get', { sessionId: help.id })).isError, true);
  assert.deepEqual(await readFile(join(directory, 'galaxy-id.json')), identityBefore);
});
