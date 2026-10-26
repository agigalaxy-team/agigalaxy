import {z} from 'zod';
import {identityProviderSchema, identityIntentSchema, identityPageSchema} from "../../../../galaxy-official/src/shared/identity-link-schema.mjs";
import {sha256Hex} from "../../../../galaxy-official/src/shared/web-primitives.mjs";

const uuid = z.uuid();
const terminal = new Set(['linked', 'revoked', 'binding-inactive', 'provider-unavailable', 'canceled']);
const loginStates = ['preparing', 'awaiting-login', 'exchanging', 'awaiting-local-signature', 'linked', 'revoked', 'failed', 'canceled'];
const key = 'account-verification-operations';
const error = (code, message) => Object.assign(new Error(message), {code});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** @typedef {{id: string, payloadJson: string, intent: import('zod').output<typeof identityIntentSchema>, payloadHash?: string}} AccountLinkPreview */

// Account verification proves an external account association. It never creates
// a Galaxy identity, expands device scopes, or grants professional capability.
export function createAccountVerificationClient({api, endpoint, captureLease, sign, getLocal, updateLocal, now = () => Math.floor(Date.now() / 1000)}) {
  if (typeof captureLease !== 'function' || typeof sign !== 'function' || typeof getLocal !== 'function' || typeof updateLocal !== 'function')
    throw new Error('Account verification storage and authority required.');
  const busy = new Set();
  function lease() {
    const authority = captureLease(); authority.assertCurrent();
    if (authority.endpoint !== endpoint) throw error('account_authority_changed', '银河账户关联所属的身份或服务已改变。');
    return authority;
  }
  function current(authority) {
    authority.assertCurrent();
    const connection = api.snapshot();
    if (!connection || connection.subjectId !== authority.subjectId || connection.endpoint !== endpoint
      || connection.bindingId !== authority.bindingId || connection.generation !== authority.generation
      || !connection.scopes.includes('binding')) throw error('connection_required', '请连接当前身份后继续核对原银河账户关联。');
  }
  async function wait(authority, action, {connected = false} = {}) {
    authority.assertCurrent(); if (connected) current(authority);
    let result;
    try {result = await action();} catch (caught) {authority.assertCurrent(); if (connected) current(authority); throw caught;}
    authority.assertCurrent(); if (connected) current(authority); return result;
  }
  const call = (authority, path, input) => wait(authority, () => api.call(path, input), {connected: true});
  function journal(value, authority) {
    if (value == null) return {version: 1, subjectId: authority.subjectId, endpoint, activeId: null, operations: {}};
    if (value.version !== 1 || value.subjectId !== authority.subjectId || value.endpoint !== endpoint
      || !value.operations || typeof value.operations !== 'object' || Array.isArray(value.operations)
      || value.activeId !== null && !uuid.safeParse(value.activeId).success)
      throw error('account_operation_invalid', '本机原银河账户关联记录不可用，请保留原操作编号。');
    for (const [id, operation] of Object.entries(value.operations)) {
      if (!uuid.safeParse(id).success || operation?.id !== id || operation.subjectId !== authority.subjectId || operation.endpoint !== endpoint
        || !uuid.safeParse(operation.bindingId).success || typeof operation.state !== 'string')
        throw error('account_operation_invalid', '本机原银河账户关联记录不可用，请保留原操作编号。');
    }
    if (value.activeId && !value.operations[value.activeId]) throw error('account_operation_invalid', '本机原银河账户关联记录不可用，请保留原操作编号。');
    return value;
  }
  const read = authority => wait(authority, async () => journal(await getLocal(key, authority.subjectId), authority));
  const update = (authority, change) => wait(authority, () => updateLocal(key, value => {
    authority.assertCurrent(); return change(journal(value, authority));
  }, authority.subjectId));
  async function save(authority, operation, original, {activate = false, finish = false} = {}) {
    return update(authority, value => {
      const prior = value.operations[operation.id];
      if (original !== undefined && !same(prior, original)) throw error('account_operation_changed', '原银河账户关联已改变，请查询同一编号后再继续。');
      if (activate && value.activeId && value.activeId !== operation.id && !terminal.has(value.operations[value.activeId].state))
        throw error('account_operation_pending', '请先查询或明确停止上一次银河账户关联。');
      return {...value, activeId: finish && value.activeId === operation.id ? null : activate ? operation.id : value.activeId,
        operations: {...value.operations, [operation.id]: operation}};
    });
  }
  const summary = operation => operation ? {
    id: operation.id, subjectId: operation.subjectId, endpoint: operation.endpoint, bindingId: operation.bindingId,
    providerId: operation.providerId ?? null, issuer: operation.issuer ?? null, authorizationUrl: operation.authorizationUrl ?? null,
    expiresAt: operation.expiresAt ?? null, state: operation.state, localRetryStopped: operation.localRetryStopped === true,
    confirmationSubmitted: !!operation.signed, cancelRequested: operation.cancelRequested === true,
  } : null;
  async function original(authority, id) {
    uuid.parse(id); const value = await read(authority);
    if (value.operations[id]) return value.operations[id];
    const old = await wait(authority, () => getLocal('account-login', authority.subjectId));
    if (old?.id !== id) return null;
    if (!uuid.safeParse(old.id).success || !uuid.safeParse(old.bindingId).success || !Number.isSafeInteger(old.expiresAt)
      || typeof old.issuer !== 'string' || typeof old.authorizationUrl !== 'string')
      throw error('account_operation_invalid', '旧银河账户关联记录不可用，请保留原操作编号。');
    let target;
    try {target = new URL(old.authorizationUrl);} catch {throw error('account_operation_invalid', '旧银河账户关联地址不可用，请保留原操作编号。');}
    if (target.protocol !== 'https:' || target.username || target.password || target.hash)
      throw error('account_operation_invalid', '旧银河账户关联地址不可用，请保留原操作编号。');
    const imported = {version: 1, id, subjectId: authority.subjectId, endpoint, bindingId: old.bindingId, issuer: old.issuer,
      authorizationUrl: old.authorizationUrl, expiresAt: old.expiresAt, state: 'awaiting-login', legacy: true};
    await save(authority, imported, undefined, {activate: !value.activeId}); return imported;
  }
  async function page(authority, input = {}) {
    const value = identityPageSchema.parse(await call(authority, '/v1/identity/query', input));
    if (value.endpoint !== endpoint || value.subjectId !== authority.subjectId
      || value.items.some(item => item.subjectId !== authority.subjectId || item.endpoint !== endpoint))
      throw error('account_result_mismatch', '账号关联查询与当前身份或服务不一致。');
    return value;
  }
  async function durable(authority, id, record = null) {
    const result = await page(authority, {id, limit: 1}), association = result.items[0];
    if (!association) return null;
    if (association.id !== id || result.items.length !== 1) throw error('account_result_mismatch', '原账号关联查询编号不一致。');
    if (record?.intent && ['issuer', 'externalSubject', 'clientId', 'providerId', 'bindingId'].some(field => record.intent[field] !== association[field]))
      throw error('account_result_mismatch', '关联事实与本机保存的原确认内容不一致。');
    if (record) await save(authority, {...record, state: association.state, receipt: association, localRetryStopped: record.localRetryStopped === true}, record, {finish: true});
    return {id, state: association.state, association, galaxyAuthorization: false, source: 'durable-query'};
  }
  async function temporary(authority, id, record) {
    let result;
    try {result = await call(authority, '/v1/identity/status', {id});}
    catch (caught) {
      if (caught.code !== 'identity_login_unavailable' || caught.status !== 409) throw caught;
      return {id, state: 'unavailable', outcome: record?.signed || record?.cancelRequested || record?.legacy ? 'unknown' : 'not-confirmed',
        source: 'temporary-login-unavailable', galaxyAuthorization: false};
    }
    if (result?.id !== id || result.galaxyAuthorization !== false || !loginStates.includes(result.state)
      || !Number.isSafeInteger(result.expiresAt)) throw error('account_result_mismatch', '银河账户关联返回的原编号或状态不一致。');
    if (['linked', 'revoked'].includes(result.state)) {
      const found = await durable(authority, id, record);
      if (!found) throw error('account_result_mismatch', '原确认结果尚未能从持久记录核对，请继续查询同一编号。');
      return found;
    }
    if (result.state === 'awaiting-local-signature') {
      let intent;
      try {intent = identityIntentSchema.parse(JSON.parse(result.payloadJson));} catch {throw error('account_preview_invalid', '账号关联预览无效。');}
      if (!same(intent, result.intent) || intent.id !== id || intent.subjectId !== authority.subjectId || intent.endpoint !== endpoint
        || intent.bindingId !== authority.bindingId || intent.expiresAt <= now() || intent.issuedAt > now()
        || record?.bindingId && record.bindingId !== intent.bindingId
        || record?.payloadJson && record.payloadJson !== result.payloadJson)
        throw error('account_preview_changed', '原银河账户关联所属的身份、连接或确认内容已改变，请先查询原编号。');
      result = {...result, payloadHash: await wait(authority, () => sha256Hex(result.payloadJson))};
      if (record?.payloadHash && record.payloadHash !== result.payloadHash)
        throw error('account_preview_changed', '本机原账号确认内容已改变，请保留原编号并查询。');
      const next = {...record, version: 1, id, subjectId: authority.subjectId, endpoint, bindingId: intent.bindingId,
        providerId: intent.providerId, issuer: intent.issuer, expiresAt: intent.expiresAt,
        intent, payloadJson: result.payloadJson, payloadHash: result.payloadHash,
        state: record?.signed ? 'awaiting-result' : 'awaiting-local-signature'};
      await save(authority, next, record ?? undefined, {activate: !record?.localRetryStopped});
    }
    return result;
  }
  const serial = async action => {
    const authority = lease(), owner = [authority.subjectId, authority.deviceId, authority.bindingId, authority.generation].join(':');
    if (busy.has(owner)) throw error('account_operation_busy', '当前身份已有银河账户关联操作正在处理。');
    busy.add(owner); try {return await action(authority);} finally {busy.delete(owner);}
  };
  return Object.freeze({
    captureLease: lease,
    async providers() {
      const authority = lease();
      const value = z.strictObject({endpoint: z.literal(endpoint), providers: z.array(identityProviderSchema).max(8), galaxyAuthorization: z.literal(false)})
        .parse(await call(authority, '/v1/identity/providers', {}));
      if (value.providers.some(provider => provider.redirectUri !== `${endpoint}/v1/identity/callback/${provider.id}`))
        throw error('account_provider_mismatch', '银河账户关联回调与当前服务不一致。');
      return value;
    },
    query(input = {}) {return page(lease(), input);},
    quotas() {return call(lease(), '/v2/account/quotas', {});},
    async pending() {
      const authority = lease(), value = await read(authority);
      if (value.activeId) return summary(value.operations[value.activeId]);
      const old = await wait(authority, () => getLocal('account-login', authority.subjectId));
      if (!old || value.operations[old.id]) return null;
      return summary(await original(authority, old.id));
    },
    async originals() {
      const value = await read(lease());
      return Object.values(value.operations).filter(operation => !terminal.has(operation.state)
        && (operation.localRetryStopped || operation.signed || operation.cancelRequested)).map(summary);
    },
    begin(providerId, {confirmed = false} = {}) {return serial(async authority => {
      if (!confirmed) throw error('account_confirmation_required', '请选择并确认这次银河账户关联服务。');
      const value = await read(authority);
      const old = await wait(authority, () => getLocal('account-login', authority.subjectId));
      if (value.activeId || old && !value.operations[old.id]) throw error('account_operation_pending', '请先查询或明确停止上一次银河账户关联。');
      const result = identityProviderSchema.extend({loginId: uuid, authorizationUrl: z.url(), expiresAt: z.number().int(),
        subjectId: z.literal(authority.subjectId), bindingId: z.literal(authority.bindingId), endpoint: z.literal(endpoint), galaxyAuthorization: z.literal(false)})
        .parse(await call(authority, '/v1/identity/begin', {providerId}));
      const target = new URL(result.authorizationUrl), required = {redirect_uri: result.redirectUri, client_id: result.clientId, scope: 'openid email', response_type: 'code', code_challenge_method: 'S256'};
      if (result.id !== providerId || result.redirectUri !== `${endpoint}/v1/identity/callback/${providerId}` || target.protocol !== 'https:'
        || target.username || target.password || target.hash || result.expiresAt <= now() || result.expiresAt > now() + 300
        || Object.entries(required).some(([name, expected]) => target.searchParams.getAll(name).length !== 1 || target.searchParams.get(name) !== expected)
        || ['state', 'nonce', 'code_challenge'].some(name => target.searchParams.getAll(name).length !== 1 || !target.searchParams.get(name)))
        throw error('account_provider_mismatch', '银河账户关联地址、服务或登录期限不一致。');
      const operation = {version: 1, id: result.loginId, subjectId: authority.subjectId, endpoint, bindingId: authority.bindingId,
        providerId, issuer: result.issuer, authorizationUrl: target.href, expiresAt: result.expiresAt, state: 'awaiting-login'};
      await save(authority, operation, undefined, {activate: true}); return summary(operation);
    });},
    status(id) {return serial(async authority => {
      const record = await original(authority, id);
      return await durable(authority, id, record) ?? await temporary(authority, id, record);
    });},
    /** @param {string|null} id */
    resumePending(id = null) {return serial(async authority => {
      const value=await read(authority),selected=id??value.activeId??Object.values(value.operations)
        .find(operation=>operation.revokeRequested&&operation.state!=='revoked')?.id;
      if(!selected)return{state:'none'};
      let record=await original(authority,selected);if(!record)return{state:'none',id:selected};
      const found=await durable(authority,selected,record);
      record=await original(authority,selected);
      const blocked=(result,reason)=>({...result,reason});
      if(found){
        if(!record.revokeRequested||found.state==='revoked')return found;
        if(record.localRetryStopped)return blocked(found,'stopped-local');
        if(record.revokeBindingId!==authority.bindingId)return blocked(found,'original-binding-changed');
        if(!Number.isSafeInteger(record.revokeExpiresAt)||record.revokeExpiresAt<=now())return blocked(found,'authorization-expired');
        const result=await call(authority,'/v1/identity/revoke',{id:selected});
        if(result?.id!==selected||result.state!=='revoked'||result.galaxyAuthorization!==false)
          throw error('account_result_mismatch','解除结果未能核对，请保留原关联记录。');
        await save(authority,{...record,state:'revoked',receipt:result,revokeRequested:false},record,{finish:true});return result;
      }
      if(record.localRetryStopped)return blocked(await temporary(authority,selected,record),'stopped-local');
      if(record.bindingId!==authority.bindingId)return{id:selected,state:'unavailable',outcome:'unknown',galaxyAuthorization:false,reason:'original-binding-changed'};
      if(record.expiresAt<=now())return{id:selected,state:'unavailable',outcome:record.signed?'unknown':'not-confirmed',galaxyAuthorization:false,reason:'authorization-expired'};
      const status=await temporary(authority,selected,record);if(status.source==='durable-query')return status;
      record=await original(authority,selected);
      if(record.cancelRequested){
        if(status.state==='unavailable')return status;
        const result=await call(authority,'/v1/identity/cancel',{id:selected});
        if(result?.id!==selected||result.state!=='canceled')throw error('account_result_mismatch','取消结果未能核对，请保留原编号。');
        await save(authority,{...record,state:'canceled',receipt:result},record,{finish:true});return{...result,serverOperationCancelled:true};
      }
      // An external login awaiting its first local approval is a preview. Only
      // the exact signature durably saved by an earlier confirm may be replayed.
      if(!record.signed||status.state!=='awaiting-local-signature')return status;
      const intent=identityIntentSchema.parse(JSON.parse(record.payloadJson));
      if(!same(intent,record.intent)||record.payloadJson!==status.payloadJson||!same(intent,status.intent)
        ||record.payloadHash!==await wait(authority,()=>sha256Hex(record.payloadJson)))
        throw error('account_preview_changed','原账号关联内容已变化，请保留原编号。');
      const result=await call(authority,'/v1/identity/confirm',{id:selected,signed:record.signed});
      if(result?.id!==selected||result.galaxyAuthorization!==false||!['linked','revoked'].includes(result.state))
        throw error('account_result_mismatch','原关联结果未能核对，请保留原编号。');
      await save(authority,{...record,state:result.state,receipt:result},record,{finish:true});return result;
    });},
    /**
     * @param {string} id
     * @param {{confirmed?: boolean, preview?: AccountLinkPreview}} [options]
     */
    confirm(id, {confirmed = false, preview} = {}) {return serial(async authority => {
      if (!confirmed) throw error('account_confirmation_required', '请核对并确认将此账号关联到当前银河身份。');
      let record = await original(authority, id);
      const found = await durable(authority, id, record);
      if (found) return found;
      if (record?.localRetryStopped) throw error('account_retry_stopped', '本机已停止原关联重试，仍可按原编号查询结果。');
      const status = await temporary(authority, id, record);
      if (status.source === 'durable-query') return status;
      if (status.state !== 'awaiting-local-signature') throw error('account_preview_unavailable', '原账号关联预览不可用，请查询同一操作结果。');
      if (preview && (preview.id !== id || preview.payloadJson !== status.payloadJson || !same(preview.intent, status.intent)
        || preview.payloadHash && preview.payloadHash !== status.payloadHash)) throw error('account_preview_changed', '实际展示的账号关联预览已改变，请重新查询原编号。');
      record = await original(authority, id);
      current(authority);
      const signed = record.signed ?? await wait(authority, () => sign(status.payloadJson, 'galaxy-identity-link+jws', authority), {connected: true});
      const next = {...record, signed, state: 'awaiting-result'};
      await save(authority, next, record);
      const result = await call(authority, '/v1/identity/confirm', {id, signed});
      if (result?.id !== id || result.galaxyAuthorization !== false || !['linked', 'revoked'].includes(result.state))
        throw error('account_result_mismatch', '关联提交结果未能核对，请保留原编号并查询。');
      await save(authority, {...next, state: result.state, receipt: result}, next, {finish: true}); return result;
    });},
    cancel(id, {confirmed = false} = {}) {return serial(async authority => {
      if (!confirmed) throw error('account_confirmation_required', '请确认取消这次银河账户关联。');
      let record = await original(authority, id);
      const found = await durable(authority, id, record);
      if (found) return {...found, serverOperationCancelled: false};
      if (!record) throw error('account_operation_unavailable', '没有本机保存的原银河账户关联，请先查询关联记录。');
      const next = {...record, cancelRequested: true, state: 'awaiting-cancel-result'}; await save(authority, next, record); record = next;
      const result = await call(authority, '/v1/identity/cancel', {id});
      if (result?.id !== id || result.state !== 'canceled') throw error('account_result_mismatch', '取消结果未能核对，请保留原编号。');
      await save(authority, {...record, state: 'canceled', receipt: result}, record, {finish: true}); return {...result, serverOperationCancelled: true};
    });},
    stop(id, {confirmed = false} = {}) {return serial(async authority => {
      if (!confirmed) throw error('account_confirmation_required', '请确认只停止本机原操作重试。');
      const record = await original(authority, id);
      if (!record) throw error('account_operation_unavailable', '没有本机保存的原银河账户关联，请先查询关联记录。');
      await save(authority, {...record, localRetryStopped: true}, record, {finish: true});
      return {id, localRetryStopped: true, serverOperationCancelled: false};
    });},
    revoke(id, {confirmed = false} = {}) {return serial(async authority => {
      if (!confirmed) throw error('account_confirmation_required', '请确认解除此账号关联。');
      uuid.parse(id); const record = await original(authority, id), found = await durable(authority, id, record);
      if (!found) throw error('account_operation_unavailable', '原账号关联不可用，请查询当前关联记录。');
      if (found.state === 'revoked') return {id, state: 'revoked', galaxyAuthorization: false};
      const originalRecord=await original(authority,id),connection=api.snapshot();
      const pending={...(originalRecord??{version:1,id,subjectId:authority.subjectId,endpoint,bindingId:found.association.bindingId}),
        state:'awaiting-revoke-result',revokeRequested:true,revokeBindingId:authority.bindingId,
        revokeExpiresAt:Math.min(connection.expiresAt,connection.bindingExpiresAt??Infinity)};
      await save(authority,pending,originalRecord??undefined,{activate:true});
      const result = await call(authority, '/v1/identity/revoke', {id});
      if (result?.id !== id || result.state !== 'revoked' || result.galaxyAuthorization !== false)
        throw error('account_result_mismatch', '解除结果未能核对，请查询同一关联编号。');
      await save(authority,{...pending,state:'revoked',receipt:result,revokeRequested:false},pending,{finish:true});return result;
    });},
  });
}
