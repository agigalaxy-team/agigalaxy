const DEFAULT_FALLBACK_SECONDS = 15 * 60;

/**
 * Connects the local Watch state machine to a host event source and an
 * optional fallback scheduler. It never supplies a model, stores credentials,
 * or acknowledges work: the host's Agent must process returned work and call
 * ack explicitly. Activation is opt-in; constructing this object schedules
 * nothing.
 */
export function createNativeWatchRuntime({
  watch,
  eventSource = null,
  schedule = (fn, delay) => setTimeout(fn, delay),
  cancelSchedule = handle => clearTimeout(handle),
  now = () => Math.floor(Date.now() / 1000),
  fallbackSeconds = DEFAULT_FALLBACK_SECONDS,
  onWork = null,
} = {}) {
  if (!watch || typeof watch.check !== 'function' || typeof watch.status !== 'function') {
    throw new Error('watch_runtime_watch_required');
  }
  if (!Number.isInteger(fallbackSeconds) || fallbackSeconds < 1) {
    throw new Error('watch_runtime_fallback_invalid');
  }
  if (onWork !== null && typeof onWork !== 'function') throw new Error('watch_runtime_onwork_invalid');

  let closed = false;
  const runners = new Map();
  const isCurrent = runner => !closed && runners.get(runner.watchId) === runner;

  const ensureOpen = () => { if (closed) throw new Error('watch_runtime_closed'); };
  const cancel = runner => {
    if (runner.timer !== null) { cancelSchedule(runner.timer); runner.timer = null; }
  };
  const unsubscribe = runner => {
    if (typeof runner.unsubscribe === 'function') { runner.unsubscribe(); runner.unsubscribe = null; }
  };

  async function scheduleNext(runner) {
    cancel(runner);
    if (!isCurrent(runner) || runner.inFlight || runner.pending) return;
    let result;
    try { result = await watch.status(runner.watchId); }
    catch {
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

  async function check(watchId, cause = 'manual') {
    ensureOpen();
    const runner = runners.get(watchId);
    if (!runner) throw new Error('watch_runtime_not_active');
    if (runner.inFlight) return runner.inFlight;
    runner.inFlight = (async () => {
      // Only an actual host event bypasses the fallback due time. A timer and
      // a manual call still obey Watch.nextCheckAt, keeping transport bounded.
      const result = await watch.check(watchId, { force: cause === 'event' });
      if (!isCurrent(runner)) return { state: 'suspended-host', modelCalls: 0, workSuppressed: true };
      if (result?.state === 'work-ready' && onWork) {
        await onWork({ watchId, work: result.work, result });
        // No implicit ack: onWork may only prepare a response and the host
        // must acknowledge after its Agent has actually processed the work.
      }
      return result;
    })();
    try { return await runner.inFlight; }
    finally { runner.inFlight = null; await scheduleNext(runner); }
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

  async function activate(watchId, { checkNow = true } = {}) {
    ensureOpen();
    let runner = runners.get(watchId);
    if (!runner) {
      runner = { watchId, timer: null, inFlight: null, pending: false, unsubscribe: null };
      runners.set(watchId, runner);
      bindEvents(runner);
    }
    const result = checkNow ? await check(watchId, 'activate') : { state: 'activated', modelCalls: 0 };
    if (!checkNow) await scheduleNext(runner);
    return { watchId, result, ...(await status(watchId)) };
  }

  async function ack(watchId, workId) {
    ensureOpen();
    const runner = runners.get(watchId);
    if (!runner || typeof watch.ack !== 'function') throw new Error('watch_runtime_not_active');
    const result = await watch.ack(watchId, workId);
    await scheduleNext(runner);
    return result;
  }

  async function stop(watchId) {
    ensureOpen();
    const runner = runners.get(watchId);
    if (!runner) throw new Error('watch_runtime_not_active');
    cancel(runner); unsubscribe(runner); runners.delete(watchId);
    return typeof watch.stop === 'function' ? watch.stop(watchId) : { watchId, state: 'stopped' };
  }
  async function pause(watchId) {
    ensureOpen();
    const runner = runners.get(watchId);
    if (!runner) throw new Error('watch_runtime_not_active');
    cancel(runner); unsubscribe(runner); runners.delete(watchId);
    return typeof watch.pause === 'function' ? watch.pause(watchId) : { watchId, state: 'paused' };
  }

  async function status(watchId) {
    ensureOpen();
    const result = await watch.status(watchId);
    const active = watchId ? runners.has(watchId) : runners.size > 0;
    const rows = Array.isArray(result?.items) ? result.items : [];
    // Persisted watches survive a host process restart, but the user Agent
    // does not. Make that boundary explicit so a cloud read is never shown as
    // a running Agent while the host is closed or the local runtime is idle.
    const withHostState = rows.map(row => ({ ...row,
      hostState: row.state !== 'active' ? 'not-running' : runners.has(row.id ?? row.watchId) ? 'running-host' : 'suspended-host',
    }));
    return { ...result, ...(Array.isArray(result?.items) ? { items: withHostState } : {}), runtime: { eventDriven: !!eventSource, fallbackPollMinutes: fallbackSeconds / 60, active, hostState: active ? 'running-host' : 'idle-host' } };
  }

  async function dispose() {
    if (closed) return;
    closed = true;
    const pending = [...runners.values()].map(runner => runner.inFlight).filter(Boolean);
    for (const runner of runners.values()) { cancel(runner); unsubscribe(runner); }
    await Promise.allSettled(pending);
    runners.clear();
  }

  return Object.freeze({ activate, check, ack, stop, pause, status, dispose, isActive: watchId => runners.has(watchId), notify: event => {
    ensureOpen();
    if (!event?.watchId) throw new Error('watch_runtime_event_watch_required');
    const runner = runners.get(event.watchId);
    return runner ? check(event.watchId, 'event') : Promise.resolve({ state: 'not-active', modelCalls: 0 });
  } });
}
