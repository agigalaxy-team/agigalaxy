import { createShutdownDeadline } from './shutdown-deadline.mjs';
import { createRuntimeLogger,consoleRuntimeLogger,runtimeLogConfiguration,installRuntimeFailureHandlers } from './operations/runtime-log.mjs';
import { loadMetricsConfiguration,createOperationalMetrics,startMetricsListener,closeMetricsListener } from './operations/metrics.mjs';
import { recordRuntimeConfig,runtimeConfigSnapshot } from './operations/runtime-config-audit.mjs';
import { loadResourceBudgetPolicy } from './infrastructure/resource-budgets.mjs';
import { digest } from './shared/digest.mjs';
import { loadRetirementController } from './retirement.mjs';
import { loadIncidentController } from './operations/incident.mjs';
import { fileURLToPath } from 'node:url';
import { runtimeServiceRelease } from './operations/service-release.mjs';
import { cleanupExpiredExports } from './infrastructure/export-retention.mjs';
import { cleanupProductV2Retention } from './operations/lifecycle-retention-v2.mjs';
import {loadForumPolicy,forumPolicyHash} from './community-forum-policy-v1.mjs';
import { assertRecoveryReady } from './infrastructure/recovery-state.mjs';
import { assertRuntimeEnvironment } from './runtime-environment.mjs';
import { workerReads } from './infrastructure/worker-reads.mjs';
import { assertSupportedSchema } from './infrastructure/migrations.mjs';
import { openDatabase } from './database.mjs';
import { ConsentReader } from './consent-reader.mjs';
import { EvidenceService } from './evidence.mjs';
import { SearchIndex } from './search-index.mjs';
import {createOperationsJobs} from './operations-jobs.mjs';
import {OperationsAutonomy,createOperationsAutonomyWorker} from './operations-autonomy.mjs';
import {OperationsAgentOsAuthority} from './operations-agentos-authority.mjs';
import {OperationsAgentOsClient} from './operations-agentos-client.mjs';
import {AiWorkAccountsReadModel} from './operations/accounts/ai-work-read-model.mjs';
import {loadOperationsAgentOsConfiguration} from './infrastructure/operations-agentos-configuration.mjs';
import { BuilderProbeWorker } from './builder-probes.mjs';
import { createCiWorkerV2 } from './ci-worker-v2.mjs';
import {loadAttachmentConfiguration} from './infrastructure/attachment-configuration.mjs';
import {ChatAttachmentsService} from './chat-attachments.mjs';
import {ForumAttachmentsV1Service} from './forum-attachments-v1.mjs';
import {FeedbackAttachmentsV1Service} from './feedback-attachments-v1.mjs';
import {AccountFeedbackDataService} from './operations/feedback/owner-data.mjs';
import {BusinessAdminService} from './business-admin.mjs';
import {OperationsRegisteredUsersService} from './operations/accounts/registered-service.mjs';
import {loadRegisteredWebsiteDirectory} from './infrastructure/registered-directory-configuration.mjs';
import {OperationsFileCleanupService} from './operations/files/cleanup-service.mjs';
import {OperationsPermissionsService} from './operations-permissions.mjs';
import {loadOperationsWorkerAuthorization,loadOperationsAccountDirectory} from './operations-config.mjs';
import {OperationsProductRules,createOperationsPolicyRuntime} from './operations-product-rules.mjs';
import {workerOperationsPolicyConsumers} from './operations-policy-consumers.mjs';
import {OperationsNotices,createOperationsNoticeWorker} from './operations-notices.mjs';
import {OperationsMessagingService,createOperationsMessagingWorkers} from './operations-messaging.mjs';
import {OperationsSmtpService} from './operations-smtp.mjs';
import {reportServiceConnectionAdoption} from './operations/system-settings/service-connections.mjs';
import {reportOperationsMailAdoption} from './operations/system-settings/mail-consumer.mjs';
import {createRefreshingSmtpCredentialResolver} from './operations/system-settings/smtp-credentials.mjs';
import {loadOperationsSmtpCredentials} from './infrastructure/operations-smtp-credentials.mjs';
import {OperationsRetention,createOperationsRetentionWorker} from './operations-retention.mjs';
import {loadDiscoveryConfiguration} from './infrastructure/discovery-configuration.mjs';
import {createDiscoveryRuntime,DiscoveryWorker} from './discovery-runtime/runtime.mjs';
import {createDiscoveryReadOnlySource} from './discovery-runtime/public-content-source.mjs';

