import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompactSign } from 'jose';
import { initializeGalaxyIntegration, createCaseDraft } from '../../galaxy-core/src/local-store.mjs';
import { createConnectionProfile, saveConnectionProfile } from '../../galaxy-core/src/connection-profile.mjs';
import { createLocalHostRuntime } from "../src/clients/local/host-runtime.mjs";
import { verifyNetworkManifest } from '../src/verification/manifest.mjs';
import { createApi } from '../src/http.mjs';
import { serviceFixture } from './service-fixture.mjs';
import { verifyConnectionAcceptance } from './connection-acceptance-workflow.mjs';

test('existing local identity completes real HTTP binding/query/revocation while unapproved writes stay absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-connection-acceptance-'));
  const now = Math.floor(Date.now() / 1000);
  const fixture = await serviceFixture(['binding', 'history', 'case-teaser', 'proof', 'context'], null, { now });
  const endpoint = fixture.bindings.endpoint, api = createApi(fixture);
  try {
    await initializeGalaxyIntegration(directory, { profile: 'coding-case', source: 'test' });
    await saveConnectionProfile(directory, createConnectionProfile({ targets: [{ id: 'official', kind: 'official', endpoint }],
      scopes: [{ id: 'binding-intent', targetId: 'official', action: 'binding', recipient: endpoint, purpose: 'Synthetic connection acceptance',
        visibleFields: ['subjectId', 'genesisProof', 'installationId', 'scopes'], expiresAt: new Date((now + 90000) * 1000).toISOString() }] }));
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const result = await verifyConnectionAcceptance({ address: `http://127.0.0.1:${api.address().port}`, endpoint, directory, db: fixture.db,
      trustedKeys: fixture.bindings.trustedKeys, modules: { createLocalHostRuntime, createCaseDraft, verifyNetworkManifest, CompactSign } });
    console.log(JSON.stringify({ event: 'connection_acceptance_local_http', ...result }));
  } finally {
    api.closeAllConnections();await new Promise(resolve => api.close(resolve));
    await fixture.db.close();await rm(directory, { recursive: true, force: true });
  }
});
