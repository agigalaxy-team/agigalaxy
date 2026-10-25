import * as z from 'zod/v4';
import {readWithTransientRecovery} from '../../../integrations/shared/read-task.mjs';
import { sha256Hex } from '../../galaxy-official/src/shared/web-primitives.mjs';
import { forumWriteSpec } from '../../galaxy-official/src/shared/community-forum-v1-schema.mjs';
import { bindForumIds } from '../../galaxy-official/src/shared/community-forum-ids-v1.mjs';
import { forumTopicSchema,forumReadTopicSchema } from '../../galaxy-official/src/shared/community-forum-topics-v1.mjs';
import { forumAudienceSchema } from '../../galaxy-official/src/shared/community-forum-access-v2.mjs';
import {createForumAttachmentsClient,forumDraftAttachmentsSchema,forumAttachmentError} from './forum-attachment-client.mjs';

const draftSchema = z.strictObject({
  id: z.uuid(), revision: z.number().int().positive(),
  kind: z.enum(['create-post', 'publish-version', 'create-reply', 'withdraw-post', 'withdraw-version', 'withdraw-reply', 'create-report', 'supplement', 'withdraw-report', 'appeal', 'resolve', 'create-section', 'update-section']),
  title: z.string().default(''), body: z.string().default(''), linksText: z.string().default(''),
  attachments:forumDraftAttachmentsSchema.default([]),
  topic: forumReadTopicSchema.optional(),
  sectionId: z.uuid().nullable().optional(), audience: forumAudienceSchema.optional(),
  theme: z.string().default(''), description: z.string().default(''), sectionState: z.enum(['active','archived']).default('active'),
  category: z.enum(['spam', 'harassment', 'privacy', 'misleading', 'other']).default('other'),
  target: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).default({}),
  replyTo: z.strictObject({ replyId: z.uuid(), contentRevision: z.literal(1) }).nullable().default(null),
  resolution: z.enum(['dismissed', 'accepted', 'needs-review']).default('needs-review'),
  hide: z.boolean().default(false), hideHours: z.number().min(0).max(24).default(24),
  operationId: z.uuid().optional(),
});
const draftRefSchema = z.strictObject({ id: z.uuid(), revision: z.number().int().positive() });
const queues = new WeakMap();
const clone = value => structuredClone(value);
const token = value => value ? { id: value.id, revision: value.revision } : null;
const same = (a, b) => a === null && b === null || !!a && !!b && a.id === b.id && a.revision === b.revision;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const terminal = operation => ['stopped-local', 'acknowledged'].includes(operation?.state);
const needsPublication = kind => ['create-post', 'publish-version', 'create-reply'].includes(kind);

export function forumScopeKey(runtime, subjectId) {
  const state = runtime?.api.snapshot();
  return `${runtime?.api.endpoint ?? ''}:${subjectId ?? 'visitor'}:${state?.bindingId ?? ''}:${state?.generation ?? ''}`;
}

export function newForumDraft(kind = 'create-post', target = {}, values = {}) {
  return draftSchema.parse({ id: crypto.randomUUID(), revision: 1, kind, target, ...values });
}

export function forumDraftPayload(value, { maxPermissionSeconds, maxGovernanceHideSeconds }, now = Math.floor(Date.now() / 1000)) {
  const draft = draftSchema.parse(value), target = draft.target;
  const base = { schemaVersion: 1, operationId: crypto.randomUUID(), ...(typeof target.accountId==='string'?{accountId:z.uuid().parse(target.accountId)}:{}) };
  const content = () => ({ versionId: crypto.randomUUID(), title: draft.title.trim(), body: draft.body.trim(),
    links: draft.linksText.split(/\r?\n/).map(line => line.trim()).filter(Boolean), publishedUntil: now + maxPermissionSeconds,
    ...(forumTopicSchema.safeParse(draft.topic).success?{topic:draft.topic}:{}),
    ...(draft.attachments.length?{attachments:draft.attachments.map(({id,sha256})=>({id,sha256}))}:{}),
    ...(draft.sectionId!==undefined?{sectionId:draft.sectionId}:{}),...(draft.audience?{audience:draft.audience}:{}) });
  switch (draft.kind) {
    case 'create-post': return { ...base, postId: crypto.randomUUID(), expectedHeadVersion: 0, ...content() };
    case 'publish-version': return { ...base, postId: target.postId, expectedHeadVersion: target.expectedHeadVersion, ...content() };
    case 'create-reply': return { ...base, replyId: crypto.randomUUID(), postId: target.postId, postVersionId: target.versionId,
      expectedRevision: 0, body: draft.body.trim(), publishedUntil: now + maxPermissionSeconds, replyTo: draft.replyTo,
      ...(draft.attachments.length?{attachments:draft.attachments.map(({id,sha256})=>({id,sha256}))}:{}),...(draft.audience?{audience:draft.audience}:{}) };
    case 'create-section': case 'update-section': return {...base,sectionId:target.sectionId??crypto.randomUUID(),expectedVersion:target.expectedVersion??0,
      title:draft.title.trim(),theme:draft.theme.trim(),description:draft.description.trim(),audience:draft.audience,state:draft.sectionState};
    case 'withdraw-post': return { ...base, postId: target.postId, expectedHeadVersion: target.expectedHeadVersion };
    case 'withdraw-version': return { ...base, postId: target.postId, versionId: target.versionId, expectedHeadVersion: target.expectedHeadVersion };
    case 'withdraw-reply': return { ...base, replyId: target.replyId, expectedRevision: 1 };
    case 'create-report': return { ...base, reportId: crypto.randomUUID(), category: draft.category, summary: draft.body.trim(),
      target: target.kind === 'reply' ? { kind: 'reply', replyId: target.replyId, contentRevision: 1 }
        : { kind: 'post-version', postId: target.postId, versionId: target.versionId } };
    default: {
      const event = { ...base, governanceEventId: crypto.randomUUID(), reportId: target.reportId, expectedReportVersion: target.expectedReportVersion,
        kind: draft.kind === 'withdraw-report' ? 'withdraw' : draft.kind };
      if (draft.kind === 'withdraw-report') return event;
      if (draft.kind === 'resolve') return { ...event, resolution: draft.resolution, reason: draft.body.trim(),
        effect: draft.hide ? { kind: 'hide-version', until: now + Math.floor(Math.min(draft.hideHours * 3600, maxGovernanceHideSeconds)) } : null };
      return { ...event, summary: draft.body.trim() };
    }
  }
}

