import {createWebEventService} from './web-events/service.mjs';
import {OperationsJobActions} from "./operations/jobs/job-actions.mjs";
import { loadGovernanceForRuntime } from './operations/governance-review.mjs';
import { loadIdentityProviders } from "./identity/config.mjs";
import {loadOfficialAccountPortal} from "./accounts/official-account.mjs";
import {loadOperationsConfiguration} from "./operations/configuration.mjs";
import {BusinessAdminService} from "./operations/audit/service.mjs";
import {OperationsRegisteredUsersService} from './operations/accounts/registered-service.mjs';
import {OperationsManagementAccountsService} from './operations/accounts/management-service.mjs';
import {OperationsAiWorkAccountsService} from './operations/accounts/ai-work-service.mjs';
import {loadRegisteredWebsiteDirectory} from './infrastructure/registered-directory-configuration.mjs';
import {OperationsPermissionsService} from "./operations/permissions/index.mjs";
import "./operations/agentos/authority.mjs";
import {P13StrategiesAuthority} from './operations/strategies/authority.mjs';
import {P13StrategiesService} from './operations/strategies/service.mjs';
import {P13StrategyEffects} from './operations/strategies/effects.mjs';
import {P13StrategiesNativeClient} from './operations/strategies/native-client.mjs';
import {P13OrdinaryStrategies} from './operations/strategies/ordinary.mjs';
import {P13StrategiesGateway} from './operations/strategies/gateway.mjs';
import {OperationsAgentOsClient} from "./operations/agentos/client.mjs";
import {OperationsAgentOsService} from "./operations/agentos/service.mjs";
import {OperationsAutonomy} from "./operations/autonomy/index.mjs";
import {createOperationsAgentOsDutyTools} from "./operations/agentos/duty-tools.mjs";
import {loadOperationsAgentOsConfiguration} from './infrastructure/operations-agentos-configuration.mjs';
import {loadDiscoveryConfiguration} from './infrastructure/discovery-configuration.mjs';
import {createDiscoveryRuntime} from './discovery-runtime/runtime.mjs';
import {createDiscoveryHttp} from './discovery-runtime/http.mjs';
import {OperationsRecommendationService} from "./operations/recommendations/service.mjs";
import {OperationsSearchQualityService} from "./operations/search-quality/service.mjs";
import {OperationsMaintenanceService} from "./operations/maintenance/service.mjs";
import {MaintenanceNativeClient,loadMaintenanceNativeConfiguration} from "./operations/maintenance/native.mjs";
import {OperationsModelSettingsService} from "./operations/model-settings/service.mjs";
import {ModelSettingsNativeClient,loadModelSettingsNativeConfiguration} from "./operations/model-settings/native.mjs";
import {ServiceError} from './shared/service-error.mjs';
import {OperationsCommunityService} from "./operations/community/service.mjs";
import {OperationsResourcesService} from "./operations/resources/service.mjs";
import {OperationsFilesService} from "./operations/files/service.mjs";
import {OperationsFileCleanupService} from './operations/files/cleanup-service.mjs';
import {OperationsFileAccessService} from './operations/files/access-service.mjs';
import {OperationsAccountUsageSummary} from './operations/accounts/usage-summary.mjs';
import {OperationsAccountProfileSummary} from './operations/accounts/profile-summary.mjs';
import {OperationsProductRules,createOperationsPolicyRuntime} from "./operations/rules/product-rules.mjs";
import {P14RulesService} from './operations/rules/service.mjs';
import {P14RulesRuntime} from './operations/rules/runtime.mjs';
import {OperationsNotices} from "./operations/messaging/notices.mjs";
import {OperationsMessagingService} from "./operations/messaging/index.mjs";
import {OperationsSmtpService} from "./operations/messaging/smtp.mjs";
import {loadOperationsSmtpCredentials} from './infrastructure/operations-smtp-credentials.mjs';
import {OperationsRetention} from "./operations/retention/service.mjs";
import {apiOperationsPolicyConsumers} from "./operations/rules/policy-consumers.mjs";
import {createOperationsJobs} from "./operations/jobs/service.mjs";
import {createInformationWatchWorker} from "./information/information-watch-worker.mjs";
import {SearchIndex} from "./discovery/search-index.mjs";
import {ContentPublications} from "./publishing/content-publications.mjs";
import {AccountChatGovernanceService} from "./chat/reports/service.mjs";
import {OperationsFeedbackService} from "./operations/feedback/service.mjs";
import {FeedbackAttachmentsV1Service} from "./community/feedback-attachments-v1.mjs";
import {AccountFeedbackDataService} from './operations/feedback/owner-data.mjs';
import {AccountFollowsV1} from "./accounts/follows-v1.mjs";
import {loadExternalCredentialsConfiguration} from "./identity/authentication/external-credentials-config.mjs";
import {createExternalCredentialsService} from "./identity/authentication/external-credentials.mjs";
import {createExternalCredentialsMaintenance} from "./identity/authentication/external-credentials-maintenance.mjs";
import { loadPersonalMcp } from "./adapters/mcp/personal/configuration.mjs";
import { createRuntimeLogger,consoleRuntimeLogger,runtimeLogConfiguration,installRuntimeFailureHandlers } from './operations/runtime-log.mjs';
import { loadMetricsConfiguration,createOperationalMetrics,startMetricsListener,closeMetricsListener } from './operations/metrics.mjs';
import { loadRequestQuotaPolicy } from './adapters/http/request-quotas.mjs';
import { loadCommunityPolicy } from "./publishing/public-writes.mjs";
import { loadBrowserPolicy } from './adapters/http/browser-policy.mjs';
import { loadChatTransport } from "./chat/chat-config.mjs";
import { createChatMaintenance } from './operations/chat-maintenance-v2.mjs';
import {loadAttachmentConfiguration} from './infrastructure/attachment-configuration.mjs';
import { loadResourceBudgetPolicy } from './infrastructure/resource-budgets.mjs';
import { digest } from './shared/digest.mjs';
import { recordRuntimeConfig,runtimeConfigSnapshot } from './operations/runtime-config-audit.mjs';
import { loadRetirementController } from "./privacy/retirement.mjs";
import { loadIncidentController } from './operations/incident.mjs';
import { assertRecoveryReady } from './infrastructure/recovery-state.mjs';
import { httpFailureWriter } from './infrastructure/http-failure-audit.mjs';
import { join } from 'node:path';
import { createShutdownDeadline } from "./infrastructure/shutdown-deadline.mjs";
import { fileURLToPath } from 'node:url';
import { runtimeServiceRelease } from './operations/service-release.mjs';
import { assertRuntimeEnvironment, assertRuntimePaths } from "./infrastructure/runtime-environment.mjs";
import { apiReads } from './infrastructure/api-reads.mjs';
import { createServices } from './services.mjs';
import {loadForumPolicy,forumPolicyHash} from "./community/community-forum-policy-v1.mjs";
import { loadNetworkProfile } from "./network/network-profile.mjs";
import canonicalize from 'canonicalize';
import { assertSupportedSchema } from './infrastructure/migrations.mjs';
import { readFile, stat } from 'node:fs/promises';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { openDatabase } from "./infrastructure/database.mjs";
import {OperationsSystemSettingsService} from './operations/system-settings/service.mjs';
import {SystemSettingsNativeClient,loadSystemSettingsNativeConfiguration} from './operations/system-settings/native-client.mjs';
import {SystemGeneralPublications} from './operations/system-settings/general-publications.mjs';
import {SystemSettingsOperationsMailBridge} from './operations/system-settings/mail-bridge.mjs';
import {reportServiceConnectionAdoption} from './operations/system-settings/service-connections.mjs';
import {reportOperationsMailAdoption} from './operations/system-settings/mail-consumer.mjs';
import {createRefreshingSmtpCredentialResolver} from './operations/system-settings/smtp-credentials.mjs';
import { createApi } from './http.mjs';
import { validateKeyring } from "./security/trust-keyring.mjs";
import { acceptKeyring } from "./security/trust-store.mjs";
import { handleDocsMcp } from "./adapters/mcp/personal/docs-mcp.mjs";

