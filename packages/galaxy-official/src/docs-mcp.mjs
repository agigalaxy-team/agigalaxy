import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import bundle from '../public-docs.json' with { type: 'json' };

const topics = ['overview', 'installation', 'compatibility', 'privacy'];
const versions = ['v0.1', 'v0.2'];
const version = z.enum(versions);
const topic = z.enum(topics);
function document(v, name) {
  if (!versions.includes(v) || !topics.includes(name)) throw new Error('Unknown public document or version.');
  return bundle.versions[v][name];
}
export function createDocsMcp() {
  const server = new McpServer({ name: 'galaxy-public-docs', version: '0.1.0' });
  for (const v of versions) for (const name of topics) {
    server.registerResource(v === 'v0.1' ? name : `${name}-${v}`, `galaxy-docs://${v}/${name}`, { mimeType: 'text/markdown', title: `${name} ${v}` },
      uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: document(v, name) }] }));
  }
  server.registerResource('versioned-public-document', new ResourceTemplate('galaxy-docs://{version}/{topic}', { list: undefined }),
    { mimeType: 'text/markdown', description: 'Only reviewed public documents; current v0.2 and preserved v0.1.' },
    (uri, values) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: document(values.version, values.topic) }] }));
  server.registerTool('docs_get', { description: 'Read a reviewed public Galaxy document.',
    inputSchema: z.strictObject({ version, topic }), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    input => ({ content: [{ type: 'text', text: document(input.version, input.topic) }] }));
  server.registerTool('docs_search', { description: 'Search the four reviewed public documents in the selected version. No private data or network access.',
    inputSchema: z.strictObject({ version, query: z.string().trim().min(1).max(128) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    input => ({ content: [{ type: 'text', text: JSON.stringify({ version: input.version,
      results: topics.filter(name => document(input.version, name).toLowerCase().includes(input.query.toLowerCase()))
        .map(name => ({ topic: name, uri: `galaxy-docs://${input.version}/${name}` })) }) }] }));
  for (const name of ['installation', 'privacy']) {
    server.registerPrompt(`explain-${name}`, { description: `Explain the public ${name} document. No actions are authorized by this prompt.` },
      () => ({ messages: [{ role: 'user', content: { type: 'text', text: `请解释以下公开文档，并明确当前限制。仅作说明，不执行初始化、连接或发布。\n\n${document(bundle.version, name)}` } }] }));
  }
  return server;
}

export async function handleDocsMcp(request, response, parsedBody) {
  const server = createDocsMcp();
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try { await server.connect(transport); await transport.handleRequest(request, response, parsedBody); }
  finally { await server.close(); }
}
