import { generateKeyPairSync, randomUUID, randomBytes } from 'node:crypto';
import { CompactSign } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { createGalaxyGenesis } from '../../galaxy-core/src/galaxy-guid.mjs';
import { migrate } from "../src/infrastructure/database.mjs";
import { digest } from '../src/shared/digest.mjs';
import { createServices } from '../src/services.mjs';

export async function serviceFixture(scopes = ['binding', 'consent', 'case-teaser'], database = null, { migrateDatabase = true, repositories, now = 2000000000, retirement,resourceBudgetPolicy,incident,manifestProfile,endpoint='https://official.example.org',identityProviders=[],communityPolicy,syntheticCommunityQuota=true } = {}) {
  const db = database ?? new PGlite();
  try {
    if (migrateDatabase) await migrate(db);
    const server = generateKeyPairSync('ed25519');
    const local = generateKeyPairSync('ed25519');
    const genesis = createGalaxyGenesis({ publicKeyPem: local.publicKey.export({ type: 'spki', format: 'pem' }), originCode: '5' });
    const services = createServices({ repositories, retirement,resourceBudgetPolicy,incident,manifestProfile,identityProviders,communityPolicy, operator: 'Fixture', region: 'test', db, endpoint, kid: 'fixture', signingKey: server.privateKey,
      allowedScopes: scopes, now: () => now, trustedKeys: new Map([['fixture', {
        publicKeyPem: server.publicKey.export({ type: 'spki', format: 'pem' }), notBefore: now - 1, notAfter: now + 200000, revoked: false }]]) });
    // Legacy behavior fixtures isolate community authentication/quotas. This
    // explicit test double is NOT evidence for public Account verification.
    // account-public-http.test uses false; production createServices always enforces it.
    if (syntheticCommunityQuota) services.assistance.publicWrites = {
      consumeWithin: async () => ({ syntheticFixture: true, verificationNotTested: true }),
      markInvitationRespondedWithin: async () => {},
    };
    const { bindings, access, consents } = services;
    const sign = (payload, typ) => new CompactSign(Buffer.from(payload)).setProtectedHeader({ alg: 'Ed25519', typ }).sign(local.privateKey);
    // A contained-incident fixture represents an already enrolled subject;
    // predeclare it so the incident gate can exercise existing-user recovery
    // without weakening the production enrollment stop.
    if (incident) await db.query('INSERT INTO subjects(id,public_key,genesis_proof) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
      [genesis.id, genesis.genesisProof.publicKeyPem, JSON.stringify(genesis.genesisProof)]);
    const challenge = await bindings.challenge({ subjectId: genesis.id, genesisProof: genesis.genesisProof, installationId: randomUUID(), scopes });
    const bound = await bindings.bind({ challenge: challenge.challenge, clientSession: challenge.clientSession,
      signature: await sign(challenge.challenge, 'galaxy-binding-response+jws') });
    const credential = randomBytes(32).toString('base64url');
    const session = await access.challenge({ bindingId: bound.bindingId, credentialHash: digest(credential) });
    await access.activate({ ...session, signature: await sign(session.challenge, 'galaxy-session-response+jws') });
    const actor = await access.authenticate(credential);
    const authorize = async (payload, action = 'case.teaser.publish', overrides = {}) => {
      const payloadJson = JSON.stringify(payload);
      const intent = { version: 1, id: randomUUID(), subjectId: genesis.id, bindingId: bound.bindingId,
        endpoint: bindings.endpoint, objectId: payload.id, action, purpose: 'operational', recipient: bindings.endpoint,
        fields: Object.keys(payload), visibility: 'Private', viewers: [], payloadHash: digest(payloadJson), policyVersion: '0.1',
        issuedAt: now, expiresAt: now + 3600, ...overrides };
      await consents.create(actor, await sign(JSON.stringify(intent), 'galaxy-consent+jws'));
      return { consentId: intent.id, payloadJson };
    };
    return { ...services, db, actor, credential, authorize, now, genesis, signForTest: sign };
  } catch (error) { if (!database) await db.close(); throw error; }
}
