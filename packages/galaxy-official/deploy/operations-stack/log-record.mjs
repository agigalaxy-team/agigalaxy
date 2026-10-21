// The collection boundary emits an operational record, never a raw message,
// request, SQL statement, authentication response or chat stanza.
export const diagnosticRules = [
  ['(?i)connection refused|failed to connect|connection timed out|connection reset', 'connection_failure'],
  ['(?i)permission denied|access denied|not authorized|forbidden', 'permission_denied'],
  ['(?i)out of memory|memory limit|oom', 'memory_pressure'],
  ['(?i)no space left|disk full', 'storage_full'],
  ['(?i)x509|certificate|tls handshake', 'tls_event'],
  ['(?i)migrat|schema', 'database_migration'],
  ['(?i)backup|restore|archive|checkpoint|wal', 'backup_event'],
  ['(?i)authentication|login|invalid.grant', 'authentication_event'],
  ['(?i)virus|clamav|signature.*updat|scan', 'scanner_event'],
  ['(?i)shutdown|stopping|stopped', 'service_shutdown'],
  ['(?i)started|starting|ready|listening', 'service_lifecycle'],
  ['(?i)exception|error|failed|failure', 'failure'],
];

export const operationalFieldPatterns = {
  event: '^[a-z][a-z0-9_.-]{0,95}$',
  code: '^[a-z][a-z0-9_-]{0,79}$',
  phase: '^[a-z][a-z0-9_-]{0,63}$',
  action: '^[a-z][a-z0-9_.-]{0,79}$',
  requestId: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  edgeRequestId: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  jobId: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  resourceId: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  stage: '^[a-z][a-z0-9-]{0,63}$',
  queue: '^(?:information-watch|search-recovery|content-publication)$',
  outcome: '^(?:started|succeeded|failed|cancelled|stopped|deferred|superseded|published|unknown)$',
  state: '^(?:observed|revoked|unavailable|indexed|hidden|pending|failed|reachable|authentication-required|protocol-mismatch)$',
  delivery: '^(?:idle|recorded|retry-pending|suppressed-by-deletion)$',
  auditStatus: '^(?:queued|closed|capacity|failed|recorded|unconfirmed|suppressed-by-deletion)$',
  signal: '^(?:SIGTERM|SIGINT|uncaughtException|unhandledRejection)$',
  logger: '^[A-Za-z][A-Za-z0-9_.:-]{0,119}$',
  exception: '^(?:(?:[A-Za-z_][A-Za-z0-9_]*[.]){1,16}[A-Za-z_$][A-Za-z0-9_$]*(?:Exception|Error)|Error|[A-Za-z][A-Za-z0-9_$]{0,79}(?:Error|Exception))$',
  sqlState: '^[0-9A-Z]{5}$',
  release: '^(?:[0-9]{1,4}[.][0-9]{1,4}(?:[.][0-9]{1,4})?(?:[-+][A-Za-z0-9_.-]{1,40})?|unreported)$',
  method: '^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$',
};
const validFields = Object.fromEntries(Object.entries(operationalFieldPatterns).map(([key, pattern]) => [key, new RegExp(pattern)]));
const errorNamePattern = '^(?:Error|[A-Za-z][A-Za-z0-9_$]{0,79}(?:Error|Exception))$';
// Matches the deliberately bounded runtime-diagnostics and admin logger output,
// not Error.message, database detail/hint or a freely supplied stack string.
const machineCodes = ['EACCES','EADDRINUSE','EADDRNOTAVAIL','EAGAIN','EBUSY','ECANCELED','ECONNABORTED','ECONNREFUSED','ECONNRESET','EEXIST','EHOSTUNREACH','EIO','EISDIR','EMFILE','ENETUNREACH','ENFILE','ENOENT','ENOSPC','ENOTDIR','ENOTEMPTY','ENOTFOUND','EPERM','EPIPE','EROFS','ETIMEDOUT','ABORT_ERR','ERR_STREAM_DESTROYED','ERR_STREAM_PREMATURE_CLOSE','ERR_HTTP_REQUEST_TIMEOUT','ERR_HTTP_HEADERS_SENT','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','ERR_OUT_OF_RANGE','ERR_CHILD_PROCESS_STDIO_MAXBUFFER','ERR_SQLITE_ERROR','ERR_SQLITE_BUSY','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','HPE_HEADER_OVERFLOW','HPE_INVALID_METHOD','HPE_INVALID_URL','HPE_INVALID_HEADER_TOKEN','HPE_INVALID_EOF_STATE','08000','08001','08003','08004','08006','08007','08P01','0A000','22001','22003','22007','22012','22023','22P02','23502','23503','23505','23514','25006','25P02','28000','28P01','3D000','3F000','40001','40P01','42501','42601','42703','42704','42883','42P01','42P07','53300','53400','54000','55000','55P03','57014','57P01','57P02','57P03','58000','58030','XX000','XX001','XX002','PROCESS_EXIT'];
const errorCodePattern = '^(?:' + machineCodes.join('|') + '|[A-Z][A-Z0-9_]{0,31}|[a-z][a-z0-9_]{0,99})$';
const frameFilePattern = '^(?:node:[A-Za-z0-9_/-]+|packages/galaxy-official/(?:src|scripts)/[A-Za-z0-9_./-]+[.](?:mjs|js)|node_modules/(?:pg|pg-pool|pg-boss|pino|rotating-file-stream|@electric-sql/pglite)/[A-Za-z0-9_./-]+[.](?:mjs|cjs|js)|[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}[.](?:mjs|cjs|js|ts|tsx))$';
const errorPatterns = { errorName: errorNamePattern, errorCode: errorCodePattern, errorSignal: '^(?:SIGTERM|SIGKILL|SIGINT|SIGABRT|SIGSEGV)$' };
const numberLimits = { status: [100, 599, true], durationMs: [0, 31536000000], duration: [0, 86400], size: [0, 1099511627776], attempt: [0, 2147483647, true], count: [0, 2147483647, true], pending: [0, 2147483647, true], version: [0, 2147483647, true], port: [0, 65535, true], exitCode: [0, 255, true] };
const exceptionInText = new RegExp('\\b' + operationalFieldPatterns.exception.slice(1, -1) + '\\b');
const sqlStateInText = /(?:SQLSTATE[= :]+|SQL state: )([0-9A-Z]{5})\b/i;
export const rfc3339Pattern = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:[.]\\d{1,9})?Z$';

