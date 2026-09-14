import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectGithubRun, githubEvidenceSource } from '../src/github-evidence.mjs';
import { checkedObservation } from '../src/evidence-source.mjs';

const now = 2000000000;
const reference = { provider: 'github-actions', owner: 'fixture', repository: 'example', runId: 1, attempt: 1, commit: 'a'.repeat(40) };
const run = { id: 1, run_attempt: 1, head_sha: reference.commit, repository: { full_name: 'fixture/example', private: false, id: 123 },
  updated_at: new Date(now * 1000).toISOString(), status: 'completed', conclusion: 'success' };

test('source changes are distinguished and mismatched run, attempt, commit or private repository is rejected', () => {
  const first = inspectGithubRun(reference, run, now);
  const changed = inspectGithubRun(reference, { ...run, conclusion: 'failure', updated_at: new Date((now + 1) * 1000).toISOString() }, now + 1);
  assert.notEqual(first.responseHash, changed.responseHash);
  assert.equal(changed.conclusion, 'failure'); assert.equal(changed.capabilitiesVerified, false);
  for (const patch of [{ id: 2 }, { run_attempt: 2 }, { head_sha: 'b'.repeat(40) },
    { repository: { ...run.repository, private: true } }, { repository: { ...run.repository, full_name: 'other/example' } },
    { updated_at: new Date((now + 301) * 1000).toISOString() }])
    assert.throws(() => inspectGithubRun(reference, { ...run, ...patch }, now));
});

test('adapter output cannot promote capability claims, change the source or extend freshness', () => {
  const observation = inspectGithubRun(reference, run, now);
  assert.equal(checkedObservation(githubEvidenceSource, observation, reference, now).strength, 'ci-execution-fact');
  for (const patch of [{ capabilitiesVerified: true }, { independence: 'independent' }, { attribution: 'verified' },
    { verifier: 'other' }, { collectedAt: now - 1 }, { validUntil: now }, { validUntil: now + 3601 },
    { source: { ...observation.source, commit: 'b'.repeat(40) } }, { authorized: true }])
    assert.throws(() => checkedObservation(githubEvidenceSource, { ...observation, ...patch }, reference, now));
});

test('GitHub collection retains a bounded observation and digest instead of source logs, artifacts or response extras', () => {
  const sourceOnly = 'SYNTHETIC-REMOTE-BODY-NOT-FOR-STORAGE';
  const response = { ...run, artifacts_url: 'https://example.org/private-artifacts', logs_url: 'https://example.org/logs',
    rawLog: sourceOnly, artifact: { bytes: sourceOnly }, repository: { ...run.repository, description: sourceOnly } };
  const observed = checkedObservation(githubEvidenceSource, inspectGithubRun(reference, response, now), reference, now);
  assert.equal(observed.status, 'observed');
  assert.equal(observed.strength, 'ci-execution-fact');
  assert.ok(!JSON.stringify(observed).includes(sourceOnly));
  assert.ok(!JSON.stringify(observed).includes('https://example.org/'));
  assert.notEqual(observed.responseHash, inspectGithubRun(reference, run, now).responseHash,
    'discarded source response still contributes to its digest');
  assert.throws(() => checkedObservation(githubEvidenceSource, { ...observed, rawResponse: response }, reference, now));
  assert.throws(() => githubEvidenceSource.referenceSchema.parse({ ...reference, artifact: { content: sourceOnly } }));
});
