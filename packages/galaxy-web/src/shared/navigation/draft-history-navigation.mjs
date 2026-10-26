/** @param {unknown} value @returns {value is Record<string,unknown>} */
const object = value => !!value && typeof value === 'object';
/** @typedef {{route:string,key:string|null}} Point */
/** @typedef {{leave:(complete:()=>void)=>void,isCurrent:()=>boolean}} DraftLeave */
/** @typedef {{committed:Promise<unknown>,finished:Promise<unknown>}} Traversal */
/** @typedef {{currentEntry:{key:string}|null,traverseTo:(key:string,options:{info:object})=>Traversal,addEventListener:(type:string,listener:(event:Event)=>void)=>void,removeEventListener:(type:string,listener:(event:Event)=>void)=>void}} BrowserNavigation */
/** @typedef {{navigationType:string,cancelable:boolean,destination:{sameDocument:boolean,url:string,key:string},info?:unknown,afterDispatch?:()=>Promise<void>,preventDefault:()=>void}} NavigationIntent */
/** @typedef {{mode:'native'|'fallback',origin:Point,target:Point,selection:DraftLeave,replaying:boolean,dispatchComplete?:Promise<void>,after?:{point:Point,action:()=>void}}} PendingLeave */
/**
 * Chromium still rejects an otherwise valid destination key in the microtask
 * checkpoint of the canceled native event, including its abort/error listeners.
 * One browser task lets that dispatch finish before saving and exact replay.
 * No elapsed-time retry or React state deferral is involved.
 */
function afterNativeDispatch() {
  return new Promise(/** @param {(value:void)=>void} resolve */ resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(null);
  });
}
/** @param {unknown} value @returns {value is BrowserNavigation} */
function browserNavigation(value) {
  return object(value) && typeof value.traverseTo === 'function'
    && typeof value.addEventListener === 'function' && typeof value.removeEventListener === 'function'
    && (value.currentEntry === null || (object(value.currentEntry) && typeof value.currentEntry.key === 'string'));
}
/** @param {Event} event @returns {NavigationIntent|null} */
function navigationIntent(event) {
  const destination = /** @type {unknown} */ (Reflect.get(event, 'destination'));
  const navigationType = /** @type {unknown} */ (Reflect.get(event, 'navigationType'));
  if (!object(destination) || typeof navigationType !== 'string' || typeof destination.sameDocument !== 'boolean'
    || typeof destination.url !== 'string' || typeof destination.key !== 'string') return null;
  return { navigationType, cancelable: event.cancelable, info: /** @type {unknown} */ (Reflect.get(event, 'info')), afterDispatch: afterNativeDispatch,
    destination: { sameDocument: destination.sameDocument, url: destination.url, key: destination.key },
    preventDefault: () => event.preventDefault() };
}
/** Feature detection keeps unsupported browsers on the retained-editor path. @param {Window} window */
export function draftNavigationBrowser(window) {
  const value = /** @type {unknown} */ (Reflect.get(window, 'navigation'));
  if (!browserNavigation(value)) return null;
  return {
    key: () => value.currentEntry?.key ?? null,
    traverseTo: (/** @type {string} */ key, /** @type {object} */ info) => value.traverseTo(key, { info }),
    listen(/** @type {(event:NavigationIntent)=>void} */ listener) {
      const changed = (/** @type {Event} */ event) => { const intent = navigationIntent(event); if (intent) listener(intent); };
      value.addEventListener('navigate', changed);
      return () => value.removeEventListener('navigate', changed);
    },
  };
}
/** @param {Point} left @param {Point} right */
const samePoint = (left, right) => left.route === right.route && left.key === right.key;
/** @param {string} left @param {string} right */
const sameReadingPage = (left, right) => left.split('#')[0] === right.split('#')[0];

/**
 * A browser traversal uses the existing editor's save callback and lease.
 * Native navigation is canceled before its history pointer moves, then the
 * exact destination key is replayed once. The compatibility path retains the
 * editor while saving, then accepts the browser's actual last position. Neither
 * path pushes, replaces, guesses a direction, or stores text in browser history.
 * @param {{origin:string,read:()=>Point,selectLeave:(origin:string)=>DraftLeave|null,
 * accept:()=>void,held:(mode:'native'|'fallback'|null)=>void,failed:()=>void,
 * traverseTo:((key:string,info:object)=>Traversal)|null}} ports
 */
