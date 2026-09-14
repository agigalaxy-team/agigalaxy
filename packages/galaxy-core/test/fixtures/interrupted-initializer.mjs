import { generateKeyPairSync } from 'node:crypto';
import { createGalaxyGenesis } from '../../src/galaxy-guid.mjs';
import { emptyState, addAuditEvent } from '../../src/domain/local-model.mjs';
import { localPaths } from '../../src/storage/files.mjs';
import { withLocalWrite } from '../../src/storage/write-lock.mjs';
import { publishInitialization } from '../../src/storage/initialization.mjs';

const [directory, stopAt] = process.argv.slice(2);
const keys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const genesis = createGalaxyGenesis({ publicKeyPem });
const identity = { id: genesis.id, genesisProof: genesis.genesisProof, version: 2 };
const state = emptyState();
addAuditEvent(state, 'galaxy_id.initialized', identity.id, { localOnly: true });
await withLocalWrite(directory, () => publishInitialization(localPaths(directory),
  { version: 1, identity, state, publicKeyPem, privateKeyPem }, async phase => {
    if (phase === stopAt) {
      process.send({ phase, id: identity.id });
      await new Promise(() => { setInterval(() => {}, 1000); });
    }
  }));
