import {
  capsuleEventV2Schema,
  capsuleUseV2Schema,
  capsulePermissionV2Schema,
} from '../../galaxy-official/src/shared/capsule-v2-schema.mjs';
import { sha256Hex } from '../../galaxy-official/src/shared/web-primitives.mjs';
import {configurationEventV2Schema} from '../../galaxy-official/src/shared/configuration-v2-schema.mjs';
import {qualificationRequestEventSchema} from '../../galaxy-official/src/shared/qualification-requests-v2-schema.mjs';
import {qualificationCalculationSchema} from '../../galaxy-official/src/shared/qualification-calculation-schema.mjs';
import {packUseEventSchema} from '../../galaxy-official/src/shared/worker-pack-uses-v2-schema.mjs';

export const capsuleRefKey = (ref) =>
  `${ref.kind ?? ref.type}:${ref.id}:${ref.version}`;
export function currentCapsuleFacts(items = []) {
  const byId = new Map();
  for (const item of items)
    if (!byId.has(item.id) || byId.get(item.id).version < item.version)
      byId.set(item.id, item);
  return [...byId.values()].filter((item) => !item.supersededInVisibleHistory);
}
export function capsuleCaseSources(history) {
  const caseId = history.caseId,
    root = history.events?.find((e) =>
      ['case', 'case-created'].includes(e.payload.kind),
    ),
    sources = [];
  if (root)
    sources.push({
      ref: { kind: 'case-root', id: root.eventId, version: 1, caseId },
      authorId: root.reportedBy,
      label: history.title ?? '工作背景',
    });
  for (const [field, kind] of [
    ['attempts', 'attempt'],
    ['interventions', 'intervention'],
    ['results', 'result'],
  ])
    for (const fact of currentCapsuleFacts(history[field] ?? []))
      sources.push({
        ref: { kind, id: fact.id, version: fact.version, caseId },
        authorId: fact.actorId === 'unknown' ? fact.reportedBy : fact.actorId,
        label: fact.summary ?? fact.description ?? fact.strategy ?? kind,
        fact,
      });
  for (const view of history.verificationRecords ?? [])
    if (view.referenceStatus === 'current' && view.record)
      sources.push({
        ref: { kind: view.type, id: view.id, version: view.version, caseId },
        authorId: view.record.reportedBy,
        label: view.record.summary,
        view,
      });
  return sources;
}

