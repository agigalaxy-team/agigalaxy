import {
  capsuleEventV2Schema,
  capsuleUseV2Schema,
  capsulePermissionV2Schema,
} from '../../galaxy-official/src/shared/capsule-v2-schema.mjs';
import { equalJson, sha256Hex } from '../../galaxy-official/src/shared/web-primitives.mjs';
import {configurationEventV2Schema} from '../../galaxy-official/src/shared/configuration-v2-schema.mjs';
import {qualificationRequestEventSchema} from '../../galaxy-official/src/shared/qualification-requests-v2-schema.mjs';
import {qualificationCalculationSchema} from '../../galaxy-official/src/shared/qualification-calculation-schema.mjs';
import {packUseEventSchema} from '../../galaxy-official/src/shared/worker-pack-uses-v2-schema.mjs';

export function capsuleDeviceHasScope(api,scope='capsules'){
  const scopes=api.snapshot()?.scopes??[];
  return scopes.includes(scope)||scopes.includes('*');
}
const capsuleReadScope=path=>path.startsWith('/v2/capsules/')?'capsules':path.startsWith('/v2/cases/')?'case-teaser':path.startsWith('/v2/verification-records/')?'evidence':'history';
const scopeLabels={capsules:'Capsule（capsules）','case-teaser':'工作事实（case-teaser）',evidence:'检查记录（evidence）',history:'工作记录（history）'};

export const capsuleRefKey = (ref) =>
  `${ref.kind ?? ref.type}:${ref.id}:${ref.version}`;
/**
 * @template {{id:string,version:number,supersededInVisibleHistory?:boolean}} T
 * @param {T[]} [items]
 * @returns {T[]}
 */
export function currentCapsuleFacts(items = []) {
  const byId = new Map();
  for (const item of items)
    if (!byId.has(item.id) || byId.get(item.id).version < item.version)
      byId.set(item.id, item);
  return [...byId.values()].filter((item) => !item.supersededInVisibleHistory);
}
/**
 * @param {import('./capsule-authoring-types').CapsuleCaseHistory} history
 * @returns {import('./capsule-authoring-types').CapsuleSourceItem[]}
 */
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
/** @param {{api:any,getLocal:(key:string)=>any,putLocal:(key:string,value:any)=>any,
 * updateLocal?:((key:string,change:(value:any)=>any)=>any)|null,subjectId:string|null,
 * operationFamily?:string,now?:()=>number}} options */