export function safeOperationalPath(value) {
  if (typeof value === 'string') value = value.replace(/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) +/, '');
  if (typeof value !== 'string' || !value.startsWith('/')) return undefined;
  let path = value.split(/[?#]/, 1)[0];
  path = path.replace(/\/(?:[A-Za-z0-9_-]{20,}|\d{6,})(?=\/|$)/g, '/:ref');
  path = path.replace(/\/(?:review|connect)\/[^/]+/g, '/:handoff/:ref');
  // Encoded/ambiguous segments are not useful route names and can contain a
  // capability or private input. The application should emit its route shape.
  if (path.length > 240 || !/^\/[A-Za-z0-9_/:.*-]*$/.test(path)) return undefined;
  return path;
}

function diagnosticError(input, depth = 0) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result = {};
  for (const [key, pattern] of Object.entries(errorPatterns)) if (typeof input[key] === 'string' && new RegExp(pattern).test(input[key])) result[key] = input[key];
  if (Number.isInteger(input.errorExitCode) && input.errorExitCode >= 0 && input.errorExitCode <= 255) result.errorExitCode = input.errorExitCode;
  const frames = input.stackFrames ?? input.frames;
  if (Array.isArray(frames)) result.stackFrames = frames.slice(0, 12).flatMap(frame => {
    if (!frame || typeof frame.file !== 'string' || frame.file.length > 300 || !new RegExp(frameFilePattern).test(frame.file) || frame.file.split('/').includes('..') || !Number.isSafeInteger(frame.line) || frame.line < 1 || frame.line > 10000000 || !Number.isSafeInteger(frame.column) || frame.column < 1 || frame.column > 1000000) return [];
    return [{ file: frame.file, line: frame.line, column: frame.column }];
  });
  if (depth < 2 && input.cause && typeof input.cause === 'object') {
    const cause = diagnosticError(input.cause, depth + 1);
    if (Object.keys(cause).length) result.cause = cause;
  }
  return result;
}

