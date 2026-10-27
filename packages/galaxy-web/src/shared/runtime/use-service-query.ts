import {QueryObserver,useQueryClient} from '@tanstack/react-query';
import {useEffect,useMemo,useRef} from 'react';
import {galaxyQueryKey,type GalaxyQueryScope} from './query-client';
import {sourceReadDeadline} from '../../application/query-reads';
const noPublicMethods:readonly string[]=[];

/** Server values and in-flight reads live only in Query. The callback updates
 * the existing UI projection after a matching source hint, never on focus. */
export function useServiceQuery(scope:GalaxyQueryScope,module:string,onInvalidate:(reset:boolean)=>void){
 const query=useQueryClient(),latest=useRef(onInvalidate);latest.current=onInvalidate;
 const {endpoint,identity,surface}=scope;
 const prefix=useMemo(()=>galaxyQueryKey({endpoint,identity,surface},module),[endpoint,identity,surface,module]);
 const subscription=useMemo(()=>({prefix,observers:new Map<string,{observer:QueryObserver;stop:()=>void}>()}),[prefix]);
 const observers=subscription.observers;
 useEffect(()=>{
  let active=true,queued=false,resetPending=false,dirty=false;
  const deliver=()=>{queued=false;if(!active)return;
   if(document.hidden){dirty=true;if(resetPending){resetPending=false;latest.current(true);}return;}
   dirty=false;const reset=resetPending;resetPending=false;latest.current(reset);
  };
  const visible=()=>{if(dirty&&!document.hidden&&!queued){queued=true;queueMicrotask(deliver);}};
  document.addEventListener('visibilitychange',visible);
  const unsubscribe=query.getQueryCache().subscribe(event=>{
   if(event.type!=='updated'||!prefix.every((part,index)=>event.query.queryKey[index]===part))return;
   const reset=event.action.type==='setState'&&event.query.state.data===undefined;
   if(event.action.type!=='invalidate'&&!reset)return;
   resetPending=resetPending||reset;if(queued)return;queued=true;
   queueMicrotask(deliver);
  });
  return()=>{active=false;unsubscribe();document.removeEventListener('visibilitychange',visible);for(const value of observers.values()){value.stop();value.observer.destroy();}observers.clear();};
 },[query,prefix,observers]);
 return useMemo(()=>({
  async read<T>(key:readonly unknown[],load:()=>Promise<T>,{fresh=false,publicRead=false}:{fresh?:boolean;publicRead?:boolean}={}){
   if(identity==='unavailable')throw new Error('query_identity_unavailable');
   const queryKey=[...prefix,...key],state=query.getQueryState<T>(queryKey);
   const observerKey=JSON.stringify(key);
   if(!observers.has(observerKey)){
    // Hold the actual displayed read in Query while mounted. An inactive
    // An imperative read alone would be collected and miss later source hints.
    const observer=new QueryObserver<unknown>(query,{queryKey,queryFn:load,enabled:false,staleTime:Infinity});
    observers.set(observerKey,{observer,stop:observer.subscribe(()=>{})});
    if(observers.size>64){const oldest=observers.keys().next().value!;const value=observers.get(oldest)!;value.stop();value.observer.destroy();observers.delete(oldest);}
   }
   const deadline=state?.data===undefined?null:sourceReadDeadline(state.data);
   // No invented lease: private sources without a complete deadline must use
   // their existing current-authority read whenever the caller renews them.
   const staleTime=fresh||!publicRead||deadline!==null&&deadline<=Date.now()?0:Infinity;
   return query.query<T>({queryKey,queryFn:load,staleTime});
  },
  invalidate(){void query.invalidateQueries({queryKey:prefix,refetchType:'none'});},
 }),[query,prefix,observers,identity]);
}

export function useServiceReadClient<T extends object>(client:T|null,scope:GalaxyQueryScope,module:string,
 methods:readonly string[],onInvalidate:(reset:boolean)=>void,publicMethods:readonly string[]=noPublicMethods):T|null{
 const reads=useServiceQuery(scope,module,onInvalidate);
 return useMemo(()=>client?new Proxy(client,{get(target,key,receiver){
  const value=Reflect.get(target,key,receiver);
  if(typeof key!=='string'||!methods.includes(key)||typeof value!=='function')return value;
  return (...args:unknown[])=>reads.read([key,...args],()=>Reflect.apply(value,target,args),{publicRead:publicMethods.includes(key)});
 }}):null,[client,reads,methods,publicMethods]);
}
