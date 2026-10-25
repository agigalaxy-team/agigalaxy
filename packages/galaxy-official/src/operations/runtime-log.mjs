import {runtimeDiagnosticFields} from '../shared/runtime-diagnostics.mjs';
import {failureRoute} from '../adapters/http/failure-audit.mjs';
import {consoleRuntimeLogger as sharedConsoleRuntimeLogger,createRuntimeLogger as sharedCreateRuntimeLogger} from '../shared/runtime-logger.mjs';
export {runtimeLogConfiguration,installRuntimeFailureHandlers} from '../shared/runtime-logger.mjs';

const phases=new Set(['environment','runtime-log','endpoint','signing-key','trust','listener-config','release','database','recovery',
  'database-role','governance','services','identity-providers','external-credentials','attachment-config','personal-mcp','configuration-audit','audit-spool','metrics','listen']);
const events=new Set(['http_rejected','listening','startup_failed','failure_audit_delivery','failure_audit_spool_failed',
  'expired_exports_removed','evidence_job','evidence_job_failed','search_index_job','builder_probe_job','worker_startup_failed','worker_shutdown_failed',
  'discovery_index_job','discovery_delivery_job',
  'migration_complete','migration_failed','runtime_started','runtime_stopping','runtime_stopped','runtime_shutdown_failed',
  'runtime_uncaught_exception','runtime_unhandled_rejection','database_pool_failed','database_transaction_failed',
  'http_completed','http_failure_audit_failed','chat_transport_unavailable','chat_retention_deferred',
  'external_credentials_status_unavailable','operations_job_failed','operations_job_finished','information_watch_deferred',
  'product_lifecycle_cleanup','ci_v2_observation_job','attachment_processing_deferred','file_cleanup_deferred',
  'content_publication_worker_started','content_publication_startup_failed','content_publication_queue_failed',
  'content_publication_step','content_publication_step_failed','operations_policy_refresh_failed']);
const deliveries=new Set(['idle','recorded','retry-pending','suppressed-by-deletion']);
const audits=new Set(['queued','closed','capacity','failed','recorded','unconfirmed','suppressed-by-deletion']);
const codes=new Set(['internal_error','access_denied','invalid_request','not_found','rate_limited','capacity_limited','service_unavailable',
  'request_aborted','connection_closed','http_parse_failed','storage_quota_exceeded','job_queue_quota_exceeded','export_ticket_quota_exceeded',
  'discovery_engine_unavailable','discovery_engine_authorization_failed','discovery_engine_failed','discovery_engine_response_invalid',
  'discovery_index_task_failed','discovery_index_task_pending','discovery_worker_failed','discovery_delivery_failed',
  'discovery_engine_not_connected','discovery_delivery_unconfirmed']);
export function runtimeLogEvent(input){
  const event=events.has(input?.event)?input.event:input?.event===undefined&&Number.isInteger(input?.status)?'http_rejected':'runtime_event_rejected';
  const result={event};
  if(typeof input?.requestId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.requestId))result.requestId=input.requestId;
  if(Number.isInteger(input?.status)&&input.status>=100&&input.status<=599)result.status=input.status;
  if(input?.code!==undefined)result.code=codes.has(input.code)?input.code:'other_error';
  if(phases.has(input?.phase))result.phase=input.phase;
  if(deliveries.has(input?.delivery))result.delivery=input.delivery;
  if(audits.has(input?.auditStatus))result.auditStatus=input.auditStatus;
  if(['observed','revoked','unavailable','indexed','hidden','pending','failed','reachable','authentication-required','protocol-mismatch',
    'removed','source-changed','delivered','confirmed','result-unknown','source-unavailable','excluded'].includes(input?.state))result.state=input.state;
  if(['openpanel','gorse'].includes(input?.target))result.target=input.target;
  for(const field of ['count','pending','version','port'])
    if(Number.isSafeInteger(input?.[field])&&input[field]>=0)result[field]=input[field];
  if(input?.route==='http.request'||input?.route==='http.parser')result.route=input.route;
  else if(typeof input?.route==='string'){
    const match=/^(GET|POST|PUT|DELETE|PATCH|OPTIONS) (\/[^?#\s]*)$/.exec(input.route);
    if(match)result.route=failureRoute(match[1],match[2]);
  }
  if(['SIGTERM','SIGINT','uncaughtException','unhandledRejection'].includes(input?.signal))result.signal=input.signal;
  if(Number.isInteger(input?.exitCode)&&input.exitCode>=0&&input.exitCode<=255)result.exitCode=input.exitCode;
  Object.assign(result,runtimeDiagnosticFields(input));
  return result;
}

// Keep the existing server API and its strict default event projection.
export function consoleRuntimeLogger(component,{eventFormatter=runtimeLogEvent,...options}={}){
 return sharedConsoleRuntimeLogger(component,{eventFormatter,...options});
}
export async function createRuntimeLogger({eventFormatter=runtimeLogEvent,...options}){
 return sharedCreateRuntimeLogger({eventFormatter,...options});
}
