import {v2WorkObservations} from './v2-work-observations.mjs';
import {createHostLocalClient} from './bridge/host-local-client.mjs';
import {hostDiagnostics} from './bridge/native-diagnostics.mjs';

const asTime = value => Number.isFinite(value) && value >= 0 ? new Date(value).toISOString() : undefined;
const modelName = model => model && typeof model.providerID === 'string' && typeof (model.modelID ?? model.id) === 'string'
  ? `${model.providerID}/${model.modelID ?? model.id}` : undefined;
const short = (value, length = 1200) => typeof value === 'string' ? value.slice(0, length) : '';
const content = text => ({excerpt: short(text), originalLength: typeof text === 'string' ? text.length : 0,
  retained: text ? 'excerpt' : 'none', availableFromHost: true});

/** @typedef {ReturnType<typeof createHostLocalClient>} HostPersistence */

/** Uses the public TuiPluginApi event bus and state. It observes the current
 * foreground session only, never enumerates other host sessions or creates a
 * background reader/model. State reconciliation also covers reconnect/restart.
 * @param {*} api
 * @param {{dataDirectory?: string, history?: HostPersistence['history'], archive?: HostPersistence['archive'], onSessionComplete?: (input: {galaxyId: string, host: string, sessionId: string}) => unknown | Promise<unknown>, pollMs?: number}} [options]
 */
