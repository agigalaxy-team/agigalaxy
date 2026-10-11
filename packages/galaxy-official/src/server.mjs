import { loadGovernanceForRuntime } from './operations/governance-review.mjs';
import { loadIdentityProviders } from './identity-config.mjs';
import { loadPersonalMcp } from './personal-mcp-config.mjs';
import { createRuntimeLogger,consoleRuntimeLogger,runtimeLogConfiguration } from './operations/runtime-log.mjs';
import { loadMetricsConfiguration,createOperationalMetrics,startMetricsListener,closeMetricsListener } from './operations/metrics.mjs';
import { loadRequestQuotaPolicy } from './adapters/http/request-quotas.mjs';
import { loadCommunityPolicy } from './public-writes.mjs';
import { loadBrowserPolicy } from './adapters/http/browser-policy.mjs';
import { loadChatTransport } from './chat-config.mjs';
import { createChatMaintenance } from './operations/chat-maintenance-v2.mjs';
import {loadAttachmentConfiguration} from './infrastructure/attachment-configuration.mjs';
import { loadResourceBudgetPolicy } from './infrastructure/resource-budgets.mjs';
import { digest } from './shared/digest.mjs';
import { recordRuntimeConfig,runtimeConfigSnapshot } from './operations/runtime-config-audit.mjs';
import { loadRetirementController } from './retirement.mjs';
import { loadIncidentController } from './operations/incident.mjs';
import { assertRecoveryReady } from './infrastructure/recovery-state.mjs';
import { httpFailureWriter } from './infrastructure/http-failure-audit.mjs';
import { join } from 'node:path';
import { createShutdownDeadline } from './shutdown-deadline.mjs';
import { fileURLToPath } from 'node:url';
import { runtimeServiceRelease } from './operations/service-release.mjs';
import { assertRuntimeEnvironment, assertRuntimePaths } from './runtime-environment.mjs';
import { apiReads } from './infrastructure/api-reads.mjs';
import { createServices } from './services.mjs';
import {loadForumPolicy,forumPolicyHash} from './community-forum-policy-v1.mjs';
import { loadNetworkProfile } from './network-profile.mjs';
import canonicalize from 'canonicalize';
import { assertSupportedSchema } from './infrastructure/migrations.mjs';
import { readFile, stat } from 'node:fs/promises';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { openDatabase } from './database.mjs';
import { createApi } from './http.mjs';
import { validateKeyring } from './trust-keyring.mjs';
import { acceptKeyring } from './trust-store.mjs';
import { handleDocsMcp } from './docs-mcp.mjs';

async function publicConfig(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 65536) throw new Error('Invalid public trust configuration');
  return JSON.parse(await readFile(path, 'utf8'));
}

