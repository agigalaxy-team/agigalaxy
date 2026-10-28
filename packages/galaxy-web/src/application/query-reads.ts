import {QueryObserver,useQueryClient,isCancelledError,type QueryClient,type QueryObserverResult} from '@tanstack/react-query';
import {useLayoutEffect,useMemo,useRef} from 'react';
import {galaxyQueryKey,type GalaxyQueryScope} from '../shared/runtime/query-client';
import type {ReadTasks,ReadCallbacks,ReadTaskResult} from '../shared/reading/use-read-task';

export type QueryReadCallbacks<T>=ReadCallbacks<T>&{force?:boolean;validUntil?:(value:T)=>number|null};
export interface QueryReads extends Omit<ReadTasks,'run'>{
 run<T>(identity:{lane:string;key:string},read:(context:{signal:AbortSignal})=>Promise<T>,callbacks?:QueryReadCallbacks<NoInfer<T>>):Promise<ReadTaskResult<T>>;
 invalidate(lane?:string):void;
}
/** Return null for sources that provide no trustworthy read/publication deadline. */
export function sourceReadDeadline(value:unknown):number|null{
 let deadline=Infinity,found=false;
 const visit=(item:unknown,depth:number)=>{if(!item||typeof item!=='object'||depth>20)return;
  for(const [key,entry] of Object.entries(item)){
   if(['readUntil','readExpiresAt','publishedUntil','sourceExpiresAt','expiresAt'].includes(key)&&entry!==null&&entry!==undefined){const time=typeof entry==='number'?(entry>1e12?entry:entry*1000):typeof entry==='string'?Date.parse(entry):NaN;if(Number.isFinite(time)){deadline=Math.min(deadline,time);found=true;}}
   else if(entry&&typeof entry==='object')visit(entry,depth+1);
  }
 };visit(value,0);return found?deadline:null;
}
type Lane={observer:QueryObserver<unknown>;stop:()=>void;explicit:boolean;callbacks:ReadCallbacks<unknown>;updatedAt:number;key:string};
/** Query owns fetched values and in-flight reads. Lanes retain only observers and
 * callback ownership, so invalidation uses the same read and the same cache. */
export function useQueryReads(scope:GalaxyQueryScope,module:string,owner:string,onBackground?:(lane:string,value:unknown)=>void):QueryReads{
 const query=useQueryClient(),latest=useRef(onBackground);latest.current=onBackground;
 const {endpoint,identity,surface}=scope;
 const scopeKey=JSON.stringify([endpoint,identity,surface,module,owner]);
 const tasks=useMemo(()=>createQueryReads(query,{endpoint,identity,surface},module,scopeKey,(lane,value)=>latest.current?.(lane,value)),[query,endpoint,identity,surface,module,scopeKey]);
 useLayoutEffect(()=>{tasks.activate();return()=>tasks.dispose();},[tasks]);return tasks;
}
function createQueryReads(query:QueryClient,scope:GalaxyQueryScope,module:string,scopeKey:string,background:(lane:string,value:unknown)=>void):QueryReads{
 const lanes=new Map<string,Lane>();let active=true;
 const cancel=(lane?:string)=>{for(const [name,value] of lanes){if(lane&&name!==lane)continue;value.stop();value.observer.destroy();lanes.delete(name);}};
 return {scopeKey,activate(){active=true;},dispose(){active=false;cancel();},cancel,invalidate(lane){void query.invalidateQueries({queryKey:galaxyQueryKey(scope,module,ownerKey(scopeKey),...(lane?[lane]:[])),refetchType:'none'});},isPending(lane){return lanes.get(lane)?.observer.getCurrentResult().isFetching??false;},
 async run<T>(identity:{lane:string;key:string},read:(context:{signal:AbortSignal})=>Promise<T>,callbacks:QueryReadCallbacks<NoInfer<T>>={}):Promise<ReadTaskResult<T>>{
  if(!active||scope.identity==='unavailable')return{status:'superseded'};
  let lane=lanes.get(identity.lane);
  if(lane?.key!==identity.key){cancel(identity.lane);lane=undefined;}
  const queryKey=galaxyQueryKey(scope,module,ownerKey(scopeKey),identity.lane,identity.key);
  if(!lane){
   const observer=new QueryObserver<unknown>(query,{queryKey,queryFn:({signal})=>read({signal}),enabled:false,staleTime:Infinity});
   lane={observer,stop:()=>{},explicit:true,callbacks:callbacks as ReadCallbacks<unknown>,updatedAt:observer.getCurrentResult().dataUpdatedAt,key:identity.key};
   const selected=lane;
   lane.stop=observer.subscribe((result:QueryObserverResult<unknown>)=>{
    if(!active||lanes.get(identity.lane)!==selected)return;
    if(result.isPending&&result.data===undefined&&selected.updatedAt>0){selected.updatedAt=0;selected.callbacks.onError?.(new Error('query_scope_reset'));background(identity.lane,undefined);}
    if(result.isFetching){selected.callbacks.onStart?.();return;}
    if(result.isError){selected.callbacks.onError?.(result.error);selected.callbacks.onSettled?.();return;}
    if(result.isSuccess&&result.dataUpdatedAt!==selected.updatedAt){selected.updatedAt=result.dataUpdatedAt;selected.callbacks.onSuccess?.(result.data);selected.callbacks.onSettled?.();if(!selected.explicit)background(identity.lane,result.data);}
   });
   lanes.set(identity.lane,lane);
  }
  lane.callbacks={...lane.callbacks,...callbacks} as ReadCallbacks<unknown>;lane.explicit=true;
  const cached=query.getQueryState<T>(queryKey),deadline=cached?.status==='success'?(callbacks.validUntil?callbacks.validUntil(cached.data as T):Infinity):null;
  if(!callbacks.force&&cached?.status==='success'&&!cached.isInvalidated&&deadline!==null&&deadline>Date.now()){
   lane.observer.setOptions({queryKey,queryFn:({signal})=>read({signal}),enabled:true,staleTime:Infinity});
   lane.explicit=false;callbacks.onSuccess?.(cached.data as T);callbacks.onSettled?.();
   return{status:'success',value:cached.data as T};
  }
  lane.observer.setOptions({queryKey,queryFn:({signal})=>read({signal}),enabled:true,staleTime:Infinity});
  for(let attempt=0;;attempt++){
   try{
    // query() shares an already-started initial/invalidated observer read.
    // Unlike refetch(), it does not cancel and restart that same read.
    const value=await query.query<T>({queryKey,queryFn:({signal})=>read({signal}),staleTime:0});
    lane.explicit=false;
    if(!active||lanes.get(identity.lane)!==lane)return{status:'superseded'};
    return{status:'success',value};
   }catch(error){
    if(!active||lanes.get(identity.lane)!==lane){lane.explicit=false;return{status:'superseded'};}
    // A current-scope event reset cancels this imperative promise while its
    // observer starts the authorized replacement read. Rejoin that query so
    // the explicit caller receives its result instead of a CancelledError.
    // Removed scopes/lanes never restart, and business errors are not retried.
    if(isCancelledError(error)){
     if(!query.getQueryCache().find({queryKey,exact:true})){lane.explicit=false;return{status:'superseded'};}
     if(attempt<2)continue;
    }
    lane.explicit=false;return{status:'error',error};
   }
  }

 }};
}
const ownerKey=(value:string)=>value;