export function createOpenCodeWorkRecorder(api, {dataDirectory, history, archive, onSessionComplete, pollMs = 2000} = {}) {
  const persistence=history?null:createHostLocalClient({localOnly:true,dataDirectory});
  history??=persistence.history;archive??=persistence?.archive;
  const diagnostics=hostDiagnostics(api);
  diagnostics.emit({event:'host_recording',stage:'recording',outcome:'started',host:'opencode'});
  let accepting = true, closing, chain = Promise.resolve(), active = null, errorCode = null, selectedModel, actualModel;
  let environmentKey = '', lastOwner = '', synchronizedSince = 0;
  let selectedModelKey = '', actualModelKey = '';
  let archiveSelectionKey = '', archiveBackfillState = null;
  const archiveJobs = new Map(), archiveControllers = new Set();
  const archiveSyncJobs = new Map(), archiveSyncRequests = new Map(), completedMessages = new Set();
  let archiveSyncState = null;
  const activatedAt=Date.now();
  const seen = new Map(), disposers = [];
  const currentSession = () => api.route?.current?.name === 'session' ? api.route.current.params?.sessionID : null;
  function report(error) {
    const code = typeof error?.code === 'string' ? error.code : 'local_work_recording_unavailable';
    if (errorCode !== code) {
      diagnostics.emit({event:'host_recording',stage:'recording',outcome:'failed',host:'opencode',error,sourceId:error?.sourceId,revisionProvided:error?.revisionProvided});
      api.ui?.toast?.({variant: 'warning', title: '银河 · 本地记录', message: '本次工作记录未保存。'});
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
    if(info.role==='assistant'&&modelName(info)&&key>=actualModelKey){actualModel=modelName(info);actualModelKey=key;}
    if(info.role==='user'&&modelName(info.model)&&key>=selectedModelKey){selectedModel=modelName(info.model);selectedModelKey=key;}
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
      seen.clear(); environmentKey = ''; synchronizedSince = active.since;
      selectedModel = undefined; actualModel = undefined; selectedModelKey = ''; actualModelKey = '';
      lastOwner = owner.id;
    }
    await saveEnvironment();
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
      if (!api.v2?.syncMessages && !api.client?.session?.messages) return {state:'unavailable',reason:'host_messages_unavailable'};
      const controller = new AbortController(); archiveControllers.add(controller);
      const deadline = setTimeout(() => controller.abort(), 120000); deadline.unref?.();
      archiveBackfillState = {state:'reading-selected-session',host,sessionId};
      try {
        // This endpoint reads only the explicitly selected session. No session
        // search, attachment fetch, excerpt substitution or model is involved.
        const response = api.v2?.syncMessages ? {data:(await api.v2.syncMessages(sessionId,{signal:controller.signal})).filter(m=>m.type==='user'||m.type==='assistant').map(m=>({info:{id:m.id,sessionID:sessionId},parts:[],original:m}))} : await api.client.session.messages({sessionID:sessionId},{signal:controller.signal});
        if (response?.error || !Array.isArray(response?.data)) throw Error('host_messages_unavailable');
        let copied = 0;
        for (const item of response.data) {
          if (!accepting || controller.signal.aborted) return {state:'cancelled',reason:'host_archive_interrupted',copied};
          if (item?.info?.sessionID !== sessionId || !item.info.id || !Array.isArray(item.parts)) continue;
          const hostSession=api.state?.session?.get?.(sessionId),workspaceId=hostSession?.workspaceID??hostSession?.directory;
          const captured = await archive.captureMessage({galaxyId,host,sessionId,messageId:item.info.id,message:item.original??item.info,parts:item.parts,...(workspaceId?{workspaceId}:{})});
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
    if (archiveSelectionKey === key) return settings;
    archiveSelectionKey = key;
    if (settings.settings.enabled) for (const item of settings.settings.sessions) {
      if (item.host === 'opencode') void backfillArchive({galaxyId:settings.galaxyId,...item});
    }
    return settings;
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
        if(!accepting)return;
        try {archiveSyncState=await diagnostics.run('archive-sync',()=>onSessionComplete({galaxyId:request.galaxyId,host:request.host,sessionId:request.sessionId}),{event:'host_archive',host:'opencode',independent:true});}
        catch {archiveSyncState={state:'pending',code:'selected_archive_sync_unavailable'};}
      }
    })().catch(error=>{diagnostics.emit({event:'host_archive',stage:'archive-sync',outcome:'failed',host:'opencode',error});archiveSyncState={state:'pending',code:'selected_archive_sync_unavailable'};});
    archiveSyncJobs.set(key,task);void task.then(()=>archiveSyncJobs.delete(key));
  }
  async function save(value) {
    if (!active) return;
    const hostTitle=active.snapshotTitle;
    if(!value.title&&hostTitle)value={...value,title:short(hostTitle,180)};
    const key = value.sourceId, encoded = JSON.stringify({...value,revision:undefined});
    if (seen.get(key) === encoded) return;
    let result;
    try{result=await history.observe({galaxyId: active.galaxyId, host: 'opencode', sessionId: active.sessionId, ...value});}
    catch(error){if(error&&typeof error==='object'){error.sourceId=key;error.revisionProvided=Object.hasOwn(value,'revision');}throw error;}
    if(!result.late)seen.set(key, encoded);
    if (seen.size > 5000) seen.delete(seen.keys().next().value);
    if(errorCode)diagnostics.emit({event:'host_recording',stage:'recording',outcome:'succeeded',host:'opencode'});
    errorCode = null;
  }
  function inWindow(info, part) {
    const value = part?.state?.time?.end ?? part?.time?.end ?? info?.time?.completed ?? info?.time?.created;
    return active && Number.isFinite(value) && value >= active.since;
  }
  function workPart(part, info) {
    if (!info || !part || part.sessionID !== active?.sessionId || !inWindow(info, part)) return null;
    if (part.type === 'text') {
      if (part.synthetic || part.ignored || (info.role === 'assistant' && !part.time?.end && !info.time?.completed)) return null;
      return {sourceId:'part:'+part.id,kind:'message',
        occurredAt:asTime(part.time?.end ?? info.time?.completed ?? info.time?.created),title:info.role==='user'?short(part.text,120):undefined,
        source:{kind:info.role==='user'?'user-statement':'model-report',messageId:info.id,partId:part.id},content:content(part.text),
        details:{revisionBasis:'local-observation',sourceVersion:'unknown',role:info.role,completed:info.role==='user'||!!info.time?.completed||!!part.time?.end,
          ...(info.role==='assistant'?{actualModel:modelName(info)||null}:{requestedModel:modelName(info.model)||null})}};
    }
    if (part.type === 'tool') {
      const state=part.state;
      if(!state||!['pending','running','completed','error'].includes(state.status))return null;
      return {sourceId:'part:'+part.id,kind:'tool',
        occurredAt:asTime(state.time?.end ?? state.time?.start ?? info.time?.created),source:{kind:'tool-report',messageId:info.id,partId:part.id},
        content:content(state.status==='completed'?state.output:state.status==='error'?state.error:''),
        details:{revisionBasis:'local-observation',sourceVersion:'unknown',tool:short(part.tool,160),status:state.status,callId:short(part.callID,256),title:short(state.title,240),
          startedAt:asTime(state.time?.start)||null,endedAt:asTime(state.time?.end)||null,workOutcome:'unknown'}};
    }
    if (part.type === 'file') return {sourceId:'part:'+part.id,kind:'artifact',occurredAt:asTime(info.time?.created),
      source:{kind:'external-material',messageId:info.id,partId:part.id},
      details:{revisionBasis:'local-observation',sourceVersion:'unknown',filename:short(part.filename,256),mime:short(part.mime,120),hostReferenceOnly:true,attachmentRead:false}};
    return null;
  }
  function workMessage(info) {
    if(!inWindow(info))return null;
    return {sourceId:'message:'+info.id,kind:'message',occurredAt:asTime(info.time?.completed ?? info.time?.created),
      source:{kind:info.role==='user'?'user-statement':'model-report',messageId:info.id},
      details:{revisionBasis:'local-observation',sourceVersion:'unknown',role:info.role,completed:info.role==='user'||!!info.time?.completed,
        errorKind:short(info.error?.name,120),finish:short(info.finish,120),
        actualModel:info.role==='assistant'?modelName(info)||null:null,requestedModel:info.role==='user'?modelName(info.model)||null:null}};
  }
  async function saveMessage(item, workspaceId) {
    const {info,observations,original,originalFailed}=item;
    if (!info || info.sessionID !== active?.sessionId) return;
    if(inWindow(info)){observeMessageModel(info);await saveEnvironment();}
    for(const observation of observations)await save(observation);
    if(originalFailed){
      if(archiveBackfillState?.reason!=='local_archive_capture_unavailable')diagnostics.emit({event:'host_archive',stage:'archive-capture',outcome:'failed',host:'opencode',error:Error('local_archive_capture_unavailable')});
      archiveBackfillState={state:'unavailable',reason:'local_archive_capture_unavailable'};
    }
    if(archive&&original){
      try{await archive.captureMessage({galaxyId:active.galaxyId,host:'opencode',sessionId:active.sessionId,messageId:info.id,message:original.info,parts:original.parts,...(workspaceId?{workspaceId}:{})});}
      catch(error){if(archiveBackfillState?.reason!=='local_archive_capture_unavailable')diagnostics.emit({event:'host_archive',stage:'archive-capture',outcome:'failed',host:'opencode',error});archiveBackfillState={state:'unavailable',reason:'local_archive_capture_unavailable'};}
    }
    if(info.role==='assistant'&&info.time?.completed&&inWindow(info)){
      const completedKey=JSON.stringify([active.galaxyId,info.sessionID,info.id,info.time.completed]);
      if(!completedMessages.has(completedKey)){
        completedMessages.add(completedKey);notifyArchiveReady(active.galaxyId,info.sessionID);
        if(completedMessages.size>5000)completedMessages.delete(completedMessages.values().next().value);
      }
    }
  }
  async function reconcile({synchronize = false} = {}) {
    const sessionId=currentSession();
    if(!(await ensureSession(sessionId)))return;
    const settings=await synchronizeArchiveSelection().catch(error=>{
      if(archiveBackfillState?.reason!=='local_archive_selection_unavailable')diagnostics.emit({event:'host_archive',stage:'archive-backfill',outcome:'failed',host:'opencode',error});
      archiveBackfillState={state:'unavailable',reason:'local_archive_selection_unavailable'};
      return null;
    });
    if(sessionId!==currentSession()||active?.sessionId!==sessionId)return;
    // Project bounded facts synchronously from the current host view. Only an
    // explicitly selected original is copied in full before the next await.
    const selected=!!archive&&settings?.galaxyId===active.galaxyId&&settings.settings?.enabled&&
      settings.settings.sessions?.some(item=>item.host==='opencode'&&item.sessionId===sessionId);
    const hostSession=api.state?.session?.get?.(sessionId);
    const session=hostSession?.id===sessionId?{id:hostSession.id,title:short(hostSession.title,180),
      workspaceId:typeof (hostSession.workspaceID??hostSession.directory)==='string'?(hostSession.workspaceID??hostSession.directory):undefined}:null;
    const sources=synchronize&&api.v2?.synchronizedMessages ? await api.v2.synchronizedMessages(sessionId,synchronizedSince || active.since) : (api.state?.session?.messages?.(sessionId)||[]);
    if(sessionId!==currentSession()||active?.sessionId!==sessionId)return;
    const entries=sources.map(source=>{
      const info={id:source.id,sessionID:source.sessionID,role:source.role,
        time:{created:source.time?.created,completed:source.time?.completed},
        providerID:source.providerID,modelID:source.modelID,
        model:source.model?{providerID:source.model.providerID,modelID:source.model.modelID,id:source.model.id}:undefined};
      const hostParts=api.state?.part?.(source.id)||[],observations=[],message=workMessage(source);
      if(message)observations.push(message);
      if(source.v2Original&&inWindow(info)) observations.push(...v2WorkObservations(source.v2Original,info,{asTime,content,short}));
      for(const part of new Map(hostParts.map(item=>[item.id,item])).values()){
        const observation=workPart(part,source);if(observation)observations.push(observation);
      }
      let original=null,originalFailed=false;
      if(selected&&source.sessionID===sessionId&&inWindow(source)&&(source.role==='user'||source.time?.completed)){
        try{original=JSON.parse(JSON.stringify({info:source.v2Original??source,parts:source.v2Original?[]:hostParts}));}catch{originalFailed=true;}
      }
      return {info,observations,original,originalFailed};
    });
    const snapshot=JSON.parse(JSON.stringify({session,entries:entries.map(({info,observations,originalFailed})=>({info,observations,originalFailed}))}));
    snapshot.entries.forEach((item,index)=>{item.original=entries[index].original;});
    if(sessionId!==currentSession()||active?.sessionId!==sessionId)return;
    active.snapshotTitle=snapshot.session?.title;
    for(const item of snapshot.entries)observeMessageModel(item.info);
    await saveEnvironment();
    if(snapshot.session?.title)await save({sourceId:'session-title',kind:'session',title:snapshot.session.title,source:{kind:'host-event'},details:{revisionBasis:'local-observation',sourceVersion:'unknown',event:'session-title',title:snapshot.session.title}});
    for(const item of snapshot.entries)await saveMessage(item,snapshot.session?.workspaceId);
    const lastUser=[...sources].reverse().find(item=>item.role==='user');
    if(synchronize&&Number.isFinite(lastUser?.time?.created))synchronizedSince=lastUser.time.created;
    return {sessionId,galaxyId:active.galaxyId,lastUserMessageId:lastUser?.id};
  }
  async function receive(event) {
    const sessionId=event.sessionId;
    if (event.type === 'server.connected' || event.type === 'tui.session.select') {await reconcile(); return;}
    if (event.type === 'mcp.tools.changed' || event.type === 'installation.updated') {await ensureSession(currentSession()); return;}
    if (!sessionId || !(await ensureSession(sessionId))) return;
    if(event.type==='session.updated'||event.type==='message.updated'||event.type==='message.part.updated'){await reconcile();return;}
    if (event.type === 'session.next.model.switched') {selectedModel = event.model;selectedModelKey=`${String(Number.isFinite(event.timestamp)?event.timestamp:Date.now()).padStart(16,'0')}:${event.id||'model-selection'}`; environmentKey = ''; await ensureSession(sessionId);return;}
    if (event.type === 'session.status' || event.type === 'session.idle') {
      const completed = await reconcile({synchronize:event.type === 'session.idle' || event.status === 'idle'});
      await save({sourceId: event.id ? `event:${event.id}` : 'session-status', kind: 'session', source: {kind: 'host-event'},
        details: {status: event.type === 'session.idle' ? 'idle' : short(event.status, 80), workOutcome: 'unknown'}});
      if (event.type === 'session.idle' || event.status === 'idle') {
        notifyArchiveReady(active.galaxyId,sessionId);
        if(accepting && completed?.lastUserMessageId && api.v2?.reviewReady) {
          diagnostics.emit({event:'host_summary',stage:'summary',outcome:'started',host:'opencode',error:Error('local_work_review_notify_started')});
          try {const result=await api.v2.reviewReady(completed);diagnostics.emit({event:'host_summary',stage:'summary',outcome:result?.accepted?'succeeded':'deferred',host:'opencode',error:Error(result?.accepted?'local_work_review_notify_accepted':'local_work_review_pending')});} catch(error) {diagnostics.emit({event:'host_summary',stage:'summary',outcome:'failed',host:'opencode',error:Object.assign(Error('local_work_review_notify_failed'),{cause:error})});}
        } else diagnostics.emit({event:'host_summary',stage:'summary',outcome:'deferred',host:'opencode',error:Error('local_work_review_no_user')});
      }
    } else if (event.type === 'message.removed' || event.type === 'message.part.removed' || event.type === 'session.error') {
      await save({sourceId: event.id ? `event:${event.id}` : `${event.type}:${event.messageId || event.partId || ''}`, kind: 'gap',
        source: {kind: 'host-event'}, details: {event: event.type, messageId: short(event.messageId, 256), partId: short(event.partId, 256), originalMayBeUnavailable: true}});
    }
  }
  if (api.event?.on) {
    // These exact event names and shapes are in @opencode-ai/plugin TuiEventBus
    // and @opencode-ai/sdk/v2's generated Event union.
    for (const type of ['message.updated', 'message.part.updated', 'message.removed', 'message.part.removed', 'session.status', 'session.idle',
      'session.error', 'session.updated', 'server.connected', 'tui.session.select', 'session.next.model.switched', 'mcp.tools.changed', 'installation.updated'])
      disposers.push(api.event.on(type, event => {
        const p=event?.properties||{};
        const sessionId=p.sessionID||p.part?.sessionID||p.info?.sessionID||(type==='session.updated'?p.info?.id:undefined);
        const notice={type,id:typeof event?.id==='string'?event.id:undefined,
          sessionId:typeof sessionId==='string'?sessionId:undefined,
          messageId:typeof p.messageID==='string'?p.messageID:undefined,partId:typeof p.partID==='string'?p.partID:undefined,
          status:typeof p.status?.type==='string'?p.status.type:undefined,
          model:modelName(p.model),timestamp:Number.isFinite(p.timestamp)?p.timestamp:undefined};
        void enqueue(() => receive(notice));
      }));
  }
  const ready = enqueue(()=>diagnostics.run('recording',reconcile,{event:'host_recording',host:'opencode'}));
  const timer = setInterval(() => {void enqueue(reconcile);}, pollMs);
  timer.unref?.();
  async function close() {
    if (closing) return closing;
    accepting = false; clearInterval(timer);
    for (const dispose of disposers.splice(0)) dispose();
    for (const controller of archiveControllers) controller.abort();
    archiveSyncRequests.clear();
    closing = diagnostics.run('shutdown',async()=>{try{await Promise.all([chain, Promise.allSettled([...archiveJobs.values(),...archiveSyncJobs.values()])]);seen.clear();completedMessages.clear();}finally{await persistence?.close();}},{event:'host_recording',host:'opencode'});
    return closing;
  }
  return {history, archive, ready, refresh: () => enqueue(reconcile), backfillArchive, close,
    status: () => ({state: errorCode ? 'unavailable' : active ? 'recording' : 'waiting-for-local-identity', errorCode,
      eventSubscription: !!api.event?.on, sessionId: active?.sessionId || null, galaxyId: active?.galaxyId || null,
      archiveBackfill: archiveBackfillState, archiveSync: archiveSyncState, fullConversationByDefault: false})};
}