async function publicConfig(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 65536) throw new Error('Invalid public trust configuration');
  return JSON.parse(await readFile(path, 'utf8'));
}

let db;
let webEvents;
let failureSpool;
let metricsServer;
let chatTransport;
let chatMaintenance;
let attachmentConfiguration;
let externalCredentialsMaintenance;
let operationsJobs;
let informationWatchWorker;
let policyRefreshTimer;
let managementDirectoryTimer;
let managementDirectoryWork;
let policyRefreshWork;
let runtimeLog=consoleRuntimeLogger('api',{destination:process.stderr,environment:process.env.GALAXY_ENVIRONMENT});
let startupPhase = 'environment';
const runtimeStartedAt=performance.now();
const shutdown = createShutdownDeadline();
async function closeStep(stage,operation){
  const startedAt=performance.now();
  try{await operation();}
  catch(error){process.exitCode=1;runtimeLog.error({event:'runtime_shutdown_failed',stage,startedAt,error});}
}
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
  runtimeLog.updateContext({release:release?.releaseId});
  startupPhase = 'database';
  db = openDatabase(process.env.DATABASE_URL,{logger:runtimeLog.write});
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
    catch(error) { runtimeLog.write({event:'chat_transport_unavailable',stage:'chat-start',error});await chatTransport.stop().catch(failure=>runtimeLog.error({event:'chat_transport_unavailable',stage:'chat-stop',error:failure})); }
    finally { clearTimeout(timer); }
  }
  const resourceBudgetPolicy=await loadResourceBudgetPolicy(process.env.GALAXY_RESOURCE_BUDGET_FILE);
  const metricsConfig=await loadMetricsConfiguration(process.env);
  const metrics=createOperationalMetrics({component:'api',db,...metricsConfig,logStatus:runtimeLog.status});
  startupPhase = 'services';
  const manifestProfile = await loadNetworkProfile(process.env.GALAXY_NETWORK_PROFILE_FILE);
  startupPhase = 'identity-providers';
  const identityConfiguration = await loadIdentityProviders(process.env.GALAXY_IDENTITY_CONFIG_FILE, { endpoint });
  const officialAccounts = await loadOfficialAccountPortal(process.env.GALAXY_ACCOUNT_CONFIG_FILE, {endpoint, db, browserOrigins:browserPolicy.origins, identityProviders:identityConfiguration.providers});
