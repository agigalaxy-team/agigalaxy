import { createShutdownDeadline } from './shutdown-deadline.mjs';
import { createRuntimeLogger,consoleRuntimeLogger,runtimeLogConfiguration } from './operations/runtime-log.mjs';
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
import { BuilderProbeWorker } from './builder-probes.mjs';
import { createCiWorkerV2 } from './ci-worker-v2.mjs';
import {loadAttachmentConfiguration} from './infrastructure/attachment-configuration.mjs';
import {ChatAttachmentsService} from './chat-attachments.mjs';
import {ForumAttachmentsV1Service} from './forum-attachments-v1.mjs';

let db;
let attachmentConfiguration;
let metricsServer;
let runtimeLog=consoleRuntimeLogger('worker',{destination:process.stderr});
const shutdown = createShutdownDeadline();
let stopping = false;
process.on('SIGTERM', () => { stopping = true; shutdown.start(); });
process.on('SIGINT', () => { stopping = true; shutdown.start(); });
try {
  assertRuntimeEnvironment(process.env, 'worker');
  const configuredLog=await createRuntimeLogger({component:'worker',...runtimeLogConfiguration(process.env)});
  await runtimeLog.close();runtimeLog=configuredLog;
  const release=await runtimeServiceRelease(process.env, 'worker', fileURLToPath(import.meta.url));
  const endpoint = process.env.GALAXY_ENDPOINT;
  if (new URL(endpoint).origin !== endpoint || !endpoint.startsWith('https://')) throw new Error();
  if (typeof process.getuid === 'function' && process.getuid() === 0) throw new Error();
  db = openDatabase(process.env.DATABASE_URL);
  assertSupportedSchema((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows);
  await assertRecoveryReady(db);
  const functions = (await db.query(`SELECT
    to_regprocedure('public.galaxy_worker_lock_case(uuid,text)') IS NOT NULL AND
    to_regprocedure('public.galaxy_worker_lock_consent(uuid,text,timestamptz)') IS NOT NULL AND
    to_regprocedure('public.galaxy_worker_lock_builder(uuid)') IS NOT NULL AND
    to_regprocedure('public.galaxy_worker_lock_ci_case(uuid,uuid)') IS NOT NULL AND
    to_regprocedure('public.galaxy_worker_lock_ci_record(uuid,uuid)') IS NOT NULL AND
    to_regprocedure('public.galaxy_worker_prune_forum_authorizations(timestamptz)') IS NOT NULL AND
    to_regprocedure('public.galaxy_worker_lock_closed_forum_reports(timestamptz)') IS NOT NULL AND
    has_function_privilege(current_user,'public.galaxy_worker_prune_forum_authorizations(timestamptz)','EXECUTE') AND
    has_function_privilege(current_user,'public.galaxy_worker_lock_closed_forum_reports(timestamptz)','EXECUTE') AS ready`)).rows[0];
  if (!functions.ready) throw new Error('Worker role provisioning required');
  const now = () => Math.floor(Date.now() / 1000);
  attachmentConfiguration=await loadAttachmentConfiguration(process.env);
  const attachments=attachmentConfiguration?new ChatAttachmentsService({chat:{db,now},...attachmentConfiguration}):null;
  const forumAttachments=attachmentConfiguration?new ForumAttachmentsV1Service({db,now,...attachmentConfiguration}):null;
  const retirement = await loadRetirementController(process.env.GALAXY_RETIREMENT_FILE, { endpoint, now });
  const incident = await loadIncidentController(process.env.GALAXY_INCIDENT_FILE, { endpoint, now });
  const resourceBudgetPolicy=await loadResourceBudgetPolicy(process.env.GALAXY_RESOURCE_BUDGET_FILE);
  const forumPolicy=await loadForumPolicy(process.env.GALAXY_FORUM_POLICY_FILE);
  const metricsConfig=await loadMetricsConfiguration(process.env);
  const metrics=createOperationalMetrics({component:'worker',...metricsConfig,backupStatusDirectory:null,logStatus:runtimeLog.status});
  if(process.env.GALAXY_SEARCH_INDEX_ENABLED!==undefined&&!['true','false'].includes(process.env.GALAXY_SEARCH_INDEX_ENABLED))throw new Error('Invalid search index state');
  const searchIndexMode=process.env.GALAXY_SEARCH_INDEX_ENABLED==='true'?'enabled':process.env.GALAXY_SEARCH_INDEX_ENABLED==='false'?'disabled':'unconfigured';
  await recordRuntimeConfig(db,{endpoint,component:'worker',operatorRef:process.env.GALAXY_OPERATOR_REF,
    snapshot:runtimeConfigSnapshot({forumPolicyHash:forumPolicyHash(forumPolicy),incident:incident.policy(),retirement:retirement.snapshot().policy,release,resourceBudgetHash:digest(JSON.stringify(resourceBudgetPolicy)),searchIndexMode})});
  const evidence = new EvidenceService(null, new ConsentReader({ now, readGrant: workerReads.readGrant }), { db, endpoint, now, readCase: workerReads.readCase,resourceBudgetPolicy });
  const ciV2 = createCiWorkerV2({ db, endpoint, now, resourceBudgetPolicy });
  const probes=new BuilderProbeWorker({db,endpoint,now,consents:new ConsentReader({now,readGrant:workerReads.readGrant}),readBuilder:workerReads.readBuilder,resourceBudgetPolicy});
  const searchIndex=process.env.GALAXY_SEARCH_INDEX_ENABLED==='true'?new SearchIndex({db,endpoint,now,readGrant:workerReads.readGrant}):null;
  if(searchIndex)await searchIndex.configure({enabled:true});
  else if(process.env.GALAXY_SEARCH_INDEX_ENABLED==='false')await new SearchIndex({db,endpoint,now}).configure({enabled:false});
  metricsServer=await startMetricsListener(metrics,metricsConfig.port);
  // This process never loads a signing key or executes uploaded code. Production
  // deployment must separately restrict its egress and database role.
  let nextExportCleanup = 0;
  let nextIndexRefresh=0;
  while (!stopping) {
    const started=performance.now();
    try {
      if (Date.now() >= nextExportCleanup) {
        nextExportCleanup = Date.now() + 60000;
        const cleanup = await cleanupExpiredExports(db);
        if (cleanup.removed) runtimeLog.write({ event: 'expired_exports_removed', count: cleanup.removed });
        const productCleanup = await cleanupProductV2Retention(db,{outcomeStore:attachments?.store ?? null,forumPolicy,endpoint});
        if (Object.values(productCleanup.removed).some(Boolean)) runtimeLog.write({ event: 'product_lifecycle_cleanup', counts: productCleanup.removed });
      }
      if (stopping) break;
      const paused=!retirement.canProcessEvidence()||!incident.canProcessEvidence();
      const result = paused ? { processed: false } : await evidence.processNext();
      const nativeCi = paused || stopping ? { processed: false } : await ciV2.processNext();
      if(attachments&&!stopping){
        // Storage retention continues during a publication pause; no model or
        // uploaded program executes here. Scanner outage defers only this queue.
        try {await attachments.purgeExpired({limit:20});await forumAttachments.purgeExpired({limit:20});if(!paused&&!stopping){await attachments.scanPending({limit:1});await forumAttachments.scanPending({limit:1});}}
        catch {runtimeLog.write({event:'attachment_processing_deferred'});}
      }
      if (nativeCi.processed) runtimeLog.write({ event: 'ci_v2_observation_job', state: nativeCi.state });
      // A signal may arrive while the preceding task drains. Never claim work
      // from another queue after that task has finished.
      const probed=paused||stopping?{processed:false}:await probes.processNext();
      metrics.builderProbe(probed);
      if(probed.processed)runtimeLog.write({event:'builder_probe_job',state:probed.state});
      let indexed={processed:false};
      if(!stopping&&!paused&&searchIndex){
        if(Date.now()>=nextIndexRefresh){
          await searchIndex.seedBatch();
          if(!stopping)await searchIndex.refreshExpired();
          nextIndexRefresh=Date.now()+1000;
        }
        if(!stopping)indexed=await searchIndex.processNext();
        if(indexed.processed)runtimeLog.write({event:'search_index_job',state:indexed.state});
      }
      metrics.workerIteration(result,(performance.now()-started)/1000,{paused});
      if (result.processed) runtimeLog.write({ event: 'evidence_job', state: result.state });
      else if(!stopping&&!indexed.processed&&!probed.processed&&!nativeCi.processed)await new Promise(resolve => setTimeout(resolve, 1000));
    } catch {
      metrics.workerIteration(null,(performance.now()-started)/1000,{failed:true});
      runtimeLog.error({ event: 'evidence_job_failed' });
      if(!stopping)await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
} catch { runtimeLog.error({ event: 'worker_startup_failed' }); process.exitCode = 1; }
finally {
  attachmentConfiguration?.store.close();
  shutdown.start();
  try { await closeMetricsListener(metricsServer); if (db) await db.end(); }
  catch { runtimeLog.error({ event: 'worker_shutdown_failed' }); process.exitCode = 1; }
  finally { try{await runtimeLog.close();}catch{process.exitCode=1;}shutdown.finish(); }
}
