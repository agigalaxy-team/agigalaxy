import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createInformationClientV2} from '../src/information-client-v2.mjs';

function fixture() {
  const endpoint = 'https://isolated-information.example', subjectId = 'GUID1501M4G06EBK9BEKWK2BYEHW7QSA', rows = new Map(), calls = [];
  let scope = {subjectId, closed: false, key: 'owner:1'}, generation = 1, handler = async () => ({state: 'absent'}), readHook = null;
  const storageKey = (name, owner) => owner + ':' + name;
  const runtime = {
    api: {endpoint, snapshot: () => ({endpoint, subjectId: scope.subjectId, bindingId: 'binding', generation}),
      call: async (path, input) => {calls.push({path, input}); return handler(path, input);}},
    taskDraftScope: () => ({...scope}),
    getLocal: async (name, owner) => {const value = structuredClone(rows.get(storageKey(name, owner)) ?? null); if (readHook) await readHook(); return value;},
    updateLocal: async (name, change, owner) => {const key = storageKey(name, owner), value = change(structuredClone(rows.get(key) ?? null)); rows.set(key, structuredClone(value)); return structuredClone(value);},
  };
  return {runtime, rows, calls, subjectId, client: () => createInformationClientV2({runtime, subjectId}),
    setHandler: value => {handler = value;}, setReadHook: value => {readHook = value;},
    switchOwner: value => {scope = {...scope, subjectId: value, key: randomUUID()}; generation++;},
    command: () => ({action: 'start', operationId: randomUUID(), watchId: randomUUID(), expectedRevision: 0,
      plan: {purpose: 'Synthetic original selection', sources: [{key: 'tasks', source: {kind: 'search', request: {type: 'task', query: {limit: 8}}}}], expiresAt: Math.floor(Date.now() / 1000) + 900}})};
}

test('two information pages atomically retain separate commands and a stop wins before an unsent execute', async () => {
  const f = fixture(), a = f.client(), b = f.client(), first = f.command(), second = f.command();
  await Promise.all([a.prepare(first), b.prepare(second)]);
  assert.equal((await a.pending()).length, 2);
  let resolveReceipt, started; const waiting = new Promise(resolve => {started = resolve;}), receipt = new Promise(resolve => {resolveReceipt = resolve;});
  let firstRead = true;
  f.setHandler(async (path, input) => {
    assert.ok(path.endsWith('/receipt'));
    if (input.operationId === first.operationId && firstRead) {firstRead = false; started(); return receipt;}
    return {state: 'absent'};
  });
  const sending = a.execute(first.operationId, {confirmed: true}), rejected = assert.rejects(sending, /不能重试/);
  await waiting; await b.stopLocal(first.operationId); resolveReceipt({state: 'absent'}); await rejected;
  const records = await b.pending();
  assert.equal(records.find(row => row.operationId === first.operationId).state, 'stopped-local');
  assert.equal(records.find(row => row.command?.operationId === second.operationId).state, 'prepared');
  assert.equal(f.calls.filter(row => !row.path.endsWith('/receipt')).length, 0);
});

test('an exact late receipt updates only its own locator and cannot restore a stopped command', async () => {
  const f = fixture(), a = f.client(), b = f.client(), first = f.command(), second = f.command();
  await Promise.all([a.prepare(first), b.prepare(second)]);
  let resolveReceipt, started; const waiting = new Promise(resolve => {started = resolve;}), receipt = new Promise(resolve => {resolveReceipt = resolve;});
  let firstRead = true;
  f.setHandler(async () => {if (firstRead) {firstRead = false; started(); return receipt;} return {state: 'absent'};});
  const reconciling = a.reconcile(first.operationId); await waiting; await b.stopLocal(first.operationId);
  resolveReceipt({state: 'acknowledged', result: {watchId: first.watchId}}); await reconciling;
  const state = [...f.rows.values()].find(row => row?.operations);
  const original = state.operations.find(row => row.operationId === first.operationId);
  assert.equal(original.state, 'acknowledged'); assert.equal(original.command, null);
  assert.equal(state.operations.find(row => row.command?.operationId === second.operationId).state, 'prepared');
});

