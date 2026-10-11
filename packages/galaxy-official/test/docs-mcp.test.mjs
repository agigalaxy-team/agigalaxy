import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApi } from '../src/http.mjs';
import { handleDocsMcp } from '../src/docs-mcp.mjs';
import bundle from '../public-docs.json' with { type: 'json' };
import { request as httpRequest } from 'node:http';

test('real MCP HTTP client reads only public resources, templates, tools and explicit prompts', async () => {
  const bindings = { endpoint: 'http://127.0.0.1' };
  // The catalog check deliberately reads every historical document over both MCP surfaces.
  const api = createApi({ bindings, docsMcp: handleDocsMcp, rateLimit: 200 });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  bindings.endpoint = `http://127.0.0.1:${api.address().port}`;
  const client = new Client({ name: 'galaxy-docs-test', version: '0.1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(bindings.endpoint + '/mcp/docs')));
    assert.equal((await client.listResources()).resources.length, (Object.keys(bundle.versions).length + 1) * 4);
    assert.equal((await client.listResourceTemplates()).resourceTemplates.length, 1);
    const read = await client.readResource({ uri: 'galaxy-docs://v0.1/overview' });
    assert.equal(read.contents[0].text, bundle.versions['v0.1'].overview);
    const current = await client.readResource({ uri: `galaxy-docs://${bundle.version}/overview` });
    assert.equal(current.contents[0].text, bundle.documents.overview);
    const alias = await client.readResource({ uri: 'galaxy-docs://current/overview' });
    assert.equal(alias.contents[0].text, bundle.documents.overview);
    assert.notEqual(current.contents[0].text, read.contents[0].text);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['docs_get', 'docs_search']);
    const found = await client.callTool({ name: 'docs_search', arguments: { version: 'v0.1', query: 'Galaxy' } });
    assert.ok(JSON.parse(found.content[0].text).results.length > 0);
    for (const [v, documents] of Object.entries(bundle.versions)) for (const [name, text] of Object.entries(documents)) {
      const resource = await client.readResource({ uri: `galaxy-docs://${v}/${name}` });
      assert.equal(resource.contents[0].text, text);
      const tool = await client.callTool({ name: 'docs_get', arguments: { version: v, topic: name } });
      assert.equal(tool.content[0].text, text);
    }
    const query = bundle.documents.overview.split(/\s+/).find(word => word && word !== '#').slice(0, 128);
    const latest = await client.callTool({ name: 'docs_search', arguments: { query } });
    const matches = JSON.parse(latest.content[0].text).results;
    assert.ok(matches.length > 0);
    assert.equal(JSON.parse(latest.content[0].text).version, bundle.version);
    assert.ok(matches.every(item => item.uri.startsWith(`galaxy-docs://${bundle.version}/`)));
    assert.equal((await client.callTool({ name: 'docs_get', arguments: { topic: 'compatibility' } })).content[0].text, bundle.documents.compatibility);
    assert.equal((await client.callTool({ name: 'docs_get', arguments: { topic: 'privacy', internalPath: '../private' } })).isError, true);
    assert.equal((await client.callTool({ name: 'docs_get', arguments: { version: 'v9', topic: 'overview' } })).isError, true);
    assert.equal((await client.callTool({ name: 'docs_get', arguments: { version: 'v0.1', topic: '../private-key' } })).isError, true);
    await assert.rejects(client.readResource({ uri: 'galaxy-docs://v9/private' }));
    assert.equal((await client.listPrompts()).prompts.length, 2);
    const prompt = await client.getPrompt({ name: 'explain-privacy' });
    assert.ok(prompt.messages[0].content.text.includes(bundle.documents.privacy));
    assert.equal((await fetch(bindings.endpoint + '/mcp/docs')).status, 405);
    const request = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) };
    const foreignHostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(bindings.endpoint + '/mcp/docs', { method: 'POST',
        headers: { ...request.headers, Host: 'foreign.example.org' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end(request.body);
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(bindings.endpoint + '/mcp/docs', { ...request,
      headers: { ...request.headers, Origin: 'https://foreign.example.org' } })).status, 403);
    assert.equal((await fetch(bindings.endpoint + '/mcp/docs', { ...request,
      headers: { ...request.headers, 'MCP-Protocol-Version': '1900-01-01' } })).status, 400);
    assert.equal((await fetch(bindings.endpoint + '/mcp/docs', { ...request, body: 'x'.repeat(32769) })).status, 413);
  } finally {
    await client.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
  }
});
