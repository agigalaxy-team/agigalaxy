/** Only explicitly read-only callers opt in. Commands and the lane controller never retry implicitly. */
export function isTransientReadFailure(error) {
  if (!error || typeof error !== 'object') return false;
  if (typeof error.status === 'number') return [500,502,503,504].includes(error.status);
  return error.name === 'TimeoutError' || error.code === 'request_timeout'
    || error.name === 'TypeError' && ['Failed to fetch','fetch failed','Load failed','NetworkError when attempting to fetch resource.'].includes(error.message);
}

/** One short recovery under the original signal, current scope and caller-owned data deadline. */
export async function readWithTransientRecovery(read, {signal,check=()=>{}} = {}) {
  signal?.throwIfAborted(); check();
  try { const value = await read(); signal?.throwIfAborted(); check(); return value; }
  catch (error) {
    signal?.throwIfAborted(); check();
    const seconds = error?.retryAfterSeconds;
    if (!isTransientReadFailure(error) || globalThis.navigator?.onLine === false
      || seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0 || seconds > 2)) throw error;
    await new Promise((resolve,reject) => {
      const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort',cancel); reject(signal.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort',cancel); resolve(); }, Math.max(300,(seconds??0)*1000));
      signal?.addEventListener('abort',cancel,{once:true});
      if (signal?.aborted) cancel();
    });
    signal?.throwIfAborted(); check();
    if (globalThis.navigator?.onLine === false) throw error;
    const value = await read(); signal?.throwIfAborted(); check(); return value;
  }
}

/** A scope owns independent read lanes. Replacing a lane invalidates all old callbacks. */
export function createReadTaskController(scopeKey) {
  const lanes = new Map();
  let disposed = false;

  const cancel = lane => {
    const selected = lane === undefined ? [...lanes.entries()] : [[lane, lanes.get(lane)]];
    for (const [name, task] of selected) {
      if (!task) continue;
      lanes.delete(name);
      task.abort.abort();
    }
  };

  /**
   * @template T
   * @param {{lane:string,key:string}} identity
   * @param {(context:{signal:AbortSignal})=>Promise<T>} read
   * @param {{onStart?:()=>void,onSuccess?:(value:T)=>void,onError?:(error:unknown)=>void,onSettled?:()=>void}} callbacks
   * @returns {Promise<{status:'success',value:T}|{status:'error',error:unknown}|{status:'superseded'}>}
   */
  function run({lane,key}, read, callbacks = {}) {
    if (disposed) return Promise.resolve({status:'superseded'});
    const previous = lanes.get(lane);
    if (previous?.key === key) return previous.promise;
    cancel(lane);
    const task = {key,abort:new AbortController(),promise:null};
    lanes.set(lane,task);
    const current = () => !disposed && lanes.get(lane) === task && !task.abort.signal.aborted;
    task.promise = (async () => {
      await Promise.resolve();
      if (!current()) return {status:'superseded'};
      let outcome;
      try {
        callbacks.onStart?.();
        if (!current()) return {status:'superseded'};
        const value = await read({signal:task.abort.signal});
        if (!current()) return {status:'superseded'};
        callbacks.onSuccess?.(value);
        outcome = {status:'success',value};
      } catch (error) {
        if (!current()) return {status:'superseded'};
        if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') outcome = {status:'superseded'};
        else {
          outcome = {status:'error',error};
          try { callbacks.onError?.(error); }
          catch (callbackError) { outcome = {status:'error',error:callbackError}; }
        }
      } finally {
        if (current()) {
          try { callbacks.onSettled?.(); }
          catch (error) { outcome = {status:'error',error}; }
          finally { if (lanes.get(lane) === task) lanes.delete(lane); }
        }
      }
      return outcome;
    })();
    return task.promise;
  }

  return {
    scopeKey,run,cancel,
    isPending(lane){ return lanes.has(lane); },
    dispose(){ disposed=true;cancel(); },
    // React's development effect replay reuses the same controller after cleanup.
    activate(){ disposed=false; }
  };
}
