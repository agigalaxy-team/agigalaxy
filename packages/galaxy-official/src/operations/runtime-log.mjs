import pino from 'pino';
import { createStream } from 'rotating-file-stream';
import { mkdir,lstat } from 'node:fs/promises';
import { isAbsolute,join } from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

const phases=new Set(['environment','runtime-log','endpoint','signing-key','trust','listener-config','release','database','recovery',
  'database-role','governance','services','identity-providers','attachment-config','personal-mcp','configuration-audit','audit-spool','listen']);
const events=new Set(['http_rejected','listening','startup_failed','failure_audit_delivery','failure_audit_spool_failed',
  'expired_exports_removed','evidence_job','evidence_job_failed','search_index_job','builder_probe_job','worker_startup_failed','worker_shutdown_failed',
  'migration_complete','migration_failed']);
const deliveries=new Set(['idle','recorded','retry-pending','suppressed-by-deletion']);
const audits=new Set(['queued','closed','capacity','failed','recorded','unconfirmed','suppressed-by-deletion']);
const codes=new Set(['internal_error','access_denied','invalid_request','not_found','rate_limited','capacity_limited','service_unavailable',
  'request_aborted','connection_closed','http_parse_failed','storage_quota_exceeded','job_queue_quota_exceeded','export_ticket_quota_exceeded']);
export function runtimeLogEvent(input){
  const event=events.has(input?.event)?input.event:input?.event===undefined&&Number.isInteger(input?.status)?'http_rejected':'runtime_event_rejected';
  const result={event};
  if(typeof input?.requestId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.requestId))result.requestId=input.requestId;
  if(Number.isInteger(input?.status)&&input.status>=100&&input.status<=599)result.status=input.status;
  if(input?.code!==undefined)result.code=codes.has(input.code)?input.code:'other_error';
  if(phases.has(input?.phase))result.phase=input.phase;
  if(deliveries.has(input?.delivery))result.delivery=input.delivery;
  if(audits.has(input?.auditStatus))result.auditStatus=input.auditStatus;
  if(['observed','revoked','unavailable','indexed','hidden','pending','failed','reachable','authentication-required','protocol-mismatch'].includes(input?.state))result.state=input.state;
  for(const field of ['count','pending','version','port'])
    if(Number.isSafeInteger(input?.[field])&&input[field]>=0)result[field]=input[field];
  return result;
}
export function runtimeLogConfiguration(env){
  const directory=env.GALAXY_RUNTIME_LOG_DIRECTORY??null;
  const instance=env.GALAXY_RUNTIME_LOG_INSTANCE??'primary';
  const rotateBytes=Number(env.GALAXY_RUNTIME_LOG_ROTATE_BYTES??10485760);
  const maxFiles=Number(env.GALAXY_RUNTIME_LOG_MAX_FILES??14);
  if(directory!==null&&!isAbsolute(directory))throw new Error('Absolute runtime log directory required');
  if(!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(instance)||!Number.isSafeInteger(rotateBytes)||rotateBytes<1024||rotateBytes>1073741824
    ||!Number.isInteger(maxFiles)||maxFiles<1||maxFiles>90)throw new Error('Invalid runtime log configuration');
  return {directory,instance,rotateBytes,maxFiles};
}
function loggerFor(component,sink,{owned=false,maxBufferedBytes=1048576,fallback=process.stderr}={}){
  if(!['api','worker','migration'].includes(component))throw new Error('Invalid log component');
  let failed=false,closed=false,writeFailures=0,droppedRecords=0,rotationWarnings=0,rotations=0,reported=false;
  const report=reason=>{
    if(reported)return;reported=true;
    try{fallback.write(JSON.stringify({event:'runtime_log_sink_unavailable',component,reason})+'\n');}catch{}
  };
  const onError=()=>{failed=true;writeFailures++;report('write_failed');};
  sink.on('error',onError);
  if(owned){sink.on('warning',()=>{rotationWarnings++;report('rotation_warning');});sink.on('rotated',()=>{rotations++;});}
  const output={write(line){
    if(closed||failed||sink.destroyed||(sink.writableLength??0)+Buffer.byteLength(line)>maxBufferedBytes){
      droppedRecords++;report('buffer_or_sink_unavailable');return false;
    }
    try{return sink.write(line);}catch{onError();droppedRecords++;return false;}
  }};
  const logger=pino({base:{component},timestamp:pino.stdTimeFunctions.isoTime},output);
  const write=(input,level)=>{
    const event=runtimeLogEvent(input);
    logger[level??(event.event.endsWith('_failed')||event.status>=500?'error':event.status>=400?'warn':'info')](event);
  };
  let closePromise=null;
  return {write,
    error:input=>write(input,'error'),
    status:()=>({mode:owned?'file':'stdout',ready:!closed&&!failed&&!sink.destroyed&&(sink.writableLength??0)<maxBufferedBytes,
      writeFailures,droppedRecords,rotationWarnings,rotations}),
    close(){
      if(closePromise)return closePromise;
      closed=true;
      closePromise=owned?(async()=>{const done=finished(sink,{cleanup:true});sink.end();await done;})():Promise.resolve();
      return closePromise.finally(()=>{if(!owned)sink.off('error',onError);});
    }
  };
}
export function consoleRuntimeLogger(component,{destination=process.stdout,...options}={}){
  return loggerFor(component,destination,options);
}
export async function createRuntimeLogger({component,directory=null,instance='primary',rotateBytes=10485760,maxFiles=14}){
  if(!['api','worker','migration'].includes(component))throw new Error('Invalid log component');
  if(!directory)return consoleRuntimeLogger(component);
  runtimeLogConfiguration({GALAXY_RUNTIME_LOG_DIRECTORY:directory,GALAXY_RUNTIME_LOG_INSTANCE:instance,
    GALAXY_RUNTIME_LOG_ROTATE_BYTES:String(rotateBytes),GALAXY_RUNTIME_LOG_MAX_FILES:String(maxFiles)});
  const path=join(directory,component+'-'+instance);
  await mkdir(path,{recursive:true,mode:0o700});
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||(process.platform!=='win32'&&(info.mode&0o077)))throw new Error('Invalid private runtime log directory');
  // Fixed numbered rotation avoids an imported history file controlling paths.
  // One writer per component/instance; stable name preserves rotation on restart.
  const stream=createStream(index=>index?'runtime.'+index+'.jsonl.gz':'runtime.jsonl',
    {path,size:rotateBytes+'B',interval:'1d',rotate:maxFiles,compress:'gzip',mode:0o600});
  const logger=loggerFor(component,stream,{owned:true});
  try{await once(stream,'open');return logger;}catch{stream.destroy();throw new Error('Runtime log file unavailable');}
}