export function forumError(reason) {
  if(typeof reason?.code==='string'&&reason.code.startsWith('attachment_'))return forumAttachmentError(reason);
  if (reason?.name === 'TypeError' && ['Failed to fetch', 'fetch failed', 'NetworkError when attempting to fetch resource.', 'Load failed'].includes(reason.message)) {
    return '暂时无法连接社区，请检查网络后重试。';
  }
  return ({ forum_scope_changed: '身份或连接已改变，请重新打开并核对原稿。', receipt_status_authority_changed: '身份或连接已改变；原稿和原操作仍分别保留。',
    connection_required: '请登录银河账户后继续，草稿保留。', account_verification_required: '请登录银河账户后继续，草稿保留。',
    verified_account_required: '请登录银河账户后继续，草稿保留。', invalid_forum_payload: '请检查必填内容、字数和链接后再发表。',
    forum_payload_too_large: '这次内容超出可提交大小，请缩短文字或链接。', forum_quota_exceeded: '今天的此类发表额度已用完，本机稿可以保留。',
    operations_feature_disabled: '这类新操作目前已暂停，本机稿仍保留。',
    operations_rule_rejected: '这次内容不符合当前规则，本机稿仍保留，请调整后继续。',
    operations_rule_facts_unavailable: '暂时无法核对本次操作条件，本机稿仍保留，请稍后继续。',
    forum_version_conflict: '这条记录已更新，请保留本机稿并重新核对当前版本。', forum_operation_conflict: '同一原操作出现不同内容，请保留原记录核对。',
    forum_head_conflict: '帖子已经有新的变化，请保留本机稿并重新核对当前版本。',
    forum_locator_mismatch: '原操作的内容与准确定位不一致，请保留本机稿并重新核对原操作。',
    forum_report_version_conflict: '处理记录已经更新，请保留自己的说明，重新核对当前记录后再操作。',
    forum_post_withdrawn: '整条帖子已经撤回，不能继续发表新版本。本机稿仍保留。',
    forum_reply_source_unavailable: '准确的父版本或所回应回复当前不可读，不能新增回复。本机稿仍保留。',
    forum_report_source_unavailable: '需要举报的准确内容当前不可读，请重新核对目标。',
    forum_content_limit: '文字或链接超过当前服务允许的范围，请缩短内容后再确认。',
    forum_storage_quota_exceeded: '当前账号的社区存储额度不足，本机稿仍保留；可以先管理自己的已发表内容。',
    forum_independent_handler_required: '当前身份不是这项记录获准的独立处理者，不能写入处理决定。',
    forum_appeal_unavailable: '当前处理状态或申诉次数不允许这次申诉，请核对最新记录。',
    forum_report_transition: '当前处理状态不允许这次操作，请重新读取原记录。',
    forum_reply_transition: '这条回复的当前状态不允许再次执行该操作，请查询原结果。',
    forum_version_transition: '这一版本的当前状态不允许再次执行该操作，请查询原结果。',
    forum_report_event_limit: '这项记录的普通补充次数已达到当前服务上限。',
    community_restricted: '当前账号暂不能进行这类新的社区发表；已有记录仍可按权限核对。',
    consent_reauthorization_required: '原连接的授权不能继续。先查询原结果，再明确选择用当前连接继续同一操作。',
    not_found: '没有读到这项内容，或当前身份没有查看权限。', request_timeout: '等待超时，原结果可能尚未返回，请查询原操作。',
    forum_original_status_unavailable: '草稿所指的原操作暂不能核对。原记录仍保留，请先查询原结果，或明确停止本机重试。',
    forum_cursor_mismatch: '浏览条件已改变，请从当前主题重新读取列表。',
    official_account_session_expired: '请登录银河账户后继续，正在编辑的文字仍保存在此浏览器。',
    official_account_changed: '当前登录账户已经变化。原账户的草稿和原操作分别保留，请回到原账户继续。',
    official_account_unavailable: '账户暂时无法连接，草稿保留。连接恢复后继续。',
    account_selection_required: '这个 ID 关联了多个账户，请先选择本次操作的目标账户。',
    forum_audience_required: '请选择这次内容的阅读范围，草稿仍保留。',
    forum_participation_denied: '当前账户不符合这篇内容的参与条件，仍可按允许范围阅读。',
    forum_section_not_found: '没有读到这个版块，或当前账户不在它的阅读范围内。',
    forum_section_archived: '这个版块已归档，已有内容按各自许可保留，不再接收新帖子。',
    forum_section_version_conflict: '版块已被更新，当前修改仍在草稿中，请先读取新内容。',
    forum_section_maintenance_denied: '当前账户不是这个版块的维护者。',
  })[reason?.code ?? reason?.message] ?? (reason?.issues ? '请检查文字、链接和目标是否完整。' : reason?.message ?? '本次操作没有完成，请稍后重试。');
}

