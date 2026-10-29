import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOperationalRecord, safeOperationalPath } from './log-record.mjs';
import { createDockerLogDecoder, dockerLogArguments } from './component-logs.mjs';
import { runtimeDiagnosticFields } from '../../../galaxy-client/src/node/runtime-diagnostics.mjs';
import { adminLog } from '../../../../apps/galaxy-admin/src/lib/runtime-log.mjs';

test('safe projection retains operational facts without request, credential, code or private content', () => {
  const requestId = '00000000-0000-4000-8000-000000000001';
  const record = normalizeOperationalRecord(JSON.stringify({
    time: '2026-10-20T10:00:00.000Z', event: 'http_request_finished', level: 'error', status: 503,
    requestId, code: '482913', method: 'POST', durationMs: 32,
    route: '/v1/identity/callback/galaxy-account?code=SECRET_QUERY&state=SECRET_STATE',
    message: 'PRIVATE_BODY_CANARY', body: { password: 'PRIVATE_PASSWORD_CANARY', token: 'PRIVATE_TOKEN_CANARY' },
    headers: { cookie: 'PRIVATE_COOKIE_CANARY' }, email: 'private-person@example.invalid',
  }));
  assert.equal(record.event, 'http_request_finished'); assert.equal(record.requestId, requestId);
  assert.equal(record.code, undefined); assert.equal(record.status, 503); assert.equal(record.durationMs, 32);
  assert.equal(record.path, '/v1/identity/callback/galaxy-account'); assert.equal(record.detailsOmitted, true);
  const output = JSON.stringify(record);
  for (const value of ['482913', 'PRIVATE_', 'SECRET_', 'example.invalid', 'headers', 'body', 'cookie', 'password', 'token']) assert.equal(output.includes(value), false);
});

test('vendor records keep error category, class and SQLSTATE while omitting text and opaque routes', () => {
  const record = normalizeOperationalRecord('ERROR com.example.DatabaseException: permission denied SQLSTATE 42501; private query SECRET_QUERY', { time: '2026-10-20T10:00:00.000000001Z' });
  assert.equal(record.level, 'error'); assert.equal(record.diagnostic, 'permission_denied');
  assert.equal(record.exception, 'com.example.DatabaseException'); assert.equal(record.sqlState, '42501');
  assert.equal(record.time, '2026-10-20T10:00:00.000000001Z'); assert.equal(JSON.stringify(record).includes('SECRET_QUERY'), false);
  assert.equal(safeOperationalPath('/review/abcdefghijklmnop12345678?secret=x'), '/:handoff/:ref');
  assert.equal(safeOperationalPath('/v1/identity/return/00000000-0000-4000-8000-000000000001'), '/v1/identity/return/:ref');
  assert.equal(safeOperationalPath('/%70rivate'), undefined);
  assert.equal(normalizeOperationalRecord('{"release":"18.6"}').release, '18.6');
});

test('Docker source commands stay read-only and explicitly address the local daemon', () => {
  assert.deepEqual(dockerLogArguments('galaxy-accounts-pilot-keycloak-1', '24h'), ['--host', 'unix:///var/run/docker.sock', 'logs', '--follow', '--timestamps', '--since', '24h', 'galaxy-accounts-pilot-keycloak-1']);
  assert.throws(() => dockerLogArguments('name;docker-exec', '24h'), /container_invalid/);
  assert.throws(() => dockerLogArguments('galaxy-api', '--details'), /cursor_invalid/);
});

test('Docker framing keeps fragmented/final records and discards oversized input before projection', () => {
  const lines = [], decoder = createDockerLogDecoder(line => lines.push(line));
  decoder.write('first rec'); decoder.write('ord\nsecond record'); decoder.end();
  assert.deepEqual(lines, [{ line: 'first record', truncated: false }, { line: 'second record', truncated: false }]);
  decoder.write('PRIVATE_'.repeat(10000)); decoder.write('\nsafe\n'); decoder.end();
  assert.deepEqual(lines.slice(2), [{ line: '', truncated: true }, { line: 'safe', truncated: false }]);
});

test('actual API diagnostics retain route, zero attempt, task context, twelve safe frames and two causes', () => {
  const jobId = '00000000-0000-4000-8000-000000000002', resourceId = '00000000-0000-4000-8000-000000000003';
  const error = Object.assign(new TypeError('PRIVATE_ERROR_MESSAGE'), { code: 'ERR_INVALID_ARG_TYPE' });
  error.stack = ['TypeError: PRIVATE_ERROR_MESSAGE', ...Array.from({ length: 15 }, (_, index) => '    at handler (/opt/releases/current/packages/galaxy-official/src/server.mjs:' + (index + 1) + ':7)')].join('\n');
  error.cause = Object.assign(new Error('PRIVATE_SQL_DETAIL'), { code: 'ECONNREFUSED', cause: Object.assign(new Error('PRIVATE_CAUSE_2'), { code: '42501', cause: new Error('PRIVATE_CAUSE_3') }) });
  const fields = runtimeDiagnosticFields({ stage: 'queue-execute', queue: 'information-watch', jobId, resourceId, attempt: 0, outcome: 'failed', error });
  const record = normalizeOperationalRecord(JSON.stringify({ event: 'operations_job_failed', level: 50, route: 'GET /v1/operations/jobs/' + jobId, ...fields }));
  assert.equal(record.path, '/v1/operations/jobs/:ref'); assert.equal(record.method, 'GET'); assert.equal(record.route, 'GET /v1/operations/jobs/:ref');
  assert.equal(record.stage, 'queue-execute'); assert.equal(record.queue, 'information-watch'); assert.equal(record.attempt, 0);
  assert.equal(record.jobId, jobId); assert.equal(record.resourceId, resourceId); assert.equal(record.outcome, 'failed');
  assert.equal(record.errorName, 'TypeError'); assert.equal(record.errorCode, 'ERR_INVALID_ARG_TYPE'); assert.equal(record.stackFrames.length, 12);
  assert.deepEqual(record.stackFrames[0], { file: 'packages/galaxy-official/src/server.mjs', line: 1, column: 7 });
  assert.equal(record.cause.errorCode, 'ECONNREFUSED'); assert.equal(record.cause.cause.errorCode, '42501'); assert.equal(record.cause.cause.cause, undefined);
  assert.equal(JSON.stringify(record).includes('PRIVATE_'), false);
});

test('actual admin diagnostics normalize statusCode and basename frames without error text or absolute paths', () => {
  const error = Object.assign(new Error('PRIVATE_UPSTREAM_BODY'), { code: 'ECONNREFUSED', stack: 'Error: PRIVATE_UPSTREAM_BODY\n    at request (/srv/private/admin/server-proxy.ts:62:11)' });
  const row = adminLog('admin_http_request', { stage: 'upstream', method: 'POST', path: '/v1/operations/users/00000000-0000-4000-8000-000000000003?secret=PRIVATE_QUERY', statusCode: 503, error }, () => {});
  const record = normalizeOperationalRecord(JSON.stringify(row));
  assert.equal(record.status, 503); assert.equal(record.stage, 'upstream'); assert.equal(record.errorName, 'Error'); assert.equal(record.errorCode, 'ECONNREFUSED');
  assert.deepEqual(record.stackFrames, [{ file: 'server-proxy.ts', line: 62, column: 11 }]);
  assert.equal(JSON.stringify(record).includes('PRIVATE_'), false); assert.equal(JSON.stringify(record).includes('/srv/private'), false);
});
