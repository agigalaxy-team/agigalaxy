'use client';

// A logout attempt is local to this document. This holds no identity, data,
// credential or authorization cache and cannot change a server decision.
let readController=new AbortController();
let logoutAttempt:object|null=null;
const listeners=new Set<()=>void>();
export const operationsReadsSuspended=()=>logoutAttempt!==null;
export const operationsReadServerSnapshot=()=>false;
export const operationsReadSignal=()=>readController.signal;
export function subscribeOperationsReadLifecycle(listener:()=>void){
  listeners.add(listener);return()=>{listeners.delete(listener);};
}
function notify(){for(const listener of listeners)listener();}

/** Abort GETs before logout's first await. Only this failed attempt can resume. */
export function beginOperationsLogout(){
  if(logoutAttempt)return()=>{};
  const attempt={};logoutAttempt=attempt;
  readController.abort(new DOMException('Operations logout started','AbortError'));
  notify();
  return()=>{
    if(logoutAttempt!==attempt)return;
    logoutAttempt=null;readController=new AbortController();notify();
  };
}
