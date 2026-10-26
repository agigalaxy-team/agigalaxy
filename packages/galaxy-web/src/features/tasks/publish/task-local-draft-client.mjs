const format = 'galaxy-task-local-draft';
const name = 'task-draft';
const recoveryName = 'task-draft-recovery-copies';
const recoveryFormat = 'galaxy-task-draft-recovery-copies';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @typedef {{id:string,revision:number}} DraftHead */
/** @typedef {Record<string,unknown>} DraftValue */
/** @typedef {{head:DraftHead,value:DraftValue}} DraftRecord */
/** @typedef {{head:DraftHead|null,value:DraftValue}} DraftSnapshot */
/** @typedef {{id:string,kind:'replaced'|'input',createdAt:number,snapshot:DraftSnapshot,raw?:DraftValue}} RecoveryCopy */
/** @typedef {{endpoint:string,subjectId:string|null,deviceId:string|null,bindingId:string|null,generation:number|null,assertCurrent:()=>void}} LocalDraftLease */

const error = (code, message) => Object.assign(new Error(message), { code });
/** @template T @param {T} value @returns {T} */
const clone = value => structuredClone(value);
/** @param {unknown} value @returns {value is DraftValue} */
function object(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
/** @param {unknown} value @returns {value is DraftHead} */
function validHead(value) {
  return object(value) && typeof value.id === 'string' && uuid.test(value.id)
    && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision > 0;
}
/** @param {DraftHead|null} left @param {DraftHead|null} right */
const sameHead = (left, right) => left === null && right === null
  || !!left && !!right && left.id === right.id && left.revision === right.revision;
/** @param {DraftHead} head */
const token = head => `${head.id}:${head.revision}`;

/**
 * Unwraps only the versioned local record. A legacy draft remains complete,
 * including unknown fields with names such as id, revision, head or version.
 * This helper never migrates, signs, writes or assigns a legacy draft a Head.
 * @param {unknown} raw
 * @returns {{head:DraftHead|null,value:DraftValue}|null}
 */
export function taskLocalDraftView(raw) {
  if (raw == null) return null;
  if (!object(raw)) throw error('task_draft_record_invalid', '本机任务稿格式无法核对；原记录仍保留。');
  if (raw.format !== format) return { head: null, value: clone(raw) };
  if (raw.version !== 1 || !validHead(raw.head) || !object(raw.value))
    throw error('task_draft_record_invalid', '本机任务稿版本或编号无法核对；原记录仍保留。');
  return { head: clone(raw.head), value: clone(raw.value) };
}

/**
 * Full legacy-value comparison inside the synchronous IDB updater. JSON alone
 * would miss undefined keys and changes in Maps or binary metadata. Unsupported
 * values fail closed, leaving the old draft intact rather than guessing equality.
 * @param {unknown} left @param {unknown} right
 * @param {Map<object,object>} [pairs] @param {Map<object,object>} [reverse]
 * @returns {boolean}
 */
function sameLegacy(left, right, pairs = new Map(), reverse = new Map()) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (pairs.has(left) || reverse.has(right)) return pairs.get(left) === right && reverse.get(right) === left;
  pairs.set(left, right); reverse.set(right, left);
  if (left instanceof Date || right instanceof Date)
    return left instanceof Date && right instanceof Date && Object.is(left.getTime(), right.getTime());
  if (left instanceof RegExp || right instanceof RegExp)
    return left instanceof RegExp && right instanceof RegExp && left.source === right.source && left.flags === right.flags && left.lastIndex === right.lastIndex;
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
    const values = [...right];
    return [...left].every(([key, value], index) => sameLegacy(key, values[index][0], pairs, reverse) && sameLegacy(value, values[index][1], pairs, reverse));
  }
  if (left instanceof Set || right instanceof Set) {
    if (!(left instanceof Set) || !(right instanceof Set) || left.size !== right.size) return false;
    const values = [...right];
    return [...left].every((value, index) => sameLegacy(value, values[index], pairs, reverse));
  }
  if (left instanceof ArrayBuffer || right instanceof ArrayBuffer) {
    if (!(left instanceof ArrayBuffer) || !(right instanceof ArrayBuffer) || left.byteLength !== right.byteLength) return false;
    const bytes = new Uint8Array(right);
    return new Uint8Array(left).every((value, index) => value === bytes[index]);
  }
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right))
    return ArrayBuffer.isView(left) && ArrayBuffer.isView(right)
      && Object.getPrototypeOf(left) === Object.getPrototypeOf(right) && left.byteOffset === right.byteOffset && left.byteLength === right.byteLength
      && sameLegacy(left.buffer, right.buffer, pairs, reverse);
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if ((!Array.isArray(left) && !object(left)) || (!Array.isArray(right) && !object(right)))
    throw error('task_draft_legacy_comparison_unavailable', '旧稿含不能同步完整核对的本机数据；原稿仍保留，尚未转换。');
  if (Array.isArray(left) && Array.isArray(right) && left.length !== right.length) return false;
  const keys = Object.keys(left), rightKeys = Object.keys(right);
  if (keys.length !== rightKeys.length) return false;
  return keys.every(key => Object.hasOwn(right, key)
    && sameLegacy(Reflect.get(left, key), Reflect.get(right, key), pairs, reverse));
}

