import { safeAlloyRecordTemplate } from './log-record.mjs';

const q = JSON.stringify;
export function logFileSources(config) {
  return [...config.logs, ...config.dockerLogs.map(entry => ({ ...entry, path: config.directories.data + '/component-logs/' + entry.component + '.jsonl' }))];
}
function labels(config, entry, source) {
  return `{component = ${q(entry.component)}, environment = ${q(config.environment)}, release = "unreported", source_kind = ${q(source)}}`;
}

export function alloyConfiguration(config) {
  const files = logFileSources(config);
  const targets = files.map(entry => `{__path__ = ${q(entry.path)}, component = ${q(entry.component)}, environment = ${q(config.environment)}, release = "unreported", source_kind = "file"}`).join(',\n    ');
  return `logging { level = "warn" }
${files.length ? `loki.source.file "runtime" {
  targets = [${targets}]
  forward_to = [loki.process.runtime.receiver]
  tail_from_end = false
  on_positions_file_error = "restart_from_beginning"
}` : ''}
${config.journals.map((entry, index) => `loki.source.journal "runtime_${index}" {
  matches = ${q('_SYSTEMD_UNIT=' + entry.unit)}
  format_as_json = false
  max_age = ${q(config.logCollection.journalMaxAgeHours + 'h')}
  labels = ${labels(config, entry, 'journal')}
  forward_to = [loki.process.runtime.receiver]
}`).join('\n')}
loki.process "runtime" {
  forward_to = [loki.write.local.receiver]
  stage.decolorize {}
  stage.json {
    expressions = {time = "time || timestamp", ts = "ts", event = "event", code = "code", status = "status || statusCode", phase = "phase", action = "action", level = "level || severity", requestId = "requestId || request_id", edgeRequestId = "edgeRequestId", jobId = "jobId", resourceId = "resourceId", stage = "stage", queue = "queue", outcome = "outcome", attempt = "attempt", state = "state", delivery = "delivery", auditStatus = "auditStatus", signal = "signal", exitCode = "exitCode", count = "count", pending = "pending", version = "version", port = "port", release = "release", method = "method || request.method", path = "route || cleanPath || path", durationMs = "durationMs", duration = "duration", size = "size", logger = "logger", exception = "exception || exceptionClass || errorName", sqlState = "sqlState", errorName = "errorName || diagnostic.errorName", errorCode = "errorCode || diagnostic.errorCode", errorSignal = "errorSignal || diagnostic.errorSignal", errorExitCode = "errorExitCode || diagnostic.errorExitCode", stackFrames = "stackFrames || frames || diagnostic.stackFrames || diagnostic.frames", cause = "cause || diagnostic.cause"}
    drop_malformed = false
  }
  stage.regex { expression = ${q('(?i)\\b(?P<plainLevel>trace|debug|info|notice|warn|warning|error|fatal|panic)\\b')} }
  stage.regex { expression = ${q('\\b(?P<exception>(?:(?:[A-Za-z_][A-Za-z0-9_]*[.]){1,16}[A-Za-z_$][A-Za-z0-9_$]*(?:Exception|Error)|Error|[A-Za-z][A-Za-z0-9_$]{0,79}(?:Error|Exception)))\\b')} }
  stage.regex { expression = ${q('(?i)(?:SQLSTATE[= :]+|SQL state: )(?P<sqlState>[0-9A-Z]{5})\\b')} }
  stage.timestamp {
    source = "ts"
    format = "Unix"
    action_on_failure = "skip"
  }
  stage.timestamp {
    source = "time"
    format = "RFC3339Nano"
    action_on_failure = "skip"
  }
  // Keep output safe even if a later projection encounters an unexpected type.
  stage.template {
    source = "safe_line"
    template = ${q('{"event":"log_projection_failed","level":"warn","detailsOmitted":true}')}
  }
  stage.template {
    source = "safe_line"
    template = ${q(safeAlloyRecordTemplate())}
  }
  stage.output { source = "safe_line" }
  stage.json {
    source = "safe_line"
    expressions = {safe_level = "level", safe_release = "release", safe_requestId = "requestId", safe_edgeRequestId = "edgeRequestId", safe_jobId = "jobId", safe_resourceId = "resourceId", safe_exception = "exception || errorName", safe_sqlState = "sqlState"}
  }
  stage.labels { values = {level = "safe_level", release = "safe_release"} }
  stage.structured_metadata { values = {requestId = "safe_requestId", edgeRequestId = "safe_edgeRequestId", jobId = "safe_jobId", resourceId = "safe_resourceId", exception = "safe_exception", sqlState = "safe_sqlState"} }
  stage.label_drop { values = ["filename", "job", "stream", "container", "container_id"] }
}
loki.write "local" {
  endpoint { url = "http://127.0.0.1:${config.loki.port}/loki/api/v1/push" }
}
`;
}

export function loggingDashboard() {
  const query = '{environment="$environment",component=~"${component:regex}",release=~"${release:regex}"} | requestId=~".*${requestId:regex}.*" or edgeRequestId=~".*${requestId:regex}.*"';
  return {
    uid: 'galaxy-logs', title: '运行日志', schemaVersion: 40, version: 1, editable: false, tags: ['galaxy'], timezone: 'browser', time: { from: 'now-1h', to: 'now' }, refresh: '30s',
    templating: { list: [
      { name: 'environment', label: '环境', type: 'query', datasource: { type: 'loki', uid: 'galaxy-loki' }, query: 'label_values(environment)', refresh: 1 },
      { name: 'component', label: '组件', type: 'query', datasource: { type: 'loki', uid: 'galaxy-loki' }, query: 'label_values({environment="$environment"},component)', includeAll: true, allValue: '.*', multi: true, current: { text: 'All', value: '$__all' }, refresh: 1 },
      { name: 'release', label: '版本', type: 'query', datasource: { type: 'loki', uid: 'galaxy-loki' }, query: 'label_values({environment="$environment"},release)', includeAll: true, allValue: '.*', multi: true, current: { text: 'All', value: '$__all' }, refresh: 1 },
      { name: 'requestId', label: '请求 ID', type: 'textbox', query: '', current: { text: '', value: '' } }
    ] },
    panels: [
      { id: 1, title: '日志', type: 'logs', gridPos: { x: 0, y: 0, w: 24, h: 18 }, datasource: { type: 'loki', uid: 'galaxy-loki' }, targets: [{ refId: 'A', expr: query }], options: { showTime: true, showLabels: true, wrapLogMessage: true, sortOrder: 'Descending', enableLogDetails: true } },
      { id: 2, title: '错误与警告', type: 'timeseries', gridPos: { x: 0, y: 18, w: 24, h: 7 }, datasource: { type: 'loki', uid: 'galaxy-loki' }, targets: [{ refId: 'A', expr: 'sum by(component,level)(count_over_time({environment="$environment",component=~"${component:regex}",level=~"warn|error"}[5m]))' }] }
    ]
  };
}
