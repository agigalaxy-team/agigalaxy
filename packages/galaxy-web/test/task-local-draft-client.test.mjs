import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskLocalDraftClient, taskLocalDraftView } from '../src/task-local-draft-client.mjs';

// This is an explicit module model, not a browser/IndexedDB cross-tab claim.
// It executes comparison and mutation together and allows real Promise gates
// before/after them, so lifecycle and queue behavior can be tested precisely.
const copy = value => structuredClone(value);
const ownerA = 'GUID15' + '0'.repeat(26), ownerB = 'GUID15' + '1'.repeat(26);
const fail = code => Object.assign(new Error(code), { code });
function gate() {
  let release, entered;
  const wait = new Promise(resolve => { release = resolve; });
  const hit = new Promise(resolve => { entered = resolve; });
  return { wait, hit, release, entered };
}
function fixture({ subjectId = null, draft } = {}) {
  let state = { endpoint: 'https://official.example.test', subjectId,
    deviceId: subjectId ? crypto.randomUUID() : null, bindingId: null, generation: null };
  const rows = new Map(), hooks = {}, calls = [];
  if (draft !== undefined) rows.set(subjectId ?? 'visitor', copy(draft));
  let tail = Promise.resolve();
  async function hook(kind, input) { if (hooks[kind]) await hooks[kind](input); }
  const adapter = {
    captureLease() {
      const original = state;
      return { ...original, assertCurrent() {
        if (state !== original) throw fail('task_draft_test_scope_changed');
      } };
    },
    async getLocal(name, key) {
      calls.push({ method: 'read', name, key });
      const value = copy(rows.get(key)); await hook('read', { key, value }); return value;
    },
    updateLocal(name, updater, key) {
      calls.push({ method: 'update', name, key });
      const run = tail.then(async () => {
        await hook('beforeUpdater', { key });
        const value = updater(copy(rows.get(key)));
        assert.equal(!!value && typeof value.then === 'function', false, 'updater must stay synchronous');
        rows.set(key, copy(value)); await hook('afterUpdater', { key, value }); return copy(value);
      });
      tail = run.then(() => undefined, () => undefined); return run;
    },
  };
  return { hooks, calls, adapter, client: () => createTaskLocalDraftClient(adapter),
    raw: (key = subjectId ?? 'visitor') => copy(rows.get(key)),
    external: (value, key = subjectId ?? 'visitor') => rows.set(key, copy(value)),
    change: patch => { state = { ...state, ...patch }; } };
}
function stored(value = {}, head = { id: crypto.randomUUID(), revision: 1 }) {
  return { format: 'galaxy-task-local-draft', version: 1, head, value };
}
const rejects = (promise, code) => assert.rejects(promise, { code });

test('visitor and disconnected identity retain local writing, with fixed explicit owner keys', async () => {
  for (const subjectId of [null, ownerA]) {
    const f = fixture({ subjectId }), client = f.client();
    assert.equal(await client.load(), null);
    const record = await client.save({ title: '未联网的原任务稿', summary: '正常本机编辑' });
    await client.flush(); assert.equal(record.head.revision, 1);
    assert.deepEqual(taskLocalDraftView(f.raw()), record);
    assert.ok(f.calls.every(call => call.key === (subjectId ?? 'visitor') && call.name === 'task-draft'));
    client.close();
  }
});

test('legacy migration preserves unknown fields and structured metadata by complete comparison', async () => {
  const draft = { title: '旧稿', id: 'legacy-id-is-content', revision: 'legacy-revision', head: { old: true }, version: 7,
    omitted: undefined, custom: { labels: ['原', '稿'], when: new Date(12345), flags: new Set(['x', 'y']),
      index: new Map([[{ id: 2 }, new Uint16Array([42, 255])]]) } };
  draft.custom.self = draft.custom;
  const f = fixture({ draft }), client = f.client(), view = await client.load();
  assert.equal(view.head.revision, 1); assert.deepEqual(view.value, draft);
  const saved = await client.save({ title: '只改标题' });
  assert.equal(saved.head.id, view.head.id); assert.equal(saved.head.revision, 2);
  assert.deepEqual(saved.value.custom, draft.custom); assert.equal(Object.hasOwn(saved.value, 'omitted'), true);
  assert.equal(saved.value.id, draft.id); assert.equal(saved.value.revision, draft.revision);
});

