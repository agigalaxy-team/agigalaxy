import test from 'node:test';
import { verifyIdentityLinks } from './identity-links-workflow.mjs';

test('OIDC code login, local-key association, durable replay, owner export and unlink use the real HTTP API', { timeout: 60000 }, () => verifyIdentityLinks());
