import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmailCodeFixtureRealmPatch, planEmailCodeRealm } from './realm-plan.mjs';

function fixture() {
  return {
    realm: 'galaxy', verifyEmail: true, browserFlow: 'browser', registrationFlow: 'registration', resetCredentialsFlow: 'reset credentials',
    authenticationFlows: [
      { alias: 'browser', builtIn: true, authenticationExecutions: [{ authenticator: 'auth-username-password-form', requirement: 'REQUIRED' }] },
      { alias: 'registration', builtIn: true, authenticationExecutions: [{ authenticator: 'registration-page-form' }] },
      { alias: 'reset credentials', builtIn: true, topLevel: true, authenticationExecutions: [
        { authenticator: 'reset-credentials-choose-user', authenticatorConfig: 'choose options', priority: 10, requirement: 'REQUIRED' },
        { authenticator: 'reset-credential-email', authenticatorConfig: 'mail options', priority: 20, requirement: 'REQUIRED' },
        { authenticator: 'reset-password', priority: 30, requirement: 'REQUIRED' },
        { flowAlias: 'reset factors', authenticatorFlow: true, priority: 40, requirement: 'CONDITIONAL' },
      ] },
      { alias: 'reset factors', builtIn: true, topLevel: false, authenticationExecutions: [{ authenticator: 'reset-otp', requirement: 'OPTIONAL' }] },
    ],
    authenticatorConfig: [{ alias: 'mail options', config: { 'force-login': 'true' } }, { alias: 'choose options', config: { retained: 'setting' } }],
    requiredActions: [{ alias: 'VERIFY_EMAIL', providerId: 'VERIFY_EMAIL', enabled: true, priority: 30, config: { max_auth_age: '300', 'email-code-enabled': 'false' } }],
    clients: [{ clientId: 'existing', redirectUris: ['https://rp.example.invalid/callback'], publicClient: true }],
  };
}

test('email-code plan copies reset tree and adapts email plus explicit re-selection; password and original flows remain', () => {
  const original = fixture();
  const result = planEmailCodeRealm(original, { emailTheme: 'candidate-a' });
  assert.deepEqual(result.authenticationFlows.slice(0, 4), original.authenticationFlows);
  assert.deepEqual(result.clients, original.clients);
  assert.equal(result.browserFlow, 'browser');
  assert.equal(result.registrationFlow, 'registration');
  const changed = result.authenticationFlows.find((flow) => flow.alias === result.resetCredentialsFlow);
  assert.deepEqual(changed.authenticationExecutions[0], {
    authenticator: 'galaxy-reset-choose-user', authenticatorConfig: 'choose options', priority: 10, requirement: 'REQUIRED',
  });
  assert.equal(changed.authenticationExecutions[1].authenticator, 'galaxy-reset-email-code');
  assert.equal(changed.authenticationExecutions[2].authenticator, 'reset-password');
  assert.equal(changed.authenticationExecutions[3].flowAlias, 'galaxy reset email code / reset factors');
  assert.equal(result.authenticatorConfig.at(-1).config['force-login'], 'true');
  assert.equal(result.requiredActions[0].providerId, 'VERIFY_EMAIL');
  assert.equal(result.requiredActions[0].priority, 30);
  assert.equal(result.requiredActions[0].config.max_auth_age, '300');
  assert.equal(result.requiredActions[0].config['email-code-enabled'], 'true');
  assert.equal(original.requiredActions[0].config['email-code-enabled'], 'false');
  assert.equal(result.authenticatorConfig.at(-1).config['email-code-enabled'], undefined);
  assert.equal(result.emailTheme, 'candidate-a');
  assert.equal(original.emailTheme, undefined);
});

test('repeat planning retains the selected flow and can use bounded fixture timings without duplicate execution', () => {
  const initial = planEmailCodeRealm(fixture());
  const next = planEmailCodeRealm(initial, { policy: { 'code-ttl-seconds': '3', 'resend-seconds': '1', 'max-attempts': '2' } });
  assert.equal(next.authenticationFlows.length, initial.authenticationFlows.length);
  assert.equal(next.authenticatorConfig.length, initial.authenticatorConfig.length);
  assert.equal(next.authenticatorConfig.at(-1).config['code-ttl-seconds'], '3');
  assert.equal(next.requiredActions[0].config['max-attempts'], '2');
  assert.equal(next.requiredActions[0].config['email-code-enabled'], 'true');
  assert.equal(next.authenticatorConfig.at(-1).config['email-code-enabled'], undefined);
  assert.equal(next.authenticationFlows.find((flow) => flow.alias === next.resetCredentialsFlow)
    .authenticationExecutions.filter((step) => step.authenticator === 'galaxy-reset-choose-user').length, 1);
  assert.equal(next.authenticationFlows.find((flow) => flow.alias === 'reset credentials').authenticationExecutions[0].authenticator, 'reset-credentials-choose-user');
  // Upgrade an already selected email-code flow from before the thin chooser
  // existed, without creating another flow or changing its requirements/config.
  const earlier = structuredClone(initial);
  earlier.authenticationFlows.find((flow) => flow.alias === earlier.resetCredentialsFlow).authenticationExecutions[0].authenticator = 'reset-credentials-choose-user';
  const upgraded = planEmailCodeRealm(earlier);
  assert.equal(upgraded.authenticationFlows.length, earlier.authenticationFlows.length);
  assert.deepEqual(upgraded.authenticationFlows.find((flow) => flow.alias === upgraded.resetCredentialsFlow).authenticationExecutions[0], {
    authenticator: 'galaxy-reset-choose-user', authenticatorConfig: 'choose options', priority: 10, requirement: 'REQUIRED',
  });
  const patch = createEmailCodeFixtureRealmPatch({ policy: { 'code-ttl-seconds': '40', 'resend-seconds': '2' } });
  assert.equal(patch.requiredActions.find((action) => action.alias === 'VERIFY_EMAIL').config['code-ttl-seconds'], '40');
  assert.equal(patch.requiredActions.find((action) => action.alias === 'VERIFY_EMAIL').config['email-code-enabled'], 'true');
  assert.ok(patch.requiredActions.find((action) => action.alias === 'VERIFY_EMAIL').priority
    < patch.requiredActions.find((action) => action.alias === 'UPDATE_PASSWORD').priority);
  assert.equal(patch.authenticationFlows.find((flow) => flow.alias === patch.resetCredentialsFlow).authenticationExecutions[1].authenticator, 'galaxy-reset-email-code');
});

test('unknown or disabled action / missing reset flow fails instead of inventing an authentication policy', () => {
  assert.throws(() => planEmailCodeRealm({ ...fixture(), realm: 'other' }));
  assert.throws(() => planEmailCodeRealm({ ...fixture(), verifyEmail: false }));
  assert.throws(() => planEmailCodeRealm({ ...fixture(), authenticationFlows: [] }));
  const disabled = fixture();
  disabled.requiredActions[0].enabled = false;
  assert.throws(() => planEmailCodeRealm(disabled));
  assert.throws(() => planEmailCodeRealm(fixture(), { policy: { 'code-ttl-seconds': '0' } }));
});
