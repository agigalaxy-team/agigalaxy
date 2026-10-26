// Navigation metadata only: no source titles, bodies, grants or cursor bytes.
const metadataKey=scope=>'galaxy-directory-reading:'+JSON.stringify([scope,location.pathname,location.search]);
function validReadingState(value,scope){
  if(!value||value.scope!==scope||!Number.isSafeInteger(value.depth)||value.depth<1)return null;
  return {depth:value.depth,anchorId:typeof value.anchorId==='string'&&value.anchorId.length<=512?value.anchorId:null};
}
/** @param {string} scope */
export function directoryReadingState(scope, state = globalThis.history?.state) {
  const current=validReadingState(state?.galaxyDirectoryReading,scope);
  if(current)return current;
  // A visible return link creates a new history entry. Recover the same
  // directory position without retaining any source content or opaque cursor.
  try{
    const stored=validReadingState(JSON.parse(sessionStorage.getItem(metadataKey(scope))??'null'),scope);
    if(stored)return stored;
  }catch{/* Reading remains available when browser navigation storage is full. */}
  return {depth:1,anchorId:null};
}
/** @param {string} scope @param {number} depth @param {string|null} [anchorId] */
export function rememberDirectoryReading(scope, depth, anchorId = null) {
  if (!Number.isSafeInteger(depth) || depth < 1) return;
  const value={scope,depth,anchorId};
  history.replaceState({...history.state, galaxyDirectoryReading:value}, '', location.href);
  try{sessionStorage.setItem(metadataKey(scope),JSON.stringify(value));}
  catch{/* The current history entry still keeps its reading position. */}
}
/** @param {string} scope */
export function restoreDirectoryReading(scope) {
  const saved = directoryReadingState(scope), route = location.pathname + location.search;
  if (!saved.anchorId) return () => {};
  const frame = requestAnimationFrame(() => {
    if (location.pathname + location.search !== route || directoryReadingState(scope).anchorId !== saved.anchorId) return;
    const target = document.getElementById(saved.anchorId);
    if (!target) return;
    // The shell restores the old scroll coordinate; keep the original object
    // in view if current, freshly read records changed the row geometry.
    const y = history.state?.scrollY;
    if (typeof y === 'number' && Number.isFinite(y) && document.documentElement.scrollHeight - innerHeight >= y)
      window.scrollTo(0, y);
    target.scrollIntoView({block: 'nearest'});
    const active = document.activeElement;
    if (!active || active === document.body || active instanceof HTMLHeadingElement)
      target.querySelector('a')?.focus({preventScroll: true});
  });
  return () => cancelAnimationFrame(frame);
}