export function createCapsuleWebClient({ api, getLocal, putLocal, updateLocal=null, subjectId, operationFamily='capsule',now=()=>Math.floor(Date.now()/1000) }) {
  if(!['capsule','configuration','qualification','worker-pack'].includes(operationFamily))throw new Error('未知操作类别。');
  const endpoint = api.endpoint,
    key = `${operationFamily}-operations:${endpoint}:${subjectId}`,
    previews = new WeakMap(), authorizationReviews = new WeakMap();
  let queue = Promise.resolve(), activeLease = null;
  const requireScope=scope=>{if(operationFamily==='capsule'&&!capsuleDeviceHasScope(api,scope))throw Object.assign(new Error(`当前浏览器设备未获准使用${scopeLabels[scope]??scope}。请在已有 Agent 的本机审阅页核对并明确批准所需权限；原任务连接和本机草稿仍保留。`),{code:'capsule_device_scope_required',scope,outcome:'rejected'});};
  const capture = () => { const s=api.snapshot();return s?JSON.stringify([api.endpoint,s.subjectId,s.bindingId,s.generation,s.control?.deviceId,s.control?.epoch]):null; };
  const check = (lease = activeLease) => {
    if (
      api.endpoint !== endpoint ||
      !subjectId ||
      api.snapshot()?.subjectId !== subjectId ||
      lease !== null && lease !== capture() ||
      activeLease !== null && activeLease !== capture()
    )
      throw new Error('身份或连接已改变，请重新打开当前内容。');
  };
  /** @param {() => Promise<any>} fn */
  const serial = (fn) => {
    const requested=capture();
    const invoke=async()=>{check(requested);activeLease=requested;try{return await fn();}finally{activeLease=null;}};
    const run = queue.then(invoke, invoke);
    queue = run.catch(() => {});
    return run;
  };
  const load = async () => {
    const lease=capture();check(lease);
    const value = await getLocal(key);
    check(lease);
    return value ?? { active: null, stopped: [] };
  };
  const update = async (change) => {
    const lease=capture();check(lease);
    const apply = current => {check(lease);return change(current ?? {active:null,stopped:[]});};
    const next = typeof updateLocal === 'function' ? await updateLocal(key,apply)
      : apply(await load());
    if(typeof updateLocal !== 'function') {check(lease);await putLocal(key,next);}
    check(lease);
    return next;
  };
  const changed = () => Object.assign(new Error('原操作已停止或已变化，请重新读取原记录。'),{code:'capsule_operation_changed'});
  const same = (a,b) => a?.operationId===b?.operationId && a?.payloadHash===b?.payloadHash && a?.type===b?.type;
  const replaceActive = async (previous,next) => {
    const expected=JSON.stringify(previous),state=await update(current=>{
      if(!same(current.active,previous)||JSON.stringify(current.active)!==expected)throw changed();
      return {...current,active:structuredClone(next)};
    });
    return state.active;
  };
  const patchActive = (previous,patch) => replaceActive(previous,{...previous,...patch});
  const read = async (path, input, { privateRead = false } = {}) => {
    const lease=capture();
    if (privateRead) {check(lease);requireScope(capsuleReadScope(path));}
    const connected = api.snapshot()?.subjectId === subjectId && !!subjectId;
    const authorized = connected && (operationFamily!=='capsule'||capsuleDeviceHasScope(api,capsuleReadScope(path)));
    const result = await api.call(path, input, {
      authenticated: privateRead || authorized,
    });
    if (privateRead || connected) check(lease);
    return result;
  };
  /** @param {string} type @param {any} input @param {{visibility?:string,viewers?:string[],grantKind?:string}} options */
  async function prepare(
    type,
    input,
    { visibility = 'Private', viewers = [], grantKind } = {},
  ) {
    const lease=capture();check(lease);requireScope('capsules');
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
    check(lease);
    const preview = structuredClone({ ...op, subjectId, endpoint });
    previews.set(preview, {op,lease,exact:JSON.stringify(preview)});
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
  async function receiptFor({operationId,payloadHash,type} = {}) {
    const selected = {configuration:'configuration','worker-pack':'worker-pack'}[operationFamily] ?? type;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId ?? '')
      || !/^[a-f0-9]{64}$/.test(payloadHash ?? '')
      || !['configuration','worker-pack','qualification-request','qualification-grant','publication','use','permission'].includes(selected)
      || (selected==='configuration')!==(operationFamily==='configuration')
      || (selected==='worker-pack')!==(operationFamily==='worker-pack')
      || selected.startsWith('qualification-')!==(operationFamily==='qualification'))
      throw new Error('原操作定位不属于当前类别。');
    const result = await receipt({type:selected,operationId,payloadHash});
    if (result.payloadHash !== undefined && result.payloadHash !== payloadHash)
      throw new Error('操作回执不匹配。');
    return result;
  }
  async function reviewPending(operationId) {
    const state = await load(), op = state.active?.operationId===operationId
      ? state.active : state.stopped.find(item=>item.operationId===operationId);
    if (!op) throw new Error('原操作不存在。');
    if (!op.payloadJson) return structuredClone({...op,endpoint,subjectId,
      localRetryStopped:true,canContinue:false});
    const {expiresAt} = await original(op);
    return structuredClone({operationId:op.operationId,type:op.type,endpoint,subjectId,
      payload:op.payload,payloadJson:op.payloadJson,payloadHash:op.payloadHash,
      visibility:op.visibility,viewers:op.viewers,expiresAt:expiresAt??null,
      originalBindingId:op.prepared?.intent?.bindingId??op.authorizationBindingId??null,
      state:op.automaticRetryBlock?'business-rejected':'awaiting-receipt',
      ...(op.automaticRetryBlock?{reason:'business-rejected',rejection:op.automaticRetryBlock}:{}),
      localRetryStopped:false,canContinue:true});
  }
  async function clear(op) {
    await update(state=>({...state,active:same(state.active,op)?null:state.active,
      stopped:state.stopped.filter(x=>!same(x,op))}));
  }
  const definiteRejection = error => error?.outcome==='rejected' && Number.isInteger(error.status)
    && error.status>=400 && error.status<500 && ![401,408,429].includes(error.status)
    && !['unauthorized','binding_revoked','invalid_session','session_expired','access_denied'].includes(error.code);
  async function send(op,{explicitRetry=false}={}) {
    let dispatching=false;
    try {
      requireScope('capsules');
      // Another page may have learned a definite rejection or stopped the same
      // operation after this page read it. Claim the exact persisted head before
      // preparing, signing or sending anything.
      const current=(await load()).active;
      if(!same(current,op)||JSON.stringify(current)!==JSON.stringify(op))throw changed();
      if(current.automaticRetryBlock&&!explicitRetry)return {state:'absent',operationId:op.operationId,
        reason:'business-rejected',rejection:structuredClone(current.automaticRetryBlock)};
      if (!op.submission) {
        if (!op.prepared) {
          const prepared = await api.prepareAuthorization(op.payloadJson, {
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
            ...(op.authorizationExpiresAt?{expiresAt:op.authorizationExpiresAt}:{}),
            confirmed: true,
          });
          check();
          op = await patchActive(op,{prepared});
        }
        const reconcile = op.authorizationAttempted === true;
        op = await patchActive(op,{authorizationAttempted:true});
        const submission = await api.submitAuthorization(op.prepared, {
          confirmed: true,
          reconcile,
        });
        check();
        op = await patchActive(op,{submission});
      }
      const next={...op,businessAttempted:true};delete next.automaticRetryBlock;
      op = await replaceActive(op,next);dispatching=true;
      await read(op.path, op.submission, { privateRead: true });
      const recorded = await receipt(op);
      if (recorded.state !== 'acknowledged')
        throw new Error('写入尚未取得精确回执，请查询原操作。');
      await clear(op);
      return recorded;
    } catch (error) {
      if(dispatching&&definiteRejection(error)) {
        try {await patchActive(op,{automaticRetryBlock:{code:error.code,status:error.status,rejectedAt:now()},state:'business-rejected'});}
        catch(persistError) {if(persistError.code!=='capsule_operation_changed')throw persistError;}
      }
      throw Object.assign(error, {
        operationId: op.operationId,
        resultUnknown: error.outcome !== 'rejected',
      });
    }
  }
  async function reviewAuthorization(operationId){const op=(await load()).active;if(op?.operationId!==operationId)throw new Error('原操作不在待处理记录中。');
    const r=await receipt(op);if(r.state==='acknowledged'){await clear(op);return r;}
    const {expiresAt}=await original(op),fresh=()=>{
      const preview=structuredClone({state:'reauthorization-required',operationId,consentId:op.prepared?.intent?.id??null,
        payloadJson:op.payloadJson,payloadHash:op.payloadHash,payload:op.payload,visibility:op.visibility,viewers:op.viewers,
        originalExpiresAt:expiresAt??null,originalBindingId:op.prepared?.intent?.bindingId??op.authorizationBindingId??null,
        expiresAt:Number.isSafeInteger(expiresAt)&&expiresAt>now()&&expiresAt<=now()+2592000?expiresAt:now()+2591900});
      authorizationReviews.set(preview,{lease:capture(),exact:JSON.stringify(preview),operation:JSON.stringify(op)});
      return preview;
    };
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=now()||expiresAt>now()+2592000)return fresh();
    if(!op.prepared)return op.authorizationBindingId&&op.authorizationBindingId===api.snapshot()?.bindingId?{state:'retry-original',operationId}:fresh();
    let a;try{a=await api.reconcileAuthorization(op.prepared);check();}
    catch(error){check();if(error.code==='consent_receipt_not_active_or_mismatched')return fresh();throw error;}
    if(a.state==='acknowledged')return{state:'retry-original',operationId};
    const i=op.prepared.intent;if(i.bindingId===api.snapshot()?.bindingId&&i.expiresAt>now())return{state:'retry-original',operationId};
    return fresh();
  }
  async function original(op){
    const schema={configuration:configurationEventV2Schema,'worker-pack':packUseEventSchema,
      'qualification-request':qualificationRequestEventSchema,'qualification-grant':qualificationCalculationSchema,
      publication:capsuleEventV2Schema,use:capsuleUseV2Schema,permission:capsulePermissionV2Schema}[op?.type];
    const path={configuration:'/v2/configurations/events','worker-pack':'/v2/builders/pack-uses/events',
      'qualification-request':'/v2/qualification/permission-requests/events','qualification-grant':'/v2/qualification/calculation-permissions',
      publication:'/v2/capsules/events',use:'/v2/capsules/uses',permission:'/v2/capsules/permissions'}[op?.type];
    const action={configuration:'configuration.publish','worker-pack':'builder.publish','qualification-request':'qualification.request',
      'qualification-grant':op?.grantKind==='compute'?'qualification.compute':'qualification.source-permission',
      publication:'capsule.publish',use:'capsule.use',permission:'capsule.permission'}[op?.type];
    const invalid=()=>{throw Object.assign(new Error('原内容、范围或授权不匹配，请保留这次操作。'),{code:'capsule_operation_invalid'});};
    let payload;try{payload=schema.parse(JSON.parse(op.payloadJson));}catch{invalid();}
    const id=op.type==='qualification-request'?payload.eventId:['configuration','worker-pack'].includes(op.type)?payload.operationId:payload.id;
    if(op.path!==path||op.operationId!==id||!equalJson(payload,op.payload)||await sha256Hex(op.payloadJson)!==op.payloadHash
      ||!['Private','Public'].includes(op.visibility)||!Array.isArray(op.viewers)||new Set(op.viewers).size!==op.viewers.length
      ||op.visibility==='Public'&&op.viewers.length||(op.type==='configuration')!==(operationFamily==='configuration')
      ||op.type.startsWith('qualification-')!==(operationFamily==='qualification')||(op.type==='worker-pack')!==(operationFamily==='worker-pack'))invalid();
    check();
    const expiresAt=op.authorizationExpiresAt??op.prepared?.intent?.expiresAt;
    if(op.prepared){const p=op.prepared,i=p.intent;
      if(p.payloadJson!==op.payloadJson||!i||i.subjectId!==subjectId||i.endpoint!==endpoint||i.recipient!==endpoint
        ||i.action!==action||i.objectId!==op.operationId||i.payloadHash!==op.payloadHash||i.visibility!==op.visibility
        ||i.purpose!==(op.visibility==='Public'?'public-profile':'operational')||!equalJson(i.fields,Object.keys(payload))
        ||!equalJson(i.viewers,op.viewers)||i.expiresAt!==expiresAt)invalid();
      if(op.submission&&(op.submission.consentId!==i.id||op.submission.payloadJson!==op.payloadJson))invalid();
    }else if(op.submission)invalid();
    return{expiresAt,invalid,action};
  }
  async function resumeActive(op,{explicitRetry=false}={}){
    const {expiresAt,invalid}=await original(op),result=await receipt(op);
    if(result.payloadHash!==undefined&&result.payloadHash!==op.payloadHash)invalid();
    if(result.state==='acknowledged'){await clear(op);return result;}
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=now())return{...result,reason:'authorization-expired'};
    // Older callers supplied milliseconds. Preserve that original record for
    // review; an impossible Consent deadline cannot be repaired by a retry.
    if(expiresAt>now()+2592000)return{...result,reason:'authorization-deadline-invalid'};
    if(op.automaticRetryBlock&&!explicitRetry)return{...result,reason:'business-rejected',rejection:structuredClone(op.automaticRetryBlock)};
    const next={...op,authorizationExpiresAt:expiresAt};
    if(op.prepared){let accepted;
      try{accepted=await api.reconcileAuthorization(op.prepared);check();}
      catch(error){check();if(error.code==='consent_receipt_not_active_or_mismatched')return{...result,reason:'original-authorization-unavailable'};throw error;}
      if(accepted.state==='acknowledged')next.submission={consentId:accepted.consentId,payloadJson:accepted.payloadJson};
      else if(accepted.state!=='absent')invalid();
      else {
        if(op.prepared.intent.bindingId!==api.snapshot()?.bindingId)return{...result,reason:'original-binding-changed'};
        next.submission=null;
        if(op.prepared.intent.issuedAt<now()-300){
          next.authorizationHistory=[...(op.authorizationHistory??[]),{prepared:op.prepared,submission:op.submission??null,reason:'same-binding-signature-renewal'}];
          next.authorizationBindingId=op.prepared.intent.bindingId;
          delete next.prepared;delete next.authorizationAttempted;
        }
      }
    }
    if(!next.prepared&&(!next.authorizationBindingId||next.authorizationBindingId!==api.snapshot()?.bindingId))
      return{...result,reason:next.authorizationBindingId?'original-binding-changed':'original-binding-unavailable'};
    op=await replaceActive(op,next);return send(op,{explicitRetry});
  }
  /** @param {{explicitRetry?:boolean}} [options] */
  const resumePending=({explicitRetry=false}={})=>serial(async()=>{
    const state=await load(),stopped=[];
    for(const old of state.stopped){const result=await receipt(old);if(result.payloadHash!==undefined&&result.payloadHash!==old.payloadHash)throw Error('操作回执不匹配。');
      if(result.state==='acknowledged')await clear(old);stopped.push({...result,localRetryStopped:true});}
    const op=(await load()).active;if(!op)return{state:'none',stopped};
    return{...await resumeActive(op,{explicitRetry}),stopped};
  });
  const previewPublication = (payload,{visibility='Public'}={}) =>
    read('/v2/capsules/preview',{payload,visibility},{privateRead:true});
  async function allPermissions({view='granted'}={}){
    const items=new Map(),cursors=new Set();let after;
    do{
      const page=await read('/v2/capsules/permissions/query',{view,limit:50,...(after?{after}:{})},{privateRead:true});
      for(const item of page.items)items.set(item.permissionId,item);
      after=page.nextAfter;
      if(after&&cursors.has(after))throw Error('来源许可游标没有继续前进。');
      if(after)cursors.add(after);
    }while(after);
    return{items:[...items.values()],nextAfter:null,coverage:'currently-authorized-explicit-permissions'};
  }
  /** @param {any} input @param {{visibility?:string}} [options] */
  async function resolvePublication(input,{visibility='Public'}={}){
    if(operationFamily!=='capsule')throw Error('操作类别不匹配。');
    const payload=capsuleEventV2Schema.parse(input);
    if(payload.kind!=='version')throw Error('仅方法版本需要匹配准确来源许可。');
    const catalog=(await allPermissions()).items;
    const eligible=item=>item.payload?.kind==='grant'&&!item.revoked&&!item.expired&&item.sourceStatus==='current'
      &&item.payload.grantees.includes(subjectId)&&item.payload.license===payload.license
      &&(visibility!=='Public'||item.payload.allowPublic)
      &&(!item.payload.expiresAt||Date.parse(item.payload.expiresAt)>now()*1000);
    const candidates=catalog.filter(eligible),ids=new Set(candidates.map(item=>item.permissionId));
    const unavailable=new Set(payload.permissionRefs.filter(id=>!ids.has(id)));
    const base={...payload,permissionRefs:[]};
    const initial=await previewPublication(base,{visibility});
    if(!initial.sourceCoverage)return{payload,preview:initial,permissionRefs:payload.permissionRefs,permissions:initial.permissions??[],
      unavailablePermissionIds:[...unavailable]};
    const key=dependency=>`${dependency.key}:${dependency.authorId}`,
      needed=new Set(initial.sourceCoverage.dependencies.filter(item=>!item.covered).map(key)),selected=[];
    // Selected existing licenses are preferred. The service, rather than the
    // browser, resolves upstream Case/record dependencies and current coverage.
    candidates.sort((a,b)=>Number(payload.permissionRefs.includes(b.permissionId))-Number(payload.permissionRefs.includes(a.permissionId)));
    for(const candidate of candidates){
      if(!needed.size||selected.length===64)break;
      const checked=await previewPublication({...base,permissionRefs:[candidate.permissionId]},{visibility});
      if(!checked.sourceCoverage){unavailable.add(candidate.permissionId);continue;}
      const covered=checked.sourceCoverage.dependencies.filter(item=>item.covered&&item.permissionIds.includes(candidate.permissionId)&&needed.has(key(item)));
      if(covered.length){selected.push(candidate.permissionId);for(const item of covered)needed.delete(key(item));}
    }
    const resolved={...payload,permissionRefs:selected};
    const preview=await previewPublication(resolved,{visibility});
    return{payload:resolved,preview,permissionRefs:selected,permissions:preview.permissions??[],unavailablePermissionIds:[...unavailable]};
  }
  return {
    prepare,
    reviewPending:id=>serial(()=>reviewPending(id)),
    receiptFor:locator=>serial(()=>receiptFor(locator)),
    resumePending,
    reviewAuthorization:id=>serial(()=>reviewAuthorization(id)),
    reauthorize:(operationId,preview,{confirmed=false}={})=>serial(async()=>{
      requireScope('capsules');
      const reviewed=authorizationReviews.get(preview);
      if(!confirmed||!reviewed||reviewed.exact!==JSON.stringify(preview))throw new Error('请核对相同业务内容、受众及授权期限后确认。');
      check(reviewed.lease);
      const selected=(await load()).active;
      if(selected?.operationId!==operationId||reviewed.operation!==JSON.stringify(selected))throw new Error('原状态已变化，请重新预览。');
      const current=await reviewAuthorization(operationId);
      if(current.state==='acknowledged')return current;
      if(current.state!=='reauthorization-required'||!Number.isSafeInteger(preview.expiresAt)||preview.expiresAt<=now()
        ||JSON.stringify({...current,expiresAt:preview.expiresAt})!==reviewed.exact)throw new Error('原状态已变化，请重新预览。');
      const state=await load(),op=state.active,prior=op.prepared,{action}=await original(op),
        i=prior?.intent??{action,objectId:op.operationId,visibility:op.visibility,viewers:op.viewers};
      const replacement=await api.prepareAuthorization(op.payloadJson,{action:i.action,objectId:i.objectId,visibility:i.visibility,viewers:i.viewers,expiresAt:preview.expiresAt,confirmed:true});
      check();
      authorizationReviews.delete(preview);
      const next={...op,authorizationHistory:[...(op.authorizationHistory??[]),{prepared:prior??null,submission:op.submission??null,reason:'business-and-consent-absent-user-confirmed'}],
        prepared:replacement,authorizationBindingId:replacement.intent.bindingId,authorizationExpiresAt:preview.expiresAt,submission:null,authorizationAttempted:false};
      return send(await replaceActive(op,next),{explicitRetry:true});
    }),
    /** @param {any} preview @param {{confirmed?:boolean,onJournal?:(locator:any)=>Promise<void>|void}} options */
    execute: (preview, { confirmed = false, onJournal } = {}) =>
      serial(async () => {
        const prepared = previews.get(preview),op=prepared?.op;
        if (!confirmed || !op || prepared.exact!==JSON.stringify(preview))
          throw new Error('请先预览并确认本次操作。');
        check(prepared.lease);
        requireScope('capsules');
        const declaredExpiry=typeof op.payload.expiresAt==='string'?Math.floor(Date.parse(op.payload.expiresAt)/1000):op.payload.expiresAt;
        op.authorizationExpiresAt=Math.min(now()+2591900,Number.isSafeInteger(declaredExpiry)?declaredExpiry:Infinity);
        op.authorizationBindingId=api.snapshot()?.bindingId;
        await update(state=>{if(state.active)throw new Error('请先读取或停止上次操作的本机重试。');return{...state,active:op};});
        previews.delete(preview);
        if(onJournal){await onJournal(Object.freeze({operationId:op.operationId,payloadHash:op.payloadHash,
          type:op.type,endpoint,subjectId}));check(prepared.lease);}
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
                payloadHash:state.active.payloadHash,
                state: state.active.automaticRetryBlock?'business-rejected':'awaiting-receipt',
                ...(state.active.automaticRetryBlock?{reason:'business-rejected'}:{}),
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
        return resumeActive(op,{explicitRetry:true});
      }),
    stopLocalRetry: (operationId, { confirmed = false } = {}) =>
      serial(async () => {
        const state = await load(),
          op = state.active;
        if (!confirmed || op?.operationId !== operationId)
          throw new Error('请确认停止本机重试。');
        const result = operationFamily==='capsule'&&!capsuleDeviceHasScope(api)?{state:'scope-unavailable'}:await receipt(op);
        if (result.state === 'acknowledged') {
          await clear(op);
          return result;
        }
        const locator={
          operationId: op.operationId,
          type: op.type,
          payloadHash: op.payloadHash,
          state: 'stopped-local',
        };
        await update(current=>{if(!same(current.active,op))throw changed();return{...current,active:null,
          stopped:[...current.stopped.filter(item=>!same(item,op)),locator]};});
        return { state: 'stopped-local', serverCancellationConfirmed: false };
      }),
    get: (input) => read('/v2/capsules/read', input),
    configuration: (input) => read('/v2/configurations/read',input,{privateRead:true}),
    /** @param {{caseId:string,taskId?:string}} input */
    caseFacts: ({caseId,taskId}) => read('/v2/cases/'+caseId+'/read',taskId?{taskId}:{},{privateRead:true}),
    verification: ref => read('/v2/verification-records/read',{type:'verification',...ref},{privateRead:true}),
    useRecord: ({eventId,...input}) => serial(async()=>{let after;const cursors=new Set();do{const page=await read('/v2/capsules/uses/query',{...input,limit:20,...(after?{after}:{})},{privateRead:true});const found=page.items.find(item=>item.eventId===eventId);if(found)return found;after=page.nextAfter;if(after&&cursors.has(after))throw Error('应用记录游标没有继续前进。');cursors.add(after);}while(after);throw Error('原应用当前不可读取，请刷新后核对。');}),
    query: (input) => read('/v2/capsules/query', input),
    versions: (input) => read('/v2/capsules/versions', input),
    uses: (input) => read('/v2/capsules/uses/query', input),
    permissions: (input) =>
      read('/v2/capsules/permissions/query', input, { privateRead: true }),
    permission: permissionId=>read('/v2/capsules/permissions/read',{permissionId},{privateRead:true}),
    allPermissions:options=>serial(()=>allPermissions(options)),
    resolvePublication:(payload,options)=>serial(()=>resolvePublication(payload,options)),
    preview: previewPublication,
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
      const lease=capture();check(lease);
      const d = await getLocal(`${operationFamily}-draft:${endpoint}:${subjectId}`);
      check(lease);
      return d ?? null;
    },
    saveDraft: async (draft) => {
      const lease=capture();check(lease);
      await putLocal(
        `${operationFamily}-draft:${endpoint}:${subjectId}`,
        structuredClone(draft),
      );
      check(lease);
    },
  };
}
