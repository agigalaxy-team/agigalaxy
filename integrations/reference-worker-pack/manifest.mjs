import { workerPackManifestSchema } from '../../packages/galaxy-contracts/src/builder-support-v2-schema.mjs';

// Source references and the actual source digest come from the owner's selected
// release. Creating or reading this manifest never starts the Worker.
export function createReferenceWorkerManifest({ source, sourceHash, licenseSource }) {
  return workerPackManifestSchema.parse({ profile: 'galaxy-worker-pack/1', name: 'Reference arithmetic Worker', version: '0.1.0',
    source, sha256: sourceHash, license: 'Apache-2.0', licenseSource,
    dependencies: [{ kind: 'runtime', name: '@a2a-js/sdk', version: '1.1.0',
      source: 'https://github.com/a2aproject/a2a-js', license: 'Apache-2.0' }],
    modelRequirements: 'No model is used; only user-selected finite-number arithmetic.',
    environment: 'User-controlled Node >=24.13; loopback A2A 1.0 JSONRPC process; explicit host transport/TLS configuration.',
    permissions: [{ resource: 'Selected numerical input', purpose: 'Only the reviewed arithmetic command is sent to the selected Worker.', required: true }],
    configurationRequirements: 'An exact separately recorded Configuration and actual current Attempt are required for each use.',
    capabilities: ['Bounded sum and quotient of explicitly selected finite numbers; finite-delay cancellation.'],
    changes: 'Initial reference implementation; no professional or independent-third-party value claim.',
    installation: 'Run the reviewed worker.mjs directly in the owner host after installing the repository locked A2A dependency.',
    upgrade: 'Choose a separately reviewed source version and a new actual Attempt; keep the old references.',
    rollback: 'Stop this local process and return to the original host; already accepted facts remain.',
    runtimeLocation: 'user-controlled', automaticActivation: false });
}
