import test from 'node:test';
import assert from 'node:assert/strict';
import {adminLog,payloadLoggerOptions,routeTemplate,safeDiagnostic,requestCorrelation} from '../src/lib/runtime-log.mjs';

test('management diagnostics preserve source frames without request content or raw errors',()=>{
  const error=Object.assign(Error('password=secret@example.invalid SQL SELECT access_token'),{code:'ECONNREFUSED'});
  error.stack='Error: private\n    at fn (/private/credentials/user-secret/worker.mjs:23:9)\n    at secret (https://example.invalid/path?token=private:2:1)';
  const lines=[];const row=adminLog('operations.proxy',{stage:'upstream-transport',path:'https://admin.invalid/v1/operations/users/sensitive-user?code=secret',error,requestId:'9e6a6cff-a53e-48cb-a35f-84815ca588f5',statusCode:503,durationMs:12.5,cookie:'secret'},line=>lines.push(line));
  assert.equal(row.route,'/v1/operations/users/:id');assert.equal(row.errorCode,'ECONNREFUSED');
  assert.deepEqual(row.frames,[{file:'worker.mjs',line:23,column:9}]);
  assert.doesNotMatch(lines.join(''),/secret|SELECT|private|access_token|cookie|example/);
  assert.equal(routeTemplate('/api/site-pages/a-private-slug?draft=true'),'/api/site-pages/:id');
  assert.equal(safeDiagnostic({name:'Error',message:'secret',code:'secret@example.invalid'}).errorCode,undefined);
  assert.match(requestCorrelation(new Headers({'x-galaxy-edge-request-id':'malformed secret'})),/^[a-f0-9-]{36}$/);
});

test('Payload free-form messages and arbitrary objects are not emitted',()=>{
  const options=payloadLoggerOptions();let called;
  options.hooks.logMethod.call({},[{email:'secret@example.invalid',err:Error('private-token')},'secret'],function(...args){called=args;});
  assert.equal(called[1],'cms.runtime');
  const safe=options.formatters.log(called[0]);
  assert.equal(safe.event,'cms.runtime');assert.equal(safe.diagnostic.errorName,'Error');
  assert.doesNotMatch(JSON.stringify(safe),/secret|private-token|email|message/);
});
