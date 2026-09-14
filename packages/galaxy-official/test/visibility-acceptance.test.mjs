import test from 'node:test';
import { verifyVisibilityAcceptance } from './visibility-acceptance-workflow.mjs';

test('HTTP subject visibility matrix preserves private IDs, counts, projections and revocations', async () => {
  console.log(JSON.stringify({ event: 'visibility_acceptance_pglite', ...await verifyVisibilityAcceptance() }));
});
