import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { browserScopes } from '../src/browser-client.mjs';
import {createExistingWebRuntime} from './existing-web-identity-fixture.mjs';

test('real HTTP connection generations distinguish rebinds and never revive a disconnected failed or concurrent connect', async () => {
  const f = await serviceFixture(browserScopes, null, { now: Math.floor(Date.now() / 1000) });
  const api = createApi({ ...f, rateLimit: 1000 });
  const values = new Map(), store = { get: async key => structuredClone(values.get(key)),
    put: async (key, value) => { values.set(key, structuredClone(value)); }, update: memoryAtomicUpdate(values) };
  let runtime, rejectChallenge = false, holdChallenge, enteredChallenge;
  try {
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const local = 'http://127.0.0.1:' + api.address().port;
    const wire = async (url, options) => {
      if (new URL(url).pathname === '/v2/binding-challenges') {
        if (rejectChallenge) throw new Error('Synthetic reconnect unavailable');
        if (holdChallenge) { enteredChallenge(); await holdChallenge; options.signal.throwIfAborted(); }
      }
      return fetch(local + new URL(url).pathname, options);
    };

    runtime = await createExistingWebRuntime({ endpoint: f.access.endpoint, trustedKeys: f.bindings.trustedKeys },
      { store, fetch: wire, now: () => f.now });
    await runtime.connect({ confirmed: true });
    const first = runtime.api.snapshot();
    assert.ok(Number.isSafeInteger(first.generation)); assert.equal(Object.hasOwn(first, 'credential'), false);
    await runtime.connect({ confirmed: true });
    const second = runtime.api.snapshot();
    assert.equal(second.subjectId, first.subjectId); assert.ok(second.generation > first.generation);
    rejectChallenge = true;
    await assert.rejects(runtime.connect({ confirmed: true }), /reconnect unavailable/);
    assert.equal(runtime.api.snapshot().generation, second.generation, 'failed replacement does not install another lease');
    await runtime.disconnect();
    await assert.rejects(runtime.connect({ confirmed: true }), /reconnect unavailable/);
    assert.equal(runtime.api.snapshot(), null, 'a disconnected old session cannot return');
    rejectChallenge = false;
    await runtime.connect({ confirmed: true });
    const third = runtime.api.snapshot(); assert.ok(third.generation > second.generation);
    let release;
    holdChallenge = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { enteredChallenge = resolve; });
    const pending = runtime.connect({ confirmed: true });
    const rejected = assert.rejects(pending, error => error.name === 'AbortError');
    await entered;
    await assert.rejects(runtime.connect({ confirmed: true }), /one connection at a time/);
    await runtime.disconnect(); release(); await rejected;
    assert.equal(runtime.api.snapshot(), null, 'cancelled in-flight connect cannot reinstall its old lease');
    holdChallenge = null;
    await runtime.connect({ confirmed: true });
    assert.ok(runtime.api.snapshot().generation > third.generation);
  } finally { runtime?.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await f.db.close(); }
});
import {memoryAtomicUpdate} from './memory-atomic-update.mjs';
