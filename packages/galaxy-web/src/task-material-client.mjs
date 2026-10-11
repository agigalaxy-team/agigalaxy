import { sha256Hex } from '../../galaxy-official/src/shared/web-primitives.mjs';
import { taskMaterialDescriptorSchema, taskMaterialPrepareSchema, taskMaterialPrepareResultSchema,
  taskTextMaterialIds, taskMaterialBodyIssue } from '../../galaxy-official/src/shared/task-material-v1-schema.mjs';

const clone = value => structuredClone(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const seconds = () => Math.floor(Date.now() / 1000);
const permanentReasons = new Set(['content-erased', 'content-expired', 'permission-revoked', 'consent-revoked',
  'permission-evidence-mismatch', 'audience-mismatch', 'binding-explicitly-revoked', 'source-device-revoked', 'deletion-approved', 'approved-deletion']);
export const isTaskText = value => value?.format === 'task-text-v1' && Array.isArray(value.segments);
export const hasMaterialText = value => taskTextMaterialIds(value).length > 0;
export const literalTaskText = value => typeof value === 'string' ? value : isTaskText(value)
  ? value.segments.filter(segment => segment.kind === 'literal').map(segment => segment.text).join('') : '';
export const materialTaskText = materialId => ({ format: 'task-text-v1', segments: [{ kind: 'material', materialId }] });
export function replaceLiteralTaskText(value, text) {
  if (!isTaskText(value)) return text;
  const material = value.segments.filter(segment => segment.kind === 'material');
  if (!material.length) return text;
  return { format: 'task-text-v1', segments: [...(text ? [{ kind: 'literal', text }] : []), ...material] };
}
export function appendMaterialTaskText(value, materialId) {
  const segments = isTaskText(value) ? clone(value.segments) : value ? [{ kind: 'literal', text: value + '\n\n' }] : [];
  if (segments.length >= 8) fail('task_material_segment_limit', '这段说明已经包含八个部分，请先移除不需要的材料。');
  return { format: 'task-text-v1', segments: [...segments, { kind: 'material', materialId }] };
}
export function removeMaterialTaskText(value, materialId) {
  if (!isTaskText(value)) return value;
  const segments = value.segments.filter(segment => segment.kind !== 'material' || segment.materialId !== materialId);
  return segments.some(segment => segment.kind === 'material')
    ? { format: 'task-text-v1', segments } : segments.map(segment => segment.text ?? '').join('');
}
export function draftMaterialIds(draft) {
  return [...new Set(['title', 'summary', 'goal', 'situation', 'expectedOutcome'].flatMap(field => taskTextMaterialIds(draft?.[field])))];
}
export function activeDraftMaterials(draft) {
  const ids = new Set(draftMaterialIds(draft));
  return { materials: (draft.materials ?? []).filter(material => ids.has(material.materialId)),
    materialBodies: (draft.materialBodies ?? []).filter(body => ids.has(body.materialId)) };
}
export function adoptPreparedTaskMaterials(draft, prepared, options) {
  const next = clone(draft), restore = { ...next.materialRestore };
  if (options.useTitle) {
    restore.title = clone(next.title); next.title = materialTaskText(options.titleId);
  }
  if (options.useBody) {
    if (options.summaryMode === 'replace') { restore.summary = clone(next.summary); next.summary = materialTaskText(options.bodyId); }
    else next.summary = appendMaterialTaskText(next.summary, options.bodyId);
  }
  next.visibility = options.visibility; next.materialRestore = restore;
  next.materials = [...(next.materials ?? []).filter(item => !prepared.descriptors.some(value => value.materialId === item.materialId)), ...clone(prepared.descriptors)];
  next.materialBodies = [...(next.materialBodies ?? []).filter(item => !prepared.materialBodies.some(value => value.materialId === item.materialId)), ...clone(prepared.materialBodies)];
  return next;
}
/** @param {unknown} value
 * @param {import('./task-material-types').TaskMaterialBody[]} [bodies]
 * @param {import('./task-material-types').TaskMaterialStates|null} [states]
 * @param {number} [now] */
export function localTaskTextView(value, bodies = [], states = null, now = seconds()) {
  if (typeof value === 'string') return { text: value, state: 'available', segments: value ? [{ kind: 'literal', text: value }] : [] };
  const indexed = new Map(bodies.map(body => [body.materialId, body.text]));
  let unavailable = 0, available = 0;
  const segments = (isTaskText(value) ? value.segments : []).map(segment => {
    if (segment.kind === 'literal') { available++; return clone(segment); }
    const state = states?.[segment.materialId], body = indexed.get(segment.materialId);
    const allowed = typeof body === 'string' && (!states || state?.status === 'available' && state.availableUntil > now);
    if (allowed) { available++; return { ...segment, status: 'available', text: body }; }
    unavailable++; return { ...segment, status: 'unavailable' };
  });
  return { text: segments.map(segment => segment.text ?? '').join(''),
    state: unavailable ? available ? 'partial' : 'unavailable' : 'available', segments };
}
export function controlledTaskTitle(task) {
  return !!(task?.textView?.fields?.title??task?.textView?.title)?.segments?.some(segment => segment.kind === 'material')
    || hasMaterialText(task?.rootRequest?.title) || hasMaterialText(task?.request?.title);
}
export function independentTaskLabel(task, label = '关联任务') {
  return controlledTaskTitle(task) ? label + ' ' + task.taskId : typeof task?.request?.title === 'string'
    ? task.request.title : label + ' ' + (task?.taskId ?? '');
}
export function independentMaterialLabel(value, fallback = '关联工作资料') {
  if(taskMaterialProjectionNodes(value).some(controlledTaskTitle))return fallback;
  return typeof value?.title==='string'?value.title:typeof value?.request?.title==='string'?value.request.title:fallback;
}
export function withholdTaskMaterialProjection(task, now = seconds(), { all = false } = {}) {
  if (!task?.textView?.fields) return task;
  const result = clone(task), view = result.textView;
  if(task._webTaskScope)Object.defineProperty(result,'_webTaskScope',{value:task._webTaskScope});
  if(task._webTaskId)Object.defineProperty(result,'_webTaskId',{value:task._webTaskId});
  if(task._webTaskRead)Object.defineProperty(result,'_webTaskRead',{value:task._webTaskRead});
  const statuses = new Map((view.materials ?? []).map(item => [item.locator?.materialId ?? item.materialId, item]));
  for (const [field, value] of Object.entries(view.fields)) {
    let lost = 0, kept = 0;
    const segments = (value.segments ?? []).map(segment => {
      if (segment.kind !== 'material') { if (segment.text) kept++; return segment; }
      const material = statuses.get(segment.materialId), until = material?.availableUntil ?? value.availableUntil;
      if (all || segment.status !== 'available' || !Number.isSafeInteger(until) || until <= now) {
        lost++; return { kind: 'material', materialId: segment.materialId, status: 'unavailable' };
      }
      kept++; return segment;
    });
    const text = segments.map(segment => segment.text ?? '').join('');
    view.fields[field] = { ...value, text, segments, state: lost ? kept ? 'partial' : 'unavailable' : value.state };
    if (field === 'goal' || field === 'currentSituation') result.request.workContext[field] = text;
    else result.request[field] = text;
  }
  view.materials = (view.materials ?? []).map(item => all || item.status !== 'available' || !Number.isSafeInteger(item.availableUntil) || item.availableUntil <= now
    ? { locator: item.locator, status: 'unavailable', checkedAt: item.checkedAt } : item);
  return result;
}
export function taskMaterialProjectionId(value) {
  return value?.taskId ?? value?._webTaskId ?? value?.record?.taskId ?? (value?.object?.type === 'task' ? value.object.id : value?.type === 'task' || value?.recordKind === 'task' ? value.ref?.id ?? value.id : null);
}
export function taskMaterialProjectionKey(value) {
  return value?._webTaskRead ? JSON.stringify(value._webTaskRead) : taskMaterialProjectionId(value);
}
/** Keep permission-aware text on a smaller in-memory reading view, without
 * copying the signed request or fields the destination did not select.
 * @template T @param {unknown} source @param {T} values @returns {T} */
export function taskMaterialDerivedView(source, values) {
  if(!source?.textView)return values;
  const fields=source.textView.fields??source.textView;
  const result={...values,textView:{format:source.textView.format,checkedAt:source.textView.checkedAt,
    fields:Object.fromEntries(Object.entries(fields).filter(([name])=>Object.hasOwn(values,name)))}};
  for(const name of ['_webTaskScope','_webTaskRead'])if(source[name])Object.defineProperty(result,name,{value:source[name]});
  const taskId=taskMaterialProjectionId(source);if(taskId)Object.defineProperty(result,'_webTaskId',{value:taskId});
  return result;
}
export function taskMaterialProjectionNodes(value, nodes = []) {
  if (!value || typeof value !== 'object') return nodes;
  if (value.textView?.fields || value.textView?.title) nodes.push(value);
  for (const [key, child] of Object.entries(value)) if (key !== 'textView') taskMaterialProjectionNodes(child, nodes);
  return nodes;
}
/** Current limited projections can be nested in History, search or notices.
 * @template T
 * @param {T} value @param {number} [now]
 * @param {{all?:boolean,current?:Map<string,unknown>|null}} [options]
 * @returns {T} */
export function withholdTaskMaterialTree(value, now = seconds(), { all = false, current = null } = {}) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => withholdTaskMaterialTree(item, now, { all, current }));
  const result = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'textView')
    .map(([key, child]) => [key, withholdTaskMaterialTree(child, now, { all, current })]));
  if(value._webTaskScope)Object.defineProperty(result,'_webTaskScope',{value:value._webTaskScope});
  if(value._webTaskId)Object.defineProperty(result,'_webTaskId',{value:value._webTaskId});
  if(value._webTaskRead)Object.defineProperty(result,'_webTaskRead',{value:value._webTaskRead});
  if (!value.textView) return result;
  const names = Object.keys(value.textView.fields ?? { title: value.textView.title }).filter(name => (value.textView.fields ?? value.textView)[name]);
  if (!names.length) { result.textView = clone(value.textView); return result; }
  const id = taskMaterialProjectionId(value), key = taskMaterialProjectionKey(value), refreshed = current?.get(key), unavailable = all || current && !refreshed;
  const fields = Object.fromEntries(names.map(name => {
    const original=(value.textView.fields??value.textView)[name],latest=refreshed?.textView?.fields?.[name];
    return [name,latest??(refreshed?{...original,segments:original.segments.map(segment=>segment.kind==='material'?{kind:'material',materialId:segment.materialId,status:'unavailable'}:segment)}:original)];
  }));
  const task = { taskId: id, request: { ...value.request, workContext: { ...value.request?.workContext } },
    textView: { fields, materials: refreshed?.textView?.materials ?? value.textView.materials ?? [] } };
  const safe = withholdTaskMaterialProjection(task, now, { all: !!unavailable });
  result.textView = value.textView.fields ? { ...value.textView, fields: safe.textView.fields,
    ...(value.textView.materials ? { materials: safe.textView.materials } : {}) } : { title: safe.textView.fields.title };
  if (value.request) result.request = safe.request;
  for (const name of names) if (Object.hasOwn(value, name)) result[name] = safe.textView.fields[name].text;
  if (!value.request && names.includes('title') && safe.textView.fields.title.state === 'unavailable') result.title = '来源标题当前不可用';
  return result;
}