let db;
let failureSpool;
let metricsServer;
let chatTransport;
let chatMaintenance;
let attachmentConfiguration;
let runtimeLog=consoleRuntimeLogger('api',{destination:process.stderr});
let startupPhase = 'environment';
const shutdown = createShutdownDeadline();
try {
  assertRuntimeEnvironment(process.env, 'api');
  startupPhase='runtime-log';
  const configuredLog=await createRuntimeLogger({component:'api',...runtimeLogConfiguration(process.env)});
  await runtimeLog.close();runtimeLog=configuredLog;
  startupPhase='environment';
  await assertRuntimePaths(process.env);
  startupPhase = 'endpoint';
  const endpoint = process.env.GALAXY_ENDPOINT;
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.origin !== endpoint || url.username || url.password)
    throw new Error('Invalid endpoint');
  startupPhase = 'signing-key';
  const keyPath = process.env.GALAXY_SIGNING_KEY_FILE;
  const info = await stat(keyPath);
  if (!info.isFile() || info.size > 4096 || (process.platform !== 'win32' && (info.mode & 0o077)))
    throw new Error('Unsafe signing key file');
  const signingKey = createPrivateKey(await readFile(keyPath));
  if (signingKey.asymmetricKeyType !== 'ed25519') throw new Error('Invalid signing key');
  const kid = process.env.GALAXY_SIGNING_KEY_ID;
  const now = Math.floor(Date.now() / 1000);
  startupPhase = 'trust';
  const rootConfig = validateKeyring(await publicConfig(process.env.GALAXY_ROOT_PINS_FILE), endpoint);
  const rootPins = new Map(rootConfig.keys.map(key => [key.kid, key]));
  const keyring = await publicConfig(process.env.GALAXY_KEYRING_FILE);
  const trusted = await acceptKeyring(keyring, { endpoint, rootPins, now, directory: process.env.GALAXY_TRUST_DIRECTORY });
  const servicePin = trusted.keys.get(kid);
  if (!servicePin || servicePin.revoked || servicePin.notBefore > now || servicePin.notAfter < now + 86400
    || servicePin.publicKeyPem !== createPublicKey(signingKey).export({ type: 'spki', format: 'pem' }))
    throw new Error('Signing key is not authorized by pinned root');
  startupPhase = 'listener-config';
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const host = process.env.GALAXY_LISTEN_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('Invalid host');
  if (typeof process.getuid === 'function' && process.getuid() === 0) throw new Error('Non-root runtime required');
  startupPhase = 'release';
  const release = await runtimeServiceRelease(process.env, 'api', fileURLToPath(import.meta.url));
  startupPhase = 'database';
  db = openDatabase(process.env.DATABASE_URL);
  // Schema changes are an explicit deploy step, never a side effect of startup.
  const versions = (await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows;
  assertSupportedSchema(versions);
  startupPhase = 'recovery';
  await assertRecoveryReady(db);
  startupPhase = 'database-role';
  const roleFunctions = (await db.query(`SELECT
    to_regprocedure('public.galaxy_api_lock_subject(text)') IS NOT NULL AND
    to_regprocedure('public.galaxy_api_lock_evidence_read(uuid,text)') IS NOT NULL AND
    to_regprocedure('public.galaxy_api_lock_evidence_write(uuid,text)') IS NOT NULL AS ready`)).rows[0];
  if (!roleFunctions.ready) throw new Error('API role provisioning required');
  startupPhase = 'governance';
  const {configuration:governance,review:governanceReview}=await loadGovernanceForRuntime({configurationPath:process.env.GALAXY_GOVERNANCE_CONFIG,
    reviewPath:process.env.GALAXY_GOVERNANCE_REVIEW_FILE,authoritiesPath:process.env.GALAXY_GOVERNANCE_AUTHORITIES_FILE,
    endpoint,environment:process.env.GALAXY_ENVIRONMENT});
  const retirement = await loadRetirementController(process.env.GALAXY_RETIREMENT_FILE, { endpoint });
  const incident = await loadIncidentController(process.env.GALAXY_INCIDENT_FILE, { endpoint });
  const requestQuotaPolicy=await loadRequestQuotaPolicy(process.env.GALAXY_REQUEST_QUOTA_FILE);
  const communityPolicy=await loadCommunityPolicy(process.env.GALAXY_COMMUNITY_QUOTA_FILE);
  const forumPolicy=await loadForumPolicy(process.env.GALAXY_FORUM_POLICY_FILE);
  const browserPolicy=await loadBrowserPolicy(process.env.GALAXY_BROWSER_POLICY_FILE);
  const chatConfiguration=await loadChatTransport(process.env.GALAXY_CHAT_CONFIG_FILE);
  chatTransport=chatConfiguration.transport;
  if (chatTransport) {
    let timer;
    try { await Promise.race([chatTransport.start(), new Promise((_, reject) => { timer=setTimeout(() => reject(new Error('Chat startup timeout')), 5000); })]); }
    catch { await chatTransport.stop().catch(() => {}); runtimeLog.write({ event: 'chat_transport_unavailable' }); }
    finally { clearTimeout(timer); }
  }
  const resourceBudgetPolicy=await loadResourceBudgetPolicy(process.env.GALAXY_RESOURCE_BUDGET_FILE);
  const metricsConfig=await loadMetricsConfiguration(process.env);
  const metrics=createOperationalMetrics({component:'api',db,...metricsConfig,logStatus:runtimeLog.status});
  startupPhase = 'services';
  const manifestProfile = await loadNetworkProfile(process.env.GALAXY_NETWORK_PROFILE_FILE);
  startupPhase = 'identity-providers';
  const identityConfiguration = await loadIdentityProviders(process.env.GALAXY_IDENTITY_CONFIG_FILE, { endpoint });
  startupPhase = 'attachment-config';
  attachmentConfiguration=await loadAttachmentConfiguration(process.env);
  const services = createServices({ ...governance, communityPolicy, forumPolicy, chatTransport, attachmentConfiguration, identityProviders: identityConfiguration.providers, manifestProfile, retirement, incident, resourceBudgetPolicy, repositories: apiReads, db, endpoint, signingKey, kid, trustedKeys: trusted.keys,
    operator: process.env.GALAXY_OPERATOR, region: process.env.GALAXY_REGION });
  startupPhase = 'personal-mcp';
  const personalMcp=await loadPersonalMcp(process.env.GALAXY_PERSONAL_MCP_CONFIG_FILE,{services,identityProviders:identityConfiguration.providers});
  startupPhase = 'configuration-audit';
  await recordRuntimeConfig(db,{endpoint,component:'api',operatorRef:process.env.GALAXY_OPERATOR_REF,honorRules:governance.honorRules,qualificationPolicies:governance.qualificationPolicies,experienceReviewers:governance.experienceReviewers??[],
    snapshot:runtimeConfigSnapshot({forumPolicyHash:forumPolicyHash(forumPolicy),personalMcpConfigurationHash:personalMcp?.configurationHash??null,identityConfigurationHash:identityConfiguration.configurationHash,governance,governanceReview,incident:incident.policy(),retirement:retirement.snapshot().policy,release,signingKeyId:kid,trustSequence:trusted.nextState.sequence,requestQuotaHash:digest(JSON.stringify(requestQuotaPolicy)),communityQuotaHash:digest(JSON.stringify(communityPolicy)),browserPolicyHash:digest(JSON.stringify(browserPolicy)),chatConfigurationHash:chatConfiguration.configurationHash,resourceBudgetHash:digest(JSON.stringify(resourceBudgetPolicy)),network:{type:services.manifest.data.networkType,manifestSha256:digest(canonicalize(services.manifest.data))}})});
  await services.honor.useRegistry();
  await services.qualification.useRegistry();
  await services.experienceReviews.useRegistry();
  startupPhase = 'audit-spool';
  const failureAuditModule = './infrastructure/' + 'failure-audit-spool.mjs';
  const { createFailureAuditSpool } = await import(failureAuditModule);
  failureSpool = await createFailureAuditSpool({ path: join(process.env.GALAXY_TRUST_DIRECTORY, 'http-failure-audit.sqlite'),
    endpoint, write: httpFailureWriter(db, endpoint), logger: runtimeLog.write });
  const server = createApi({ browserOrigins: browserPolicy.origins, ...services, personalMcp, incident, metrics, requestQuotaPolicy, releaseId: release?.releaseId, keyring, docsMcp: handleDocsMcp, failureAudit: failureSpool.record,
    trustedProxyAddresses: process.env.GALAXY_TRUSTED_PROXY_ADDRESSES
      ? process.env.GALAXY_TRUSTED_PROXY_ADDRESSES.split(',').map(value => value.trim()) : [],
    readiness: async () => {
      const current = Math.floor(Date.now() / 1000);
      if (!failureSpool.status().ready) return false;
      if (current + 86400 > servicePin.notAfter || current + 300 > trusted.expiresAt) return false;
      try { await db.query('SELECT 1'); return true; } catch { return false; }
    }, logger: runtimeLog.write });
  startupPhase = 'listen';
  metricsServer=await startMetricsListener(metrics,metricsConfig.port);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  runtimeLog.write({ event: 'listening', port });
  chatMaintenance=createChatMaintenance({chat:services.chat,summaries:services.summaries,sharedSummaries:services.sharedSummaries,choices:services.choices,transport:chatTransport,logger:runtimeLog.write});
  chatMaintenance.start();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    chatMaintenance?.quiesce();
    shutdown.start();
    const timeout = setTimeout(() => { server.closeAllConnections(); }, 10000);
    timeout.unref();
    server.close(() => { clearTimeout(timeout); void closeMetricsListener(metricsServer).then(()=>chatTransport?.stop()).then(()=>chatMaintenance?.drain()).then(()=>failureSpool.close()).finally(() => db.end()).finally(()=>runtimeLog.close())
      .catch(() => { process.exitCode = 1; }).finally(() => shutdown.finish()); });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch {
  runtimeLog.error({ event: 'startup_failed', phase: startupPhase });
  process.exitCode = 1;
  shutdown.start();
  try { chatMaintenance?.quiesce(); await closeMetricsListener(metricsServer); if (chatTransport) await chatTransport.stop(); await chatMaintenance?.drain(); if (failureSpool) await failureSpool.close(); if (db) await db.end(); } catch { /* Keep sanitized startup failure. */ }
  finally { try{await runtimeLog.close();}catch{process.exitCode=1;}shutdown.finish(); }
}