export function normalizeOperationalRecord(line, { time } = {}) {
  if (typeof line !== 'string') line = '';
  let input;
  try { const parsed = JSON.parse(line); if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') input = parsed; } catch { /* Plain vendor records retain only operational facts below. */ }
  const record = { event: 'operational_record', level: 'info' };
  const category = diagnosticRules.find(([pattern]) => new RegExp(pattern.replace('(?i)', ''), 'i').test(line));
  if (category) record.diagnostic = category[1];
  for (const [key, expression] of Object.entries(validFields)) {
    const value = input?.[key] ?? (key === 'requestId' ? input?.request_id : key === 'exception' ? input?.exceptionClass ?? input?.errorName : undefined);
    if (typeof value === 'string' && expression.test(value)) record[key] = value;
  }
  const level = input?.level ?? input?.severity ?? /\b(trace|debug|info|notice|warn|warning|error|fatal|panic)\b/i.exec(line)?.[1];
  const levels = { trace: 'debug', debug: 'debug', info: 'info', notice: 'info', warn: 'warn', warning: 'warn', error: 'error', fatal: 'error', panic: 'error', 10: 'debug', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'error' };
  record.level = levels[String(level).toLowerCase()] ?? 'info';
  for (const [key, [minimum, maximum, integral]] of Object.entries(numberLimits)) {
    const value = input?.[key] ?? (key === 'status' ? input?.statusCode : undefined);
    if (typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum && (!integral || Number.isSafeInteger(value))) record[key] = value;
  }
  const route = input?.route ?? input?.cleanPath ?? input?.path, path = safeOperationalPath(route);
  const method = typeof route === 'string' && /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) +\//.exec(route)?.[1];
  if (method) record.method = method;
  if (path) { record.path = path; if (method) record.route = method + ' ' + path; }
  else if (route === 'http.request' || route === 'http.parser') record.route = route;
  Object.assign(record, diagnosticError(input));
  if (input?.diagnostic && typeof input.diagnostic === 'object') Object.assign(record, diagnosticError(input.diagnostic));
  if (!record.exception) { const value = exceptionInText.exec(line)?.[0]; if (value && validFields.exception.test(value)) record.exception = value; }
  if (!record.sqlState) { const value = sqlStateInText.exec(line)?.[1]; if (value && validFields.sqlState.test(value)) record.sqlState = value; }
  const timestamp = time ?? input?.time ?? input?.timestamp;
  if (typeof timestamp === 'string' && new RegExp(rfc3339Pattern).test(timestamp)) record.time = timestamp;
  record.detailsOmitted = true;
  return record;
}

// Alloy's supported Go/Sprig template functions perform the same allowlist
// projection for journal/file input. The original entry is never the output.
export function safeAlloyRecordTemplate() {
  const lines = ['{{- $r := dict "event" "operational_record" "level" "info" "detailsOmitted" true -}}'];
  for (const [index, [pattern, category]] of diagnosticRules.entries()) lines.push(`{{- ${index ? 'else if' : 'if'} regexMatch ${JSON.stringify(pattern)} .Entry -}}{{- $_ := set $r "diagnostic" ${JSON.stringify(category)} -}}`);
  lines.push('{{- end -}}');
  for (const [key, pattern] of Object.entries(operationalFieldPatterns)) lines.push(`{{- if and .${key} (regexMatch ${JSON.stringify(pattern)} (toString .${key})) -}}{{- $_ := set $r ${JSON.stringify(key)} (toString .${key}) -}}{{- end -}}`);
  lines.push('{{- $level := lower (toString (default .plainLevel .level)) -}}{{- if regexMatch "^(trace|debug|10|20)$" $level -}}{{- $_ := set $r "level" "debug" -}}{{- else if regexMatch "^(warn|warning|40)$" $level -}}{{- $_ := set $r "level" "warn" -}}{{- else if regexMatch "^(error|fatal|panic|50|60)$" $level -}}{{- $_ := set $r "level" "error" -}}{{- end -}}');
  for (const [key, [minimum, maximum, integral]] of Object.entries(numberLimits)) lines.push(`{{- if and (regexMatch ${JSON.stringify(integral ? '^[0-9]{1,13}$' : '^[0-9]{1,13}(?:[.][0-9]{1,9})?$')} (toString .${key})) (ge (float64 .${key}) ${minimum}.0) (le (float64 .${key}) ${maximum}.0) -}}{{- $_ := set $r ${JSON.stringify(key)} .${key} -}}{{- end -}}`);
  lines.push('{{- if .path -}}{{- $rawPath := toString .path -}}{{- $method := regexFind "^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) +" $rawPath -}}{{- $p := regexReplaceAll "^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) +" $rawPath "" -}}{{- $p = regexReplaceAll "[?#].*$" $p "" -}}{{- $p = regexReplaceAll "/[A-Za-z0-9_-]{20,}([/]|$)" $p "/:ref${1}" -}}{{- $p = regexReplaceAll "/[0-9]{6,}([/]|$)" $p "/:ref${1}" -}}{{- $p = regexReplaceAll "/(review|connect)/[^/]+" $p "/:handoff/:ref" -}}{{- if and (le (len $p) 240) (regexMatch "^/[A-Za-z0-9_/:.*-]*$" $p) (not (regexMatch "/([A-Za-z0-9_-]{20,}|[0-9]{6,})([/]|$)" $p)) -}}{{- $_ := set $r "path" $p -}}{{- if $method -}}{{- $_ := set $r "method" (trim $method) -}}{{- $_ := set $r "route" (printf "%s %s" (trim $method) $p) -}}{{- end -}}{{- else if regexMatch "^http[.](request|parser)$" $rawPath -}}{{- $_ := set $r "route" $rawPath -}}{{- end -}}{{- end -}}');
  lines.push(goDiagnosticProjection('.', '$r', 0));
  lines.push('{{- toJson $r -}}');
  return lines.join('');
}

