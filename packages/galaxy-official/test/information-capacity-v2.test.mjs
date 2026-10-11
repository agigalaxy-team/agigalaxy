import test from 'node:test';
import assert from 'node:assert/strict';
import { runInformationCapacityV2, capacityCostObservation } from './information-capacity-v2-workflow.mjs';

test('current signed HTTP sources and retained metadata scale without leaking hidden data in a bounded local fixture', { timeout: 120000 }, async t => {
  const report = await runInformationCapacityV2(null, { profile: { levels: [2, 4], fanouts: [1, 2], concurrency: [1, 2], requestsPerPhase: 8, budgetSamplesPerPhase: 4 } });
  assert.equal(report.allMeasuredRequestsSucceeded, true);
  assert.equal(report.environment.actualPostgresConcurrency, false);
  assert.deepEqual(report.stages.map(stage => stage.counts.retained_versions), [2, 4]);
  assert.ok(report.stages[1].ownerBudgetBytes > report.stages[0].ownerBudgetBytes);
  assert.equal(report.phases.length, 20);
  assert.ok(report.phases.every(phase => phase.kind === 'authorized-resource-budget-aggregate'
    ? phase.samples === 4 && phase.latencyMs.count === 4 : phase.semanticProbes.after && phase.responses === 8 && phase.body.responses === 8));
  assert.equal(report.resourceBudget.changed, false); assert.equal(report.requestQuota.productionPolicyChanged, false);
  assert.equal(report.cost.state, 'unknown'); assert.equal(report.cost.amount, null); assert.equal(report.cost.perRequestCost, null);
  assert.deepEqual(report.cleanup, { apiClosed: true, localDatabaseClosed: true });
  t.diagnostic(JSON.stringify({ event: 'information_capacity_local_fixture', ...report }));
});

test('cost observations preserve provenance and an observed zero never fills an unknown bill', () => {
  const unavailable = capacityCostObservation(); assert.equal(unavailable.amount, null); assert.equal(unavailable.newPaidProcurementExecuted, false);
  const observed = capacityCostObservation({ version: 2, currency: 'USD', kind: 'billing-export', amount: 0,
    periodStart: '2026-09-01T00:00:00Z', periodEnd: '2026-10-01T00:00:00Z', observedAt: '2026-10-01T12:00:00Z', budget: null,
    scope: { dimension: 'resourceId', count: 1, sha256: 'a'.repeat(64), attribution: 'unallocated' } });
  assert.equal(observed.amount, 0); assert.equal(observed.state, 'billing-observed');
  assert.equal(observed.observedAt, '2026-10-01T12:00:00Z'); assert.equal(observed.attribution, 'unallocated'); assert.equal(observed.perRequestCost, null);
  assert.throws(() => capacityCostObservation({ amount: 0 }));
});