/** Own draft/pending material reader. All awaits retain the browser identity lifecycle. */
export function createTaskMaterialClient(runtime, { subjectId = runtime.taskDraftScope?.().subjectId ?? null,
  now = seconds } = {}) {
  const api = runtime.api, endpoint = api.endpoint, scope = runtime.taskDraftScope?.().key;
  const lease = subjectId ? runtime.receiptStatus?.captureLease?.() : null;
  let closed = false;
  const check = () => {
    if (closed || endpoint !== api.endpoint || scope !== runtime.taskDraftScope?.().key)
      fail('task_material_scope_changed', '身份、服务或页面已改变，请重新核对原稿和来源。');
    lease?.assertCurrent();
    if (subjectId !== (runtime.taskDraftScope?.().subjectId ?? null))
      fail('task_material_scope_changed', '当前材料不属于这个身份，请重新核对。');
  };
  const wait = async action => { check(); try { const result = await action(); check(); return result; } catch (error) { check(); throw error; } };
  const call = (path, input = null, authenticated = false, method = 'GET') => wait(() => api.call(path, input, { authenticated, method }));
  const hash = text => wait(() => sha256Hex(text));
  const ownConnection = () => {
    check();
    if (!subjectId || api.snapshot()?.subjectId !== subjectId) fail('connection_required', '请连接原身份，再核对选定材料。原稿仍保留。');
  };
  async function prepare(input) {
    ownConnection();
    const selected = taskMaterialPrepareSchema.parse(input);
    const result = taskMaterialPrepareResultSchema.parse(await call('/v2/task-materials/prepare', selected, true, 'POST'));
    if (result.source.endpoint !== endpoint || result.source.postId !== selected.source.postId || result.source.versionId !== selected.source.versionId
      || result.descriptors.length !== selected.selections.length || result.materialBodies.length !== selected.selections.length)
      fail('task_material_prepare_mismatch', '材料预览与所选准确版本不一致，原稿仍保留。');
    for (const selection of selected.selections) {
      const descriptor = result.descriptors.find(item => item.materialId === selection.materialId);
      const body = result.materialBodies.find(item => item.materialId === selection.materialId);
      if (!descriptor || !body || descriptor.source.endpoint !== endpoint || descriptor.source.postId !== selected.source.postId
        || descriptor.source.versionId !== selected.source.versionId || descriptor.source.field !== selection.field
        || descriptor.source.start !== selection.start || descriptor.source.end !== selection.end || descriptor.expiresAt !== selected.expiresAt
        || descriptor.source.payloadHash !== result.source.payloadHash || descriptor.source.permissionId !== result.source.permissionId
        || selection.text !== undefined && body.text !== selection.text || await hash(body.text) !== descriptor.textHash)
        fail('task_material_prepare_mismatch', '材料范围、编辑文字或期限与本次预览不一致，原稿仍保留。');
    }
    return result;
  }
  async function inspect(descriptors = []) {
    check();
    const parsed = descriptors.map(value => taskMaterialDescriptorSchema.parse(value)), selectedTexts = new Map(), versions = new Map();
    /** @type {import('./task-material-types').TaskMaterialStates} */
    const states = {};
    for (const descriptor of parsed) {
      const id = descriptor.materialId, source = descriptor.source;
      let state = { materialId: id, status: 'unavailable', permanent: false, checkedAt: now(), availableUntil: descriptor.expiresAt, reason: 'source-unverified' };
      if (descriptor.expiresAt <= now()) { states[id] = { ...state, permanent: true, reason: 'expired' }; continue; }
      if (source.endpoint !== endpoint || !subjectId) { states[id] = state; continue; }
      const key = source.postId + ':' + source.versionId;
      try {
        if (!versions.has(key)) versions.set(key, call('/v2/community/posts/' + source.postId + '/versions/' + source.versionId));
        const version = await versions.get(key); check();
        if (version.availability === 'withdrawn' || version.availability === 'expired') {
          states[id] = { ...state, permanent: true, reason: version.availability }; continue;
        }
        if (version.availability !== 'available' || !version.payload) {
          if (api.snapshot()?.subjectId === subjectId) {
            try {
              const permission = await call('/v2/community/permissions/' + source.permissionId, null, true);
              const reasons = permission.stoppedReasons ?? [];
              state = { ...state, permanent: reasons.some(reason => permanentReasons.has(reason)), reason: reasons[0] ?? 'temporarily-unavailable' };
            } catch { check(); }
          }
          states[id] = state; continue;
        }
        const payloadHash = version.authorizationEvidence?.intent?.payloadHash;
        const raw = version.payload[source.field];
        if (version.authorId !== subjectId || version.permissionId !== source.permissionId || payloadHash !== source.payloadHash
          || typeof raw !== 'string' || source.end > Array.from(raw).length) { states[id] = { ...state, reason: 'source-mismatch' }; continue; }
        const selectedText = Array.from(raw).slice(source.start, source.end).join('');
        if (await hash(selectedText) !== source.selectionHash) { states[id] = { ...state, reason: 'selection-mismatch' }; continue; }
        const availableUntil = Math.min(descriptor.expiresAt, version.publishedUntil);
        if (!Number.isSafeInteger(availableUntil) || availableUntil <= now()) {
          states[id] = { ...state, permanent: true, reason: 'expired' }; continue;
        }
        states[id] = { ...state, status: 'available', availableUntil, checkedAt: now(), reason: 'current-source' };
        selectedTexts.set(id, selectedText);
      } catch { check(); states[id] = { ...state, reason: 'temporarily-unavailable' }; }
    }
    return { states, selectedTexts, checkedAt: now() };
  }
  async function sanitize(value, { validateBodyHash = false, rebuild = false } = {}) {
    const original = clone(value), descriptors = original.materials ?? [], bodies = original.materialBodies ?? [];
    /** @type {import('./task-material-types').TaskMaterialStates} */
    const emptyStates = {};
    /** @type {string[]} */
    const emptyErased = [];
    if (!descriptors.length) return { value: original, view: original, states: emptyStates, erased: emptyErased, changed: false };
    const { states, selectedTexts, checkedAt } = await inspect(descriptors);
    const erased = Object.entries(states).filter(([,state]) => state.permanent).map(([id]) => id);
    const kept = bodies.filter(body => !erased.includes(body.materialId)), visible = [];
    for (const descriptor of descriptors) {
      const id = descriptor.materialId, state = states[id];
      if (state?.status !== 'available') continue;
      let body = kept.find(item => item.materialId === id);
      if (!body && rebuild && selectedTexts.has(id) && await hash(selectedTexts.get(id)) === descriptor.textHash) {
        body = { materialId: id, text: selectedTexts.get(id) }; kept.push(body);
      }
      if (body && (!validateBodyHash || await hash(body.text) === descriptor.textHash)) visible.push(clone(body));
      else states[id] = { ...state, status: 'unavailable', reason: 'edited-body-unavailable' };
    }
    const next = { ...original, materialBodies: kept };
    return { value: next, view: { ...next, materialBodies: visible }, states, erased, checkedAt,
      changed: kept.length !== bodies.length || erased.some(id => bodies.some(body => body.materialId === id)) };
  }
  async function prepareDraft(draft) {
    check();
    const active = activeDraftMaterials(draft);
    if (!active.materials.length) return { draft: clone(draft), ...active };
    ownConnection();
    const sanitized = await sanitize({ ...active }, { validateBodyHash: false });
    if (Object.values(sanitized.states).some(state => state.status !== 'available'))
      fail('task_material_unavailable', '部分材料当前不可用。独立说明仍保留，请先核对或移除对应材料。');
    const groups = new Map(), prepared = [], materialBodies = [];
    for (const descriptor of active.materials) {
      const body = sanitized.view.materialBodies.find(item => item.materialId === descriptor.materialId);
      if (!body) fail('task_material_body_unavailable', '原编辑材料已不再保留，请核对原稿；不会用原文替换它。');
      const key = descriptor.source.postId + ':' + descriptor.source.versionId + ':' + descriptor.expiresAt;
      if (!groups.has(key)) groups.set(key, { source: { postId: descriptor.source.postId, versionId: descriptor.source.versionId },
        expiresAt: descriptor.expiresAt, selections: [] });
      groups.get(key).selections.push({ materialId: descriptor.materialId, field: descriptor.source.field,
        start: descriptor.source.start, end: descriptor.source.end, text: body.text });
    }
    for (const input of groups.values()) {
      const result = await prepare(input);
      for (const descriptor of result.descriptors) {
        const original = active.materials.find(item => item.materialId === descriptor.materialId);
        if (Object.keys(original.source).some(key => original.source[key] !== descriptor.source[key]))
          fail('task_material_source_changed', '原材料选择已变化，请重新核对；没有替换为帖子的新版本。');
      }
      prepared.push(...result.descriptors); materialBodies.push(...result.materialBodies);
    }
    const updated = clone(draft);
    updated.materials = (updated.materials ?? []).map(item => prepared.find(value => value.materialId === item.materialId) ?? item);
    updated.materialBodies = (updated.materialBodies ?? []).map(item => materialBodies.find(value => value.materialId === item.materialId) ?? item);
    return { draft: updated, materials: prepared, materialBodies };
  }
  async function verifySubmission(payload, bodies, { rebuild = false } = {}) {
    const sanitized = await sanitize({ materials: payload.materials ?? [], materialBodies: bodies ?? [] }, { validateBodyHash: true, rebuild });
    if (Object.values(sanitized.states).some(state => state.status !== 'available'))
      return { ...sanitized, allowed: false };
    const issue = taskMaterialBodyIssue(payload, sanitized.view.materialBodies);
    return { ...sanitized, allowed: !issue, issue };
  }
  return Object.freeze({ check, prepare, inspect, sanitize, prepareDraft, verifySubmission, close() { closed = true; } });
}