test('legacy raw changes after read, including absent versus undefined, cannot be converted over new data', async () => {
  const original = { title: '旧窗口', future: undefined }, f = fixture({ draft: original }), client = f.client();
  f.hooks.read = async () => { f.external({ title: '新窗口' }); delete f.hooks.read; };
  await rejects(client.load(), 'task_draft_conflict');
  assert.deepEqual(f.raw(), { title: '新窗口' });
  const current = await client.load(); assert.equal(current.value.title, '新窗口');
  const u = fixture({ draft: original }), reader = u.client();
  u.hooks.read = async () => { u.external({ title: '旧窗口' }); delete u.hooks.read; };
  await rejects(reader.load(), 'task_draft_conflict'); assert.deepEqual(u.raw(), { title: '旧窗口' });
});

test('rapid successive inputs serialize without stale internal Head conflicts', async () => {
  const f = fixture(), client = f.client(); await client.load();
  const writes = Array.from({ length: 40 }, (_, index) => client.save({ title: 'x'.repeat(index + 1), unknown: { stable: true } }));
  const records = await Promise.all(writes); await client.flush();
  assert.deepEqual(records.map(record => record.head.revision), Array.from({ length: 40 }, (_, index) => index + 1));
  assert.equal(new Set(records.map(record => record.head.id)).size, 1);
  assert.equal(f.raw().value.title.length, 40);
  assert.deepEqual((await client.load()).value.unknown, { stable: true });
});

test('independent clients reject stale save and flush; explicit fresh load resumes from current Head', async () => {
  const f = fixture({ draft: stored({ title: '共同原稿' }) }), a = f.client(), b = f.client();
  await a.load(); await b.load();
  const changed = await a.save({ title: 'A已保存的新稿' });
  await rejects(b.save({ title: 'B旧窗口输入' }), 'task_draft_conflict');
  await rejects(b.flush(), 'task_draft_conflict');
  await rejects(b.save({ title: 'B不能偷偷覆盖' }), 'task_draft_reload_required');
  assert.equal(f.raw().value.title, 'A已保存的新稿');
  assert.deepEqual(await b.load(), changed); await b.flush();
  const deliberate = await b.save({ title: '明确读后B再编辑' });
  assert.equal(deliberate.head.revision, changed.head.revision + 1);
});

test('another client clearing the current draft prevents stale resurrection', async () => {
  const f = fixture({ draft: stored({ title: '应被清理的原稿' }) }), a = f.client(), b = f.client();
  const original = await a.load(); await b.load();
  assert.equal(await b.clear(original.head), true);
  await rejects(a.save({ title: '不能复活旧稿' }), 'task_draft_conflict');
  assert.equal(f.raw(), null); assert.equal(await a.load(), null);
  const fresh = await a.save({ title: '显式另写的新稿' }); assert.notEqual(fresh.head.id, original.head.id);
});

test('clear protects new revisions and IDs, ignores headless history, and only confirms observed absence', async () => {
  const f = fixture({ draft: stored({ title: '准备发布稿' }) }), a = f.client(), b = f.client();
  const original = await a.load(); await b.load();
  const next = await b.save({ title: '提交等待间编辑的新版' });
  assert.equal(await a.clear(original.head), false); assert.deepEqual(taskLocalDraftView(f.raw()), next);
  assert.equal(await a.clear(null), false); assert.deepEqual(taskLocalDraftView(f.raw()), next);
  await a.load(); assert.equal(await a.clear(next.head), true);
  assert.equal(await a.clear(next.head), true, 'observed exact Head may be confirmed already absent');
  const unknown = f.client(); assert.equal(await unknown.clear(next.head), false, 'unobserved Head plus absence is not proof');
  const legacy = fixture({ draft: { title: '无编号旧稿' } });
  assert.equal(await legacy.client().clear(original.head), false); assert.deepEqual(legacy.raw(), { title: '无编号旧稿' });
  const c = f.client(); await c.load(); const later = await c.save({ title: '新ID' });
  assert.notEqual(later.head.id, next.head.id); assert.equal(await b.clear(next.head), false);
  assert.equal(f.raw().value.title, '新ID');
});

