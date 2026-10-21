const DEFAULT_FALLBACK_SECONDS = 15 * 60;
import {nativeWatchHostSchema} from './watch.mjs';
import {nativeDiagnostics} from './diagnostics.mjs';

/**
 * Connects the local Watch state machine to a host event source and an
 * optional fallback scheduler. It never supplies a model, stores credentials,
 * or acknowledges unprocessed work. A selected formal host driver can execute
 * and ACK only completed work after current source revalidation; ordinary MCP
 * hosts keep the explicit Agent ACK path. Construction schedules nothing.
 */
export function createNativeWatchRuntime({
  watch,
  eventSource = null,
  schedule = (fn, delay) => setTimeout(() => fn(), delay),
  cancelSchedule = handle => clearTimeout(handle),
  now = () => Math.floor(Date.now() / 1000),
  fallbackSeconds = DEFAULT_FALLBACK_SECONDS,
  onWork = null,
  hostDriver = null,
  getHostLease = null,
} = {}) {
  const diagnostics=nativeDiagnostics();
  if (!watch || typeof watch.check !== 'function' || typeof watch.status !== 'function') {
    throw new Error('watch_runtime_watch_required');
  }
  if (!Number.isInteger(fallbackSeconds) || fallbackSeconds < 1) {
    throw new Error('watch_runtime_fallback_invalid');
  }
  if (onWork !== null && typeof onWork !== 'function') throw new Error('watch_runtime_onwork_invalid');
  if (hostDriver && (typeof hostDriver.run !== 'function' || typeof hostDriver.cancel !== 'function' || typeof getHostLease !== 'function')) throw Error('watch_host_driver_invalid');

  let closed = false, disposing;
  const runners = new Map(), operations = new Set();
  const track = (run,stage='runtime') => {
    const operation = diagnostics.run(stage,run,{event:'native_watch',independent:true});
    operations.add(operation);
    operation.then(() => operations.delete(operation), () => operations.delete(operation));
    return operation;
  };
  const isCurrent = runner => !closed && runners.get(runner.watchId) === runner;
  const sameLease = (a, b) => !!a&&!!b&&['subjectId','endpoint','bindingId','generation'].every(key=>a[key]===b[key]);
  const captureHostLease=()=>{const value=getHostLease?.();return value?{subjectId:value.subjectId,endpoint:value.endpoint,bindingId:value.bindingId,generation:value.generation}:null;};
  const hostCurrent = runner => isCurrent(runner) && runner.hostExpiresAt>now() && sameLease(runner.hostLease, getHostLease?.());

  const ensureOpen = () => { if (closed) throw new Error('watch_runtime_closed'); };
  const cancel = runner => {
    if (runner.timer !== null) { cancelSchedule(runner.timer); runner.timer = null; }
  };
  const cancelExpiry=runner=>{if(runner.expiryTimer!==null){cancelSchedule(runner.expiryTimer);runner.expiryTimer=null;}};
  const unsubscribe = runner => {
    if (typeof runner.unsubscribe === 'function') { runner.unsubscribe(); runner.unsubscribe = null; }
  };

  async function scheduleNext(runner) {
    cancel(runner);
    if (!isCurrent(runner) || runner.inFlight || runner.pending) return;
    let result;
    try { result = await watch.status(runner.watchId); }
    catch(error) {
      diagnostics.emit({event:'native_watch',stage:'watch-status',outcome:'failed',error});
      if (!isCurrent(runner)) return;
      // A transient host/API failure must not permanently orphan an active
      // Watch. Keep the local runtime alive and retry on the bounded fallback.
      runner.timer = schedule(() => {
        runner.timer = null;
        void check(runner.watchId, 'fallback').catch(() => {});
      }, fallbackSeconds * 1000);
      return;
    }
    if (!isCurrent(runner)) return;
    const row = result?.items?.find(item => item.id === runner.watchId || item.watchId === runner.watchId);
    if (!row || row.state !== 'active' || row.pending) return;
    const due = Number.isSafeInteger(row.nextCheckAt) ? row.nextCheckAt : now() + fallbackSeconds;
    const delay = Math.max(0, (due - now()) * 1000);
    runner.timer = schedule(() => {
      runner.timer = null;
      void check(runner.watchId, 'fallback').catch(() => {});
    }, delay);
  }

  function check(watchId, cause = 'manual') {
    ensureOpen();
    const runner = runners.get(watchId);
    if (!runner) throw new Error('watch_runtime_not_active');
    if (runner.inFlight) return runner.inFlight;
    runner.inFlight = track(async () => {
     try {
      // Only an actual host event bypasses the fallback due time. A timer and
      // a manual call still obey Watch.nextCheckAt, keeping transport bounded.
      const result = await watch.check(watchId, { force: cause === 'event', host: !!runner.host });
      if (!isCurrent(runner)) return { state: 'suspended-host', modelCalls: 0, workSuppressed: true };
      if (runner.host) {
        if(runner.hostExpiresAt<=now()){await expire(runner);return{state:'inactive',reason:'watch-expired',modelCalls:0,workSuppressed:true};}
        if (!hostCurrent(runner)) { await pause(watchId); return { state: 'binding-changed', modelCalls: 0, workSuppressed: true }; }
        if (result?.state === 'work-completed-pending-ack') {
          if (!sameLease(result.hostExecution?.lease, runner.hostLease)) return { state: 'host-result-pending', modelCalls: 0, reason: 'original-binding-required' };
          return acknowledgeHost(runner, result.workId, result.hostExecution, 0);
        }
        if (result?.state === 'work-ready') return processHost(runner, result);
      }
      if (result?.state === 'work-ready' && onWork) {
        await onWork({ watchId, work: result.work, result });
        // No implicit ack: onWork may only prepare a response and the host
        // must acknowledge after its Agent has actually processed the work.
      }
      return result;
     } finally { runner.inFlight = null; await scheduleNext(runner); }
    },'watch-check');
    return runner.inFlight;
  }

  async function acknowledgeHost(runner, workId, execution, modelCalls) {
    try {
      await watch.verifyHostWork(runner.watchId, workId);
      if (!hostCurrent(runner)) return { state: 'binding-changed', modelCalls, workSuppressed: true };
      const receipt = await watch.ack(runner.watchId, workId);
      if (!hostCurrent(runner)) return { state: 'binding-changed', modelCalls, workSuppressed: true };
      return { state: 'processed', workId, modelCalls, execution, receipt };
    } catch(error) {diagnostics.emit({event:'native_watch',stage:'watch-ack',outcome:'unknown',error}); return { state: 'host-completed-ack-unconfirmed', workId, modelCalls, execution, retryOriginalAckOnly: true }; }
  }
  async function processHost(runner, result) {
    const workId = result.work.workId;
    const scope = await watch.verifyHostWork(runner.watchId, workId);
    if (!hostCurrent(runner)||scope.agentGrantId!==runner.hostGrantId) return { state: 'binding-changed', modelCalls: 0, workSuppressed: true };
    const journal=state=>({...state,model:runner.host.model,lease:runner.hostLease,scopeKey:runner.hostScopeKey,agentGrantId:runner.hostGrantId});
    runner.execution={workId,...journal({state:'dispatching'})};
    await watch.recordHostExecution(runner.watchId, workId, journal({state:'dispatching'}));
    if (!hostCurrent(runner)) return { state: 'binding-changed', modelCalls: 0, workSuppressed: true };
    runner.abort = new AbortController();
    const execution = await diagnostics.run('watch-host',()=>hostDriver.run({ watchId: runner.watchId, work: result.work, purpose: scope.purpose,
      ...runner.host, scopeKey: runner.hostScopeKey, isCurrent: () => hostCurrent(runner), signal: runner.abort.signal,
      onState: async state => { runner.execution={workId,...journal(state)};await watch.recordHostExecution(runner.watchId, workId, journal(state)); } }),{event:'native_watch',resultFailed:value=>['failed','unknown'].includes(value?.state)});
    const hostTurnsAttempted=execution.hostTurnDispatches??0,modelCalls=hostTurnsAttempted?null:0;
    if (!hostCurrent(runner)) return { state: 'suspended-host', modelCalls, hostTurnsAttempted, workSuppressed: true };
    // Keep only control metadata in the local journal. Returned analysis is
    // withheld until the exact current source and Agent cursor ACK are valid.
    const metadata = journal({ state: execution.state,reason:execution.reason, threadId: execution.threadId, turnId: execution.turnId });
    runner.execution={workId,...metadata};
    await watch.recordHostExecution(runner.watchId, workId, metadata);
    if (!hostCurrent(runner)) return { state: 'binding-changed', modelCalls, hostTurnsAttempted, workSuppressed: true };
    if (execution.state !== 'completed') return { state: 'host-result-pending', workId, modelCalls, hostTurnsAttempted, execution: metadata, automaticRetry: false };
    const acked = await acknowledgeHost(runner, workId, metadata, modelCalls);
    return { ...acked, hostTurnsAttempted, ...(acked.state === 'processed' ? { output: execution.output } : {}) };
  }

  function bindEvents(runner) {
    if (!eventSource || typeof eventSource.subscribe !== 'function') return;
    const handler = event => {
      if (event?.watchId && event.watchId !== runner.watchId) return;
      void check(runner.watchId, 'event').catch(() => {});
    };
    const cleanup = eventSource.subscribe(handler);
    if (typeof cleanup === 'function') runner.unsubscribe = cleanup;
  }

  async function activate(watchId, { checkNow = true, host = null, confirmed = false } = {}) {
    ensureOpen();
    if(host)host=nativeWatchHostSchema.parse(host);
    if (host && (!confirmed || !hostDriver || typeof host.model !== 'string' || typeof host.cwd !== 'string')) throw Error('watch_host_choice_required');
    const selectedLease=host?captureHostLease():null;
    if(host){if(!selectedLease?.subjectId||!selectedLease.endpoint||!selectedLease.bindingId||!Number.isSafeInteger(selectedLease.generation))throw Error('watch_host_binding_required');}
    if (host && (typeof watch.verifyHostWork !== 'function' || typeof watch.recordHostExecution !== 'function')) throw Error('watch_host_journal_required');
    let runner = runners.get(watchId);
    if (runner && host && (runner.host||runner.inFlight)) throw Error('watch_host_already_active');
    let selected;
    if(host){
      selected=(await watch.status(watchId)).items?.find(item=>(item.id??item.watchId)===watchId);
      ensureOpen();
      if(!sameLease(selectedLease,getHostLease())||!selected?.agentGrantId||selected.state!=='active'||selected.bindingLease&&!sameLease(selected.bindingLease,selectedLease))throw Error('watch_host_active_grant_required');
      if(runners.get(watchId)!==runner||runner?.inFlight||runner?.host)throw Error('watch_host_choice_changed');
    }
    if(runner&&host){cancel(runner);unsubscribe(runner);runners.delete(watchId);runner=null;}
    if (!runner) {
      runner = { watchId, timer: null, expiryTimer:null,inFlight: null, pending: false, unsubscribe: null,
        host: host ? { ...host } : null, hostLease: selectedLease, hostGrantId:selected?.agentGrantId,
        hostScopeKey:host?JSON.stringify({lease:selectedLease,watchId,agentGrantId:selected.agentGrantId}):null,hostExpiresAt:selected?.expiresAt,
        execution:selected?.pending?.hostExecution?{workId:selected.pending.workId,...selected.pending.hostExecution}:null,abort: null };
      runners.set(watchId, runner);
      bindEvents(runner);
      if(host)runner.expiryTimer=schedule(()=>{runner.expiryTimer=null;if(isCurrent(runner))void expire(runner).catch(()=>{});},Math.max(0,(runner.hostExpiresAt-now())*1000));
    }
    const result = checkNow ? await check(watchId, 'activate') : { state: 'activated', modelCalls: 0 };
    if (!checkNow) await scheduleNext(runner);
    return { watchId, result, ...(await status(watchId)) };
  }

  async function reconcileHost(watchId,{workId}={}) {
    ensureOpen();
    if(!hostDriver?.reconcile||typeof getHostLease!=='function')throw Error('watch_host_not_configured');
    return track(async()=>{
      const before=captureHostLease(),current=()=>!closed&&sameLease(before,getHostLease());
      const runner=runners.get(watchId),row=(await watch.status(watchId)).items?.find(item=>(item.id??item.watchId)===watchId);
      if(!current())throw Error('watch_binding_changed');
      const pending=row?.pending,execution=workId?pending?.workId===workId?pending.hostExecution:row?.hostStopReceipts?.[workId]
        :pending?.hostExecution??row?.lastHostExecution;
      if(!execution?.threadId||!execution.turnId)return{state:'unknown',originalTurnLocatorMissing:true,automaticRetry:false};
      if(!before?.subjectId||execution.lease?.subjectId!==before.subjectId||execution.lease?.endpoint!==before.endpoint)throw Error('watch_host_receipt_owner_required');
      const receipt=await hostDriver.reconcile({threadId:execution.threadId,turnId:execution.turnId,isCurrent:current});
      if(!current())throw Error('watch_binding_changed');
      if(pending&&(!workId||pending.workId===workId)&&receipt.state==='completed'&&runner?.host&&hostCurrent(runner)&&sameLease(execution.lease,runner.hostLease)&&execution.scopeKey===runner.hostScopeKey){
        await watch.verifyHostWork(watchId,pending.workId);
        if(!current()||!hostCurrent(runner))throw Error('watch_binding_changed');
        await watch.recordHostExecution(watchId,pending.workId,{...execution,state:'completed'});
        if(!current())throw Error('watch_binding_changed');
      }else if(['completed','interrupted','failed'].includes(receipt.state)&&execution.workId&&typeof watch.recordHostCancellation==='function'){
        await watch.recordHostCancellation(watchId,execution,{...receipt,cancellationConfirmed:receipt.state==='interrupted',executionEnded:true});
        if(!current())throw Error('watch_binding_changed');
      }
      return{...receipt,automaticRetry:false,bodyIncluded:false};
    });
  }

  function ack(watchId, workId) {
    ensureOpen();
    const runner = runners.get(watchId);
    if (!runner || typeof watch.ack !== 'function') throw new Error('watch_runtime_not_active');
    return track(async () => {
      const result = await watch.ack(watchId, workId);
      await scheduleNext(runner);
      return result;
    });
  }

  function stop(watchId) {
    ensureOpen();
    const runner = runners.get(watchId);
    if (!runner) throw new Error('watch_runtime_not_active');
    cancel(runner);cancelExpiry(runner); unsubscribe(runner); runners.delete(watchId);
    return track(() => haltHost(runner, 'stop'));
  }
  function pause(watchId) {
    ensureOpen();
    const runner = runners.get(watchId);
    if (!runner) throw new Error('watch_runtime_not_active');
    cancel(runner);cancelExpiry(runner); unsubscribe(runner); runners.delete(watchId);
    return track(() => haltHost(runner, 'pause'));
  }
  function expire(runner){
    if(!isCurrent(runner)||runner.hostExpiresAt>now())return Promise.resolve({state:'not-expired'});
    cancel(runner);cancelExpiry(runner);unsubscribe(runner);runners.delete(runner.watchId);
    return track(()=>haltHost(runner,'expire'));
  }
  async function haltHost(runner, action) {
    let galaxy, error;
    // The local runner was detached synchronously; attempt exact Galaxy
    // revocation before signalling the user host. An unconfirmed revoke does
    // not prevent cancellation and is still reported as unconfirmed.
    try { galaxy = typeof watch[action] === 'function' ? await watch[action](runner.watchId,runner.host?{agentGrantId:runner.hostGrantId}:undefined) : { state: action === 'pause' ? 'paused' : 'stopped' }; } catch (e) { error = e; }
    let external = { state: 'not-configured', cancellationConfirmed: false, executionEnded: true };
    if (runner.host) {
      runner.abort?.abort();
      try { external = await hostDriver.cancel(runner.watchId,{scopeKey:runner.hostScopeKey,threadId:runner.execution?.threadId,turnId:runner.execution?.turnId}); } catch { external = { state: 'unknown', cancellationConfirmed: false, executionEnded: false }; }
      if(typeof watch.recordHostCancellation==='function')await watch.recordHostCancellation(runner.watchId,runner.execution,external);
    }
    if (error) throw error;
    return { ...galaxy, ...(runner.host ? { externalModelCancellation: external.state, hostCancellation: external } : {}) };
  }

  async function status(watchId) {
    ensureOpen();
    const result = await watch.status(watchId);
    const active = watchId ? runners.has(watchId) : runners.size > 0;
    const rows = Array.isArray(result?.items) ? result.items : [];
    // Persisted watches survive a host process restart, but the user Agent
    // does not. Make that boundary explicit so a cloud read is never shown as
    // a running Agent while the host is closed or the local runtime is idle.
    const withHostState = rows.map(row => {const runner=runners.get(row.id??row.watchId),execution=row.pending?.hostExecution??row.lastHostExecution;
      const actual=runner?.host?hostDriver.status?.(runner.watchId,{scopeKey:runner.hostScopeKey}):null;
      const uncertain=execution&&!execution.cancellation?.executionEnded&&['unknown','dispatching'].includes(execution.state);
      return{ ...row,
      hostState: row.state !== 'active' ? 'not-running' : runners.has(row.id ?? row.watchId) ? 'running-host' : 'suspended-host',
      hostModelEnabled: !!runner?.host,modelRunning:actual&&actual.state!=='not-running'?actual.modelRunning:uncertain?null:false,
      hostModelState:actual&&actual.state!=='not-running'?actual.state:uncertain?'unconfirmed':'not-running',
    };});
    return { ...result, ...(Array.isArray(result?.items) ? { items: withHostState } : {}), runtime: { eventDriven: !!eventSource, fallbackPollMinutes: fallbackSeconds / 60, active, hostState: active ? 'running-host' : 'idle-host' } };
  }

  function dispose() {
    closed = true;
    return disposing ??= diagnostics.run('shutdown',async () => {
      const errors = [];
      for (const runner of runners.values()) {
        try { cancel(runner);cancelExpiry(runner); } catch (error) { errors.push(error); }
        try { unsubscribe(runner); } catch (error) { errors.push(error); }
        if (runner.host) { runner.abort?.abort(); try {
          const result=await hostDriver.cancel(runner.watchId,{scopeKey:runner.hostScopeKey,threadId:runner.execution?.threadId,turnId:runner.execution?.turnId});
          if(runner.execution&&['completed','interrupted','failed'].includes(result.state)){
            try{await watch.recordHostExecution(runner.watchId,runner.execution.workId,{...runner.execution,state:result.state});}
            catch(error){if(!['watch_work_changed','watch_host_scope_changed'].includes(error.message))throw error;}
          }
        } catch (error) { errors.push(error); } }
      }
      // Include operations detached by pause/stop and in-flight ACKs. A
      // second dispose observes the same drain rather than returning early.
      await Promise.allSettled(operations);
      runners.clear();
      if (hostDriver?.close) { try { await hostDriver.close(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, 'watch_runtime_cleanup_failed');
    },{event:'native_watch'});
  }

  return Object.freeze({ activate, check, ack, stop, pause, status, dispose, reconcileHost, isActive: watchId => runners.has(watchId), notify: event => {
    ensureOpen();
    if (!event?.watchId) throw new Error('watch_runtime_event_watch_required');
    const runner = runners.get(event.watchId);
    return runner ? check(event.watchId, 'event') : Promise.resolve({ state: 'not-active', modelCalls: 0 });
  } });
}
