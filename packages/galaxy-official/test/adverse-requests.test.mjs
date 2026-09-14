import test from 'node:test';
import { verifyAdverseRequests } from './adverse-requests-workflow.mjs';
test('untrusted webhook, arbitrary source URLs and malformed requests cannot create evidence', async () => {
  console.log(JSON.stringify({ event: 'adverse_requests_pglite', ...await verifyAdverseRequests() }));
});