test('save input and load output are isolated copies', async () => {
  const f = fixture(), client = f.client(); await client.load();
  const hold = gate(); f.hooks.beforeUpdater = async () => { hold.entered(); await hold.wait; };
  const input = { title: '调用时输入', metadata: { tag: '原值' } }, operation = client.save(input);
  await hold.hit; input.title = '后来改的另一对象'; input.metadata.tag = '后来'; hold.release();
  const result = await operation; result.value.metadata.tag = '输出也不能改存储';
  assert.deepEqual(f.raw().value, { title: '调用时输入', metadata: { tag: '原值' } });
  delete f.hooks.beforeUpdater;
});

test('lifecycle changes before a queued updater prevent any write to either scope', async () => {
  for (const patch of [{ subjectId: ownerB }, { bindingId: crypto.randomUUID(), generation: 2 },
    { deviceId: crypto.randomUUID() }, { generation: 1 }, { endpoint: 'https://other.example.test' }]) {
    const original = stored({ title: 'A准确原稿' }), f = fixture({ subjectId: ownerA, draft: original }), client = f.client();
    await client.load(); const hold = gate();
    f.hooks.beforeUpdater = async () => { hold.entered(); await hold.wait; };
    const operation = client.save({ title: '旧租约晚写' }); await hold.hit; f.change(patch); hold.release();
    await rejects(operation, 'task_draft_test_scope_changed');
    assert.deepEqual(f.raw(ownerA), original); assert.equal(f.raw(ownerB), undefined);
  }
});

test('visitor ABA and a lifecycle change after read do not reveal or migrate an old draft', async () => {
  const original = { title: '访客原稿' }, f = fixture({ draft: original }), client = f.client(), hold = gate();
  f.hooks.read = async () => { hold.entered(); await hold.wait; };
  const operation = client.load(); await hold.hit;
  f.change({ subjectId: ownerA, deviceId: crypto.randomUUID() }); f.change({ subjectId: null, deviceId: null }); hold.release();
  await rejects(operation, 'task_draft_test_scope_changed'); assert.deepEqual(f.raw(), original);
  assert.equal(f.calls.filter(call => call.method === 'update').length, 0);
});

test('closing a client fences queued input while retaining storage owned by the original scope', async () => {
  const original = stored({ title: '当前稿' }), f = fixture({ draft: original }), client = f.client(); await client.load();
  const hold = gate(); f.hooks.beforeUpdater = async () => { hold.entered(); await hold.wait; };
  const first = client.save({ title: '排队1' }), second = client.save({ title: '排队2' });
  await hold.hit; client.close(); hold.release();
  await rejects(first, 'task_draft_scope_changed'); await rejects(second, 'task_draft_scope_changed');
  assert.deepEqual(f.raw(), original); assert.equal(f.calls.filter(call => call.method === 'update').length, 1);
});

test('a lifecycle change after commit rejects the late result but never redirects the original write', async () => {
  const f = fixture({ subjectId: ownerA }), client = f.client(); await client.load();
  const hold = gate(); f.hooks.afterUpdater = async () => { hold.entered(); await hold.wait; };
  const operation = client.save({ title: '原租约提交的本机稿' }); await hold.hit; f.change({ subjectId: ownerB }); hold.release();
  await rejects(operation, 'task_draft_test_scope_changed');
  assert.equal(f.raw(ownerA).value.title, '原租约提交的本机稿'); assert.equal(f.raw(ownerB), undefined);
});