let db;
let attachmentConfiguration;
let metricsServer;
let operationsJobs;
let runtimeLog=consoleRuntimeLogger('worker',{destination:process.stderr,environment:process.env.GALAXY_ENVIRONMENT});
const shutdown = createShutdownDeadline();
const runtimeStartedAt=performance.now();
let stage='environment';
let stopping = false;
const stop=signal=>{if(stopping)return;stopping=true;runtimeLog.write({event:'runtime_stopping',stage:'shutdown',signal});shutdown.start();};
process.once('SIGTERM',()=>stop('SIGTERM'));
process.once('SIGINT',()=>stop('SIGINT'));
async function closeStep(current,operation){const startedAt=performance.now();try{await operation();}catch(error){process.exitCode=1;runtimeLog.error({event:'worker_shutdown_failed',stage:current,startedAt,error});}}
try {
  assertRuntimeEnvironment(process.env, 'worker');
  stage='runtime-log';
  const configuredLog=await createRuntimeLogger({component:'worker',...runtimeLogConfiguration(process.env)});
  await runtimeLog.close();runtimeLog=configuredLog;
  stage='release';
  const release=await runtimeServiceRelease(process.env, 'worker', fileURLToPath(import.meta.url));
  runtimeLog.updateContext({release:release?.releaseId});
  stage='endpoint';
  const endpoint = process.env.GALAXY_ENDPOINT;
  if (new URL(endpoint).origin !== endpoint || !endpoint.startsWith('https://')) throw new Error();
  if (typeof process.getuid === 'function' && process.getuid() === 0) throw new Error();
  stage='database';
  db = openDatabase(process.env.DATABASE_URL,{logger:runtimeLog.write});
  assertSupportedSchema((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows);
  stage='recovery';
  await assertRecoveryReady(db);
  stage='database-role';
  const functions = (await db.query(`SELECT
    to_regprocedure('public.galaxy_worker_lock_case(uuid,text)') IS NOT NULL AND
    to_regprocedure('public.galaxy_worker_lock_consent(uuid,text,timestamptz)') IS NOT NULL AND
    to_regprocedure('public.galaxy_worker_lock_builder(uuid)') IS NOT NULL AND
    to_regprocedure('public.galaxy_worker_lock_ci_case(uuid,uuid)') IS NOT NULL AND
    to_regprocedure('public.galaxy_worker_lock_ci_record(uuid,uuid)') IS NOT NULL AND
    to_regprocedure('public.galaxy_worker_prune_forum_authorizations(timestamptz)') IS NOT NULL AND
    to_regprocedure('public.galaxy_worker_lock_closed_forum_reports(timestamptz)') IS NOT NULL AND
    to_regprocedure('public.galaxy_worker_lock_messaging_plan(uuid,text)') IS NOT NULL AND
    has_function_privilege(current_user,'public.galaxy_worker_lock_messaging_plan(uuid,text)','EXECUTE') AND
    has_function_privilege(current_user,'public.galaxy_worker_prune_forum_authorizations(timestamptz)','EXECUTE') AND
    has_function_privilege(current_user,'public.galaxy_worker_lock_closed_forum_reports(timestamptz)','EXECUTE') AS ready`)).rows[0];
  if (!functions.ready) throw new Error('Worker role provisioning required');
  const now = () => Math.floor(Date.now() / 1000);
  stage='attachment-config';
  attachmentConfiguration=await loadAttachmentConfiguration(process.env);
  const attachments=attachmentConfiguration?new ChatAttachmentsService({chat:{db,now},...attachmentConfiguration,logger:runtimeLog.write}):null;
  const forumAttachments=attachmentConfiguration?new ForumAttachmentsV1Service({db,now,...attachmentConfiguration,logger:runtimeLog.write}):null;
  const feedbackAttachments=attachmentConfiguration?new FeedbackAttachmentsV1Service({db,endpoint,now,...attachmentConfiguration,logger:runtimeLog.write}):null;
  const accountFeedbackData=new AccountFeedbackDataService({db,endpoint,feedbackAttachments,now,logger:runtimeLog.write});
  stage='governance';
  const retirement = await loadRetirementController(process.env.GALAXY_RETIREMENT_FILE, { endpoint, now });
  const incident = await loadIncidentController(process.env.GALAXY_INCIDENT_FILE, { endpoint, now });
  const resourceBudgetPolicy=await loadResourceBudgetPolicy(process.env.GALAXY_RESOURCE_BUDGET_FILE);
  let forumPolicy=await loadForumPolicy(process.env.GALAXY_FORUM_POLICY_FILE);
  const metricsConfig=await loadMetricsConfiguration(process.env);
  const metrics=createOperationalMetrics({component:'worker',...metricsConfig,backupStatusDirectory:null,logStatus:runtimeLog.status});
  if(process.env.GALAXY_SEARCH_INDEX_ENABLED!==undefined&&!['true','false'].includes(process.env.GALAXY_SEARCH_INDEX_ENABLED))throw new Error('Invalid search index state');
  const searchIndexMode=process.env.GALAXY_SEARCH_INDEX_ENABLED==='true'?'enabled':process.env.GALAXY_SEARCH_INDEX_ENABLED==='false'?'disabled':'unconfigured';
  stage='configuration-audit';
  await recordRuntimeConfig(db,{endpoint,component:'worker',operatorRef:process.env.GALAXY_OPERATOR_REF,
    snapshot:runtimeConfigSnapshot({forumPolicyHash:forumPolicyHash(forumPolicy),incident:incident.policy(),retirement:retirement.snapshot().policy,release,resourceBudgetHash:digest(JSON.stringify(resourceBudgetPolicy)),searchIndexMode})});
  const evidence = new EvidenceService(null, new ConsentReader({ now, readGrant: workerReads.readGrant }), { db, endpoint, now, readCase: workerReads.readCase,resourceBudgetPolicy });
  const ciV2 = createCiWorkerV2({ db, endpoint, now, resourceBudgetPolicy });
  const probes=new BuilderProbeWorker({db,endpoint,now,consents:new ConsentReader({now,readGrant:workerReads.readGrant}),readBuilder:workerReads.readBuilder,resourceBudgetPolicy});
  stage='queue-start';
  operationsJobs=createOperationsJobs({db,scheduling:true,onError:diagnostic=>runtimeLog.write({event:'operations_job_failed',...diagnostic}),onEvent:runtimeLog.write});
  await operationsJobs.start();
  stage='operations-config';
  const operatorAuthorization=await loadOperationsWorkerAuthorization(process.env.GALAXY_OPERATIONS_CONFIG_FILE,{db,endpoint});
  const accountDirectory=await loadOperationsAccountDirectory(process.env.GALAXY_OPERATIONS_CONFIG_FILE);
  const permissions=new OperationsPermissionsService({db,endpoint,operatorAuthorization,now});
  const businessAdmin=new BusinessAdminService({db,endpoint,operatorAuthorization,permissions,identityDirectory:accountDirectory,now});
  const aiWorkAccounts=new AiWorkAccountsReadModel({db,endpoint,businessAdmin,now});
  permissions.aiWorkAccounts=aiWorkAccounts;
  const autonomyConfiguration=await loadOperationsAgentOsConfiguration(process.env.GALAXY_AGENTOS_CONFIG_FILE,{endpoint});
  const autonomyClient=new OperationsAgentOsClient({...autonomyConfiguration,now});
  const autonomyAuthority=new OperationsAgentOsAuthority({db,endpoint,permissions,aiWorkAccounts,now});
  const autonomy=new OperationsAutonomy({db,endpoint,businessAdmin,jobs:operationsJobs,authority:autonomyAuthority,client:autonomyClient,aiWorkAccounts,now});
  autonomy.codeRunner=task=>autonomy.native.run(task);
  businessAdmin.executorAuthority=autonomyAuthority;
  const autonomyWorker=createOperationsAutonomyWorker({autonomy,jobs:operationsJobs,logger:runtimeLog.write});
  await autonomyWorker.start();
  const registeredDirectory=await loadRegisteredWebsiteDirectory(process.env.GALAXY_REGISTERED_DIRECTORY_CONFIG_FILE);
  const registeredUsers=new OperationsRegisteredUsersService({businessAdmin,directory:registeredDirectory});
  const operationsFileCleanup=new OperationsFileCleanupService({businessAdmin,chatAttachments:attachments,forumAttachments,now,logger:runtimeLog.write});
  const operationsRules=new OperationsProductRules({db,endpoint,businessAdmin,now});
  const discoveryConfiguration=await loadDiscoveryConfiguration(process.env.GALAXY_DISCOVERY_CONFIG_FILE,{endpoint});
  if(discoveryConfiguration&&!discoveryConfiguration.sourceMetadata)throw new Error('Discovery worker source metadata is required');
  const discoverySource=discoveryConfiguration?createDiscoveryReadOnlySource({db,endpoint,now,readGrant:workerReads.readGrant,forumPolicy,...discoveryConfiguration.sourceMetadata}):null;
  const discoveryRuntime=discoveryConfiguration?createDiscoveryRuntime({db,endpoint,now,source:discoverySource,config:discoveryConfiguration}):null;
  const discoveryWorker=discoveryRuntime?new DiscoveryWorker(discoveryRuntime):null;
  if(discoveryRuntime)await discoveryRuntime.store.initialize();
  let discoverySeedComplete=discoveryRuntime?Boolean((await db.query('SELECT scan_complete FROM discovery_index_control_v1 WHERE endpoint=$1',[endpoint])).rows[0]?.scan_complete):true;
  const policyRuntime=createOperationsPolicyRuntime({rules:operationsRules,component:'worker',consumers:workerOperationsPolicyConsumers({evidence,ciV2,probes,onForumPolicy:policy=>{
    forumPolicy=policy;
    if(discoverySource){const policyHash=forumPolicyHash(policy),forum=discoverySource.forum;for(const consumer of [forum,forum.permissions,forum.budget,forum.governance])if(consumer)Object.assign(consumer,{policy,policyHash});}
  }})});
  await policyRuntime.refresh();
  const operationsNotices=new OperationsNotices({db,endpoint,businessAdmin,jobs:operationsJobs,now});
  const smtpCredentials=process.env.GALAXY_MESSAGING_SMTP_CREDENTIAL_FILE
    ?createRefreshingSmtpCredentialResolver(process.env.GALAXY_MESSAGING_SMTP_CREDENTIAL_FILE,{endpoint})
    :await loadOperationsSmtpCredentials(undefined,{endpoint});
  const operationsSmtp=new OperationsSmtpService({db,endpoint,businessAdmin,directory:accountDirectory,credentialResolver:smtpCredentials,now});
  const operationsMessaging=new OperationsMessagingService({db,endpoint,businessAdmin,jobs:operationsJobs,mailProvider:operationsSmtp,lockPlan:workerReads.lockMessagingPlan,now});
  operationsMessaging.autonomy=autonomy;
  autonomyAuthority.durableOperationAuthorizationWithin=(tx,context)=>operationsMessaging.validatePersistedApprovalWithin(tx,context);
  const messagingWorkers=createOperationsMessagingWorkers({messaging:operationsMessaging});
  const operationsRetention=new OperationsRetention({db,endpoint,businessAdmin,jobs:operationsJobs,now});
  await createOperationsNoticeWorker({notices:operationsNotices,jobs:operationsJobs}).start();
  await operationsJobs.work('messaging-run',messagingWorkers.run);
  await operationsJobs.work('messaging-delivery',messagingWorkers.delivery);
  await createOperationsRetentionWorker({retention:operationsRetention,jobs:operationsJobs}).start();
  const searchIndex=process.env.GALAXY_SEARCH_INDEX_ENABLED==='true'?new SearchIndex({db,endpoint,now,readGrant:workerReads.readGrant,jobs:operationsJobs}):null;
  if(searchIndex)await searchIndex.configure({enabled:true});
  else if(process.env.GALAXY_SEARCH_INDEX_ENABLED==='false')await new SearchIndex({db,endpoint,now}).configure({enabled:false});
  if(searchIndex)await operationsJobs.work('search-recovery',(data,context)=>searchIndex.recoverJob(data,context));
  stage='metrics';
  metricsServer=await startMetricsListener(metrics,metricsConfig.port);
  installRuntimeFailureHandlers({logger:runtimeLog.error,onFatal:()=>stop()});
  runtimeLog.write({event:'runtime_started',stage:'startup',startedAt:runtimeStartedAt});
  await reportServiceConnectionAdoption(process.env.GALAXY_SERVICE_CONNECTIONS_METADATA_FILE,{component:'worker',discoveryRuntime,attachmentConfiguration});
  await reportOperationsMailAdoption(process.env.GALAXY_SYSTEM_SETTINGS_MAIL_METADATA_FILE,{component:'worker',smtp:operationsSmtp,credentialFile:process.env.GALAXY_MESSAGING_SMTP_CREDENTIAL_FILE});
  // Uploaded programs never execute here. The protected AgentOS service
  // credential is used only for the fixed original-task endpoints.
  let nextExportCleanup = 0;
  let nextIndexRefresh=0;
  let nextDiscoveryReconcile=Date.now()+60000;
  let nextPolicyRefresh=Date.now()+30000;
  let nextRegisteredDirectorySync=0;
  let nextAutonomyHealth=Date.now()+30000;
  while (!stopping) {
    const started=performance.now();
    try {
      // The worker's independent fallback observes AI silence and re-arms the
      // same durable tick; it does not invoke a model or replay a business POST.
      if(Date.now()>=nextAutonomyHealth){stage='autonomy-health';await autonomyWorker.tick();nextAutonomyHealth=Date.now()+autonomy.defaults.healthSeconds*1000;}
      if(registeredDirectory&&Date.now()>=nextRegisteredDirectorySync){
        nextRegisteredDirectorySync=Date.now()+60000;stage='registered-directory-sync';
        try{await registeredUsers.sync();}
        catch(error){runtimeLog.error({event:'registered_directory_sync_failed',stage,error});}
      }
      if(Date.now()>=nextPolicyRefresh){
        nextPolicyRefresh=Date.now()+30000;stage='policy-refresh';
        try{const refreshed=await policyRuntime.refresh();if(refreshed.items.some(item=>item.errorCode))runtimeLog.write({event:'operations_policy_refresh_failed',stage});}
        catch(error){runtimeLog.error({event:'operations_policy_refresh_failed',stage,error});}
      }
      if (Date.now() >= nextExportCleanup) {
        nextExportCleanup = Date.now() + 60000;
        stage='export-cleanup';
        const cleanup = await cleanupExpiredExports(db);
        await operationsRetention.recordMaintenance({target:'data-exports',result:cleanup});
        if (cleanup.removed) runtimeLog.write({ event: 'expired_exports_removed', count: cleanup.removed });
        stage='product-retention';
        const productCleanup = await cleanupProductV2Retention(db,{outcomeStore:attachments?.store ?? null,forumPolicy,endpoint});
        await operationsRetention.recordMaintenance({target:'private-conversation-archives',result:{privateConversationArchives:productCleanup.removed.privateConversationArchives}});
        await operationsRetention.recordMaintenance({target:'information-watches',result:{informationChangeReceipts:productCleanup.removed.informationChangeReceipts,informationWatchReceipts:productCleanup.removed.informationWatchReceipts}});
        if (Object.values(productCleanup.removed).some(Boolean)) runtimeLog.write({event:'product_lifecycle_cleanup',stage,count:Object.values(productCleanup.removed).filter(Number.isSafeInteger).reduce((sum,n)=>sum+n,0)});
      }
      if (stopping) break;
      const paused=!retirement.canProcessEvidence()||!incident.canProcessEvidence();
      stage='evidence-process';
      const result = paused ? { processed: false } : await evidence.processNext();
      stage='ci-process';
      const nativeCi = paused || stopping ? { processed: false } : await ciV2.processNext();
      if(attachments&&!stopping){
        // Storage retention continues during a publication pause; no model or
        // uploaded program executes here. Scanner outage defers only this queue.
        const attachmentStartedAt=performance.now();
        try {stage='attachment-cleanup';await attachments.purgeExpired({limit:20});await forumAttachments.purgeExpired({limit:20});if(!stopping){stage='approved-file-cleanup';await operationsFileCleanup.processApproved({limit:1});}if(!stopping){stage='account-feedback-deletion';await accountFeedbackData.processOwnerDeletions({limit:1});}if(!paused&&!stopping){stage='attachment-scan';await attachments.scanPending({limit:1});await forumAttachments.scanPending({limit:1});await feedbackAttachments.scanPending({limit:1});}}
        catch(error) {runtimeLog.write({event:'attachment_processing_deferred',stage,startedAt:attachmentStartedAt,error});}
      }
      if (nativeCi.processed) runtimeLog.write({ event: 'ci_v2_observation_job', state: nativeCi.state });
      // A signal may arrive while the preceding task drains. Never claim work
      // from another queue after that task has finished.
      stage='builder-probe';
      const probed=paused||stopping?{processed:false}:await probes.processNext();
      metrics.builderProbe(probed);
      if(probed.processed)runtimeLog.write({event:'builder_probe_job',state:probed.state});
      let indexed={processed:false};
      if(!stopping&&!paused&&searchIndex){
        if(Date.now()>=nextIndexRefresh){
          stage='search-seed';await searchIndex.seedBatch();
          if(!stopping){stage='search-refresh';await searchIndex.refreshExpired();}
          if(!stopping){stage='search-recovery';await searchIndex.recoverFailed();}
          nextIndexRefresh=Date.now()+1000;
        }
        if(!stopping){stage='search-process';indexed=await searchIndex.processNext();}
        if(indexed.processed)runtimeLog.write({event:'search_index_job',state:indexed.state});
      }
      let discoveryProcessed=false;
      if(!stopping&&!paused&&discoveryWorker){
        // A temporary governance restriction can expire without a SQL write.
        // Reconcile in bounded batches so removed public candidates can return
        // after that boundary; current-source checks still gate every result.
        if(discoverySeedComplete&&Date.now()>=nextDiscoveryReconcile)discoverySeedComplete=false;
        if(!discoverySeedComplete){stage='discovery-seed';const seeded=await discoveryWorker.seedBatch();discoverySeedComplete=seeded.complete;if(seeded.complete)nextDiscoveryReconcile=Date.now()+60000;}
        if(!stopping){stage='discovery-index';const item=await discoveryWorker.indexOne();discoveryProcessed=!['idle','not-connected'].includes(item.state);if(discoveryProcessed)runtimeLog.write({event:'discovery_index_job',state:item.state,code:item.code});}
        if(!stopping){stage='discovery-delivery';const item=await discoveryWorker.deliverOne();const processed=!['idle','not-connected'].includes(item.state);discoveryProcessed=discoveryProcessed||processed;if(processed)runtimeLog.write({event:'discovery_delivery_job',state:item.state,target:item.target,code:item.code});}
      }
      metrics.workerIteration(result,(performance.now()-started)/1000,{paused});
      if (result.processed) runtimeLog.write({ event: 'evidence_job', state: result.state });
      else if(!stopping&&!indexed.processed&&!probed.processed&&!nativeCi.processed&&!discoveryProcessed)await new Promise(resolve => setTimeout(resolve, 1000));
    } catch(error) {
      metrics.workerIteration(null,(performance.now()-started)/1000,{failed:true});
      runtimeLog.error({event:'evidence_job_failed',stage,startedAt:started,error});
      if(!stopping)await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
} catch(error) { runtimeLog.error({event:'worker_startup_failed',stage,startedAt:runtimeStartedAt,error}); process.exitCode = 1; }
finally {
  shutdown.start();
  const startedAt=performance.now();
  await closeStep('attachment-cleanup',()=>attachmentConfiguration?.store.close());
  await closeStep('metrics-close',()=>closeMetricsListener(metricsServer));
  await closeStep('queue-stop',()=>operationsJobs?.stop());
  await closeStep('database-close',()=>db?.end());
  runtimeLog.write({event:'runtime_stopped',stage:'shutdown',startedAt,exitCode:process.exitCode??0});
  try{await runtimeLog.close();}catch{process.exitCode=1;}shutdown.finish();
}