// Draft heads and the original-operation journal share one IDB transaction.
// A second tab can retire an operation without allowing an old queued save,
// signing completion, or HTTP completion to resurrect its retry body.
/** @param {any} runtime @param {{subjectId?: string|null, context?: string, browserDrafts?:boolean, account?:{id:string,assertCurrent:()=>void,call:(path:string,input:unknown,options?:{method?:string,signal?:AbortSignal})=>Promise<any>,transfer?:(path:string,input:unknown,options?:{method?:string,signal?:AbortSignal})=>Promise<Response>}|null, targetAccountId?:string|null, now?:()=>number,onAcknowledged?:(value:{kind:string,receipt:{status:string,operationId:string,locator:unknown}})=>unknown}} [options] */
export function createCommunityForumClient(runtime, { subjectId = null, context = 'community', browserDrafts = false, account = null, targetAccountId = null, now=()=>Math.floor(Date.now()/1000),onAcknowledged } = {}) {
  const api = runtime.api, endpoint = api.endpoint, original = api.snapshot();
  const lease = subjectId && !account ? runtime.receiptStatus.captureLease() : null;
  const ownerId=account?`account:${account.id}`:subjectId??'visitor';
  const key = `community-forum:${endpoint}:${account?ownerId:subjectId??(browserDrafts?'visitor':null)}`;
  const storageOwner=account||browserDrafts&&!subjectId?ownerId:subjectId;
  const accountActor=account?`account:${account.id}`:null;
  const previews = new WeakMap(), observed = new Set();
  let closed = false, loaded = false, head = null, lastSave = null, operationTail = Promise.resolve();
  const readAbort = new AbortController();
  if (!queues.has(api)) queues.set(api, new Map());
  const localQueues = queues.get(api);
  function check() {
    if (closed || api.endpoint !== endpoint) fail('forum_scope_changed', '页面或服务已改变，请重新打开社区。');
    if(account)return;
    if(browserDrafts&&!subjectId)return;
    lease?.assertCurrent();
    const current = api.snapshot();
    if (!!original !== !!current || original && ['subjectId', 'bindingId', 'generation'].some(field => original[field] !== current?.[field]))
      fail('forum_scope_changed', '身份或连接已改变，请重新核对本机稿和原操作。');
    if (subjectId && lease?.subjectId !== subjectId) fail('forum_scope_changed', '本机稿不属于当前身份。');
  }
  function localCheck() {
    check();
    if (!account && !browserDrafts && (!subjectId || !lease)) fail('forum_identity_required', '先建立或接回自己的银河身份，文字才能归入本机稿。');
  }
  function writeCheck(scope = null) {
    localCheck();
    if(account){account.assertCurrent();return;}
    if(!subjectId)fail('official_account_session_expired','请登录银河账户后继续，草稿仍保存在此浏览器。');
    const current = api.snapshot();
    if (!current) fail('connection_required', '请先连接当前身份。本机稿仍保留。');
    if (!current.scopes.some(value => value === '*' || (scope ? value === scope : ['assistance', 'moderation'].includes(value))))
      fail('device_scope_required', '当前设备没有此操作需要的权限，请接回已获准的设备。');
  }
  async function wait(action) {
    check();
    try { const value = await action(); check(); return value; } catch (error) { check(); throw error; }
  }
  const publicCall = (path, input, method = 'POST', signal) => wait(() => api.call(path, input, { method, authenticated: false, ...(signal?{signal}:{}) }));
  const privateCall = async (path, input, method = 'POST', accountId = targetAccountId, signal) => { writeCheck(); return wait(() => account?account.call(path,input,{method,...(signal?{signal}:{})}):api.call(path, input, { method, authenticated: true, ...(accountId?{accountId}:{}), ...(signal?{signal}:{}) })); };
  const recoverRead = action => readWithTransientRecovery(action,{signal:readAbort.signal,check:()=>{check();account?.assertCurrent();}});
  const readerCall = (path,input,method='POST',accountId=targetAccountId) => recoverRead(()=>account ? wait(()=>account.call(path,input,{method,signal:readAbort.signal}))
    : subjectId&&api.snapshot() ? wait(()=>api.call(path,input,{method,authenticated:true,...(accountId?{accountId}:{}),signal:readAbort.signal})) : publicCall(path,input,method,readAbort.signal));
  const privateRead = (path,input,method='POST',accountId=targetAccountId) => recoverRead(()=>privateCall(path,input,method,accountId,readAbort.signal));
  const attachments=createForumAttachmentsClient({endpoint,publicCall,account});
  function rowValue(value) {
    const row = value ?? { version: 1, endpoint, subjectId, ...(account||browserDrafts&&!subjectId?{ownerId}:{}), drafts: {}, active: null, completed: [] };
    if (row.version !== 1 || row.endpoint !== endpoint || row.subjectId !== subjectId || !row.drafts || !Array.isArray(row.completed))
      fail('forum_local_owner_mismatch', '本机社区记录与当前身份或服务不一致。');
    if((account||browserDrafts&&!subjectId)&&row.ownerId!==ownerId)fail('forum_local_owner_mismatch','当前账户与这份本机稿不一致。');
    return row;
  }
  function update(mutator) {
    localCheck();
    if (typeof runtime.updateLocal !== 'function') fail('local_atomic_update_unavailable', '当前本机存储不能安全保存，请保留文字后重新打开。');
    return wait(() => runtime.updateLocal(key, value => { localCheck(); return mutator(rowValue(value)); }, storageOwner));
  }
  const read = async () => { localCheck(); return rowValue(await wait(() => runtime.getLocal(key, storageOwner))); };
  function serialDraft(action) {
    localCheck();
    const invoke = () => { localCheck(); return action(); };
    const operation = (localQueues.get(key) ?? Promise.resolve()).then(invoke, invoke);
    const tail = operation.then(() => {}, () => {});
    localQueues.set(key, tail);
    void tail.then(() => { if (localQueues.get(key) === tail) localQueues.delete(key); });
    return operation;
  }
  function serialOperation(action) {
    localCheck();
    const invoke = () => { localCheck(); return action(); };
    const operation = operationTail.then(invoke, invoke);
    operationTail = operation.then(() => {}, () => {});
    return operation;
  }
  function retireDrafts(row, operation) {
    const reference = operation.draftRef, old = row.drafts[operation.context];
    if (reference && same(token(old), reference) && old?.operationId === operation.operationId)
      delete row.drafts[operation.context];
  }
  function consumeTerminalDraft(row) {
    const value = row.drafts[context];
    if (value?.operationId && row.completed.some(operation => operation.operationId === value.operationId && terminal(operation)))
      delete row.drafts[context];
    return row;
  }
  const draft = Object.freeze({
    load() {
      const originalSave = lastSave;
      return serialDraft(async () => {
        let row = await update(consumeTerminalDraft), value = row.drafts[context] ? draftSchema.parse(row.drafts[context]) : null;
        if (value?.operationId) {
          const operation = row.active?.operationId === value.operationId ? row.active : null;
          if (!operation) fail('forum_original_status_unavailable', '原操作记录不完整，不能将已提交稿当作新稿。');
          let result;
          try { result = await receipt(operation); }
          catch (error) { check(); throw Object.assign(Error('forum_original_status_unavailable'), { code: 'forum_original_status_unavailable', cause: error }); }
          if (result.status === 'acknowledged') await complete(operation, result);
          row = await update(consumeTerminalDraft);
          value = row.drafts[context] ? draftSchema.parse(row.drafts[context]) : null;
        }
        head = token(value); loaded = true;
        if (value) observed.add(`${value.id}:${value.revision}`);
        if (lastSave === originalSave) lastSave = null;
        return clone(value);
      });
    },
    save(input) {
      const value = draftSchema.parse(input);
      const operation = serialDraft(async () => {
        if (!loaded) fail('forum_draft_not_loaded', '请先读取这处本机稿，再保存修改。');
        const expected = head;
        const row = await update(current => {
          const old = current.drafts[context] ?? null;
          if (!same(token(old), expected)) fail('forum_draft_conflict', '本机稿已在另一页面改变。本次没有覆盖；请保留文字后重新读取。');
          if (value.operationId && current.completed.some(op => op.operationId === value.operationId && terminal(op)))
            fail('forum_operation_terminal', '原操作已经结束本机重试，不能把原编号重新保存成待发送稿。');
          if (old?.id === value.id && value.revision <= old.revision && JSON.stringify(old) !== JSON.stringify(value))
            fail('forum_draft_conflict', '本次编辑版本已过期，请重新读取本机稿。');
          current.drafts[context] = value; return current;
        });
        head = token(row.drafts[context]); observed.add(`${value.id}:${value.revision}`);
        return clone(row.drafts[context]);
      });
      lastSave = operation; return operation;
    },
    flush() { const saving = lastSave; return serialDraft(async () => { if (saving) await wait(() => saving); }); },
    clear(reference) {
      const expected = draftRefSchema.parse(reference);
      return serialDraft(async () => {
        let cleared = false;
        await update(row => {
          const old = row.drafts[context] ?? null;
          if (!old) cleared = observed.has(`${expected.id}:${expected.revision}`);
          else if (same(token(old), expected)) { delete row.drafts[context]; cleared = true; }
          return row;
        });
        if (cleared) { head = null; loaded = true; }
        return cleared;
      });
    },
    importVisitor(reference) {
      const expected=draftRefSchema.parse(reference);
      return serialDraft(async()=>{
        if(!account)fail('official_account_session_expired','登录后才能接回这份草稿。');
        const visitorKey=`community-forum:${endpoint}:visitor`;
        const source=await wait(()=>runtime.getLocal(visitorKey,'visitor'));
        const raw=source?.version===1&&source.endpoint===endpoint&&source.ownerId==='visitor'&&source.subjectId===null?source.drafts?.[context]:null;
        if(!raw||!same(token(raw),expected)||raw.operationId)return {status:'missing',draft:null};
        const value=draftSchema.parse(raw);let occupied=false;
        const row=await update(current=>{const prior=current.drafts[context];
          if(prior&&!same(token(prior),expected)){occupied=true;return current;}
          current.drafts[context]=clone(value);return current;});
        if(occupied)return {status:'occupied',draft:clone(value)};
        await wait(()=>runtime.updateLocal(visitorKey,current=>{
          if(current?.ownerId==='visitor'&&same(token(current.drafts?.[context]),expected)&&!current.drafts[context].operationId)delete current.drafts[context];
          return current;
        },'visitor'));
        head=token(row.drafts[context]);loaded=true;observed.add(`${value.id}:${value.revision}`);
        return {status:'imported',draft:clone(row.drafts[context])};
      });
    },
  });

  function minimal(operation, state, receipt = null) {
    const publishedUntil = operation.payload?.publishedUntil ?? operation.publishedUntil;
    return { operationId: operation.operationId, payloadHash: operation.payloadHash, kind: operation.kind,
      context: operation.context, draftRef: operation.draftRef, state,
      ...(Number.isSafeInteger(publishedUntil) ? { publishedUntil } : {}),
      ...(receipt?.locator ? { locator: clone(receipt.locator) } : {}),
      ...(state === 'stopped-local' ? { serverCancellationConfirmed: false } : {}), recordedAt: Date.now() };
  }
  async function complete(operation, receipt) {
    await update(row => {
      if (row.active?.operationId === operation.operationId) row.active = null;
      const prior = row.completed.find(item => item.operationId === operation.operationId);
      const item = minimal(operation, 'acknowledged', receipt);
      if (prior?.state === 'stopped-local' || prior?.localRetryStopped) item.localRetryStopped = true;
      row.completed = [...row.completed.filter(item => item.operationId !== operation.operationId), item];
      retireDrafts(row, operation); return row;
    });
    if(account&&needsPublication(operation.kind)&&receipt.status==='acknowledged'&&onAcknowledged){
      try{void Promise.resolve(onAcknowledged({kind:operation.kind,receipt:{status:'acknowledged',operationId:operation.operationId,locator:clone(receipt.locator)}})).catch(()=>{});}catch{}
    }
    // Do not advance this instance's observed draft head after an old request.
    // Only a fresh explicit load can adopt another tab's newer head.
    return receipt;
  }
  async function receipt(operation) {
    const result = await privateCall('/v2/community/receipt', { operationId: operation.operationId, payloadHash: operation.payloadHash }, 'POST', operation.payload?.accountId??targetAccountId);
    if (!['absent', 'acknowledged'].includes(result.status) || result.operationId !== operation.operationId || result.payloadHash !== operation.payloadHash)
      fail('forum_receipt_mismatch', '原操作回执未通过核对，请保留原记录。');
    return result;
  }
  async function activeOperation(operationId) {
    const row = await read();
    if (row.active?.operationId !== operationId || row.completed.some(item => item.operationId === operationId && terminal(item)))
      fail('forum_operation_terminal', '原操作已停止本机重试或已经确认，只能查询原结果。');
    return row.active;
  }
  async function saveActive(operation) {
    return update(row => {
      if (row.active?.operationId !== operation.operationId || row.completed.some(item => item.operationId === operation.operationId && terminal(item)))
        fail('forum_operation_terminal', '原操作已结束本机重试，迟到结果不会恢复待发送内容。');
      row.active = operation; return row;
    });
  }
  async function originalAuthorization(operation) {
    const spec = forumWriteSpec(operation.kind, operation.payload);
    if (operation.payload.operationId !== operation.operationId || JSON.stringify(operation.payload) !== operation.payloadJson
      || await wait(() => sha256Hex(operation.payloadJson)) !== operation.payloadHash
      || ['action','objectId','path','visibility'].some(field => spec[field] !== operation[field]))
      fail('forum_operation_conflict', '保存的内容与原发布操作不一致，请保留原稿。');
    if(account){if(operation.accountId!==account.id)fail('official_account_changed','原提交属于另一个账户。');return false;}
    if (!operation.prepared) return false;
    const intent = operation.prepared.intent;
    const expiresAt = needsPublication(operation.kind) ? operation.payload.publishedUntil : operation.authorizationExpiresAt;
    if (operation.prepared.payloadJson !== operation.payloadJson || operation.prepared.endpoint !== endpoint
      || intent.payloadHash !== operation.payloadHash || intent.subjectId !== subjectId || intent.endpoint !== endpoint
      || intent.action !== operation.action || intent.objectId !== operation.objectId || intent.visibility !== operation.visibility
      || intent.recipient!==endpoint || intent.purpose!==(operation.visibility==='Public'?'public-profile':'operational')
      || JSON.stringify(intent.fields)!==JSON.stringify(Object.keys(operation.payload))
      || intent.expiresAt !== expiresAt || JSON.stringify(intent.viewers) !== JSON.stringify(operation.viewers))
      fail('forum_operation_conflict', '原内容或可见范围已改变，请保留原稿。');
    const stamp=now();
    return intent.bindingId !== api.snapshot()?.bindingId || intent.issuedAt < stamp - 300 || intent.expiresAt <= stamp;
  }
  async function send(operation, { reauthorize = false } = {}) {
    try {
      writeCheck(operation.kind === 'resolve' ? 'moderation' : 'assistance'); await activeOperation(operation.operationId);
      if(account){
        await originalAuthorization(operation);
        if(needsPublication(operation.kind)&&operation.payload.publishedUntil<=now())fail('forum_publication_expired','原内容的公开期限已过，草稿仍保留。');
        operation.businessAttempted=true;await saveActive(operation);
        await privateCall(operation.path,{payloadJson:operation.payloadJson});
        const result=await receipt(operation);
        if(result.status!=='acknowledged')fail('forum_receipt_unknown','正在确认发表结果，请保留原稿。');
        return complete(operation,result);
      }
      if (reauthorize) {
        if(operation.prepared)operation.authorizationHistory=[...(operation.authorizationHistory??[]),
          {prepared:operation.prepared,reason:operation.prepared.intent.bindingId===api.snapshot()?.bindingId?'same-binding-signature-renewal':'explicit-current-binding-authorization'}];
        operation.prepared = null; delete operation.submission;
      }
      if (!operation.prepared) {
        const expiresAt = needsPublication(operation.kind) ? operation.payload.publishedUntil : operation.authorizationExpiresAt;
        if (expiresAt <= now()) fail('forum_publication_expired', '原操作选定的许可期限已过，不能通过重试自动延长。');
        operation.prepared = await wait(() => api.prepareAuthorization(operation.payloadJson, {
          action: operation.action, objectId: operation.objectId, visibility: operation.visibility,
          viewers: operation.viewers, expiresAt, confirmed: true,
        }));
        operation.authorizationBindingId=operation.prepared.intent.bindingId;
        await saveActive(operation);
      }
      const intent = operation.prepared.intent, stamp=now();
      if (intent.bindingId !== api.snapshot()?.bindingId || intent.issuedAt < stamp - 300 || intent.expiresAt <= stamp)
        fail('consent_reauthorization_required', '原签名需要在核对原结果后，用当前连接明确重新确认。');
      if (operation.prepared.payloadJson !== operation.payloadJson || intent.payloadHash !== operation.payloadHash
        || intent.subjectId !== subjectId || operation.prepared.endpoint !== endpoint)
        fail('forum_operation_conflict', '原签名与保存的准确内容不一致，请保留原记录核对。');
      operation.businessAttempted = true; await saveActive(operation);
      await activeOperation(operation.operationId);
      // The server creates and consumes the signed Consent in the same forum
      // transaction. A rejected business write cannot leave an unspent grant.
      await privateCall(operation.path, { signedIntent: operation.prepared.signedIntent, payloadJson: operation.payloadJson }, 'POST', operation.payload.accountId??targetAccountId);
      const result = await receipt(operation);
      if (result.status !== 'acknowledged') fail('forum_receipt_unknown', '写入结果尚未确认，请查询原操作。');
      return await complete(operation, result);
    } catch (error) {
      throw Object.assign(error, { operationId: operation.operationId, resultUnknown: error.outcome !== 'rejected' });
    }
  }

  return Object.freeze({
    check, draft, attachments, close() { closed = true; readAbort.abort(); },
    topics: () => recoverRead(()=>publicCall('/v2/community/topics', null, 'GET',readAbort.signal)),
    posts: input => readerCall('/v2/community/posts/query', input ?? {}),
    post: postId => readerCall(`/v2/community/posts/${z.uuid().parse(postId)}`, null, 'GET'),
    version: (postId, versionId) => readerCall(`/v2/community/posts/${z.uuid().parse(postId)}/versions/${z.uuid().parse(versionId)}`, null, 'GET'),
    versions: (postId, input = {}) => readerCall(`/v2/community/posts/${z.uuid().parse(postId)}/versions`, input),
    replies: input => readerCall('/v2/community/replies/query', input),
    reply: replyId => readerCall(`/v2/community/replies/${z.uuid().parse(replyId)}`, null, 'GET'),
    accessOptions: () => readerCall('/v2/community/access-options',null,'GET'),
    accounts: (input={}) => readerCall('/v2/community/accounts/query',input),
    sections: (input={}) => readerCall('/v2/community/sections/query',input),
    section: sectionId => readerCall(`/v2/community/sections/${z.uuid().parse(sectionId)}`,null,'GET',null),
    notifications: (input={}) => privateRead('/v2/community/notifications/query',input),
    readNotification: replyId => privateCall('/v2/community/notifications/read',{replyId:z.uuid().parse(replyId)}),
    owned: (input = {}) => privateRead('/v2/community/posts/owned', input),
    ownPost: postId => privateRead(`/v2/community/posts/${z.uuid().parse(postId)}/owned`, null, 'GET',null),
    ownReply: replyId => privateRead(`/v2/community/replies/${z.uuid().parse(replyId)}/owned`, null, 'GET',null),
    quotas: (input={}) => {const query=new URLSearchParams();for(const name of ['postId','replyId','sectionId'])if(input[name])query.set(name,z.uuid().parse(input[name]));return privateRead('/v2/community/quotas'+(query.size?'?'+query:''),null,'GET',query.size?null:targetAccountId);},
    permission: permissionId => privateRead(`/v2/community/permissions/${z.uuid().parse(permissionId)}`, null, 'GET'),
    reportConfig: (input = {}) => privateRead('/v2/community/reports/config', input),
    reports: (input = {}) => privateRead('/v2/community/reports/query', input),
    report: reportId => privateRead(`/v2/community/reports/${z.uuid().parse(reportId)}`, null, 'GET',null),
    /** @param {string} kind @param {unknown} input @param {{viewers?: string[], draftRef?: {id: string, revision: number}|null, authorizationExpiresAt?: number}} [options] */
    async prepare(kind, input, { viewers = [], draftRef = null, authorizationExpiresAt = now() + 3600 } = {}) {
      writeCheck(kind === 'resolve' ? 'moderation' : 'assistance');
      // Bind only a new preparation. Retained operations never enter this path.
      // Check the lease around each real digest, including both create-post IDs.
      const scopedCrypto = { subtle: { digest: (algorithm, bytes) => wait(() => globalThis.crypto.subtle.digest(algorithm, bytes)) } };
      const knownAccount=!!input&&typeof input==='object'&&'accountId'in input&&typeof input.accountId==='string'?input.accountId:null;
      const targeted=!account&&!knownAccount&&targetAccountId?Object.assign({},input,{accountId:targetAccountId}):input;
      const payload = await wait(() => bindForumIds(kind, accountActor??subjectId, targeted, scopedCrypto));
      const spec = forumWriteSpec(kind, payload);
      const payloadJson = JSON.stringify(payload), payloadHash = await wait(() => sha256Hex(payloadJson));
      const operation = { kind, operationId: payload.operationId, payload, payloadJson, payloadHash,
        action: spec.action, objectId: spec.objectId, path: spec.path, visibility: spec.visibility,
        viewers: [...new Set(viewers)], authorizationExpiresAt, context, ...(account?{accountId:account.id}:{}), draftRef: draftRef ? draftRefSchema.parse(draftRef) : null };
      const preview = clone({ kind, payload, visibility: spec.visibility, viewers: operation.viewers, payloadHash });
      previews.set(preview, operation); return preview;
    },
    execute(preview, { confirmed = false } = {}) {
      return serialOperation(async () => {
        const operation = previews.get(preview);
        if (!confirmed || !operation) fail('forum_confirmation_required', '请核对这份预览后明确确认。');
        writeCheck(operation.kind === 'resolve' ? 'moderation' : 'assistance');
        operation.authorizationBindingId=api.snapshot()?.bindingId;
        await update(row => {
          if (row.active) fail('forum_operation_pending', '请先核对或停止上一项本机重试。');
          if (row.completed.some(item => item.operationId === operation.operationId && terminal(item)))
            fail('forum_operation_terminal', '原编号已结束本机重试，不能重新发表。');
          if (operation.draftRef) {
            const current = row.drafts[context];
            if (!same(token(current), operation.draftRef)) fail('forum_draft_conflict', '预览后的本机稿已改变，请重新读取和预览。');
            current.operationId = operation.operationId;
          }
          row.active = clone(operation); return row;
        });
        previews.delete(preview);
        return send(clone(operation));
      });
    },
    async pending() {
      const row = await read();
      return [ ...(row.active ? [{ ...minimal(row.active, 'awaiting-receipt'), originalBindingId: row.active.prepared?.intent.bindingId ?? null }] : []), ...row.completed.map(clone) ];
    },
    resumePending() {
      return serialOperation(async () => {
        const row = await read(), operation = row.active;
        if (!operation) return { status: 'none' };
        const result = await receipt(operation);
        if (result.status === 'acknowledged') return complete(operation, result);
        // The approved selection owns a fixed binding, body, audience and
        // deadline. Only signature age in that same binding can renew itself.
        const reauthorize = await originalAuthorization(operation);
        if(account)return send(clone(operation));
        const bindingId=operation.prepared?.intent?.bindingId??operation.authorizationBindingId;
        if(!bindingId||bindingId!==api.snapshot()?.bindingId)
          throw Object.assign(new Error('原许可未成立，请核对原内容后明确使用当前连接继续。'),{
            code:'consent_reauthorization_required',reason:bindingId?'original-binding-changed':'original-binding-unavailable'});
        return send(clone(operation), { reauthorize });
      });
    },
    async reviewOperation(operationId) {
      const operation = await activeOperation(operationId);
      return clone({ operationId: operation.operationId, kind: operation.kind, payload: operation.payload,payloadHash:operation.payloadHash,
        expiresAt:needsPublication(operation.kind)?operation.payload.publishedUntil:operation.authorizationExpiresAt??operation.prepared?.intent?.expiresAt??null,
        visibility: operation.visibility, viewers: operation.viewers, originalBindingId: operation.prepared?.intent.bindingId ?? operation.authorizationBindingId ?? null,
        requiresReauthorization: account?false:!operation.prepared
          ? !operation.authorizationBindingId||operation.authorizationBindingId!==api.snapshot()?.bindingId
          : operation.prepared.intent.bindingId !== api.snapshot()?.bindingId||operation.prepared.intent.issuedAt < now() - 300 });
    },
    reconcile(operationId) {
      return serialOperation(async () => {
        const row = await read(), operation = row.active?.operationId === operationId ? row.active : row.completed.find(item => item.operationId === operationId);
        if (!operation) fail('forum_operation_missing', '本机没有这项原操作记录。');
        const result = await receipt(operation);
        return result.status === 'acknowledged' ? complete(operation, result) : result;
      });
    },
    retry(operationId, { confirmed = false, reauthorize = false } = {}) {
      return serialOperation(async () => {
        if (!confirmed) fail('forum_confirmation_required', '请明确确认继续原操作。');
        const operation = await activeOperation(operationId), result = await receipt(operation);
        if (result.status === 'acknowledged') return complete(operation, result);
        return send(clone(operation), { reauthorize });
      });
    },
    stopLocalRetry(operationId, { confirmed = false } = {}) {
      return serialOperation(async () => {
        if (!confirmed) fail('forum_confirmation_required', '请确认停止本机重试。');
        let result;
        await update(row => {
          const operation = row.active;
          if (operation?.operationId !== operationId) {
            result = row.completed.find(item => item.operationId === operationId);
            if (!terminal(result)) fail('forum_operation_missing', '原操作不在本机待重试记录中。');
            return row;
          }
          result = minimal(operation, 'stopped-local');
          row.active = null; row.completed = [...row.completed.filter(item => item.operationId !== operationId), result];
          retireDrafts(row, operation); return row;
        });
        return clone(result);
      });
    },
  });
}
