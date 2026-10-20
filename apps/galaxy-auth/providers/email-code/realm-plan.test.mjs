import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmailCodeFixtureRealmPatch, planEmailCodeRealm, planRegistrationContinuationRealm } from './realm-plan.mjs';

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

function registrationFixture() {
  const result = fixture();
  result.registrationEmailAsUsername = true;
  result.duplicateEmailsAllowed = false;
  result.registrationAllowed = true;
  result.requiredActions[0].config['email-code-enabled'] = 'true';
  result.authenticationFlows[1] = {
    id: 'original-registration', alias: 'registration', providerId: 'basic-flow', builtIn: true, topLevel: true,
    authenticationExecutions: [{ id: 'form-execution', flowAlias: 'registration form', authenticator: 'registration-page-form', authenticatorFlow: true, requirement: 'REQUIRED', priority: 10 }],
  };
  result.authenticationFlows.push({
    id: 'original-form', alias: 'registration form', providerId: 'form-flow', topLevel: false, builtIn: true,
    authenticationExecutions: [
      { id: 'creation', authenticator: 'registration-user-creation', requirement: 'REQUIRED', priority: 20 },
      { id: 'password', authenticator: 'registration-password-action', authenticatorConfig: 'registration password', requirement: 'REQUIRED', priority: 50 },
      { id: 'captcha', authenticator: 'registration-recaptcha-action', requirement: 'DISABLED', priority: 60 },
      { id: 'terms', authenticator: 'registration-terms-and-conditions', requirement: 'DISABLED', priority: 70 },
    ],
  });
  result.authenticatorConfig.push({ alias: 'registration password', config: { always_set_password_on_register_form: 'false', retained: 'setting' } });
  result.userProfile = { attributes: [{ name: 'firstName', permissions: { view: ['admin', 'user'] } }] };
  return result;
}

test('registration continuation copies the real form tree and replaces only user creation', () => {
  const original = registrationFixture();
  const planned = planRegistrationContinuationRealm(original);
  assert.deepEqual(planned.authenticationFlows.slice(0, original.authenticationFlows.length), original.authenticationFlows);
  assert.equal(planned.authenticationFlows.length, original.authenticationFlows.length + 2);
  const form = planned.authenticationFlows.find((flow) => flow.alias === 'galaxy registration continue / registration form');
  const expected = structuredClone(original.authenticationFlows.at(-1));
  delete expected.id;
  expected.alias = form.alias;
  expected.builtIn = false;
  expected.authenticationExecutions.forEach((step) => { delete step.id; });
  expected.authenticationExecutions[0].authenticator = 'galaxy-registration-user-creation';
  assert.deepEqual(form, expected);
  for (const key of ['clients', 'browserFlow', 'resetCredentialsFlow', 'authenticatorConfig', 'requiredActions', 'userProfile']) assert.deepEqual(planned[key], original[key]);
  assert.equal(original.registrationFlow, 'registration');
  assert.deepEqual(planRegistrationContinuationRealm(planned), planned);
});

test('registration continuation refuses unverified-first or ambiguous registration shapes', () => {
  const passwordFirst = registrationFixture();
  passwordFirst.authenticatorConfig.at(-1).config.always_set_password_on_register_form = 'true';
  assert.throws(() => planRegistrationContinuationRealm(passwordFirst), /verify email before/);
  for (const override of [{ verifyEmail: false }, { registrationEmailAsUsername: false }, { duplicateEmailsAllowed: true }, { registrationAllowed: false }]) {
    assert.throws(() => planRegistrationContinuationRealm({ ...registrationFixture(), ...override }));
  }
  const disabled = registrationFixture();
  disabled.requiredActions[0].config['email-code-enabled'] = 'false';
  assert.throws(() => planRegistrationContinuationRealm(disabled));
  const missingPasswordConfig = registrationFixture();
  missingPasswordConfig.authenticatorConfig.pop();
  assert.throws(() => planRegistrationContinuationRealm(missingPasswordConfig));
  const reordered = registrationFixture();
  reordered.authenticationFlows.at(-1).authenticationExecutions.reverse();
  assert.throws(() => planRegistrationContinuationRealm(reordered));
  const missingChild = registrationFixture();
  missingChild.authenticationFlows.pop();
  assert.throws(() => planRegistrationContinuationRealm(missingChild));
});

test('fresh fixtures enable the explicit registration continuation alongside the existing reset code flow', () => {
  const patch = createEmailCodeFixtureRealmPatch();
  assert.equal(patch.registrationEmailAsUsername, true);
  assert.equal(patch.duplicateEmailsAllowed, false);
  assert.equal(patch.registrationFlow, 'galaxy registration continue');
  const steps = patch.authenticationFlows.flatMap((flow) => flow.authenticationExecutions ?? []);
  assert.equal(steps.filter((step) => step.authenticator === 'galaxy-registration-user-creation').length, 1);
  assert.equal(steps.filter((step) => step.authenticator === 'galaxy-reset-email-code').length, 1);
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
