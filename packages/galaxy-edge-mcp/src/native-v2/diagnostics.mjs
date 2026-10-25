import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {consoleRuntimeLogger,createRuntimeLogger,runtimeLogConfiguration} from '../../../galaxy-official/src/shared/runtime-logger.mjs';

const context=new AsyncLocalStorage(),registeredTools=new Set(),defaults=new Map();
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const events=new Set(['native_runtime','native_tool','native_http','native_private_sync','native_transport','native_watch',
  'host_bridge','host_process','host_rpc','host_recording','host_archive','host_summary','client_log_rate_limited']);
const stages=new Set(['configuration','runtime','artifact','transport','tool','http','private-sync','shutdown',
  'bridge-start','bridge-request','host-process','host-rpc','recording','archive-backfill','archive-capture','archive-sync','archive-cleanup','summary',
  'watch-check','watch-status','watch-host','watch-ack']);
const outcomes=new Set(['started','succeeded','failed','cancelled','stopped','deferred','unknown']);
const names=new Set(['Error','TypeError','RangeError','ReferenceError','SyntaxError','URIError','AggregateError','AbortError','TimeoutError','ZodError']);
const methods=new Set(['initialize','tools/call','thread/start','thread/resume','thread/read','turn/start','turn/interrupt',
  'model/list','session/new','session/load','session/prompt','session/cancel']);
const codes=new Set(['EACCES','EADDRINUSE','EAGAIN','EBUSY','ECANCELED','ECONNABORTED','ECONNREFUSED','ECONNRESET',
  'EEXIST','EHOSTUNREACH','EIO','EMFILE','ENETUNREACH','ENOENT','ENOSPC','ENOTDIR','ENOTFOUND','EPERM','EPIPE',
  'EROFS','ETIMEDOUT','ABORT_ERR','ERR_STREAM_DESTROYED','ERR_STREAM_PREMATURE_CLOSE',
  'native_configuration_missing','native_configuration_path_required','native_configuration_not_found',
  'native_configuration_unreadable','native_configuration_too_large','native_configuration_invalid',
  'native_runtime_closed','native_operation_failed','native_tool_failed','native_log_configuration_unavailable',
  'native_connection_choice_required','native_connection_selection_changed','native_identity_required',
  'native_identity_changed','native_identity_selection_required','native_device_key_unavailable',
  'native_authorization_choice_required','native_authorization_request_changed','current_device_control_required',
  'receipt_status_authority_changed','native_choice_binding_changed','native_choice_changed_or_expired',
  'native_choice_in_progress','native_choice_already_consumed','local_identity_required','local_recovery_required',
  'local_initialization_requires_recovery','native_bridge_timeout_invalid','native_bridge_closed',
  'native_bridge_response_unknown','native_bridge_request_rejected','native_bridge_send_failed','native_bridge_result_invalid',
  'host_executable_required','host_timeout_invalid','host_disconnected','host_frame_too_large','host_process_failed',
  'host_protocol_invalid','host_rpc_failed','host_rpc_unknown','host_closed','host_process_shutdown_unconfirmed',
  'host_model_execution_unavailable','host_model_interrupted','host_model_summary_failed',
  'local_work_model_failed','local_work_model_session_invalid','local_work_model_interrupted','local_work_model_output_invalid',
  'local_work_summary_revision_conflict','local_work_recording_unavailable','local_archive_selection_unavailable',
  'host_messages_unavailable','local_archive_capture_unavailable','selected_archive_sync_unavailable',
  'request_timeout','request_failed','request_aborted','unauthorized','binding_revoked','invalid_session','session_expired',
  'access_denied','account_selection_required','official_account_changed','service_unavailable','rate_limited',
  'work_sync_snapshot_too_large','work_sync_unknown','archive_sync_unknown','local_archive_cleanup_failed',
  'watch_runtime_closed','watch_runtime_not_active','watch_work_changed','watch_host_scope_changed','watch_binding_changed',
  'watch_host_not_configured','watch_host_work_pending','watch_host_result_unknown','watch_host_choice_required']);
const valueOf=(value,key)=>{try{return value?.[key];}catch{return undefined;}};

