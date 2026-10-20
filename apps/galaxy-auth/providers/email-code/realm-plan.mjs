export const galaxyEmailCodeProvider = Object.freeze({
  requiredAction: 'VERIFY_EMAIL',
  resetAuthenticator: 'galaxy-reset-email-code',
  resetChooseUser: 'galaxy-reset-choose-user',
  enableKey: 'email-code-enabled',
  defaultPolicy: Object.freeze({ 'code-ttl-seconds': '600', 'resend-seconds': '60', 'max-attempts': '5' }),
});

/**
 * Pure realm-representation transformation for a release owner / local fixture.
 * It performs no HTTP requests, imports, writes or SMTP operations. Supply an
 * in-memory representation; do not persist a production export with credentials.
 */
export function planEmailCodeRealm(representation, {
  resetAlias = 'galaxy reset email code',
  policy = galaxyEmailCodeProvider.defaultPolicy,
  emailTheme,
} = {}) {
  if (!representation || representation.realm !== 'galaxy') throw new Error('Expected the explicitly scoped galaxy realm');
  if (representation.verifyEmail !== true) throw new Error('Existing email-verification requirement must be enabled');
  if (!resetAlias || typeof resetAlias !== 'string' || resetAlias.length > 120) throw new Error('Invalid reset flow alias');
  if (emailTheme !== undefined && (typeof emailTheme !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(emailTheme))) throw new Error('Invalid email theme name');
  const effectivePolicy = { ...galaxyEmailCodeProvider.defaultPolicy };
  for (const [key, min, max] of [['code-ttl-seconds', 2, 900], ['resend-seconds', 1, 300], ['max-attempts', 1, 10]]) {
    if (policy[key] !== undefined) {
      const value = Number(policy[key]);
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid setting: ${key}`);
      effectivePolicy[key] = String(value);
    }
  }
  const realm = structuredClone(representation);
  const flows = realm.authenticationFlows;
  if (!Array.isArray(flows)) throw new Error('Provide the existing reset flow and its referenced subflows');
  const originalAlias = realm.resetCredentialsFlow || 'reset credentials';
  const root = flows.find((flow) => flow.alias === originalAlias);
  if (!root) throw new Error('Existing reset credentials flow was not supplied');
  const allConfigs = realm.authenticatorConfig ?? [];
  const collected = new Map();
  const walk = (flow) => {
    if (collected.has(flow.alias)) return;
    collected.set(flow.alias, flow);
    for (const step of flow.authenticationExecutions ?? []) {
      if (!step.authenticatorFlow) continue;
      const child = flows.find((candidate) => candidate.alias === step.flowAlias);
      if (!child) throw new Error('A referenced reset subflow was not supplied');
      walk(child);
    }
  };
  walk(root);
  const resetSteps = [...collected.values()].flatMap((flow) => flow.authenticationExecutions ?? []);
  const emailSteps = resetSteps
    .filter((step) => step.authenticator === 'reset-credential-email' || step.authenticator === galaxyEmailCodeProvider.resetAuthenticator);
  const chooseSteps = resetSteps
    .filter((step) => step.authenticator === 'reset-credentials-choose-user' || step.authenticator === galaxyEmailCodeProvider.resetChooseUser);
  if (emailSteps.length !== 1) throw new Error('Expected exactly one reset email execution');
  if (chooseSteps.length !== 1) throw new Error('Expected exactly one supported reset user chooser');
  const existing = emailSteps[0].authenticator === galaxyEmailCodeProvider.resetAuthenticator;
  if (!existing && flows.some((flow) => flow.alias === resetAlias)) throw new Error('New reset alias is already used');
  const aliases = new Map([...collected.keys()].map((alias) => [alias, alias === originalAlias ? resetAlias : `${resetAlias} / ${alias}`]));
  const configAlias = `${resetAlias} policy`;
  let originalConfig = {};
  if (emailSteps[0].authenticatorConfig) {
    const matched = allConfigs.find((config) => config.alias === emailSteps[0].authenticatorConfig);
    if (!matched) throw new Error('Existing reset-email execution settings were not supplied');
    originalConfig = matched.config ?? {};
  }
  if (!existing && allConfigs.some((config) => config.alias === configAlias)) throw new Error('New execution config alias is already used');
  const config = { alias: existing ? emailSteps[0].authenticatorConfig || configAlias : configAlias, config: { ...originalConfig, ...effectivePolicy } };
  if (existing) {
    const index = allConfigs.findIndex((item) => item.alias === config.alias);
    if (index < 0) allConfigs.push(config); else allConfigs[index] = config;
    emailSteps[0].authenticatorConfig = config.alias;
    chooseSteps[0].authenticator = galaxyEmailCodeProvider.resetChooseUser;
  } else {
    for (const flow of collected.values()) {
      const copy = structuredClone(flow);
      delete copy.id;
      copy.alias = aliases.get(flow.alias);
      copy.builtIn = false;
      for (const step of copy.authenticationExecutions ?? []) {
        delete step.id;
        if (step.authenticatorFlow) step.flowAlias = aliases.get(step.flowAlias);
        if (step.authenticator === 'reset-credentials-choose-user') step.authenticator = galaxyEmailCodeProvider.resetChooseUser;
        if (step.authenticator === 'reset-credential-email') {
          step.authenticator = galaxyEmailCodeProvider.resetAuthenticator;
          step.authenticatorConfig = config.alias;
        }
      }
      flows.push(copy);
    }
    allConfigs.push(config);
    realm.resetCredentialsFlow = resetAlias;
  }
  realm.authenticatorConfig = allConfigs;
  realm.requiredActions ??= [];
  let verify = realm.requiredActions.find((action) => action.providerId === 'VERIFY_EMAIL' || action.alias === 'VERIFY_EMAIL');
  if (!verify) {
    verify = { alias: 'VERIFY_EMAIL', name: 'Verify Email', providerId: 'VERIFY_EMAIL', enabled: true, defaultAction: false, priority: 50, config: {} };
    realm.requiredActions.push(verify);
  }
  if (verify.enabled === false) throw new Error('Existing VERIFY_EMAIL action is disabled');
  verify.config = { ...(verify.config ?? {}), ...effectivePolicy, [galaxyEmailCodeProvider.enableKey]: 'true' };
  if (emailTheme !== undefined) realm.emailTheme = emailTheme;
  return realm;
}

/** Fresh local fixtures only: the reset tree from Keycloak 26.7.3's
 * DefaultAuthenticationFlows, with the normal required-action ordering. This
 * is not a replacement for reading an existing realm's customized flow. */
export function createEmailCodeFixtureRealmPatch({ policy, emailTheme } = {}) {
  const representation = {
    realm: 'galaxy', verifyEmail: true, resetCredentialsFlow: 'reset credentials',
    authenticationFlows: [
      {
        alias: 'reset credentials', description: 'Reset credentials', providerId: 'basic-flow', topLevel: true, builtIn: true,
        authenticationExecutions: [
          { authenticator: 'reset-credentials-choose-user', requirement: 'REQUIRED', priority: 10, authenticatorFlow: false },
          { authenticator: 'reset-credential-email', requirement: 'REQUIRED', priority: 20, authenticatorFlow: false },
          { authenticator: 'reset-password', requirement: 'REQUIRED', priority: 30, authenticatorFlow: false },
          { flowAlias: 'Reset - Conditional OTP', requirement: 'CONDITIONAL', priority: 40, authenticatorFlow: true },
        ],
      },
      {
        alias: 'Reset - Conditional OTP', description: 'Reset configured OTP', providerId: 'basic-flow', topLevel: false, builtIn: true,
        authenticationExecutions: [
          { authenticator: 'conditional-user-configured', requirement: 'REQUIRED', priority: 10, authenticatorFlow: false },
          { authenticator: 'reset-otp', requirement: 'REQUIRED', priority: 20, authenticatorFlow: false },
        ],
      },
    ],
    authenticatorConfig: [],
    requiredActions: [
      { alias: 'UPDATE_PROFILE', name: 'Update Profile', providerId: 'UPDATE_PROFILE', enabled: true, defaultAction: false, priority: 40, config: {} },
      { alias: 'VERIFY_EMAIL', name: 'Verify Email', providerId: 'VERIFY_EMAIL', enabled: true, defaultAction: false, priority: 50, config: {} },
      { alias: 'CONFIGURE_TOTP', name: 'Configure OTP', providerId: 'CONFIGURE_TOTP', enabled: true, defaultAction: false, priority: 54, config: {} },
      { alias: 'UPDATE_PASSWORD', name: 'Update Password', providerId: 'UPDATE_PASSWORD', enabled: true, defaultAction: false, priority: 57, config: {} },
      { alias: 'VERIFY_PROFILE', name: 'Verify Profile', providerId: 'VERIFY_PROFILE', enabled: true, defaultAction: false, priority: 100, config: {} },
    ],
  };
  const planned = planEmailCodeRealm(representation, { policy, emailTheme });
  const { authenticationFlows, authenticatorConfig, requiredActions, resetCredentialsFlow } = planned;
  return { authenticationFlows, authenticatorConfig, requiredActions, resetCredentialsFlow, ...(emailTheme ? { emailTheme } : {}) };
}
