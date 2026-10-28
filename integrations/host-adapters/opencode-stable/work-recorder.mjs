import {createLegacyHistory} from './bridge/legacy-local.mjs';
import {createOpenCodeWorkSummarizer} from './work-summarizer.mjs';
import {nativeDiagnostics} from '../../../packages/galaxy-edge-mcp/src/native-v2/diagnostics.mjs';

const asTime = value => Number.isFinite(value) && value >= 0 ? new Date(value).toISOString() : undefined;
const modelName = model => model && typeof model.providerID === 'string' && typeof (model.modelID ?? model.id) === 'string'
  ? `${model.providerID}/${model.modelID ?? model.id}` : undefined;
const promptModel = model => modelName(model)?{providerID:model.providerID,modelID:model.modelID??model.id}:undefined;
const short = (value, length = 1200) => typeof value === 'string' ? value.slice(0, length) : '';
const content = text => ({excerpt: short(text), originalLength: typeof text === 'string' ? text.length : 0,
  retained: text ? 'excerpt' : 'none', availableFromHost: true});

/** @typedef {string | {id?: string, subjectId?: string, createdAt?: string} | null | undefined} WorkRecorderIdentity */

/** Uses the public TuiPluginApi event bus and state. It observes the current
 * foreground session only, never enumerates other host sessions or creates a
 * background reader/model. State reconciliation also covers reconnect/restart.
 * @param {*} api
 * @param {{dataDirectory?: string, getIdentity?: (directory: string) => WorkRecorderIdentity | Promise<WorkRecorderIdentity>, history?: Pick<ReturnType<typeof import('../../../packages/galaxy-core/src/work-history/index.mjs').createLocalWorkHistory>, 'identity'|'beginCapture'|'observeEnvironment'|'observe'|'list'|'get'|'pending'|'setSummaryState'|'submitSummary'>, archive?: Pick<ReturnType<typeof import('../../../packages/galaxy-core/src/conversation-archive/index.mjs').createLocalConversationArchive>, 'settings'|'captureMessage'|'configure'>, onSessionComplete?: (input: {galaxyId: string, host: string, sessionId: string}) => unknown | Promise<unknown>, pollMs?: number}} [options]
 */
