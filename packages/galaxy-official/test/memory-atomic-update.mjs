// Test-only implementation of the synchronous updater contract used by IDB
// readwrite transactions and Native withLocalWrite. No runtime get/put fallback.
// Fault observers run after the in-memory commit, never between compare/write.
export function memoryAtomicUpdate(records,onCommitted){
 return async(key,change)=>{
  if(typeof change!=='function')throw Error('local_update_callback_required');
  const next=change(structuredClone(records.get(key)));
  if(next&&typeof next.then==='function'){
   if(next instanceof Promise)void next.catch(()=>{});
   throw Error('local_update_async_callback');
  }
  const committed=structuredClone(next);records.set(key,committed);
  await onCommitted?.(key,structuredClone(committed));
  return structuredClone(committed);
 };
}