test('query and watch drafts use independent CAS heads, preserve changed inputs, and never retain commands or authorization', async () => {
  const f = fixture(), a = f.client(), b = f.client(), value = {query: 'unfinished purpose', types: ['task'], environment: 'local'};
  const first = await a.saveComposerDraft('query', value, {expectedRevision: null});
  assert.deepEqual(await b.saveComposerDraft('query', value, {expectedRevision: null}), first);
  const next = await b.saveComposerDraft('query', {...value, query: 'newer input'}, {expectedRevision: first.revision});
  await assert.rejects(a.saveComposerDraft('query', {...value, query: 'other page input'}, {expectedRevision: first.revision}), error => error.code === 'information_composer_changed' && error.current.revision === next.revision);
  assert.equal((await a.clearComposerDraft('query', {revision: first.revision})).revision, next.revision);
  const watch = await a.saveComposerDraft('watch', {selected: [], watchPurpose: '', expires: 'unfinished date'}, {expectedRevision: null});
  assert.equal((await b.readComposerDraft('query')).revision, next.revision);
  assert.equal((await b.readComposerDraft('watch')).revision, watch.revision);
  for (const name of ['authorization', 'command', 'operationId', 'preparedConsent', 'signature', 'confirmed'])
    await assert.rejects(a.saveComposerDraft('query', {...value, [name]: {approved: true}}));
  await assert.rejects(a.saveComposerDraft('watch', {selected: [{key: 'tasks', source: {kind: 'search', request: {type: 'task', query: {limit: 8}}, authorization: {approved: true}}}]}));
  assert.equal(f.calls.length, 0);
  assert.equal(await a.clearComposerDraft('query', {revision: next.revision}), null);
  assert.equal((await a.readComposerDraft('watch')).revision, watch.revision);
});

test('local drafts fence late owner changes and retain visitor inputs only in their original namespace', async () => {
  const f = fixture(), owner = f.client(); await owner.saveComposerDraft('query', {query: 'original owner'});
  f.setReadHook(async () => {f.switchOwner(null);});
  await assert.rejects(owner.readComposerDraft('query'), /身份|连接/); f.setReadHook(null);
  const visitor = createInformationClientV2({runtime: f.runtime, subjectId: null});
  assert.equal(await visitor.readComposerDraft('query'), null);
  await visitor.saveComposerDraft('query', {query: 'visitor input'}, {expectedRevision: null});
  f.switchOwner(f.subjectId);
  await assert.rejects(visitor.saveComposerDraft('query', {query: 'late visitor overwrite'}), /身份/);
  assert.equal((await f.client().readComposerDraft('query')).value.query, 'original owner');
  assert.equal(f.calls.length, 0);
});

test('prepared-only editing stops only an unsent command and retains an unknown original operation', async () => {
  const f = fixture(), a = f.client(), b = f.client(), command = f.command(); await a.prepare(command);
  f.setHandler(async path => {if (path.endsWith('/receipt')) return {state: 'absent'}; throw Error('Synthetic ACK unavailable');});
  await assert.rejects(a.execute(command.operationId, {confirmed: true}), /ACK unavailable/);
  assert.equal((await b.stopLocal(command.operationId, {onlyPrepared: true})).state, 'result-unknown');
  const retained = (await b.pending())[0]; assert.equal(retained.command.operationId, command.operationId);
  assert.equal(f.calls.filter(row => row.path.endsWith('/command')).length, 1);
  const unsent = f.command(); await b.prepare(unsent);
  assert.equal((await b.stopLocal(unsent.operationId, {onlyPrepared: true})).state, 'stopped-local');
  await assert.rejects(a.prepare(unsent), /已停止/);
  assert.equal(f.calls.filter(row => row.path.endsWith('/command')).length, 1);
});