export function createOpenCodeWorkRecorder(api, {dataDirectory, getIdentity, history = createLegacyHistory({dataDirectory, getIdentity}), archive, onSessionComplete, pollMs = 2000} = {}) {
  const diagnostics=nativeDiagnostics('host-client');
  diagnostics.emit({event:'host_recording',stage:'recording',outcome:'started',host:'opencode'});
  let accepting = true, closing, chain = Promise.resolve(), active = null, errorCode = null, selectedModel, actualModel;
  let environmentKey = '', lastSession = '', lastOwner = '';
  let selectedModelKey = '', actualModelKey = '', selectedModelSpec;
  let archiveSelectionKey = '', archiveBackfillState = null;
  const archiveJobs = new Map(), archiveControllers = new Set();
  const archiveSyncJobs = new Map(), archiveSyncRequests = new Map(), completedMessages = new Set();
  let archiveSyncState = null;
  const activatedAt=Date.now();
  const messages = new Map(), parts = new Map(), seen = new Map(), disposers = [];
  const summarizer = createOpenCodeWorkSummarizer(api, history);
  const currentSession = () => api.route?.current?.name === 'session' ? api.route.current.params?.sessionID : null;
  function report(error) {
    const code = typeof error?.code === 'string' ? error.code : 'local_work_recording_unavailable';
    if (errorCode !== code) {
      diagnostics.emit({event:'host_recording',stage:'recording',outcome:'failed',host:'opencode',error});
      api.ui?.toast?.({variant: 'warning', title: '银河 · 本地记录', message: '本地工作记录暂未保存，已有资料保留。可在本地工作履历查看状态。'});
    }
    errorCode = code;
  }
  function enqueue(operation) {
    if (!accepting) return chain;
    chain = chain.then(operation).catch(report);
    return chain;
  }
  function environment() {
    const servers = api.state?.mcp?.() || [];
    return {host: 'opencode', hostVersion: api.app?.version, platform: process.platform, architecture: process.arch,
      runtime: process.versions.bun ? 'bun' : 'node', runtimeVersion: process.versions.bun || process.versions.node,
      selectedModel: selectedModel || (typeof api.state?.config?.model === 'string' ? api.state.config.model : undefined),
      configuredModel:typeof api.state?.config?.model === 'string'?api.state.config.model:undefined,
      actualModel,
      tools: servers.map(server => `mcp:${server.name}:${server.status}`)};
  }
  const messageKey = info => `${String(info.time?.completed ?? info.time?.created ?? 0).padStart(16,'0')}:${info.id}`;
  function observeMessageModel(info) {
    if(!inWindow(info))return;
    const key=messageKey(info);
    if(info.role==='assistant'&&modelName(info)&&key>actualModelKey){actualModel=modelName(info);actualModelKey=key;}
    if(info.role==='user'&&modelName(info.model)&&key>selectedModelKey){selectedModel=modelName(info.model);selectedModelSpec=promptModel(info.model);selectedModelKey=key;}
  }
  async function saveEnvironment() {
    const facts = environment(), encoded = JSON.stringify(facts);
    if (active && encoded !== environmentKey) {
      await history.observeEnvironment({galaxyId: active.galaxyId, host: 'opencode', sessionId:active.sessionId, facts});
      environmentKey = encoded;
    }
  }
  async function ensureSession(sessionId) {
    if (!sessionId || sessionId !== currentSession()) return false;
    const owner = await history.identity();
    if (!owner) {active = null; errorCode = null; return false;}
    if (!active || active.galaxyId !== owner.id || active.sessionId !== sessionId) {
      const since=lastOwner&&lastOwner!==owner.id?Date.now():Math.max(activatedAt,Date.parse(owner.createdAt)||0);
      const capture = await history.beginCapture({galaxyId: owner.id, host: 'opencode', sessionId,observedAt:new Date(since).toISOString()});
      active = {...capture, since: Date.parse(capture.startedAt)};
      messages.clear(); parts.clear(); seen.clear(); environmentKey = '';
      selectedModel = undefined; actualModel = undefined; selectedModelSpec=undefined;selectedModelKey = ''; actualModelKey = '';
      lastSession = sessionId; lastOwner = owner.id;
      for(const info of api.state?.session?.messages?.(sessionId)||[])observeMessageModel(info);
    }
    await saveEnvironment();
    const session=api.state?.session?.get?.(sessionId);
    if(session?.id===sessionId&&session.title)await save({sourceId:'session-title',revision:Number.isFinite(session.time?.updated)?session.time.updated:undefined,kind:'session',title:short(session.title,180),source:{kind:'host-event'},details:{event:'session-title',title:short(session.title,180)}});
    await synchronizeArchiveSelection().catch(error => {
      if(archiveBackfillState?.reason!=='local_archive_selection_unavailable')diagnostics.emit({event:'host_archive',stage:'archive-backfill',outcome:'failed',host:'opencode',error});
      archiveBackfillState={state:'unavailable',reason:'local_archive_selection_unavailable'};
    });
    return true;
  }
  function backfillArchive({galaxyId, host = 'opencode', sessionId}) {
    const key = JSON.stringify([galaxyId, host, sessionId]);
    if (archiveJobs.has(key)) return archiveJobs.get(key);
    const task = diagnostics.run('archive-backfill',async () => {
      if (!accepting || !archive || host !== 'opencode') return {state:'unavailable',reason:'host_archive_unavailable'};
      const settings = await archive.settings();
      if (settings.galaxyId !== galaxyId) return {state:'cancelled',reason:'local_identity_changed'};
      if (!settings.settings.enabled || !settings.settings.sessions.some(item => item.host === host && item.sessionId === sessionId))
        return {state:'cancelled',reason:'not-selected'};
      if (!api.client?.session?.messages) return {state:'unavailable',reason:'host_messages_unavailable'};
      const controller = new AbortController(); archiveControllers.add(controller);
      const deadline = setTimeout(() => controller.abort(), 120000); deadline.unref?.();
      archiveBackfillState = {state:'reading-selected-session',host,sessionId};
      try {
        // This endpoint reads only the explicitly selected session. No session
        // search, attachment fetch, excerpt substitution or model is involved.
        const response = await api.client.session.messages({sessionID:sessionId},{signal:controller.signal});
        if (response?.error || !Array.isArray(response?.data)) throw Error('host_messages_unavailable');
        let copied = 0;
        for (const item of response.data) {
          if (!accepting || controller.signal.aborted) return {state:'cancelled',reason:'host_archive_interrupted',copied};
          if (item?.info?.sessionID !== sessionId || !item.info.id || !Array.isArray(item.parts)) continue;
          const hostSession=api.state?.session?.get?.(sessionId),workspaceId=hostSession?.workspaceID??hostSession?.directory;
          const captured = await archive.captureMessage({galaxyId,host,sessionId,messageId:item.info.id,message:item.info,parts:item.parts,...(workspaceId?{workspaceId}:{})});
          if (!captured.captured) return {state:'cancelled',reason:captured.reason,copied};
          copied++;
        }
        notifyArchiveReady(galaxyId,sessionId);
        return {state:'copied',host,sessionId,copied,coverage:'host-returned-messages',hostCompleteness:'not-guaranteed',attachmentsRead:false};
      } finally {clearTimeout(deadline);archiveControllers.delete(controller);}
    },{event:'host_archive',host:'opencode',independent:true,resultOutcome:value=>value?.state==='cancelled'?'cancelled':value?.state==='unavailable'?'deferred':'succeeded'}).catch(() => ({state:'unavailable',reason:'host_messages_unavailable'}));
    archiveJobs.set(key,task);
    void task.then(value => {archiveBackfillState=value;archiveJobs.delete(key);});
    return task;
  }
  async function synchronizeArchiveSelection() {
    if (!accepting || !archive) return;
    const settings = await archive.settings();
    const key = JSON.stringify([settings.galaxyId,settings.settings.enabled,settings.settings.sessions]);
    if (archiveSelectionKey === key) return;
    archiveSelectionKey = key;
    if (settings.settings.enabled) for (const item of settings.settings.sessions) {
      if (item.host === 'opencode') void backfillArchive({galaxyId:settings.galaxyId,...item});
    }
  }
  function notifyArchiveReady(galaxyId,sessionId) {
    if (!accepting || !onSessionComplete) return;
    const key=JSON.stringify([galaxyId,sessionId]);
    archiveSyncRequests.set(key,{galaxyId,host:'opencode',sessionId});
    if (archiveSyncJobs.has(key)) return;
    const task=(async()=>{
      while(accepting&&archiveSyncRequests.has(key)) {
        const request=archiveSyncRequests.get(key);archiveSyncRequests.delete(key);
        if((await history.identity())?.id!==request.galaxyId)continue;
        try {archiveSyncState=await diagnostics.run('archive-sync',()=>onSessionComplete({galaxyId:request.galaxyId,host:request.host,sessionId:request.sessionId}),{event:'host_archive',host:'opencode',independent:true});}
        catch {archiveSyncState={state:'pending',code:'selected_archive_sync_unavailable'};}
      }
    })().catch(error=>{diagnostics.emit({event:'host_archive',stage:'archive-sync',outcome:'failed',host:'opencode',error});archiveSyncState={state:'pending',code:'selected_archive_sync_unavailable'};});
    archiveSyncJobs.set(key,task);void task.then(()=>archiveSyncJobs.delete(key));
  }
  async function save(value) {
    if (!active) return;
    const hostTitle=api.state?.session?.get?.(active.sessionId)?.title;
    if(!value.title&&hostTitle)value={...value,title:short(hostTitle,180)};
    const key = value.sourceId, encoded = JSON.stringify({...value,revision:undefined});
    if (seen.get(key) === encoded) return;
    const result=await history.observe({galaxyId: active.galaxyId, host: 'opencode', sessionId: active.sessionId, ...value});
    if(!result.late)seen.set(key, encoded);
    if (seen.size > 5000) seen.delete(seen.keys().next().value);
    if(errorCode)diagnostics.emit({event:'host_recording',stage:'recording',outcome:'succeeded',host:'opencode'});
    errorCode = null;
  }
  function inWindow(info, part) {
    const value = part?.state?.time?.end ?? part?.time?.end ?? info?.time?.completed ?? info?.time?.created;
    return active && Number.isFinite(value) && value >= active.since;
  }
  async function savePart(part, info, eventTime) {
    if (!info || !part || part.sessionID !== active?.sessionId || !inWindow(info, part)) return;
    if (part.type === 'text') {
      if (part.synthetic || part.ignored || (info.role === 'assistant' && !part.time?.end && !info.time?.completed)) return;
      await save({sourceId: `part:${part.id}`, revision: Math.trunc(eventTime ?? part.time?.end ?? info.time?.completed ?? info.time?.created ?? 0), kind: 'message',
        occurredAt: asTime(part.time?.end ?? info.time?.completed ?? info.time?.created), title: info.role === 'user' ? short(part.text, 120) : undefined,
        source: {kind: info.role === 'user' ? 'user-statement' : 'model-report', messageId: info.id, partId: part.id}, content: content(part.text),
        details: {role: info.role, completed: info.role === 'user' || !!info.time?.completed || !!part.time?.end,
          ...(info.role === 'assistant' ? {actualModel: modelName(info) || null} : {requestedModel: modelName(info.model) || null})}});
    } else if (part.type === 'tool') {
      const state = part.state;
      if (!state || !['pending', 'running', 'completed', 'error'].includes(state.status)) return;
      await save({sourceId: `part:${part.id}`, revision: Math.trunc(eventTime ?? state.time?.end ?? state.time?.start ?? info.time?.created ?? 0), kind: 'tool',
        occurredAt: asTime(state.time?.end ?? state.time?.start ?? info.time?.created), source: {kind: 'tool-report', messageId: info.id, partId: part.id},
        content: content(state.status === 'completed' ? state.output : state.status === 'error' ? state.error : ''),
        details: {tool: short(part.tool, 160), status: state.status, callId: short(part.callID, 256), title: short(state.title, 240),
          startedAt: asTime(state.time?.start) || null, endedAt: asTime(state.time?.end) || null, workOutcome: 'unknown'}});
    } else if (part.type === 'file') {
      await save({sourceId: `part:${part.id}`, kind: 'artifact', occurredAt: asTime(info.time?.created), source: {kind: 'external-material', messageId: info.id, partId: part.id},
        details: {filename: short(part.filename, 256), mime: short(part.mime, 120), hostReferenceOnly: true, attachmentRead: false}});
    }
  }
  async function saveMessage(info, suppliedParts) {
    if (!info || info.sessionID !== active?.sessionId) return;
    messages.set(info.id, info);
    if (inWindow(info)) {
      observeMessageModel(info);
      await saveEnvironment();
    }
    const current = suppliedParts || api.state?.part?.(info.id) || [];
    const combined = new Map(current.map(part => [part.id, part]));
    for (const {part, time} of parts.values()) if (part.messageID === info.id) {
      const currentPart = combined.get(part.id), currentTime = currentPart?.state?.time?.end ?? currentPart?.time?.end ?? 0;
      if (!currentPart || (time || 0) >= currentTime) combined.set(part.id, part);
    }
    if (inWindow(info)) await save({sourceId: `message:${info.id}`, revision: Math.trunc(info.time?.completed ?? info.time?.created ?? 0), kind: 'message',
      occurredAt: asTime(info.time?.completed ?? info.time?.created), source: {kind: info.role === 'user' ? 'user-statement' : 'model-report', messageId: info.id},
      details: {role: info.role, completed: info.role === 'user' || !!info.time?.completed, errorKind: short(info.error?.name, 120), finish: short(info.finish, 120),
        actualModel: info.role === 'assistant' ? modelName(info) || null : null, requestedModel: info.role === 'user' ? modelName(info.model) || null : null}});
    for (const part of combined.values()) await savePart(part, info);
    // Full copies are an independent, explicit selection. Archive policy is
    // applied by its own local module; this recorder keeps only bounded excerpts.
    if (archive && inWindow(info) && (info.role === 'user' || info.time?.completed)) {
      const hostSession=api.state?.session?.get?.(active.sessionId),workspaceId=hostSession?.workspaceID??hostSession?.directory;
      try {await archive.captureMessage({galaxyId: active.galaxyId, host: 'opencode', sessionId: active.sessionId, messageId: info.id, message: info, parts: [...combined.values()],...(workspaceId?{workspaceId}:{})});}
      catch(error) {if(archiveBackfillState?.reason!=='local_archive_capture_unavailable')diagnostics.emit({event:'host_archive',stage:'archive-capture',outcome:'failed',host:'opencode',error});archiveBackfillState={state:'unavailable',reason:'local_archive_capture_unavailable'};}
    }
    if(info.role==='assistant'&&info.time?.completed&&inWindow(info)) {
      const completedKey=JSON.stringify([active.galaxyId,info.sessionID,info.id,info.time.completed]);
      if(!completedMessages.has(completedKey)) {
        completedMessages.add(completedKey);notifyArchiveReady(active.galaxyId,active.sessionId);
        if(completedMessages.size>5000)completedMessages.delete(completedMessages.values().next().value);
      }
    }
  }
  async function reconcile() {
    const sessionId = currentSession();
    if (!(await ensureSession(sessionId))) return;
    const visible=api.state?.session?.messages?.(sessionId) || [];
    for(const info of visible)observeMessageModel(info);
    await saveEnvironment();
    for (const info of visible) await saveMessage(info);
    if (api.state?.session?.status?.(sessionId)?.type === 'idle') await scheduleSummary(sessionId);
  }
  async function scheduleSummary(sessionId,{modelChanged=false}={}) {
    if (!active) return;
    const work = await history.get({galaxyId: active.galaxyId, host:'opencode',sessionId,limit:1});
    const latest=[...messages.values()].sort((a,b)=>messageKey(b).localeCompare(messageKey(a)));
    const lastAssistant=latest.find(message=>message.role==='assistant'&&message.providerID&&message.modelID);
    const lastUser=latest.find(message=>message.role==='user'&&message.model?.providerID&&message.model?.modelID);
    const configured=api.state?.config?.model,separator=typeof configured==='string'?configured.indexOf('/'):-1;
    const model=selectedModelSpec&&(!lastAssistant||selectedModelKey>messageKey(lastAssistant))?selectedModelSpec
      :lastAssistant?{providerID:lastAssistant.providerID,modelID:lastAssistant.modelID}:lastUser?.model
      ??(separator>0?{providerID:configured.slice(0,separator),modelID:configured.slice(separator+1)}:null);
    if(work?.work.pending)summarizer.schedule({galaxyId:active.galaxyId,workId:work.work.workId,sessionId,model,agent:lastAssistant?.agent||lastUser?.agent},{modelChanged});
  }
  async function receive(event) {
    const p = event?.properties || {}, sessionId = p.sessionID || p.part?.sessionID || p.info?.sessionID || (event.type==='session.updated'?p.info?.id:null);
    if (event.type === 'server.connected' || event.type === 'tui.session.select') {await reconcile(); return;}
    if (event.type === 'mcp.tools.changed' || event.type === 'installation.updated') {await ensureSession(currentSession()); return;}
    if (!sessionId || !(await ensureSession(sessionId))) return;
    if(event.type==='session.updated'&&p.info?.title){await save({sourceId:'session-title',revision:Number.isFinite(p.info.time?.updated)?p.info.time.updated:undefined,kind:'session',title:short(p.info.title,180),source:{kind:'host-event'},details:{event:'session-title',title:short(p.info.title,180)}});return;}
    if (event.type === 'session.next.model.switched') {selectedModel = modelName(p.model);selectedModelSpec=promptModel(p.model);selectedModelKey=`${String(Number.isFinite(p.timestamp)?p.timestamp:Date.now()).padStart(16,'0')}:${event.id||'model-selection'}`; environmentKey = ''; await ensureSession(sessionId);if(api.state?.session?.status?.(sessionId)?.type==='idle')await scheduleSummary(sessionId,{modelChanged:true}); return;}
    if (event.type === 'message.updated') {await saveMessage(p.info); return;}
    if (event.type === 'message.part.updated') {
      const part = p.part; if (!part) return;
      const prior = parts.get(part.id);
      if (!prior || (p.time || 0) >= (prior.time || 0)) parts.set(part.id, {part, time: p.time});
      if (parts.size > 5000) parts.delete(parts.keys().next().value);
      const info = messages.get(part.messageID) || api.state?.session?.messages?.(sessionId)?.find(message => message.id === part.messageID);
      await savePart(part, info, p.time);
      if (info) await saveMessage(info);
      return;
    }
    if (event.type === 'session.status' || event.type === 'session.idle') {
      await reconcile();
      await save({sourceId: event.id ? `event:${event.id}` : 'session-status', kind: 'session', source: {kind: 'host-event'},
        details: {status: event.type === 'session.idle' ? 'idle' : short(p.status?.type, 80), workOutcome: 'unknown'}});
      if (event.type === 'session.idle' || p.status?.type === 'idle') {
        await scheduleSummary(sessionId);
        notifyArchiveReady(active.galaxyId,sessionId);
      }
    } else if (event.type === 'message.removed' || event.type === 'message.part.removed' || event.type === 'session.error') {
      await save({sourceId: event.id ? `event:${event.id}` : `${event.type}:${p.messageID || p.partID || ''}`, kind: 'gap',
        source: {kind: 'host-event'}, details: {event: event.type, messageId: short(p.messageID, 256), partId: short(p.partID, 256), originalMayBeUnavailable: true}});
    }
  }
  if (api.event?.on) {
    // These exact event names and shapes are in @opencode-ai/plugin TuiEventBus
    // and @opencode-ai/sdk/v2's generated Event union.
    for (const type of ['message.updated', 'message.part.updated', 'message.removed', 'message.part.removed', 'session.status', 'session.idle',
      'session.error', 'session.updated', 'server.connected', 'tui.session.select', 'session.next.model.switched', 'mcp.tools.changed', 'installation.updated'])
      disposers.push(api.event.on(type, event => {void enqueue(() => receive(event));}));
  }
  const ready = enqueue(()=>diagnostics.run('recording',reconcile,{event:'host_recording',host:'opencode'}));
  const timer = setInterval(() => {void enqueue(async () => {
    const owner = await history.identity();
    if (currentSession() !== lastSession || owner?.id !== lastOwner || !api.event?.on || errorCode) await reconcile();
    else {await ensureSession(currentSession());if(api.state?.session?.status?.(currentSession())?.type==='idle')await scheduleSummary(currentSession());}
  });}, pollMs);
  timer.unref?.();
  async function close() {
    if (closing) return closing;
    accepting = false; clearInterval(timer);
    for (const dispose of disposers.splice(0)) dispose();
    for (const controller of archiveControllers) controller.abort();
    archiveSyncRequests.clear();
    closing = diagnostics.run('shutdown',()=>Promise.all([chain, summarizer.close(), Promise.allSettled([...archiveJobs.values(),...archiveSyncJobs.values()])]).then(() => {messages.clear(); parts.clear(); seen.clear();completedMessages.clear();}),{event:'host_recording',host:'opencode'});
    return closing;
  }
  return {history, archive, ready, refresh: () => enqueue(reconcile), backfillArchive, close,
    status: () => ({state: errorCode ? 'unavailable' : active ? 'recording' : 'waiting-for-local-identity', errorCode,
      eventSubscription: !!api.event?.on, sessionId: active?.sessionId || null, galaxyId: active?.galaxyId || null,
      archiveBackfill: archiveBackfillState, archiveSync: archiveSyncState, fullConversationByDefault: false})};
}
