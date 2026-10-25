import { AsyncLocalStorage } from 'node:async_hooks';
import { ServiceError } from './service-error.mjs';

const context = new AsyncLocalStorage();
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const names = new Set(['Error','TypeError','RangeError','ReferenceError','SyntaxError','URIError','EvalError',
  'AggregateError','AbortError','TimeoutError','DatabaseError','ZodError']);
// Only machine codes, never a database detail/hint/query, upstream body or Error.message.
const machineCodes = new Set(['EACCES','EADDRINUSE','EADDRNOTAVAIL','EAGAIN','EBUSY','ECANCELED','ECONNABORTED',
  'ECONNREFUSED','ECONNRESET','EEXIST','EHOSTUNREACH','EIO','EISDIR','EMFILE','ENETUNREACH','ENFILE','ENOENT',
  'ENOSPC','ENOTDIR','ENOTEMPTY','ENOTFOUND','EPERM','EPIPE','EROFS','ETIMEDOUT','ABORT_ERR',
  'ERR_STREAM_DESTROYED','ERR_STREAM_PREMATURE_CLOSE','ERR_HTTP_REQUEST_TIMEOUT','ERR_HTTP_HEADERS_SENT',
  'ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','ERR_OUT_OF_RANGE','ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  'ERR_SQLITE_ERROR','ERR_SQLITE_BUSY','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT',
  'HPE_HEADER_OVERFLOW','HPE_INVALID_METHOD','HPE_INVALID_URL','HPE_INVALID_HEADER_TOKEN','HPE_INVALID_EOF_STATE',
  '08000','08001','08003','08004','08006','08007','08P01','0A000','22001','22003','22007','22012','22023',
  '22P02','23502','23503','23505','23514','25006','25P02','28000','28P01','3D000','3F000','40001','40P01',
  '42501','42601','42703','42704','42883','42P01','42P07','53300','53400','54000','55000','55P03',
  '57014','57P01','57P02','57P03','58000','58030','XX000','XX001','XX002']);
const stages = new Set(['environment','runtime-log','endpoint','signing-key','trust','listener-config','release',
  'database','database-role','database-pool','database-connect','transaction-rollback','recovery','governance',
  'services','identity-providers','external-credentials','attachment-config','personal-mcp','configuration-audit',
  'audit-spool','audit-spool-status','audit-spool-read','audit-spool-record','audit-delivery','listen','metrics',
  'http-request','http-address','http-url','http-quota','http-browser-policy','http-readiness','http-dispatch','http-parser',
  'startup','shutdown','metrics-close','watch-stop','queue-stop','chat-stop','chat-drain','credentials-close',
  'audit-close','database-close','log-close','chat-start','queue-start','queue-error','queue-execute','queue-complete',
  'watch-execute','watch-reconcile','watch-start','watch-schedule','export-cleanup','product-retention',
  'evidence-process','ci-process','attachment-cleanup','attachment-scan','builder-probe','search-seed',
  'search-refresh','search-recovery','search-process','publisher-config','publisher-files','publisher-current',
  'publisher-prepare','publisher-activate','publisher-start','publisher-stop','credentials-refresh',
  'transport-reconnect','archive','account-reports','personal-expiry','personal-sources','shared-expiry',
  'shared-sources','choice-expiry','choice-sources','chat-maintenance','policy-refresh']);
const outcomes = new Set(['started','succeeded','failed','cancelled','stopped','deferred','superseded','published','unknown']);
const queues = new Set(['information-watch','search-recovery','content-publication','account-notice','retention-cleanup','messaging-run','messaging-delivery']);
const environments = new Set(['production','staging','development','test','local','integration','pilot','unknown']);
const valueOf = (value, key) => { try { return value?.[key]; } catch { return undefined; } };

function frameFile(location){
  if(typeof location!=='string')return null;
  location=location.replaceAll('\\','/');
  if(/^node:[a-zA-Z0-9_/-]+$/.test(location))return location;
  const source=/(?:^|\/)(packages\/galaxy-official\/(?:src|scripts)\/[a-zA-Z0-9_./-]+\.(?:mjs|js))$/.exec(location);
  const dependency=/(?:^|\/)node_modules\/((?:pg|pg-pool|pg-boss|pino|rotating-file-stream|@electric-sql\/pglite)\/[a-zA-Z0-9_./-]+\.(?:mjs|cjs|js))$/.exec(location);
  const file=source?.[1]??(dependency?'node_modules/'+dependency[1]:null);
  return file&&!file.split('/').includes('..')?file:null;
}