function goDiagnosticProjection(source, target, depth) {
  const result = [];
  const field = key => source === '.' ? '.' + key : 'index ' + source + ' ' + JSON.stringify(key);
  for (const [key, pattern] of Object.entries(errorPatterns)) result.push(`{{- if and (${field(key)}) (regexMatch ${JSON.stringify(pattern)} (toString (${field(key)}))) -}}{{- $_ := set ${target} ${JSON.stringify(key)} (toString (${field(key)})) -}}{{- end -}}`);
  result.push(`{{- if and (regexMatch "^[0-9]{1,3}$" (toString (${field('errorExitCode')}))) (le (int64 (${field('errorExitCode')})) 255) -}}{{- $_ := set ${target} "errorExitCode" (${field('errorExitCode')}) -}}{{- end -}}`);
  const frames = '$frames' + depth, safeFrames = '$safeFrames' + depth;
  result.push(`{{- ${frames} := (${field('stackFrames')}) -}}{{- if kindIs "string" ${frames} -}}{{- ${frames} = fromJson ${frames} -}}{{- end -}}{{- if kindIs "slice" ${frames} -}}{{- ${safeFrames} := list -}}{{- range $i := until 12 -}}{{- if lt $i (len ${frames}) -}}{{- $frame := index ${frames} $i -}}{{- if kindIs "map" $frame -}}{{- $file := toString (index $frame "file") -}}{{- $line := toString (index $frame "line") -}}{{- $column := toString (index $frame "column") -}}{{- if and (regexMatch ${JSON.stringify(frameFilePattern)} $file) (not (has ".." (splitList "/" $file))) (regexMatch "^[0-9]{1,8}$" $line) (ge (int64 $line) 1) (le (int64 $line) 10000000) (regexMatch "^[0-9]{1,7}$" $column) (ge (int64 $column) 1) (le (int64 $column) 1000000) -}}{{- ${safeFrames} = append ${safeFrames} (dict "file" $file "line" (int64 $line) "column" (int64 $column)) -}}{{- end -}}{{- end -}}{{- end -}}{{- end -}}{{- $_ := set ${target} "stackFrames" ${safeFrames} -}}{{- end -}}`);
  if (depth < 2) {
    const cause = '$cause' + depth, safeCause = '$safeCause' + depth;
    result.push(`{{- ${cause} := (${field('cause')}) -}}{{- if kindIs "string" ${cause} -}}{{- ${cause} = fromJson ${cause} -}}{{- end -}}{{- if kindIs "map" ${cause} -}}{{- ${safeCause} := dict -}}`);
    // Both producers use stackFrames in causes; top-level admin frames is
    // mapped to stackFrames by the JSON extraction stage.
    result.push(goDiagnosticProjection(cause, safeCause, depth + 1));
    result.push(`{{- if gt (len ${safeCause}) 0 -}}{{- $_ := set ${target} "cause" ${safeCause} -}}{{- end -}}{{- end -}}`);
  }
  return result.join('');
}