// eslint-disable-next-line prefer-const -- Forward references must stay initialized to undefined when setup fails before assignment.
  let operations;
  const operationsPermissions=new OperationsPermissionsService({db,endpoint,operatorAuthorization:(actor,options)=>{
    if(!operations?.authorizeStoredOperator)throw new ServiceError('operations_authorization_unavailable',503);
    return operations.authorizeStoredOperator(actor,options);
  },managementMaintainerAuthorization:(actor,options)=>{
    if(!operations?.authorizeManagementMaintainer)throw new ServiceError('operations_authorization_unavailable',503);
    return operations.authorizeManagementMaintainer(actor,options);
  }});
  operations=await loadOperationsConfiguration(process.env.GALAXY_OPERATIONS_CONFIG_FILE,{endpoint,db,permissions:operationsPermissions});
  const businessAdmin=new BusinessAdminService({db,endpoint,identityDirectory:operations?.identityDirectory,operatorAuthorization:operations?.authorizeStoredOperator,permissions:operationsPermissions});
  const registeredDirectory=await loadRegisteredWebsiteDirectory(process.env.GALAXY_OPERATIONS_CONFIG_FILE,{write:true,expectedIssuer:officialAccounts?.identityIssuer??null});
  const registeredUsers=new OperationsRegisteredUsersService({businessAdmin,directory:registeredDirectory,accountPortal:officialAccounts});
  const managementAccounts=new OperationsManagementAccountsService({businessAdmin,directory:operations?.managementDirectory,
    rootPrincipal:operations?.rootPrincipal,managementSessions:operations?.managementSessions});
  operationsJobs=createOperationsJobs({db,onError:diagnostic=>runtimeLog.write({event:'operations_job_failed',...diagnostic}),onEvent:runtimeLog.write});
  await operationsJobs.start();
  const operationsSearchIndex=new SearchIndex({db,endpoint,jobs:operationsJobs});
  const contentPublications=new ContentPublications({db,endpoint,jobs:operationsJobs,businessAdmin});
  startupPhase = 'external-credentials';
  const externalCredentialsConfiguration=await loadExternalCredentialsConfiguration(process.env.GALAXY_EXTERNAL_CREDENTIALS_CONFIG_FILE);
  const externalCredentials=createExternalCredentialsService({db,endpoint,configuration:externalCredentialsConfiguration});
  externalCredentialsMaintenance=createExternalCredentialsMaintenance(externalCredentials,{logger:runtimeLog.write});
  startupPhase = 'attachment-config';
  attachmentConfiguration=await loadAttachmentConfiguration(process.env);
  const services = createServices({ ...governance, officialAccounts,externalCredentials,communityPolicy, forumPolicy, chatTransport, attachmentConfiguration, identityProviders: identityConfiguration.providers, manifestProfile, retirement, incident, resourceBudgetPolicy, repositories: apiReads, db, endpoint, signingKey, kid, trustedKeys: trusted.keys,
    operator: process.env.GALAXY_OPERATOR, region: process.env.GALAXY_REGION });
  const accountChatGovernance=new AccountChatGovernanceService({chat:services.chat,businessAdmin});
  businessAdmin.forum=services.forum;
  const feedbackAttachments=new FeedbackAttachmentsV1Service({db,endpoint,accounts:services.communityAccounts,...attachmentConfiguration,logger:runtimeLog.write});
  const operationsFeedback=new OperationsFeedbackService({businessAdmin,accounts:services.communityAccounts,feedbackAttachments});
  const accountFeedbackData=new AccountFeedbackDataService({db,endpoint,accounts:services.communityAccounts,feedbackAttachments,logger:runtimeLog.write});
  const accountFollows=new AccountFollowsV1({accounts:services.communityAccounts,endpoint});
  const operationsCommunity=new OperationsCommunityService({businessAdmin,forum:services.forum,governance:services.forumGovernance});
  const agentOsConfiguration=await loadOperationsAgentOsConfiguration(process.env.GALAXY_AGENTOS_CONFIG_FILE,{endpoint});
  const agentOsClient=new OperationsAgentOsClient(agentOsConfiguration);
  const aiWorkAccounts=new OperationsAiWorkAccountsService({db,endpoint,businessAdmin,runtime:agentOsClient,automationEditorAvailable:true});
  operationsPermissions.aiWorkAccounts=aiWorkAccounts;
  const agentOsAuthority=new P13StrategiesAuthority({db,endpoint,permissions:operationsPermissions,content:operationsCommunity.content,aiWorkAccounts});
  const agentOsGateway=new P13StrategiesGateway({authority:agentOsAuthority,content:operationsCommunity.content,serviceKey:agentOsConfiguration.serviceKey});
  businessAdmin.executorAuthority=agentOsAuthority;
  businessAdmin.executorGateway=agentOsGateway;
  operationsPermissions.runtimeStatus=()=>agentOsClient.status();
  const operationsAgentOs=new OperationsAgentOsService({authority:agentOsAuthority,client:agentOsClient,summaryForConversation:operator=>operationsCommunity.summary(operator)});
  const strategies=new P13StrategiesService({db,endpoint,businessAdmin,authority:agentOsAuthority,
    effects:new P13StrategyEffects({authority:agentOsAuthority,gateway:agentOsGateway,content:operationsCommunity.content}),native:new P13StrategiesNativeClient({client:agentOsClient})});
  agentOsGateway.ordinaryStrategies=new P13OrdinaryStrategies({strategies});
  agentOsAuthority.strategies=strategies;
  const discoveryConfiguration=await loadDiscoveryConfiguration(process.env.GALAXY_DISCOVERY_CONFIG_FILE,{endpoint});
  const discoveryRuntime=discoveryConfiguration?createDiscoveryRuntime({db,endpoint,forum:services.forum,accounts:services.communityAccounts,permissions:operationsPermissions,config:discoveryConfiguration}):null;
  businessAdmin.accountUsageAnalysis=new OperationsAccountUsageSummary({businessAdmin,discovery:discoveryRuntime});
  businessAdmin.accountProfileAnalysis=new OperationsAccountProfileSummary({businessAdmin,discovery:discoveryRuntime});
  const discoveryHttp=discoveryConfiguration?createDiscoveryHttp(discoveryConfiguration):null;
  if(discoveryRuntime)await discoveryRuntime.initialize();
  const operationsRecommendation=discoveryRuntime?new OperationsRecommendationService({db,endpoint,permissions:operationsPermissions,businessAdmin,source:discoveryRuntime.source,openpanel:discoveryRuntime.openpanel}):null;
  if(discoveryRuntime)discoveryRuntime.recommendationOperations=operationsRecommendation;
  const operationsSearchQuality=discoveryRuntime?new OperationsSearchQualityService({db,endpoint,permissions:operationsPermissions,businessAdmin,meili:discoveryRuntime.meili,openpanel:discoveryRuntime.openpanel}):null;
  if(discoveryRuntime)discoveryRuntime.searchQuality=operationsSearchQuality;
  const maintenanceConfiguration=await loadMaintenanceNativeConfiguration(process.env.GALAXY_MAINTENANCE_NATIVE_FILE);
  const maintenanceNative=maintenanceConfiguration?new MaintenanceNativeClient(maintenanceConfiguration):null;
  const operationsMaintenance=new OperationsMaintenanceService({businessAdmin,native:maintenanceNative,incident});
  const modelSettingsConfiguration=await loadModelSettingsNativeConfiguration(process.env.GALAXY_MODEL_SETTINGS_NATIVE_FILE??process.env.GALAXY_MAINTENANCE_NATIVE_FILE);
  const modelSettingsNative=modelSettingsConfiguration?new ModelSettingsNativeClient(modelSettingsConfiguration):null;
  const operationsModelSettings=new OperationsModelSettingsService({businessAdmin,native:modelSettingsNative});
  const systemSettingsConfiguration=await loadSystemSettingsNativeConfiguration(process.env.GALAXY_SYSTEM_SETTINGS_NATIVE_FILE??process.env.GALAXY_MAINTENANCE_NATIVE_FILE);
  const systemSettingsNative=systemSettingsConfiguration?new SystemSettingsNativeClient(systemSettingsConfiguration):null;
  const operationsSystemSettings=new OperationsSystemSettingsService({businessAdmin,native:systemSettingsNative});
  const systemGeneralPublications=new SystemGeneralPublications({businessAdmin,contentPublications,websiteOrigin:process.env.GALAXY_SYSTEM_SETTINGS_WEBSITE_ORIGIN??'https://agigalaxy.org'});
  agentOsGateway.discovery=discoveryRuntime;
  const operationsResources=new OperationsResourcesService({businessAdmin,projects:services.projects,capsules:services.capsules.v2,maxHideSeconds:forumPolicy.maxGovernanceHideSeconds});
  const operationsFiles=new OperationsFilesService({businessAdmin,chatAttachments:services.attachments,forumAttachments:services.forumAttachments});
  const operationsFileCleanup=new OperationsFileCleanupService({businessAdmin,chatAttachments:services.attachments,forumAttachments:services.forumAttachments,logger:runtimeLog.write});
  const operationsFileAccess=new OperationsFileAccessService({businessAdmin,chatAttachments:services.attachments,forumAttachments:services.forumAttachments});
  const operationsRules=new OperationsProductRules({db,endpoint,businessAdmin});
  await operationsRules.bootstrap({'resource-budget':resourceBudgetPolicy,'community-quota':communityPolicy,'forum-quota':forumPolicy});
  const p14Rules=new P14RulesService({db,endpoint,businessAdmin,legacyRules:operationsRules});
  await p14Rules.initialize();
  const businessRules=new P14RulesRuntime({db,endpoint,accounts:services.communityAccounts,publicWrites:services.publicWrites});
  for(const consumer of [services.forum,services.chat,services.attachments,services.forumAttachments]){
    if(!consumer)throw new Error('Business rule consumer unavailable');
    consumer.businessRules=businessRules;
  }
  const operationsNotices=new OperationsNotices({db,endpoint,businessAdmin,jobs:operationsJobs,accounts:services.communityAccounts});
  const smtpCredentials=process.env.GALAXY_MESSAGING_SMTP_CREDENTIAL_FILE
    ?createRefreshingSmtpCredentialResolver(process.env.GALAXY_MESSAGING_SMTP_CREDENTIAL_FILE,{endpoint})
    :await loadOperationsSmtpCredentials(undefined,{endpoint});
  const operationsSmtp=new OperationsSmtpService({db,endpoint,businessAdmin,directory:operations?.identityDirectory,credentialResolver:smtpCredentials});
  const systemSettingsOperationsMail=new SystemSettingsOperationsMailBridge({settings:operationsSystemSettings,operationsSmtp});
  const operationsMessaging=new OperationsMessagingService({db,endpoint,businessAdmin,accounts:services.communityAccounts,jobs:operationsJobs,mailProvider:operationsSmtp});
  const operationsRetention=new OperationsRetention({db,endpoint,businessAdmin,jobs:operationsJobs});
  const operationsJobActions=new OperationsJobActions({db,endpoint,businessAdmin,jobs:operationsJobs,searchIndex:operationsSearchIndex});
  operationsAgentOs.connectConversationTools({gateway:agentOsGateway,services:{accounts:businessAdmin,registeredUsers,systemSettings:operationsSystemSettings,systemGeneral:systemGeneralPublications,community:operationsCommunity,content:operationsCommunity.content,chatReports:accountChatGovernance,
    feedback:operationsFeedback,files:operationsFiles,fileCleanup:operationsFileCleanup,fileAccess:operationsFileAccess,resources:operationsResources,analytics:discoveryRuntime,recommendations:operationsRecommendation,searchQuality:operationsSearchQuality,
    messaging:operationsMessaging,strategies,ordinaryStrategies:agentOsGateway.ordinaryStrategies,rules:p14Rules,maintenance:operationsMaintenance,aiRuns:operationsAgentOs.aiRuns,jobs:operationsJobs,jobActions:operationsJobActions,permissions:operationsPermissions}});
  const operationsAutonomy=new OperationsAutonomy({db,endpoint,businessAdmin,jobs:operationsJobs,authority:agentOsAuthority,client:agentOsClient,aiWorkAccounts,
    queryTools:operationsAgentOs.conversations.tools.query,actionTools:operationsAgentOs.conversations.tools.actions,gateway:agentOsGateway});
  operationsCommunity.autonomy=operationsAutonomy;
  operationsAgentOs.conversations.autonomy=operationsAutonomy;
  strategies.autonomy=operationsAutonomy;
  operationsMessaging.autonomy=operationsAutonomy;
  agentOsAuthority.durableOperationAuthorizationWithin=(tx,context)=>operationsMessaging.validatePersistedApprovalWithin(tx,context);
  operationsAutonomy.dutyTools=createOperationsAgentOsDutyTools({authority:agentOsAuthority,actions:operationsAgentOs.conversations.tools.actions,
    permissions:operationsPermissions,authorizeOperation:operationsAutonomy.authorizeOperationWithin.bind(operationsAutonomy)});
  const policyRuntime=createOperationsPolicyRuntime({rules:operationsRules,component:'api',consumers:apiOperationsPolicyConsumers(services,{onForumPolicy:policy=>{
    operationsCommunity.maxHideSeconds=policy.maxGovernanceHideSeconds;operationsCommunity.content.maxHideSeconds=policy.maxGovernanceHideSeconds;operationsResources.maxHideSeconds=policy.maxGovernanceHideSeconds;
  }})});
  await policyRuntime.refresh();
  informationWatchWorker=createInformationWatchWorker({services,jobs:operationsJobs,retirement,incident,onError:diagnostic=>runtimeLog.write({event:'information_watch_deferred',...diagnostic})});
  await informationWatchWorker.start();
  startupPhase = 'personal-mcp';
  const personalMcp=await loadPersonalMcp(process.env.GALAXY_PERSONAL_MCP_CONFIG_FILE,{services,identityProviders:identityConfiguration.providers});
  startupPhase = 'configuration-audit';
  await recordRuntimeConfig(db,{endpoint,component:'api',operatorRef:process.env.GALAXY_OPERATOR_REF,honorRules:governance.honorRules,qualificationPolicies:governance.qualificationPolicies,experienceReviewers:governance.experienceReviewers??[],
    snapshot:runtimeConfigSnapshot({officialAccountConfigurationHash:officialAccounts?.configurationHash??null,forumPolicyHash:forumPolicyHash(forumPolicy),personalMcpConfigurationHash:personalMcp?.configurationHash??null,identityConfigurationHash:identityConfiguration.configurationHash,governance,governanceReview,incident:incident.policy(),retirement:retirement.snapshot().policy,release,signingKeyId:kid,trustSequence:trusted.nextState.sequence,requestQuotaHash:digest(JSON.stringify(requestQuotaPolicy)),communityQuotaHash:digest(JSON.stringify(communityPolicy)),browserPolicyHash:digest(JSON.stringify(browserPolicy)),chatConfigurationHash:chatConfiguration.configurationHash,resourceBudgetHash:digest(JSON.stringify(resourceBudgetPolicy)),network:{type:services.manifest.data.networkType,manifestSha256:digest(canonicalize(services.manifest.data))}})});
  await services.honor.useRegistry();
  await services.qualification.useRegistry();
  await services.experienceReviews.useRegistry();
  startupPhase = 'audit-spool';
  const failureAuditModule = './infrastructure/' + 'failure-audit-spool.mjs';
  const { createFailureAuditSpool } = await import(failureAuditModule);
  failureSpool = await createFailureAuditSpool({ path: join(process.env.GALAXY_TRUST_DIRECTORY, 'http-failure-audit.sqlite'),
    endpoint, write: httpFailureWriter(db, endpoint), logger: runtimeLog.write });
  webEvents=createWebEventService({pool:db,endpoint,officialAccounts,communityAccounts:services.communityAccounts,access:services.access,authorizeOperator:operations?.portal?.authorizeOperator,businessAdmin,forum:services.forum,chat:services.chat,assistance:services.assistance,projects:services.projects,capsules:services.capsules,inbox:services.inbox,builders:services.builders,informationWatches:services.informationWatches,choices:services.choices,ciV2:services.ciV2});
  await webEvents.start();
  const server = createApi({webEvents, browserOrigins: [...new Set([...browserPolicy.origins,...(operations?[operations.adminOrigin]:[])])], ...services,
    operations,operationsSystemSettings,systemGeneralPublications,systemSettingsOperationsMail,systemSettingsNative,registeredUsers,managementAccounts,aiWorkAccounts,operationsPermissions,operationsMessaging,operationsSmtp,operationsAgentOs,agentOsGateway,operationsAutonomy,strategies,discoveryRuntime,discoveryHttp,operationsRecommendation,operationsSearchQuality,operationsMaintenance,maintenanceNative,operationsModelSettings,modelSettingsNative,businessAdmin,operationsJobs,operationsCommunity,operationsResources,operationsFiles,operationsFileCleanup,operationsFileAccess,operationsRules,p14Rules,operationsNotices,operationsRetention,operationsFeedback,feedbackAttachments,accountFeedbackData,accountFollows,contentPublications,accountChatGovernance,searchIndex:operationsSearchIndex,personalMcp, incident, metrics, requestQuotaPolicy, releaseId: release?.releaseId, keyring, docsMcp: handleDocsMcp, failureAudit: failureSpool.record,
    trustedProxyAddresses: process.env.GALAXY_TRUSTED_PROXY_ADDRESSES
      ? process.env.GALAXY_TRUSTED_PROXY_ADDRESSES.split(',').map(value => value.trim()) : [],
    readiness: async () => {
      const current = Math.floor(Date.now() / 1000);
      if (!failureSpool.status().ready) return false;
      if (current + 86400 > servicePin.notAfter || current + 300 > trusted.expiresAt) return false;
      try { await db.query('SELECT 1'); return true; }
      catch(error){runtimeLog.error({event:'database_pool_failed',stage:'http-readiness',error});return false;}
    }, logger: runtimeLog.write });
  startupPhase = 'metrics';
  metricsServer=await startMetricsListener(metrics,metricsConfig.port);
  startupPhase = 'listen';
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  runtimeLog.write({ event: 'listening', port });
  runtimeLog.write({event:'runtime_started',stage:'listen',startedAt:runtimeStartedAt});
  await reportServiceConnectionAdoption(process.env.GALAXY_SERVICE_CONNECTIONS_METADATA_FILE,{component:'api',discoveryRuntime,agentOsClient,attachmentConfiguration});
  await reportOperationsMailAdoption(process.env.GALAXY_SYSTEM_SETTINGS_MAIL_METADATA_FILE,{component:'api',smtp:operationsSmtp,credentialFile:process.env.GALAXY_MESSAGING_SMTP_CREDENTIAL_FILE});
  if(operations?.managementDirectory){
    const syncManagementDirectory=()=>{
      if(managementDirectoryWork)return;
      managementDirectoryWork=managementAccounts.sync()
        .catch(error=>runtimeLog.error({event:'management_directory_sync_failed',stage:'management-directory-sync',error}))
        .finally(()=>{managementDirectoryWork=null;});
    };
    managementDirectoryTimer=setInterval(syncManagementDirectory,60000);managementDirectoryTimer.unref();
    syncManagementDirectory();
  }
  chatMaintenance=createChatMaintenance({chat:services.chat,accountChatGovernance,summaries:services.summaries,sharedSummaries:services.sharedSummaries,choices:services.choices,transport:chatTransport,logger:runtimeLog.write});
  chatMaintenance.start();
  policyRefreshTimer=setInterval(()=>{
    if(policyRefreshWork)return;
    policyRefreshWork=policyRuntime.refresh().then(result=>{
      if(result.items.some(item=>item.errorCode))runtimeLog.error({event:'operations_policy_refresh_failed',stage:'policy-refresh'});
    }).catch(error=>runtimeLog.error({event:'operations_policy_refresh_failed',stage:'policy-refresh',error})).finally(()=>{policyRefreshWork=null;});
  },30000);policyRefreshTimer.unref();
  if(externalCredentialsConfiguration.issuers.length)externalCredentialsMaintenance.start();
  let stopPromise;
  const stop = signal => {
    if(stopPromise)return stopPromise;
    const startedAt=performance.now();
    runtimeLog.write({event:'runtime_stopping',stage:'shutdown',signal});
    chatMaintenance?.quiesce();
    clearInterval(policyRefreshTimer);
    clearInterval(managementDirectoryTimer);
    shutdown.start();
    const timeout = setTimeout(() => { server.closeAllConnections(); }, 10000);
    timeout.unref();
    stopPromise=new Promise(resolve=>server.close(resolve)).then(async()=>{
      clearTimeout(timeout);
      await closeStep('policy-refresh',()=>policyRefreshWork);
      await closeStep('management-directory-sync',()=>managementDirectoryWork);
      await closeStep('metrics-close',()=>closeMetricsListener(metricsServer));
      await closeStep('watch-stop',()=>informationWatchWorker?.stop());
      await closeStep('queue-stop',()=>operationsJobs?.stop());
      await closeStep('chat-stop',()=>chatTransport?.stop());
      await closeStep('chat-drain',()=>chatMaintenance?.drain());
      await closeStep('credentials-close',()=>externalCredentialsMaintenance?.close());
      await closeStep('audit-close',()=>failureSpool.close());
      await closeStep('web-events-stop',()=>webEvents?.stop());
      await closeStep('database-close',()=>db.end());
      runtimeLog.write({event:'runtime_stopped',stage:'shutdown',startedAt,exitCode:process.exitCode??0});
      await runtimeLog.close();
    }).catch(()=>{process.exitCode=1;}).finally(()=>shutdown.finish());
    return stopPromise;
  };
  process.once('SIGTERM',()=>{void stop('SIGTERM');});
  process.once('SIGINT',()=>{void stop('SIGINT');});
  installRuntimeFailureHandlers({logger:runtimeLog.error,onFatal:()=>stop()});
  server.on('error',error=>{runtimeLog.error({event:'runtime_shutdown_failed',stage:'listen',error});process.exitCode=1;void stop();});
} catch(error) {
  runtimeLog.error({event:'startup_failed',phase:startupPhase,stage:startupPhase,startedAt:runtimeStartedAt,error});
  process.exitCode = 1;
  shutdown.start();
  chatMaintenance?.quiesce();
  clearInterval(policyRefreshTimer);
  clearInterval(managementDirectoryTimer);
  await closeStep('policy-refresh',()=>policyRefreshWork);
  await closeStep('management-directory-sync',()=>managementDirectoryWork);
  await closeStep('metrics-close',()=>closeMetricsListener(metricsServer));
  await closeStep('watch-stop',()=>informationWatchWorker?.stop());
  await closeStep('queue-stop',()=>operationsJobs?.stop());
  await closeStep('chat-stop',()=>chatTransport?.stop());
  await closeStep('chat-drain',()=>chatMaintenance?.drain());
  await closeStep('credentials-close',()=>externalCredentialsMaintenance?.close());
  await closeStep('audit-close',()=>failureSpool?.close());
  await closeStep('web-events-stop',()=>webEvents?.stop());
      await closeStep('database-close',()=>db?.end());
  runtimeLog.write({event:'runtime_stopped',stage:'shutdown',startedAt:runtimeStartedAt,exitCode:1});
  try{await runtimeLog.close();}catch{process.exitCode=1;}shutdown.finish();
}