function stackFrames(error) {
  const stack = valueOf(error,'stack');
  if (typeof stack !== 'string') return [];
  const result = [];
  // Drop the message line, function names, absolute prefixes and URL parameters.
  for (const line of stack.split('\n').slice(1,50)) {
    if (!/^\s+at /.test(line)) continue;
    const match = /(?:\(|\s)([^()]+):(\d+):(\d+)\)?$/.exec(line);
    if (!match) continue;
    const file=frameFile(match[1]);
    const row = Number(match[2]), column = Number(match[3]);
    if (!file || file.split('/').includes('..') || row < 1 || row > 10000000 || column < 1 || column > 1000000) continue;
    result.push({file,line:row,column});
    if (result.length === 12) break;
  }
  return result;
}

export function safeRuntimeError(error, depth = 0, seen = new Set()) {
  const service = error instanceof ServiceError;
  const name = valueOf(error,'name'), code = valueOf(error,'code');
  const result = {errorName:service?'ServiceError':names.has(name)?name:'Error',
    errorCode:machineCodes.has(code)||service&&typeof code==='string'&&/^[a-z][a-z0-9_]{0,99}$/.test(code)?code:'unclassified_error',
    stackFrames:stackFrames(error)};
  if(typeof valueOf(error,'cmd')==='string'&&Number.isInteger(code)&&code>=0&&code<=255){result.errorCode='PROCESS_EXIT';result.errorExitCode=code;}
  if(['SIGTERM','SIGKILL','SIGINT','SIGABRT','SIGSEGV'].includes(valueOf(error,'signal')))result.errorSignal=valueOf(error,'signal');
  if (error && typeof error === 'object' && depth < 2 && !seen.has(error)) {
    seen.add(error);
    const cause = valueOf(error,'cause');
    if (cause && typeof cause === 'object' && !seen.has(cause)) result.cause = safeRuntimeError(cause,depth+1,seen);
  }
  return result;
}

function formattedError(input,depth=0){
  if(input?.errorName!=='ServiceError'&&!names.has(input?.errorName))return {};
  const result={errorName:input.errorName,errorCode:machineCodes.has(input.errorCode)||input.errorCode==='PROCESS_EXIT'
    ||input.errorName==='ServiceError'&&typeof input.errorCode==='string'&&/^[a-z][a-z0-9_]{0,99}$/.test(input.errorCode)?input.errorCode:'unclassified_error',stackFrames:[]};
  for(const frame of Array.isArray(input.stackFrames)?input.stackFrames.slice(0,12):[]){
    const file=frameFile(frame?.file);
    if(file&&Number.isSafeInteger(frame.line)&&frame.line>0&&frame.line<=10000000&&Number.isSafeInteger(frame.column)&&frame.column>0&&frame.column<=1000000)
      result.stackFrames.push({file,line:frame.line,column:frame.column});
  }
  if(Number.isInteger(input.errorExitCode)&&input.errorExitCode>=0&&input.errorExitCode<=255)result.errorExitCode=input.errorExitCode;
  if(['SIGTERM','SIGKILL','SIGINT','SIGABRT','SIGSEGV'].includes(input.errorSignal))result.errorSignal=input.errorSignal;
  if(depth<2&&input.cause?.errorName)result.cause=formattedError(input.cause,depth+1);
  return result;
}

export function runtimeDiagnosticFields(input = {}) {
  const result = {}, inherited = context.getStore() ?? {};
  for (const key of ['requestId','jobId','resourceId']) {
    const value = input[key] ?? inherited[key];
    if (typeof value === 'string' && uuid.test(value)) result[key] = value;
  }
  const stage = input.stage ?? inherited.stage;
  if (stages.has(stage)) result.stage = stage;
  const queue = input.queue ?? inherited.queue;
  if (queues.has(queue)) result.queue = queue;
  if (outcomes.has(input.outcome)) result.outcome = input.outcome;
  if (Number.isSafeInteger(input.attempt) && input.attempt >= 0) result.attempt = input.attempt;
  const elapsed = input.durationMs ?? (Number.isFinite(input.startedAt)?performance.now()-input.startedAt:undefined);
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 31536000000) result.durationMs = Math.round(elapsed*1000)/1000;
  if (input.error !== undefined) Object.assign(result,safeRuntimeError(input.error));
  else Object.assign(result,formattedError(input));
  return result;
}

export function withRuntimeDiagnosticContext(fields, operation) {
  const selected = runtimeDiagnosticFields(fields);
  return context.run({...context.getStore(),...selected},operation);
}

export function runtimeDiagnosticContext({release,environment} = {}) {
  return {release:typeof release==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(release)?release:'unknown',
    environment:environments.has(environment)?environment:'unknown'};
}
