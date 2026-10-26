// Test-only routing to a real, locally issued TLS server. This preload is never
// imported by a service entry or included in a service release.
import assert from 'node:assert/strict';
import https from 'node:https';
import dns from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { BuilderProbeWorker } from "../../src/builders/builder-probes.mjs";
import { SearchIndex } from "../../src/discovery/search-index.mjs";

assert.equal(process.env.GALAXY_TEST_PG_ISOLATED, '1');
assert.equal(typeof process.send, 'function');
const port = Number(process.env.GALAXY_TEST_SOURCE_PORT);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
const ca = readFileSync(process.env.GALAXY_TEST_SOURCE_CA);
const nativeRequest = https.request;
dns.lookup = async host => {
  assert.equal(host, 'api.github.com');
  return [{ address: '8.8.8.8', family: 4 }];
};
https.request = (url, options, callback) => {
  assert.equal(url.origin, 'https://api.github.com');
  assert.match(url.pathname, /^\/repos\/fixture\/example\/actions\/runs\/\d+\/attempts\/1$/);
  assert.notEqual(options.rejectUnauthorized, false);
  assert.equal(options.checkServerIdentity, undefined);
  assert.equal(options.headers.Authorization, undefined);
  const local = new URL(url); local.port = String(port);
  return nativeRequest(local, { ...options, ca,
    lookup: (_host, flags, done) => flags.all
      ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4) }, response => {
    assert.equal(response.socket.authorized, true);
    callback(response);
  });
};
syncBuiltinESMExports();

let stopping = false;
const afterStopCalls = [];
for (const [type, methods] of [[BuilderProbeWorker, ['processNext']], [SearchIndex, ['seedBatch', 'refreshExpired', 'processNext']]]) {
  for (const name of methods) {
    const original = type.prototype[name];
    type.prototype[name] = function (...args) {
      if (stopping) afterStopCalls.push(type.name + '.' + name);
      return original.apply(this, args);
    };
  }
}
process.once('SIGTERM', () => {
  stopping = true;
  process.send({ event: 'fixture-stop-seen' }, () => { if (process.connected) process.disconnect(); });
});
process.on('message', message => { if (message === 'stop-fixture') process.emit('SIGTERM'); });
process.on('exit', () => process.stdout.write(JSON.stringify({ event: 'fixture-drain', afterStopCalls }) + '\n'));
