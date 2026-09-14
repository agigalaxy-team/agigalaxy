import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRemoteToolServer } from '../../galaxy-edge-mcp/src/remote-server.mjs';

test('real MCP client discovers explicit tools and publication requires host approval of original preview', async () => {
  let approved = false, writes = 0, queries = 0, cancellations = 0,lastQuery,lastSearch;
  const preview = Object.freeze({ endpoint: 'https://official.example.org', eventId: 'event',
    payloadJson: '{"title":"Fixture"}', intentJson: '{"visibility":"Private"}', confirmation: 'exact host confirmation' });
  const runtime = createRemoteToolServer({
    authorizePublication: async value => { assert.equal(value, preview); return approved; },
    controller: {
      querySearch: async input => {lastSearch=input;return {type:input.type,items:[]};},
      queryHistory: async input => { queries++;lastQuery=input; return { items: [], query: input.query }; },
      getCase: async () => ({ events: [] }), listPublicationDrafts: async () => [],
      preparePublication: async () => preview,
      executePublication: async (value, confirmation) => {
        assert.equal(value, preview); assert.equal(confirmation, preview.confirmation); writes++; return { state: 'acknowledged' };
      },
      cancelPublication(value) { assert.equal(value, preview); cancellations++; }, reconcilePublication: async () => ({ state: 'unknown' })
    } });
  const client = new Client({ name: 'galaxy-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools(); assert.equal(listed.tools.length, 8);
    assert.equal(listed.tools.find(tool=>tool.name==='galaxy_remote_search').annotations.readOnlyHint,true);
    assert.equal(listed.tools.find(tool => tool.name === 'galaxy_remote_history_query').annotations.readOnlyHint, true);
    assert.equal(listed.tools.find(tool => tool.name === 'galaxy_publication_reconcile').annotations.readOnlyHint, false);
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    const unpack = value => JSON.parse(value.content[0].text);
    assert.equal(unpack(await call('galaxy_remote_search',{type:'proof',query:{query:'compiler',conclusion:'failure',limit:8}})).type,'proof');
    assert.deepEqual(lastSearch,{type:'proof',query:{query:'compiler',conclusion:'failure',limit:8}});
    for(const type of ['worker','hub']){
      assert.equal(unpack(await call('galaxy_remote_search',{type,query:{query:'compiler'}})).type,type);
      assert.equal(lastSearch.type,type);
    }
    await call('galaxy_remote_history_query', { query: 'compiler',capabilityId:'compiler',verificationStrength:'ci-execution-fact' }); assert.equal(queries, 1);
    assert.equal(lastQuery.capabilityId,'compiler');assert.equal(lastQuery.verificationStrength,'ci-execution-fact');
    const input = { localCaseId: 'case_' + '0'.repeat(32) };
    const first = unpack(await call('galaxy_publication_prepare', input));
    assert.equal(first.payloadJson, preview.payloadJson); assert.equal(writes, 0);
    assert.equal((await call('galaxy_publication_execute', { handle: first.handle })).isError, true);
    assert.equal(writes, 0); assert.equal(cancellations, 1);
    approved = true;
    const second = unpack(await call('galaxy_publication_prepare', input));
    assert.equal(unpack(await call('galaxy_publication_execute', { handle: second.handle })).state, 'acknowledged');
    assert.equal(writes, 1);
    assert.equal((await call('galaxy_publication_execute', { handle: second.handle })).isError, true);
    const third = unpack(await call('galaxy_publication_prepare', input));
    await call('galaxy_publication_cancel', { handle: third.handle });
    assert.equal((await call('galaxy_publication_execute', { handle: third.handle })).isError, true);
    assert.equal(writes, 1);
    assert.equal(unpack(await call('galaxy_publication_reconcile', input)).state, 'unknown');
  } finally { await client.close(); await runtime.close(); }
});