export function createDraftHistoryNavigation(ports) {
  let active = false, current = ports.read();
  /** @type {PendingLeave|null} */
  let pending = null;
  /** @type {{request:PendingLeave,target:Point,token:object}|null} */
  let permit = null;
  /** A late replay remains identifiable even after a new route or owner clears its permit. */
  /** @type {WeakMap<object,{request:PendingLeave,target:Point}>} */
  const replays = new WeakMap();
  /** @type {Set<Promise<unknown>>} */
  const issued = new Set();
  /** @type {Point|null} */
  let allowedPop = null;
  function clear() { pending = null; permit = null; ports.held(null); }
  /** @param {PendingLeave} request */
  function finish(request) {
    if (!active || pending !== request || request.replaying || !request.selection.isCurrent()) return;
    if (request.dispatchComplete) { flush(request); return; }
    const actual = ports.read();
    if (request.after) {
      if (!samePoint(actual, request.after.point)) return;
      const action = request.after.action; current = actual; clear(); action(); return;
    }
    if (request.mode === 'fallback') {
      if (!samePoint(actual, request.target)) return;
      current = actual; clear(); ports.accept(); return;
    }
    if (!samePoint(actual, request.origin) || !request.target.key || !ports.traverseTo) return;
    request.replaying = true;
    const token = {};
    permit = { request, target: request.target, token }; replays.set(token, permit);
    try {
      const result = ports.traverseTo(request.target.key, token);
      const settled = Promise.allSettled([result.committed, result.finished]).then(results => {
        if (results.some(result => result.status === 'rejected') && active && pending === request && permit?.token === token) {
          request.replaying = false; permit = null; ports.failed();
        }
      }).catch(() => { if (active && pending === request && permit?.token === token) { request.replaying = false; permit = null; ports.failed(); } });
      issued.add(settled); settled.then(() => issued.delete(settled)).catch(() => issued.delete(settled));
    } catch { request.replaying = false; permit = null; ports.failed(); }
  }
  /** @param {PendingLeave} request */
  function flush(request) {
    if (request.dispatchComplete) {
      const completed = request.dispatchComplete;
      completed.then(() => {
        if (active && pending === request && request.dispatchComplete === completed) { request.dispatchComplete = undefined; flush(request); }
      }).catch(() => { if (active && pending === request && request.dispatchComplete === completed) ports.failed(); });
      return;
    }
    if (active && pending === request && !request.replaying && request.selection.isCurrent()) request.selection.leave(() => finish(request));
  }
  return Object.freeze({
    start() { active = true; current = ports.read(); pending = null; permit = null; allowedPop = null; },
    stop(/** @type {()=>void} */ unlisten = () => {}) {
      active = false; pending = null; permit = null; allowedPop = null;
      if (!issued.size) unlisten();
      else Promise.allSettled(issued).then(unlisten).catch(unlisten);
    },
    /** Existing app navigation and same-entry query changes supersede old callbacks. */
    changed() { if (active) { current = ports.read(); allowedPop = null; clear(); } },
    /** Used only to install the original editor registration during its loading phase. */
    editorRoute() { return current.route; },
    /** A save failure can be retried without re-reading or replacing the input. */
    resume() {
      if (!active || !pending || pending.replaying) return;
      if (!pending.selection.isCurrent()) { clear(); return; }
      const selection = ports.selectLeave(current.route);
      if (selection) { pending.selection = selection; flush(pending); }
    },
    /** Shell navigation can wait for the editor to mount, then save through its actual registration. */
    leave(/** @type {()=>void} */ action, includeCurrent = false) {
      if (!active) return false;
      if (pending && !pending.selection.isCurrent()) clear();
      if (!pending && (includeCurrent || current.route !== ports.read().route)) {
        const selection = ports.selectLeave(current.route);
        if (selection) { pending = { mode: 'fallback', origin: current, target: ports.read(), selection, replaying: false }; ports.held('fallback'); }
      }
      if (!pending) return false;
      pending.after = { point: ports.read(), action }; flush(pending); return true;
    },
    /** @param {NavigationIntent} event */
    navigate(event) {
      if (!active) {
        if (event.cancelable && event.destination.sameDocument && object(event.info) && replays.has(event.info)) event.preventDefault();
        return;
      }
      if (event.navigationType !== 'traverse') { allowedPop = null; clear(); return; }
      if (!event.destination.sameDocument || !event.cancelable || !ports.traverseTo) return;
      const url = new URL(event.destination.url, ports.origin);
      if (url.origin !== ports.origin) return;
      const target = { route: url.pathname + url.search + url.hash, key: event.destination.key }, actual = ports.read();
      const replay = object(event.info) ? replays.get(event.info) : null;
      if (replay) {
        replays.delete(event.info);
        if (pending === replay.request && permit?.token === event.info && replay.request.replaying
          && samePoint(replay.target, target) && samePoint(replay.request.origin, actual) && replay.request.selection.isCurrent()) {
          allowedPop = target; clear(); return;
        }
        event.preventDefault(); return;
      }
      if (sameReadingPage(current.route, target.route)) { allowedPop = target; clear(); return; }
      const selection = pending?.selection.isCurrent() ? pending.selection : ports.selectLeave(current.route);
      if (!selection) { allowedPop = target; clear(); return; }
      event.preventDefault(); permit = null; allowedPop = null;
      if (pending?.mode === 'native' && samePoint(pending.origin, actual) && pending.selection.isCurrent()) {
        pending.target = target; pending.after = undefined; pending.replaying = false;
      } else pending = { mode: 'native', origin: actual, target, selection, replaying: false };
      pending.dispatchComplete = event.afterDispatch?.();
      ports.held('native'); flush(pending);
    },
    /** Legacy/noncancelable traversals never unmount the editor before successful saving. */
    pop() {
      if (!active) return;
      const actual = ports.read();
      if (allowedPop && samePoint(allowedPop, actual)) { allowedPop = null; current = actual; clear(); ports.accept(); return; }
      allowedPop = null; permit = null;
      if (sameReadingPage(current.route, actual.route)) { current = actual; clear(); ports.accept(); return; }
      const selection = pending?.selection.isCurrent() ? pending.selection : ports.selectLeave(current.route);
      if (!selection) { current = actual; clear(); ports.accept(); return; }
      if (pending?.mode === 'fallback' && pending.selection.isCurrent()) { pending.target = actual; pending.after = undefined; }
      else pending = { mode: 'fallback', origin: current, target: actual, selection, replaying: false };
      ports.held('fallback'); flush(pending);
    },
  });
}