test('fresh load clears only its earlier settled save error, preserving a later save failure', async () => {
  const f = fixture({ draft: stored({ title: '原稿' }) }), client = f.client(); await client.load();
  f.hooks.beforeUpdater = async () => { throw fail('test_store_failure'); };
  await rejects(client.save({ title: '失败输入' }), 'test_store_failure'); await rejects(client.flush(), 'test_store_failure');
  delete f.hooks.beforeUpdater;
  const hold = gate(); f.hooks.read = async () => { hold.entered(); await hold.wait; };
  const reloaded = client.load(); await hold.hit;
  f.hooks.beforeUpdater = async () => { throw fail('test_later_store_failure'); };
  const later = client.save({ title: '较晚失败输入' }); hold.release(); await reloaded;
  await rejects(later, 'test_later_store_failure'); await rejects(client.flush(), 'test_later_store_failure');
  delete f.hooks.read; delete f.hooks.beforeUpdater;
  await client.load(); await client.flush(); assert.equal(f.raw().value.title, '原稿');
});

test('future or malformed records, unsupported legacy comparison and revision overflow preserve raw storage', async () => {
  const values = [ { ...stored({ title: '未来稿' }), version: 2 },
    { ...stored({ title: '缺Head' }), head: null }, { title: '带二进制附件的旧稿', attachment: new Blob(['private']) } ];
  for (const draft of values) {
    const f = fixture({ draft }), client = f.client();
    await rejects(client.load(), draft.attachment ? 'task_draft_legacy_comparison_unavailable' : 'task_draft_record_invalid');
    assert.deepEqual(f.raw(), draft);
  }
  const draft = stored({ title: '编号上限原稿' }, { id: crypto.randomUUID(), revision: Number.MAX_SAFE_INTEGER }), f = fixture({ draft }), client = f.client();
  await client.load(); await rejects(client.save({ title: '不能溢出编号' }), 'task_draft_revision_limit'); assert.deepEqual(f.raw(), draft);
});

test('visitor adoption can atomically copy the complete wrapper without pinning it to the former owner', async () => {
  const f = fixture(), visitor = f.client(); await visitor.load(); const input = await visitor.save({ title: '明确接纳访客稿', custom: { keep: true } });
  const original = f.raw('visitor');
  // This models the already-existing Core copy contract; its actual IDB/UI
  // confirmation path is deliberately left to the production browser checks.
  f.external(original, ownerA); f.change({ subjectId: ownerA, deviceId: crypto.randomUUID() });
  const identity = f.client(); assert.deepEqual(await identity.load(), input);
  await identity.save({ title: '本人继续编辑' }); assert.deepEqual(f.raw('visitor'), original);
  assert.equal(f.raw(ownerA).head.id, original.head.id); assert.equal(f.raw(ownerA).head.revision, original.head.revision + 1);
  await rejects(visitor.save({ title: '旧访客不能跟入身份' }), 'task_draft_test_scope_changed');
});

test('save requires an observed draft and invalid heads never erase a current record', async () => {
  const original = stored({ title: '未读取稿' }), f = fixture({ draft: original }), client = f.client();
  await rejects(client.save({ title: '盲写' }), 'task_draft_reload_required');
  await rejects(client.clear({ id: 'wrong', revision: 1 }), 'task_draft_head_invalid');
  assert.deepEqual(f.raw(), original); await client.load(); await client.flush();
  const saved = await client.save({ title: '已读后写' }); assert.equal(saved.value.title, '已读后写');
});

test('late cleanup of an older known revision does not block continued own typing', async () => {
  const f = fixture(), client = f.client(); await client.load();
  const submitted = await client.save({ title: '明确发布时的稿' });
  const newer = await client.save({ title: '等待回执期间我继续编辑' });
  assert.equal(await client.clear(submitted.head), false);
  assert.deepEqual(taskLocalDraftView(f.raw()), newer);
  const continued = await client.save({ title: '回执迟到后仍能正常编辑' });
  assert.equal(continued.head.id, newer.head.id); assert.equal(continued.head.revision, newer.head.revision + 1);
});

test('invalid input save remains a flush error until explicit load or a corrected save succeeds', async () => {
  const f = fixture(), client = f.client(); await client.load(); await client.save({ title: '此前成功稿' });
  await rejects(client.save(null), 'task_draft_value_invalid');
  await rejects(client.flush(), 'task_draft_value_invalid');
  await client.save({ title: '修正后的真实输入' }); await client.flush();
  assert.equal(f.raw().value.title, '修正后的真实输入');
});