/**
 * Local-only adapter: visitor, disconnected identities and connected identities
 * use the same atomic draft protocol. The runtime owns the lifecycle lease and
 * the exact endpoint/owner storage key; no HTTP or signing occurs here.
 * @param {{captureLease:()=>LocalDraftLease,getLocal:(name:string,ownerKey:string)=>Promise<unknown>,updateLocal:(name:string,updater:(previous:unknown)=>unknown,ownerKey:string)=>Promise<unknown>,crypto?:{randomUUID:()=>string}}} adapter
 */
export function createTaskLocalDraftClient({ captureLease, getLocal, updateLocal, crypto = globalThis.crypto }) {
  if (typeof captureLease !== 'function' || typeof getLocal !== 'function' || typeof updateLocal !== 'function')
    throw error('task_draft_adapter_required', '本机任务稿需要当前生命周期和原子存储适配。');
  const lease = captureLease();
  if (!lease || typeof lease.assertCurrent !== 'function' || typeof lease.endpoint !== 'string' || !lease.endpoint
    || !(lease.subjectId === null || typeof lease.subjectId === 'string' && !!lease.subjectId))
    throw error('task_draft_lease_invalid', '当前本机稿身份租约无法核对。');
  const ownerKey = lease.subjectId ?? 'visitor';
  const observed = new Set();
  let closed = false, loaded = false, reloadRequired = false;
  /** @type {DraftHead|null} */
  let head = null;
  /** @type {DraftValue|null} */
  let legacySnapshot = null;
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  /** @type {Promise<DraftRecord>|null} */
  let lastSave = null;
  /** @type {{expected:DraftHead|null,legacy:DraftValue|null,record:DraftValue}|null} */
  let unconfirmedWrite = null;
  function check() {
    if (closed) throw error('task_draft_scope_changed', '本机任务稿页面已关闭，请重新核对原稿。');
    lease.assertCurrent();
  }
  check();
  /** @template T @param {()=>Promise<T>} action @returns {Promise<T>} */
  async function wait(action) {
    check(); let value;
    try { value = await action(); } catch (failure) { check(); throw failure; }
    check(); return value;
  }
  /** @template T @param {()=>Promise<T>} action @returns {Promise<T>} */
  function serial(action) {
    try { check(); } catch (failure) { return Promise.reject(failure); }
    const run = tail.then(() => wait(action));
    // Scheduling can continue after an error, while its original Promise and
    // flush still report the error. Only a successful explicit load resets it.
    tail = run.then(() => undefined, () => undefined);
    return run;
  }
  /** @param {DraftHead|null} current */
  function observe(current) { if (current) observed.add(token(current)); }
  /** @param {DraftValue} value @param {DraftHead} nextHead @param {unknown} [previous] */
  function wrap(value, nextHead, previous) {
    return { ...(object(previous) && previous.format === format ? previous : {}),
      format, version: 1, head: clone(nextHead), value: clone(value) };
  }
  function nextId() {
    const id = crypto?.randomUUID?.();
    if (typeof id !== 'string' || !uuid.test(id)) throw error('task_draft_id_unavailable', '无法准备本机稿件编号；原稿仍保留。');
    return id;
  }

  /** @param {unknown} current @param {DraftSnapshot|null} view @param {DraftHead|null} expected @param {DraftValue|null} legacy */
  function matches(current, view, expected, legacy) {
    if (legacy !== null) return expected === null && !!view && view.head === null && sameLegacy(current, legacy);
    return (!view || !!view.head) && sameHead(view?.head ?? null, expected);
  }

  /** @param {DraftSnapshot|null} view */
  function conflict(view) {
    return Object.assign(error('task_draft_conflict', '另一页面已改变或清空本机任务稿；本页输入和已保存内容均仍保留。'),
      { current: view ? clone(view) : null });
  }
  /** @param {unknown} row @returns {row is RecoveryCopy} */
  function recoveryCopy(row) {
    return object(row) && typeof row.id === 'string' && uuid.test(row.id)
      && (row.kind === 'replaced' || row.kind === 'input') && typeof row.createdAt === 'number' && Number.isSafeInteger(row.createdAt)
      && object(row.snapshot) && (row.snapshot.head === null || validHead(row.snapshot.head)) && object(row.snapshot.value)
      && (row.raw === undefined || object(row.raw));
  }
  /** @param {unknown} raw @returns {RecoveryCopy[]} */
  function copies(raw) {
    if (raw == null) return [];
    if (!object(raw) || raw.format !== recoveryFormat || raw.version !== 1 || !Array.isArray(raw.copies)
      || !raw.copies.every(recoveryCopy))
      throw error('task_draft_recovery_copies_invalid', '保留的对照输入暂时无法核对；原稿及副本均未替换。');
    return clone(raw.copies);
  }

  /** @param {unknown} value @param {readonly string[]} erased */
  function cleanReplacedBodies(value, erased) {
    if (!erased.length) return;
    if (!object(value)) throw error('task_draft_recovery_cleanup_invalid', '原材料缓存格式无法准确核对；原稿及输入仍保留。');
    if (value.materialBodies === undefined) return;
    if (!Array.isArray(value.materialBodies)) throw error('task_draft_recovery_cleanup_invalid', '原材料缓存格式无法准确核对；原稿及输入仍保留。');
    value.materialBodies = value.materialBodies.filter(body => !object(body) || typeof body.materialId !== 'string' || !erased.includes(body.materialId));
  }

  /** @param {DraftHead|null} expected @param {DraftValue|null} legacy @param {()=>void} guarded @param {{preserveReplaced?:boolean,preserveInput?:DraftValue,eraseReplacedMaterialIds?:readonly string[]}} options */
  async function preserveCopies(expected, legacy, guarded, { preserveReplaced, preserveInput, eraseReplacedMaterialIds = [] }) {
    if (!preserveReplaced && preserveInput === undefined) return;
    guarded();
    const raw = await wait(() => getLocal(name, ownerKey));
    guarded(); const view = taskLocalDraftView(raw);
    if (!matches(raw, view, expected, legacy)) throw conflict(view);
    /** @type {RecoveryCopy[]} */
    const selected = [];
    if (preserveReplaced && view && object(raw)) {
      const snapshot = clone(view), retainedRaw = clone(raw);
      cleanReplacedBodies(snapshot.value, eraseReplacedMaterialIds);
      cleanReplacedBodies(retainedRaw.format === format ? retainedRaw.value : retainedRaw, eraseReplacedMaterialIds);
      selected.push({ id: nextId(), kind: 'replaced', createdAt: Date.now(), snapshot, raw: retainedRaw });
    }
    if (preserveInput !== undefined) selected.push({ id: nextId(), kind: 'input', createdAt: Date.now(), snapshot: { head: null, value: clone(preserveInput) } });
    if (!selected.length) return;
    await wait(() => updateLocal(recoveryName, previous => {
      guarded(); const retained = copies(previous);
      for (const item of selected) if (!retained.some(row => row.kind === item.kind && sameHead(row.snapshot.head, item.snapshot.head)
        && sameLegacy(row.snapshot.value, item.snapshot.value) && sameLegacy(row.raw, item.raw))) retained.push(item);
      return { ...(object(previous) ? previous : {}), format: recoveryFormat, version: 1, copies: retained };
    }, ownerKey));
    guarded();
  }

  /** @param {boolean} migrate @returns {Promise<DraftSnapshot|null>} */
  function read(migrate) {
    const earlierSave = lastSave;
    return serial(async () => {
      const original = await wait(() => getLocal(name, ownerKey));
      let view = taskLocalDraftView(original);
      if (migrate && view && !view.head) {
        const legacy = clone(original), legacyValue = clone(view.value), nextHead = { id: nextId(), revision: 1 };
        const migrated = await wait(() => updateLocal(name, current => {
          check();
          if (!sameLegacy(current, legacy)) throw error('task_draft_conflict', '另一页面已改变本机任务稿，请重新读取；本页输入仍保留。');
          return wrap(legacyValue, nextHead);
        }, ownerKey));
        view = taskLocalDraftView(migrated);
      }
      check();
      const currentHead = view?.head ?? null;
      if (migrate && view && !currentHead) throw error('task_draft_record_invalid', '本机稿转换结果无法核对；请重新读取原稿。');
      legacySnapshot = view && !currentHead ? clone(view.value) : null;
      head = currentHead; loaded = true; reloadRequired = false; observe(head);
      if (lastSave === earlierSave) lastSave = null;
      return view ? { head: clone(currentHead), value: clone(view.value) } : null;
    });
  }

  /** @param {DraftValue} selected @param {DraftHead|null} expected @param {DraftValue|null} legacy @param {()=>void} [guard] @param {{recovery?:boolean,preserveReplaced?:boolean,preserveInput?:DraftValue,eraseReplacedMaterialIds?:readonly string[]}} [options] @returns {Promise<DraftRecord>} */
  async function write(selected, expected, legacy, guard, options = {}) {
    if (!loaded || reloadRequired && !options.recovery) throw error('task_draft_reload_required', '请先重新读取本机任务稿；本页未保存的输入仍保留。');
    const guarded = () => {
      check();
      const result = guard?.();
      if (result && typeof result.then === 'function') throw error('task_draft_preview_guard_invalid', '预览的本机核对必须同步完成，原稿仍保留。');
    };
    const earlier = unconfirmedWrite;
    /** @type {DraftValue|null} */
    let attempted = null;
    try {
      guarded();
      if (options.preserveReplaced || options.preserveInput !== undefined) await preserveCopies(expected, legacy, guarded, options);
      const saved = await wait(() => updateLocal(name, current => {
        guarded();
        const view = taskLocalDraftView(current);
        // A failed callback may have followed an actual local commit. Only our
        // exact generated record, original base and full bytes prove that fact;
        // an unrelated newer Head can never become the replacement base.
        const ownCommit = options.recovery && earlier && sameHead(earlier.expected, expected)
          && sameLegacy(earlier.legacy, legacy) && sameLegacy(current, earlier.record);
        if (!ownCommit && !matches(current, view, expected, legacy)) throw conflict(view);
        const effectiveHead = ownCommit ? view?.head ?? null : expected;
        const priorValue = ownCommit ? clone(view?.value ?? {}) : null;
        const nextValue = view?.value ?? {};
        for (const key of Object.keys(selected)) Object.defineProperty(nextValue, key,
          { value: selected[key], enumerable: true, configurable: true, writable: true });
        if (priorValue && sameLegacy(priorValue, nextValue)) return current;
        const revision = effectiveHead ? effectiveHead.revision + 1 : 1;
        if (!Number.isSafeInteger(revision)) throw error('task_draft_revision_limit', '本机稿修订编号已达到上限，原稿仍保留。');
        attempted = wrap(nextValue, { id: effectiveHead?.id ?? nextId(), revision }, current);
        return attempted;
      }, ownerKey));
      const view = taskLocalDraftView(saved);
      if (!view?.head) throw error('task_draft_record_invalid', '本机保存结果无法核对，请重新读取。');
      head = view.head; legacySnapshot = null; reloadRequired = false; unconfirmedWrite = null; observe(head);
      return { head: clone(head), value: clone(view.value) };
    } catch (failure) {
      if (attempted) unconfirmedWrite = { expected: clone(expected), legacy: clone(legacy), record: clone(attempted) };
      reloadRequired = true; throw failure;
    }
  }

  return Object.freeze({
    /** @returns {Promise<DraftRecord|null>} */
    load() { return read(true); },
    /** Read without migrating or writing; opening/cancelling selection leaves the original byte structure intact. */
    inspect() { return read(false); },
    /** @param {DraftValue} value @returns {Promise<DraftRecord>} */
    save(value) {
      let selected;
      try {
        if (!object(value)) throw error('task_draft_value_invalid', '本机任务稿编辑字段无效，尚未保存。');
        selected = clone(value);
      } catch (failure) {
        const rejected = serial(async () => { throw failure; });
        lastSave = rejected; return rejected;
      }
      const run = serial(async () => {
        return write(selected, clone(head), clone(legacySnapshot));
      });
      lastSave = run;
      return run;
    },
    /**
     * Apply exactly the snapshot the user previewed. Unlike ordinary save, the
     * expected Head is captured at invocation and never follows our newer Head.
     * The UI revision/selection/expiry guard runs inside the same IDB updater.
     * @param {DraftValue} value
     * @param {{expected:DraftSnapshot|null,assertCurrent:()=>void}} options
     * @returns {Promise<DraftRecord>}
     */
    compareAndSave(value, { expected, assertCurrent } = {}) {
      let selected, snapshot;
      try {
        if (!object(value)) throw error('task_draft_value_invalid', '本机任务稿编辑字段无效，尚未保存。');
        if (expected !== null && (!object(expected) || !(expected.head === null || validHead(expected.head)) || !object(expected.value)))
          throw error('task_draft_head_invalid', '没有准确的预览稿件，原稿仍保留。');
        if (typeof assertCurrent !== 'function') throw error('task_draft_preview_guard_invalid', '尚未核对当前预览输入，原稿仍保留。');
        selected = clone(value); snapshot = clone(expected);
      } catch (failure) {
        const rejected = serial(async () => { throw failure; });
        lastSave = rejected; return rejected;
      }
      const run = serial(() => write(selected, snapshot?.head ?? null,
        snapshot && !snapshot.head ? snapshot.value : null, assertCurrent));
      lastSave = run; return run;
    },
    /**
     * Retry current input against its original base without loading a newer
     * draft into that base. Copies are made only for an explicit conflict choice.
     * @param {DraftValue} value
     * @param {{expected:DraftSnapshot|null,assertCurrent:()=>void,preserveReplaced?:boolean,preserveInput?:DraftValue,eraseReplacedMaterialIds?:readonly string[]}} options
     * @returns {Promise<DraftRecord>}
     */
    recover(value, { expected, assertCurrent, preserveReplaced, preserveInput, eraseReplacedMaterialIds = [] } = {}) {
      let selected, snapshot, input, erased;
      try {
        if (!object(value) || preserveInput !== undefined && !object(preserveInput) || preserveReplaced !== undefined && typeof preserveReplaced !== 'boolean')
          throw error('task_draft_value_invalid', '本机任务稿编辑字段无效，尚未保存。');
        if (expected !== null && (!object(expected) || !(expected.head === null || validHead(expected.head)) || !object(expected.value)))
          throw error('task_draft_head_invalid', '没有准确的原稿基底，原输入仍保留。');
        if (typeof assertCurrent !== 'function') throw error('task_draft_preview_guard_invalid', '尚未核对当前恢复输入，原稿仍保留。');
        if (!Array.isArray(eraseReplacedMaterialIds) || eraseReplacedMaterialIds.some(id => typeof id !== 'string' || !uuid.test(id))
          || eraseReplacedMaterialIds.length && !preserveReplaced)
          throw error('task_draft_recovery_cleanup_invalid', '尚未准确核对要清理的原材料正文；原稿及输入仍保留。');
        selected = clone(value); snapshot = clone(expected); input = preserveInput === undefined ? undefined : clone(preserveInput); erased = [...new Set(eraseReplacedMaterialIds)];
      } catch (failure) {
        const rejected = serial(async () => { throw failure; });
        lastSave = rejected; return rejected;
      }
      const run = serial(() => write(selected, snapshot?.head ?? null,
        snapshot && !snapshot.head ? snapshot.value : null, assertCurrent, { recovery: true, preserveReplaced, preserveInput: input, eraseReplacedMaterialIds: erased }));
      lastSave = run; return run;
    },
    /** @returns {Promise<RecoveryCopy[]>} */
    readRecoveryCopies() {
      return serial(async () => copies(await wait(() => getLocal(recoveryName, ownerKey))));
    },
    flush() {
      const pending = lastSave;
      return wait(async () => { if (pending) await wait(() => pending); });
    },
    /** @param {DraftHead|null} expected @returns {Promise<boolean>} */
    clear(expected) {
      if (expected === null) return wait(async () => false);
      if (!validHead(expected)) return Promise.reject(error('task_draft_head_invalid', '没有准确本机稿件修订，不能清除当前稿。'));
      const selected = clone(expected);
      return serial(async () => {
        let cleared = false, knownCurrent = false;
        await wait(() => updateLocal(name, current => {
          check(); const view = taskLocalDraftView(current);
          knownCurrent = loaded && (!view || !!view.head) && sameHead(view?.head ?? null, head);
          if (!view) { cleared = observed.has(token(selected)); return current ?? null; }
          if (!sameHead(view.head, selected)) return current;
          cleared = true; return null;
        }, ownerKey));
        if (cleared) { head = null; legacySnapshot = null; loaded = true; reloadRequired = false; }
        else if (!knownCurrent) reloadRequired = true;
        return cleared;
      });
    },
    close() { closed = true; },
  });
}