// Drafts and the exact-operation journal stay on the selected user's device.
// Network retries reuse the original event and Consent; read never writes use.
export function createCapsuleWebClient({ api, getLocal, putLocal, subjectId, operationFamily='capsule',now=()=>Math.floor(Date.now()/1000) }) {
  if(!['capsule','configuration','qualification','worker-pack'].includes(operationFamily))throw new Error('未知操作类别。');
  const endpoint = api.endpoint,
    key = `${operationFamily}-operations:${endpoint}:${subjectId}`,
    previews = new WeakMap();
  let queue = Promise.resolve();
  const check = () => {
    if (
      api.endpoint !== endpoint ||
      !subjectId ||
      api.snapshot()?.subjectId !== subjectId
    )
      throw new Error('身份或连接已改变，请重新打开当前内容。');
  };
  /** @param {() => Promise<any>} fn */
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  const load = async () => {
    check();
    const value = await getLocal(key);
    check();
    return value ?? { active: null, stopped: [] };
  };
  const save = async (value) => {
    check();
    await putLocal(key, value);
    check();
  };
  const read = async (path, input, { privateRead = false } = {}) => {
    if (privateRead) check();
    const connected = api.snapshot()?.subjectId === subjectId && !!subjectId;
    const result = await api.call(path, input, {
      authenticated: privateRead || connected,
    });
    if (privateRead || connected) check();
    return result;
  };
  /** @param {string} type @param {any} input @param {{visibility?:string,viewers?:string[],grantKind?:string}} options */
  async function prepare(
    type,
    input,
    { visibility = 'Private', viewers = [], grantKind } = {},
  ) {
    check();
    if((type==='configuration')!==(operationFamily==='configuration'))throw new Error('操作类别不匹配。');
    if(type.startsWith('qualification-')!==(operationFamily==='qualification'))throw new Error('操作类别不匹配。');
    if((type==='worker-pack')!==(operationFamily==='worker-pack'))throw new Error('操作类别不匹配。');
    const schema = {
      configuration:configurationEventV2Schema,
      'worker-pack':packUseEventSchema,
      'qualification-request':qualificationRequestEventSchema,
      'qualification-grant':qualificationCalculationSchema,
      publication: capsuleEventV2Schema,
      use: capsuleUseV2Schema,
      permission: capsulePermissionV2Schema,
    }[type];
    if (!schema) throw new Error('未知 Capsule 操作。');
    const payload = schema.parse(input),
      selected = [...new Set(viewers.filter((id) => id !== subjectId))];
    if (
      !['Private', 'Public'].includes(visibility) ||
      (visibility === 'Public' && selected.length)
    )
      throw new Error('请明确选择公开或选定人员可见。');
    const payloadJson = JSON.stringify(payload),
      op = {
        type,
        operationId: type==='qualification-request'?payload.eventId:['configuration','worker-pack'].includes(type)?payload.operationId:payload.id,
        grantKind: type==='qualification-grant'?(payload.kind==='revoke'?grantKind:payload.kind):null,
        payload,
        payloadJson,
        payloadHash: await sha256Hex(payloadJson),
        visibility,
        viewers: selected,
        path: {
          configuration:'/v2/configurations/events',
          'worker-pack':'/v2/builders/pack-uses/events',
          'qualification-request':'/v2/qualification/permission-requests/events',
          'qualification-grant':'/v2/qualification/calculation-permissions',
          publication: '/v2/capsules/events',
          use: '/v2/capsules/uses',
          permission: '/v2/capsules/permissions',
        }[type],
      };
    if(type==='qualification-grant'&&!['compute','source-permission'].includes(op.grantKind))throw new Error('请明确原许可用途。');
    if(operationFamily==='qualification'&&visibility!=='Private')throw new Error('资格请求与限定许可只允许私有受众。');
    const preview = structuredClone({ ...op, subjectId, endpoint });
    previews.set(preview, op);
    return preview;
  }
  async function receipt(op) {
    const raw = await read(
      op.type==='worker-pack'?'/v2/builders/pack-uses/receipt':op.type==='qualification-request'?'/v2/qualification/permission-requests/receipt':op.type==='qualification-grant'?'/v2/qualification/calculation-receipt':op.type==='configuration'?'/v2/configurations/receipt':'/v2/capsules/receipt',
      {
        ...(['configuration','worker-pack','qualification-request','qualification-grant'].includes(op.type)?{}:{type:op.type}),
        ...(op.type==='qualification-request'?{eventId:op.operationId}:{operationId:op.operationId}),
        payloadHash: op.payloadHash,
      },
      { privateRead: true },
    );
    const result=op.type==='qualification-request'?{...raw,operationId:raw.eventId}:raw;
    if (result.state === 'conflict')
      throw new Error('同一操作号对应其他内容，请保留记录核对。');
    if (
      !['acknowledged', 'absent'].includes(result.state) ||
      result.operationId !== op.operationId
    )
      throw new Error('操作回执不匹配。');
    return result;
  }
  async function clear(op) {
    const state = await load();
    if (state.active?.operationId === op.operationId) state.active = null;
    state.stopped = state.stopped.filter(
      (x) => x.operationId !== op.operationId,
    );
    await save(state);
  }
  async function send(op) {
    try {
      if (!op.submission) {
        if (!op.prepared) {
          op.prepared = await api.prepareAuthorization(op.payloadJson, {
            action: {
              configuration:'configuration.publish',
              'worker-pack':'builder.publish',
              'qualification-request':'qualification.request',
              'qualification-grant':op.grantKind==='compute'?'qualification.compute':'qualification.source-permission',
              publication: 'capsule.publish',
              use: 'capsule.use',
              permission: 'capsule.permission',
            }[op.type],
            objectId: op.operationId,
            visibility: op.visibility,
            viewers: op.viewers,
            confirmed: true,
          });
          await save({ ...(await load()), active: op });
        }
        const reconcile = op.authorizationAttempted === true;
        op.authorizationAttempted = true;
        await save({ ...(await load()), active: op });
        op.submission = await api.submitAuthorization(op.prepared, {
          confirmed: true,
          reconcile,
        });
        await save({ ...(await load()), active: op });
      }
      op.businessAttempted = true;
      await save({ ...(await load()), active: op });
      await read(op.path, op.submission, { privateRead: true });
      const recorded = await receipt(op);
      if (recorded.state !== 'acknowledged')
        throw new Error('写入尚未取得精确回执，请查询原操作。');
      await clear(op);
      return recorded;
    } catch (error) {
      throw Object.assign(error, {
        operationId: op.operationId,
        resultUnknown: error.outcome !== 'rejected',
      });
    }
  }
  async function reviewAuthorization(operationId){const op=(await load()).active;if(op?.operationId!==operationId)throw new Error('原操作不在待处理记录中。');
    const r=await receipt(op);if(r.state==='acknowledged'){await clear(op);return r;}
    if(!op.prepared)return{state:'retry-original',operationId};
    const a=await api.reconcileAuthorization(op.prepared);if(a.state!=='absent')return{state:'retry-original',operationId};
    const i=op.prepared.intent;if(i.bindingId===api.snapshot()?.bindingId&&i.issuedAt>=now()-300&&i.expiresAt>now())return{state:'retry-original',operationId};
    return{state:'reauthorization-required',operationId,consentId:i.id,payloadHash:op.payloadHash,payload:op.payload,visibility:i.visibility,viewers:i.viewers,expiresAt:now()+2591900};
  }
  return {
    prepare,
    reviewAuthorization:id=>serial(()=>reviewAuthorization(id)),
    reauthorize:(operationId,preview,{confirmed=false}={})=>serial(async()=>{
      if(!confirmed)throw new Error('请核对相同业务内容、受众及授权期限后确认。');const current=await reviewAuthorization(operationId);
      if(current.state==='acknowledged')return current;
      if(current.state!=='reauthorization-required'||current.consentId!==preview?.consentId||current.payloadHash!==preview?.payloadHash)throw new Error('原状态已变化，请重新预览。');
      const state=await load(),op=state.active,prior=op.prepared,i=prior.intent;
      const replacement=await api.prepareAuthorization(op.payloadJson,{action:i.action,objectId:i.objectId,visibility:i.visibility,viewers:i.viewers,expiresAt:preview.expiresAt,confirmed:true});
      op.authorizationHistory=[...(op.authorizationHistory??[]),{prepared:prior,submission:op.submission??null,reason:'business-and-consent-absent-user-confirmed'}];
      op.prepared=replacement;op.submission=null;op.authorizationAttempted=false;await save(state);return send(op);
    }),
    execute: (preview, { confirmed = false } = {}) =>
      serial(async () => {
        const op = previews.get(preview);
        if (!confirmed || !op)
          throw new Error('请先预览并确认本次操作。');
        const state = await load();
        if (state.active) throw new Error('请先查询或停止上次操作的本机重试。');
        previews.delete(preview);
        await save({ ...state, active: op });
        return send(op);
      }),
    pending: async () => {
      const state = await load();
      return [
        ...(state.active
          ? [
              {
                operationId: state.active.operationId,
                type: state.active.type,
                payload: state.active.payload,
                state: 'awaiting-receipt',
              },
            ]
          : []),
        ...state.stopped,
      ];
    },
    reconcile: (operationId) =>
      serial(async () => {
        const state = await load(),
          op =
            state.active?.operationId === operationId
              ? state.active
              : state.stopped.find((x) => x.operationId === operationId);
        if (!op) throw new Error('原操作不存在。');
        const result = await receipt(op);
        if (result.state === 'acknowledged') await clear(op);
        return result;
      }),
    retry: (operationId, { confirmed = false } = {}) =>
      serial(async () => {
        const op = (await load()).active;
        if (!confirmed || op?.operationId !== operationId)
          throw new Error('请确认重试原操作；已停止的操作不能重发。');
        const r = await receipt(op);
        if (r.state === 'acknowledged') {
          await clear(op);
          return r;
        }
        return send(op);
      }),
    stopLocalRetry: (operationId, { confirmed = false } = {}) =>
      serial(async () => {
        const state = await load(),
          op = state.active;
        if (!confirmed || op?.operationId !== operationId)
          throw new Error('请确认停止本机重试。');
        const result = await receipt(op);
        if (result.state === 'acknowledged') {
          await clear(op);
          return result;
        }
        state.active = null;
        state.stopped.push({
          operationId: op.operationId,
          type: op.type,
          payloadHash: op.payloadHash,
          state: 'stopped-local',
        });
        await save(state);
        return { state: 'stopped-local', serverCancellationConfirmed: false };
      }),
    get: (input) => read('/v2/capsules/read', input),
    query: (input) => read('/v2/capsules/query', input),
    versions: (input) => read('/v2/capsules/versions', input),
    uses: (input) => read('/v2/capsules/uses/query', input),
    permissions: (input) =>
      read('/v2/capsules/permissions/query', input, { privateRead: true }),
    preview: (payload) =>
      read('/v2/capsules/preview', { payload }, { privateRead: true }),
    history: ({ after } = {}) =>
      read(
        '/v2/history/query',
        {
          subjectId,
          timeWindow: { kind: 'all-visible' },
          limit: 20,
          ...(after ? { after } : {}),
        },
        { privateRead: true },
      ),
    loadDraft: async () => {
      check();
      const d = await getLocal(`${operationFamily}-draft:${endpoint}:${subjectId}`);
      check();
      return d ?? null;
    },
    saveDraft: async (draft) => {
      check();
      await putLocal(
        `${operationFamily}-draft:${endpoint}:${subjectId}`,
        structuredClone(draft),
      );
      check();
    },
  };
}