test('selection inspect is read-only for legacy drafts and first accepted edit preserves opaque fields', async () => {
  const original = { title: '已有独立标题', summary: '独立说明', future: { data: new Map([['k', 1]]) }, id: 'legacy-content-id' };
  const f = fixture({ draft: original }), client = f.client();
  const preview = await client.inspect();
  assert.equal(preview.head, null); assert.deepEqual(preview.value, original);
  assert.equal(f.calls.filter(call => call.method === 'update').length, 0);
  assert.deepEqual(f.raw(), original, 'opening and cancelling selection cannot migrate the original');
  const adopted = await client.compareAndSave({ summary: '明确采用后的说明' }, { expected: preview, assertCurrent() {} });
  assert.equal(adopted.head.revision, 1); assert.equal(adopted.value.title, original.title);
  assert.deepEqual(adopted.value.future, original.future); assert.equal(adopted.value.id, original.id);
  const later = await client.save({ title: '采用后继续编辑' });
  assert.equal(later.head.revision, 2, 'the same client follows its own accepted Head');
});

test('preview cannot follow a newer internal Head or resurrect a draft cleared after preview', async () => {
  const f = fixture({ draft: stored({ title: '预览时原稿', opaque: 42 }) }), client = f.client();
  const preview = await client.inspect();
  const newer = await client.save({ title: '预览后本人继续输入' });
  await rejects(client.compareAndSave({ title: '过期预览' }, { expected: preview, assertCurrent() {} }), 'task_draft_conflict');
  assert.deepEqual(taskLocalDraftView(f.raw()), newer);
  const current = await client.inspect(), other = f.client(); await other.inspect(); await other.clear(current.head);
  await rejects(client.compareAndSave({ title: '不准复活' }, { expected: current, assertCurrent() {} }), 'task_draft_conflict');
  assert.equal(f.raw(), null);
});

test('selection apply compares the complete original legacy snapshot even if an intervening inspect observes another headless draft', async () => {
  const f = fixture({ draft: { title: '旧稿', keep: undefined } }), client = f.client(), preview = await client.inspect();
  f.external({ title: '另一个窗口的新稿', keep: undefined }); await client.inspect();
  await rejects(client.compareAndSave({ title: '旧选材预览' }, { expected: preview, assertCurrent() {} }), 'task_draft_conflict');
  assert.deepEqual(f.raw(), { title: '另一个窗口的新稿', keep: undefined });
});

test('same-page revision and source-expiry guards run inside the mutation, after queued waits', async () => {
  for (const code of ['task_draft_input_changed', 'task_material_expired']) {
    const original = stored({ title: '原稿不可被晚到预览替换' }), f = fixture({ draft: original }), client = f.client(), preview = await client.inspect();
    const hold = gate(); let valid = true, checks = 0;
    f.hooks.beforeUpdater = async () => { hold.entered(); await hold.wait; };
    const operation = client.compareAndSave({ title: '应拒绝的材料' }, { expected: preview, assertCurrent() { checks++; if (!valid) throw fail(code); } });
    await hold.hit; valid = false; hold.release();
    await rejects(operation, code); assert.ok(checks >= 2);
    assert.deepEqual(f.raw(), original);
  }
});

test('selection apply rejects asynchronous or missing guards without mutating storage', async () => {
  const f = fixture(), client = f.client(); await client.inspect();
  await rejects(client.compareAndSave({ title: '缺少guard' }, { expected: null }), 'task_draft_preview_guard_invalid');
  await client.inspect();
  await rejects(client.compareAndSave({ title: '异步guard' }, { expected: null, assertCurrent: async () => {} }), 'task_draft_preview_guard_invalid');
  assert.equal(f.raw(), undefined);
});

test('first write after read-only legacy inspect still detects every concurrent opaque change', async () => {
  const original = { title: '旧稿', future: undefined }, f = fixture({ draft: original }), client = f.client(); await client.inspect();
  f.external({ title: '旧稿' });
  await rejects(client.save({ summary: '普通编辑也不能覆盖' }), 'task_draft_conflict');
  assert.deepEqual(f.raw(), { title: '旧稿' });
});
