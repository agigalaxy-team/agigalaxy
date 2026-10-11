import test from 'node:test';
import assert from 'node:assert/strict';
import { buildersContinuityFixture } from './builders-client-continuity-workflow.mjs';
import { verifyWorkerPackOriginalHostExecution } from './worker-pack-use-client-workflow.mjs';

test('actual Worker Pack support read withholds private content after same-subject rebind', { timeout: 60000 }, async () => {
  const f = await buildersContinuityFixture();
  try {
    await f.client.submit(f.event, { confirmed: true, visibility: 'Private' });
    f.state.reconnectAfterRead = '/v2/builders/support/read';
    await assert.rejects(f.workerClient.support(f.event.builderId), /身份|连接/);
    assert.equal(f.businessCalls(), 1);
  } finally { await f.close(); }
});

test('original-host execution is associated with exact Configuration/Attempt/Result and only original Pack receipt recovers',
  { timeout: 60000 }, async () => {
    const observed = await verifyWorkerPackOriginalHostExecution();
    assert.equal(observed.hostRuns, 1); assert.equal(observed.originalOperationRecovered, 'acknowledged');
  });
