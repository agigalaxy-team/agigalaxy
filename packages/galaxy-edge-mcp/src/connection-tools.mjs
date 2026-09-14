import { getGalaxyConnectionStatus } from '../../galaxy-core/src/connection-profile.mjs';

export function registerConnectionTools(server, dataDir) {
  for (const name of ['galaxy_connection_preview', 'galaxy_connection_status']) {
    server.registerTool(name, {
      title: name === 'galaxy_connection_preview' ? 'Preview local Galaxy connection intentions' : 'Read local Galaxy connection status',
      description: 'Read-only local Connection Profile and Scope contract. Does not fetch a Manifest, create an identity, sign, bind, or send data. Configured endpoints remain unverified and disconnected.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async () => ({ content: [{ type: 'text', text: JSON.stringify(await getGalaxyConnectionStatus(dataDir), null, 2) }] }));
  }
}
