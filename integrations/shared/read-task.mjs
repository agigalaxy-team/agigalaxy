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