function frames(error){
  const stack=valueOf(error,'stack');if(typeof stack!=='string')return [];
  const result=[];
  // No message line, function names, absolute directories, URL queries, or
  // user-selected executable/file paths. Only shipped source locations remain.
  for(const line of stack.split('\n').slice(1,50)){
    if(!/^\s+at /.test(line))continue;
    const match=/(?:\(|\s)([^()]+):(\d+):(\d+)\)?$/.exec(line);if(!match)continue;
    const location=match[1].replaceAll('\\','/');
    const source=/(?:^|\/)((?:packages\/galaxy-(?:edge-mcp|core)\/src|integrations\/native-v2|integrations\/host-adapters\/opencode-stable)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts))$/.exec(location);
    const bundle=/(?:^|\/)((?:galaxy|runtime|server|opencode|chunk-[A-Z0-9_-]+)\.js)$/.exec(location);
    const file=/^node:[A-Za-z0-9_/-]+$/.test(location)?location:source?.[1]??bundle?.[1];
    const row=Number(match[2]),column=Number(match[3]);
    if(!file||file.split('/').includes('..')||row<1||row>10000000||column<1||column>1000000)continue;
    result.push({file,line:row,column});if(result.length===12)break;
  }
  return result;
}
export function safeNativeError(error,depth=0,seen=new Set()){
  const name=valueOf(error,'name'),code=valueOf(error,'code'),message=valueOf(error,'message');
  const selected=codes.has(code)?code:codes.has(message)?message:'native_operation_failed';
  const result={errorName:names.has(name)?name:'Error',errorCode:selected,stackFrames:frames(error)};
  if(error&&typeof error==='object'&&depth<2&&!seen.has(error)){
    seen.add(error);const cause=valueOf(error,'cause');
    if(cause&&typeof cause==='object'&&!seen.has(cause))result.cause=safeNativeError(cause,depth+1,seen);
  }
  return result;
}
// This receives only static server registration names, never tool-call input.
export function registerDiagnosticTool(name){
  if(registeredTools.size<1024&&typeof name==='string'&&/^galaxy_[a-z0-9_]{1,100}$/.test(name))registeredTools.add(name);
}
export function nativeDiagnosticFields(input={}){
  const output={event:events.has(input.event)?input.event:'native_runtime'};
  if(stages.has(input.stage))output.stage=input.stage;
  if(outcomes.has(input.outcome))output.outcome=input.outcome;
  for(const key of ['requestId','upstreamRequestId'])if(typeof input[key]==='string'&&uuid.test(input[key]))output[key]=input[key];
  if(registeredTools.has(input.tool))output.tool=input.tool;
  if(methods.has(input.method))output.method=input.method;
  if(['opencode','codex','claude-code','copilot'].includes(input.host))output.host=input.host;
  if(Number.isFinite(input.durationMs)&&input.durationMs>=0&&input.durationMs<=31536000000)output.durationMs=Math.round(input.durationMs*1000)/1000;
  for(const key of ['attempt','pending','count','dropped'])if(Number.isSafeInteger(input[key])&&input[key]>=0)output[key]=input[key];
  if(Number.isInteger(input.status)&&input.status>=100&&input.status<=599)output.status=input.status;
  if(Number.isInteger(input.exitCode)&&input.exitCode>=0&&input.exitCode<=255)output.exitCode=input.exitCode;
  if(input.error!==undefined)Object.assign(output,safeNativeError(input.error));
  return output;
}
export function createNativeDiagnosticReporter(logger){
  let windowAt=performance.now(),written=0,dropped=0;
  function emit(fields){
    // Bound bursts without retaining their arguments, errors, or request data.
    try{
      const now=performance.now();
      if(now-windowAt>=1000){if(dropped)logger.write({event:'client_log_rate_limited',dropped});windowAt=now;written=0;dropped=0;}
      if(written++>=128){dropped++;return;}
      const inherited=context.getStore()??{};
      const value={...inherited,...fields,requestId:fields.requestId??inherited.requestId??randomUUID()};
      if(fields.outcome==='failed')logger.error(value);else logger.write(value);
    }catch{/* Diagnostics cannot change a business result or error. */}
  }
  async function run(stage,operation,{event='native_runtime',resultFailed,resultOutcome,independent=false,...fields}={}){
    const requestId=!independent&&context.getStore()?.requestId||randomUUID(),startedAt=performance.now();
    return context.run({requestId},async()=>{
      emit({...fields,event,stage,outcome:'started'});
      try{
        const value=await Promise.resolve().then(operation);let failed=false,selectedOutcome;
        try{failed=resultFailed?.(value)===true;}catch{}
        try{selectedOutcome=resultOutcome?.(value);}catch{}
        emit({...fields,event,stage,outcome:failed?'failed':outcomes.has(selectedOutcome)?selectedOutcome:'succeeded',durationMs:performance.now()-startedAt,
          ...(failed?{error:Error(event==='native_tool'?'native_tool_failed':'native_operation_failed')}:{})});
        return value;
      }catch(error){
        emit({...fields,event,stage,outcome:valueOf(error,'name')==='AbortError'?'cancelled':'failed',durationMs:performance.now()-startedAt,error});
        throw error;
      }
    });
  }
  const scope=(operation,{independent=false}={})=>context.run({requestId:!independent&&context.getStore()?.requestId||randomUUID()},operation);
  return Object.freeze({emit,run,scope,status:()=>({...logger.status(),rateLimitedRecords:dropped}),close:()=>logger.close()});
}
export function nativeDiagnostics(component='native'){
  if(!defaults.has(component))defaults.set(component,createNativeDiagnosticReporter(consoleRuntimeLogger(component,{destination:process.stderr,eventFormatter:nativeDiagnosticFields,maxBufferedBytes:262144,
    release:process.env.GALAXY_NATIVE_RELEASE,environment:process.env.GALAXY_ENVIRONMENT??'local'})));
  return defaults.get(component);
}
export async function createNativeDiagnostics({component='native',env=process.env}={}){
  try{
    const configuration=runtimeLogConfiguration({...env,GALAXY_RUNTIME_LOG_ROTATE_BYTES:env.GALAXY_RUNTIME_LOG_ROTATE_BYTES??'1048576',GALAXY_RUNTIME_LOG_MAX_FILES:env.GALAXY_RUNTIME_LOG_MAX_FILES??'4'});
    return createNativeDiagnosticReporter(await createRuntimeLogger({component,...configuration,release:env.GALAXY_NATIVE_RELEASE,
      eventFormatter:nativeDiagnosticFields,defaultDestination:process.stderr}));
  }catch(error){
    const fallback=nativeDiagnostics(component);
    fallback.emit({event:'native_runtime',stage:'configuration',outcome:'failed',error:Object.assign(Error('native_log_configuration_unavailable'),{cause:error})});
    return Object.freeze({...fallback,close:()=>Promise.resolve()});
  }
}
